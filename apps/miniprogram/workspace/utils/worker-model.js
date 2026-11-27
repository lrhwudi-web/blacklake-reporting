const detail=require('./detail-model');
const {compareCreated}=detail;
const {productInfo}=require('./task-product');
const dates=require('./task-overview');
const quantity=value=>Number.isSafeInteger(value)&&value>=0;
function clockText(seconds){
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)return '—';
  const value=Math.floor(seconds);
  return [Math.floor(value/3600),Math.floor(value%3600/60),value%60].map(n=>String(n).padStart(2,'0')).join(':');
}
function confirmationQuantity(task){return Number.isSafeInteger(task?.processPlanQuantity)&&task.processPlanQuantity>=0?String(task.processPlanQuantity):'';}
function present(task){
  const product=productInfo(task),order=task.orderInfo||{};
  return {...task,productInfo:product,imageUrl:product.images[0]?.url||'',imageFailed:false,quantityCancelLabel:task.isSelfService?'撤销此次报工':'返回计时',
    timerStateText:task.status==='READY'||task.status==='PAUSED'&&task.canStart?'待开始':task.status==='AWAITING_QUANTITY'?'已停止':task.status==='PAUSED'?'组长已暂停':task.status==='REPORTING'?'报工提交中':task.status==='NEEDS_REVIEW'?'报工待核对':task.timerPaused?(task.timerPauseSource==='overnight'?'系统已暂停':['clockout','leader'].includes(task.timerPauseSource)?'组长已暂停':'已暂停'):'正在计时',
    planText:detail.amount(order.planQuantity),remainingText:detail.amount(order.remainingQuantity),reportPlanText:detail.amount(task.reportPlanQuantity),reportRemainingText:detail.amount(task.reportRemainingQuantity),unitText:order.unit||'单位未确认',orderSyncText:order.sync?(order.sync.status==='fresh'?'同步于 ':'上次同步 ')+(order.sync.updatedAt?detail.time(order.sync.updatedAt).slice(11,16):'尚未完成')+(order.sync.status==='fresh'?'':' · 待更新'):''};
}
function records(tasks){
  return tasks.flatMap(task=>(task.reports||[]).filter(report=>!report.deleted&&String(report.productionWorkerId||task.workerId)===String(task.workerId))
    .map(report=>({...report,...detail.presentReportRecord(report,task),assignmentId:task.id,processName:task.processName,orderCode:task.orderCode,
      productName:task.productInfo.title,unitText:task.unitText})))
    .sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
}
function recordView(records,{mode='today',today='',start='',end=''}={}){
  const range=mode==='month'?{mode:'custom',start:dates.validDay(today)?today.slice(0,7)+'-01':'',end:today}:{mode,today,start,end};
  const visible=records.filter(row=>dates.dateMatches(row.createdAt,range));
  let seconds=0,knownCount=0,unknownCount=0,good=0,bad=0,unknownQuantity=false;
  for(const row of visible){
    const value=row.reportedSeconds;
    if(typeof value==='number'&&Number.isFinite(value)&&value>=0){seconds+=value;knownCount++;}else unknownCount++;
    if(quantity(row.goodQuantity)&&quantity(row.defectiveQuantity)){good+=row.goodQuantity;bad+=row.defectiveQuantity;}else unknownQuantity=true;
  }
  const whole=Math.floor(seconds),hours=Math.floor(whole/3600),minutes=Math.floor(whole%3600/60),remainder=whole%60;
  const totalText=visible.length&&!knownCount?'—':(hours?hours+'小时':'')+(minutes?minutes+'分':'')+(remainder?remainder+'秒':'')||'0分';
  return {visibleRecords:visible,recordTotalText:totalText,recordTotalLabel:unknownCount&&knownCount?'已知报工用时':'总报工用时',recordUnknownDurationCount:unknownCount,
    recordQuantityText:unknownQuantity?'—':detail.amount(good+bad)+'件',
    recordQuantityNote:unknownQuantity?'部分件数待确认':'良品 '+detail.amount(good)+' · 不良 '+detail.amount(bad),
    recordUnknownDateCount:mode==='all'?0:records.filter(row=>!dates.dayKey(row.createdAt)).length,
    recordDateLabel:{today:'今天',yesterday:'昨天',week:'近7天',month:'本月',all:'全部',custom:'自选日期'}[mode]||'今天',
    recordRangeText:mode==='all'?'全部日期':mode==='custom'?(start===end?start:start+' 至 '+end):mode==='month'?today.slice(0,7):mode==='week'?dates.offsetDay(today,-6)+' 至 '+today:mode==='yesterday'?dates.offsetDay(today,-1):today};
}
function presentOrders(orders){
  const statuses={NOT_STARTED:'未开始',IN_PROGRESS:'进行中',FINISHED:'已结束'};
  return orders.map(order=>{
    const product=productInfo({orderId:order.id,orderInfo:order});
    return {...detail.presentOrder(order),title:order.code||order.title||'工单编号未确认',
      statusText:statuses[order.status]||'状态未确认',productText:order.product||product.title,
      imageUrl:product.images[0]?.url||'',imageFailed:false,processes:detail.presentProcesses(order.processes||[])};
  });
}
function filterOrders(orders,keyword,status,{scope='all',taskOrderIds=[],sort='default'}={}){
  const normalize=value=>String(value??'').replace(/[\uFF01-\uFF5E]/g,char=>String.fromCharCode(char.charCodeAt(0)-65248)).toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
  const terms=String(keyword||'').trim().split(/\s+/).map(normalize).filter(Boolean);
  const ids=new Set(taskOrderIds.map(String));
  const filtered=orders.filter(order=>(scope!=='mine'||ids.has(String(order.id)))&&(status==='ALL'||order.status===status)&&terms.every(term=>[order.code,order.title,order.product,order.productCode,order.productName,order.productSpecification].some(value=>normalize(value).includes(term))));
  if(sort==='default'||sort==='created-asc')filtered.sort((a,b)=>compareCreated(a,b,sort==='created-asc'?'asc':'desc'));
  if(sort==='code')filtered.sort((a,b)=>String(a.code||'').localeCompare(String(b.code||''),'zh-CN',{numeric:true}));
  else if(sort==='start-asc'||sort==='start-desc')filtered.sort((a,b)=>{const first=Date.parse(String(a.startAt||'').replace(' ','T')),second=Date.parse(String(b.startAt||'').replace(' ','T'));return !Number.isFinite(first)?(Number.isFinite(second)?1:0):!Number.isFinite(second)?-1:(sort==='start-asc'?first-second:second-first);});
  return filtered;
}
module.exports={clockText,confirmationQuantity,present,records,recordView,presentOrders,filterOrders};
