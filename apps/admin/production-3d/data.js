export const activeStatuses = new Set(['READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW']);
export const isQuantityPending = item => item?.quantityPending === true || item?.status === 'QUANTITY_PENDING';
export const hasUnconfirmedQuantity = item => isQuantityPending(item) || item?.quantityPolicy === 'PENDING_REVIEW';
export const assignmentStatusName = item => isQuantityPending(item) ? '待核量' : ({READY:'待开始',IN_PROGRESS:'生产中',NEEDS_REVIEW:'待核对',REPORTING:'提交中'}[item?.status] || '状态待确认');
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const orderKey = item => Number(item?.projectId) > 0 ? `project:${item.projectId}` : `legacy:${item?.projectCode || ''}:${item?.taskId || ''}`;
export function sameOrder(a,b) {
  if (Number(a?.projectId)>0 || Number(b?.projectId)>0) return Number(a?.projectId)>0 && Number(a.projectId)===Number(b?.projectId);
  return a?.projectCode===b?.projectCode && Number(a?.taskId)===Number(b?.taskId);
}
export function floor3Number(value) {
  const match=String(value || '').match(/^(?:3F-|MACHINE-)?(\d{1,2})$/);
  return match && Number(match[1])>=1 && Number(match[1])<=12 ? Number(match[1]) : null;
}
export function currentUnit(unit) {
  const assignments=(unit.assignments || []).filter(a=>activeStatuses.has(a.status));
  const state=assignments.some(a=>['REPORTING','NEEDS_REVIEW'].includes(a.status))?'attention'
    :assignments.some(a=>a.status==='IN_PROGRESS')?'running'
    :assignments.some(a=>a.status==='READY')?'scheduled'
    :unit.state==='unknown'?'unknown':'available';
  return {...unit,state,assignments};
}
export function sceneOrders(payload={}, scene={}, floor='3') {
  const units=scene.floors?.[floor] || [], sceneRecords=units.flatMap(u=>u.assignments || []), ids=new Set(units.map(u=>u.id));
  const related=(payload.assignments || []).filter(a=>floor==='3' ? Boolean(floor3Number(a.machineId)) : ids.has(a.stationName));
  const refs=[...sceneRecords,...related], seen=new Map();
  for(const a of refs) if(!seen.has(orderKey(a))) {
    const work=(payload.workOrders || []).find(w=>sameOrder(w,a));
    seen.set(orderKey(a),{...a,id:orderKey(a),name:work?.productName || a.productName || '未命名产品',due:work?.dueDate || '',processes:work?.processes || [],processSync:work?.processSync,records:refs.filter(r=>sameOrder(r,a))});
  }
  return [...seen.values()];
}
export function progress(process) {
  const plan=Number(process?.plannedAmount), amount=Number(process?.reportedAmount);
  return Number.isFinite(plan) && plan>0 && Number.isFinite(amount) ? Math.min(100,Math.round(amount/plan*100)) : null;
}
