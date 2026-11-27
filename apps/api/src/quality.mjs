// Historical fallback only for legacy already-submitted records that have no
// stored identity snapshot. New/unreported work uses the server staff profile.
export function isQualityInspection(processName) {
  return /质检|检验|检测|检查/.test(String(processName || ""));
}

export function reportedTaskAmount(task, inspection = false) {
  const good = Number(task.reportedGoodAmount) || 0;
  if (!inspection) return good;
  return Math.max(good + (Number(task.reportedDefectAmount) || 0), Number(task.completedAmount) || 0);
}
