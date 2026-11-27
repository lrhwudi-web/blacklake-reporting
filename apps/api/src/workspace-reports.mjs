import {reportAuthority} from './report-authority.mjs';
import {createHash} from 'node:crypto';
import {assert} from './errors.mjs';
import {approvalProjection} from './report-approvals.mjs';
import {canReviewGroupReport,groupApprovalPending} from './group-report-review.mjs';
import {distributeDefects} from './blacklake-client.mjs';

const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const number=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const time=value=>{if(!value)return null;const at=Date.parse(/Z$|[+-]\d\d:\d\d$/.test(String(value))?value:String(value).replace(' ','T')+'+08:00');return Number.isFinite(at)?new Date(at).toISOString():null;};
const local=value=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19).replace('T',' '):'';
const day=at=>new Date(at+8*3600000).toISOString().slice(0,10);
const norm=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
const sum=(rows,key)=>rows.reduce((n,r)=>n+(r[key]??0),0);
const pieces=rows=>({pieceQuantity:rows.every(r=>r.goodQuantity!==null)?sum(rows,'goodQuantity'):null,unknownPieceCount:rows.filter(r=>r.goodQuantity===null).length});

// Read-only projections of the shared database. Opening a report never starts
// an upstream fetch or treats the currently loaded phone list as full history.
export class WorkspaceReports {
 constructor({store,workspace,sync,getPeopleGroups,defectReasons=[],now=Date.now}){Object.assign(this,{store,workspace,sync,getPeopleGroups,defectReasons,now});this.db=store.db;this.cache=null;}
 manager(session){return this.store.entryProfile(session.blacklakeOperatorId).appRole==='floor8_leader'||this.store.qualityProfile(session.blacklakeOperatorId).qualityRole==='quality_leader';}
 query(params){
  const today=day(this.now()),from=params.from||today,to=params.to||today;
  const valid=d=>/^\d{4}-\d\d-\d\d$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00+08:00'))&&day(Date.parse(d+'T00:00:00+08:00'))===d;
  assert(valid(from)&&valid(to)&&from<=to&&to<=today&&(Date.parse(to)-Date.parse(from))/86400000<=365,422,'REPORT_DATE_RANGE','请选择有效的日期范围，最长366天。');
  const page=Number(params.page||1),pageSize=Number(params.pageSize||30);
  assert(Number.isSafeInteger(page)&&page>0&&page<100000&&Number.isSafeInteger(pageSize)&&pageSize>0&&pageSize<=100,422,'REPORT_PAGE_INVALID','报工分页无效。');
  const strings=['query','group','process','personId','defectCode','approval'];for(const key of strings)assert(params[key]===undefined||typeof params[key]==='string'&&params[key].length<=120,422,'REPORT_FILTER_INVALID','报表筛选条件无效。');
  const people=params.personIds??'';
  assert(typeof people==='string'&&people.length<=6000&&(!people||/^\d{1,16}(,\d{1,16})*$/.test(people)),422,'REPORT_FILTER_INVALID','员工筛选条件无效。');
  assert(!params.approval||['approved','pending','unknown'].includes(params.approval),422,'REPORT_FILTER_INVALID','审批筛选无效。');
  const sort=params.sort||'latest';
  assert(['latest','oldest','quantity'].includes(sort),422,'REPORT_FILTER_INVALID','报工排序无效。');
  return {from,to,page,pageSize,sort,personIds:people?new Set(people.split(',')):null,...Object.fromEntries(strings.map(k=>[k,String(params[k]||'').trim()]))};
 }
 rows(from,to){
  const revision=this.db.prepare('SELECT total_changes() n').get().n,key=from+':'+to;
  if(this.cache?.key===key&&this.cache.revision===revision&&this.now()-this.cache.at<3000)return this.cache.rows;
  const orderDetails=this.sync?this.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=?'):null;
  const orderSnapshot=this.sync?this.db.prepare("SELECT data_json FROM blacklake_sync_snapshots WHERE kind='order' AND target=?"):null;
  const metadata=new Map();
  const people=new Map(this.db.prepare('SELECT id,blacklake_operator_id,name FROM operators').all().map(r=>[r.id,r]));
  const pending=new Map(this.sync?this.db.prepare("SELECT report_id,state FROM integration_jobs WHERE mode='write' AND state IN ('QUEUED','RUNNING','RETRY','UNKNOWN','FAILED') AND (kind<>'report-approval' OR state<>'FAILED') AND report_id<>''").all().map(r=>[r.report_id,r.state]):[]);
  const approvalJobs=new Map(this.sync?this.db.prepare("SELECT target,state FROM integration_jobs WHERE kind='report-approval' ORDER BY created_at,rowid").all().map(j=>[j.target,j.state]):[]);
  const approvals=new Map(this.sync?this.db.prepare("SELECT target,data_json FROM blacklake_sync_snapshots WHERE kind='report-approval'").all().map(r=>[r.target,parse(r.data_json)]):[]);
  const operations=new Set(this.db.prepare("SELECT report_id FROM leader_report_operations WHERE status IN ('CHECKING','PENDING','UNKNOWN')").all().map(r=>r.report_id));
  const localRows=this.db.prepare(`SELECT r.*,a.id assignment_id,a.project_id,a.task_id,a.project_code,a.product_name,a.process_name,a.duration_seconds,a.started_at,a.ended_at,p.data_json production_json,s.deleted,
    g.group_id,g.revision AS approval_revision,g.approved_at,d.items_json
   FROM reports r JOIN assignments a ON a.report_id=r.id LEFT JOIN report_production_details p ON p.report_id=r.id LEFT JOIN leader_report_states s ON s.report_id=r.id
   LEFT JOIN report_group_reviews g ON g.report_id=r.id LEFT JOIN report_defect_allocations d ON d.report_id=r.id
   WHERE r.created_at>=datetime(?,'-8 hours') AND r.created_at<datetime(?,'+1 day','-8 hours') ORDER BY r.created_at DESC LIMIT 50001`).all(from,to);
  const mirrors=new Set(this.db.prepare("SELECT blacklake_output_id FROM reports WHERE blacklake_output_id IS NOT NULL AND blacklake_output_id<>''").all().map(r=>String(r.blacklake_output_id)));
  assert(localRows.length<=50000,413,'REPORT_RANGE_TOO_LARGE','记录过多，请缩短日期范围。');
  const upstream=this.sync?this.db.prepare('SELECT output_id,project_id,task_id,created_at,raw_json,correction_json,deleted,updated_at FROM blacklake_output_index WHERE deleted=0 AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 50001')
   .all(from+' 00:00:00',day(Date.parse(to+'T00:00:00+08:00')+86400000)+' 00:00:00'):[];
  assert(upstream.length+localRows.length<=50000,413,'REPORT_RANGE_TOO_LARGE','记录过多，请缩短日期范围。');
  const outputs=new Map(upstream.map(row=>[String(row.output_id),row]));
  const outputById=this.sync?this.db.prepare('SELECT project_id,task_id,raw_json,correction_json,deleted,updated_at FROM blacklake_output_index WHERE output_id=?'):null;
  const readOutput=id=>{
   if(!outputs.has(id))outputs.set(id,outputById?.get(id));
   return outputs.get(id);
  };
  const rows=[];
  const approval=(output,raw)=>({approvalStatus:approvalProjection(raw,approvals.get(String(output))),approvalSync:approvalJobs.get(String(output))??null});
  const enrich=row=>{
   if(!metadata.has(row.orderId)){
    const indexed=orderDetails?.get(row.orderId),order=parse(indexed?.details_json)||{};
    const snapshot=parse(orderSnapshot?.get(String(row.orderId))?.data_json)||{};
    if(indexed&&!order.productImageUrls?.length&&snapshot.info?.productImageUrls?.length)order.productImageUrls=snapshot.info.productImageUrls;
    const processNames=new Map((snapshot.tasks||[]).map(task=>[Number(task.taskId),task.processName]));
    metadata.set(row.orderId,{order,processNames});
   }
   const {order,processNames}=metadata.get(row.orderId);
   return {...row,processName:row.processName||processNames.get(row.processId)||'',orderCode:row.orderCode||order.projectCode||String(row.orderId),productCode:order.productCode||'',
    productName:order.productName||row.productName||'',productSpecification:order.productSpecification||'',images:order.productImageUrls||[],unit:order.unit||'',defectItems:row.defectItems||[]};
  };
  const authoritative=this.sync?reportAuthority(this.store,readOutput):()=>null;
  for(const r of localRows){
   if(r.status==='DELETED'||r.deleted||!['SUCCEEDED','PENDING','UNKNOWN','FAILED',groupApprovalPending].includes(r.status)||r.status!=='SUCCEEDED'&&!r.group_id&&!pending.has(r.id))continue;
   const p=parse(r.production_json),remote=authoritative(r,p);if(remote?.deleted)continue;const worker=people.get(p.operatorId??r.operator_id),good=remote?remote.goodQuantity:number(r.good_amount),bad=remote?remote.defectiveQuantity:number(r.defect_amount);
   const allowed=r.status==='SUCCEEDED'&&!!r.blacklake_output_id&&!pending.has(r.id)&&!operations.has(r.id);
   const output=r.blacklake_output_id?readOutput(String(r.blacklake_output_id)):null;
   const indexed=output&&!output.deleted&&r.project_id!=null&&r.task_id!=null&&output.project_id===r.project_id&&output.task_id===r.task_id?output:null;
   const nativeApproval=approval(r.blacklake_output_id,parse(indexed?.raw_json));
   const syncState=pending.get(r.id)||r.status;
   const waiting=r.status===groupApprovalPending;
   const groupReview=waiting?'PENDING':r.approved_at?'APPROVED':null;
   const storedItems=r.group_id?(r.items_json?JSON.parse(r.items_json):distributeDefects(r.defect_amount,String(r.defect_code||'').split(',').filter(Boolean))):[];
   rows.push(enrich({id:r.id,orderId:r.project_id,processId:r.task_id,orderCode:r.project_code,productName:r.product_name,processName:r.process_name,personId:remote?.personId??String(worker?.blacklake_operator_id||''),personName:remote?.personName||p.operatorName||worker?.name||'人员未提供',createdAt:time(r.created_at?.replace(' ','T')+'Z'),goodQuantity:good,defectiveQuantity:bad,startedAt:time(remote?.startedAt||p.startedAt||r.started_at),endedAt:time(remote?.endedAt||p.endedAt||r.ended_at),reportedSeconds:remote?remote.reportedSeconds:number(p.durationSeconds??r.duration_seconds),defectItems:(remote?.defectItems||p.defectItems||storedItems).map(d=>({code:String(d.code),quantity:number(d.amount??d.quantity)})),canEdit:allowed||waiting,canDelete:allowed,canApprove:waiting||allowed&&!!indexed,...nativeApproval,syncState,
     ...(groupReview?{groupReview,reportGroupId:r.group_id}:{}),
     ...(waiting?{approvalStatus:0,approvalRevision:r.approval_revision}:{}),
     ...(groupReview==='APPROVED'&&nativeApproval.approvalStatus===null?{approvalStatus:10,canApprove:false,approvalSync:syncState==='SUCCEEDED'?null:syncState}:{})}));
  }
  for(const r of upstream){if(mirrors.has(String(r.output_id)))continue;const raw=parse(r.raw_json),correction=parse(r.correction_json),native=correction.native||{},id='blacklake:'+r.output_id;
    const items=correction.defectItems||raw.defectItemList||raw.defectList||native.defects||[];
    const unlocked=!!r.project_id&&!!r.task_id&&!pending.has(id);
    rows.push(enrich({id,orderId:r.project_id,processId:r.task_id,orderCode:raw.projectCode,processName:raw.processName||native.processName||'',personId:String(raw.productionStaffId??raw.productionStaff?.id??correction.operatorId??''),personName:raw.productionStaffName||raw.productionStaff?.name||(typeof raw.productionStaff==='string'?raw.productionStaff:'')||correction.operatorName||'人员未提供',createdAt:time(r.created_at||raw.createdAt),goodQuantity:number(correction.fineAmount??raw.numberofgoodProducts??raw.fineAmount),defectiveQuantity:number(correction.defectsAmount??raw.numberofDefectives??raw.defectsAmount),startedAt:time(correction.startedAt||raw.starttimeofReport||raw.startedAt),endedAt:time(correction.endedAt||raw.endtimeofReport||raw.endedAt),reportedSeconds:number(correction.effectiveTime??raw.effectiveTime),defectItems:items.map(d=>({code:String(d.code||d.defectCode||''),quantity:number(d.amount??d.defectAmount??d.quantity)})),canEdit:unlocked,canDelete:unlocked,canApprove:unlocked,...approval(r.output_id,raw),syncState:pending.get(id)||'SUCCEEDED'}));
  }
  rows.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||b.id.localeCompare(a.id));this.cache={key,revision,at:this.now(),rows};return rows;
 }
 read(params,session){
  this.workspace.authorize(session);const q=this.query(params),canManage=this.manager(session);
  const roster=this.db.prepare('SELECT blacklake_operator_id AS blacklakeOperatorId,name,group_names_json FROM operators WHERE active=1').all().map(p=>({...p,departments:parse(p.group_names_json)}));
  const groupConfig=this.getPeopleGroups(roster).groups;
  const groups=groupConfig.map(g=>({id:g.id,name:g.name,operatorIds:g.blacklakeOperatorIds||g.operatorIds||[]}));
  const rows=this.rows(q.from,q.to),terms=q.query.split(/\s+/).map(norm).filter(Boolean);
  const membership=new Map(),employeeOptions=new Map();
  for(const group of groups)for(const member of group.operatorIds){const id=String(member);if(!membership.has(id))membership.set(id,[]);membership.get(id).push(group.name);}
  for(const person of roster){const id=String(person.blacklakeOperatorId);employeeOptions.set(id,{id,name:person.name,groups:membership.get(id)||person.departments||[]});}
  for(const row of rows)if(/^\d{1,16}$/.test(row.personId)&&!employeeOptions.has(row.personId))employeeOptions.set(row.personId,{id:row.personId,name:row.personName,groups:[]});
  const selectedGroups=q.group?groups.filter(g=>g.id===q.group||g.name===q.group):[];
  const groupMembers=new Set(selectedGroups.flatMap(g=>g.operatorIds.map(String)));
  const all=rows.filter(r=>(!q.personIds||q.personIds.has(r.personId))&&(!q.group||groupMembers.has(r.personId)||selectedGroups.some(g=>g.id===r.reportGroupId))&&(!q.process||r.processName===q.process)&&terms.every(t=>[r.personName,r.orderCode,r.productCode,r.productName,r.processName].some(v=>norm(v).includes(t))));
  const selected=all.filter(r=>(!q.personId||r.personId===q.personId)&&(!q.defectCode||r.defectItems.some(d=>d.code===q.defectCode))&&(!q.approval||({pending:0,approved:10,unknown:null})[q.approval]===r.approvalStatus));
  if(q.sort==='oldest')selected.reverse();
  if(q.sort==='quantity'){
   const quantity=row=>row.goodQuantity===null||row.defectiveQuantity===null?-1:row.goodQuantity+row.defectiveQuantity;
   selected.sort((a,b)=>quantity(b)-quantity(a));
  }
  const totalBad=all.every(r=>r.defectiveQuantity!==null)?sum(all,'defectiveQuantity'):null,totalQuantity=all.every(r=>r.goodQuantity!==null&&r.defectiveQuantity!==null)?sum(all,'goodQuantity')+sum(all,'defectiveQuantity'):null;
  const people=new Map();for(const r of all){const key=r.personId||'unknown';if(!people.has(key))people.set(key,{id:key,name:r.personName,count:0,seconds:0,unknownDurationCount:0,pieceQuantity:0,unknownPieceCount:0,processes:new Set()});const p=people.get(key);p.count++;p.seconds+=r.reportedSeconds||0;p.unknownDurationCount+=r.reportedSeconds===null?1:0;p.pieceQuantity+=r.goodQuantity??0;p.unknownPieceCount+=r.goodQuantity===null?1:0;p.processes.add(r.processName||'工序未提供');}
  const processes=new Map();for(const r of all){const name=r.processName||'工序未提供';if(!processes.has(name))processes.set(name,{name,count:0,seconds:0,unknownDurationCount:0});const p=processes.get(name);p.count++;p.seconds+=r.reportedSeconds||0;p.unknownDurationCount+=r.reportedSeconds===null?1:0;}
  const defects=this.defectReasons.map(d=>({...d,quantity:all.reduce((n,r)=>n+r.defectItems.filter(i=>i.code===d.code).reduce((s,i)=>s+(i.quantity||0),0),0)}));
  const missingDefectCount=all.filter(r=>r.defectiveQuantity>0&&r.defectItems.reduce((n,d)=>n+(d.quantity||0),0)!==r.defectiveQuantity).length;
  const scopes=[];if(this.sync)for(let at=Date.parse(q.from+'T00:00:00+08:00');at<=Date.parse(q.to+'T00:00:00+08:00');at+=86400000){const d=day(at),s=this.sync.snapshot('history-day',d).sync;scopes.push({date:d,complete:s.complete,updatedAt:s.updatedAt,pending:s.pending,paused:s.paused});}
  const distinct=all.filter(r=>r.personId).map(r=>r.personId),unknownDurationCount=all.filter(r=>r.reportedSeconds===null).length;
  const reviewableGroups=new Set(groupConfig.filter(g=>g.leaderIds?.includes(session.blacklakeOperatorId)
    && canReviewGroupReport(this.store,groupConfig,g.id,session.blacklakeOperatorId)).map(g=>g.id));
  const first=(q.page-1)*q.pageSize,records=selected.slice(first,first+q.pageSize).map(r=>{
   const waiting=r.groupReview==='PENDING',allowed=canManage&&(!waiting||reviewableGroups.has(r.reportGroupId));
   return {...r,canManage:allowed,canEdit:allowed&&r.canEdit,canDelete:allowed&&r.canDelete,
    canApprove:allowed&&r.canApprove&&r.approvalStatus!==null,
    managementBlockedReason:waiting&&!allowed?'仅本小组负责组长可核对这笔报工。':r.canEdit?'':'这笔报工尚在同步，可先处理其他记录。'};
  });
  const days=Math.round((Date.parse(q.to)-Date.parse(q.from))/86400000)+1,binDays=Math.ceil(days/7),bins=[];
  if(days===1){for(const [from,to]of [[0,6],[6,9],[9,12],[12,15],[15,18],[18,21],[21,24]])bins.push({label:String(from).padStart(2,'0')+':00',seconds:all.filter(r=>{const h=Number(local(r.createdAt).slice(11,13));return h>=from&&h<to;}).reduce((n,r)=>n+(r.reportedSeconds||0),0)});}
  else for(let offset=0;offset<days;offset+=binDays){const from=day(Date.parse(q.from+'T00:00:00+08:00')+offset*86400000),to=day(Date.parse(q.from+'T00:00:00+08:00')+Math.min(days,offset+binDays)*86400000);bins.push({label:from.slice(5).replace('-','/'),seconds:all.filter(r=>local(r.createdAt).slice(0,10)>=from&&local(r.createdAt).slice(0,10)<to).reduce((n,r)=>n+(r.reportedSeconds||0),0)});}
  const result={pieceBasis:'good',selectionSummary:{...pieces(selected),seconds:sum(selected,'reportedSeconds'),unknownDurationCount:selected.filter(r=>r.reportedSeconds===null).length},range:{from:q.from,to:q.to,today:day(this.now())},canManage,summary:{...pieces(all),people:new Set(distinct).size,count:all.length,seconds:sum(all,'reportedSeconds'),unknownDurationCount,unknownPersonCount:all.filter(r=>!r.personId).length,bad:totalBad,quantity:totalQuantity,defectRate:totalQuantity>0&&totalBad!==null?totalBad/totalQuantity:null,affectedOrders:new Set(all.filter(r=>r.defectiveQuantity>0).map(r=>r.orderId)).size,missingDefectCount},people:[...people.values()].map(p=>({...p,pieceQuantity:p.unknownPieceCount?null:p.pieceQuantity,processes:[...p.processes]})),processes:[...processes.values()],defects,bins,groups:groups.map(({id,name})=>({id,name})),processOptions:[...new Set(rows.map(r=>r.processName).filter(Boolean))],records,total:selected.length,page:q.page,pageSize:q.pageSize,hasMore:first+records.length<selected.length,sync:{complete:scopes.length>0&&scopes.every(s=>s.complete),updatedAt:scopes.map(s=>s.updatedAt).filter(Boolean).sort()[0]||null,pending:scopes.some(s=>s.pending),scope:'所选日期内已同步到本系统的报工；尚未同步的历史不计入统计。',scopes},source:'local_sqlite'};
  result.summary.approvedCount=all.filter(row=>row.approvalStatus===10).length;
  result.summary.pendingApprovalCount=all.filter(row=>row.approvalStatus===0).length;
  result.employeeOptions=[...employeeOptions.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh')||a.id.localeCompare(b.id));
  result.version=createHash('sha256').update(JSON.stringify(result)).digest('hex');return result;
 }
}
