// Original authenticated transport; no demo identities, sample orders or fallback writer.
const {request}=require('../../utils/api');
const read=path=>request(path,{timeout:path.startsWith('/v1/orders')?45000:15000}),post=(path,data,key)=>request(path,{method:'POST',data,idempotencyKey:key});
const reportLinks=new Map();
function remember(snapshot){for(const task of snapshot.assignments||[])for(const report of task.reports||[])reportLinks.set(String(report.id),{assignmentId:task.id,version:report.version});return snapshot;}
const loadLeaderTasks=async({activeOnly=false}={})=>remember(await read('/v1/workspace/tasks'+(activeOnly?'?active=1':'')));
const loadAssignmentHistory=async(page,start='',end='')=>remember(await read('/v1/workspace/assignment-history?page='+page+'&start='+encodeURIComponent(start)+'&end='+encodeURIComponent(end)));
const loadOrderExecution=async id=>remember(await read('/v1/workspace/tasks?orderId='+encodeURIComponent(id)));
const embroideryQuery=enabled=>enabled?'?mode=embroidery':'';
const loadEmployeeWork=async embroidery=>remember(await read('/v1/workspace/worker'+embroideryQuery(embroidery)));
const loadEmployeeOrders=(page=1,query='',options={})=>read('/v1/orders?pageNum='+page+'&projectCode='+encodeURIComponent(query)+'&sort='+encodeURIComponent(options.sort||'default')+'&status='+encodeURIComponent(options.status||'ALL')+(options.watch?.length?'&watch='+options.watch.join(','):''));
const searchQueueOrders=(page,query)=>loadEmployeeOrders(page,query,{status:'OPEN'});
const refreshOrderDetail=id=>post('/v1/orders/'+encodeURIComponent(id)+'/refresh',{});
const loadOrderDetail=id=>read('/v1/orders/'+encodeURIComponent(id));
const loadOrderProcesses=id=>read('/v1/orders/'+encodeURIComponent(id)+'/processes');
const loadOrderSection=(id,section,pageNum=1)=>read('/v1/orders/'+encodeURIComponent(id)+'/'+section+'?pageNum='+pageNum);
const processManagementPath=id=>'/v1/workspace/orders/'+encodeURIComponent(id)+'/process-management';
const loadProcessManagement=id=>read(processManagementPath(id));
const loadProcessManagementJob=(id,job)=>read(processManagementPath(id)+'?job='+encodeURIComponent(job));
const saveProcessManagement=(id,input,key)=>post(processManagementPath(id),input,key);
const searchProcessCatalog=query=>request('/v1/workspace/process-catalog?query='+encodeURIComponent(query),{timeout:45000});
const loadDispatchContext=order=>read('/v1/workspace/context/'+encodeURIComponent(order.id));
const loadDispatchPeople=async()=>{const value=await read('/v1/dispatch/overview'),employees=value.employees||[],config=value.peopleGroupConfig;return {employees,peopleGroups:config?{...config,groups:config.groups.map(group=>({...group,blacklakeOperatorIds:employees.filter(person=>(person.departments||[]).includes(group.name)).map(person=>person.blacklakeOperatorId)}))}:null};};
const loadSelfServiceContext=(id,embroidery)=>read('/v1/workspace/self/'+encodeURIComponent(id)+embroideryQuery(embroidery));
const processReportCache=new Map();let processReportAccount='';
function reportCacheKey(id,processId){const token=getApp().globalData.sessionToken||'';if(token!==processReportAccount){processReportAccount=token;processReportCache.clear();}return String(id)+':'+String(processId);}
const peekProcessReports=(id,processId)=>processReportCache.get(reportCacheKey(id,processId))||null;
async function loadProcessReports(id,processId){
 const key=reportCacheKey(id,processId),account=processReportAccount,prior=processReportCache.get(key),value=await read('/v1/workspace/process-reports/'+encodeURIComponent(id)+'/'+encodeURIComponent(processId)+(prior?.version?'?version='+encodeURIComponent(prior.version):''));
 const result=value.notModified&&prior?{...prior,...value,reports:prior.reports}:value;
 if(account===getApp().globalData.sessionToken&&Array.isArray(result.reports)){if(processReportCache.size>=40&&!processReportCache.has(key))processReportCache.delete(processReportCache.keys().next().value);processReportCache.set(key,{...result,notModified:false});}return result;
}
const refreshProcessReports=(id,processId)=>post('/v1/workspace/process-reports/'+encodeURIComponent(id)+'/'+encodeURIComponent(processId)+'/refresh',{});
const resolveScannedOrder=(flowCode,embroidery)=>post('/v1/workspace/scan'+embroideryQuery(embroidery),{flowCode});
const loadEmbroideryFinishDefaults=id=>read('/v1/assignments/'+encodeURIComponent(id)+'/finish-default?mode=embroidery');
const processReportLinks=new Map();
async function loadProcessReportCreateContext(orderId,processId){
  const value=await read('/v1/workspace/process-reports/'+encodeURIComponent(orderId)+'/'+encodeURIComponent(processId)+'/create-context');
  return {...value,serverTime:new Date(value.serverTime.replace(' ','T')+'+08:00').toISOString(),reportOptions:{employees:value.people.map(p=>({id:String(p.operatorId),name:p.name,departments:p.departments||[]})),defectReasons:value.defectReasons||[],peopleGroupConfig:value.peopleGroupConfig}};
}
async function createProcessReport(orderId,processId,input,meta){
  if(Date.parse(input.actualEndedAt)<=Date.parse(input.actualStartedAt))throw Error('请填写实际起止时间，结束时间须晚于开始时间。');
  if(input.reportedSeconds===0)throw Error('请核对有效工时。有效工时为 0 时，黑湖无法计算达标率。');
  const localTime=value=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19).replace('T',' ');
  const body={operatorId:Number(input.productionWorkerId),goodQuantity:input.goodQuantity,defectQuantity:input.defectiveQuantity,defectItems:(input.defectItems||[]).map(i=>({code:i.code,amount:i.quantity})),startedAt:localTime(input.actualStartedAt),endedAt:localTime(input.actualEndedAt),durationSeconds:input.reportedSeconds,materialProcess:input.materialProcess};
  const result=await post('/v1/workspace/process-reports/'+encodeURIComponent(orderId)+'/'+encodeURIComponent(processId)+'/create',body,meta.operationId);
  if(!result.accepted||!result.queued&&result.status!=='SUCCEEDED')throw Error('本次报工已保存但同步异常，请在报工记录或后台核对，勿重复新建。');return result;
}
async function loadProcessReportEditor(orderId,processId,id){
  const path='/v1/workspace/process-reports/'+encodeURIComponent(orderId)+'/'+encodeURIComponent(processId)+'/'+encodeURIComponent(id),response=await read(path+'/editor'),raw=response.report,production=raw.production||{};
  const asIso=value=>value?new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value)?value:String(value).replace(' ','T')+'+08:00').toISOString():null;
  processReportLinks.set(String(id),{path,version:raw.version,remoteVersion:raw.remoteVersion,quantityOnly:raw.quantityOnly===true,orderId:String(orderId),processId:String(processId)});
  return {orderId:response.orderId,processId:response.processId,permission:response.permission,canEdit:response.canEdit,canDelete:response.canDelete,version:raw.version,assignment:response.assignment,
    report:{...raw,id:String(id),assignmentId:response.assignment.id,productionWorkerId:String(raw.operatorId),productionWorkerName:raw.operatorName,goodQuantity:raw.goodQuantity,defectiveQuantity:raw.defectQuantity,
      actualStartedAt:asIso(raw.startedAt),actualEndedAt:asIso(raw.endedAt),reportedSeconds:raw.durationSeconds,materialProcess:production.materialProcess||'',punchMinutes:production.punchMinutes??null,defectItems:(raw.defectItems||[]).map(row=>({code:row.code,quantity:row.amount??row.quantity}))},
    reportOptions:{employees:response.people.map(person=>({id:String(person.operatorId),name:person.name,departments:person.departments||[]})),defectReasons:raw.defectReasons||[],peopleGroupConfig:response.peopleGroupConfig}};
}
async function changeProcessReport(orderId,processId,input,meta,action){
  const link=processReportLinks.get(String(input.reportId));if(!link||link.orderId!==String(orderId)||link.processId!==String(processId)||link.version!==meta.expectedVersion)throw Error('请刷新工序报工后重新打开编辑。');
  const body={expectedVersion:link.version},localTime=value=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19).replace('T',' ');
  if(action==='edit'){
    const items=input.defectItems||[];
    Object.assign(body,{goodQuantity:input.goodQuantity,defectQuantity:input.defectiveQuantity,defectCodes:items.map(row=>row.code),defectItems:items.map(row=>({code:row.code,amount:row.quantity}))});
    if(!link.quantityOnly)Object.assign(body,{expectedRemoteVersion:link.remoteVersion,operatorId:Number(input.productionWorkerId),startedAt:localTime(input.actualStartedAt),endedAt:localTime(input.actualEndedAt),durationSeconds:input.reportedSeconds,materialProcess:input.materialProcess});
  }
  const result=await post(link.path+'/'+action,body,meta.operationId);if(result.status!=='SUCCEEDED'&&!(result.accepted&&result.queued))throw Error(result.error?.message||'报工操作结果待核对，请勿重复提交。');return result;
}
const approveProcessReport=(row,operationId)=>post('/v1/workspace/process-reports/'+encodeURIComponent(row.orderId)+'/'+encodeURIComponent(row.processId)+'/'+encodeURIComponent(row.id)+'/approval',{
  approved:row.approvalStatus===0,expectedStatus:row.approvalStatus,
  ...(row.approvalRevision!=null?{expectedApprovalRevision:row.approvalRevision}:{})
},operationId);
const editProcessReport=(orderId,processId,input,meta)=>changeProcessReport(orderId,processId,input,meta,'edit');
const deleteProcessReport=(orderId,processId,input,meta)=>changeProcessReport(orderId,processId,input,meta,'delete');
const previewAssignment=input=>post('/v1/workspace/preview',input);
async function recommendDispatchProcess(order,ids){const response=await post('/v1/dispatch/prediction',{flowCode:'projectId='+order.id,blacklakeOperatorIds:ids});return response.prediction?.snapshot||response.prediction?.suggestion||response.prediction||null;}
async function loadReportEdit(id){
  const link=reportLinks.get(String(id));if(!link)throw Error('请刷新报工记录。');
  const response=await read('/v1/dispatch/reports/'+encodeURIComponent(link.assignmentId)+'/editor');
  reportLinks.set(String(id),{...link,version:response.report.version,remoteVersion:response.report.remoteVersion});
  const raw=response.report,production=raw.production||{},asIso=value=>value?new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value)?value:String(value).replace(' ','T')+'+08:00').toISOString():null;
  return {report:{...raw,id:String(id),productionWorkerId:String(raw.operatorId),goodQuantity:raw.goodQuantity,defectiveQuantity:raw.defectQuantity,
    actualStartedAt:asIso(raw.startedAt),actualEndedAt:asIso(raw.endedAt),reportedSeconds:raw.durationSeconds,materialProcess:production.materialProcess||'',punchMinutes:production.punchMinutes??null,
    defectItems:(raw.defectItems||[]).map(row=>({code:row.code,quantity:row.amount??row.quantity})),defectCodes:raw.defectCodes||[]},
    options:{employees:response.people.map(person=>({id:String(person.operatorId),name:person.name,departments:person.departments||[]})),defectReasons:raw.defectReasons||[],peopleGroupConfig:response.peopleGroupConfig}};
}
async function executeExecutionAction(action,input,meta={}){
  const key=meta.operationId;
  if(meta.embroidery){
    if(action==='selfStart')return post('/v1/flow/start',{flowCode:'projectId='+input.orderId,taskId:input.processId,reportingMode:'embroidery',selfService:'embroidery-bound',embroideryPart:input.embroideryPart},key);
    const path='/v1/assignments/'+encodeURIComponent(input.assignmentId);
    if(action==='start')return post(path+'/start',{},key);
    if(action==='exitClosedSelfTask')return post(path+'/exit-closed-machine',{},key);
    const timerPath={end:'end',cancelEnd:'cancel-end',cancelSelfReport:'withdraw'}[action];
    if(timerPath)return post(path+'/'+timerPath,{expectedRevision:meta.expectedTimingRevision},key);
  }
  if(['pauseTimer','resumeTimer'].includes(action))return post('/v1/assignments/'+encodeURIComponent(input.assignmentId)+'/'+(action==='pauseTimer'?'pause':'resume'),{expectedRevision:meta.expectedTimingRevision},key);
  if(action==='finish'){
    const result=await post('/v1/assignments/'+encodeURIComponent(input.assignmentId)+'/finish',{quantity:input.goodQuantity,defectQuantity:input.defectiveQuantity,defectCodes:input.defectCodes||[],...(input.defectItems?{defectItems:input.defectItems.map(row=>({code:row.code,amount:row.quantity}))}:{})},key);
    const status=result.assignment?.status;
    if(result.quantityReviewPending||status!=='COMPLETED'&&!(result.accepted&&['NEEDS_REVIEW','REPORTING'].includes(status))){
      throw Error('报工结果待核对，请刷新任务，勿重复提交。');
    }
    return result;
  }
  if(['editReport','deleteReport'].includes(action)){
    const link=reportLinks.get(String(input.reportId));if(!link)throw Error('请刷新报工记录。');
    const body={expectedVersion:link.version},localTime=value=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19).replace('T',' ');
    if(action==='editReport')Object.assign(body,{expectedRemoteVersion:link.remoteVersion,goodQuantity:input.goodQuantity,defectQuantity:input.defectiveQuantity,
      defectCodes:(input.defectItems||[]).filter(row=>row.quantity>0).map(row=>row.code),defectItems:(input.defectItems||[]).map(row=>({code:row.code,amount:row.quantity})),
      operatorId:Number(input.productionWorkerId),startedAt:localTime(input.actualStartedAt),endedAt:localTime(input.actualEndedAt),durationSeconds:input.reportedSeconds,
      materialProcess:input.materialProcess});
    const response=await post('/v1/dispatch/reports/'+encodeURIComponent(link.assignmentId)+'/'+(action==='editReport'?'edit':'delete'),body,key);
    if(response.status!=='SUCCEEDED'&&!(response.accepted&&response.queued))throw Error(response.error?.message||'报工操作结果待核对，请先核对，勿重复提交。');return response;
  }
  if(action==='restoreReport')throw Error('报工恢复接口尚未完成正式验证，本次未改动数据。');
  if(action==='updateOrder'){const result=await post('/v1/workspace/actions',{action,input,meta:{expectedVersion:meta.expectedVersion}},key);if(result.status!=='SUCCEEDED'&&result.status!=='UNKNOWN'&&!(result.accepted&&result.queued))throw Error(result.message||'工单修改未完成，请重新核对。');return result;}
  return post('/v1/workspace/actions',{action,input,meta:{expectedVersion:meta.expectedVersion,...(Number.isSafeInteger(meta.dispatchVersion)?{dispatchVersion:meta.dispatchVersion}:{})}},key);
}
const loadClockout=()=>read('/v1/dispatch/clock-out');
const pauseClockout=(input,key)=>post('/v1/dispatch/clock-out',input,key);
const saveClockoutSchedule=(input,key)=>request('/v1/dispatch/clock-out/schedule',{method:'PUT',data:input,idempotencyKey:key});
const loadOrderOperations=(id,operationId)=>read('/v1/workspace/orders/'+encodeURIComponent(id)+'/operations'+(operationId?'?operationId='+encodeURIComponent(operationId):''));
const loadOrderOperationStates=()=>Promise.resolve(null);
const loadWorkspaceReports=filters=>read('/v1/workspace/reports?'+Object.entries(filters||{}).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'));
module.exports={approveProcessReport,loadWorkspaceReports,read,loadLeaderTasks,loadAssignmentHistory,loadOrderExecution,loadEmployeeWork,loadEmployeeOrders,searchQueueOrders,loadOrderDetail,refreshOrderDetail,loadOrderProcesses,loadOrderSection,loadProcessManagement,loadProcessManagementJob,saveProcessManagement,searchProcessCatalog,loadDispatchContext,loadDispatchPeople,loadSelfServiceContext,loadProcessReports,refreshProcessReports,peekProcessReports,resolveScannedOrder,loadProcessReportCreateContext,createProcessReport,loadProcessReportEditor,editProcessReport,deleteProcessReport,previewAssignment,recommendDispatchProcess,loadReportEdit,executeExecutionAction,loadClockout,pauseClockout,saveClockoutSchedule,loadOrderOperations,loadOrderOperationStates,loadEmbroideryFinishDefaults};
