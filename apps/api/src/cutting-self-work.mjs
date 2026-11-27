import { FLOOR8_UNIT_IDS } from './dispatch.mjs';

export const isCuttingProcess = (process) => /裁床|裁剪|裁切|开料|下料/.test(String(process?.processName || ''))
  && !/检验|质检|检查/.test(String(process?.processName || ''));

export function cuttingWorkUnits(store, operatorId) {
  return [...new Set([
    store.entryProfile(operatorId)?.workUnitId,
    ...store.dispatchUnitRecommendations().filter(row=>row.blacklakeOperatorId===operatorId).map(row=>row.unitId)
  ].filter(id=>FLOOR8_UNIT_IDS.includes(id)&&id.startsWith('裁床')))];
}

export function employeeWorkUnits(store, operatorId) {
  return [...new Set([store.entryProfile(operatorId)?.workUnitId,
    ...store.dispatchUnitRecommendations().filter(row=>row.blacklakeOperatorId===operatorId).map(row=>row.unitId)
  ].filter(id=>FLOOR8_UNIT_IDS.includes(id)))];
}
