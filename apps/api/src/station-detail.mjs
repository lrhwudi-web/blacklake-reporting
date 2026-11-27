const labels={READY:'待开始',IN_PROGRESS:'生产中',REPORTING:'提交中',NEEDS_REVIEW:'结果待核对'};
const observed=(r,k)=>r.quantityPresence?.[k]!==false&&r[k]!==null&&r[k]!==undefined&&String(r[k]).trim()!==''&&Number.isFinite(Number(r[k]))&&Number(r[k])>=0&&(Number(r[k])!==0||r.quantityPresence?.[k]===true);
function step(r,taskId){
 const plan=observed(r,'plannedAmount')?Number(r.plannedAmount):null,good=observed(r,'reportedGoodAmount')?Number(r.reportedGoodAmount):null;
 const ratio=plan>0&&good!==null?Math.round(good/plan*1000)/10:null,percent=ratio!==null&&Number.isFinite(ratio)?ratio:null;
 const display=String(r.processStatusDisplay||'').trim();
 const closed=Number(r.processStatus)===20||/^(已完成|完成|已完工|完工|已结束|已关闭|已取消|已作废)$/.test(display)?true:Number(r.processStatus)===10||/^(未开始|执行中|进行中)$/.test(display)?false:null;
 return{taskId:r.taskId,processName:r.processName||'未命名工序',sequence:observed(r,'sequence')?Number(r.sequence):null,plannedAmount:plan,reportedGoodAmount:good,percent,percentLabel:percent===null?'未确认':percent+'%',closed,statusLabel:closed?'已结束':r.processStatusDisplay||'状态未确认',current:r.taskId===taskId};
}

// Shared current floor occupancy is distinct from owner-scoped dispatch history.
export async function stationDetail({store,blacklake,unitId,now=Date.now}){
 const assignments=store.activeAssignmentsByUnit(unitId),ids=[...new Set(assignments.map(a=>a.projectId).filter(id=>Number.isSafeInteger(id)&&id>0))];
 let tasks=[],progressError='';
 if(ids.length)try{tasks=await blacklake.listProjectTasks({projectIds:ids},{deadline:Date.now()+10000});}catch{progressError='工序进度暂未取得，请重试。';}
 const bindings=store.dispatchUnitRecommendations().filter(r=>r.unitId===unitId).map(r=>r.blacklakeOperatorId);
 const mapped=unitId.startsWith('3F-')?store.operatorForWorkUnit(unitId):null;
 if(mapped?.blacklakeOperatorId)bindings.push(mapped.blacklakeOperatorId);
 const residents=[...new Set(bindings)].map(id=>{const p=store.findOperatorByBlacklakeId(id);return{blacklakeOperatorId:id,name:p?.name||'人员 '+id,activeHere:assignments.some(a=>a.operatorId===p?.id&&a.status==='IN_PROGRESS')};});
 const items=assignments.map(a=>{
  const ordered=[...new Map(tasks.filter(t=>Number.isSafeInteger(t.taskId)&&t.taskId>0&&t.projectId===a.projectId).map(t=>[t.taskId,t])).values()].sort((l,r)=>(observed(l,'sequence')&&l.sequence>0?l.sequence:Number.MAX_SAFE_INTEGER)-(observed(r,'sequence')&&r.sequence>0?r.sequence:Number.MAX_SAFE_INTEGER)||l.taskId-r.taskId);
  const steps=ordered.map(t=>step(t,a.taskId)),missing=!steps.some(p=>p.current);
  if(missing)steps.push({taskId:a.taskId,processName:a.processName||'本地任务工序',sequence:null,plannedAmount:null,reportedGoodAmount:null,percent:null,percentLabel:'未确认',closed:false,statusLabel:'上游未确认',current:true});
  return{id:a.id,operatorName:a.operatorName,projectId:a.projectId,projectCode:a.projectCode,productName:a.productName,taskId:a.taskId,processName:a.processName,status:a.status,statusLabel:labels[a.status]||a.status,startedAt:a.startedAt||null,steps,progressError:progressError||(missing?'未在黑湖工序中找到该任务，保留本地工序供核对。':''),orderUnconfirmed:ordered.some(t=>!observed(t,'sequence')||t.sequence<=0),currentProcessClosed:steps.some(p=>p.current&&p.closed)};
 });
 return{unitId,residents,assignments:items,coverage:{localSource:'本系统当前未结束任务与常驻绑定；不代表人员实时到岗',progressSource:'黑湖工单各工序累计已报合格数 / 计划数，并非个人完成率',queriedAt:new Date(now()).toISOString(),upstreamCacheSeconds:30,completeWithinScope:true}};
}
