const detail=require('./detail-model');
const normalize=value=>String(value??'').replace(/[\uFF01-\uFF5E]/g,char=>String.fromCharCode(char.charCodeAt(0)-65248)).toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
const terms=value=>String(value||'').split(/\s+/).map(normalize).filter(Boolean);
const matches=(row,query)=>query.every(term=>[row.orderCode,row.product,row.productCode,row.productName,row.productSpecification,row.workerName,row.productionWorkerName,row.processName].some(value=>normalize(value).includes(term)));
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
function productLabels(task){
  const text=value=>typeof value==='string'||typeof value==='number'?String(value).trim():'';
  const parts=text(task.product).split('|').map(part=>part.trim()).filter(Boolean);
  const productCode=text(task.productCode)||(parts.length>1?parts[0]:'');
  const names=[text(task.productName),text(task.productSpecification)].filter(Boolean);
  const productDescription=[...new Set(names)].join(' · ')||(parts.length>1?parts.slice(1).join(' | '):text(task.product))||'产品信息未提供';
  return {reportTitle:[text(task.orderCode)||'工单编号未提供',productCode].filter(Boolean).join(' · '),productDescription};
}
function present(assignments){
  return detail.presentAssignments(assignments).map(task=>({...task,
    statusText:task.status==='IN_PROGRESS'&&task.timerPaused?'已暂停':task.statusText,
    assignedShort:task.assignedText==='未确认'?'派工时间未确认':task.assignedText.slice(5,16),
    reportCount:task.reports.filter(report=>!report.deleted).length,
    reports:task.reports.map(report=>({...report,assignmentId:task.id,orderId:task.orderId,processId:task.processId,productionWorkerId:report.productionWorkerId??task.workerId,orderCode:task.orderCode,product:task.product,
      productCode:task.productCode,productName:task.productName,productSpecification:task.productSpecification,
      processName:task.processName,workerName:task.workerName,statusText:task.statusText,
      productionWorkerName:report.productionWorkerName||task.workerName,...productLabels(task)}))}));
}
function view(assignments,{keyword='',status='all',reportScope='',deleted=false}={}){
  const query=terms(keyword),searched=assignments.filter(row=>matches(row,query));
  const reports=assignments.flatMap(task=>task.reports).filter(report=>matches(report,query));
  const scope=assignments.find(row=>String(row.id)===String(reportScope));
  return {
    visibleTasks:searched.filter(row=>status==='all'||row.status===({paused:'PAUSED',running:'IN_PROGRESS',ready:'READY',completed:'COMPLETED',cancelled:'CANCELLED'}[status])).sort((a,b)=>stamp(b.assignedAt)-stamp(a.assignedAt)),
    visibleReports:reports.filter(report=>(!scope||String(report.assignmentId)===String(scope.id))&&!!report.deleted===deleted).sort((a,b)=>stamp(b.createdAt)-stamp(a.createdAt)).map((row,index)=>({...row,anchorId:'report-more-0-'+index})),
    taskCounts:{all:searched.length,paused:searched.filter(row=>row.status==='PAUSED').length,running:searched.filter(row=>row.status==='IN_PROGRESS').length},
    reportCount:reports.filter(row=>!row.deleted).length,deletedCount:reports.filter(row=>row.deleted).length,
    reportScope:scope?String(scope.id):'',scopeLabel:scope?scope.workerName+' · '+scope.processName:''
  };
}
module.exports={present,view};
