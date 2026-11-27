function milliseconds(value){
  if(value==null||value==='')return NaN;
  if(typeof value==='number')return value;
  const text=String(value).trim(),stamp=/[zZ]|[+-]\d\d:\d\d$/.test(text)?text:text.replace(' ','T')+'+08:00';
  return Date.parse(stamp);
}
function remaining(order,now=Date.now()){
  const end=milliseconds(order.endAt);if(!Number.isFinite(end))return {dueText:'',dueLabel:'',overdue:false};
  if(order.status==='FINISHED')return {dueText:'',dueLabel:'',overdue:false};
  const delta=end-now,absolute=Math.abs(delta),days=Math.floor(absolute/86400000),hours=Math.ceil(absolute/3600000);
  const text=days>=1?days+'天':hours>=1?hours+'小时':'不足1小时';
  return {dueText:text,dueLabel:delta<0?'逾期':'剩',overdue:delta<0};
}
function compareCreated(a,b,direction='desc'){
  const first=milliseconds(a.createdAt),second=milliseconds(b.createdAt);
  if(Number.isFinite(first)!==Number.isFinite(second))return Number.isFinite(first)?-1:1;
  return (Number.isFinite(first)?(direction==='asc'?first-second:second-first):0)||String(b.id).localeCompare(String(a.id),'en',{numeric:true});
}
const orderTime={milliseconds,remaining,compareCreated};

const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '—';
function time(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' 北京时间' : '未确认';
}
function presentOrder(order) {
  return { ...order,...orderTime.remaining(order), planText: amount(order.planQuantity), remainingText:amount(order.remainingQuantity), actualText: amount(order.completedQuantity), unitText: order.unit || '单位未确认' };
}
function presentProcesses(processes) {
  return processes.map((row, index) => ({ ...row, orderLabel: String(index + 1).padStart(2, '0'),
    name: row.name || '未命名工序', percent: typeof row.percent === 'string' ? row.percent : '—',
    statusText: row.closed === true ? '已关闭' : row.statusText || '状态未确认', closed: row.closed === true,
    goodText: amount(row.goodQuantity), defectiveText: amount(row.defectiveQuantity), planText: amount(row.planQuantity), remainingText:amount(row.remainingQuantity),
    selectable: row.closed !== true && row.selectable !== false && Number.isSafeInteger(row.id) && row.id > 0 }));
}
function presentSection(section,items) {
  const label=value=>typeof value==='string'&&value.trim()?value:'—';
  return items.map((row,index)=>({...row,indexLabel:String(index+1).padStart(2,'0'),
    ...(section==='materials'?{title:row.name||row.code||'物料信息未提供',codeText:label(row.code),specText:label(row.specification),supplierText:label(row.supplier),
      inventoryText:amount(row.inventoryQuantity),requiredText:amount(row.requiredQuantity),unitText:amount(row.unitConsumption),unissuedText:amount(row.unissuedQuantity)}:
    section==='history'?{title:row.title||'生产记录',operatorText:label(row.operator),occurredText:label(row.occurredAt),processText:label(row.process),descriptionText:label(row.description),
      goodText:amount(row.goodQuantity),defectiveText:amount(row.defectiveQuantity)}:
    {title:row.process||row.code||'委外任务',codeText:label(row.code),supplierText:label(row.supplier),stateText:row.statusText||'状态未提供',
      plannedText:amount(row.plannedQuantity),deliveredText:amount(row.deliveredQuantity),receivedText:amount(row.receivedQuantity),endText:label(row.plannedEndAt)})}));
}
function presentAssignments(assignments) {
  const statuses={READY:'待开始',IN_PROGRESS:'进行中',PAUSED:'已暂停',AWAITING_QUANTITY:'待确认数量',COMPLETED:'已完成',CANCELLED:'已撤销',REPORTING:'提交中',NEEDS_REVIEW:'待核对'};
  return assignments.map(row=>({...row,statusText:statuses[row.status]||'状态未知',avatarText:(row.workerName||'员').slice(-1),
    assignedText:time(row.assignedAt),elapsedText:Math.floor(row.elapsedSeconds/3600)+'小时'+Math.floor(row.elapsedSeconds%3600/60)+'分',elapsedShortText:compactDuration(row.elapsedSeconds),
    reports:(row.reports||[]).map(report=>({...report,...presentReportRecord(report,row),goodText:amount(report.goodQuantity),defectiveText:amount(report.defectiveQuantity),timeText:time(report.updatedAt||report.createdAt),
      shortTime:time(report.actualEndedAt||report.createdAt).replace(' 北京时间','').slice(5,16),reportedAtText:time(report.createdAt)==='未确认'?'—':time(report.createdAt).slice(5,16),durationShortText:compactDuration(report.reportedSeconds),showDefective:!(typeof report.defectiveQuantity==='number'&&Number.isFinite(report.defectiveQuantity)&&report.defectiveQuantity===0),durationText:typeof report.reportedSeconds==='number'?Math.floor(report.reportedSeconds/3600)+'小时'+Math.floor(report.reportedSeconds%3600/60)+'分':'—'}))}));
}
function compactDuration(seconds){
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)return '—';
  const whole=Math.floor(seconds),hours=Math.floor(whole/3600),minutes=Math.floor(whole%3600/60);
  if(hours)return hours+'小时'+(minutes?minutes+'分':'');
  if(whole>0&&whole<60)return whole+'秒';
  return minutes+'分';
}
function presentReportRecord(report,assignment={}){
  const name=typeof report.productionWorkerName==='string'?report.productionWorkerName.trim():'';
  const sameWorker=report.productionWorkerId==null||String(report.productionWorkerId)===String(assignment.workerId);
  const created=time(report.createdAt);
  return {recordWorkerText:name||(sameWorker&&assignment.workerName)||'人员未提供',recordTimeText:created==='未确认'?'—':created.slice(0,19),
    recordGoodText:amount(report.goodQuantity),recordBadText:amount(report.defectiveQuantity),recordDurationText:compactDuration(report.reportedSeconds),recordSyncText:report.sync?.label||'',recordSyncWarning:['UNKNOWN','FAILED'].includes(report.sync?.state)};
}
function presentProcessReports(reports){
  return reports.filter(row=>!row.deleted).map(row=>({...presentReportRecord(row),id:row.id,workerText:typeof row.productionWorkerName==='string'&&row.productionWorkerName.trim()?row.productionWorkerName:'人员未提供',
    goodText:amount(row.goodQuantity),defectiveText:amount(row.defectiveQuantity),durationText:compactDuration(row.reportedSeconds),
    reportedAtText:time(row.createdAt)==='未确认'?'未确认':time(row.createdAt).slice(0,16),canManage:row.canManage===true,canEdit:row.canEdit===true,canDelete:row.canDelete===true,managementBlockedReason:typeof row.managementBlockedReason==='string'?row.managementBlockedReason:''}));
}
function processReportStatus(response){const sync=response.sync||{},partial=!sync.complete,phase=sync.phase;
 const text=sync.paused?'更新异常 · 后台待处理':phase==='cooldown'?'黑湖冷却中 · 已有记录可查看':sync.pending?(partial?'历史正在补齐 · ':'')+(phase==='updating'?'更新中':'排队更新'):partial?'历史尚未补齐':sync.status==='stale'?'已有记录 · 后台统一核对':'';
 return {processReportsStatusText:text,processReportsUpdatedText:sync.updatedAt?'最近同步 '+time(sync.updatedAt).slice(0,19):''};
}
module.exports = { compareCreated,remaining, amount, time, presentOrder, presentProcesses, presentSection, presentAssignments, presentProcessReports, presentReportRecord,processReportStatus };
