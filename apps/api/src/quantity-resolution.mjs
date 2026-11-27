import { randomUUID } from 'node:crypto';
import { assert, AppError } from './errors.mjs';
import { stableHash } from './crypto.mjs';
import { TaskRecovery, inputShape } from './task-recovery.mjs';
import {assertNewOutputLink} from './report-create-receipt.mjs';

// Completing quantities never reopens the already-ended production clock.
export class QuantityResolution {
  constructor({store,blacklake,defectReasons=[],now}) {
    this.store=store;this.db=store.db;this.blacklake=blacklake;this.recovery=new TaskRecovery(store,{now});
    this.reasons=defectReasons.map(({code,name})=>({code,name}));
  }
  detail(id, operatorId) {
    const row=this.recovery.raw(id);
    assert(operatorId===undefined||row.operator_id===operatorId,404,'ASSIGNMENT_NOT_FOUND','没有找到这笔任务。');
    return {assignment:{...this.recovery.present(row),isQualityInspection:this.store.assignmentById(id).isQualityInspection,goodQuantity:row.good_quantity,defectQuantity:row.defect_quantity},defectReasons:this.reasons};
  }
  list(operatorId,{offset=0,limit=20}={}) {
    assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=50,422,'INVALID_PAGINATION','分页参数不正确。');
    const where="operator_id=? AND (status='QUANTITY_PENDING' OR (quantity_policy='PENDING_REVIEW' AND status IN ('REPORTING','NEEDS_REVIEW')))";
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE '+where).get(operatorId).n;
    const ids=this.db.prepare('SELECT id FROM assignments WHERE '+where+' ORDER BY ended_at ASC,id LIMIT ? OFFSET ?').all(operatorId,limit,offset);
    return {assignments:ids.map(r=>this.detail(r.id,operatorId).assignment),total,offset,limit};
  }
  async submit(id,input,{actor,operationId,operatorId}) {
    inputShape(input,['expectedVersion','reason','quantity','defectQuantity','defectCodes']);
    const {assignment}=this.detail(id,operatorId);
    const reason=String(input.reason||'').trim();
    assert(reason.length<=300&&!/[\u0000-\u001f\u007f]/.test(reason),422,'RECOVERY_REASON_REQUIRED','操作备注最多300字，且不能包含控制字符。');
    const quantity=input.quantity,defectQuantity=input.defectQuantity??0;
    assert(Number.isSafeInteger(quantity)&&quantity>=0&&Number.isSafeInteger(defectQuantity)&&defectQuantity>=0&&Number.isSafeInteger(quantity+defectQuantity)&&quantity+defectQuantity>0,422,'INVALID_REPORT_QUANTITY','请填写实际数量，合计必须大于0；无效任务请在后台作废。');
    assert(assignment.isQualityInspection||defectQuantity===0,422,'NOT_QUALITY_PROCESS','这笔任务按普通人员报工，不能填写不良数。');
    assert(input.defectCodes===undefined||Array.isArray(input.defectCodes),422,'INVALID_DEFECT_REASON','不良原因参数不正确。');
    const codes=[...new Set(input.defectCodes||[])];
    if(defectQuantity>0)assert(codes.length>0&&codes.length<=defectQuantity&&codes.every(c=>this.reasons.some(r=>r.code===c)),422,'DEFECT_REASON_REQUIRED','请选择有效的不良原因，原因数不能多于不良件数。');
    const defectCodes=defectQuantity?codes:[];
    // Persisted receipt is scoped to the authenticated actor and immutable request.
    const receipt=this.recovery.transact(operationId,actor,'confirm-quantity:'+id,input,()=>{
      const row=this.recovery.raw(id);
      assert(!this.store.orderRemoved(row.project_id),409,'WORK_ORDER_DELETED','黑湖已删除这张工单，不能补报数量，原工时仍保留。');
      assert(input.expectedVersion===this.recovery.version(row),409,'RECOVERY_VERSION_CHANGED','任务状态已变化，请刷新后核对。');
      assert(row.status==='QUANTITY_PENDING'&&!row.report_id&&row.ended_at&&row.started_at,409,'QUANTITY_NOT_PENDING','只能处理尚未报量的完工待核量任务；结果未知时请先核对黑湖。');
      const before=this.recovery.present(row),key='quantity_'+randomUUID().replaceAll('-','');
      const report={id:randomUUID(),idempotencyKey:key,requestHash:stableHash({assignmentId:id,quantity,defectQuantity,defectCodes}),operatorId:row.operator_id,taskId:row.task_id,projectId:row.project_id,projectCode:row.project_code,productName:row.product_name,processName:row.process_name,amount:quantity+defectQuantity,goodAmount:quantity,defectAmount:defectQuantity,defectCode:defectCodes.join(','),outputTime:row.ended_at};
      this.store.insertPendingReport(report);
      this.db.prepare('UPDATE assignments SET quality_inspection=COALESCE(quality_inspection,?) WHERE id=?').run(assignment.isQualityInspection?1:0,id);
      this.db.prepare("UPDATE assignments SET status='REPORTING',quantity=?,good_quantity=?,defect_quantity=?,defect_code=?,report_id=?,quantity_policy='PENDING_REVIEW',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(report.amount,quantity,defectQuantity,report.defectCode,report.id,id);
      this.recovery.event({row,action:'SUBMIT_PENDING_QUANTITY',actor,reason,before,after:this.recovery.present(this.recovery.raw(id))});
      return {assignment:this.detail(id).assignment,action:'SUBMIT_PENDING_QUANTITY',reportKey:key};
    });
    if(receipt.replayed)return this.currentReceipt(receipt);
    const row=this.recovery.raw(id),operator={id:row.operator_id,name:row.operator_name,blacklakeOperatorId:row.blacklake_operator_id};
    let outcome,error;
    try {
      // Fresh ownership/state check, then the existing Blacklake writer owns its own timeout.
      const task=await this.blacklake.findTaskById(row.task_id,{fresh:true});
      assert(task&&Number(task.taskId)===row.task_id&&Number(task.projectId)===row.project_id,409,'QUANTITY_TASK_CHANGED','黑湖工序归属无法确认，请后台核实。');
      assert(task.processStatus!=null&&String(task.processStatus).trim()!==''&&Number.isFinite(Number(task.processStatus)),503,'QUANTITY_TASK_STATE_UNKNOWN','暂时无法核实黑湖工序状态，待核量记录已保留。');
      assert(Number(task.processStatus)!==20&&!/已完成|已关闭|已取消|已作废/.test(String(task.processStatusDisplay||'')),409,'TASK_CLOSED','黑湖工序已关闭，请核实后作废无效记录或在黑湖恢复工序。');
      // No async gap remains before deciding a write may have reached Blacklake.
      outcome='UNKNOWN';
      const result=await this.blacklake.createOutput({reportId:row.report_id,operator,task:{taskId:row.task_id,projectId:row.project_id,projectCode:row.project_code},amount:quantity+defectQuantity,defectAmount:defectQuantity,defectCodes,defectCode:defectCodes[0]||'',outputTime:row.ended_at,actualStartedAt:row.started_at,actualEndedAt:row.ended_at});
      assertNewOutputLink(this.db,row.report_id,result?.id);
      outcome='SUCCEEDED';receipt.outputId=result.id;
    } catch(e) {
      error=e;
      if(outcome!=='UNKNOWN'||e.definiteFailure===true||['BLACKLAKE_REJECTED','TASK_CLOSED','WORK_ORDER_NOT_FOUND','BLACKLAKE_WORK_ORDER_NOT_FOUND'].includes(e.code))outcome='FAILED';
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const report=this.store.reportByKey(receipt.reportKey);
      assert(report?.status==='PENDING'&&this.recovery.raw(id).status==='REPORTING',409,'QUANTITY_SUBMISSION_CHANGED','提交状态已变化，请刷新核对。');
      if(outcome==='SUCCEEDED'){this.store.markReportSucceeded(receipt.reportKey,receipt.outputId);this.store.completeAssignment(id);}
      else if(outcome==='FAILED'){
        this.store.markReportFailed(receipt.reportKey,error.code||'QUANTITY_SUBMIT_FAILED',error.message||'报量未成功');
        this.db.prepare("UPDATE assignments SET status='QUANTITY_PENDING',report_id=NULL,attempt_number=attempt_number+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      }else{this.store.markReportUnknown(receipt.reportKey,'QUANTITY_RESULT_UNKNOWN','补量结果待核对，请先查询黑湖，不要重复提交。');this.store.reviewAssignment(id);}
      const final={assignment:this.detail(id).assignment,action:'CONFIRM_PENDING_QUANTITY',reportStatus:outcome,...(error?{error:{code:outcome==='UNKNOWN'?'REPORT_RESULT_UNKNOWN':error.code||'QUANTITY_SUBMIT_FAILED',message:outcome==='UNKNOWN'?'报工已保留，黑湖结果尚未确认，请勿重复提交。':'本次未完成报量，待核量记录保留；请核实黑湖工序后重试或作废。'}}:{})};
      this.recovery.event({row,action:outcome==='SUCCEEDED'?'CONFIRM_PENDING_QUANTITY':outcome==='FAILED'?'QUANTITY_SUBMIT_FAILED':'QUANTITY_RESULT_UNKNOWN',actor,reason,before:receipt.assignment,after:final.assignment});
      this.db.prepare('UPDATE task_recovery_operations SET response_json=? WHERE actor=? AND operation_id=?').run(JSON.stringify(final),actor,operationId);
      this.db.exec('COMMIT');return final;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  currentReceipt(receipt) {
    if(receipt.action==='SUBMIT_PENDING_QUANTITY')return {assignment:this.detail(receipt.assignment.id).assignment,action:'CONFIRM_PENDING_QUANTITY',replayed:true,reportStatus:this.store.reportByKey(receipt.reportKey)?.status||'UNKNOWN'};
    return receipt;
  }
}
