import {reportAuthority} from './report-authority.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {assert,AppError} from './errors.mjs';
import {createExecution} from './workspace-domain.mjs';
import {FLOOR8_UNIT_IDS} from './dispatch.mjs';
import {employeeWorkUnits} from './cutting-self-work.mjs';
import {isQualityInspection,reportedTaskAmount} from './quality.mjs';
import {processProgress} from './process-progress.mjs';
import {processEditLocksTask} from './order-process-edits.mjs';
import {effectiveWorkSecondsBetween} from './work-time.mjs';
import {shanghaiTime} from './task-recovery.mjs';
import {reportProduction} from './report-production.mjs';
import {requiresManualReportQuantity} from './people-groups.mjs';
import {groupApprovalPending} from './group-report-review.mjs';
import {BOUND_EMBROIDERY_ASSIGNMENT,isEmbroideryProcessName} from './embroidery.mjs';

const active=['READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING'];
const placeholders=items=>items.map(()=>'?').join(',');
const historyPageSize=80;
const localActions=new Set(['dispatch','reorderQueue','insertAssignment','resume','start','end','cancelEnd','cancelSelfReport','exitClosedSelfTask','skipClosedAssignment','editAssignment','cancelAssignment','selfStart']);
const delegatedTimerActions=new Set(['leaderStartTimer','leaderPauseTimer']);
const useProcessActions=new Set(['dispatch','selfStart','start','resume','leaderStartTimer','insertAssignment','editAssignment']);
const timerGroups=config=>(config.groups||[]).map(group=>({leaderIds:group.leaderIds,employeeIds:group.blacklakeOperatorIds}));
const same=(a,b)=>String(a)===String(b),copy=v=>structuredClone(v);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const iso=v=>{if(!v)return null;const at=Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(v)?v:String(v).replace(' ','T')+'+08:00');return Number.isFinite(at)?new Date(at).toISOString():null;};
const sql=v=>v?shanghaiTime(Date.parse(v)):null;
const amount=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
const remaining=(plan,done)=>plan===null||done===null?null:Math.max(0,plan-done);
const norm=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
const orderPriorities={EXTREME:3,URGENT:2,EXPEDITED:1,PAUSED:-1,NONE:0};
const orderPriorityNames=Object.fromEntries(Object.entries(orderPriorities).map(([name,value])=>[value,name]));
const orderStatuses=['NOT_STARTED','IN_PROGRESS','FINISHED'];
const pendingSyncStates=['QUEUED','RETRY','RUNNING'];
const orderReviewReasons=['manual','order-operation','order-operation-review'];
export function isOrderOperationRead(reason){return orderReviewReasons.includes(reason);}

export function workspaceOrder(info,tasks=[]){
  const status=String(info.projectStatus??''),priorityCode=String(info.projectPriority);
  const priority=Object.hasOwn(orderPriorityNames,priorityCode)?orderPriorityNames[priorityCode]:null;
  return {id:Number(info.projectId),code:info.projectCode,title:info.projectCode,
    statusText:({'0':'未开始','10':'执行中','20':'已结束'})[status]||'状态未确认',
    status:({'0':'NOT_STARTED','10':'IN_PROGRESS','20':'FINISHED'})[status]||'UNKNOWN',priority:priority||'NONE',priorityKnown:!!priority,
    product:[info.productCode,info.productName].filter(Boolean).join(' | '),productCode:info.productCode||'',productName:info.productName||'',productSpecification:info.productSpecification||'',
    images:(info.productImageUrls||[]).map(url=>({url})),imageUrls:info.productImageUrls||[],imageUrl:info.productImageUrls?.[0]||'',
    planQuantity:amount(info.plannedAmount),completedQuantity:amount(info.actualAmount),remainingQuantity:remaining(amount(info.plannedAmount),amount(info.actualAmount)),unit:info.unit||'',startAt:info.planStartTime||'未确认',endAt:info.planEndTime||'未确认',createdAt:info.createdAt??null,upstreamUpdatedAt:info.updatedAt||null,
    processes:tasks.map(task=>{
      const planQuantity=task.quantityPresence?.plannedAmount===false?null:amount(task.plannedAmount),goodQuantity=task.quantityPresence?.reportedGoodAmount===false?null:amount(task.reportedGoodAmount),defectiveQuantity=task.quantityPresence?.reportedDefectAmount===false?null:amount(task.reportedDefectAmount),qualityInspection=isQualityInspection(task.processName);
      const done=qualityInspection?(goodQuantity!==null&&defectiveQuantity!==null?goodQuantity+defectiveQuantity:null):goodQuantity;
      const {closed}=processProgress(task);
      return {id:Number(task.taskId),name:task.processName,closed,selectable:!closed&&[0,10].includes(Number(task.processStatus))&&task.processStatus!=null,priority:task.processPriority!=null&&Number.isFinite(Number(task.processPriority))?Number(task.processPriority):null,priorityKnown:task.processPriority!=null&&Number.isFinite(Number(task.processPriority)),
        planQuantity,goodQuantity,defectiveQuantity,remainingQuantity:amount(task.remnantAmount)??remaining(planQuantity,done),qualityInspection,statusText:task.processStatusDisplay||(Number(task.processStatus)===20?'已关闭':Number(task.processStatus)===10?'执行中':task.processStatus!=null&&Number(task.processStatus)===0?'未开始':'状态未提供'),percent:planQuantity>0&&goodQuantity!==null?Math.round(goodQuantity/planQuantity*100)+'%':'—'};
    })};
}

function matchesOrder(order,target){
  const priority=orderPriorities[target.priority];
  return order.status===target.status&&order.priorityKnown&&order.priority===target.priority&&
    (!target.syncPriority||order.processes.every(p=>p.closed||p.priorityKnown&&p.priority===priority));
}

export function pendingOrderOperation(db,id){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_order_operations'").get())return null;
  return db.prepare("SELECT * FROM workspace_order_operations WHERE order_id=? AND status IN ('PENDING','UNKNOWN')").get(id);
}

function restoredPriority(order,before,target){
  if(before.id!==order.id||before.code!==order.code||!before.priorityKnown||
      !['NOT_STARTED','IN_PROGRESS'].includes(before.status)||before.status!==target.status||
      before.status!==order.status||before.priority!==order.priority||!Object.hasOwn(orderPriorities,before.priority))return false;
  if(!target.syncPriority)return before.priority!==target.priority;
  const previous=before.processes.filter(p=>!p.closed),current=order.processes.filter(p=>!p.closed);
  return previous.length===current.length&&current.every(p=>p.priorityKnown&&previous.some(old=>old.id===p.id&&old.priorityKnown&&old.priority===p.priority));
}

function restoredStatus(order,before,target,receipt,now){
  // An old receipt whose only change was execution status can be retired when
  // a new read sees the entire original state after the write has had time to settle.
  return now-Date.parse(iso(receipt.updated_at))>=60000&&!target.syncPriority&&orderStatuses.includes(before.status)&&
    before.status!==target.status&&order.status===before.status&&before.priorityKnown&&
    before.priority===target.priority&&order.priority===before.priority;
}

export function reconcileOrderOperation(db,order,pending,now,{allowRestored=false}={}){
  if(pending?.status!=='UNKNOWN'||pending.order_id!==order.id||!order.priorityKnown)return false;
  const target=JSON.parse(pending.target_json),before=JSON.parse(pending.before_json);
  if(before.id!==order.id||before.code!==order.code)return false;
  const restored=allowRestored&&(restoredPriority(order,before,target)||restoredStatus(order,before,target,pending,now));
  const status=matchesOrder(order,target)?'SUCCEEDED':restored?'SUPERSEDED':null;
  if(!status)return false;
  const result={status,operationId:pending.operation_id,reconciliation:{source:'blacklake-live',status:order.status,priority:order.priority,checkedAt:new Date(now).toISOString()},
    message:status==='SUPERSEDED'?'黑湖当前仍是修改前的设置。旧操作已核对，可以重新编辑。':'工单修改已确认。'};
  const prior=JSON.parse(pending.result_json);
  const changed=db.prepare("UPDATE workspace_order_operations SET status=?,result_json=?,updated_at=? WHERE order_id=? AND actor=? AND operation_id=? AND status='UNKNOWN'")
    .run(status,JSON.stringify({...prior,...result,queued:false}),shanghaiTime(now),order.id,pending.actor,pending.operation_id).changes===1;
  if(changed&&prior.jobId){
    db.prepare("UPDATE integration_jobs SET state=?,error_code='',updated_at=? WHERE id=? AND kind='order-operation-write' AND state='UNKNOWN'")
      .run(status==='SUCCEEDED'?'SUCCEEDED':'CANCELLED',now,prior.jobId);
  }
  return changed;
}

// Formal SQLite projection for the confirmed native UI. No demo data or browser storage.
export function canOperateOrdersFromEmployeeView(store,session){
  // The authorized Blacklake account can hold this capability while working in the employee view.
  return session.scope!=='review'&&session.blacklakeOperatorId===3602917
    &&store.entryProfile(session.blacklakeOperatorId).appRole==='employee'
    &&store.qualityProfile(session.blacklakeOperatorId).qualityRole==='quality_leader';
}

export class Workspace {
  constructor({store,blacklake,listPeople,getPeopleGroups,profile,routing,embroideryAllowed,defectReasons=[],now=Date.now,leaderReports,dataSync,reportOutbox,groupReportReview,upstreamReports}){
    Object.assign(this,{store,blacklake,listPeople,getPeopleGroups,profile,routing,embroideryAllowed,defectReasons,now,leaderReports,dataSync,reportOutbox,groupReportReview,upstreamReports});this.db=store.db;this.orderCache=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_task_state(assignment_id TEXT PRIMARY KEY REFERENCES assignments(id),state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_operations(actor TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor,operation_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_order_operations(actor TEXT NOT NULL,operation_id TEXT NOT NULL,order_id INTEGER NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,before_json TEXT NOT NULL,target_json TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(actor,operation_id));
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_order_pending_idx ON workspace_order_operations(order_id) WHERE status IN ('PENDING','UNKNOWN');`);
    if(!store.workspaceOrdersRecovered){
      const activeWrite=dataSync?" AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.id=json_extract(result_json,'$.jobId') AND j.state IN ('QUEUED','RETRY','RUNNING'))":'';
      this.db.prepare("UPDATE workspace_order_operations SET status='UNKNOWN' WHERE status='PENDING'"+activeWrite).run();store.workspaceOrdersRecovered=true;
    }
    const cols=this.db.prepare('PRAGMA table_info(assignment_pauses)').all();if(!cols.some(row=>row.name==='source'))this.db.exec("ALTER TABLE assignment_pauses ADD COLUMN source TEXT NOT NULL DEFAULT 'employee'");
    this.leaderReports();
  }
  authorize(session,{embroidery=false}={}){
    const role=this.profile(session).appRole;
    if(embroidery){assert(session.scope!=='review'&&role==='employee'&&this.embroideryAllowed?.(session),403,'EMBROIDERY_MODE_NOT_ALLOWED','当前人员不能使用绣花报工。');return role;}
    assert(session.scope!=='review'&&(role==='floor8_leader'||role==='employee'&&this.routing(session).canReceiveFloor8Assignments),403,'WORKSPACE_ROLE_REQUIRED','此界面仅适用于8楼组长和员工。');return role;
  }
  orderOperationActor(session){
    const role=this.authorize(session);
    assert(role==='floor8_leader'||canOperateOrdersFromEmployeeView(this.store,session),
      403,'WORKSPACE_ROLE_REQUIRED','当前账号没有工单操作权限。');
    return (role==='floor8_leader'?role:'quality_leader')+':'+session.blacklakeOperatorId;
  }
  async directory(session,{embroidery=false}={}){
    if(embroidery){
      const role=this.authorize(session,{embroidery}),id=String(session.blacklakeOperatorId);
      const person={id,name:session.name,qualityRole:this.store.qualityProfile(session.blacklakeOperatorId).qualityRole,selfServiceEnabled:this.store.selfServicePermission(session.blacklakeOperatorId).enabled};
      return {people:[],employees:[person],groups:{groups:[]},actor:{role,id,employeeId:id}};
    }
    const role=this.authorize(session),people=await this.listPeople(),groups=this.getPeopleGroups(people);
    const employees=people.map(p=>({id:String(p.blacklakeOperatorId),name:p.name,departments:(groups.groups||[]).filter(g=>g.blacklakeOperatorIds.includes(p.blacklakeOperatorId)).map(g=>g.name),
      boundUnitIds:p.boundUnitIds||[],qualityRole:this.store.qualityProfile(p.blacklakeOperatorId).qualityRole,selfServiceEnabled:this.store.selfServicePermission(p.blacklakeOperatorId).enabled,blocked:p.inactive===true}));
    const actor={role,id:String(session.blacklakeOperatorId),...(role==='employee'?{employeeId:String(session.blacklakeOperatorId)}:{employeeIds:employees.map(p=>p.id)})};
    return {people,employees,groups,actor};
  }
  rows(session,{activeOnly=false,workerIds=null,history=null,orderId=null,embroidery=false}={}){
    const role=this.profile(session).appRole;
    const employeeScope="(a.operator_id=? OR a.report_id IN (SELECT id FROM reports WHERE operator_id=?))",leaderScope="(a.status IN ('READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING') OR a.published_by_operator_id=?)";
    const args=[...(embroidery?[]:FLOOR8_UNIT_IDS),...(role==='employee'?[session.id,session.id]:[session.blacklakeOperatorId])];
    const select=`SELECT a.*,o.blacklake_operator_id AS person_key,o.name AS person_name,o.active AS person_active FROM assignments a JOIN operators o ON o.id=a.operator_id
      WHERE ${embroidery?`(a.machine_id<>'' OR a.assignment_mode='${BOUND_EMBROIDERY_ASSIGNMENT}')`:`a.machine_id='' AND (a.station_name IN (${placeholders(FLOOR8_UNIT_IDS)}) OR a.assignment_mode='MANUAL_REPORT')`} AND ${role==='employee'?employeeScope:leaderScope}`;
    const activeFilter=`a.status IN (${placeholders(active)})`;
    const workerFilter=workerIds?.length?` AND o.blacklake_operator_id IN (${placeholders(workerIds)})`:'';
    const newest=' ORDER BY a.published_at DESC,a.id';
    if(history){
      const stamp='COALESCE(a.ended_at,a.published_at)';
      let filter=" AND a.status IN ('COMPLETED','CANCELLED')";
      if(history.start){filter+=` AND ${stamp}>=?`;args.push(history.start+' 00:00:00');}
      if(history.end){filter+=` AND ${stamp}<=?`;args.push(history.end+' 23:59:59');}
      return this.db.prepare(select+filter+` ORDER BY ${stamp} DESC,a.id LIMIT ? OFFSET ?`).all(...args,historyPageSize+1,(history.page-1)*historyPageSize);
    }
    const open=this.db.prepare(select+' AND '+activeFilter+workerFilter+newest).all(...args,...active,...(workerIds||[]));
    if(activeOnly)return open;
    const recent=this.db.prepare(select+' AND NOT ('+activeFilter+')'+(orderId?' AND a.project_id=?':'')+newest+' LIMIT 2000')
      .all(...args,...active,...(orderId?[orderId]:[]));
    return [...open,...recent].sort((a,b)=>String(b.published_at).localeCompare(String(a.published_at))||a.id.localeCompare(b.id));
  }
  taskFingerprint(rows){
    const ids=rows.map(r=>r.id),marks=placeholders(ids);
    const states=ids.length?this.db.prepare(`SELECT * FROM workspace_task_state WHERE assignment_id IN (${marks}) ORDER BY assignment_id`).all(...ids):[];
    const pauses=ids.length?this.db.prepare(`SELECT * FROM assignment_pauses WHERE assignment_id IN (${marks}) ORDER BY id`).all(...ids):[];
    const reports=ids.length?this.db.prepare(`SELECT r.* FROM reports r JOIN assignments a ON a.report_id=r.id WHERE a.id IN (${marks}) ORDER BY r.id`).all(...ids):[];
    return [rows,states,pauses,reports];
  }
  version(session,{embroidery=false}={}){
    const rows=this.rows(session,{activeOnly:Boolean(this.dataSync),embroidery});
    const permissions=['operator_entry_profiles','operator_quality_profiles','operator_worker_types','operator_self_service_permissions'].map(table=>this.db.prepare(`SELECT * FROM ${table} ORDER BY blacklake_operator_id`).all());
    const people=this.db.prepare('SELECT id,active,blacklake_operator_id FROM operators ORDER BY id').all();
    return parseInt(digest([...this.taskFingerprint(rows),permissions,people]).slice(0,13),16);
  }
  dispatchWorkers(input){
    assert(Array.isArray(input.workerIds)&&input.workerIds.length>0&&input.workerIds.length<=200,422,'WORKSPACE_INVALID_WORKERS','请选择 1 至 200 位派工人员。');
    const ids=[...new Set(input.workerIds.map(String))].sort();
    assert(ids.every(id=>/^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id))),422,'WORKSPACE_INVALID_WORKERS','所选人员无效，请重新选择。');
    return ids;
  }
  dispatchVersion(rows,order,input,ids){
    const process=order?.processes.find(row=>same(row.id,input.processId));
    const people=this.db.prepare(`SELECT id,active,blacklake_operator_id FROM operators WHERE blacklake_operator_id IN (${placeholders(ids)}) ORDER BY id`).all(...ids);
    return parseInt(digest([input.orderId,String(input.processId),input.priority,ids,order?.status,process?.closed,process?.selectable,process?.planQuantity,people,...this.taskFingerprint(rows)]).slice(0,13),16);
  }
  async order(id,{fresh=false}={}){
    if(this.dataSync)return this.dataSync.order(id,{refresh:fresh});
    return this.readLiveOrder(id,{fresh});
  }
  async readLiveOrder(id,{fresh=true}={}){
    id=Number(id);assert(Number.isSafeInteger(id)&&id>0,422,'INVALID_WORK_ORDER','工单编号无效。');
    const cached=this.orderCache.get(id);if(!fresh&&cached&&this.now()-cached.at<10000)return copy(cached.value);
    const tasks=await this.blacklake.listWorkOrderProcesses('projectId='+id,{includeCompleted:true,fresh});
    assert(Array.isArray(tasks)&&tasks.every(t=>Number(t.projectId)===id),502,'WORKSPACE_ORDER_MISMATCH','工单工序归属无法确认。');
    let projectCode=tasks[0]?.projectCode;
    if(!tasks.length){
      const catalog=await this.blacklake.listWorkOrderCatalog(),matches=catalog.filter(row=>Number(row.projectId)===id);
      assert(matches.length===1&&typeof matches[0].projectCode==='string'&&matches[0].projectCode.trim(),404,'WORK_ORDER_NOT_FOUND','没有找到对应工单资料，请重新扫描核对。');
      projectCode=matches[0].projectCode;
    }
    const info=await this.blacklake.readWorkOrderDetails(id,projectCode,{fresh});
    assert(Number(info.projectId)===id&&info.projectCode===projectCode,502,'WORKSPACE_ORDER_MISMATCH','工单资料归属无法确认。');
    const value=workspaceOrder(info,tasks);this.orderCache.set(id,{at:this.now(),value});return copy(value);
  }
  async refreshOrder(id){
    const pending=pendingOrderOperation(this.db,id),order=await this.readLiveOrder(id);
    if(pending?.status==='UNKNOWN'){
      const current=pendingOrderOperation(this.db,id);
      if(current?.status==='UNKNOWN'&&current.actor===pending.actor&&current.operation_id===pending.operation_id)
        reconcileOrderOperation(this.db,order,current,this.now(),{allowRestored:true});
    }
    return order;
  }
  async list({pageNum=1,projectCode='',sort='default',status='ALL',priority='ALL'}={}){
    if(this.dataSync)return this.dataSync.list({pageNum,projectCode,sort,status,priority});
    assert(Number.isSafeInteger(pageNum)&&pageNum>=1&&pageNum<=500&&typeof projectCode==='string'&&projectCode.length<=100,422,'WORKSPACE_INVALID_QUERY','查询条件不正确。');
    const catalog=await this.blacklake.listWorkOrderCatalog(),terms=projectCode.trim().split(/\s+/).map(norm).filter(Boolean);
    const rows=catalog.filter(row=>(status!=='OPEN'||['0','10'].includes(String(row.projectStatus)))&&terms.every(term=>[row.projectCode,row.productCode,row.productName,row.productSpecification].some(v=>norm(v).includes(term))));
    const created=value=>{if(!value)return NaN;return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(String(value))?value:String(value).replace(' ','T')+'+08:00');};
    rows.sort((a,b)=>{const first=created(a.createdAt),second=created(b.createdAt);return Number.isFinite(first)&&Number.isFinite(second)?(sort==='created-asc'?first-second:second-first)||b.projectId-a.projectId:Number.isFinite(first)?-1:Number.isFinite(second)?1:b.projectId-a.projectId;});
    const selected=rows.slice((pageNum-1)*20,pageNum*20),orders=[];
    if(status==='OPEN')orders.push(...selected.map(row=>workspaceOrder(row)));
    else for(let index=0;index<selected.length;index+=4)orders.push(...await Promise.all(selected.slice(index,index+4).map(async row=>{try{return await this.order(row.projectId);}catch(error){return {...workspaceOrder(row),loadError:error.message,processesLoaded:false};}})));
    return {orders,pageNum,total:rows.length,hasMore:pageNum*20<rows.length,pageSize:20,source:'blacklake-live',fetchedAt:new Date(this.now()).toISOString(),complete:pageNum===1&&rows.length<=20,
      scope:{globalHistory:false,catalog:'工单编号包含当前年或上一年的已缓存目录；按编号/SKU/产品信息模糊查找'},scopeNote:'当前/上一年编号目录，非全厂完整历史'};
  }
  async scan(flowCode,session,options){
    this.authorize(session,options);let code=String(flowCode||'').trim();try{code=decodeURIComponent(code);}catch{}
    assert(code.length>=2&&code.length<=1024&&!/[\u0000-\u001f\u007f]/.test(code),422,'INVALID_FLOW_CODE','未识别到有效工单，请重新扫描。');
    let orderId;
    if(/^projectId=\d+$/.test(code)||/^https:\/\/liteapp\.blacklake\.cn\/pages\/index\/workOrderDetail\/index\?/.test(code)){
      if(this.dataSync){const url=code.startsWith('https://')?new URL(code):null;orderId=Number(url?url.searchParams.get('id'):code.slice('projectId='.length));assert(Number.isSafeInteger(orderId)&&orderId>0,422,'INVALID_FLOW_CODE','工单二维码无效。');return {order:await this.order(orderId),source:'blacklake-snapshot'};}
      const rows=await this.blacklake.listWorkOrderProcesses(code,{includeCompleted:true,fresh:true}),ids=[...new Set(rows.map(row=>Number(row.projectId)))];
      assert(ids.length===1&&Number.isSafeInteger(ids[0])&&ids[0]>0,404,'WORK_ORDER_NOT_FOUND','二维码对应工单未能确认。');orderId=ids[0];
    }else{
      const catalog=this.dataSync?this.dataSync.catalog():await this.blacklake.listWorkOrderCatalog(),matches=catalog.filter(row=>[row.projectCode,row.productCode].some(value=>String(value||'').trim()===code));
      assert(matches.length===1,422,'WORK_ORDER_SCAN_AMBIGUOUS',matches.length?'条码匹配到多个工单，请通过产品信息查找确认。':'没有找到条码对应的工单，请检查条码或搜索。');orderId=Number(matches[0].projectId);
    }
    return {order:await this.order(orderId,{fresh:true}),source:'blacklake-live',fetchedAt:new Date(this.now()).toISOString()};
  }
  async section(id,section,pageNum=1){
    if(this.dataSync&&section!=='outsource'){await this.order(id);return this.dataSync.section(id,section,pageNum);}
    await this.order(id);assert(['materials','history','outsource'].includes(section)&&Number.isSafeInteger(pageNum)&&pageNum>=1&&pageNum<=100,422,'WORKSPACE_INVALID_SECTION','资料分类或页码无效。');
    if(section==='outsource')return {orderId:id,section,items:[],available:false,pageNum,hasMore:false,complete:false,source:'blacklake-live',scopeNote:'委外接口及归属尚未完成验证，暂不能读取；不表示没有委外。'};
    if(section==='materials'){
      assert(pageNum===1,422,'WORKSPACE_INVALID_SECTION','用料明细不支持此页码。');const response=await this.blacklake.nativeRequest('/api/dytin/project/web/detail',{projectId:id}),data=response.data;
      assert(Number(data?.project?.id)===id&&Array.isArray(data.productionMaterialsList)&&data.productionMaterialsList.every(row=>Number(row.projectId)===id),502,'WORKSPACE_SECTION_SCOPE','用料资料归属无法确认。');
      return {orderId:id,section,available:true,pageNum,hasMore:false,complete:true,source:'blacklake-live',fetchedAt:new Date(this.now()).toISOString(),items:data.productionMaterialsList.map((row,i)=>({id:String(row.id??i),sequence:amount(row.seq),code:String(row.nextProductCode||''),name:String(row.nextProductName||''),specification:String(row.nextProductSpec||''),unit:String(row.nextProductUnit||''),inventoryQuantity:amount(row.nextStockQty),requiredQuantity:amount(row.demandQty),unitConsumption:amount(row.unitQty),unissuedQuantity:amount(row.unReceivedMaterialQty),issuedQuantity:amount(row.receivedMaterialQty),process:String(row.feedProcessName||'')}))};
    }
    const response=await this.blacklake.nativeRequest('/api/dytin/project/log/detail',{projectId:id,page:{pageNum,pageSize:20},orders:[{orderBy:'created_at',sort:'desc'}]}),data=response.data;
    const rows=[data?.data,data?.list,data?.records,data].find(Array.isArray);assert(rows&&rows.length<=20&&rows.every(row=>Number(row.projectId??row.project?.id)===id),502,'WORKSPACE_SECTION_SCOPE','履历资料归属无法确认。');
    const total=amount(data?.total??data?.count),hasMore=total===null?rows.length===20:pageNum*20<total;
    return {orderId:id,section,available:true,pageNum,total,hasMore,complete:pageNum===1&&!hasMore,source:'blacklake-live',fetchedAt:new Date(this.now()).toISOString(),items:rows.map((row,i)=>({id:String(row.id??pageNum+'-'+i),title:String(row.operationName||row.actionName||row.logTypeName||'生产履历'),operator:String(row.operatorName||row.userName||''),occurredAt:row.createdAt||row.createTime||'',process:String(row.processName||''),description:String(row.description||row.content||''),goodQuantity:amount(row.fineAmount),defectiveQuantity:amount(row.defectiveAmount)}))};
  }
  async state(session,{orderId,fresh=false,workerIds=null,history=null,activeOnly=false,allowRemoved=false,embroidery=false}={}){
    const directory=await this.directory(session,{embroidery}),orders=new Map();
    const scoped=Boolean(workerIds),rowOptions={activeOnly:scoped||activeOnly,workerIds,history,orderId,embroidery};
    const ids=[...new Set([...(scoped||history?[]:this.rows(session,{activeOnly:true,embroidery}).map(r=>r.project_id)),...(orderId?[Number(orderId)]:[])])];
    for(let index=0;index<ids.length;index+=4)await Promise.all(ids.slice(index,index+4).map(async id=>{try{orders.set(id,await this.order(id,{fresh}));}catch(error){if(same(id,orderId)&&!(allowRemoved&&error.code==='WORK_ORDER_DELETED'))throw error;}}));
    const rows=this.rows(session,rowOptions),reports=[],assignments=[];
    for(const raw of rows){
      const metadata=this.db.prepare('SELECT state_json FROM workspace_task_state WHERE assignment_id=?').get(raw.id),saved=metadata?JSON.parse(metadata.state_json):null;
      const record=this.store.assignmentRecord(raw),status=raw.status==='QUANTITY_PENDING'?'AWAITING_QUANTITY':raw.status==='IN_PROGRESS'&&raw.ended_at&&!raw.report_id?'AWAITING_QUANTITY':raw.status;
      const submitted=raw.report_id?this.store.reportById(raw.report_id):null,reportPerson=submitted?this.db.prepare('SELECT blacklake_operator_id id FROM operators WHERE id=?').get(submitted.operator_id):null;
      const visibleWorker=directory.actor.role==='employee'&&!active.includes(raw.status)&&reportPerson?reportPerson.id:raw.person_key;
      const task={id:raw.id,orderId:raw.project_id,orderCode:raw.project_code,processId:raw.task_id,processName:raw.process_name,workerId:String(visibleWorker),leaderId:String(raw.published_by_operator_id??''),unitId:raw.station_name,
        ...(embroidery?{machineId:raw.machine_id.replace(/^(?:3F|MACHINE)-/i,''),embroideryPart:raw.embroidery_part}:{}),status,priority:saved?.priority||'NORMAL',assignedAt:iso(raw.published_at),queueRank:raw.queue_position??saved?.queueRank,
        segments:saved?.segments?.length?saved.segments:(raw.started_at?[{start:iso(raw.started_at),end:iso(raw.ended_at)}]:[]),
        pauseReason:saved?.pauseReason||'',pausedAt:saved?.pausedAt||null,endedAt:iso(raw.ended_at),
        timerPauses:this.db.prepare("SELECT p.started_at,p.ended_at,p.source AS storage_source,CASE WHEN c.pause_id IS NOT NULL THEN 'clockout' ELSE p.source END AS source FROM assignment_pauses p LEFT JOIN leader_clockout_pauses c ON c.pause_id=p.id WHERE p.assignment_id=? AND p.source<>'workspace_queue' ORDER BY p.id").all(raw.id).map(p=>({start:iso(p.started_at),end:iso(p.ended_at),source:p.source,storageSource:p.storage_source})),
        timerRevision:record.timingRevision,isSelfService:raw.assignment_mode!=='DISPATCHED',isQualityInspection:record.isQualityInspection};
      if(!orders.has(raw.project_id)){
        const snapshot=this.dataSync?.snapshot('order',raw.project_id),known=snapshot?.data;
        const deleted=this.store.orderRemoved(raw.project_id);
        orders.set(raw.project_id,known?{...workspaceOrder(known.info,deleted?[]:known.tasks),...(deleted?{status:'DELETED',statusText:'黑湖已删除'}:{}),processesLoaded:!deleted,sync:snapshot.sync}:{id:raw.project_id,code:raw.project_code,product:raw.product_name,status:deleted?'DELETED':'UNKNOWN',processes:[]});
      }
      assignments.push(task);
      if(!directory.employees.some(p=>same(p.id,raw.person_key)))directory.employees.push({id:String(raw.person_key),name:raw.person_name,departments:[],blocked:!raw.person_active});
      if(raw.report_id){
        const report=this.store.reportById(raw.report_id),production=reportProduction(this.store,raw.report_id);
        if(report){const person=this.db.prepare('SELECT blacklake_operator_id id FROM operators WHERE id=?').get(production?.operatorId??report.operator_id);
          reports.push({id:report.id,assignmentId:raw.id,productionWorkerId:String(person?.id??raw.person_key),goodQuantity:report.good_amount,defectiveQuantity:report.defect_amount,createdAt:report.created_at?new Date(report.created_at.replace(' ','T')+'Z').toISOString():iso(report.output_time),updatedAt:report.updated_at?new Date(report.updated_at.replace(' ','T')+'Z').toISOString():iso(report.output_time),
            actualStartedAt:iso(production?.startedAt||raw.started_at),actualEndedAt:iso(production?.endedAt||raw.ended_at),reportedSeconds:production?.durationSeconds??raw.duration_seconds,elapsedSeconds:production?.durationSeconds??raw.duration_seconds,
            upstreamState:({PENDING:'REPORTING',UNKNOWN:'NEEDS_REVIEW'})[report.status]||report.status,
            sync:report.status===groupApprovalPending?{state:groupApprovalPending,label:'待组长审批'}:this.reportOutbox?.reportSync(report.id),
            deleted:report.status==='DELETED'||!!this.db.prepare('SELECT deleted FROM leader_report_states WHERE report_id=?').get(report.id)?.deleted,materialProcess:production?.materialProcess||'',punchMinutes:production?.punchMinutes??null,defectItems:(production?.defectItems||JSON.parse(this.db.prepare('SELECT items_json FROM report_defect_allocations WHERE report_id=?').get(report.id)?.items_json||'[]')).map(row=>({code:row.code,quantity:row.quantity??row.amount})),defectCodes:String(report.defect_code||'').split(',').filter(Boolean)});
        }
      }
    }
    const employeeCurrent={};for(const task of assignments.filter(t=>active.includes(t.status)||t.status==='AWAITING_QUANTITY')){
      const prior=assignments.find(t=>same(t.id,employeeCurrent[task.workerId]));
      if(!prior||(task.queueRank??1e9)<(prior.queueRank??1e9)||task.status==='IN_PROGRESS'&&prior.queueRank==null)employeeCurrent[task.workerId]=task.id;
    }
    return {directory,rows,state:{version:scoped||history?0:this.version(session,{embroidery}),orders:[...orders.values()],employees:directory.employees,peopleGroups:timerGroups(directory.groups),units:embroidery?[]:FLOOR8_UNIT_IDS.map(id=>({id,name:id})),assignments,reports,audit:[],operations:{},employeeCurrent,defectReasons:this.defectReasons}};
  }
  engine(state){return createExecution(state,{now:()=>new Date(this.now()).toISOString(),id:()=>randomUUID()});}
  async snapshot(session,options={}){
    const {state,directory,rows}=await this.state(session,options),view=this.engine(state).snapshot(options.orderId??null,directory.actor);view.source='workspace-live';view.sources={assignments:'local_sqlite',reports:'local_sqlite_with_upstream_receipts',orders:this.dataSync?'blacklake-snapshot':'blacklake-live'};
    const manualQuantity=directory.actor.role==='employee'&&requiresManualReportQuantity(directory.groups.groups,session.blacklakeOperatorId);
    if(options.history){view.hasMore=view.assignments.length>historyPageSize;view.assignments=view.assignments.slice(0,historyPageSize);}
    const quantities=new Map(state.orders.flatMap(order=>order.processes.map(process=>[order.id+':'+process.id,process])));
    for(const task of view.assignments){const raw=rows.find(r=>r.id===task.id),record=this.store.assignmentById(task.id);task.timingRevision=record.timingRevision;
      const process=quantities.get(task.orderId+':'+task.processId);
      task.reportPlanQuantity=process?.planQuantity??null;task.reportRemainingQuantity=process?.remainingQuantity??null;
      task.canExitClosedSelfTask=task.canExitClosedSelfTask&&!raw.report_id&&['SELF_SCAN',BOUND_EMBROIDERY_ASSIGNMENT].includes(raw.assignment_mode);
      task.canSkipClosedAssignment=task.canSkipClosedAssignment&&!raw.report_id&&!raw.started_at&&raw.assignment_mode==='DISPATCHED';
      if(task.canExitClosedSelfTask)task.canConfirmQuantity=false;
      if(task.orderInfo?.status==='DELETED'){task.canConfirmQuantity=false;task.canReturnToWork=false;task.orderUnavailableReason='黑湖已删除这张工单，原计时和报工记录仍可查询。';}
      // Existing worker clients read this field as the input default; the displayed plan is reportPlanQuantity.
      if(directory.actor.role==='employee'&&task.canConfirmQuantity)task.processPlanQuantity=manualQuantity?null:task.reportRemainingQuantity;
      const end=raw.ended_at||(['PAUSED','READY'].includes(task.status)?sql(task.segments.at(-1)?.end):null),asOf=new Date(this.now()).toISOString(),pauses=this.store.assignmentPauses(task.id);
      task.timing={startedAt:raw.started_at,endedAt:end,pauses,asOf};task.elapsedSeconds=raw.started_at?effectiveWorkSecondsBetween(raw.started_at,end||asOf,pauses):0;
      for(const report of task.reports){report.canRestore=false;if(directory.actor.role==='floor8_leader'&&report.upstreamState==='SUCCEEDED'){
        try{const linked=this.leaderReports().present(this.leaderReports().owned(task.id,{ownerId:session.blacklakeOperatorId,unitIds:FLOOR8_UNIT_IDS}));Object.assign(report,{canEdit:linked.canEdit,canDelete:linked.canDelete,deleted:linked.deleted,version:linked.version});}catch{report.canEdit=false;report.canDelete=false;}
      }}
      if(raw?.status==='QUANTITY_PENDING'){task.canReturnToWork=false;task.returnToWorkBlockedReason='历史完工待核量请在原核量入口处理。';}
      if(options.embroidery){
        task.isQualityInspection=!!record.isQualityInspection;
        task.canSkipClosedAssignment=false;
        if(task.status==='READY')task.canStart=!!process?.selectable&&!process.closed;
        if(task.status==='AWAITING_QUANTITY'&&!raw.report_id)task.canReturnToWork=!!process?.selectable&&!process.closed;
      }
    }
    view.reportOptions&&Object.assign(view.reportOptions,{peopleGroupConfig:directory.groups});
    if(options.embroidery)view.selfServiceDefectReasons=copy(this.defectReasons);
    view.scopeNote=options.embroidery?'本人绣花机任务及近期报工。':'仅本系统已保存的8楼任务和报工。默认显示当前任务及近期记录，历史派工可分页查看。';view.capabilities={restoreReport:false,outsource:false,orderOperations:!options.embroidery};return view;
  }
  async assignmentHistory(session,{page,start,end}){
    assert(this.authorize(session)==='floor8_leader',403,'WORKSPACE_ROLE_REQUIRED','仅组长可以查看本人派工历史。');
    const day=value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    assert(Number.isSafeInteger(page)&&page>=1&&page<=100000&&day(start)&&day(end)&&(!start||!end||start<=end),422,'WORKSPACE_INVALID_QUERY','历史派工日期或页码无效。');
    const result=await this.snapshot(session,{history:{page,start,end}});
    return {assignments:result.assignments,hasMore:result.hasMore,page};
  }
  async context(id,session){
    const order=await this.order(id),directory=await this.directory(session);assert(directory.actor.role==='floor8_leader',403,'WORKSPACE_ROLE_REQUIRED','仅组长可以派工。');
    return {workOrder:{projectId:order.id,projectCode:order.code},operator:{name:session.name},executionMode:'formal',processesLoaded:order.processesLoaded!==false,processes:order.processes.map(p=>({taskId:p.id,processName:p.name,selectable:p.selectable,closed:p.closed,statusLabel:p.statusText||'状态未提供',percentLabel:p.percent,description:'',sourceLabel:'黑湖工序'})),employees:directory.people.map(person=>({...person,departments:directory.employees.find(p=>same(p.id,person.blacklakeOperatorId))?.departments||[]})),units:FLOOR8_UNIT_IDS.map(id=>({id,name:id})),peopleGroups:directory.groups};
  }
  async preview(input,session){
    assert(this.authorize(session)==='floor8_leader',403,'WORKSPACE_ROLE_REQUIRED','仅组长可以派工。');
    assert(!this.dataSync?.routeEdits||!processEditLocksTask(this.db,input.orderId,input.processId),
      409,'PROCESS_EDIT_PENDING','该工序正在修改或已经移除，请选其他工序。');
    const workerIds=this.dispatchWorkers(input);
    const {state,directory,rows}=await this.state(session,{orderId:input.orderId,workerIds,fresh:true});
    const order=state.orders.find(item=>same(item.id,input.orderId));
    assert(order?.processesLoaded!==false,503,'BLACKLAKE_DATA_SYNCING','工序正在后台加载，请稍后重新核对。');
    assert(!this.store.orderStatusPending(input.orderId),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','这张工单的执行状态正在核对，确认后可派工。');
    let plan;
    try{plan=this.engine(state).previewDispatch(input,directory.actor,true);}
    catch(error){throw new AppError(409,'WORKSPACE_ACTION_REJECTED',error.message);}
    return {...plan,version:this.version(session),dispatchVersion:plan.workerIds.length?this.dispatchVersion(rows.filter(row=>plan.workerIds.includes(String(row.person_key))),order,input,[...plan.workerIds].sort()):null};
  }
  async selfContext(id,session,{embroidery=false}={}){
    const {state,directory}=await this.state(session,{orderId:id,embroidery});
    if(embroidery){
      const order=state.orders.find(row=>same(row.id,id));
      assert(order?.processesLoaded!==false,503,'BLACKLAKE_DATA_SYNCING','工序正在由后台同步，请稍后重试。');
      if(order)order.processes=order.processes.filter(row=>isEmbroideryProcessName(row.name));
    }
    return this.engine(state).selfServiceContext(id,directory.actor);
  }
  async refreshProcessReports(id,processId,session,{embroidery=false}={}){
    this.authorize(session,{embroidery});const order=await this.order(id);assert(order.processes.some(p=>same(p.id,processId)),404,'WORKSPACE_PROCESS_NOT_FOUND','工单工序不匹配。');
    assert(this.dataSync,409,'REPORT_REFRESH_UNAVAILABLE','报工同步暂未启用。');this.dataSync.requestReportRefresh(id,order.code,'USER:'+session.blacklakeOperatorId);
    return this.processReports(id,processId,session,{embroidery});
  }
  async processReports(id,processId,session,{version,embroidery=false}={}){
    const role=this.authorize(session,{embroidery});const order=await this.order(id);assert(order.processes.some(p=>same(p.id,processId)),404,'WORKSPACE_PROCESS_NOT_FOUND','工单工序不匹配。');
    const reportStates=this.reportOutbox?"IN ('SUCCEEDED','PENDING','FAILED','UNKNOWN')":"='SUCCEEDED'";
    const rows=this.db.prepare(`SELECT a.*,r.id AS local_report_id,r.blacklake_output_id,r.good_amount,r.defect_amount,r.status AS report_status,r.created_at AS reported_created_at,o.name AS person_name FROM assignments a JOIN reports r ON a.report_id=r.id JOIN operators o ON o.id=r.operator_id WHERE a.project_id=? AND a.task_id=? AND r.status ${reportStates} ORDER BY r.created_at DESC`).all(Number(id),Number(processId));
    const qualityManager=!embroidery&&role==='employee'&&this.store.qualityProfile(session.blacklakeOperatorId).qualityRole==='quality_leader',canManage=role==='floor8_leader'||qualityManager,context={ownerId:session.blacklakeOperatorId,unitIds:FLOOR8_UNIT_IDS,...(canManage?{scope:'all-process-reports'}:{})};
    const reports=rows.filter(row=>!this.db.prepare('SELECT deleted FROM leader_report_states WHERE report_id=?').get(row.local_report_id)?.deleted).map(row=>{const production=reportProduction(this.store,row.local_report_id);let rights={canManage,canEdit:false,canDelete:false};if(canManage){try{const linked=this.leaderReports().present(this.leaderReports().owned(row.id,context));rights={canManage:true,canEdit:linked.canEdit,canDelete:linked.canDelete,managementBlockedReason:linked.canEdit?'':'报工正在同步或待核对，请在后台核对后再修改。'};}catch{rights={canManage:true,canEdit:false,canDelete:false,managementBlockedReason:'报工状态尚未确认，请刷新或在后台核对。'};}}return {id:row.local_report_id,orderId:Number(id),processId:Number(processId),productionWorkerName:production?.operatorName||row.person_name,goodQuantity:row.good_amount,defectiveQuantity:row.defect_amount,reportedSeconds:production?.durationSeconds??row.duration_seconds,createdAt:row.reported_created_at?new Date(row.reported_created_at.replace(' ','T')+'Z').toISOString():iso(row.ended_at),...(this.reportOutbox?{sync:this.reportOutbox.reportSync(row.local_report_id)}:{}),...rights};});
    if(this.dataSync){const authoritative=reportAuthority(this.store);for(let n=reports.length-1;n>=0;n--){const report=reports[n],row=rows.find(r=>r.local_report_id===report.id),remote=authoritative(row,reportProduction(this.store,report.id)||{});if(remote?.deleted){reports.splice(n,1);continue;}if(remote)Object.assign(report,{goodQuantity:remote.goodQuantity,defectiveQuantity:remote.defectiveQuantity,reportedSeconds:remote.reportedSeconds,productionWorkerName:remote.personName,source:remote.source,sourceUpdatedAt:remote.sourceUpdatedAt});}}
    const shared=this.dataSync?.orderReports(Number(id),order.code),linked=new Set(rows.map(row=>String(row.blacklake_output_id||'')));
    // A deleted local report must also suppress its older upstream mirror.
    for(const row of this.db.prepare("SELECT r.blacklake_output_id FROM reports r JOIN assignments a ON a.report_id=r.id LEFT JOIN leader_report_states s ON s.report_id=r.id WHERE a.project_id=? AND a.task_id=? AND (r.status='DELETED' OR s.deleted=1)").all(Number(id),Number(processId)))linked.add(String(row.blacklake_output_id));
    for(const row of shared?.records||[]){const key=String(row.reportingId??row.id??row.outputId);if(linked.has(key)||!same(row.taskId??row.projectProcessId,processId))continue;const seconds=amount(row.effectiveTime);reports.push({id:'blacklake:'+key,orderId:Number(id),processId:Number(processId),productionWorkerName:row.productionStaffName||row.productionStaff?.name||(typeof row.productionStaff==='string'?row.productionStaff:'')||row.operatorName||'人员未提供',goodQuantity:amount(row.numberofgoodProducts??row.fineAmount),defectiveQuantity:amount(row.numberofDefectives??row.defectsAmount),reportedSeconds:seconds,createdAt:iso(row.createdAt),...(canManage&&this.upstreamReports?this.upstreamReports().rights('blacklake:'+key):{canEdit:false,canDelete:false})});}
    reports.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||String(b.id).localeCompare(String(a.id)));
    const result={orderId:Number(id),processId:Number(processId),reports,canEditReports:canManage,canCreateReports:canManage&&!!this.reportOutbox&&this.blacklake.supportsFullReportCorrection===true&&order.status!=='FINISHED'&&order.processes.some(p=>same(p.id,processId)&&p.selectable),permission:canManage?'all-process-reports':null,source:'local_sqlite',complete:shared?shared.sync.complete&&shared.sync.status==='fresh':false,sync:{...(shared?.sync||{complete:false,status:'unavailable'}),pending:!!shared?.sync.pending||reports.some(r=>['QUEUED','RUNNING','RETRY'].includes(r.sync?.state))},scopeNote:'该工单所有人员、所有日期的已同步报工；查看与修改权限独立。',fetchedAt:new Date(this.now()).toISOString()};
    result.version=digest({...result,fetchedAt:undefined});if(version===result.version){delete result.reports;result.notModified=true;}return result;
  }
  processReportContext(id,processId,reportId,session){
    const role=this.authorize(session),qualityManager=role==='employee'&&this.store.qualityProfile(session.blacklakeOperatorId).qualityRole==='quality_leader';assert(role==='floor8_leader'||qualityManager,403,'REPORT_MANAGEMENT_FORBIDDEN','只有组长或已授权的质检组长可以修改或删除报工。');
    const row=this.db.prepare('SELECT a.* FROM assignments a JOIN reports r ON r.id=a.report_id WHERE r.id=? AND a.project_id=? AND a.task_id=?').get(reportId,Number(id),Number(processId));
    assert(row,404,'REPORT_NOT_FOUND','报工与当前工单工序不匹配。');
    const context={ownerId:session.blacklakeOperatorId,unitIds:FLOOR8_UNIT_IDS,scope:'all-process-reports'};this.leaderReports().owned(row.id,context);return {row,context};
  }
  async processReportEditor(id,processId,reportId,session){
    this.authorize(session);if(String(reportId).startsWith('blacklake:')){assert(this.upstreamReports,409,'REPORT_MANAGEMENT_UNAVAILABLE','历史报工管理暂未启用。');return this.upstreamReports().editor(id,processId,reportId,session.blacklakeOperatorId);}
    if(this.store.reportById(reportId)?.status===groupApprovalPending)return this.groupReportReview.editor(id,processId,reportId,session.blacklakeOperatorId);
    const {row,context}=this.processReportContext(id,processId,reportId,session),editor=await this.leaderReports().editor(row.id,context);
    return {...editor,orderId:Number(id),processId:Number(processId),permission:context.scope||'own-dispatch-reports',canEdit:editor.report.canEdit,canDelete:editor.report.canDelete,assignment:{id:row.id,orderId:Number(id),processId:Number(processId),processName:row.process_name,workerId:String(this.db.prepare('SELECT blacklake_operator_id FROM operators WHERE id=?').get(row.operator_id)?.blacklake_operator_id),workerName:editor.report.originalOperatorName,segments:[{start:iso(row.started_at),end:iso(row.ended_at)}]}};
  }
  async changeProcessReport(id,processId,reportId,action,input,operationId,session){
    this.authorize(session);if(String(reportId).startsWith('blacklake:')){assert(this.upstreamReports,409,'REPORT_MANAGEMENT_UNAVAILABLE','历史报工管理暂未启用。');return this.upstreamReports().enqueue(id,processId,reportId,action,input,operationId,session.blacklakeOperatorId);}
    if(this.store.reportById(reportId)?.status===groupApprovalPending)return this.groupReportReview.edit(id,processId,reportId,action,input,session.blacklakeOperatorId);
    const {row,context}=this.processReportContext(id,processId,reportId,session);
    if(action!=='reconcile'&&this.reportOutbox)return this.reportOutbox.enqueueChange(row.id,input,{...context,operationId,action});
    return action==='reconcile'?this.leaderReports().reconcile(row.id,context):this.leaderReports().change(row.id,input,{...context,operationId,action});
  }
  orderVersion(order){return parseInt(digest([order.id,order.code,order.status,order.priority,order.priorityKnown,order.processes.map(p=>[p.id,p.closed,p.selectable,p.priority,p.priorityKnown])]).slice(0,13),16);}
  receiptForClient(row){
    if(!row)return null;
    const result=JSON.parse(row.result_json),read=this.dataSync.orderRefreshState(row.order_id);
    const checking=row.status==='PENDING'||row.status==='UNKNOWN'&&pendingSyncStates.includes(read?.state);
    const message=checking?'后台正在核对黑湖。':row.status==='UNKNOWN'?'工单操作仍待核对，请刷新这张工单。':result.message;
    return {operationId:row.operation_id,status:row.status,checking,message};
  }
  async orderOperations(id,session,operationId){
    const actor=this.orderOperationActor(session);
    id=Number(id);
    if(this.dataSync){
      const cached=this.dataSync.order(id),snapshot=this.dataSync.snapshot('order',id);
      const order=snapshot.data?workspaceOrder(snapshot.data.info,snapshot.data.tasks):cached;
      const pending=pendingOrderOperation(this.db,id);
      if(pending?.status==='UNKNOWN')this.queueOrderReview(pending);
      const receipt=operationId?this.db.prepare('SELECT * FROM workspace_order_operations WHERE order_id=? AND actor=? AND operation_id=?').get(id,actor,operationId):null;
      const complete=snapshot.sync.complete&&order.priorityKnown&&orderStatuses.includes(order.status);
      const pendingView=this.receiptForClient(pending);
      const cooling=this.blacklake.requestBudget?.state.cooldownUntil>this.now()||this.dataSync.snapshot('control','rate-limit').data?.until>this.now();
      return {order,version:this.orderVersion(order),canManage:complete&&!pending,
        canSyncPriority:complete&&order.processes.every(p=>p.closed||p.priorityKnown),
        pending:pendingView,receipt:this.receiptForClient(receipt),sync:cooling&&pendingView?.checking?{...cached.sync,phase:'cooldown'}:cached.sync,
        source:'blacklake-snapshot',fetchedAt:snapshot.sync.updatedAt};
    }
    const order=await this.refreshOrder(Number(id));
    assert(order.priorityKnown,503,'WORKSPACE_ORDER_PRIORITY_UNKNOWN','黑湖未返回工单优先级，暂不能修改。');
    assert(!pendingOrderOperation(this.db,Number(id)),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','上次工单操作正在处理或结果待核对，请核对黑湖后刷新；不会自动重发。');
    return {order,version:this.orderVersion(order),canManage:true,canSyncPriority:order.processes.every(p=>p.closed||p.priorityKnown),source:'blacklake-live',fetchedAt:new Date(this.now()).toISOString()};
  }
  async updateOrder(input,meta,session){
    const actor=this.orderOperationActor(session);
    assert(Object.hasOwn(orderPriorities,input.priority)&&orderStatuses.includes(input.status)&&typeof input.syncPriority==='boolean',422,'WORKSPACE_ORDER_INPUT','请选择有效的工单状态和优先级。');
    const hash=digest({input,version:meta.expectedVersion});
    const replay=()=>{
      const prior=this.db.prepare('SELECT request_hash,result_json,status FROM workspace_order_operations WHERE actor=? AND operation_id=?').get(actor,meta.operationId);
      if(prior){assert(prior.request_hash===hash,409,'WORKSPACE_OPERATION_CONFLICT','操作编号已用于其他内容。');return {...JSON.parse(prior.result_json),status:prior.status,replayed:true};}
    };
    const prior=replay();
    if(prior)return prior;
    const snapshot=await this.orderOperations(input.orderId,session),before=snapshot.order;
    const concurrent=replay();
    if(concurrent)return concurrent;
    assert(snapshot.canManage,409,snapshot.pending?'WORKSPACE_ORDER_RESULT_UNKNOWN':'BLACKLAKE_DATA_SYNCING',snapshot.pending?'本工单已有操作在后台核对。':'工单资料正在更新，更新后可继续编辑。');
    assert(snapshot.version===meta.expectedVersion,409,'WORKSPACE_VERSION_CHANGED','黑湖工单已变化，请刷新后重新核对。');
    assert(!input.syncPriority||snapshot.canSyncPriority,422,'WORKSPACE_PROCESS_PRIORITY_UNKNOWN','当前工序优先级未能完整读取，暂不能同步。');
    const target={status:input.status,priority:input.priority,syncPriority:input.syncPriority};
    const command=this.orderTransition(before,target),id=Number(input.orderId);
    const record=(result)=>this.db.prepare('INSERT INTO workspace_order_operations(actor,operation_id,order_id,request_hash,status,before_json,target_json,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(actor,meta.operationId,id,hash,result.status,JSON.stringify(before),JSON.stringify(target),JSON.stringify(result),shanghaiTime(this.now()),shanghaiTime(this.now()));
    if(!command&&before.priority===target.priority&&!target.syncPriority){
      const result={status:'SUCCEEDED',operationId:meta.operationId,order:before};record(result);return result;
    }
    if(this.dataSync){
      this.db.exec('BEGIN IMMEDIATE');try{
        assert(!pendingOrderOperation(this.db,id),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','本工单已有操作在后台核对。');
        const read=this.requestOrderCheck(id,'order-operation-preflight');
        const job=this.dataSync.jobs.enqueue({key:'write:order-operation:'+actor+':'+meta.operationId,mode:'write',kind:'order-operation-write',target:id,
          actor,payload:{actor,operatorId:session.blacklakeOperatorId,operationId:meta.operationId,preflightJobId:read.id,generation:read.generation}});
        const result={status:'PENDING',operationId:meta.operationId,jobId:job.id,accepted:true,queued:true,message:'已提交，后台会核对并更新黑湖。'};
        record(result);this.db.exec('COMMIT');return result;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    record({status:'PENDING',operationId:meta.operationId});
    let attempted=false,completed=0,status='SUCCEEDED',message='';
    try{
      if(before.priority!==input.priority||input.syncPriority){attempted=true;await this.blacklake.nativeRequest('/api/dytin/project/priority/update',{projectId:Number(input.orderId),priority:orderPriorities[input.priority],isSyncTask:input.syncPriority},{write:true});completed++;}
      if(command){attempted=true;await this.blacklake.nativeRequest('/api/dytin/project/'+command,{projectStatusFlow:{projectIds:[Number(input.orderId)]}},{write:true});completed++;}
      this.blacklake.taskCache?.clear();this.blacklake.workOrderCatalog=null;this.orderCache.delete(Number(input.orderId));
      const order=await this.readLiveOrder(id);
      assert(matchesOrder(order,target),409,'WORKSPACE_ORDER_READBACK','黑湖尚未确认目标状态。');
    }catch(error){status=!attempted||error.definiteFailure===true&&!completed?'FAILED':'UNKNOWN';message=status==='UNKNOWN'?'工单操作结果待核对，请核对黑湖后刷新；不会自动重发。':error.message||'工单操作未完成。';}
    const result={status,operationId:meta.operationId,...(message?{message}:{})};this.db.prepare('UPDATE workspace_order_operations SET status=?,result_json=?,updated_at=? WHERE actor=? AND operation_id=?').run(status,JSON.stringify(result),shanghaiTime(this.now()),actor,meta.operationId);
    return result;
  }
  orderTransition(before,target){
    if(before.status===target.status)return null;
    const command=({'NOT_STARTED:IN_PROGRESS':'start','IN_PROGRESS:FINISHED':'finish','IN_PROGRESS:NOT_STARTED':'revert','FINISHED:IN_PROGRESS':'revert'})[before.status+':'+target.status];
    assert(command,422,'WORKSPACE_ORDER_TRANSITION','请先切换到执行中，再执行下一步状态操作。');
    if(command==='finish')assert(!this.db.prepare("SELECT id FROM assignments WHERE project_id=? AND status IN ('READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING') LIMIT 1").get(before.id),409,'WORKSPACE_ORDER_HAS_TASKS','此工单仍有未完成任务或待核对报工，不能结束。');
    return command;
  }
  requestOrderCheck(id,reason){
    const job=this.dataSync.request('order',id,{projectId:id,reason},true);
    this.dataSync.jobs.demand(job.id,120000);
    return job;
  }
  queueOrderReview(row){
    const result=JSON.parse(row.result_json);
    const state=this.dataSync.orderRefreshState(row.order_id)?.state;
    if(result.autoReviewRequested||result.jobId&&this.now()-Date.parse(iso(row.updated_at))<60000||
       state==='FAILED'||pendingSyncStates.includes(state))return;
    const job=this.requestOrderCheck(row.order_id,'order-operation-review');
    if(job.state==='FAILED')return;
    this.db.prepare("UPDATE workspace_order_operations SET result_json=json_set(result_json,'$.autoReviewRequested',1) WHERE actor=? AND operation_id=? AND status='UNKNOWN'")
      .run(row.actor,row.operation_id);
  }
  scheduleOrderReviews(){
    const row=this.db.prepare(`SELECT o.* FROM workspace_order_operations o
      WHERE o.status='UNKNOWN' AND o.updated_at<=? AND COALESCE(json_extract(o.result_json,'$.autoReviewRequested'),0)=0
      AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.job_key='read:order:'||o.order_id AND j.state IN ('QUEUED','RETRY','RUNNING','FAILED'))
      ORDER BY o.updated_at LIMIT 1`).get(shanghaiTime(this.now()-60000));
    if(row)this.queueOrderReview(row);
  }
  orderWriteReceipt(job){
    return this.db.prepare('SELECT * FROM workspace_order_operations WHERE order_id=? AND actor=? AND operation_id=?').get(Number(job.target),job.payload.actor,job.payload.operationId);
  }
  finishOrderWrite(job,row,status,message,{acknowledged=false}={}){
    const result={...JSON.parse(row.result_json),status,acknowledged,message,queued:status==='UNKNOWN'};
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare("UPDATE workspace_order_operations SET status=?,result_json=?,updated_at=? WHERE actor=? AND operation_id=? AND status='PENDING'")
        .run(status,JSON.stringify(result),shanghaiTime(this.now()),row.actor,row.operation_id);
      if(status==='UNKNOWN')this.requestOrderCheck(row.order_id,'order-operation');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return {jobOutcome:{state:status},result:{projectId:row.order_id,acknowledged}};
  }
  recoverOrderWrite(job){
    if(!['UNKNOWN','FAILED'].includes(job.state))return;
    const row=this.orderWriteReceipt(job);
    if(row?.status==='PENDING')this.finishOrderWrite(job,row,job.state,job.state==='UNKNOWN'?
      '提交时连接中断，后台会按黑湖实际结果核对。':'本次修改未发出，请刷新工单后重新提交。');
  }
  async executeOrderWrite(job){
    const row=this.orderWriteReceipt(job);
    if(row?.status!=='PENDING')return {jobOutcome:{state:'CANCELLED'}};
    const id=row.order_id,read=this.dataSync.orderRefreshState(id);
    if(!read||read.jobId!==job.payload.preflightJobId||read.state==='FAILED')return this.finishOrderWrite(job,row,'FAILED','本次尚未发出。请先刷新这张工单，再重新提交。');
    if(!read?.completed||read.generation<job.payload.generation)return {jobOutcome:{state:'QUEUED',delayMs:1200}};
    const snapshot=this.dataSync.snapshot('order',id);
    if(!snapshot.sync.complete||snapshot.sync.status!=='fresh'){
      this.requestOrderCheck(id,'order-operation-preflight');
      return {jobOutcome:{state:'QUEUED',delayMs:1200}};
    }
    const before=JSON.parse(row.before_json),target=JSON.parse(row.target_json),current=workspaceOrder(snapshot.data.info,snapshot.data.tasks);
    const operator=this.store.findOperatorByBlacklakeId(job.payload.operatorId);
    const actor=operator&&(this.profile(operator).appRole==='floor8_leader'?'floor8_leader':
      canOperateOrdersFromEmployeeView(this.store,operator)&&this.routing(operator).canReceiveFloor8Assignments?'quality_leader':null);
    if(!actor||row.actor!==actor+':'+operator.blacklakeOperatorId)return this.finishOrderWrite(job,row,'FAILED','工单操作权限已变化，本次修改尚未发出。');
    if(this.orderVersion(current)!==this.orderVersion(before))return this.finishOrderWrite(job,row,'FAILED','黑湖工单已变化。本次修改尚未发出，请核对当前值后重新提交。');
    let command;
    try{command=this.orderTransition(current,target);}catch(error){
      if(!(error instanceof AppError))throw error;
      return this.finishOrderWrite(job,row,'FAILED',error.message);
    }
    this.dataSync.jobs.sending(job.id,job.attempts);
    let acknowledged=0;
    try{
      if(before.priority!==target.priority||target.syncPriority){
        await this.blacklake.nativeRequest('/api/dytin/project/priority/update',{projectId:id,priority:orderPriorities[target.priority],isSyncTask:target.syncPriority},{write:true});
        acknowledged++;
      }
      if(command){
        await this.blacklake.nativeRequest('/api/dytin/project/'+command,{projectStatusFlow:{projectIds:[id]}},{write:true});
        acknowledged++;
      }
    }catch(error){
      if(!acknowledged&&error.writeNotSent&&['BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(error.code))
        return {jobOutcome:{state:'QUEUED',delayMs:error.retryAfterMs??10000}};
      if(!acknowledged&&(error.writeNotSent||error.definiteFailure))return this.finishOrderWrite(job,row,'FAILED','黑湖未接受本次修改，请刷新工单后重新提交。');
      return this.finishOrderWrite(job,row,'UNKNOWN','黑湖结果待核对，后台会更新本工单的进度。');
    }
    return this.finishOrderWrite(job,row,'UNKNOWN','黑湖已接收，后台正在核对最新状态。',{acknowledged:true});
  }
  async action(action,input,meta,session){
    assert(typeof meta.operationId==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(meta.operationId),422,'WORKSPACE_OPERATION_REQUIRED','缺少有效操作编号。');
    if(action==='updateOrder')return this.updateOrder(input,meta,session);
    const delegated=delegatedTimerActions.has(action);
    assert(localActions.has(action)||delegated,422,'WORKSPACE_ACTION_UNAVAILABLE','此操作须使用已接入的正式接口，未改动业务。');
    const actorKey=this.authorize(session)+':'+session.blacklakeOperatorId,requestHash=digest({action,input,meta}),prior=this.db.prepare('SELECT * FROM workspace_operations WHERE actor=? AND operation_id=?').get(actorKey,meta.operationId);
    if(prior){assert(prior.request_hash===requestHash,409,'WORKSPACE_OPERATION_CONFLICT','此操作编号已用于其他内容。');return {...JSON.parse(prior.response_json),replayed:true};}
    const target=input.assignmentId?this.store.assignmentById(input.assignmentId):null;
    if(action==='exitClosedSelfTask'){
      assert(this.authorize(session)==='employee'&&target?.operatorId===session.id&&target.assignmentMode==='SELF_SCAN',403,'WORKSPACE_SELF_EXIT_NOT_ALLOWED','只能退出本人自主任务。');
      assert(!target.reportId,409,'WORKSPACE_SELF_EXIT_HAS_REPORT','任务已关联报工，请核对报工记录。');
    }
    const skipping=action==='skipClosedAssignment';
    if(skipping){
      assert(this.authorize(session)==='employee'&&target?.operatorId===session.id&&target.assignmentMode==='DISPATCHED',403,'WORKSPACE_SKIP_NOT_ALLOWED','只能跳过本人待开工的派工。');
      assert(target.status==='READY'&&!target.startedAt&&!target.reportId,409,'WORKSPACE_SKIP_NOT_READY','派工已开始或状态已改变，请刷新任务。');
    }
    if(delegated)assert(this.authorize(session)==='floor8_leader'&&target?.assignmentMode==='DISPATCHED'&&same(target.publishedByOperatorId,session.blacklakeOperatorId),403,'WORKSPACE_TIMER_NOT_ALLOWED','只能调整本人派给当前组员的计时。');
    const targetOrder=delegated||skipping||action==='exitClosedSelfTask'?target.projectId:input.orderId??target?.projectId;
    const starting=action==='leaderStartTimer'&&['READY','PAUSED'].includes(target?.status);
    const scopedDispatch=action==='dispatch'&&meta.dispatchVersion!==undefined;
    if(scopedDispatch)assert(this.authorize(session)==='floor8_leader',403,'WORKSPACE_ROLE_REQUIRED','仅组长可以派工。');
    const workerIds=scopedDispatch?this.dispatchWorkers(input):null;
    const {state,directory,rows}=await this.state(session,{orderId:targetOrder,workerIds,allowRemoved:['end','cancelAssignment','cancelSelfReport','leaderPauseTimer'].includes(action),fresh:skipping||starting||['dispatch','selfStart','start','editAssignment','resume'].includes(action)});
    if(skipping&&this.dataSync){
      // A cached closure can outlive an upstream reopen. Confirm this order before changing the local queue.
      const verified=await this.readLiveOrder(targetOrder);
      state.orders=state.orders.map(order=>same(order.id,targetOrder)?verified:order);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.authorize(session);
      const replay=this.db.prepare('SELECT * FROM workspace_operations WHERE actor=? AND operation_id=?').get(actorKey,meta.operationId);
      if(replay){assert(replay.request_hash===requestHash,409,'WORKSPACE_OPERATION_CONFLICT','此操作编号已用于其他内容。');this.db.exec('COMMIT');return {...JSON.parse(replay.response_json),replayed:true};}
      if(scopedDispatch){
        const order=state.orders.find(row=>same(row.id,targetOrder));
        const current=this.rows(session,{activeOnly:true,workerIds});
        assert(this.dispatchVersion(current,order,input,workerIds)===meta.dispatchVersion&&this.dispatchVersion(rows,order,input,workerIds)===meta.dispatchVersion,409,'WORKSPACE_DISPATCH_CHANGED','本次工单、工序或所选员工的任务已变化，请重新核对。');
      }else assert(this.version(session)===meta.expectedVersion&&state.version===meta.expectedVersion,409,'WORKSPACE_VERSION_CHANGED','任务状态已变化，请刷新后重新核对。');
      if(delegated){
        state.peopleGroups=timerGroups(this.getPeopleGroups(directory.people));
        const worker=rows.find(row=>same(row.id,input.assignmentId))?.person_key;
        assert(state.peopleGroups.some(group=>group.leaderIds?.some(id=>same(id,session.blacklakeOperatorId))&&group.employeeIds.some(id=>same(id,worker))),403,'WORKSPACE_TIMER_NOT_ALLOWED','只能调整本人派给当前组员的计时。');
      }
      if(starting)assert(!this.store.orderStatusPending(targetOrder),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','这张工单的执行状态正在核对，确认后可开工。');
      if(this.dataSync?.routeEdits&&useProcessActions.has(action)){
        const processId=input.processId??target?.taskId;
        assert(!processId||!processEditLocksTask(this.db,target?.projectId??targetOrder,processId),
          409,'PROCESS_EDIT_PENDING','该工序正在修改或已经移除，请选其他工序。');
      }
      const engine=this.engine(state),result=engine.execute(action,input,directory.actor,scopedDispatch?{...meta,expectedVersion:state.version}:meta),next=engine.exportState();
      for(const task of next.assignments)if(!state.assignments.some(t=>t.id===task.id))assert(!this.store.orderStatusPending(task.orderId),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','这张工单的执行状态正在核对，确认后可派工。');
      for(const task of next.assignments){
        const before=state.assignments.find(t=>t.id===task.id);
        const cancellationReason=task.id===result.assignmentId?{
          exitClosedSelfTask:'黑湖已关闭，员工退出自主任务',
          skipClosedAssignment:'黑湖已关闭，员工跳过待开工派工'
        }[action]:undefined;
        if(!before||JSON.stringify(before)!==JSON.stringify(task))this.persist(task,before,next,rows,directory,session,cancellationReason);
      }
      if(delegated){
        const before=state.assignments.find(row=>same(row.id,result.assignmentId)),after=next.assignments.find(row=>same(row.id,result.assignmentId));
        if(after.timerRevision!==before.timerRevision)this.db.prepare('INSERT INTO assignment_timer_operations VALUES(?,?,?,?,?,?)')
          .run('leader-'+digest([actorKey,meta.operationId]).slice(0,60),before.id,target.operatorId,action==='leaderPauseTimer'?'pause':'resume',before.timerRevision,shanghaiTime(this.now()));
      }
      for(const audit of next.audit)this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(audit.assignmentId,audit.type,audit.reason||JSON.stringify({before:audit.before,after:audit.after}),actorKey);
      result.version=this.version(session);this.db.prepare('INSERT INTO workspace_operations VALUES(?,?,?,?,?)').run(actorKey,meta.operationId,requestHash,JSON.stringify(result),shanghaiTime(this.now()));
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');if(!error.status)throw new AppError(409,'WORKSPACE_ACTION_REJECTED',error.message);throw error;}
  }
  persist(task,before,state,rows,directory,session,cancellationReason='由本人或所属组长撤销'){
    const order=state.orders.find(o=>same(o.id,task.orderId)),process=order?.processes.find(p=>same(p.id,task.processId)),person=directory.people.find(p=>same(p.blacklakeOperatorId,task.workerId));
    assert(person,409,'WORKSPACE_PERSON_CHANGED','人员已变化，请刷新核对。');
    const operator=this.store.findOperatorByBlacklakeId(Number(task.workerId))||this.store.upsertBlacklakeOperator({blacklakeOperatorId:Number(task.workerId),name:person.name,groupNames:person.departments||[]});
    const status=task.status==='AWAITING_QUANTITY'?'IN_PROGRESS':task.status;
    if(!before){
      const quantity=process?.planQuantity;assert(Number.isSafeInteger(quantity)&&quantity>0,422,'BLACKLAKE_PLAN_AMOUNT_INVALID','当前工序计划数量未知，不能开工或派工。');
      const baseline=this.store.succeededAmountForTaskSince({taskId:task.processId,projectId:task.orderId,since:'',includeDefects:this.store.isQualityOperator(operator.id)});
      this.db.prepare(`INSERT INTO assignments(id,operator_id,task_id,project_id,project_code,product_name,process_name,station_name,machine_id,quantity,target_quantity,baseline_reported_amount,local_report_baseline,min_duration_seconds,max_duration_seconds,status,assignment_mode,flow_code_hint,published_by,published_by_operator_id,published_at,quantity_policy,quality_inspection)
        VALUES(?,?,?,?,?,?,?,?,'',?,?,?,?,0,2147483647,?,?,?,?,?,?,?,?)`).run(task.id,operator.id,task.processId,task.orderId,task.orderCode,order.productName||order.product||'',task.processName,task.unitId,quantity,quantity,baseline,baseline,status,task.isSelfService?'SELF_SCAN':'DISPATCHED',String(task.orderId).slice(-4),task.isSelfService?person.name:session.name,task.isSelfService?null:session.blacklakeOperatorId,sql(task.assignedAt),'SERVER_DEFAULT',task.isQualityInspection||this.store.isQualityOperator(operator.id)?1:0);
    }
    const started=task.segments[0]?.start||null,ended=task.endedAt||(task.status==='CANCELLED'?(task.cancelledAt||task.segments.at(-1)?.end):null)||null;
    const original=rows.find(row=>row.id===task.id);
    assert(!original?.started_at||sql(started)===original.started_at,409,'WORKSPACE_START_CHANGED','已记录的开工时间不能被排工操作清空或改写，请刷新任务。');
    this.db.prepare('UPDATE assignments SET operator_id=?,task_id=?,process_name=?,station_name=?,status=?,started_at=?,ended_at=?,queue_position=?,cancellation_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(operator.id,task.processId,task.processName,task.unitId,status,sql(started),sql(ended),task.queueRank??null,task.status==='CANCELLED'?cancellationReason:'',task.id);
    const stateData={segments:task.segments,priority:task.priority,pauseReason:task.pauseReason,pausedAt:task.pausedAt,queueRank:task.queueRank};
    this.db.prepare('INSERT INTO workspace_task_state VALUES(?,?) ON CONFLICT(assignment_id) DO UPDATE SET state_json=excluded.state_json').run(task.id,JSON.stringify(stateData));
    const desired=(task.timerPauses||[]).map(p=>({start:p.start,end:p.end,source:p.storageSource||p.source||'employee'}));
    if(task.status==='CANCELLED')for(const pause of desired)if(!pause.end)pause.end=ended;
    for(let i=0;i<task.segments.length-1;i++){const end=task.segments[i].end,start=task.segments[i+1].start;if(end&&Date.parse(start)>=Date.parse(end))desired.push({start:end,end:start,source:'workspace_queue'});}
    // An open employee/clock-out pause already covers this queue wait. Keep
    // that pause and its source; never store a second open pause for the task.
    // When it closes, the next persist materializes the remaining queue wait.
    if(started&&['PAUSED','READY'].includes(task.status)&&task.segments.at(-1)?.end&&!desired.some(p=>!p.end&&p.source!=='workspace_queue'))desired.push({start:task.segments.at(-1).end,end:null,source:'workspace_queue'});
    const open=this.db.prepare('SELECT * FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(task.id);
    if(open){const match=desired.find(p=>sql(p.start)===open.started_at&&p.source===open.source);if(!match||match.end)this.db.prepare('UPDATE assignment_pauses SET ended_at=? WHERE id=?').run(sql(match?.end)||sql(task.segments.at(-1)?.start)||shanghaiTime(this.now()),open.id);}
    for(const p of desired){const existing=this.db.prepare('SELECT * FROM assignment_pauses WHERE assignment_id=? AND started_at=? AND source=? ORDER BY id LIMIT 1').get(task.id,sql(p.start),p.source);if(existing){if(existing.ended_at!==sql(p.end))this.db.prepare('UPDATE assignment_pauses SET ended_at=? WHERE id=?').run(sql(p.end),existing.id);}else this.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at,ended_at,source) VALUES(?,?,?,?)').run(task.id,sql(p.start),sql(p.end),p.source);}
    if(ended&&started){const pauses=this.store.assignmentPauses(task.id),seconds=effectiveWorkSecondsBetween(sql(started),sql(ended),pauses);this.db.prepare('UPDATE assignments SET duration_seconds=? WHERE id=?').run(seconds,task.id);}
  }
}
