import {randomUUID,createHash} from 'node:crypto';
import {IntegrationJobs} from './integration-jobs.mjs';
import {assert,AppError} from './errors.mjs';
import {workspaceOrder,Workspace,pendingOrderOperation,reconcileOrderOperation,isOrderOperationRead} from './workspace.mjs';

const clone=v=>structuredClone(v),positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
const day=at=>new Date(at+8*3600000).toISOString().slice(0,10);
// Real OpenAPI accepts 2001 onward; 2000 and earlier return a date-config error.
const catalogYear=at=>Number(day(at).slice(0,4)),CATALOG_FIRST_YEAR=2001;
const DAY=86400000,MINUTE=60000,ORDER_VISIBLE="NOT EXISTS(SELECT 1 FROM blacklake_sync_snapshots removed WHERE removed.kind='order-presence' AND removed.target=CAST(blacklake_order_index.project_id AS TEXT) AND json_extract(removed.data_json,'$.present')=0)";
const NIGHTLY_START=3*60+10,NIGHTLY_CATCHUP_END=6*60;
const stamp=value=>{if(value==null||value==='')return '';if(typeof value==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value))return value.replace('T',' ');const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' '):'';};
const normalizeSearch=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
const createdMs=value=>{const text=stamp(value);return text?Date.parse(text.replace(' ','T')+'+08:00'):null;};
const code=e=>/^[A-Za-z0-9_.:-]{1,100}$/.test(e?.code||'')?e.code:'BLACKLAKE_SYNC_FAILED';
const labels={QUEUED:'同步中',RETRY:'等待重试',RUNNING:'同步中',UNKNOWN:'待核对',FAILED:'同步异常',SUCCEEDED:'已同步',CANCELLED:'已取消同步'};
const errorLabels={TASK_CLOSED:'黑湖工序已关闭或状态未确认，请先核对工序。',REPORT_PERSON_CHANGED:'人员停用或身份发生变化，尚未提交黑湖。',REPORT_OWNER_ROLE_CHANGED:'原操作人的权限已变化，尚未提交黑湖。',REPORT_VERSION_CHANGED:'本地报工已变化，请重新打开记录后编辑。',REPORT_REMOTE_CHANGED:'黑湖记录已被其他操作修改，请重新核对。',BLACKLAKE_TIMEOUT:'黑湖响应超时，请核对是否已产生记录。',BLACKLAKE_UNAVAILABLE:'暂时无法连接黑湖。',WORKER_RESTART:'同步期间服务重启，请核对结果。',ADMIN_CONFIRMED_ABSENT:'已明确核对黑湖未产生记录，可以重试。',SYNC_CANCELLED:'已取消同步，保留本地记录。'};
export class BlacklakeSync {
 constructor({store,blacklake,now=Date.now,historyDays=2,refreshMs=60000,intervalMs=1200,refreshPolicy={},maxReadFailures=5,random=Math.random}){
  Object.assign(this,{store,blacklake,now,historyDays,refreshMs,intervalMs,refreshPolicy,maxReadFailures,random});this.db=store.db;this.jobs=new IntegrationJobs(this.db,{now});this.handlers=new Map();
  this.db.exec(`CREATE TABLE IF NOT EXISTS blacklake_sync_snapshots(kind TEXT NOT NULL,target TEXT NOT NULL,data_json TEXT NOT NULL,
    fetched_at INTEGER,complete INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',scope_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(kind,target));
   CREATE TABLE IF NOT EXISTS blacklake_order_index(project_id INTEGER PRIMARY KEY,project_code TEXT NOT NULL,product_code TEXT NOT NULL,product_name TEXT NOT NULL,details_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS blacklake_product_index(product_code TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS blacklake_output_index(output_id TEXT PRIMARY KEY,project_id INTEGER,task_id INTEGER,output_time TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL,correction_json TEXT,correction_at INTEGER,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS blacklake_output_project ON blacklake_output_index(project_id,task_id,output_time);
   CREATE INDEX IF NOT EXISTS blacklake_output_live_created ON blacklake_output_index(created_at DESC) WHERE deleted=0;`);
  this.db.exec("CREATE INDEX IF NOT EXISTS blacklake_snapshot_read_audit ON blacklake_sync_snapshots(fetched_at,kind,target) WHERE kind IN ('order','order-reports') AND complete=1");
  const columns=new Set(this.db.prepare('PRAGMA table_info(blacklake_order_index)').all().map(r=>r.name));
  for(const [name,type]of [['created_at_ms','INTEGER'],['search_text',"TEXT NOT NULL DEFAULT ''"],['catalog_hash',"TEXT NOT NULL DEFAULT ''"]])if(!columns.has(name))this.db.exec('ALTER TABLE blacklake_order_index ADD COLUMN '+name+' '+type);
  this.db.exec('CREATE INDEX IF NOT EXISTS blacklake_order_created ON blacklake_order_index(created_at_ms DESC,project_id DESC)');
  for(const row of this.db.prepare("SELECT details_json FROM blacklake_order_index WHERE search_text=''").all())this.indexOrder(JSON.parse(row.details_json));
  for(const section of ['materials','history'])this.handlers.set(section,async job=>{const reader=Object.assign(Object.create(Workspace.prototype),{blacklake:this.blacklake,now:this.now,order:async id=>this.order(id)}),value=await reader.section(job.payload.projectId,section,job.payload.pageNum);this.assertClaim(job);this.save(section,job.target,value);return {records:value.items.length};});
 }
 snapshot(kind,target){
  const row=this.db.prepare('SELECT * FROM blacklake_sync_snapshots WHERE kind=? AND target=?').get(kind,String(target)),job=this.jobs.byKey('read:'+kind+':'+target);
  const available=row?.fetched_at!=null,stale=available&&(!!row.error_code||this.now()-row.fetched_at>this.ttl(kind)||job&&['QUEUED','RUNNING','RETRY'].includes(job.state));
  const pending=job&&['QUEUED','RUNNING','RETRY'].includes(job.state)||false,errorCode=row?.error_code||job?.error_code||'',cooling=(this.blacklake.requestBudget?.state.cooldownUntil||this.snapshotCooldown||0)>this.now();
  return {data:available?JSON.parse(row.data_json):null,sync:{status:!available?'unavailable':stale?'stale':row.complete?'fresh':'partial',updatedAt:available?new Date(row.fetched_at).toISOString():null,complete:!!row?.complete,pending,paused:job?.state==='FAILED',phase:job?.state==='FAILED'?'failed':pending?cooling||errorCode==='BLACKLAKE_RATE_COOLDOWN'?'cooldown':job.state==='RUNNING'?'updating':'queued':'idle',...(errorCode?{errorCode}:{}),scope:row?JSON.parse(row.scope_json):{}}};
 }
 ttl(kind){return this.refreshPolicy?.[kind]??this.refreshMs;}
 save(kind,target,data,{complete=true,scope={}}={}){this.db.prepare("INSERT INTO blacklake_sync_snapshots(kind,target,data_json,fetched_at,complete,scope_json) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET data_json=excluded.data_json,fetched_at=excluded.fetched_at,complete=excluded.complete,scope_json=excluded.scope_json,error_code=''").run(kind,String(target),JSON.stringify(data),this.now(),complete?1:0,JSON.stringify(scope));}
 request(kind,target,payload={},force=false){return this.jobs.enqueue({key:'read:'+kind+':'+target,mode:'read',kind,target,payload,force});}
 read(kind,target,payload={},{foreground=true,revalidate=false}={}){const s=this.snapshot(kind,target);if(!s.data||!s.sync.complete||revalidate&&s.sync.status==='stale'){const job=this.request(kind,target,payload);if(foreground)this.jobs.demand(job.id);}else{const job=this.jobs.byKey('read:'+kind+':'+target);if(foreground&&job&&['QUEUED','RETRY','RUNNING'].includes(job.state))this.jobs.demand(job.id);}return this.snapshot(kind,target);}
 require(snapshot,label){assert(snapshot.data!=null,503,'BLACKLAKE_DATA_SYNCING',label+'正在由后台同步，请稍后刷新。');return snapshot.data;}
 indexOrder(info,{catalog=false}={}){
  assert(positive(info.projectId)&&typeof info.projectCode==='string'&&info.projectCode,502,'SYNC_ORDER_IDENTITY','工单身份未能确认。');
  const prior=this.db.prepare('SELECT details_json,catalog_hash FROM blacklake_order_index WHERE project_id=?').get(Number(info.projectId)),old=prior?JSON.parse(prior.details_json):{},data={...old,...info,createdAt:info.createdAt??old.createdAt??null,...(catalog&&!info.productImageUrls?.length&&old.productImageUrls?.length?{productImageUrls:old.productImageUrls}:{})},fingerprint=catalog?createHash('sha256').update(JSON.stringify(info)).digest('hex'):prior?.catalog_hash||'';
  const changed=!prior||catalog&&fingerprint!==prior.catalog_hash;if(catalog&&!changed)return false;
  const search=[data.projectCode,data.productCode,data.productName,data.productSpecification].map(normalizeSearch).join('\n');
  this.db.prepare('INSERT INTO blacklake_order_index(project_id,project_code,product_code,product_name,details_json,updated_at,created_at_ms,search_text,catalog_hash) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET project_code=excluded.project_code,product_code=excluded.product_code,product_name=excluded.product_name,details_json=excluded.details_json,updated_at=excluded.updated_at,created_at_ms=excluded.created_at_ms,search_text=excluded.search_text,catalog_hash=excluded.catalog_hash').run(Number(data.projectId),data.projectCode,data.productCode||'',data.productName||'',JSON.stringify(data),this.now(),createdMs(data.createdAt),search,fingerprint);
  if(data.productCode)this.db.prepare('INSERT INTO blacklake_product_index VALUES(?,?,?) ON CONFLICT(product_code) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(data.productCode,JSON.stringify({code:data.productCode,name:data.productName||'',specification:data.productSpecification||'',images:data.productImageUrls||[]}),this.now());
  return changed;
 }
 catalog(){return this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE '+ORDER_VISIBLE+' ORDER BY created_at_ms DESC,project_id DESC').all().map(r=>JSON.parse(r.details_json));}
 requestOrderPresence(id,actor='SYSTEM'){
  assert(typeof this.blacklake.readWorkOrderPresence==='function'&&positive(id)&&this.db.prepare('SELECT 1 FROM blacklake_order_index WHERE project_id=?').get(Number(id)),404,'WORK_ORDER_NOT_FOUND','没有找到要核对的工单。');
  const prior=this.jobs.byKey('read:order-presence:'+id);
  if(prior?.state==='FAILED'&&actor!=='SYSTEM')this.jobs.retry(prior.id,actor,prior);
  const job=this.request('order-presence',id,{projectId:Number(id)});
  if(actor!=='SYSTEM')this.jobs.demand(job.id);
  return job;
 }
 async confirmOrderPresence(job,id){
  const result=await this.blacklake.readWorkOrderPresence(id);
  if(this.assertClaim(job).generation!==job.claimed_generation)return {superseded:true};
  assert(result?.present===true&&typeof result.projectCode==='string'&&result.projectCode||result?.present===false&&result.code==='01002021',502,'BLACKLAKE_ORDER_PRESENCE_UNCONFIRMED','黑湖工单存在状态无法确认。');
  const removed=this.store.orderRemoved(id);
  this.db.exec('BEGIN IMMEDIATE');try{
   this.save('order-presence',id,result);
   if(!result.present&&!removed)this.jobs.event(job.id,'ORDER_ABSENCE_CONFIRMED','SYSTEM',{projectId:id,upstreamCode:result.code});
   if(result.present&&removed){
    const indexed=this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?').get(id);
    if(indexed)this.indexOrder({...JSON.parse(indexed.details_json),projectCode:result.projectCode});
    this.request('order',id,{projectId:id,reason:'restored'},true);
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return result;
 }
 orderRefreshState(id){const job=this.jobs.byKey('read:order:'+id);return job?{jobId:job.id,generation:job.generation,state:job.state,completed:job.state==='SUCCEEDED'&&job.generation===job.claimed_generation}:null;}
 requestOrderRefresh(id,actor='USER'){
  assert(positive(id),422,'INVALID_WORK_ORDER','工单编号无效。');
  assert(!this.store.orderRemoved(id),404,'WORK_ORDER_DELETED','这张工单已在黑湖删除，已从工单目录移除。');
  assert(this.db.prepare('SELECT 1 FROM blacklake_order_index WHERE project_id=?').get(Number(id)),404,'WORK_ORDER_NOT_FOUND','没有找到这张工单，请从列表重新打开。');
  let job=this.jobs.byKey('read:order:'+id);
  if(!(job&&job.payload.reason==='manual'&&['QUEUED','RETRY','RUNNING'].includes(job.state))){
   if(job?.state==='FAILED')this.jobs.retry(job.id,actor,job);
   job=this.request('order',id,{projectId:Number(id),reason:'manual',requestedAt:this.now()},true);
   this.jobs.event(job.id,'MANUAL_ORDER_REFRESH',actor,{projectId:Number(id),generation:job.generation});
  }
  this.jobs.demand(job.id);return this.order(id);
 }
 order(id,{refresh=false}={}){
  assert(positive(id),422,'INVALID_WORK_ORDER','工单编号无效。');assert(!this.store.orderRemoved(id),404,'WORK_ORDER_DELETED','这张工单已在黑湖删除，已从工单目录移除。');const s=this.read('order',id,{projectId:Number(id)});
  s.sync.refresh=this.orderRefreshState(id);
  if(s.data){const latest=this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?').get(Number(id));return {...workspaceOrder({...s.data.info,...(latest?JSON.parse(latest.details_json):{})},s.data.tasks),processesLoaded:true,sync:s.sync};}
  const index=this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?').get(Number(id));assert(index,503,'BLACKLAKE_DATA_SYNCING','这张工单正在由后台同步，请稍后刷新。');
  return {...workspaceOrder(JSON.parse(index.details_json)),processesLoaded:false,sync:s.sync};
 }
 list({pageNum=1,projectCode='',sort='default',status='ALL',priority='ALL',watch=[]}={}){
  assert(Number.isSafeInteger(pageNum)&&pageNum>0&&pageNum<=1000000&&typeof projectCode==='string'&&projectCode.length<=100,422,'WORKSPACE_INVALID_QUERY','查询条件不正确。');
  const sorts={default:'created_at_ms DESC,project_id DESC','created-asc':'created_at_ms IS NULL,created_at_ms ASC,project_id ASC',code:'project_code COLLATE NOCASE,project_id DESC','start-desc':"json_extract(details_json,'$.planStartTime') DESC,project_id DESC",'start-asc':"json_extract(details_json,'$.planStartTime') IS NULL,json_extract(details_json,'$.planStartTime'),project_id DESC"};
  assert(Object.hasOwn(sorts,sort)&&['ALL','OPEN','NOT_STARTED','IN_PROGRESS','FINISHED'].includes(status)&&['ALL','NONE','PAUSED','EXPEDITED','URGENT','EXTREME'].includes(priority),422,'WORKSPACE_INVALID_QUERY','筛选或排序无效。');
  const clauses=[ORDER_VISIBLE],args=[];for(const term of projectCode.trim().split(/\s+/).map(normalizeSearch).filter(Boolean)){clauses.push('instr(search_text,?)>0');args.push(term);}
  const searchWhere=clauses.length?' WHERE '+clauses.join(' AND '):'',statusMap={NOT_STARTED:'0',IN_PROGRESS:'10',FINISHED:'20'};
  const statusCounts=Object.fromEntries(this.db.prepare("SELECT json_extract(details_json,'$.projectStatus') status,COUNT(*) count FROM blacklake_order_index"+searchWhere+" GROUP BY status").all(...args).map(r=>[Object.keys(statusMap).find(k=>statusMap[k]===String(r.status))||'UNKNOWN',r.count]));
  if(status==='OPEN')clauses.push("CAST(json_extract(details_json,'$.projectStatus') AS TEXT) IN ('0','10')");
  else if(status!=='ALL'){clauses.push("CAST(json_extract(details_json,'$.projectStatus') AS TEXT)=?");args.push(statusMap[status]);}
  if(priority!=='ALL'){clauses.push("json_extract(details_json,'$.projectPriority')=?");args.push({NONE:0,PAUSED:-1,EXPEDITED:1,URGENT:2,EXTREME:3}[priority]);}
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'',total=this.db.prepare('SELECT COUNT(*) n FROM blacklake_order_index'+where).get(...args).n,selected=this.db.prepare('SELECT details_json FROM blacklake_order_index'+where+' ORDER BY '+sorts[sort]+' LIMIT 20 OFFSET ?').all(...args,(pageNum-1)*20);
  const present=row=>{const info=JSON.parse(row.details_json),s=this.snapshot('order',info.projectId);return {...workspaceOrder(info,s.data?.tasks||[]),processesLoaded:!!s.data,sync:s.sync};};
  const orders=selected.map(present),watched=new Map(orders.map(order=>[order.id,order]));
  if(watch.length){
   assert(watch.length<=50&&watch.every(positive),422,'WORKSPACE_INVALID_QUERY','工单回读范围不正确。');
   for(const row of this.db.prepare('SELECT project_id,details_json FROM blacklake_order_index WHERE '+ORDER_VISIBLE+' AND project_id IN ('+watch.map(()=>'?').join(',')+')').all(...watch.map(Number)))if(!watched.has(row.project_id))watched.set(row.project_id,present(row));
  }
  const all=this.snapshot('catalog','all').sync,legacy=[new Date(this.now()).getUTCFullYear(),new Date(this.now()).getUTCFullYear()-1].map(y=>this.snapshot('catalog',y).sync),complete=all.complete,scopes=all.updatedAt?[all]:legacy;
  return {orders,...(watch.length?{watchedOrders:watch.map(id=>watched.get(Number(id))).filter(Boolean)}:{}),pageNum,pageSize:20,total,hasMore:pageNum*20<total,statusCounts,sort,source:'blacklake-snapshot',fetchedAt:scopes.map(s=>s.updatedAt).filter(Boolean).sort()[0]||null,complete:complete&&!this.jobs.byKey('read:catalog:all')?.error_code,sync:{status:complete?'fresh':'partial',complete,scopes},scope:{globalHistory:complete,catalog:'后台已同步工单目录'},scopeNote:'共'+total+'张匹配工单'+(complete?'':'，目录正在分批补齐')};
 }
 people(){const s=this.read('people','all');if(s.data)return clone(s.data);return this.db.prepare('SELECT name,blacklake_operator_id AS blacklakeOperatorId,group_names_json FROM operators WHERE active=1 AND blacklake_operator_id>0 ORDER BY id').all().map(p=>({name:p.name,blacklakeOperatorId:p.blacklakeOperatorId,groupNames:JSON.parse(p.group_names_json)})).filter(p=>!this.store.members.byKey(p.blacklakeOperatorId));}
 section(id,section,pageNum=1){const s=this.read(section,id+':'+pageNum,{projectId:Number(id),pageNum});return {...this.require(s,'工单资料'),source:'blacklake-snapshot',fetchedAt:s.sync.updatedAt,sync:s.sync};}
 outputEditor(id){const row=this.db.prepare('SELECT correction_json,correction_at,deleted FROM blacklake_output_index WHERE output_id=?').get(String(id));if(!row?.correction_json){const job=this.request('output',String(id),{outputId:String(id)});this.jobs.demand(job.id);}assert(row?.correction_json&&!row.deleted,503,'BLACKLAKE_DATA_SYNCING','报工详情正在由后台同步，请稍后重新打开。');return JSON.parse(row.correction_json);}
 reportRefreshState(id){
  const job=this.jobs.byKey('read:order-reports:'+id);if(!job?.payload.requestId)return null;
  const order=this.jobs.byKey('read:order:'+id),required=job.payload.orderGeneration,orderDone=!required||order?.state==='SUCCEEDED'&&order.claimed_generation>=required;
  const checks=this.db.prepare("SELECT state FROM integration_jobs WHERE kind='output' AND json_extract(payload_json,'$.refreshRequestId')=?").all(job.payload.requestId),failure=checks.some(r=>r.state==='FAILED')||required&&order?.state==='FAILED',checking=checks.some(r=>r.state!=='SUCCEEDED');
  const completed=job.state==='SUCCEEDED'&&job.generation===job.claimed_generation&&this.snapshot('order-reports',id).sync.complete&&orderDone&&!checking;
  return {jobId:job.id,requestId:job.payload.requestId,state:failure?'FAILED':job.state==='SUCCEEDED'&&!completed?'QUEUED':job.state,completed};
 }
 requestReportRefresh(id,projectCode,actor='USER'){
  let job=this.jobs.byKey('read:order-reports:'+id);
  if(!(job?.payload.requestId&&['QUEUED','RETRY','RUNNING'].includes(job.state))){
   if(job?.state==='FAILED')this.jobs.retry(job.id,actor,job);
   const order=this.requestOrderRefresh(id,actor).sync.refresh;
   job=this.request('order-reports',id,{projectId:Number(id),projectCode,pageNum:1,requestId:randomUUID(),orderGeneration:order.generation},true);
   this.jobs.event(job.id,'MANUAL_PROCESS_REPORT_REFRESH',actor,{projectId:Number(id),requestId:job.payload.requestId});
  }
  this.jobs.demand(job.id);return this.reportRefreshState(id);
 }
 orderReports(projectId,projectCode){
  const s=this.read('order-reports',projectId,{projectId:Number(projectId),projectCode,pageNum:1});
  // A completed older empty scan is not an allowlist. New incremental and
  // confirmed write receipts are immediately visible by immutable project ID.
  const records=this.db.prepare('SELECT output_id,raw_json FROM blacklake_output_index WHERE project_id=? AND deleted=0 ORDER BY created_at DESC,output_id DESC').all(Number(projectId)).map(r=>JSON.parse(r.raw_json));
  const refresh=this.reportRefreshState(projectId);return {records,sync:{...s.sync,pending:s.sync.pending||!!refresh&&!refresh.completed&&refresh.state!=='FAILED',refresh}};
 }
 outputsSnapshot(){const end=day(this.now()),start=day(this.now()-this.historyDays*86400000);const records=this.db.prepare("SELECT raw_json FROM blacklake_output_index WHERE deleted=0 AND created_at>=? AND created_at<=? ORDER BY created_at DESC,output_id DESC LIMIT 2000").all(start+' 00:00:00',end+' 23:59:59').map(r=>JSON.parse(r.raw_json));const scopes=[];for(let at=Date.parse(start+'T00:00:00+08:00');at<=this.now();at+=86400000)scopes.push(this.snapshot('history-day',day(at)).sync);return {records,sync:{status:scopes.every(s=>s.complete)?scopes.some(s=>s.status==='stale')?'stale':records.length?'fresh':'empty':records.length?'stale':'unavailable',complete:scopes.every(s=>s.complete)&&records.length<2000,updatedAt:scopes.map(s=>s.updatedAt).filter(Boolean).sort()[0]||null,scope:{from:start,to:end,maxRecords:2000,globalHistory:false},...(records.length===2000?{truncated:true}:{})}};}
 processSnapshots(projects){return projects.map(project=>{const s=this.read('order',project.projectId,{projectId:Number(project.projectId)});return {project,tasks:s.data?.tasks||[],sync:s.sync};});}
 outputPage(filters={},page={}){
  const pageNum=page.pageNum??1,pageSize=page.pageSize??100;assert(Number.isInteger(pageNum)&&pageNum>0&&Number.isInteger(pageSize)&&pageSize>0&&pageSize<=100,422,'INVALID_OUTPUT_PAGE','分页参数无效。');
  const from=stamp(filters.createdAtGte)||day(this.now()-this.historyDays*86400000)+' 00:00:00',to=stamp(filters.createdAtLte)||day(this.now())+' 23:59:59';assert(from<=to,422,'INVALID_OUTPUT_RANGE','日期范围无效。');
  assert((filters.createdAtGte===undefined||stamp(filters.createdAtGte))&&(filters.createdAtLte===undefined||stamp(filters.createdAtLte)),422,'INVALID_OUTPUT_RANGE','日期范围无效。');
  assert(Object.keys(filters).every(k=>['createdAtGte','createdAtLte','id','projectId','projectIds','projectCode','projectCodes','taskId','operatorId','operatorIds'].includes(k)),422,'SYNC_QUERY_UNSUPPORTED','当前历史筛选尚未支持，未改为其他查询。');
  const start=Date.parse(from.slice(0,10)+'T00:00:00+08:00'),end=Date.parse(to.slice(0,10)+'T00:00:00+08:00');assert(Number.isFinite(start)&&Number.isFinite(end)&&end-start<=366*86400000,422,'SYNC_HISTORY_RANGE','单次历史同步不能超过366天。');
  let complete=true;const scopes=[];for(let at=start;at<=end;at+=86400000){const date=day(at),s=this.snapshot('history-day',date);scopes.push(s.sync);if(!s.sync.complete){complete=false;this.request('history-day',date,{date,pageNum:1});}}
  assert(complete,503,'BLACKLAKE_DATA_SYNCING','所选日期的历史报工正在后台分页同步，暂不能作为完整统计。');
  const clauses=['deleted=0','created_at>=?','created_at<=?'],args=[from,to];if(filters.id!=null){clauses.push('output_id=?');args.push(String(filters.id));}
  for(const [single,multiple,column]of [['projectId','projectIds','project_id'],['operatorId','operatorIds',"COALESCE(json_extract(raw_json,'$.productionStaffId'),json_extract(raw_json,'$.operatorId'))"]]){const values=filters[multiple]??(filters[single]!=null?[filters[single]]:null);if(values){assert(Array.isArray(values)&&values.length>0&&values.length<=500&&values.every(positive),422,'SYNC_QUERY_INVALID','历史筛选编号无效。');clauses.push(column+' IN ('+values.map(()=>'?').join(',')+')');args.push(...values.map(Number));}}
  if(filters.taskId!=null){assert(positive(filters.taskId),422,'SYNC_QUERY_INVALID','工序编号无效。');clauses.push('task_id=?');args.push(Number(filters.taskId));}
  const codes=filters.projectCodes??(filters.projectCode!=null?[filters.projectCode]:null);if(codes){assert(Array.isArray(codes)&&codes.length>0&&codes.length<=100&&codes.every(c=>typeof c==='string'&&c),422,'SYNC_QUERY_INVALID','工单编号筛选无效。');clauses.push("json_extract(raw_json,'$.projectCode') IN ("+codes.map(()=>'?').join(',')+')');args.push(...codes);}
  const where=clauses.join(' AND '),total=this.db.prepare('SELECT COUNT(*) n FROM blacklake_output_index WHERE '+where).get(...args).n,records=this.db.prepare('SELECT raw_json FROM blacklake_output_index WHERE '+where+' ORDER BY created_at,output_id LIMIT ? OFFSET ?').all(...args,pageSize,(pageNum-1)*pageSize).map(r=>JSON.parse(r.raw_json));return {records,total,pageNum,pageSize,source:'local_sqlite',sync:{updatedAt:scopes.map(s=>s.updatedAt).filter(Boolean).sort()[0]||null,stale:scopes.some(s=>s.status!=='fresh'),complete:true}};
 }
 readClient(){const self=this;return new Proxy(this.blacklake,{get(target,key){
  if(key==='listOperators')return async()=>self.people();if(key==='listWorkOrderCatalog')return async()=>self.catalog();if(key==='readOutputForCorrection')return async id=>self.outputEditor(id);if(key==='readSnapshotOutputs')return async()=>self.outputsSnapshot();if(key==='readSnapshotProcesses')return async refs=>self.processSnapshots(refs);
  if(key==='queryOutputPage')return async(...args)=>self.outputPage(...args);
  if(key==='queryOutputs')return async(filters={},options={})=>{const rows=[];for(let pageNum=1;pageNum<=(options.maxPages||10000);pageNum++){const page=self.outputPage(filters,{pageNum,pageSize:options.pageSize||100});rows.push(...page.records);if(rows.length>=options.maxRecords)return rows.slice(0,options.maxRecords);if(pageNum*page.pageSize>=page.total)return rows;}throw new AppError(503,'SYNC_HISTORY_LIMIT','历史范围尚未完整取得。');};
  if(key==='listProjectTasks')return async({projectIds=[],projectCodes=[]}={})=>{const refs=projectIds.length?projectIds:self.catalog().filter(r=>projectCodes.includes(r.projectCode)).map(r=>r.projectId);assert(refs.length,503,'BLACKLAKE_DATA_SYNCING','工单目录正在同步。');return refs.flatMap(id=>self.require(self.read('order',id,{projectId:Number(id)}),'工序').tasks);};
  if(key==='readWorkOrderDetails')return async(id,projectCode)=>{const row=self.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?').get(Number(id));assert(row,503,'BLACKLAKE_DATA_SYNCING','工单资料正在同步。');const info=JSON.parse(row.details_json);assert(info.projectCode===projectCode,409,'WORK_ORDER_CHANGED','工单编号不匹配。');return info;};
  if(key==='listWorkOrderProcesses')return async flow=>{const text=String(flow),id=text.startsWith('projectId=')?Number(text.slice(10)):text.startsWith('https://liteapp.blacklake.cn/')?Number(new URL(text).searchParams.get('id')):NaN;assert(positive(id),422,'INVALID_FLOW_CODE','请选择明确的工单。');return self.require(self.read('order',id,{projectId:id}),'工序').tasks;};
  if(key==='listTasks'||key==='findTaskById')return async criteria=>{const filter=key==='findTaskById'?{taskId:Number(criteria)}:criteria||{},rows=self.db.prepare("SELECT s.data_json FROM blacklake_sync_snapshots s WHERE s.kind='order' AND s.fetched_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM blacklake_sync_snapshots p WHERE p.kind='order-presence' AND p.target=s.target AND json_extract(p.data_json,'$.present')=0)").all().flatMap(r=>JSON.parse(r.data_json)?.tasks||[]).filter(r=>(!filter.taskId||r.taskId===filter.taskId)&&(!filter.projectId||r.projectId===filter.projectId)&&(!filter.projectCode||r.projectCode===filter.projectCode)&&(!filter.processCode||r.processCode===filter.processCode));if(key==='listTasks')return rows;assert(rows.length===1,503,'BLACKLAKE_DATA_SYNCING','该工序尚未同步。');return rows[0];};
  if(['createOutput','updateOutputConfirmed','deleteOutputConfirmed','nativeRequest','request','prepareOutputCorrection'].includes(key))return ()=>{throw new AppError(409,'SYNC_READ_ONLY','共享快照不能直接写入黑湖。');};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }});}
 invalidateOrder(projectId,{outputId,deleted=false}={}){if(positive(projectId))this.request('order',Number(projectId),{projectId:Number(projectId),reason:'mutation'},true);if(outputId){if(deleted)this.db.prepare('UPDATE blacklake_output_index SET deleted=1,updated_at=? WHERE output_id=?').run(this.now(),String(outputId));else this.request('output',String(outputId),{outputId:String(outputId)},true);}}
 queueReportProgress(projectIds,{nightly=false}={}){
  const indexed=this.db.prepare('SELECT 1 FROM blacklake_order_index WHERE project_id=?');
  for(const projectId of projectIds){
   if(!indexed.get(projectId)||this.store.orderRemoved(projectId))continue;
   const job=this.jobs.byKey('read:order:'+projectId);
   const pending=job&&['QUEUED','RETRY','RUNNING'].includes(job.state);
   if(pending){
    // An earlier task step may already hold an older cumulative quantity.
    // Keep manual receipts and write-reconciliation reasons on the same job.
    const promote=!nightly&&job.payload.reason==='nightly';
    if(job.payload.reportProgress&&job.claimed_generation!==job.generation&&!promote)continue;
    this.request('order',projectId,{...job.payload,reportProgress:true,...(promote?{reason:'report-progress'}:{})},true);
   }else{
    this.request('order',projectId,{projectId,reportProgress:true,reason:nightly?'nightly':'report-progress'});
   }
  }
 }
 pruneObsoleteReads(){
  const rows=this.db.prepare("SELECT j.id,j.kind,j.target FROM integration_jobs j JOIN blacklake_sync_snapshots s ON s.kind=j.kind AND s.target=j.target LEFT JOIN integration_read_state q ON q.job_id=j.id WHERE j.mode='read' AND j.kind='order' AND j.state IN ('QUEUED','RETRY') AND s.complete=1 AND COALESCE(json_extract(j.payload_json,'$.reportProgress'),0)=0 AND COALESCE(json_extract(j.payload_json,'$.reason'),'') NOT IN ('mutation','audit','manual','catalog-delta','nightly') AND COALESCE(q.demand_until,0)<=? AND NOT EXISTS(SELECT 1 FROM assignments a WHERE a.project_id=CAST(j.target AS INTEGER) AND a.status IN ('READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING'))").all(this.now());
  for(const row of rows){this.db.prepare("UPDATE integration_jobs SET state='CANCELLED',safe_retry=0,error_code='',updated_at=? WHERE id=?").run(this.now(),row.id);this.db.prepare("UPDATE blacklake_sync_snapshots SET error_code='' WHERE kind=? AND target=? AND error_code IN ('BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN')").run(row.kind,row.target);this.jobs.event(row.id,'CACHE_REFRESH_SUPERSEDED','SYSTEM',{reason:'local-first-central-sync'});}return rows.length;
 }
 scheduleNightly(){
  const now=this.now(),local=new Date(now+8*3600000),minutes=local.getUTCHours()*60+local.getUTCMinutes(),today=day(now);
  if(minutes<NIGHTLY_START||minutes>=NIGHTLY_CATCHUP_END||this.snapshot('control','nightly-maintenance').data?.date===today)return;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const orders=this.db.prepare(`SELECT project_id,s.fetched_at
    FROM blacklake_order_index
    LEFT JOIN blacklake_sync_snapshots s ON s.kind='order' AND s.target=CAST(project_id AS TEXT)
    WHERE ${ORDER_VISIBLE} AND CAST(json_extract(details_json,'$.projectStatus') AS TEXT) IN ('0','10')
      AND (s.fetched_at IS NULL OR s.complete=0 OR s.fetched_at<=?)
      AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.job_key='read:order:'||project_id AND j.state IN ('QUEUED','RETRY','RUNNING','FAILED'))
    ORDER BY s.fetched_at IS NOT NULL AND s.complete=1,s.fetched_at,project_id LIMIT 500`).all(now-DAY);
   const queueOrder=row=>this.request('order',row.project_id,{projectId:row.project_id,reason:'nightly'});
   const missing=orders.filter(row=>row.fetched_at==null);
   missing.forEach(queueOrder);
   const yesterday=day(now-DAY),first=Math.min(Date.parse(today.slice(0,7)+'-01T00:00:00+08:00'),Date.parse(yesterday+'T00:00:00+08:00'));
   const reportDays=[];
   for(let at=first;day(at)<=yesterday;at+=DAY){
    const date=day(at),to=date+' 23:59:59',snapshot=this.snapshot('history-day',date),watermark=snapshot.data?.watermark;
    if(snapshot.sync.complete&&watermark>=to||snapshot.sync.pending||snapshot.sync.paused)continue;
    const previous=createdMs(watermark),from=previous?stamp(Math.max(at,previous-MINUTE)):date+' 00:00:00';
    this.request('history-day',date,{date,pageNum:1,from,to,incremental:!!previous,reason:'nightly'});
    reportDays.push(date);
   }
   orders.filter(row=>row.fetched_at!=null).forEach(queueOrder);
   const recent=this.db.prepare(`SELECT i.project_id,i.project_code
    FROM blacklake_order_index i LEFT JOIN blacklake_sync_snapshots s ON s.kind='order-reports' AND s.target=CAST(i.project_id AS TEXT)
    WHERE (s.fetched_at IS NULL OR s.fetched_at<=?)
      AND EXISTS(SELECT 1 FROM blacklake_output_index b WHERE b.project_id=i.project_id AND b.deleted=0 AND (b.created_at>=? OR b.output_time>=?))
      AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.job_key='read:order-reports:'||i.project_id AND j.state IN ('QUEUED','RETRY','RUNNING','FAILED'))
    ORDER BY s.fetched_at,i.project_id LIMIT 30`).all(now-DAY,day(now-14*DAY),day(now-14*DAY));
   for(const row of recent)this.request('order-reports',row.project_id,{projectId:row.project_id,projectCode:row.project_code,pageNum:1,reason:'nightly'});
   this.save('control','nightly-maintenance',{date:today,scheduledAt:new Date(now).toISOString(),missingOrders:missing.length,staleOrders:orders.length-missing.length,reportDays,reportOrders:recent.length});
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 ensureScheduled(){
  this.orderWrites?.schedule();
  this.scheduleRecovery?.();
  this.pruneObsoleteReads();
  this.scheduleNightly();
  const catalog=this.snapshot('catalog','all');
  if(!catalog.sync.complete)this.request('catalog','all',{year:catalog.sync.scope.nextYear||catalogYear(this.now()),pageNum:catalog.sync.scope.nextPage||1});
  else{
   const head=this.snapshot('catalog','all-head'),end=this.now()-10000,previous=createdMs(head.data?.watermark);
   if(!head.sync.updatedAt||this.now()-Date.parse(head.sync.updatedAt)>(previous&&end-previous>DAY?MINUTE:this.ttl('catalog'))){
    const watermark=previous??end-DAY;
    if(watermark<=end)this.request('catalog','all-head',{year:catalogYear(this.now()),pageNum:1,updatedFrom:stamp(watermark-5*MINUTE),updatedTo:stamp(Math.min(end,watermark+DAY))});
   }
  }
  if(this.snapshot('people','all').sync.status!=='fresh')this.request('people','all');
  for(let n=0;n<=this.historyDays;n++){const date=day(this.now()-n*86400000),s=this.snapshot('history-day',date),end=n===0?stamp(this.now()):date+' 23:59:59',watermark=s.data?.watermark;if(!s.sync.complete||n===0&&s.sync.status!=='fresh'||n===1&&watermark&&watermark<end)this.request('history-day',date,{date,pageNum:1,from:watermark?stamp(Math.max(Date.parse(date+'T00:00:00+08:00'),Date.parse(watermark.replace(' ','T')+'+08:00')-60000)):date+' 00:00:00',to:end,incremental:!!watermark});}
  for(const row of this.db.prepare("SELECT DISTINCT project_id FROM assignments WHERE status IN ('READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING') AND project_id>0").all())if(!this.store.orderRemoved(row.project_id)&&this.snapshot('order',row.project_id).sync.status!=='fresh')this.request('order',row.project_id,{projectId:row.project_id});
  if(typeof this.blacklake.readWorkOrderPresence==='function'&&this.now()-(this.snapshot('control','order-presence-audit').data?.at??0)>=MINUTE){
   const row=this.db.prepare(`SELECT i.project_id FROM blacklake_order_index i
    LEFT JOIN blacklake_sync_snapshots p ON p.kind='order-presence' AND p.target=CAST(i.project_id AS TEXT)
    WHERE (p.fetched_at IS NULL OR p.fetched_at<?) AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.job_key='read:order-presence:'||i.project_id AND j.state IN ('RUNNING','QUEUED','RETRY','FAILED'))
    ORDER BY p.fetched_at,i.created_at_ms DESC,i.project_id DESC LIMIT 1`).get(this.now()-7*DAY);
   if(row)this.requestOrderPresence(row.project_id);
   this.save('control','order-presence-audit',{at:this.now()});
  }
  // APIs without an updated-since contract are checked in bounded rotation,
  // never re-read once per visitor. At most one old snapshot per minute.
  const audit=this.snapshot('control','read-audit').data;if(!audit||this.now()-audit.at>=60000){const row=this.db.prepare("SELECT s.kind,s.target FROM blacklake_sync_snapshots s INDEXED BY blacklake_snapshot_read_audit WHERE s.kind IN ('order','order-reports') AND s.complete=1 AND s.fetched_at<? AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.job_key='read:'||s.kind||':'||s.target AND j.state IN ('QUEUED','RETRY','RUNNING','FAILED')) ORDER BY s.fetched_at,s.kind,s.target LIMIT 1").get(this.now()-6*3600000);if(row){const info=this.db.prepare('SELECT project_code FROM blacklake_order_index WHERE project_id=?').get(Number(row.target));if(info)this.request(row.kind,row.target,{projectId:Number(row.target),projectCode:info.project_code,pageNum:1,reason:'audit'});this.save('control','read-audit',{at:this.now()});}}
 }
 async refresh(job){
  const {kind,target,payload}=job;
  if(kind==='catalog'){
   if(payload.updatedFrom){
    const page=await this.blacklake.queryWorkOrderCatalogPage(payload);
    if(this.assertClaim(job).generation!==job.claimed_generation)return {readContinuation:true};
    if(payload.expectedTotal!=null&&page.total!=null&&page.total!==payload.expectedTotal){
     assert((payload.restarts??0)<3,502,'SYNC_CATALOG_WINDOW_CHANGED','窗口在分页期间变化，水位已保留。');
     this.request(kind,target,{...payload,pageNum:1,expectedTotal:null,restarts:(payload.restarts??0)+1},true);
     return {readContinuation:true,restartedWindow:true};
    }
    this.db.exec('BEGIN IMMEDIATE');try{
     let changed=0;
     for(const info of page.records){
      const updated=this.indexOrder(info,{catalog:true});
      if(updated)changed++;
      if(this.store.orderRemoved(info.projectId))this.requestOrderPresence(info.projectId);
      else if(String(info.projectStatus)==='10'){
       const order=this.snapshot('order',info.projectId);
       if(!order.sync.complete||updated&&String(order.data?.info?.projectStatus)!=='10')
        this.request('order',info.projectId,{projectId:Number(info.projectId),reason:'catalog-delta'});
      }
     }
     const previous=this.snapshot(kind,target).data,more=page.hasMore;
     this.save(kind,target,{watermark:more?(previous?.watermark??null):payload.updatedTo},{complete:!more,scope:{basis:'updatedAt',from:payload.updatedFrom,to:payload.updatedTo,nextPage:more?payload.pageNum+1:null}});
     if(more){assert(payload.pageNum<10000,502,'SYNC_CATALOG_LIMIT','工单更新时间窗口仍在分批补齐。');this.request(kind,target,{...payload,pageNum:payload.pageNum+1,expectedTotal:page.total??null},true);}
     this.db.exec('COMMIT');return {records:page.records.length,changed,incremental:true,windowComplete:!more};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
   }
   const year=Math.max(CATALOG_FIRST_YEAR,payload.year||catalogYear(this.now())),page=await this.blacklake.queryWorkOrderCatalogPage({year,pageNum:payload.pageNum});this.assertClaim(job);let changed=0;
   const nextYear=page.hasMore?year:year>CATALOG_FIRST_YEAR?year-1:catalogYear(this.now()),nextPage=page.hasMore?payload.pageNum+1:year>CATALOG_FIRST_YEAR?1:2;
   const more=page.hasMore||target==='all'&&year>CATALOG_FIRST_YEAR;
   this.db.exec('BEGIN IMMEDIATE');try{for(const info of page.records)if(this.indexOrder(info,{catalog:true})){changed++;}
    this.save(kind,target,{pageNum:payload.pageNum,year,nextPage,nextYear},{complete:payload.incremental===true||!more,scope:{allOrders:target==='all',firstYear:CATALOG_FIRST_YEAR,year,nextPage:more?nextPage:null,nextYear:more?nextYear:null,incremental:!!payload.incremental}});this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
   if(more&&!payload.incremental){assert(payload.pageNum<10000,502,'SYNC_CATALOG_LIMIT','目录仍在分批补齐。');this.request('catalog',target,{...payload,year:nextYear,pageNum:nextPage},true);}return {records:page.records.length,changed,incremental:!!payload.incremental};
  }
  if(kind==='order-presence')return this.confirmOrderPresence(job,Number(payload.projectId));
  if(kind==='people'){const people=await this.blacklake.listOperators({fresh:true});this.assertClaim(job);assert(Array.isArray(people),502,'SYNC_PEOPLE_FORMAT','人员资料格式无效。');this.save(kind,target,people);return {records:people.length};}
  if(kind==='order'){
   const id=Number(payload.projectId),steps=this.jobs.progress(job);let tasks=steps.tasks;
   if(this.store.orderRemoved(id))return {removed:true};
   if(!tasks){
    const pending=isOrderOperationRead(payload.reason)?pendingOrderOperation(this.db,id):null;
    const orderOperation=pending?.status==='UNKNOWN'?{actor:pending.actor,id:pending.operation_id}:null;
    try{tasks=await this.blacklake.listWorkOrderProcesses('projectId='+id,{includeCompleted:true,fresh:true});}
    catch(error){
     if(error.code==='WORK_ORDER_NOT_FOUND'&&typeof this.blacklake.readWorkOrderPresence==='function'){
      const result=await this.confirmOrderPresence(job,id);if(result.present===false)return {removed:true};if(result.superseded)return {readContinuation:true};
     }
     throw error;
    }
    if(this.assertClaim(job).generation!==job.claimed_generation)return {readContinuation:true};
    assert(Array.isArray(tasks)&&tasks.every(t=>Number(t.projectId)===id),502,'SYNC_ORDER_IDENTITY','工序归属不一致。');
    const prior=this.snapshot('order',id).data;
    if(!tasks.length&&prior?.tasks?.length){
     if(typeof this.blacklake.readWorkOrderPresence==='function'){const result=await this.confirmOrderPresence(job,id);if(result.present===false)return {removed:true};if(result.superseded)return {readContinuation:true};}
     throw new AppError(502,'BLACKLAKE_EMPTY_TASK_RESULT','工序查询为空，已保留上次完整工序。');
    }
    this.jobs.checkpoint(job,{tasks,orderOperation});const indexed=this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?').get(id),info=prior?.info||(indexed?JSON.parse(indexed.details_json):null);
    if(info)this.save('order',id,{info,tasks},{complete:false,scope:{step:'details'}});
    return {readContinuation:true,records:tasks.length};
   }
   const known=this.db.prepare('SELECT project_code FROM blacklake_order_index WHERE project_id=?').get(id),projectCode=tasks[0]?.projectCode||known?.project_code;assert(projectCode,503,'SYNC_CATALOG_REQUIRED','先同步工单目录。');
   let info;
   try{info=await this.blacklake.readWorkOrderDetails(id,projectCode,{fresh:true});}catch(error){
    if(error.code==='WORK_ORDER_NOT_FOUND'&&typeof this.blacklake.readWorkOrderPresence==='function'){
     const result=await this.confirmOrderPresence(job,id);
     if(result.present===false)return {removed:true};
     if(result.superseded)return {readContinuation:true};
    }
    throw error;
   }
   if(this.assertClaim(job).generation!==job.claimed_generation)return {readContinuation:true};
   assert(Number(info.projectId)===id&&info.projectCode===projectCode,502,'SYNC_ORDER_IDENTITY','工单归属不一致。');
   // An empty response must not silently erase a previously nonempty route.
   const prior=this.snapshot('order',id).data;if(!tasks.length&&prior?.tasks?.length)throw new AppError(502,'BLACKLAKE_EMPTY_TASK_RESULT','工序查询为空，已保留上次完整工序。');
   this.db.exec('BEGIN IMMEDIATE');try{
    this.indexOrder(info);this.save(kind,id,{info,tasks});
    if(steps.orderOperation){
     const pending=pendingOrderOperation(this.db,id);
     if(pending?.actor===steps.orderOperation.actor&&pending.operation_id===steps.orderOperation.id)
      reconcileOrderOperation(this.db,workspaceOrder(info,tasks),pending,this.now(),{allowRestored:payload.reason!=='order-operation'});
    }
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}return {records:tasks.length};
  }
  if(kind==='output'){
   const steps=this.jobs.progress(job);let value;
   if(payload.verifyAbsence&&payload.projectCode)this.blacklake.outputProjectCodes?.set(String(payload.outputId),payload.projectCode);
   try{value=await this.blacklake.readOutputForCorrection(payload.outputId,{production:true,...(steps.outputBase&&this.now()-steps.outputBaseAt<120000?{resume:steps.outputBase}:{}),onReadStep:async outputBase=>{this.assertClaim(job);this.jobs.checkpoint(job,{outputBase,outputBaseAt:this.now()});}});}catch(error){if(payload.verifyAbsence&&error.definiteAbsence===true){this.assertClaim(job);const changed=this.db.prepare('UPDATE blacklake_output_index SET deleted=1,updated_at=? WHERE output_id=? AND project_id=? AND updated_at<=?').run(this.now(),String(payload.outputId),Number(payload.projectId),payload.scanStartedAt);return {records:0,confirmedAbsent:true,deleted:changed.changes===1};}if(error.code==='REPORT_REMOTE_CHANGED')this.jobs.checkpoint(job,{});throw error;}
   const id=String(value.id);assert(id===String(payload.outputId),502,'SYNC_OUTPUT_IDENTITY','报工归属不一致。');
   this.assertClaim(job);const existing=this.db.prepare('SELECT raw_json FROM blacklake_output_index WHERE output_id=?').get(id),local=this.db.prepare('SELECT created_at,output_time FROM reports WHERE blacklake_output_id=?').get(id),prior=existing?JSON.parse(existing.raw_json):{};
   const raw={...prior,...value,taskId:value.projectProcessId,productionStaffId:value.operatorId,numberofgoodProducts:value.fineAmount,numberofDefectives:value.defectsAmount,createdAt:prior.createdAt||(local?stamp(local.created_at.replace(' ','T')+'Z'):''),outputTime:prior.outputTime||local?.output_time||''};
   this.db.prepare("INSERT INTO blacklake_output_index(output_id,project_id,task_id,output_time,created_at,raw_json,correction_json,correction_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(output_id) DO UPDATE SET raw_json=excluded.raw_json,correction_json=excluded.correction_json,correction_at=excluded.correction_at,updated_at=excluded.updated_at").run(id,value.projectId,value.projectProcessId,stamp(raw.outputTime),stamp(raw.createdAt),JSON.stringify(raw),JSON.stringify(value),this.now(),this.now());return {records:1};
  }
  if(kind==='history-day'){
   const to=payload.to||(payload.date===day(this.now())?stamp(this.now()):payload.date+' 23:59:59');
   const page=await this.blacklake.queryOutputPage({createdAtGte:payload.from||payload.date+' 00:00:00',createdAtLte:to},{pageNum:payload.pageNum,pageSize:100});if(this.assertClaim(job).generation!==job.claimed_generation)return {readContinuation:true};
   const more=page.total===null?page.records.length===100:payload.pageNum*100<page.total;
   assert(!more||payload.pageNum<10000,502,'SYNC_HISTORY_LIMIT','历史同步需缩小日期范围。');
   this.db.exec('BEGIN IMMEDIATE');try{
    const affected=new Set(),existing=this.db.prepare('SELECT 1 FROM blacklake_output_index WHERE output_id=?');
    const put=this.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,output_time,created_at,raw_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(output_id) DO UPDATE SET raw_json=CASE WHEN blacklake_output_index.correction_json IS NULL THEN excluded.raw_json ELSE blacklake_output_index.raw_json END,output_time=excluded.output_time,created_at=excluded.created_at,updated_at=excluded.updated_at');
    for(const row of page.records){
     const id=row.reportingId??row.id??row.outputId;
     assert(id!=null&&positive(row.projectId),502,'SYNC_OUTPUT_IDENTITY','历史报工缺少身份。');
     const createdAt=stamp(row.createdAt),projectId=Number(row.projectId);
     assert(createdAt,502,'SYNC_HISTORY_TIME_MISSING','历史报工缺少可核对的创建时间。');
     if(!existing.get(String(id)))affected.add(projectId);
     put.run(String(id),projectId,Number(row.projectProcessId??row.taskId)||null,stamp(row.outputTime),createdAt,JSON.stringify(row),this.now());
    }
    this.queueReportProgress(affected,{nightly:payload.reason==='nightly'});
    if(more)this.request('history-day',target,{...payload,to,pageNum:payload.pageNum+1},true);
    this.save('history-day',payload.date,{pageNum:payload.pageNum,watermark:more?(this.snapshot('history-day',payload.date).data?.watermark??null):to},{complete:!more,scope:{from:payload.date,to:payload.date,nextPage:more?payload.pageNum+1:null,incremental:!!payload.incremental}});
    this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   return {records:page.records.length};
  }
  if(kind==='order-reports'){
   const pageNum=payload.pageNum||1,startedAt=this.now(),page=await this.blacklake.queryOutputPage({projectCode:payload.projectCode},{pageNum,pageSize:100});this.assertClaim(job);
   if(this.jobs.get(job.id).generation!==job.claimed_generation)return {supersededRead:true};
   const prior=this.snapshot(kind,target),ids=pageNum===1?[]:(prior.data?.buildingIds||[]),scanStartedAt=pageNum===1?startedAt:prior.data?.scanStartedAt||startedAt;
   // projectCode is a fuzzy upstream search, so "test" also matches "审核test".
   // Filter by immutable project ID. Missing identity must still fail instead
   // of making an incomplete history appear complete.
   assert(page.records.every(r=>positive(r.projectId)),502,'SYNC_OUTPUT_IDENTITY','工单报工缺少真实工单编号，未覆盖原记录。');
   const records=page.records.filter(r=>Number(r.projectId)===Number(payload.projectId));
   assert(records.every(r=>positive(r.reportingId??r.id??r.outputId)&&positive(r.taskId??r.projectProcessId)),502,'SYNC_OUTPUT_IDENTITY','目标工单报工或工序身份不完整，未覆盖原记录。');
   // Follow the original upstream page even when every row is filtered out.
   const more=page.total===null?page.records.length===100:pageNum*100<page.total;
   assert(!more||pageNum<10000,502,'SYNC_HISTORY_LIMIT','工单报工仍需分批补齐。');
   this.db.exec('BEGIN IMMEDIATE');try{
    const projectId=Number(payload.projectId),affected=new Set(),existing=this.db.prepare('SELECT 1 FROM blacklake_output_index WHERE output_id=?');
    const put=this.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,output_time,created_at,raw_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(output_id) DO UPDATE SET project_id=excluded.project_id,task_id=excluded.task_id,raw_json=excluded.raw_json,created_at=excluded.created_at,output_time=excluded.output_time,correction_json=NULL,correction_at=NULL,updated_at=excluded.updated_at WHERE blacklake_output_index.updated_at<=?');
    for(const row of records){
     const id=String(row.reportingId??row.id??row.outputId);ids.push(id);
     if(!existing.get(id))affected.add(projectId);
     put.run(id,projectId,Number(row.taskId??row.projectProcessId),stamp(row.outputTime),stamp(row.createdAt),JSON.stringify(row),this.now(),scanStartedAt);
    }
    this.queueReportProgress(affected,{nightly:payload.reason==='nightly'});
    this.save(kind,target,{ids:more?[...new Set([...(prior.data?.ids||[]),...ids])]:[...new Set(ids)],buildingIds:more?ids:[],pageNum,scanStartedAt},{complete:!more,scope:{projectId:Number(payload.projectId),allDates:true,nextPage:more?pageNum+1:null}});
    // A missing fuzzy-search row is not proof of deletion. Confirm absence by
    // exact output ID separately; newer incremental/mutation receipts win.
    if(!more){const found=new Set(ids.map(String));for(const row of this.db.prepare("SELECT output_id FROM blacklake_output_index b WHERE project_id=? AND deleted=0 AND updated_at<? AND NOT EXISTS(SELECT 1 FROM reports r LEFT JOIN report_production_details p ON p.report_id=r.id JOIN operators o ON o.id=COALESCE(json_extract(p.data_json,'$.operatorId'),r.operator_id) WHERE r.blacklake_output_id=b.output_id AND o.blacklake_operator_id>=1000000000000)").all(Number(payload.projectId),scanStartedAt))if(!found.has(row.output_id)){const prior=this.jobs.byKey('read:output:'+row.output_id);if(payload.requestId&&prior?.state==='FAILED')this.jobs.retry(prior.id,'USER:process-report-refresh',prior);this.request('output',row.output_id,{outputId:row.output_id,verifyAbsence:true,projectId:Number(payload.projectId),projectCode:payload.projectCode,scanStartedAt,...(payload.reason==='nightly'?{reason:'nightly'}:{}),...(payload.requestId?{refreshRequestId:payload.requestId}:{})},!!payload.requestId);}}
    if(more)this.request(kind,target,{...payload,pageNum:pageNum+1},true);
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}return {records:records.length,scanned:page.records.length,filtered:page.records.length-records.length};
  }
  const custom=this.handlers.get(kind);assert(custom,422,'SYNC_KIND_UNSUPPORTED','同步类型不支持。');return custom(job);
 }
 assertClaim(job){const current=this.jobs.get(job.id);assert(current?.state==='RUNNING'&&current.attempts===job.attempts&&current.lease_until>this.now(),409,'SYNC_LEASE_LOST','同步结果已过期，未覆盖新快照。');return current;}
 readFailures(job){
  if(Number.isSafeInteger(job.result.consecutiveFailures))return job.result.consecutiveFailures;
  const events=this.db.prepare("SELECT event FROM integration_job_events WHERE job_id=? AND event IN ('RETRY','FAILED','SUCCEEDED','MANUAL_RETRY') AND COALESCE(json_extract(data_json,'$.code'),'') NOT IN ('BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN') ORDER BY id DESC LIMIT ?").all(job.id,this.maxReadFailures);let count=0;for(const e of events){if(['SUCCEEDED','MANUAL_RETRY'].includes(e.event))break;count++;}return count;
 }
 parkExhaustedReads(){for(const row of this.db.prepare("SELECT id FROM integration_jobs WHERE mode='read' AND state='RETRY' AND error_code<>''").all()){const job=this.jobs.get(row.id),failures=this.readFailures(job);if(failures<this.maxReadFailures)continue;this.db.prepare("UPDATE integration_jobs SET state='FAILED',safe_retry=1,lease_until=NULL,result_json=?,updated_at=? WHERE id=? AND state='RETRY'").run(JSON.stringify({...job.result,consecutiveFailures:failures,autoPaused:true}),this.now(),job.id);this.jobs.event(job.id,'AUTO_PAUSED','SYSTEM',{failures,code:job.error_code});}}
 claimNext(){
  // Weighted round robin, with unused slots borrowed by any ready lane. FIFO
  // age survives deferrals and steps, so recurring updates cannot jump ahead.
  const state=this.snapshot('control','scheduler').data||{},streak=state.writeStreak||0,readLanes=state.nextRead==='background'?['background','interactive']:['interactive','background'];
  const lanes=streak<2?['write',...readLanes]:[...readLanes,'write'];
  for(const lane of lanes){const job=this.jobs.claim({lane});if(job){this.save('control','scheduler',{writeStreak:lane==='write'?streak+1:0,nextRead:lane==='write'?readLanes[0]:lane==='interactive'?'background':'interactive'});return {...job,interactive:lane==='interactive'};}}
  return null;
 }
 async tick(){
  if(this.running)return false;this.running=true;let job,heartbeat;
  try{for(const recovered of this.jobs.recover())this.onRecovered?.(recovered);if(this.snapshot('control','rate-limit').data?.until>this.now()||this.blacklake.requestBudget?.state.cooldownUntil>this.now())return false;job=this.claimNext();if(!job)return false;heartbeat=setInterval(()=>{try{this.jobs.heartbeat(job.id,job.attempts);}catch{}},30000);heartbeat.unref?.();const write=()=>job.kind==='order-operation-write'?this.orderWrites.execute(job):(this.handlers.get(job.kind)||this.writeHandler)(job),refresh=()=>this.refresh(job),read=()=>this.blacklake.withDeferredRepeatedReads?this.blacklake.withDeferredRepeatedReads(refresh):refresh(),result=job.mode==='write'?(this.blacklake.withPriority?await this.blacklake.withPriority(write):await write()):job.interactive&&this.blacklake.withPriority?await this.blacklake.withPriority(read):await read();this.jobs.finish(job.id,{attempt:job.attempts,...(result?.readContinuation?{state:'QUEUED'}:{}),...(result?.jobOutcome||{}),result:result?.result??result});return true;}
  catch(error){if(job&&this.jobs.get(job.id)?.state==='RUNNING'&&this.jobs.get(job.id)?.attempts===job.attempts){const sending=job.mode==='write'&&this.jobs.get(job.id).phase==='SENDING',transient=error.upstreamStatus===429||['BLACKLAKE_TIMEOUT','BLACKLAKE_UNAVAILABLE','BLACKLAKE_DATA_SYNCING','LOCAL_SUBMISSION_NOT_SENT'].includes(error.code),retry=job.mode==='read'||!sending&&transient||sending&&job.kind==='report-create'&&error.upstreamStatus===429;
    const deferred=['BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(error.code),failures=job.mode==='read'?this.readFailures(job)+(deferred?0:1):0,canRetry=deferred?(!sending||error.definiteFailure===true):retry||error.upstreamStatus===429&&error.definiteFailure===true;
    const state=job.mode==='read'?deferred?'QUEUED':failures>=this.maxReadFailures?'FAILED':'RETRY':sending&&!canRetry&&error.definiteFailure!==true?'UNKNOWN':canRetry?'RETRY':'FAILED',delay=deferred?(error.retryAfterMs||10000)+Math.floor(this.random()*Math.min(1000,(error.retryAfterMs||10000)*.1)):job.mode==='read'?Math.round(Math.min(15*60000,10000*2**Math.min(failures-1,6))*(.75+this.random()*.5)):undefined;this.jobs.finish(job.id,{attempt:job.attempts,state,code:code(error),...(delay!==undefined?{delayMs:delay}:{}),safeRetry:state!=='UNKNOWN'&&(!sending||canRetry||error.definiteFailure===true),result:{upstreamStatus:error.upstreamStatus||null,...(job.mode==='read'?{consecutiveFailures:failures,autoPaused:state==='FAILED',...(job.result.autoProbe?{autoProbe:true}:{})}:{})}});if(error.upstreamStatus===429)this.save('control','rate-limit',{until:this.now()+Math.min(15*60000,10000*2**Math.min(job.attempts-1,6))});
   if(job.mode==='read')this.db.prepare("INSERT INTO blacklake_sync_snapshots(kind,target,data_json,complete,error_code) VALUES(?,?,'null',0,?) ON CONFLICT(kind,target) DO UPDATE SET error_code=excluded.error_code").run(job.kind,job.target,code(error));
    if(job.mode==='write')this.onWriteError?.(job,error,state);
   }return false;}
  finally{clearInterval(heartbeat);this.running=false;}
 }
 start(){if(this.timer)return;this.parkExhaustedReads();this.ensureScheduled();const warn=e=>console.warn(JSON.stringify({event:'shared_sync_worker_failed',code:code(e)})),loop=async()=>{if(this.stopping)return;let completed=false;try{completed=await this.tick();}catch(e){warn(e);}if(!this.stopping){this.timer=setTimeout(loop,completed?25:this.intervalMs);this.timer.unref?.();}};this.timer=setTimeout(loop,0);this.scheduleTimer=setInterval(()=>{try{this.ensureScheduled();}catch(e){warn(e);}},30000);this.timer.unref?.();this.scheduleTimer.unref?.();}
 async stop(){this.stopping=true;clearTimeout(this.timer);clearInterval(this.scheduleTimer);while(this.running)await new Promise(r=>setTimeout(r,10));}
 status({attentionGroups}={}){const counts=this.db.prepare('SELECT mode,state,COUNT(*) count FROM integration_jobs GROUP BY mode,state').all();return {source:'local_sqlite',counts,automation:this.recovery?.summary(attentionGroups)||null,requestBudget:this.blacklake.requestBudget?.status()||null,refreshPolicy:this.refreshPolicy,maxReadFailures:this.maxReadFailures,nightlyMaintenance:{time:'03:10',timeZone:'Asia/Shanghai',lastPlan:this.snapshot('control','nightly-maintenance').data},orders:this.db.prepare('SELECT COUNT(*) n FROM blacklake_order_index WHERE '+ORDER_VISIBLE).get().n,products:this.db.prepare('SELECT COUNT(*) n FROM blacklake_product_index').get().n,outputs:this.db.prepare('SELECT COUNT(*) n FROM blacklake_output_index WHERE deleted=0').get().n,people:this.snapshot('people','all').sync,catalog:[{year:'全部',...this.snapshot('catalog','all').sync}],catalogDelta:this.snapshot('catalog','all-head').sync,history:this.outputsSnapshot().sync};}
 jobVersion(job){return createHash('sha256').update(JSON.stringify([job.state,job.attempts,job.updated_at,job.result_json,job.error_code])).digest('hex');}
 publicJob(job){const task=job.mode==='write'?this.store.assignmentById(job.target):null,paused=job.mode==='read'&&job.state==='FAILED';return {id:job.id,automation:this.recovery?.status(job)||null,version:this.jobVersion(job),kind:job.kind,mode:job.mode,target:job.target,reportId:job.report_id,...(job.kind==='manual-report-create'?{createdOutputId:this.store.reportById(job.report_id)?.blacklake_output_id||null}:{}),state:job.state,label:paused?'待处理':labels[job.state]||job.state,attempts:job.attempts,updatedAt:new Date(job.updated_at).toISOString(),errorCode:job.error_code,errorMessage:paused?'读取连续失败，已暂停自动重试；保留已有资料，处理后可手动重试。':job.error_code?(job.result.upstreamStatus===429?'黑湖限流，后台将自动重试。':['BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(job.error_code)?'后台限速排队，尚未发出新的黑湖请求。':errorLabels[job.error_code]||'同步尚未完成，请查看记录并核对。'):'',canRetry:!!job.safe_retry&&['FAILED','RETRY'].includes(job.state),needsReview:job.state==='UNKNOWN'&&job.kind!=='order-operation-write',result:job.result,...(task?{projectCode:task.projectCode,processName:task.processName,operatorName:task.operatorName}:job.kind.startsWith('upstream-report-')?{projectCode:job.payload.projectCode,processName:job.payload.processName,operatorName:job.payload.operatorName}:{})};}
}
