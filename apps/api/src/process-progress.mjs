// Work-order operation totals, never personal completion or an automatic closure rule.
const number = (task, key) => {
  const value = task[key];
  if (task.quantityPresence?.[key] === false || value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && (n !== 0 || task.quantityPresence?.[key] === true) ? n : null;
};
export function processProgress(task) {
  const plan = number(task, 'plannedAmount'), good = number(task, 'reportedGoodAmount');
  const ratio = plan > 0 && good !== null ? Math.round(good / plan * 1000) / 10 : null;
  const percent = ratio !== null && Number.isFinite(ratio) ? ratio : null;
  const status = task.processStatus == null ? null : Number(task.processStatus);
  const display = String(task.processStatusDisplay || '').trim();
  const closed = status === 20 || /^(已完成|完成|已完工|完工|已结束|已关闭|已取消|已作废)$/.test(display);
  const overPlan = !closed && plan > 0 && good !== null && good > plan;
  const statusLabel = closed ? '已关闭' : overPlan ? '超计划'
    : status === 0 || display === '未开始' ? '未开始'
    : status === 10 || /^(执行中|进行中|生产中)$/.test(display) ? '进行中' : '状态未确认';
  return {plannedAmount:plan, reportedGoodAmount:good, percent, percentLabel:percent === null ? '—' : percent+'%', closed, overPlan,
    statusLabel, quantityConfirmed:percent !== null};
}
