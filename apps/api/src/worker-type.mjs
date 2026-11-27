import { isEmbroideryDepartment, reportingProfile, REPORTING_MODES } from './embroidery.mjs';

export function workerRouting(operator, entry, setting = {}, legacyFloor8Ids = []) {
  const type=setting.workerType||'auto',employee=entry.appRole==='employee',machine=String(entry.workUnitId||'').startsWith('3F-');
  const floor8=employee&&!machine&&(type==='floor8'||type==='auto'&&(legacyFloor8Ids.includes(Number(operator.blacklakeOperatorId))||!isEmbroideryDepartment(operator.groupNames)));
  return {workerType:type,workerTypeRevision:setting.revision||0,effectiveWorkerType:employee?(floor8?'floor8':'embroidery'):null,
    canReceiveFloor8Assignments:floor8,floor8EmployeeOverride:floor8&&(type==='floor8'||legacyFloor8Ids.includes(Number(operator.blacklakeOperatorId)))};
}

export function workerReportingProfile(operator,entry,setting,config,permission) {
  const base=reportingProfile(operator,config.reportingModeAdminOperatorIds,permission),routing=workerRouting(operator,entry,setting,config.floor8EmployeeIds||[]);
  if(!routing.effectiveWorkerType)return base;
  const mode=routing.effectiveWorkerType==='floor8'?REPORTING_MODES.STANDARD:REPORTING_MODES.EMBROIDERY;
  return {...base,defaultReportingMode:mode,reportingModes:base.reportingModes.length>1?base.reportingModes:[mode]};
}
