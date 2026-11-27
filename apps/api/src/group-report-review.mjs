import {createHash} from 'node:crypto';
import {assert} from './errors.mjs';
import {liReportGroupId, requiresManualReportQuantity} from './people-groups.mjs';
import {distributeDefects} from './blacklake-client.mjs';
import {reportProduction} from './report-production.mjs';

export const groupApprovalPending = 'GROUP_APPROVAL_PENDING';

export function canReviewGroupReport(store, groups, groupId, leaderId) {
  return store.entryProfile(leaderId).appRole === 'floor8_leader'
    && store.db.prepare('SELECT active FROM operators WHERE blacklake_operator_id=?').get(leaderId)?.active === 1
    && groups.some(group => group.id === groupId && group.leaderIds?.includes(leaderId));
}

export class GroupReportReview {
  constructor({store, getGroups, outbox, manualReports, defectReasons}) {
    Object.assign(this, {store, getGroups, outbox, manualReports, defectReasons});
    this.db = store.db;
  }

  save(report, assignment, operator) {
    this.store.rememberReportSubmitter(report.id, operator);
    this.hold(report.id);
    this.store.completeAssignment(assignment.id);
  }

  requiresApproval(personId) {
    return requiresManualReportQuantity(this.getGroups(), personId);
  }

  hold(reportId) {
    this.db.prepare('INSERT INTO report_group_reviews(report_id,group_id) VALUES (?,?)').run(reportId, liReportGroupId);
    this.db.prepare('UPDATE reports SET status=? WHERE id=?').run(groupApprovalPending, reportId);
  }

  find(reportId) {
    return this.db.prepare('SELECT * FROM report_group_reviews WHERE report_id=?').get(reportId);
  }

  canReview(review, leaderId) {
    return canReviewGroupReport(this.store, this.getGroups(), review.group_id, leaderId);
  }

  read(orderId, processId, reportId, leaderId) {
    const review = this.find(reportId), report = this.store.reportById(reportId);
    const assignment = this.db.prepare('SELECT id FROM assignments WHERE report_id=?').get(reportId);
    assert(review && assignment && report.project_id === orderId && report.task_id === processId,
      404, 'REPORT_NOT_FOUND', '报工与当前工单和工序不一致。');
    assert(this.canReview(review, leaderId), 403, 'GROUP_REPORT_REVIEW_FORBIDDEN', '仅本小组负责组长可核对这笔报工。');
    const person = this.db.prepare('SELECT * FROM operators WHERE id=?').get(report.operator_id);
    const codes = String(report.defect_code || '').split(',').filter(Boolean);
    const allocation = this.db.prepare('SELECT items_json FROM report_defect_allocations WHERE report_id=?').get(report.id);
    const items = allocation ? JSON.parse(allocation.items_json) : distributeDefects(report.defect_amount, codes);
    return {review, report, assignment: this.store.assignmentById(assignment.id), person, codes, items};
  }

  version({report, review}) {
    return createHash('sha256').update(JSON.stringify([report.id, review.revision])).digest('hex');
  }

  editor(orderId, processId, reportId, leaderId) {
    const row = this.read(orderId, processId, reportId, leaderId);
    const {report, assignment, person, codes, items} = row;
    assert(report.status === groupApprovalPending, 409, 'REPORT_VERSION_CHANGED', '这笔报工已审批，请刷新报表。');
    return {
      orderId, processId, permission: 'all-process-reports', canEdit: true, canDelete: false,
      assignment: {id: assignment.id, orderId, processId, processName: assignment.processName,
        workerId: String(person.blacklake_operator_id), workerName: person.name, segments: []},
      report: {id: reportId, operatorId: person.blacklake_operator_id, operatorName: person.name,
        startedAt: assignment.startedAt, endedAt: assignment.endedAt, durationSeconds: assignment.durationSeconds,
        goodQuantity: report.good_amount, defectQuantity: report.defect_amount, defectCodes: codes, defectItems: items,
        defectReasons: this.defectReasons, isQualityInspection: assignment.isQualityInspection || assignment.assignmentMode === 'MANUAL_REPORT',
        quantityOnly: true, canEdit: true, canDelete: false, version: this.version(row)},
      people: [{operatorId: person.blacklake_operator_id, name: person.name}]
    };
  }

  edit(orderId, processId, reportId, action, input, leaderId) {
    assert(action === 'edit', 409, 'GROUP_REPORT_QUANTITY_ONLY', '待审批报工可更正数量。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.read(orderId, processId, reportId, leaderId);
      assert(row.report.status === groupApprovalPending && input?.expectedVersion === this.version(row),
        409, 'REPORT_VERSION_CHANGED', '报工已修改或审批，请刷新后核对。');
      assert(Object.keys(input).every(key => ['expectedVersion','goodQuantity','defectQuantity','defectCodes','defectItems'].includes(key)),
        422, 'GROUP_REPORT_QUANTITY_ONLY', '请在报表中重新打开待审批报工的数量编辑。');
      const {goodQuantity: good, defectQuantity: bad, defectItems: items} = input;
      assert([good, bad, good + bad].every(Number.isSafeInteger) && good >= 0 && bad >= 0 && good + bad > 0,
        422, 'INVALID_REPORT_QUANTITY', '合格数和不良数须为非负整数，合计大于0。');
      assert(row.assignment.isQualityInspection || row.assignment.assignmentMode === 'MANUAL_REPORT' || bad === 0,
        422, 'NOT_QUALITY_PROCESS', '普通报工只填写良品数量。');
      assert(Array.isArray(items) && new Set(items.map(item => item?.code)).size === items.length
        && items.every(item => item && this.defectReasons.some(reason => reason.code === item.code)
          && Number.isSafeInteger(item.amount) && item.amount > 0)
        && items.reduce((sum, item) => sum + item.amount, 0) === bad,
        422, 'INVALID_DEFECT_ALLOCATION', '请核对不良品项，合计须等于不良数。');
      const codes = items.map(item => item.code).join(',');
      const values = [good + bad, good, bad, codes];
      this.db.prepare('UPDATE reports SET amount=?,good_amount=?,defect_amount=?,defect_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(...values, reportId);
      this.db.prepare('UPDATE assignments SET quantity=?,good_quantity=?,defect_quantity=?,defect_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(...values, row.assignment.id);
      this.db.prepare(`INSERT INTO report_defect_allocations(report_id,items_json) VALUES (?,?)
        ON CONFLICT(report_id) DO UPDATE SET items_json=excluded.items_json`).run(reportId, JSON.stringify(items));
      if (row.assignment.assignmentMode === 'MANUAL_REPORT') {
        const production = reportProduction(this.store, reportId);
        this.manualReports().saveProduction(reportId, {...production, defectItems: items});
      }
      this.db.prepare('UPDATE report_group_reviews SET revision=revision+1 WHERE report_id=?').run(reportId);
      this.audit(row.assignment.id, 'LEADER_EDIT_GROUP_REPORT', leaderId, JSON.stringify({
        before: {good: row.report.good_amount, bad: row.report.defect_amount, items: row.items}, after: {good, bad, items}
      }));
      this.db.exec('COMMIT');
      return {status: 'SUCCEEDED', accepted: true, queued: false};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  approve(orderId, processId, reportId, input, operationId, leaderId) {
    assert(this.outbox, 503, 'SYNC_NOT_ENABLED', '后台同步暂不可用，报工仍待审批。');
    assert(input?.approved === true && input.expectedStatus === 0 && Number.isSafeInteger(input.expectedApprovalRevision)
      && /^[A-Za-z0-9_-]{16,120}$/.test(operationId), 422, 'REPORT_APPROVAL_INPUT', '请刷新并核对本笔报工后审批。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {review, report, assignment, person, items} = this.read(orderId, processId, reportId, leaderId);
      if (review.approved_by === leaderId && review.approval_operation === operationId && review.revision === input.expectedApprovalRevision) {
        const sync = this.outbox.reportSync(reportId);
        this.db.exec('COMMIT');
        return {accepted: true, status: 'SUCCEEDED', sync, replayed: true};
      }
      assert(report.status === groupApprovalPending && !review.approved_at && review.revision === input.expectedApprovalRevision,
        409, 'REPORT_APPROVAL_CHANGED', '数量或审批状态已变化，请刷新后核对。');
      this.db.prepare('UPDATE report_group_reviews SET approved_by=?,approved_at=CURRENT_TIMESTAMP,approval_operation=? WHERE report_id=?')
        .run(leaderId, operationId, reportId);
      this.db.prepare("UPDATE reports SET status='PENDING',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reportId);
      const job = assignment.assignmentMode === 'MANUAL_REPORT'
        ? this.manualReports().enqueueCreation(report, assignment, leaderId, 10)
        : this.outbox.enqueueCreate({
          report: {id: reportId, idempotencyKey: report.idempotency_key, amount: report.amount,
            defectAmount: report.defect_amount, defectCode: report.defect_code, defectItems: items},
          assignment, operator: {id: person.id, blacklakeOperatorId: person.blacklake_operator_id, name: person.name},
          endedAt: assignment.endedAt, approveStatus: 10
        });
      this.audit(assignment.id, 'LEADER_APPROVE_GROUP_REPORT', leaderId, '审批通过并交由后台提交黑湖');
      this.db.exec('COMMIT');
      return this.outbox.receipt(job);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit(assignmentId, action, leaderId, reason) {
    this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES (?,?,?,?)')
      .run(assignmentId, action, reason, 'floor8_leader:' + leaderId);
  }
}
