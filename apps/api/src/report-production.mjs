import {assert} from './errors.mjs';
import {workTimeBreakdown,timestampMs} from './work-time.mjs';
const shanghaiTime=ms=>new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' ');

export function initializeReportProduction(db){db.exec(`CREATE TABLE IF NOT EXISTS report_production_details(
 report_id TEXT PRIMARY KEY REFERENCES reports(id),data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS report_defect_allocations(report_id TEXT PRIMARY KEY REFERENCES reports(id),items_json TEXT NOT NULL);`);}
export function reportProduction(store,id){const row=store.db.prepare('SELECT data_json FROM report_production_details WHERE report_id=?').get(id);return row?JSON.parse(row.data_json):null;}
export function reportSubmissionIdentity(store,id){
 const production=reportProduction(store,id);
 if(production)return Number(production.upstreamOperatorId)!==Number(production.personId)
  ?{actualOperatorId:production.operatorId,actualName:production.operatorName,submitAsId:production.upstreamOperatorId,submitAsName:production.upstreamOperatorName}:undefined;
 return store.members?.snapshot(id)||undefined;
}
export function validReportTime(value,now){
 const at=timestampMs(value);
 assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)&&Number.isFinite(at)&&shanghaiTime(at)===value&&at<=now,422,'INVALID_REPORT_TIME','请填写有效时间，且不能晚于当前时间。');
 return value;
}
export function balanceReportDuration(elapsedSeconds,durationSeconds,planRestTime=0,unplanShutdownTime=0){
 assert([elapsedSeconds,durationSeconds,planRestTime,unplanShutdownTime].every(v=>Number.isSafeInteger(v)&&v>=0)&&durationSeconds<=elapsedSeconds,422,'INVALID_REPORT_DURATION','有效工时须为非负秒数，且不能超过起止时间的实际跨度。');
 const deduction=elapsedSeconds-durationSeconds,rest=Math.min(planRestTime,deduction);
 return {planRestTime:rest,unplanShutdownTime:deduction-rest,manualAdjustmentSeconds:Math.max(0,elapsedSeconds-planRestTime-unplanShutdownTime)-durationSeconds};
}
export function reportEditProduction(store,row,input,now){
 const old=reportProduction(store,row.local_report_id),startedAt=validReportTime(input.startedAt??old?.startedAt??row.started_at,now),endedAt=validReportTime(input.endedAt??old?.endedAt??row.ended_at,now);
 assert(endedAt>=startedAt,422,'INVALID_REPORT_TIME','结束时间不能早于开始时间。');
 const breakdown=workTimeBreakdown(startedAt,endedAt,store.assignmentPauses(row.id)),calculated=breakdown.effectiveSeconds;
 const seconds=input.durationSeconds??(startedAt===old?.startedAt&&endedAt===old?.endedAt?old.durationSeconds:calculated);
 const balanced=balanceReportDuration(breakdown.elapsedSeconds,seconds,breakdown.lunchSeconds,breakdown.pauseSeconds);
 const materialProcess=input.materialProcess??old?.materialProcess??'';
 const punchMinutes=(timestampMs(endedAt)-timestampMs(startedAt))/60000;
 assert(typeof materialProcess==='string'&&materialProcess.length<=100&&!/[\u0000-\u001f]/.test(materialProcess),422,'INVALID_REPORT_EXTRA','请核对用料工序。');
 assert(input.punchMinutes===undefined||Number.isFinite(input.punchMinutes)&&Math.abs(input.punchMinutes-punchMinutes)<0.000001,422,'INVALID_REPORT_EXTRA','打卡时长由起止时间计算，不能手工修改为有效工时。');
 return {startedAt,endedAt,durationSeconds:seconds,durationMode:seconds===calculated?'RECALCULATED':'MANUAL',...balanced,materialProcess:materialProcess.trim(),punchMinutes};
}
