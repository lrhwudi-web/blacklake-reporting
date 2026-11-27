const detail=require('./detail-model');
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
const dayKey=value=>{const time=Date.parse(value);return Number.isFinite(time)?new Date(time+8*3600000).toISOString().slice(0,10):'';};
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const offsetDay=(value,days)=>validDay(value)?new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10):'';
const priorities={IN_PROGRESS:0,PAUSED:1,READY:2,AWAITING_QUANTITY:3,REPORTING:4,NEEDS_REVIEW:5,COMPLETED:6,CANCELLED:7};
const stateLabels={all:'全部派工',running:'进行中',paused:'已暂停',ready:'待开始',completed:'已完成',cancelled:'已撤销'};
const states={running:'IN_PROGRESS',paused:'PAUSED',ready:'READY',completed:'COMPLETED',cancelled:'CANCELLED'};
const taskOrder=(a,b)=>(a.isEmployeeCurrent?0:1)-(b.isEmployeeCurrent?0:1)||(a.queuePosition??1e9)-(b.queuePosition??1e9)||(priorities[a.status]??99)-(priorities[b.status]??99)||stamp(b.assignedAt)-stamp(a.assignedAt);
const historyAt=row=>row.endedAt||row.segments?.filter(segment=>segment.end).at(-1)?.end||null;
function dateMatches(value,{mode='today',today='',start='',end=''}={}){
  if(mode==='all')return true;const day=dayKey(value);if(!day)return false;
  if(mode==='custom')return validDay(start)&&validDay(end)&&start<=end&&day>=start&&day<=end;
  if(!validDay(today))return false;
  if(mode==='yesterday')return day===offsetDay(today,-1);
  if(mode==='week')return day>=offsetDay(today,-6)&&day<=today;
  return day===today;
}
function dateLabel(mode,today,start,end){
  if(mode==='all')return '全部日期';if(mode==='week')return '最近7天';
  if(mode==='custom')return start===end?start.slice(5).replace('-','月')+'日':start.slice(5).replace('-','/')+' – '+end.slice(5).replace('-','/');
  const value=mode==='yesterday'?offsetDay(today,-1):today;
  return (mode==='yesterday'?'昨天':'今天')+(validDay(value)?' '+Number(value.slice(5,7))+'月'+Number(value.slice(8,10))+'日':'');
}
function groupIdentity(row,mode,reports){
  if(mode==='order')return {key:'order:'+String(row.orderId??row.assignmentId??row.id),label:row.orderCode||'工单编号未提供'};
  if(mode==='process')return {key:'process:'+String(row.processId??row.processName??row.id),label:row.processName||'工序未提供'};
  const id=reports?row.productionWorkerId:row.workerId;
  return {key:'person:'+String(id??('unknown-'+row.id)),label:(reports?row.productionWorkerName:row.workerName)||'人员待核对'};
}
function project(base,{tab='assignments',groupMode='person',status='all',dateMode='today',today='',start='',end='',deleted=false,drill=null,history=false,historyDateMode='all',historyStart='',historyEnd=''}={}){
  const reports=tab==='reports';
  const tasks=base.visibleTasks.filter(row=>['COMPLETED','CANCELLED'].includes(row.status)===history&&(status==='all'||row.status===states[status])&&(!history||dateMatches(historyAt(row),{mode:historyDateMode,today,start:historyStart,end:historyEnd})));
  const records=reports?base.visibleReports.filter(row=>drill?.mode==='assignment'&&drill.allDates===true||dateMatches(row.createdAt,{mode:dateMode,today,start,end})):tasks;
  const groups=new Map();
  for(const row of records){const identity=groupIdentity(row,groupMode,reports);if(!groups.has(identity.key))groups.set(identity.key,{...identity,rows:[]});groups.get(identity.key).rows.push(row);}
  const overviewGroups=[...groups.values()].map(group=>{
    group.rows.sort((a,b)=>reports?stamp(b.createdAt)-stamp(a.createdAt):history?stamp(historyAt(b))-stamp(historyAt(a)):taskOrder(a,b));
    const first=group.rows[0],time=reports?stamp(first.createdAt):stamp(history?historyAt(first):first.assignedAt);
    return {key:group.key,label:group.label,count:group.rows.length,
      preview:reports?group.rows.length+' 条报工 · '+(time?'最近 '+detail.time(first.createdAt).slice(11,16):'时间未提供'):(groupMode==='person'?first.processName:first.workerName)||'资料未提供',
      state:reports?'':first.statusText,stateCode:reports?'':first.status,rank:reports||history?0:(priorities[first.status]??99),latest:time};
  }).sort((a,b)=>a.rank-b.rank||b.latest-a.latest||a.label.localeCompare(b.label));
  const selected=drill?.mode==='assignment'?records.filter(row=>String(row.assignmentId)===String(drill.key)):drill?records.filter(row=>groupIdentity(row,drill.mode,reports).key===drill.key):[];
  const ordered=reports?selected:[...selected].sort(history?(a,b)=>stamp(historyAt(b))-stamp(historyAt(a)):taskOrder);
  return {overviewGroups,displayTasks:reports?[]:ordered,displayReports:reports?selected:[],drillCount:selected.length,
    overviewFilterLabel:reports?dateLabel(dateMode,today,start,end)+(deleted?' · 已删除':''):history?dateLabel(historyDateMode,today,historyStart,historyEnd):stateLabels[status]||stateLabels.all,
    overviewGroupLabel:{person:'按人员',order:'按工单',process:'按工序'}[groupMode]||'按人员'};
}
module.exports={dayKey,offsetDay,validDay,dateMatches,dateLabel,project,stateLabels};
