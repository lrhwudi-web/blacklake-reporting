import { randomUUID } from "node:crypto";
import { PeopleGroups, requiresManualReportQuantity, validatePeopleGroups } from "./people-groups.mjs";
import { readFile } from "node:fs/promises";
import { AppError, assert, publicError } from "./errors.mjs";
import { newConfirmationCode, safeEqualText, stableHash } from "./crypto.mjs";
import { recommendEmployeeProcess } from "./process-inference.mjs";
import { predictDispatch, predictProcessForEmployees } from "./dispatch-prediction.mjs";
import { cuttingWorkUnits, employeeWorkUnits, isCuttingProcess } from "./cutting-self-work.mjs";
import { effectiveWorkSecondsBetween } from "./work-time.mjs";
import { evaluateProductionAnomalies, summarizeProductionAnomalies } from "./anomaly-rules.mjs";
import { reportedTaskAmount } from "./quality.mjs";
import { AdminSync } from "./admin-sync.mjs";
import { createHomepageAgent, agentOwner } from "./homepage-agent.mjs";
import { workerRouting, workerReportingProfile } from "./worker-type.mjs";
import { createProductionInsights } from "./production-insights.mjs";
import { createTaskRecoveryHandler, createDispatchedStartCheck } from "./task-recovery.mjs";
import { QuantityResolution } from "./quantity-resolution.mjs";
import { createManagementHandler } from "./management.mjs";
import { stationDetail } from "./station-detail.mjs";
import { employeeDailySummary } from "./employee-daily-summary.mjs";
import {LeaderReports} from './leader-reports.mjs';
import {ReportOutbox} from './report-outbox.mjs';
import {ManualReports} from './manual-reports.mjs';
import {ReportApprovals} from './report-approvals.mjs';
import {GroupReportReview,groupApprovalPending} from './group-report-review.mjs';
import {OrderProcessEdits} from './order-process-edits.mjs';
import {assertNewOutputLink} from './report-create-receipt.mjs';
import {UpstreamReports} from './upstream-reports.mjs';
import {LeaderClockout} from './leader-clockout.mjs';
import {Workspace,canOperateOrdersFromEmployeeView} from './workspace.mjs';
import {WorkspaceReports} from './workspace-reports.mjs';
import { withLocalMembers } from "./local-members.mjs";
import { processProgress } from "./process-progress.mjs";
import {
  EMBROIDERY_PARTS,
  BOUND_EMBROIDERY_ASSIGNMENT,
  REPORTING_MODES,
  isEmbroideryDepartment,
  isEmbroideryProcessName,
  reportingProfile,
  normalizeEmbroideryMachineCode,
  normalizeEmbroideryPart
} from "./embroidery.mjs";
import { APP_ROLES, assertDispatcher, publicEntryProfile } from "./entry-profile.mjs";
import { FLOOR3_MACHINE_IDS, FLOOR8_UNIT_IDS, normalizeDispatchUnit, resolveEmployeePlacements, unitState, unitsForRole } from "./dispatch.mjs";

const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";
const ADMIN_ASSETS = new Map([
  ["/admin/local-members.js", [new URL("../../admin/local-members.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/local-members.css", [new URL("../../admin/local-members.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/management.js", [new URL("../../admin/management.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/management.css", [new URL("../../admin/management.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin", [new URL("../../admin/index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/admin/", [new URL("../../admin/index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/admin/app.js", [new URL("../../admin/app.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/task-recovery.js", [new URL("../../admin/task-recovery.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/task-recovery.css", [new URL("../../admin/task-recovery.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/data-sync.js", [new URL("../../admin/data-sync.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/data-sync.css", [new URL("../../admin/data-sync.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/agent-chat.js", [new URL("../../admin/agent-chat.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/weekly-report.js", [new URL("../../admin/weekly-report.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/dispatch-feedback.js", [new URL("../../admin/dispatch-feedback.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/dispatch-feedback.css", [new URL("../../admin/dispatch-feedback.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/production-insights.css", [new URL("../../admin/production-insights.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/styles.css", [new URL("../../admin/styles.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/people-groups.js", [new URL("../../admin/people-groups.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/admin/people-groups.css", [new URL("../../admin/people-groups.css", import.meta.url), "text/css; charset=utf-8"]],
  ["/admin/assets/embroidery-machine-list.0390558efd.webp", [new URL("../../admin/assets/embroidery-machine-list.0390558efd.webp", import.meta.url), "image/webp", IMMUTABLE_ASSET_CACHE]],
  ["/admin/assets/embroidery-machine-detail.c8f650b45a.webp", [new URL("../../admin/assets/embroidery-machine-detail.c8f650b45a.webp", import.meta.url), "image/webp", IMMUTABLE_ASSET_CACHE]]
]);
// Explicit allowlist: no directory traversal, server files or node_modules exposure.
for (const name of ["index.html", "app.js", "data.js", "scene-models.js", "floor-models.js", "scene-details.js", "style.css", "polish.css", "vendor/three.module.js", "vendor/three.core.js", "vendor/OrbitControls.js", "vendor/RoundedBoxGeometry.js", "vendor/LICENSE"]) {
  ADMIN_ASSETS.set(`/admin/production-3d/${name}`, [new URL(`../../admin/production-3d/${name}`, import.meta.url), name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8"]);
}
ADMIN_ASSETS.set("/admin/production-3d/", ADMIN_ASSETS.get("/admin/production-3d/index.html"));
ADMIN_ASSETS.set("/admin/theme.css", [new URL("../../admin/theme.css", import.meta.url), "text/css; charset=utf-8"]);

export function createApp({ config, store, blacklake, wechat, processInferenceRules, dispatchPredictionRules, defectReasons = [], adminSync = new AdminSync(blacklake), agentRunner, insightRunner, weeklyCollector, now, dataSync }) {
  const memberUpstream=blacklake;
  blacklake=withLocalMembers(store,blacklake);
  const readBlacklake=dataSync?withLocalMembers(store,dataSync.readClient()):blacklake;
  if(dataSync)adminSync=new AdminSync(readBlacklake,{now:now||Date.now});
  let reportOutbox;
  let peopleGroupsStore;
  const peopleGroups = () => peopleGroupsStore ||= new PeopleGroups(store.db);
  const manualQuantityFor = (session) => session.scope !== "review"
    && requiresManualReportQuantity(peopleGroups().read().groups, session.blacklakeOperatorId);
  let recoveryHandler;
  let managementHandler;
  let quantityService;
  const quantities = () => quantityService ||= new QuantityResolution({store,blacklake,defectReasons,now});
  let leaderReportsService;
  let clockoutService;
  const clockout=()=>clockoutService ||= new LeaderClockout({store,now});
  const leaderReports=()=>leaderReportsService ||= new LeaderReports({store,blacklake,readBlacklake,queueStatus:id=>reportOutbox?.pending(id),defectReasons,now,onChanged:change=>{if(dataSync)dataSync.invalidateOrder(change.projectId,change);else{adminSync.output={};adminSync.routes?.clear();}},
    onQuantityReduced:change=>reportOutbox?.enqueueReopen(change),
    getPeopleGroupConfig:people=>{
      const config=peopleGroups().read(people.map(p=>({...p,departments:p.departments||p.groupNames||[]}))),allowed=new Set(people.map(p=>p.blacklakeOperatorId));
      return {revision:config.revision,allPosition:config.allPosition,groups:config.groups.map(({id,name,blacklakeOperatorIds})=>({id,name,operatorIds:blacklakeOperatorIds.filter(id=>allowed.has(id))}))};
    },
    listPeople:async({unitIds,scope})=>scope==='all-process-reports'?(await readBlacklake.listOperators()).filter(p=>['employee','floor8_leader'].includes(store.entryProfile(p.blacklakeOperatorId).appRole)):unitIds.some(id=>id.startsWith('A-'))?listDispatchEmployees():(await readBlacklake.listOperators()).filter(p=>store.entryProfile(p.blacklakeOperatorId).appRole==='employee'&&store.dispatchUnitRecommendations().some(b=>b.blacklakeOperatorId===p.blacklakeOperatorId&&unitIds.includes(b.unitId)))});
  let upstreamReportsService;
  const upstreamReports=()=>upstreamReportsService ||= new UpstreamReports({store,sync:dataSync,blacklake,now:now||Date.now,defectReasons,
    listPeople:async()=>(await readBlacklake.listOperators()).filter(p=>['employee','floor8_leader'].includes(store.entryProfile(p.blacklakeOperatorId).appRole)),
    getPeopleGroups:people=>{const config=peopleGroups().read(people);return {...config,groups:config.groups.map(({id,name,blacklakeOperatorIds})=>({id,name,operatorIds:blacklakeOperatorIds}))};},
    onQuantityReduced:change=>reportOutbox?.enqueueReopen(change)});
  let manualReportsService;
  const manualReports=()=>manualReportsService ||= new ManualReports({store,sync:dataSync,blacklake,leaderReports,
    groupReview:groupReportReview,now:now||Date.now,defectReasons});
  const approvals=dataSync?new ReportApprovals({store,sync:dataSync,blacklake,authorize:id=>upstreamReports().authorize(id)}):null;
  const processEdits=dataSync?new OrderProcessEdits({store,sync:dataSync,blacklake,now:now||Date.now}):null;
  if(dataSync)reportOutbox=new ReportOutbox({store,sync:dataSync,blacklake,leaderReports,upstreamReports,manualReports,approvals,now:now||Date.now,allowNext:config.dataSync?.allowNext!==false});
  const groupReportReview=new GroupReportReview({store,getGroups:()=>peopleGroups().read().groups,
    outbox:reportOutbox,manualReports,defectReasons});
  const checkDispatchedStart = createDispatchedStartCheck(blacklake, {now});
  let workspaceService;
  let workspaceReportsService;
  const workspaceReports=()=>workspaceReportsService ||= new WorkspaceReports({store,workspace:workspace(),sync:dataSync,getPeopleGroups:people=>peopleGroups().read(people),defectReasons,now:now||Date.now});
  const workspace=()=>workspaceService ||= new Workspace({store,blacklake,listPeople:listDispatchEmployees,getPeopleGroups:people=>peopleGroups().read(people),profile:entryProfile,routing:workerRoutingFor,embroideryAllowed:operator=>operatorReportingProfile(operator).reportingModes.includes(REPORTING_MODES.EMBROIDERY),defectReasons,now:now||Date.now,leaderReports,dataSync,reportOutbox,groupReportReview,manualReports,upstreamReports:dataSync?upstreamReports:null,clockoutService:clockout()});
  const insights = createProductionInsights({ config, store, blacklake:readBlacklake, runner: insightRunner, collect: weeklyCollector, now });
  const homepageAgent = createHomepageAgent({ config, store, blacklake:readBlacklake, adminSync, runner: agentRunner, weeklyStore: insights.records });
  const availableDefectReasons = defectReasons.map(({ code, name }) => ({ code, name }));
  const defectReasonByCode = new Map(availableDefectReasons.map((reason) => [reason.code, reason]));
  const presentAssignment = (assignment) => ({...publicAssignment(assignment, defectReasonByCode),...(reportOutbox&&assignment.reportId?{reportSync:reportOutbox.reportSync(assignment.reportId)}:{})});
  const reportingPermissionOverride = (operator) => store.reportingModeSwitchPermission(operator?.blacklakeOperatorId);
  const workerRoutingFor = (operator) => workerRouting(operator,store.entryProfile(operator?.blacklakeOperatorId),store.workerTypeProfile(operator?.blacklakeOperatorId),config.floor8EmployeeIds||[]);
  const operatorReportingProfile = (operator) => workerReportingProfile(operator,store.entryProfile(operator?.blacklakeOperatorId),store.workerTypeProfile(operator?.blacklakeOperatorId),config,reportingPermissionOverride(operator));
  const entryProfile = (operator) => publicEntryProfile(store.entryProfile(operator?.blacklakeOperatorId));
  const selfServiceEnabled = (operator) => operator?.scope !== 'review' && entryProfile(operator).appRole === APP_ROLES.EMPLOYEE
    && store.selfServicePermission(operator.blacklakeOperatorId).enabled;
  const cuttingUnits = (operator) => selfServiceEnabled(operator)?employeeWorkUnits(store,operator.blacklakeOperatorId):[];
  const assertCuttingWorker = (operator) => {
    assert(selfServiceEnabled(operator),403,'SELF_SERVICE_NOT_ALLOWED','当前人员仅接派工，请联系管理员在后台开启自主报工。');
    return cuttingUnits(operator);
  };
  const presentOperator = (operator) => {const member=store.members.byKey(operator.blacklakeOperatorId);return {name:operator.name,...operatorReportingProfile(operator),...(member?{identitySource:'LOCAL',memberCode:member.memberCode,submissionIdentity:{actualOperatorId:member.id,actualName:member.name,submitAsId:member.submitAsId,submitAsName:member.submitAsName}}:{})};};
  const eligibleFloor8Operator = (operator) => {
    return workerRoutingFor(operator).canReceiveFloor8Assignments;
  };
  const listDispatchEmployees = async () => {
    const bindings = store.dispatchUnitRecommendations();
    const operators = await readBlacklake.listOperators();
    const normalized = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    const employees = operators.filter(eligibleFloor8Operator).map((operator) => ({
      blacklakeOperatorId: operator.blacklakeOperatorId, name: operator.name,
      departments: Array.isArray(operator.groupNames) ? operator.groupNames : [],
      ...(operator.identitySource==='LOCAL'?{identitySource:'LOCAL',personId:operator.personId,memberCode:operator.memberCode,blacklakeSourceId:null}:{}),
      description: Array.isArray(operator.groupNames) ? operator.groupNames.join("、") : "",
      identityAmbiguous: operators.filter((row) => normalized(row.name) === normalized(operator.name)).length !== 1,
      boundUnitIds: bindings.filter((row) => row.blacklakeOperatorId === operator.blacklakeOperatorId && FLOOR8_UNIT_IDS.includes(row.unitId)).map((row) => row.unitId),
      ...store.dispatchQueueState(operator.blacklakeOperatorId)
    }));
    return peopleGroups().apply(employees);
  };
  const presentAdminOperator = (operator, status = {}) => {
    const override = reportingPermissionOverride(operator);
    const profile = operatorReportingProfile(operator);
    const department = Array.isArray(operator.groupNames) && operator.groupNames.length
      ? operator.groupNames.join("、")
      : "未设置";
    return {
      blacklakeOperatorId: operator.blacklakeOperatorId,
      ...(operator.identitySource==='LOCAL'?{identitySource:'LOCAL',personId:operator.personId,memberCode:operator.memberCode,blacklakeSourceId:null,submitAsId:operator.submitAsId,submitAsName:operator.submitAsName}:{}),
      name: operator.name,
      description: department,
      defaultReportingMode: profile.defaultReportingMode,
      canSwitchReportingMode: profile.reportingModes.length > 1,
      ...store.qualityProfile(operator.blacklakeOperatorId),
      selfServiceEnabled: store.selfServicePermission(operator.blacklakeOperatorId).enabled,
      selfServiceRevision: store.selfServicePermission(operator.blacklakeOperatorId).revision,
      ...workerRoutingFor(operator),
      permissionSource: typeof override === "boolean"
        ? "manual"
        : isEmbroideryDepartment(operator.groupNames)
          ? "department"
          : config.reportingModeAdminOperatorIds.includes(Number(operator.blacklakeOperatorId))
            ? "config"
            : "default",
      ...entryProfile(operator),
      bound: Boolean(status.boundAt),
      boundAt: status.boundAt || null
    };
  };

  if(dataSync){
    const service=workspace(),reportRecovered=dataSync.onRecovered,reportError=dataSync.onWriteError;
    dataSync.orderWrites={execute:job=>service.executeOrderWrite(job),schedule:()=>service.scheduleOrderReviews()};
    dataSync.onRecovered=job=>job.kind==='order-operation-write'?service.recoverOrderWrite(job):reportRecovered(job);
    dataSync.onWriteError=(job,error,state)=>job.kind==='order-operation-write'?service.recoverOrderWrite({...job,state}):reportError(job,error,state);
    reportOutbox.recover();
  }
  return async function handler(req, res) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      res.setHeader("X-Request-Id", requestId);
      res.setHeader("Cache-Control", "no-store");

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, mode: config.blacklake.mode });
      }

      if (req.method === "GET" && ADMIN_ASSETS.has(url.pathname)) {
        const [file, contentType, cacheControl] = ADMIN_ASSETS.get(url.pathname);
        return sendAsset(res, await readFile(file), contentType, cacheControl);
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/wechat") {
        const input = await jsonBody(req);
        const subject = await wechat.exchangeCode(input.code);
        let operator = store.operatorByWechatSubject(subject);
        if (operator) {
          try {
            const current = (await blacklake.listOperators())
              .find((item) => item.blacklakeOperatorId === operator.blacklakeOperatorId);
            if (current) operator = store.upsertBlacklakeOperator(current);
          } catch (error) {
            console.warn(JSON.stringify({
              event: "operator_department_refresh_failed",
              blacklakeOperatorId: operator.blacklakeOperatorId,
              code: error.code || "BLACKLAKE_QUERY_FAILED"
            }));
          }
          const session = store.createSession(operator.id);
          return send(res, 200, {
            status: "BOUND",
            token: session.token,
            expiresAt: session.expiresAt,
            operator: presentOperator(operator),
            entry: entryProfile(operator)
          });
        }
        const challenge = store.createWechatBindingChallenge(subject);
        return send(res, 200, {
          status: "UNBOUND",
          bindingToken: challenge.token,
          expiresAt: challenge.expiresAt,
          reviewAvailable: Boolean(config.review?.enabled)
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/review") {
        assert(config.review?.enabled, 404, "REVIEW_MODE_DISABLED", "审核体验当前未开放。");
        const input = await jsonBody(req);
        const bindingToken = String(input.bindingToken || "");
        assert(store.bindingChallenge(bindingToken), 401, "BINDING_EXPIRED", "审核登录已过期，请重新打开小程序。");
        const accessCode = String(input.accessCode || "").trim();
        if (!safeEqualText(accessCode, config.review.accessCode)) {
          const challenge = store.recordBindingChallengeFailure(bindingToken);
          assert(challenge, 429, "TOO_MANY_REVIEW_ATTEMPTS", "审核码错误次数过多，请重新打开小程序。");
          throw new AppError(422, "REVIEW_CODE_INVALID", "审核码不正确，请查看提审备注。");
        }

        const blacklakeOperators = await blacklake.listOperators();
        const blacklakeOperator = blacklakeOperators.find((item) =>
          item.blacklakeOperatorId === config.review.operatorId
        );
        assert(blacklakeOperator, 503, "REVIEW_OPERATOR_NOT_FOUND", "审核测试人员不在黑湖人员名单中，请联系开发者。");
        const operator = store.upsertBlacklakeOperator(blacklakeOperator);
        const activeAssignment = store.currentAssignment(operator.id);
        if (activeAssignment) assertReviewProject({ scope: "review" }, activeAssignment, config);
        assert(store.consumeBindingChallenge(bindingToken), 401, "BINDING_EXPIRED", "审核登录已过期，请重新打开小程序。");
        const session = store.createSession(operator.id, {
          scope: "review",
          ttlHours: config.review.sessionHours
        });
        return send(res, 200, {
          status: "BOUND",
          token: session.token,
          expiresAt: session.expiresAt,
          operator: { name: "审核体验" },
          entry: publicEntryProfile(),
          reviewMode: true
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/operators") {
        const input = await jsonBody(req);
        assert(store.bindingChallenge(String(input.bindingToken || "")), 401, "BINDING_EXPIRED", "首次绑定已过期，请重新打开小程序。");
        const operators = await blacklake.listOperators();
        return send(res, 200, { operators: publicOperatorChoices(operators) });
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/bind") {
        const input = await jsonBody(req);
        const blacklakeOperatorId = Number(input.blacklakeOperatorId);
        const code = String(input.confirmationCode || "").trim();
        assert(Number.isSafeInteger(blacklakeOperatorId) && blacklakeOperatorId > 0, 422, "INVALID_OPERATOR", "请选择正确的姓名。");
        assert(/^\d{6}$/.test(code), 422, "INVALID_CONFIRMATION_CODE", "请输入班组长提供的 6 位确认码。");
        const blacklakeOperator = (await blacklake.listOperators())
          .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
        assert(blacklakeOperator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个人，请重新选择姓名。");
        store.upsertBlacklakeOperator(blacklakeOperator);
        const result = store.completeWechatBinding({
          challengeToken: String(input.bindingToken || ""),
          blacklakeOperatorId,
          code
        });
        if (result.status !== "BOUND") throw bindingError(result.status);
        const session = store.createSession(result.operator.id);
        return send(res, 200, {
          status: "BOUND",
          token: session.token,
          expiresAt: session.expiresAt,
          operator: presentOperator(result.operator),
          entry: entryProfile(result.operator)
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
        const token = bearer(req);
        if (token) store.deleteSession(token);
        return send(res, 204);
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        requireAdmin(req, config);
        if(req.method==='POST'&&url.pathname.startsWith('/v1/admin/data-sync/')){assert(req.headers['sec-fetch-site']!=='cross-site',403,'SYNC_ORIGIN_REJECTED','请从管理后台处理同步。');if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,'SYNC_ORIGIN_REJECTED','请从管理后台处理同步。');}}
        if(req.method==='GET'&&url.pathname==='/v1/admin/data-sync'){
          if(!dataSync)return send(res,200,{enabled:false});
          const offset=Number(url.searchParams.get('offset')||0),attention=url.searchParams.get('attention'),groups=dataSync.recovery.attentionGroups();
          const page=attention?dataSync.recovery.listAttention(attention,{offset,groups}):dataSync.jobs.list({state:url.searchParams.get('state')||undefined,limit:50,offset});
          return send(res,200,{enabled:true,...dataSync.status({attentionGroups:groups}),jobTotal:page.total,offset,jobs:page.jobs.map(job=>dataSync.publicJob(job))});
        }
        const syncDetailPath=url.pathname.match(/^\/v1\/admin\/data-sync\/jobs\/([^/]+)$/);
        if(req.method==='GET'&&syncDetailPath){assert(dataSync,409,'SYNC_NOT_ENABLED','共享同步尚未启用。');const job=dataSync.jobs.get(decodeURIComponent(syncDetailPath[1]));assert(job,404,'SYNC_JOB_NOT_FOUND','没有找到同步任务。');return send(res,200,{job:dataSync.publicJob(job),events:store.db.prepare('SELECT event,actor,created_at AS createdAt FROM integration_job_events WHERE job_id=? ORDER BY id DESC LIMIT 100').all(job.id)});}
        const syncJobPath=url.pathname.match(/^\/v1\/admin\/data-sync\/jobs\/([^/]+)\/(retry|reconcile|confirm-absent|cancel)$/);
        if(req.method==='POST'&&syncJobPath){assert(dataSync,409,'SYNC_NOT_ENABLED','共享同步尚未启用。');const input=await jsonBody(req),id=decodeURIComponent(syncJobPath[1]),job=dataSync.jobs.get(id),actor='ADMIN:'+agentOwner(req,config).slice(0,24);assert(job?.kind!=='order-operation-write',409,'ORDER_SYNC_REVIEW_IN_WORKSPACE','请打开对应工单刷新核对执行状态和优先级。');let result;if(job?.mode==='read'&&syncJobPath[2]==='retry'){assert(dataSync.jobVersion(job)===input.expectedVersion,409,'SYNC_JOB_CHANGED','同步状态已变化，请刷新。');result={job:dataSync.publicJob(dataSync.jobs.retry(id,actor,job))};}else result=await reportOutbox.adminAction(id,syncJobPath[2],input,actor);return send(res,200,result);}
        if(req.method==='POST'&&url.pathname==='/v1/admin/data-sync/refresh'){assert(dataSync,409,'SYNC_NOT_ENABLED','共享同步尚未启用。');const input=await jsonBody(req);assert(input&&!Array.isArray(input)&&Object.keys(input).every(key=>key==='projectId')&&Number.isSafeInteger(input.projectId)&&input.projectId>0,422,'INVALID_WORK_ORDER','请选择具体工单。');const job=dataSync.request('order',input.projectId,{projectId:input.projectId},true);return send(res,202,{job:dataSync.publicJob(job)});}
        const presencePath=req.method==='POST'&&url.pathname.match(/^\/v1\/admin\/data-sync\/orders\/(\d+)\/presence$/);
        if(presencePath){
          assert(dataSync,409,'SYNC_NOT_ENABLED','共享同步尚未启用。');const input=await jsonBody(req);
          assert(input&&!Array.isArray(input)&&Object.keys(input).length===0,422,'INVALID_WORK_ORDER','存在状态由系统向黑湖核对，不能手工指定。');
          return send(res,202,{job:dataSync.publicJob(dataSync.requestOrderPresence(Number(presencePath[1]),'ADMIN'))});
        }
        if(url.pathname==='/v1/admin/local-members'&&req.method==='GET'){
          const senders=(dataSync?dataSync.people():await memberUpstream.listOperators()).map(p=>({id:p.blacklakeOperatorId,name:p.name}));
          return send(res,200,{members:store.members.list({includeInactive:true}),submitters:senders});
        }
        const localMemberMatch=url.pathname.match(/^\/v1\/admin\/local-members\/(\d+)$/);
        if((url.pathname==='/v1/admin/local-members'&&req.method==='POST')||(localMemberMatch&&req.method==='PATCH')){
          assert(req.headers['sec-fetch-site']!=='cross-site',403,'LOCAL_MEMBER_ORIGIN','请从管理后台操作。');
          const member=await store.members.save(await jsonBody(req),{key:localMemberMatch?Number(localMemberMatch[1]):undefined,actor:`ADMIN:${agentOwner(req,config).slice(0,24)}`,upstream:memberUpstream});
          return send(res,localMemberMatch?200:201,{member});
        }
        if (url.pathname === '/v1/admin/management' || url.pathname.startsWith('/v1/admin/management/')) {
          managementHandler ||= createManagementHandler({store,blacklake,config,now});
          return await managementHandler(req,res,url,{jsonBody,send});
        }
        if (url.pathname === "/v1/admin/task-recovery" || url.pathname.startsWith("/v1/admin/task-recovery/")) {
          recoveryHandler ||= createTaskRecoveryHandler({store,config,now,quantities:quantities()});
          return await recoveryHandler(req,res,url,{jsonBody,send});
        }
        if (url.pathname.startsWith("/v1/admin/weekly-reports") || url.pathname.startsWith("/v1/admin/production-findings")) {
          return await insights.handle(req, res, url, { jsonBody, send });
        }
        if (url.pathname.startsWith("/v1/admin/agent/")) {
          return await homepageAgent(req, res, url, { jsonBody, send });
        }

        if (req.method === "GET" && url.pathname === "/v1/admin/production-scene") {
          const floor = (ids) => ids.map((id) => {
            const aliases = id.startsWith("3F-") ? [id, `MACHINE-${id.slice(-2)}`, id.slice(-2)] : [id];
            const assignments = [...new Map(aliases.flatMap((alias) => store.activeAssignmentsByUnit(alias)).map((a) => [a.id, a])).values()]
              .sort((a, b) => ["NEEDS_REVIEW", "REPORTING", "IN_PROGRESS", "READY"].indexOf(a.status) - ["NEEDS_REVIEW", "REPORTING", "IN_PROGRESS", "READY"].indexOf(b.status));
            return { id, state: unitState(assignments), assignments: assignments.map(presentAssignment) };
          });
          return send(res, 200, { updatedAt: new Date().toISOString(), floors: { "3": floor(FLOOR3_MACHINE_IDS), "8": floor(FLOOR8_UNIT_IDS) }, warehouse: { connected: false, layout: "schematic" } });
        }

        if (req.method === "POST" && url.pathname === "/v1/admin/tasks/search") {
          const input = await jsonBody(req);
          const projectCode = String(input.projectCode || "").trim();
          assert(projectCode && projectCode.length <= 100, 422, "INVALID_PROJECT_CODE", "请填写正确的黑湖工单号。");
          const tasks = await blacklake.listTasks({ projectCode });
          return send(res, 200, { tasks: tasks.map(publicTask) });
        }

        if (req.method === "GET" && url.pathname === "/v1/admin/assignments") {
          let localAssignments = evaluateProductionAnomalies(store.listAssignments(300), {
            now: new Date(),
            rules: config.anomalyRules
          });
          const outputSnapshot = await adminSync.outputs();
          const blacklakeOutputs = outputSnapshot.records;
          // Proxy submissions keep their true local owner even after aging out
          // of the latest-300 view. Match exact saved output IDs, never names.
          const linked=store.members.assignmentsForOutputs(blacklakeOutputs);
          if(linked.length){const map=new Map(localAssignments.map(a=>[a.id,a]));for(const a of evaluateProductionAnomalies(linked,{now:new Date(),rules:config.anomalyRules}))map.set(a.id,a);localAssignments=[...map.values()];}
          const warnings = [];
          if (outputSnapshot.sync.status === "stale") warnings.push("黑湖报工暂时无法同步，沿用上次成功记录。");
          if (outputSnapshot.sync.status === "unavailable") warnings.push("黑湖报工暂时无法同步，当前仅显示本地可取得的记录。");
          const projectKey = (item) => {
            const projectId = optionalPositiveInteger(item.projectId);
            if (projectId) return `project:${projectId}`;
            const projectCode = String(item.projectCode || "").trim();
            return projectCode ? `code:${projectCode}` : `task:${optionalPositiveInteger(item.taskId) || String(item.id || "unknown")}`;
          };
          const projectEntries = [...new Map([...localAssignments, ...blacklakeOutputs].map((item) => [
            projectKey(item),
            { projectId: optionalPositiveInteger(item.projectId), projectCode: String(item.projectCode || "") }
          ])).entries()];
          const projectRefs = projectEntries.map(([, project]) => project);
          const processSnapshots = await adminSync.processes(projectRefs);
          const retainedProjectKeys = new Set(localAssignments
            .filter((assignment) => ["IN_PROGRESS", "REPORTING", "NEEDS_REVIEW", "QUANTITY_PENDING"].includes(assignment.status))
            .map(projectKey));
          const confirmedMissingProjectKeys = new Set(projectEntries
            .filter(([key], index) => processSnapshots[index]?.sync.status === "empty" && !retainedProjectKeys.has(key))
            .map(([key]) => key));
          const visibleProjectEntries = projectEntries.filter(([key]) => !confirmedMissingProjectKeys.has(key));
          const visibleProjectRefs = visibleProjectEntries.map(([, project]) => project);
          const visibleProcessSnapshots = processSnapshots.filter((_, index) => !confirmedMissingProjectKeys.has(projectEntries[index][0]));
          const visibleLocalAssignments = localAssignments.filter((assignment) => !confirmedMissingProjectKeys.has(projectKey(assignment)));
          const visibleBlacklakeOutputs = blacklakeOutputs.filter((output) => !confirmedMissingProjectKeys.has(projectKey(output)));
          const projectTasks = visibleProcessSnapshots.flatMap((snapshot) => snapshot.tasks);
          const countSync = (status) => visibleProcessSnapshots.filter((snapshot) => snapshot.sync.status === status).length;
          if (countSync("stale")) warnings.push(`${countSync("stale")} 张工单工序暂时无法同步，沿用上次成功数据（时间见工单详情）。`);
          if (countSync("unavailable")) warnings.push(`${countSync("unavailable")} 张工单工序暂时无法同步，进度暂不可判定。`);
          if (countSync("empty")) warnings.push(`${countSync("empty")} 张工单查询未返回工序，尚不能确认其工艺完整性。`);
          const tasksById = new Map(projectTasks.map((task) => [task.taskId, task]));
          const localOutputIds = new Set(visibleLocalAssignments.map((assignment) => String(assignment.blacklakeOutputId || "")).filter(Boolean));
          const syncedAssignments = visibleBlacklakeOutputs
            .filter((output) => output.id !== undefined && !localOutputIds.has(String(output.id)))
            .map((output) => publicBlacklakeOutput(output, tasksById.get(Number(output.taskId))))
            .filter(Boolean);
          const assignments = [...visibleLocalAssignments.map(presentAssignment), ...syncedAssignments]
            .toSorted((left, right) => String(right.endedAt || right.startedAt || "").localeCompare(String(left.endedAt || left.startedAt || "")));
          return send(res, 200, {
            assignments,
            workOrders: publicAdminWorkOrders(visibleProjectRefs, projectTasks, visibleProcessSnapshots),
            syncWarning: warnings.join(" "),
            outputSync: outputSnapshot.sync,
            anomalySummary: summarizeProductionAnomalies(visibleLocalAssignments),
            anomalyRules: publicAnomalyRules(config.anomalyRules)
          });
        }

        if (req.method === "GET" && url.pathname === "/v1/admin/dispatch-predictions") {
          const outcome = String(url.searchParams.get("outcome") || "ALL");
          const query = String(url.searchParams.get("q") || "").trim();
          const limit = Number(url.searchParams.get("limit") || 30);
          const offset = Number(url.searchParams.get("offset") || 0);
          assert(["ALL", "ADOPTED", "ADJUSTED", "NO_SUGGESTION"].includes(outcome), 422, "INVALID_PREDICTION_FILTER", "预测记录筛选无效。");
          assert(query.length <= 100 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
            && Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000, 422, "INVALID_PREDICTION_QUERY", "预测记录查询参数无效。");
          return send(res, 200, store.predictions.listFeedback({ outcome, query, limit, offset }));
        }

        if (req.method === "GET" && url.pathname === "/v1/admin/audit") {
          const query = String(url.searchParams.get("q") || "").trim();
          const eventType = String(url.searchParams.get("eventType") || "ALL");
          const errorCode = String(url.searchParams.get("errorCode") || "ALL");
          const actor = String(url.searchParams.get("actor") || "ALL");
          const from = String(url.searchParams.get("from") || "");
          const to = String(url.searchParams.get("to") || "");
          const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
          const offset = Math.min(100_000, Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0));
          const allowedEventTypes = new Set([
            "ALL", "REPORT_SUCCEEDED", "REPORT_FAILED", "REPORT_UNKNOWN", "REPORT_PENDING",
            "ASSIGNMENT_CANCELLED", "ASSIGNMENT_ACTION"
          ]);
          assert(query.length <= 100, 422, "INVALID_AUDIT_QUERY", "审计搜索内容不能超过100个字符。");
          assert(allowedEventTypes.has(eventType), 422, "INVALID_AUDIT_EVENT_TYPE", "审计事件类型不正确。");
          assert(errorCode === "ALL" || /^[A-Z0-9_-]{1,100}$/.test(errorCode), 422, "INVALID_AUDIT_ERROR_CODE", "审计错误码不正确。");
          assert(actor.length >= 1 && actor.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(actor), 422, "INVALID_AUDIT_ACTOR", "审计操作人必须为1至200字且不能含控制字符。");
          assert(!from || (from.length <= 40 && !Number.isNaN(Date.parse(from))), 422, "INVALID_AUDIT_FROM", "审计开始时间不正确。");
          assert(!to || (to.length <= 40 && !Number.isNaN(Date.parse(to))), 422, "INVALID_AUDIT_TO", "审计结束时间不正确。");
          assert(!from || !to || Date.parse(from) < Date.parse(to), 422, "INVALID_AUDIT_RANGE", "审计结束时间必须晚于开始时间。");
          const result = store.listAuditEvents({
            query,
            eventType,
            errorCode,
            actor,
            from: from ? new Date(from).toISOString() : "",
            to: to ? new Date(to).toISOString() : "",
            limit,
            offset
          });
          return send(res, 200, { ...result, limit, offset, facets: store.auditFacets() });
        }

        if (["GET", "PUT"].includes(req.method) && url.pathname === "/v1/admin/people-groups") {
          const employees = await listDispatchEmployees();
          const leaders=(await readBlacklake.listOperators()).filter(person=>store.entryProfile(person.blacklakeOperatorId).appRole===APP_ROLES.FLOOR8_LEADER).map(person=>({blacklakeOperatorId:person.blacklakeOperatorId,name:person.name}));
          if (req.method === "PUT") {
            const input = await jsonBody(req);
            assert(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 422, "INVALID_PEOPLE_GROUP_REVISION", "请先读取分类再保存。");
            const before = peopleGroups().read(employees);
            const allowed = new Set([...employees.map((person) => person.blacklakeOperatorId), ...(before.managed ? before.groups.flatMap((group) => group.blacklakeOperatorIds) : [])]);
            const groups = validatePeopleGroups(input.groups, allowed,new Set(leaders.map(person=>person.blacklakeOperatorId)));
            const saved = peopleGroups().save(groups, input.expectedRevision, "admin", employees, {allPosition: input.allPosition});
            return send(res, 200, { ...saved, employees: peopleGroups().apply(employees),leaders });
          }
          return send(res, 200, { ...peopleGroups().read(employees), employees,leaders });
        }

        if (req.method === "GET" && url.pathname === "/v1/admin/operators") {
          const operators = await readBlacklake.listOperators();
          const statuses = new Map(store.wechatBindingStatuses().map((item) => [item.blacklakeOperatorId, item]));
          return send(res, 200, {
            operators: operators.map((operator) => presentAdminOperator(
              operator,
              statuses.get(operator.blacklakeOperatorId)
            )),
            unitRecommendations: store.dispatchUnitRecommendations()
          });
        }

        const unitRecommendationMatch = req.method === "PATCH"
          && url.pathname.match(/^\/v1\/admin\/dispatch-units\/([^/]+)\/recommended-operator$/);
        if (unitRecommendationMatch) {
          const unitId = decodeURIComponent(unitRecommendationMatch[1]);
          assert(FLOOR8_UNIT_IDS.includes(unitId), 422, "INVALID_RECOMMENDATION_UNIT", "只能为8楼工位设置驻位员工。" );
          const input = await jsonBody(req);
          const requestedIds = Array.isArray(input.blacklakeOperatorIds)
            ? input.blacklakeOperatorIds
            : input.blacklakeOperatorId === null || input.blacklakeOperatorId === "" ? [] : [input.blacklakeOperatorId];
          assert(requestedIds.length <= 100, 422, "INVALID_OPERATOR", "单个工位最多安排100人。" );
          const blacklakeOperatorIds = [...new Set(requestedIds.map(Number))];
          assert(blacklakeOperatorIds.every((id) => Number.isSafeInteger(id) && id > 0),
            422, "INVALID_OPERATOR", "请选择正确的驻位员工。" );
          const operators = blacklakeOperatorIds.length ? await blacklake.listOperators() : [];
          for (const blacklakeOperatorId of blacklakeOperatorIds) {
            assert(Number.isSafeInteger(blacklakeOperatorId) && blacklakeOperatorId > 0, 422, "INVALID_OPERATOR", "请选择正确的驻位员工。" );
            const operator = operators
              .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
            assert(operator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个人员 ID，请刷新后重试。" );
            store.upsertBlacklakeOperator(operator);
            const entry = store.entryProfile(blacklakeOperatorId);
            assert(entry.appRole === APP_ROLES.EMPLOYEE, 409, "OPERATOR_NOT_EMPLOYEE", "驻位人员必须是员工身份。" );
            assert(eligibleFloor8Operator(operator),
              409, "OPERATOR_NOT_FLOOR8_EMPLOYEE", "8楼工位只能选择当前归属8楼、未绑定3楼机台的员工。" );
          }
          const recommendations = store.setDispatchUnitRecommendations(unitId, blacklakeOperatorIds, "admin");
          return send(res, 200, {
            recommendations,
            recommendation: recommendations[0] || { unitId, blacklakeOperatorId: null }
          });
        }

        const reportingPermissionMatch = req.method === "PATCH" && url.pathname.match(/^\/v1\/admin\/operators\/(\d+)\/reporting-permission$/);
        if (reportingPermissionMatch) {
          const blacklakeOperatorId = Number(reportingPermissionMatch[1]);
          const input = await jsonBody(req);
          assert(typeof input.allowSwitch === "boolean", 422, "INVALID_REPORTING_PERMISSION", "允许切换必须是开启或关闭。" );
          const operator = (await blacklake.listOperators())
            .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          assert(operator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个人员 ID，请刷新后重试。" );
          store.setReportingModeSwitchPermission(blacklakeOperatorId, input.allowSwitch);
          const status = store.wechatBindingStatuses()
            .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          return send(res, 200, { operator: presentAdminOperator(operator, status) });
        }

        const qualityMatch=req.method==='PATCH'&&url.pathname.match(/^\/v1\/admin\/operators\/(\d+)\/quality-profile$/);
        if(qualityMatch){
          const input=await jsonBody(req),id=Number(qualityMatch[1]);
          assert(input&&!Array.isArray(input)&&Object.keys(input).every(key=>['qualityRole','expectedRevision'].includes(key)),422,'INVALID_QUALITY_PROFILE_INPUT','报工身份参数不正确。');
          assert(req.headers['sec-fetch-site']!=='cross-site',403,'QUALITY_ORIGIN_REJECTED','请从管理后台设置报工身份。');
          if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,'QUALITY_ORIGIN_REJECTED','请从管理后台设置报工身份。');}
          const operator=(await blacklake.listOperators()).find(person=>person.blacklakeOperatorId===id);
          assert(operator,404,'OPERATOR_NOT_FOUND','没有找到这位黑湖人员，请刷新。');
          store.upsertBlacklakeOperator(operator);
          store.setQualityProfile(id,input.qualityRole,input.expectedRevision,'ADMIN:'+agentOwner(req,config).slice(0,24));
          const status=store.wechatBindingStatuses().find(person=>person.blacklakeOperatorId===id);
          return send(res,200,{operator:presentAdminOperator(operator,status)});
        }
        const selfServiceMatch=req.method==='PATCH'&&url.pathname.match(/^\/v1\/admin\/operators\/(\d+)\/self-service$/);
        if(selfServiceMatch){
          const input=await jsonBody(req),id=Number(selfServiceMatch[1]);
          assert(input&&Object.keys(input).every(key=>['enabled','expectedRevision'].includes(key)),422,'INVALID_SELF_SERVICE_INPUT','自主报工设置参数不正确。');
          assert(req.headers['sec-fetch-site']!=='cross-site',403,'SELF_SERVICE_ORIGIN_REJECTED','请从管理后台设置自主报工。');
          if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,'SELF_SERVICE_ORIGIN_REJECTED','请从管理后台设置自主报工。');}
          const operator=(await blacklake.listOperators()).find(person=>person.blacklakeOperatorId===id);
          assert(operator,404,'OPERATOR_NOT_FOUND','没有找到这位黑湖人员，请刷新。');
          store.upsertBlacklakeOperator(operator);
          store.setSelfServicePermission(id,input.enabled,input.expectedRevision,`ADMIN:${agentOwner(req,config).slice(0,24)}`);
          const status=store.wechatBindingStatuses().find(person=>person.blacklakeOperatorId===id);
          return send(res,200,{operator:presentAdminOperator(operator,status)});
        }

        const workerTypeMatch = req.method === 'PATCH' && url.pathname.match(/^\/v1\/admin\/operators\/(\d+)\/worker-type$/);
        if(workerTypeMatch) {
          const input=await jsonBody(req),id=Number(workerTypeMatch[1]);
          assert(input&&Object.keys(input).every(key=>['workerType','expectedRevision'].includes(key)),422,'INVALID_WORKER_TYPE_INPUT','归属设置参数不正确。');
          assert(req.headers['sec-fetch-site']!=='cross-site',403,'WORKER_TYPE_ORIGIN_REJECTED','请从管理后台设置员工归属。');
          if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,'WORKER_TYPE_ORIGIN_REJECTED','请从管理后台设置员工归属。');}
          const operator=(await blacklake.listOperators()).find(person=>person.blacklakeOperatorId===id);
          assert(operator,404,'OPERATOR_NOT_FOUND','黑湖人员名单中没有此人，请刷新。');
          store.upsertBlacklakeOperator(operator);
          store.setWorkerType(id,input.workerType,input.expectedRevision,`ADMIN:${agentOwner(req,config).slice(0,24)}`);
          const status=store.wechatBindingStatuses().find(person=>person.blacklakeOperatorId===id);
          return send(res,200,{operator:presentAdminOperator(operator,status)});
        }

        const entryProfileMatch = req.method === "PATCH" && url.pathname.match(/^\/v1\/admin\/operators\/(\d+)\/entry-profile$/);
        if (entryProfileMatch) {
          const blacklakeOperatorId = Number(entryProfileMatch[1]);
          const input = await jsonBody(req);
          const operator = (await blacklake.listOperators())
            .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          assert(operator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个人员 ID，请刷新后重试。" );
          store.upsertBlacklakeOperator(operator);
          store.setEntryProfile(blacklakeOperatorId, input);
          const status = store.wechatBindingStatuses()
            .find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          return send(res, 200, { operator: presentAdminOperator(operator, status) });
        }

        if (req.method === "POST" && url.pathname === "/v1/admin/binding-codes") {
          const input = await jsonBody(req);
          const blacklakeOperatorId = Number(input.blacklakeOperatorId);
          assert(Number.isSafeInteger(blacklakeOperatorId) && blacklakeOperatorId > 0, 422, "INVALID_OPERATOR", "请选择正确的黑湖人员。");
          const blacklakeOperators = await blacklake.listOperators();
          const blacklakeOperator = blacklakeOperators.find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          assert(blacklakeOperator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个人，请刷新后重试。");
          const localOperator = store.upsertBlacklakeOperator(blacklakeOperator);
          const existingBinding = store.wechatBindingStatuses()
            .find((item) => item.blacklakeOperatorId === blacklakeOperatorId && item.boundAt);
          assert(!existingBinding, 409, "OPERATOR_ALREADY_BOUND", "这个人已经绑定微信。如需更换微信，请先解除旧绑定。");
          const code = newConfirmationCode();
          const created = store.createOperatorBindingCode({ blacklakeOperatorId, code });
          assert(created && created.operator.id === localOperator.id, 500, "BINDING_CODE_FAILED", "确认码生成失败，请重试。");
          return send(res, 201, {
            blacklakeOperatorId,
            name: localOperator.name,
            confirmationCode: code,
            expiresAt: created.expiresAt
          });
        }

        const unbindMatch = req.method === "DELETE" && url.pathname.match(/^\/v1\/admin\/bindings\/(\d+)$/);
        if (unbindMatch) {
          const blacklakeOperatorId = Number(unbindMatch[1]);
          assert(
            !store.hasActiveAssignmentForBlacklakeOperator(blacklakeOperatorId),
            409,
            "OPERATOR_HAS_ACTIVE_ASSIGNMENT",
            "这个人还有进行中或待核对的报工，处理完成后才能解绑。"
          );
          assert(store.unbindWechatOperator(blacklakeOperatorId), 404, "BINDING_NOT_FOUND", "这个人目前没有微信绑定。");
          return send(res, 204);
        }

        const cancelMatch = req.method === "POST" && url.pathname.match(/^\/v1\/admin\/assignments\/([^/]+)\/cancel$/);
        if (cancelMatch) {
          const input = await jsonBody(req);
          const reason = String(input.reason || "").trim();
          assert(reason.length <= 200 && !/[\u0000-\u001f\u007f]/.test(reason), 422, "INVALID_CANCELLATION_REASON", "操作备注最多200字，且不能包含控制字符。");
          const assignment = store.cancelAssignment(decodeURIComponent(cancelMatch[1]), reason, shanghaiTimestamp());
          assert(assignment, 409, "ASSIGNMENT_NOT_CANCELLABLE", "只能取消进行中的任务；提交中或待核对的任务必须先核对黑湖结果。");
          return send(res, 200, { assignment: presentAssignment(assignment) });
        }

        const resolveMatch = req.method === "POST" && url.pathname.match(/^\/v1\/admin\/assignments\/([^/]+)\/resolve$/);
        if (resolveMatch) {
          const assignmentId = decodeURIComponent(resolveMatch[1]);
          const input = await jsonBody(req);
          const outcome = String(input.outcome || "").toUpperCase();
          assert(["CONFIRMED", "NOT_CREATED"].includes(outcome), 422, "INVALID_REVIEW_OUTCOME", "核对结果只能是 CONFIRMED 或 NOT_CREATED。");
          const assignment = outcome === "CONFIRMED"
            ? store.resolveUnknownAsConfirmed(assignmentId, input.blacklakeOutputId)
            : store.resolveUnknownAsNotCreated(assignmentId);
          assert(assignment, 409, "ASSIGNMENT_NOT_REVIEWABLE", "该任务不在等待核对状态，或已经被其他人处理。");
          return send(res, 200, { assignment: presentAssignment(assignment) });
        }

        throw new AppError(404, "NOT_FOUND", "管理接口不存在。");
      }

      const session = requireSession(req, store);
      if(url.pathname.startsWith('/v1/workspace/')||/^\/v1\/orders(?:\/|$)/.test(url.pathname)){
        const service=workspace(),path=url.pathname,method=req.method;
        const workerModeRoute=method==='GET'&&(path==='/v1/workspace/worker'||/^\/v1\/workspace\/self\/\d+$/.test(path));
        const scanRoute=method==='POST'&&path==='/v1/workspace/scan';
        const sharedRead=method==='GET'&&(/^\/v1\/orders(?:\/\d+(?:\/(?:processes|materials|history|outsource))?)?$/.test(path)||/^\/v1\/workspace\/process-reports\/\d+\/\d+$/.test(path))
          ||method==='POST'&&(/^\/v1\/orders\/\d+\/refresh$/.test(path)||/^\/v1\/workspace\/process-reports\/\d+\/\d+\/refresh$/.test(path));
        const embroidery=(workerModeRoute||scanRoute||sharedRead)&&url.searchParams.get('mode')==='embroidery'
          ||(sharedRead||scanRoute)&&workerRoutingFor(session).effectiveWorkerType==='embroidery';
        service.authorize(session,{embroidery});
        if(req.method==='GET'&&url.pathname==='/v1/workspace/reports')return send(res,200,workspaceReports().read(Object.fromEntries(url.searchParams),session));
        const routeEditPath=url.pathname.match(/^\/v1\/workspace\/orders\/(\d+)\/process-management$/);
        if(routeEditPath||url.pathname==='/v1/workspace/process-catalog'){
          assert(processEdits,503,'PROCESS_EDIT_UNAVAILABLE','工序管理尚未接入。');
          const actor=session.blacklakeOperatorId;
          if(req.method==='GET'&&!routeEditPath)return send(res,200,await processEdits.catalog(url.searchParams.get('query')||'',actor));
          if(routeEditPath){
            const orderId=Number(routeEditPath[1]),job=url.searchParams.get('job');
            if(req.method==='GET')return send(res,200,job?processEdits.getJob(orderId,job,actor):await processEdits.context(orderId,actor));
            if(req.method==='POST')return send(res,202,processEdits.enqueue(orderId,await jsonBody(req),String(req.headers['idempotency-key']||''),actor));
          }
        }
        const approvalPath=req.method==='POST'&&url.pathname.match(/^\/v1\/workspace\/process-reports\/(\d+)\/(\d+)\/([^/]+)\/approval$/);
        if(approvalPath){
          const [,orderId,processId,rawId]=approvalPath,reportId=decodeURIComponent(rawId);
          const input=await jsonBody(req),operationId=String(req.headers['idempotency-key']||''),ownerId=session.blacklakeOperatorId;
          const groupReview=groupReportReview.find(reportId);
          if(groupReview&&(!groupReview.approved_at||input?.expectedApprovalRevision!==undefined)){
            return send(res,202,groupReportReview.approve(Number(orderId),Number(processId),reportId,input,operationId,ownerId));
          }
          assert(approvals,409,'REPORT_APPROVAL_UNAVAILABLE','报工审批同步尚未启用。');
          return send(res,202,approvals.enqueue(Number(orderId),Number(processId),reportId,input,operationId,ownerId));
        }
        if(req.method==='POST'&&url.pathname==='/v1/workspace/scan')return send(res,200,await service.scan((await jsonBody(req)).flowCode,session,{embroidery}));
        if(req.method==='GET'&&url.pathname==='/v1/orders'){
          const query={pageNum:Number(url.searchParams.get('pageNum')||1),projectCode:url.searchParams.get('projectCode')||'',sort:url.searchParams.get('sort')||'default',status:url.searchParams.get('status')||'ALL',priority:url.searchParams.get('priority')||'ALL'};
          const watch=url.searchParams.get('watch');
          return send(res,200,dataSync&&watch?dataSync.list({...query,watch:watch.split(',')}):await service.list(query));
        }
        const orderRefreshPath=req.method==='POST'&&url.pathname.match(/^\/v1\/orders\/(\d+)\/refresh$/);
        if(orderRefreshPath){
          const input=await jsonBody(req);assert(input&&!Array.isArray(input)&&Object.keys(input).length===0,422,'INVALID_ORDER_REFRESH','刷新只接受当前工单，不接受业务修改参数。');
          const id=Number(orderRefreshPath[1]),order=dataSync?dataSync.requestOrderRefresh(id,'operator:'+session.blacklakeOperatorId):await service.refreshOrder(id);
          return send(res,dataSync?202:200,{order,source:dataSync?'blacklake-snapshot':'blacklake-live',sync:order.sync,fetchedAt:order.sync?.updatedAt??new Date((now||Date.now)()).toISOString()});
        }
        const orderPath=url.pathname.match(/^\/v1\/orders\/(\d+)(?:\/(processes|materials|history|outsource))?$/);
        if(req.method==='GET'&&orderPath){const id=Number(orderPath[1]),section=orderPath[2];if(section&&section!=='processes')return send(res,200,await service.section(id,section,Number(url.searchParams.get('pageNum')||1)));
          const order=await service.order(id);if(section==='processes'&&order.processesLoaded===false)throw new AppError(503,'BLACKLAKE_DATA_SYNCING','工序正在由后台同步，请稍后刷新。');const fetchedAt=dataSync?(order.sync?.updatedAt??null):new Date((now||Date.now)()).toISOString();return send(res,200,section?{orderId:id,processes:order.processes,source:dataSync?'blacklake-snapshot':'blacklake-live',complete:order.sync?.complete??true,sync:order.sync,fetchedAt}:{order,source:dataSync?'blacklake-snapshot':'blacklake-live',sync:order.sync,fetchedAt});}
        if(req.method==='GET'&&['/v1/workspace/tasks','/v1/workspace/worker'].includes(url.pathname))return send(res,200,await service.snapshot(session,{embroidery,orderId:url.searchParams.has('orderId')?Number(url.searchParams.get('orderId')):undefined,activeOnly:url.pathname.endsWith('/tasks')&&url.searchParams.get('active')==='1'}));
        if(req.method==='GET'&&url.pathname==='/v1/workspace/assignment-history')return send(res,200,await service.assignmentHistory(session,{page:Number(url.searchParams.get('page')||1),start:url.searchParams.get('start')||'',end:url.searchParams.get('end')||''}));
        const contextPath=url.pathname.match(/^\/v1\/workspace\/(context|self)\/(\d+)$/);
        if(req.method==='GET'&&contextPath)return send(res,200,contextPath[1]==='context'?await service.context(Number(contextPath[2]),session):await service.selfContext(Number(contextPath[2]),session,{embroidery}));
        const reportsPath=url.pathname.match(/^\/v1\/workspace\/process-reports\/(\d+)\/(\d+)$/);
        const reportsRefreshPath=url.pathname.match(/^\/v1\/workspace\/process-reports\/(\d+)\/(\d+)\/refresh$/);
        if(req.method==='POST'&&reportsRefreshPath)return send(res,200,await service.refreshProcessReports(Number(reportsRefreshPath[1]),Number(reportsRefreshPath[2]),session,{embroidery}));
        const reportCreatePath=url.pathname.match(/^\/v1\/workspace\/process-reports\/(\d+)\/(\d+)\/(create-context|create)$/);
        if(reportCreatePath){const [,orderId,processId,action]=reportCreatePath;service.authorize(session);manualReports().authorize(session.blacklakeOperatorId);const order=await service.order(Number(orderId));if(req.method==='GET'&&action==='create-context')return send(res,200,await manualReports().context(order,Number(processId),session.blacklakeOperatorId));if(req.method==='POST'&&action==='create')return send(res,202,await manualReports().create(order,Number(processId),await jsonBody(req),String(req.headers['idempotency-key']||''),session.blacklakeOperatorId));}
        const reportActionPath=url.pathname.match(/^\/v1\/workspace\/process-reports\/(\d+)\/(\d+)\/([^/]+)\/(editor|edit|delete|reconcile)$/);
        if(reportActionPath){const [,orderId,processId,rawId,action]=reportActionPath,reportId=decodeURIComponent(rawId);if(req.method==='GET'&&action==='editor')return send(res,200,await service.processReportEditor(Number(orderId),Number(processId),reportId,session));if(req.method==='POST'&&action!=='editor')return send(res,200,await service.changeProcessReport(Number(orderId),Number(processId),reportId,action,await jsonBody(req),String(req.headers['idempotency-key']||''),session));}
        if(req.method==='GET'&&reportsPath)return send(res,200,await service.processReports(Number(reportsPath[1]),Number(reportsPath[2]),session,{embroidery,version:url.searchParams.get('version')}));
        const operationPath=url.pathname.match(/^\/v1\/workspace\/orders\/(\d+)\/operations$/);
        if(req.method==='GET'&&operationPath)return send(res,200,await service.orderOperations(Number(operationPath[1]),session,url.searchParams.get('operationId')));
        if(req.method==='POST'&&url.pathname==='/v1/workspace/preview')return send(res,200,await service.preview(await jsonBody(req),session));
        if(req.method==='POST'&&url.pathname==='/v1/workspace/actions'){const body=await jsonBody(req);return send(res,200,await service.action(body.action,body.input||{}, {...body.meta,operationId:String(req.headers['idempotency-key']||'')},session));}
        throw new AppError(404,'WORKSPACE_NOT_FOUND','此界面接口不存在。');
      }
      if(url.pathname.startsWith('/v1/flow/')&&session.scope!=='review')assertCuttingWorker(session);

      if (url.pathname === '/v1/assignments/quantity-pending' && req.method === 'GET') {
        assert(session.scope !== 'review',403,'QUANTITY_ACCESS_DENIED','审核体验不能访问正式补量任务。');
        return send(res,200,quantities().list(session.id,{offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||20)}));
      }
      const quantityMatch=url.pathname.match(/^\/v1\/assignments\/([^/]+)\/quantity$/);
      if(quantityMatch) {
        assert(session.scope !== 'review',403,'QUANTITY_ACCESS_DENIED','审核体验不能处理正式补量任务。');
        const id=decodeURIComponent(quantityMatch[1]);
        if(req.method==='GET')return send(res,200,quantities().detail(id,session.id));
        if(req.method==='POST')return send(res,200,await quantities().submit(id,await jsonBody(req),{actor:`WORKER:${session.blacklakeOperatorId}`,operatorId:session.id,operationId:String(req.headers['idempotency-key']||'')}));
      }

      if (req.method === "GET" && url.pathname === "/v1/me") {
        let currentOperator = session;
        if (session.scope !== "review") {
          try {
            const current = (await readBlacklake.listOperators())
              .find((item) => item.blacklakeOperatorId === session.blacklakeOperatorId);
            if (current) currentOperator = store.upsertBlacklakeOperator(current);
          } catch (error) {
            console.warn(JSON.stringify({
              event: "operator_department_refresh_failed",
              blacklakeOperatorId: session.blacklakeOperatorId,
              code: error.code || "BLACKLAKE_QUERY_FAILED"
            }));
          }
        }
        return send(res, 200, {
          operator: session.scope === "review" ? { name: "审核体验" } : presentOperator(currentOperator),
          draftOwnerId: `${session.scope === "review" ? "review" : "operator"}:${session.id}`,
          entry: session.scope === "review" ? publicEntryProfile() : {
            ...entryProfile(currentOperator),
            ...(canOperateOrdersFromEmployeeView(store,session)&&workerRoutingFor(session).canReceiveFloor8Assignments?{canOperateOrders:true}:{})
          },
          reviewMode: session.scope === "review",
          selfServiceEnabled: selfServiceEnabled(currentOperator),
          cuttingSelfService: selfServiceEnabled(currentOperator)
        });
      }

      const stationDetailMatch = req.method === "GET" && url.pathname.match(/^\/v1\/dispatch\/units\/([^/]+)$/);
      if (stationDetailMatch) {
        const profile = entryProfile(session);
        assertDispatcher(profile);
        assert(session.scope !== "review",403,"ROLE_NOT_ALLOWED","体验身份不可查看现场工位。");
        const unitId = normalizeDispatchUnit(decodeURIComponent(stationDetailMatch[1]),profile.appRole);
        return send(res,200,await stationDetail({store,blacklake,unitId,now}));
      }

      if (req.method === "GET" && url.pathname === "/v1/dispatch/overview") {
        const profile = entryProfile(session);
        assertDispatcher(profile);
        const unitIds = unitsForRole(profile.appRole);
        const unitRecommendations = new Map();
        for (const item of store.dispatchUnitRecommendations()) {
          if (!unitRecommendations.has(item.unitId)) unitRecommendations.set(item.unitId, []);
          unitRecommendations.get(item.unitId).push(item.blacklakeOperatorId);
        }
        const units = unitIds.map((id) => {
          const assignments = store.activeAssignmentsByUnit(id);
          const assignment = assignments[0];
          const state = unitState(assignments);
          const operatorMapped = profile.appRole !== APP_ROLES.FLOOR3_SUPERVISOR || Boolean(store.operatorForWorkUnit(id));
          return {
            id,
            state,
            assignment: assignment ? presentAssignment(assignment) : null,
            assignments: assignments.map(presentAssignment),
            assignmentCount: assignments.length,
            canAssign: profile.appRole === APP_ROLES.FLOOR8_LEADER
              || (operatorMapped && !["running", "attention"].includes(state)),
            operatorMapped,
            recommendedBlacklakeOperatorIds: profile.appRole === APP_ROLES.FLOOR8_LEADER
              ? unitRecommendations.get(id) || []
              : [],
            recommendedBlacklakeOperatorId: profile.appRole === APP_ROLES.FLOOR8_LEADER
              ? unitRecommendations.get(id)?.[0] || null
              : null
          };
        });
        const employees = profile.appRole === APP_ROLES.FLOOR8_LEADER ? await listDispatchEmployees() : [];
        const groupConfig = profile.appRole === APP_ROLES.FLOOR8_LEADER ? peopleGroups().read(employees) : null;
        const peopleGroupConfig = groupConfig ? { revision: groupConfig.revision, allPosition: groupConfig.allPosition,
          groups: groupConfig.groups.map(({id, name}) => ({id, name})) } : null;
        return send(res, 200, { profile, units, employees, peopleGroupConfig });
      }

      if (req.method === "GET" && url.pathname === "/v1/dispatch/stations") {
        assert(session.scope !== "review" && entryProfile(session).appRole === APP_ROLES.FLOOR8_LEADER,
          403, "ROLE_NOT_ALLOWED", "只有8楼组长可以维护工位绑定。");
        const employees = await listDispatchEmployees();
        const bindings = store.dispatchUnitRecommendations();
        return send(res, 200, { employees, units: FLOOR8_UNIT_IDS.map((id) => ({ id,
          blacklakeOperatorIds: bindings.filter((row) => row.unitId === id).map((row) => row.blacklakeOperatorId) })) });
      }

      const stationBindingMatch = req.method === "PATCH" && url.pathname.match(/^\/v1\/dispatch\/stations\/([^/]+)$/);
      if (stationBindingMatch) {
        assert(session.scope !== "review" && entryProfile(session).appRole === APP_ROLES.FLOOR8_LEADER,
          403, "ROLE_NOT_ALLOWED", "只有8楼组长可以维护工位绑定。");
        const unitId = normalizeDispatchUnit(decodeURIComponent(stationBindingMatch[1]), APP_ROLES.FLOOR8_LEADER);
        const input = await jsonBody(req);
        assert(Array.isArray(input.blacklakeOperatorIds) && Array.isArray(input.expectedOperatorIds)
          && input.blacklakeOperatorIds.length <= 100 && input.expectedOperatorIds.length <= 100,
          422, "INVALID_STATION_BINDING", "请刷新后选择工位人员。");
        const ids = [...new Set(input.blacklakeOperatorIds.map(Number))];
        const expected = input.expectedOperatorIds.map(Number);
        assert([...ids, ...expected].every((id) => Number.isSafeInteger(id) && id > 0), 422, "INVALID_OPERATOR", "工位人员无效。");
        const employees = await listDispatchEmployees();
        assert(ids.every((id) => employees.some((employee) => employee.blacklakeOperatorId === id)),
          409, "OPERATOR_NOT_FLOOR8_EMPLOYEE", "只能绑定当前8楼可派工员工，请刷新名单。");
        const saved = store.setDispatchUnitRecommendations(unitId, ids, `leader:${session.blacklakeOperatorId}:${session.name}`,
          { expectedOperatorIds: expected, audit: true });
        assert(saved, 409, "STATION_BINDING_CHANGED", "工位绑定已被其他人修改，请刷新后再保存。");
        return send(res, 200, { unitId, blacklakeOperatorIds: ids });
      }

      if (req.method === "POST" && url.pathname === "/v1/dispatch/prediction") {
        assert(session.scope !== "review" && entryProfile(session).appRole === APP_ROLES.FLOOR8_LEADER,
          403, "ROLE_NOT_ALLOWED", "只有8楼组长可以读取派工预测。");
        const input = await jsonBody(req);
        const processes = (await (dataSync?readBlacklake:blacklake).listWorkOrderProcesses(normalizeFlowCode(input.flowCode))).filter(task=>Number(task.processStatus)!==20);
        assert(processes.length, 409, "FLOW_COMPLETED", "当前工单没有可派工工序。");
        assertReviewProject(session, processes[0], config);
        if (input.taskId !== undefined && input.taskId !== null) assert(processes.some((row) => row.taskId === Number(input.taskId)),
          422, "INVALID_TASK", "请选择当前工单工序。");
        const flowCode = normalizeFlowCode(input.flowCode);
        let initialPredictionId = null;
        if (input.initialPredictionId) {
          const initial = store.predictions.get(String(input.initialPredictionId));
          assert(initial?.ownerId === session.blacklakeOperatorId && initial.projectId === processes[0].projectId
            && initial.snapshot.flowCodeHash === stableHash({ flowCode }), 403, "PREDICTION_NOT_OWNED", "初始预测不属于当前组长或工单。");
          initialPredictionId = initial.id;
        }
        const employees = await listDispatchEmployees();
        let selectedEmployeeIds;
        if (input.blacklakeOperatorIds !== undefined) {
          assert(Array.isArray(input.blacklakeOperatorIds) && input.blacklakeOperatorIds.length > 0 && input.blacklakeOperatorIds.length <= 100,
            422, "INVALID_OPERATOR", "请先选择人员，再获取工序建议。");
          selectedEmployeeIds = [...new Set(input.blacklakeOperatorIds.map(Number))];
          assert(selectedEmployeeIds.every((id) => Number.isSafeInteger(id) && id > 0), 422, "INVALID_OPERATOR", "所选人员无效。");
          assert(selectedEmployeeIds.every((id) => employees.some((person) => person.blacklakeOperatorId === id && (person.available||person.canQueue))),
            409, "DISPATCH_CONFLICT", "所选人员状态已变化，请返回重新选人。");
        }
        const snapshot = { ...(selectedEmployeeIds
          ? predictProcessForEmployees({ rules: dispatchPredictionRules, processes, employees, selectedEmployeeIds })
          : predictDispatch({ rules: dispatchPredictionRules, processes, employees, taskId: input.taskId })),
          flowCodeHash: stableHash({ flowCode }), initialPredictionId };
        const prediction = store.predictions.create({ ownerId: session.blacklakeOperatorId, dispatcherName: session.name,
          projectId: processes[0].projectId, projectCode: processes[0].projectCode, snapshot });
        return send(res, 200, { prediction });
      }

      if(url.pathname==='/v1/dispatch/clock-out'||url.pathname==='/v1/dispatch/clock-out/schedule'){
        assert(session.scope!=='review'&&entryProfile(session).appRole===APP_ROLES.FLOOR8_LEADER,403,'CLOCKOUT_NOT_ALLOWED','只有正式组长可以操作下班。');
        const service=clockout(),owner=session.blacklakeOperatorId,key=String(req.headers['idempotency-key']||'');
        if(req.method==='GET'&&url.pathname==='/v1/dispatch/clock-out')return send(res,200,service.preview(owner));
        if(req.method==='POST'&&url.pathname==='/v1/dispatch/clock-out')return send(res,200,service.pause(owner,await jsonBody(req),key));
        if(req.method==='PUT'&&url.pathname.endsWith('/schedule'))return send(res,200,service.saveSchedule(owner,await jsonBody(req),key));
        return send(res,405,{message:'不支持此操作。'});
      }
      const leaderReportChange=url.pathname.match(/^\/v1\/dispatch\/reports\/([^/]+)\/(edit|delete|reconcile)$/);
      const leaderReportEditor=req.method==='GET'&&url.pathname.match(/^\/v1\/dispatch\/reports\/([^/]+)\/editor$/);
      if((req.method==='GET'&&url.pathname==='/v1/dispatch/reports')||leaderReportEditor||(req.method==='POST'&&leaderReportChange)) {
        assert(session.scope!=='review',403,'DISPATCH_NOT_ALLOWED','体验身份不能访问正式报工管理。');
        const profile=entryProfile(session);assertDispatcher(profile);
        const context={ownerId:session.blacklakeOperatorId,unitIds:unitsForRole(profile.appRole)};
        if(leaderReportEditor)return send(res,200,await leaderReports().editor(decodeURIComponent(leaderReportEditor[1]),context));
        if(req.method==='GET')return send(res,200,leaderReports().list({...context,date:url.searchParams.get('date')||undefined,
          offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||30)}));
        if(leaderReportChange[2]==='reconcile')return send(res,200,await leaderReports().reconcile(decodeURIComponent(leaderReportChange[1]),context));
        const result=await (reportOutbox?reportOutbox.enqueueChange.bind(reportOutbox):leaderReports().change.bind(leaderReports()))(decodeURIComponent(leaderReportChange[1]),await jsonBody(req),{
          ...context,action:leaderReportChange[2],operationId:String(req.headers['idempotency-key']||'')});
        return send(res,200,result);
      }

      if (req.method === "GET" && url.pathname === "/v1/dispatch/history") {
        assert(session.scope !== "review", 403, "DISPATCH_NOT_ALLOWED", "审核体验不能访问正式分配记录。");
        const profile = entryProfile(session);
        assertDispatcher(profile);
        const limit = Number(url.searchParams.get("limit") || 100);
        assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200,
          422, "INVALID_HISTORY_LIMIT", "每次可读取1至200条分配记录。");
        const includeActiveValue = url.searchParams.get("includeActive");
        assert(includeActiveValue === null || ["true", "false"].includes(includeActiveValue),
          422, "INVALID_HISTORY_SCOPE", "分配记录查询范围无效。");
        const includeActive = includeActiveValue === "true";
        const serverTime = shanghaiTimestamp();
        const date = serverTime.slice(0, 10);
        const nextDate = shanghaiTimestamp(new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86400000)).slice(0, 10);
        const result = store.dispatchHistory({ unitIds: unitsForRole(profile.appRole), from: `${date} 00:00:00`, to: `${nextDate} 00:00:00`, limit, includeActive, publishedByOperatorId: session.blacklakeOperatorId });
        const assignments = result.assignments.map((assignment) => ({
          ...presentAssignment(assignment),
          unitId: assignment.machineId || assignment.stationName,
          canCancel: assignment.status === "READY",
          // 未完成/待核对时的 quantity 不是已确认产量。实际加工数包括良品及不良品。
          actualQuantity: assignment.status === "COMPLETED" ? assignment.goodQuantity + assignment.defectQuantity : null
        }));
        return send(res, 200, { assignments, date, timezone: "Asia/Shanghai", scope: includeActive ? "today-and-open" : "today",
          scopeDescription: includeActive ? "本人今日分配、跨日未结束任务和跨日完工待核量记录；完工待核量不占用人员或工位。" : "本人今日分配记录。",
          total: result.total, limit, truncated: result.total > assignments.length, serverTime });
      }

      const dispatchCancelMatch = req.method === "POST" && url.pathname.match(/^\/v1\/dispatch\/assignments\/([^/]+)\/cancel$/);
      if (dispatchCancelMatch) {
        assert(session.scope !== "review", 403, "DISPATCH_NOT_ALLOWED", "审核体验不能撤销正式派单。");
        const profile = entryProfile(session);
        assertDispatcher(profile);
        const unitIds = unitsForRole(profile.appRole);
        const id = decodeURIComponent(dispatchCancelMatch[1]);
        const current = store.assignmentById(id);
        assert(current && current.assignmentMode === "DISPATCHED" && current.publishedByOperatorId === session.blacklakeOperatorId
          && unitIds.includes(current.machineId || current.stationName),
          404, "ASSIGNMENT_NOT_FOUND", "没有找到您派出的这笔任务，请刷新后重试。");
        const input = await jsonBody(req);
        const reason = String(input.reason || "").normalize("NFKC").trim();
        assert(reason.length <= 300 && !/[\u0000-\u001f\u007f]/.test(reason),
          422, "INVALID_CANCELLATION_REASON", "操作备注最多300字，且不能包含控制字符。");
        const assignment = store.cancelDispatchedAssignment({
          id, unitIds, reason, endedAt: shanghaiTimestamp(), actor: `DISPATCHER:${session.blacklakeOperatorId}:${session.name}`, publishedByOperatorId: session.blacklakeOperatorId
        });
        assert(assignment, 409, "ASSIGNMENT_NOT_CANCELLABLE", "只能撤销待开始的派单；已开始、提交中或待核对任务请联系管理员处理。");
        return send(res, 200, { assignment: { ...presentAssignment(assignment), unitId: assignment.machineId || assignment.stationName, canCancel: false, actualQuantity: null } });
      }

      if (req.method === "POST" && url.pathname === "/v1/dispatch/work-order/detail") {
        const profile = entryProfile(session);
        assert(profile.appRole === APP_ROLES.FLOOR8_LEADER, 403, 'ROLE_NOT_ALLOWED', '只有8楼组长可以读取此工单详情。');
        const input = await jsonBody(req), flowCode = normalizeFlowCode(input.flowCode);
        const tasks = await blacklake.listWorkOrderProcesses(flowCode, {includeCompleted:true});
        assert(tasks.length, 404, 'WORK_ORDER_NOT_FOUND', '没有找到这张工单的工序。');
        const first = tasks[0];assertReviewProject(session, first, config);
        assert(tasks.every(task => task.projectId === first.projectId && task.projectCode === first.projectCode), 502, 'WORK_ORDER_MISMATCH', '工单资料不一致，请重新扫描。');
        let workOrder = {projectId:first.projectId,projectCode:first.projectCode,productName:first.productName}, metadataStatus = 'available';
        try {
          const details = await blacklake.readWorkOrderDetails(first.projectId,first.projectCode);
          assert(details.projectId === first.projectId && details.projectCode === first.projectCode,502,'WORK_ORDER_MISMATCH','工单资料不一致。');
          workOrder = details;
        } catch { metadataStatus = 'unavailable'; }
        return send(res,200,{workOrder,metadataStatus,processOverview:tasks.map(task=>({...publicProcessOption(task),...processProgress(task)})),
          source:{source:'BLACKLAKE',asOf:new Date(now ? now() : Date.now()).toISOString(),cacheSeconds:10,
            projectProgressField:'actualAmount / planAmount',description:'工单进度直接来自黑湖；各工序累计合格/计划，不相加为成品产量。'}});
      }

      if (req.method === "POST" && url.pathname === "/v1/dispatch/work-order") {
        const profile = entryProfile(session);
        assertDispatcher(profile);
        const input = await jsonBody(req);
        const flowCode = normalizeFlowCode(input.flowCode);
        const includeProgress = input.includeProgress === true && profile.appRole === APP_ROLES.FLOOR8_LEADER;
        const allProcesses = await blacklake.listWorkOrderProcesses(flowCode, { includeCompleted: includeProgress });
        let processes = includeProgress ? allProcesses.filter(task => !processProgress(task).closed) : allProcesses;
        assert(allProcesses.length && (includeProgress || processes.length), 409, "FLOW_COMPLETED", "这张工单没有可分配的未完成工序。");
        assertReviewProject(session, allProcesses[0], config);
        if (profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR) {
          processes = processes.filter((process) => isEmbroideryProcessName(process.processName));
          assert(processes.length, 409, "EMBROIDERY_PROCESS_NOT_FOUND", "这张工单没有可分配的绣花工序。");
        }
        const first = processes[0] || allProcesses[0];
        return send(res, 200, {
          workOrder: {
            projectId: first.projectId,
            projectCode: first.projectCode,
            productName: first.productName
          },
          processes: processes.map(publicProcessOption),
          ...(includeProgress ? {
            processOverview: allProcesses.map(task => ({ ...publicProcessOption(task), ...processProgress(task),
              selectable: processes.some(option => option.taskId === task.taskId) })),
            progressSource: { source: 'BLACKLAKE', description: '工序累计已报合格数 / 计划数，非个人完成率', asOf: new Date(now ? now() : Date.now()).toISOString(), cacheSeconds: 10 }
          } : {}),
          recommendedProcess: profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR
            ? publicProcessOption(preferredEmbroideryProcess(processes) || processes[0])
            : null
        });
      }

      if (req.method === "POST" && ["/v1/dispatch/work-orders/search", "/v1/flow/work-orders/search"].includes(url.pathname)) {
        const profile = entryProfile(session);
        if (url.pathname.startsWith('/v1/flow/')) assertCuttingWorker(session);
        else assertDispatcher(profile);
        const input = await jsonBody(req);
        const sku = String(input.sku || "").normalize("NFKC").trim();
        assert(sku.length >= 1 && sku.length <= 80 && !/[\u0000-\u001f\u007f]/.test(sku),
          422, "INVALID_SKU", "请输入正确的 SKU。" );
        const workOrders = (await blacklake.searchWorkOrdersBySku(sku))
          // Blacklake project status 20 means 已结束; quantities do not close a work order.
          .filter((order) => !["20", "已结束"].includes(String(order.projectStatus ?? "").trim()))
          .filter((order) => isReviewProjectAllowed(session, order, config));
        return send(res, 200, { workOrders });
      }

      if (req.method === "POST" && url.pathname === "/v1/dispatch/process-recommendations") {
        const profile = entryProfile(session);
        assert(profile.appRole === APP_ROLES.FLOOR8_LEADER, 403, "ROLE_NOT_ALLOWED", "只有8楼组长可以读取人员工序推荐。" );
        const input = await jsonBody(req);
        const flowCode = normalizeFlowCode(input.flowCode);
        if (input.unitId !== undefined) normalizeDispatchUnit(input.unitId, profile.appRole);
        const requestedIds = Array.isArray(input.blacklakeOperatorIds)
          ? input.blacklakeOperatorIds.map(Number)
          : [];
        assert(requestedIds.length && requestedIds.every((id) => Number.isSafeInteger(id) && id > 0), 422, "INVALID_OPERATOR", "请至少选择一名员工。" );
        const blacklakeOperatorIds = [...new Set(requestedIds)];
        const operators = await blacklake.listOperators();
        const selectedOperators = [];
        for (const blacklakeOperatorId of blacklakeOperatorIds) {
          const operator = operators.find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
          assert(operator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个员工，请刷新后重试。" );
          assert(store.entryProfile(blacklakeOperatorId).appRole === APP_ROLES.EMPLOYEE, 409, "OPERATOR_NOT_EMPLOYEE", "选择的人员当前不是员工身份。" );
          selectedOperators.push(operator);
        }
        const processes = await blacklake.listWorkOrderProcesses(flowCode);
        assert(processes.length, 409, "FLOW_COMPLETED", "这张工单没有可分配的未完成工序。" );
        assertReviewProject(session, processes[0], config);
        const history = store.dispatchProcessPreferences({
          dispatcherBlacklakeOperatorId: session.blacklakeOperatorId,
          targetBlacklakeOperatorIds: blacklakeOperatorIds
        });
        const analyzedHistory = selectedOperators.map((operator) => recommendEmployeeProcess({
          operatorName: operator.name,
          processes,
          rules: processInferenceRules
        })).filter(Boolean).map((recommendation) => ({
          processName: recommendation.process.processName,
          useCount: recommendation.evidence.reportCount,
          lastUsedAt: recommendation.evidence.period?.to || ""
        }));
        history.systemRecommended = mergeProcessPreferenceRows([
          ...analyzedHistory,
          ...history.systemRecommended
        ]);
        return send(res, 200, groupDispatchProcessRecommendations(processes, history));
      }

      if (req.method === "POST" && url.pathname === "/v1/dispatch/assign") {
        const profile = entryProfile(session);
        assertDispatcher(profile);
        const input = await jsonBody(req);
        const flowCode = normalizeFlowCode(input.flowCode);
        let predictionFeedback;
        let predictionRecord;
        const predictionId = input.predictionId;
        const predictionRequestHash = stableHash({ flowCode, taskId: Number(input.taskId), unitId: String(input.unitId || ""),
          operators: [...new Set((Array.isArray(input.blacklakeOperatorIds) ? input.blacklakeOperatorIds : [input.blacklakeOperatorId]).map(Number))].sort((a, b) => a - b),
          placements: (Array.isArray(input.placements) ? input.placements : []).map((row) => ({
            blacklakeOperatorId: Number(row?.blacklakeOperatorId), unitId: String(row?.unitId || ""), source: row?.source
          })).sort((a, b) => a.blacklakeOperatorId - b.blacklakeOperatorId) });
        if (predictionId !== undefined && predictionId !== null) {
          assert(profile.appRole === APP_ROLES.FLOOR8_LEADER && session.scope !== "review",
            403, "ROLE_NOT_ALLOWED", "当前身份不能确认派工预测。");
          assert(typeof predictionId === "string" && /^[a-f0-9-]{36}$/.test(predictionId), 422, "INVALID_PREDICTION", "预测记录无效。");
          predictionRecord = store.predictions.get(predictionId);
          assert(predictionRecord?.ownerId === session.blacklakeOperatorId, 403, "PREDICTION_NOT_OWNED", "请使用当前组长获取的预测。");
          assert(predictionRecord.snapshot.flowCodeHash === stableHash({ flowCode }), 409, "PREDICTION_WORK_ORDER_CHANGED", "工单已变化，请重新读取预测。");
          const feedback = store.predictions.feedback(predictionId);
          if (feedback) {
            assert(feedback.requestHash === predictionRequestHash, 409, "PREDICTION_ALREADY_USED", "本次预测已确认；请先核对今日分配，再重新获取建议。");
            const assignments = store.dispatchedBatchAssignments(feedback.batchId).map(presentAssignment);
            return send(res, 200, { assignment: assignments[0], assignments, replayed: true });
          }
          assert(Date.parse(predictionRecord.expiresAt) > Date.now(), 409, "PREDICTION_EXPIRED", "建议已过期，请重新获取建议。");
        }
        const unitId = profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR
          ? normalizeDispatchUnit(input.unitId, profile.appRole) : input.unitId;
        const task = await blacklake.findWorkOrderProcess(flowCode, input.taskId);
        assertReviewProject(session, task, config);
        if (profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR) {
          assert(isEmbroideryProcessName(task.processName), 422, "NOT_EMBROIDERY_PROCESS", "3楼绣花机只能分配绣花工序。");
        }
        let targetOperators;
        if (profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR) {
          const targetOperator = store.operatorForWorkUnit(unitId);
          assert(targetOperator, 409, "WORK_UNIT_OPERATOR_NOT_CONFIGURED", `请先在后台给 ${unitId} 绑定员工。`);
          targetOperators = [targetOperator];
        } else {
          const requestedIds = Array.isArray(input.blacklakeOperatorIds)
            ? input.blacklakeOperatorIds.map(Number)
            : [Number(input.blacklakeOperatorId)];
          assert(requestedIds.length && requestedIds.every((id) => Number.isSafeInteger(id) && id > 0), 422, "INVALID_OPERATOR", "请至少选择一名员工。");
          const blacklakeOperatorIds = [...new Set(requestedIds)];
          const operators = await blacklake.listOperators();
          targetOperators = blacklakeOperatorIds.map((blacklakeOperatorId) => {
            const operator = operators.find((item) => item.blacklakeOperatorId === blacklakeOperatorId);
            assert(operator, 404, "OPERATOR_NOT_FOUND", "黑湖人员名单中没有这个员工，请刷新后重试。");
            assert(store.entryProfile(blacklakeOperatorId).appRole === APP_ROLES.EMPLOYEE, 409, "OPERATOR_NOT_EMPLOYEE", "选择的人员当前不是员工身份。");
            assert(eligibleFloor8Operator(operator), 409, "OPERATOR_NOT_FLOOR8_EMPLOYEE", "所选人员不是当前8楼可派工员工。");
            return store.upsertBlacklakeOperator(operator);
          });
        }
        const embroideryPart = profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR
          ? normalizeEmbroideryPart(input.embroideryPart)
          : "";
        if (profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR) {
          assert(embroideryPart, 422, "INVALID_EMBROIDERY_PART", `请选择${EMBROIDERY_PARTS.join("或")}。`);
        }
        const quantity = Number(task.plannedAmount);
        assert(Number.isSafeInteger(quantity) && quantity > 0, 422, "BLACKLAKE_PLAN_AMOUNT_INVALID", "这道工序没有可用的计划数量，请先在黑湖核对。");
        const publishedAt = shanghaiTimestamp();
        const quantityPolicy = "SERVER_DEFAULT";
        const dispatchBatchId = randomUUID();
        const placements = profile.appRole === APP_ROLES.FLOOR8_LEADER
          ? resolveEmployeePlacements({ operatorIds: targetOperators.map((operator) => operator.blacklakeOperatorId),
            bindings: store.dispatchUnitRecommendations(), placements: input.placements, unitId }) : [];
        if (predictionRecord) {
          assert(predictionRecord.projectId === task.projectId, 409, "PREDICTION_WORK_ORDER_CHANGED", "工单已变化，请重新读取预测。");
          if (predictionRecord.snapshot.mode === "PERSON_FIRST") assert(
            JSON.stringify(predictionRecord.snapshot.employees.map((row) => row.blacklakeOperatorId).sort((a,b) => a-b))
              === JSON.stringify(targetOperators.map((row) => row.blacklakeOperatorId).sort((a,b) => a-b)),
            409, "PREDICTION_PEOPLE_CHANGED", "人员已变化，请先重新获取工序建议。");
          const reason = String(input.predictionAdjustmentReason || "").trim();
          assert(reason.length <= 200, 422, "INVALID_ADJUSTMENT_REASON", "调整说明最多200字。");
          let appliedPrediction;
          if (input.appliedPredictionId && input.appliedPredictionId !== predictionId) {
            const applied = store.predictions.get(String(input.appliedPredictionId));
            assert(applied?.ownerId === session.blacklakeOperatorId && applied.projectId === task.projectId
              && applied.snapshot.initialPredictionId === predictionId && applied.snapshot.taskId === task.taskId,
              403, "PREDICTION_NOT_OWNED", "调整后的人员建议与本次工单不一致。");
            appliedPrediction = { id: applied.id, suggestion: applied.snapshot };
          }
          predictionFeedback = { predictionId, ownerId: session.blacklakeOperatorId, batchId: dispatchBatchId,
            requestHash: predictionRequestHash, reason, finalSelection: { projectId: task.projectId, taskId: task.taskId,
              processName: task.processName, processCode: task.processCode || "", appliedPrediction, employees: targetOperators.map((operator) => ({
                blacklakeOperatorId: operator.blacklakeOperatorId, name: operator.name,
                unitId: placements.find((row) => row.blacklakeOperatorId === operator.blacklakeOperatorId).unitId
              })) } };
        }
        const assignments = store.dispatchAssignments(targetOperators.map((targetOperator) => ({
          id: randomUUID(),
          operatorId: targetOperator.id,
          ...task,
          stationName: placements.find((item) => item.blacklakeOperatorId === targetOperator.blacklakeOperatorId)?.unitId || "",
          expectedBoundUnitId: placements.find((item) => item.blacklakeOperatorId === targetOperator.blacklakeOperatorId && item.source === "binding")?.unitId,
          machineId: profile.appRole === APP_ROLES.FLOOR3_SUPERVISOR ? unitId : "",
          embroideryPart,
          quantity,
          quantityPolicy,
          dispatchBatchId,
          baselineReportedAmount: nonNegativeInteger(reportedTaskAmount(task, store.isQualityOperator(targetOperator.id))),
          flowCodeHash: stableHash({ projectId: task.projectId }),
          flowCodeHint: String(task.projectId).slice(-4),
          publishedBy: session.name,
          publishedByOperatorId: session.blacklakeOperatorId,
          publishedAt
        })), { predictionFeedback, allowQueue:profile.appRole===APP_ROLES.FLOOR8_LEADER });
        assert(assignments?.length === targetOperators.length, 409, "DISPATCH_CONFLICT", "所选人员任务或工位绑定已变化，请刷新后核对重试。");
        const presented = assignments.map(presentAssignment);
        return send(res, 201, { assignment: presented[0], assignments: presented });
      }

      if (req.method === "GET" && url.pathname === "/v1/assignments/current") {
        const assignments = store.activeAssignments(session.id)
          .filter((assignment) => isReviewProjectAllowed(session, assignment, config));
        const requestedId = String(url.searchParams.get("id") || "");
        const assignment = requestedId
          ? assignments.find((item) => item.id === requestedId)
          : assignments[0];
        const presented = assignments.map((item) => ({
          ...presentAssignment(item),
          canWorkerCancel: store.canWorkerCancelAssignment(item.id, session.id)
        }));
        const current = assignment ? presented.find((item) => item.id === assignment.id) : null;
        let todaySummary=null,todaySummaryError='';
        if(session.scope!=='review'&&entryProfile(session).appRole===APP_ROLES.EMPLOYEE){
          try{todaySummary=employeeDailySummary(store,session.blacklakeOperatorId,{now:now||Date.now});}
          catch(error){todaySummaryError='今日统计暂时不可用，请稍后重试。';console.warn(JSON.stringify({event:'employee_daily_summary_unavailable',code:error.code||'SUMMARY_READ_FAILED'}));}
        }
        return send(res, 200, { assignment: current, assignments: presented, todaySummary,todaySummaryError,queueEnabled:session.scope!=='review'&&workerRoutingFor(session).canReceiveFloor8Assignments, serverTime: shanghaiTimestamp(new Date(now ? now() : Date.now())) });
      }

      if (req.method === "GET" && url.pathname === "/v1/assignments/recent") {
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 5));
        const assignments = store.recentAssignments(session.id, limit)
          .filter((assignment) => isReviewProjectAllowed(session, assignment, config));
        return send(res, 200, { assignments });
      }

      const assignmentImageMatch = req.method === "GET" && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/product-images$/);
      if (assignmentImageMatch) {
        const assignment = store.assignmentById(decodeURIComponent(assignmentImageMatch[1]));
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assertReviewProject(session, assignment, config);
        let details;
        try { details = await blacklake.readWorkOrderDetails(assignment.projectId, assignment.projectCode); }
        catch { throw new AppError(502, "PRODUCT_IMAGE_UNAVAILABLE", "产品图片暂时无法读取，请稍后重试。"); }
        const current = store.assignmentById(assignment.id);
        assert(current && current.operatorId === session.id && current.projectId === assignment.projectId && current.projectCode === assignment.projectCode,
          404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assert(details?.projectId === assignment.projectId && details?.projectCode === assignment.projectCode,
          502, "PRODUCT_IMAGE_MISMATCH", "产品图片对应工单未能确认，请稍后重试。");
        res.setHeader("Cache-Control", "private, no-store");
        return send(res, 200, { assignmentId: assignment.id, projectId: assignment.projectId,
          projectCode: assignment.projectCode, productImageUrls: details.productImageUrls || [] });
      }

      const assignmentDetailMatch = req.method === "GET" && url.pathname.match(/^\/v1\/assignments\/([^/]+)$/);
      if (assignmentDetailMatch) {
        const assignment = store.assignmentById(decodeURIComponent(assignmentDetailMatch[1]));
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assertReviewProject(session, assignment, config);
        return send(res, 200, { assignment: presentAssignment(assignment) });
      }

      const timerMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/(pause|resume|end|cancel-end|withdraw)$/);
      if (timerMatch) {
        const assignmentId=decodeURIComponent(timerMatch[1]),action=timerMatch[2];
        const input=await jsonBody(req),operationId=String(req.headers['idempotency-key']||'');
        assert(session.scope!=='review',403,'TIMER_REVIEW_READ_ONLY','体验身份不能操作任务计时。');
        assert(IDEMPOTENCY_PATTERN.test(operationId),422,'INVALID_TIMER_KEY','请刷新任务后重试。');
        assert(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,422,'INVALID_TIMER_REVISION','请刷新任务计时状态。');
        const current=store.assignmentById(assignmentId);
        assert(current?.operatorId===session.id,404,'ASSIGNMENT_NOT_FOUND','没有找到这笔任务。');
        assertReviewProject(session,current,config);
        if(!['pause','resume'].includes(action))workspace().authorize(session,{embroidery:true});
        const at=shanghaiTimestamp(new Date(now ? now() : Date.now()));
        const assignment=store.changeAssignmentTimer({assignmentId,operatorId:session.id,action,expectedRevision:input.expectedRevision,operationId,at});
        return send(res,200,{assignment:presentAssignment(assignment),serverTime:at});
      }

      const closedMachineMatch=req.method==='POST'&&url.pathname.match(/^\/v1\/assignments\/([^/]+)\/exit-closed-machine$/);
      if(closedMachineMatch){
        workspace().authorize(session,{embroidery:true});
        const id=decodeURIComponent(closedMachineMatch[1]),task=store.assignmentById(id);
        assert(task?.operatorId===session.id&&(task.assignmentMode===BOUND_EMBROIDERY_ASSIGNMENT||task.machineId&&task.assignmentMode==='SELF_SCAN'),404,'ASSIGNMENT_NOT_FOUND','没有找到本人自主绣花任务。');
        assert(task.status==='IN_PROGRESS'&&!task.reportId,409,'WORKSPACE_SELF_EXIT_NOT_ALLOWED','计时或报工状态已变化，请刷新。');
        if(!store.orderRemoved(task.projectId)){
          const order=await workspace().readLiveOrder(task.projectId);
          assert(order.status==='FINISHED'||order.processes.some(row=>row.id===task.taskId&&row.closed),409,'WORKSPACE_SELF_EXIT_NOT_ALLOWED','黑湖工序仍可用，请继续计时或报工。');
        }
        assert(store.assignmentById(id)?.reportId==null,409,'WORKSPACE_SELF_EXIT_NOT_ALLOWED','已有报工待核对。');
        const cancelled=store.cancelAssignment(id,'黑湖已关闭，员工退出自主机台任务',shanghaiTimestamp(new Date((now||Date.now)())),'AUTHENTICATED_OPERATOR');
        assert(cancelled,409,'ASSIGNMENT_NOT_CANCELLABLE','任务状态已改变，请刷新。');
        return send(res,200,{assignment:presentAssignment(cancelled)});
      }

      const startAssignedMatch = req.method === "POST" && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/start$/);
      if (startAssignedMatch) {
        const assignmentId = decodeURIComponent(startAssignedMatch[1]);
        const assignment = store.assignmentById(assignmentId);
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔待开始任务。");
        assertReviewProject(session, assignment, config);
        await checkDispatchedStart(assignment);
        let freshDefaults;
        if(!assignment.machineId&&FLOOR8_UNIT_IDS.includes(assignment.stationName)&&blacklake.findWorkOrderProcess){
          const task=await blacklake.findWorkOrderProcess('projectId='+assignment.projectId,assignment.taskId);
          assert(Number(task?.taskId)===assignment.taskId&&Number(task?.projectId)===assignment.projectId,409,'DISPATCH_TASK_CHANGED','工单工序已变化，请联系组长核对。');
          const quantity=Number(task.plannedAmount);
          assert(Number.isSafeInteger(quantity)&&quantity>0,422,'BLACKLAKE_PLAN_AMOUNT_INVALID','暂未取得当前工序的有效计划数量，请先在黑湖核对。');
          freshDefaults={quantity,baselineReportedAmount:nonNegativeInteger(reportedTaskAmount(task,assignment.isQualityInspection))};
        }
        const started = store.startDispatchedAssignment(assignmentId, session.id, shanghaiTimestamp(),freshDefaults);
        assert(started, 409, "ASSIGNMENT_START_CONFLICT", "任务状态已变化，或您还有其他正在生产的任务，请刷新后重试。");
        return send(res, 200, { assignment: presentAssignment(started) });
      }

      if (req.method === "POST" && url.pathname === "/v1/flow/options") {
        const input = await jsonBody(req);
        const selfWorkUnits = ['cutting','employee'].includes(input.selfService) ? assertCuttingWorker(session) : null;
        const flowCode = normalizeFlowCode(input.flowCode);
        const reportingMode = normalizeReportingMode(input.reportingMode);
        const profile = operatorReportingProfile(session);
        assertReportingModeAccess(profile, reportingMode);
        const canUseEmbroidery = profile.reportingModes.includes(REPORTING_MODES.EMBROIDERY);
        const includeProgress = Boolean(selfWorkUnits && input.includeProgress === true);
        const allProcesses = await blacklake.listWorkOrderProcesses(flowCode, { includeCompleted: includeProgress });
        let processes = includeProgress ? allProcesses.filter(task => !processProgress(task).closed) : allProcesses;
        assert(allProcesses.length && (includeProgress || processes.length), 409, "FLOW_COMPLETED", "这张工单没有可选择的未完成工序。");
        assertReviewProject(session, allProcesses[0], config);
        const activeAssignments = store.activeAssignments(session.id);
        if (activeAssignments.length) {
          assert(activeAssignments.every((assignment) => isEmbroideryProcessName(assignment.processName)), 409, "OPERATOR_ALREADY_WORKING", "您已经有一笔正在生产的任务，请先完成后再扫码。");
          assert(reportingMode !== REPORTING_MODES.STANDARD, 409, "OPERATOR_ALREADY_WORKING", "您已有正在生产的绣花机任务，请先返回机台任务。");
          processes = processes.filter((process) => isEmbroideryProcessName(process.processName));
          assert(processes.length, 409, "EMBROIDERY_PARALLEL_ONLY", "多机并行只支持尚未开工的外协加工绣花任务。");
        } else if (reportingMode === REPORTING_MODES.EMBROIDERY) {
          processes = processes.filter((process) => isEmbroideryProcessName(process.processName));
          assert(includeProgress || processes.length, 409, "EMBROIDERY_PROCESS_NOT_FOUND", "这张工单没有可用的外协加工绣花工序。");
        } else if (reportingMode === REPORTING_MODES.STANDARD || !canUseEmbroidery) {
          processes = processes.filter((process) => !isEmbroideryProcessName(process.processName));
          assert(includeProgress || processes.length, 409, "STANDARD_PROCESS_NOT_FOUND", "这张工单只有绣花工序，请切换到绣花机报工。");
        }

        const favoriteNames = store.favoriteProcessNames(session.id, 30);
        const favoriteProcesses = [];
        for (const name of favoriteNames) {
          const match = processes.find((process) => process.processName === name);
          if (match && !favoriteProcesses.some((process) => process.taskId === match.taskId)) favoriteProcesses.push(match);
          if (favoriteProcesses.length === 2) break;
        }
        const featuredProcesses = favoriteProcesses.length
          ? favoriteProcesses
          : processes.slice(0, 2);
        let recommendation = recommendEmployeeProcess({
          operatorName: session.name,
          processes,
          rules: processInferenceRules
        });
        if (selfWorkUnits) {
          let identityAmbiguous=true;
          try{const people=await blacklake.listOperators(),nameKey=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');identityAmbiguous=people.filter(person=>nameKey(person.name)===nameKey(session.name)).length!==1;}catch{}
          const history = predictProcessForEmployees({ rules: dispatchPredictionRules, processes,
            employees: [{blacklakeOperatorId:session.blacklakeOperatorId,name:session.name,available:activeAssignments.length===0,identityAmbiguous}], selectedEmployeeIds: [session.blacklakeOperatorId] });
          recommendation = history.taskId ? { process: processes.find(p=>p.taskId===history.taskId),
            evidence: { ...history.candidates[0]?.evidence, period: history.source.sourcePeriod, source:'STAFF_HISTORY' } } : recommendation;
        }
        const first = processes[0] || allProcesses[0];
        const embroideryProcess = reportingMode === REPORTING_MODES.STANDARD
          ? null
          : preferredEmbroideryProcess(processes);
        return send(res, 200, {
          workOrder: {
            projectId: first.projectId,
            projectCode: first.projectCode,
            productName: first.productName
          },
          featuredTitle: favoriteProcesses.length ? "你常做的" : "前两道未完成工序",
          featuredProcesses: featuredProcesses.map(publicProcessOption),
          favoriteProcesses: favoriteProcesses.map(publicProcessOption),
          processes: processes.map(publicProcessOption),
          embroideryProcess: embroideryProcess ? publicProcessOption(embroideryProcess) : null,
          recommendedProcess: recommendation ? publicProcessOption(recommendation.process) : null,
          recommendationEvidence: recommendation?.evidence || null,
          ...(includeProgress ? {
            processOverview: allProcesses.map(task => ({ ...publicProcessOption(task), ...processProgress(task),
              selectable: processes.some(option => option.taskId === task.taskId) })),
            progressSource: { source: 'BLACKLAKE', description: '工序累计已报合格数 / 计划数，非个人完成率', asOf: new Date(now ? now() : Date.now()).toISOString(), cacheSeconds: 10 }
          } : {}),
          ...(selfWorkUnits ? {selfWorkUnits} : {})
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/flow/embroidery-machine") {
        const input = await jsonBody(req);
        assert(
          operatorReportingProfile(session).reportingModes.includes(REPORTING_MODES.EMBROIDERY),
          403,
          "EMBROIDERY_MODE_NOT_ALLOWED",
          "当前人员未绑定绣花部门，不能使用绣花机报工。"
        );
        const flowCode = normalizeFlowCode(input.flowCode);
        const task = await blacklake.findWorkOrderProcess(flowCode, input.taskId);
        assertReviewProject(session, task, config);
        assert(isEmbroideryProcessName(task.processName), 422, "NOT_EMBROIDERY_PROCESS", "这张工单当前选择的不是绣花外协工序。");
        const machineId = normalizeEmbroideryMachineCode(input.machineCode);
        assert(machineId, 422, "INVALID_EMBROIDERY_MACHINE_CODE", "没有识别到 01–12 号绣花机，请扫描机台上的二维码。");
        assert(!store.activeAssignmentByMachine(machineId), 409, "EMBROIDERY_MACHINE_IN_USE", `${machineId} 号机已有进行中的任务，请确认机台或先结束原任务。`);
        return send(res, 200, {
          machine: { id: machineId, name: `${machineId} 号绣花机` },
          parts: [...EMBROIDERY_PARTS],
          process: publicProcessOption(task)
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/flow/process-code") {
        const input = await jsonBody(req);
        const flowCode = normalizeFlowCode(input.flowCode);
        const reportingMode = normalizeReportingMode(input.reportingMode);
        assertReportingModeAccess(operatorReportingProfile(session), reportingMode);
        const stationCode = normalizeStationCode(input.processCode);
        let processes = await blacklake.listWorkOrderProcesses(flowCode);
        assert(processes.length, 409, "FLOW_COMPLETED", "这张工单没有可选择的未完成工序。");
        assertReviewProject(session, processes[0], config);
        if (reportingMode === REPORTING_MODES.STANDARD) {
          processes = processes.filter((process) => !isEmbroideryProcessName(process.processName));
        } else if (reportingMode === REPORTING_MODES.EMBROIDERY) {
          processes = processes.filter((process) => isEmbroideryProcessName(process.processName));
        }
        const aliasedProcessCode = stationCode.taskId
          ? config.stationCodeAliases?.[String(stationCode.taskId)] || ""
          : "";
        const referenceTask = stationCode.taskId && !aliasedProcessCode
          ? await blacklake.findTaskById(stationCode.taskId)
          : undefined;
        const referenceProcessCode = stationCode.processCode || aliasedProcessCode || referenceTask?.processCode || "";
        const processKey = comparableProcessCode(referenceProcessCode);
        const matches = processKey
          ? processes.filter((process) =>
            process.processCode && comparableProcessCode(process.processCode) === processKey
          )
          : processes.filter((process) => process.taskId === stationCode.taskId);
        assert(
          matches.length,
          404,
          "STATION_PROCESS_NOT_FOUND",
          "这个工序码不属于当前工单，或该工序已经完成。请确认工位后重新扫描。"
        );
        assert(
          matches.length === 1,
          409,
          "STATION_PROCESS_AMBIGUOUS",
          "当前工单中有多道工序使用相同编码，请联系班组长修正黑湖工序编码。"
        );
        const activeAssignments = store.activeAssignments(session.id);
        if (activeAssignments.length) {
          assert(
            activeAssignments.every((assignment) => isEmbroideryProcessName(assignment.processName)) && isEmbroideryProcessName(matches[0].processName),
            409,
            "OPERATOR_ALREADY_WORKING",
            "您已有正在生产的任务；只有外协加工绣花工序支持多机并行。"
          );
          assert(
            !activeAssignments.some((assignment) => assignment.taskId === matches[0].taskId),
            409,
            "ASSIGNMENT_START_CONFLICT",
            "这道绣花任务已经在计时，请直接切换到已有任务。"
          );
        }
        return send(res, 200, { process: publicProcessOption(matches[0]) });
      }

      if (req.method === "POST" && url.pathname === "/v1/flow/start") {
        const input = await jsonBody(req);
        const boundEmbroidery=input.selfService==='embroidery-bound';
        const selfEmbroidery=boundEmbroidery||input.selfService==='embroidery';
        if(selfEmbroidery)workspace().authorize(session,{embroidery:true});
        const selfWorkUnits = ['cutting','employee'].includes(input.selfService) ? assertCuttingWorker(session) : null;
        const startKey = selfWorkUnits||selfEmbroidery ? String(req.headers['idempotency-key'] || '') : '';
        if (selfWorkUnits||selfEmbroidery) assert(IDEMPOTENCY_PATTERN.test(startKey),422,'INVALID_START_KEY','请重新选择工序后开工。');
        const selfAssignmentId = startKey ? stableHash({kind:boundEmbroidery?'embroidery-bound-start':selfEmbroidery?'embroidery-start':'cutting-start', operatorId:session.id,key:startKey}) : '';
        const findReplay=()=>{
          const row=selfAssignmentId?store.assignmentById(selfAssignmentId):null;
          if(row)assert(row.operatorId===session.id&&row.taskId===Number(input.taskId)&&(!selfEmbroidery||input.flowCode==='projectId='+row.projectId&&(boundEmbroidery||row.machineId===normalizeEmbroideryMachineCode(input.machineId))&&row.embroideryPart===normalizeEmbroideryPart(input.embroideryPart)),409,'START_KEY_REUSED','开工请求已使用，请刷新当前任务。');
          return row;
        };
        const replay = findReplay();
        if (replay) {
          return send(res,200,{assignment:presentAssignment(replay)});
        }
        const flowCode = normalizeFlowCode(input.flowCode);
        const task = await blacklake.findWorkOrderProcess(flowCode, input.taskId);
        if(selfEmbroidery){
          const concurrent=findReplay();
          if(concurrent)return send(res,200,{assignment:presentAssignment(concurrent)});
          assert(flowCode==='projectId='+task.projectId&&Number(input.taskId)===task.taskId&&isEmbroideryProcessName(task.processName)&&!processProgress(task).closed,409,'EMBROIDERY_PROCESS_CHANGED','绣花工单或工序已变化，请重新选择。');
        }
        const selfWorkUnit = selfWorkUnits ? String(input.workUnitId || (selfWorkUnits.length===1?selfWorkUnits[0]:'')) : '';
        if (selfWorkUnits) {
          assert(selfWorkUnits.length?selfWorkUnits.includes(selfWorkUnit):selfWorkUnit==='',409,'SELF_WORK_UNIT_REQUIRED','请选择本人已绑定的工位；未绑定时请留空。');
          const concurrent = store.assignmentById(selfAssignmentId);
          if (concurrent) return send(res,200,{assignment:presentAssignment(concurrent)});
        }
        assertReviewProject(session, task, config);
        const embroidery = isEmbroideryProcessName(task.processName);
        const reportingMode = normalizeReportingMode(input.reportingMode);
        const taskReportingMode = embroidery ? REPORTING_MODES.EMBROIDERY : REPORTING_MODES.STANDARD;
        assertReportingModeAccess(operatorReportingProfile(session), reportingMode === "auto" ? taskReportingMode : reportingMode);
        assert(
          reportingMode === "auto" || reportingMode === taskReportingMode,
          422,
          "REPORTING_MODE_MISMATCH",
          embroidery ? "当前是普通报工模式，请返回并切换到绣花机报工。" : "当前是绣花机报工模式，请返回并切换到普通报工。"
        );
        const machineId = embroidery&&!boundEmbroidery ? normalizeEmbroideryMachineCode(input.machineId) : "";
        const embroideryPart = embroidery ? normalizeEmbroideryPart(input.embroideryPart) : "";
        if (embroidery) {
          assert(
            operatorReportingProfile(session).reportingModes.includes(REPORTING_MODES.EMBROIDERY),
            403,
            "EMBROIDERY_MODE_NOT_ALLOWED",
            "当前人员未绑定绣花部门，不能使用绣花机报工。"
          );
          if(!boundEmbroidery)assert(machineId, 422, "INVALID_EMBROIDERY_MACHINE_CODE", "请先扫描 01–12 号绣花机的机台码。");
          assert(embroideryPart, 422, "INVALID_EMBROIDERY_PART", "请选择前幅或后幅。");
          if(machineId)assert(!store.activeAssignmentByMachine(machineId), 409, "EMBROIDERY_MACHINE_IN_USE", `${machineId} 号机已有进行中的任务，请确认机台或先结束原任务。`);
        }
        const activeAssignments = store.activeAssignments(session.id);
        if (activeAssignments.length) {
          assert(
            !boundEmbroidery && embroidery && activeAssignments.every((assignment) => isEmbroideryProcessName(assignment.processName) && assignment.assignmentMode!==BOUND_EMBROIDERY_ASSIGNMENT),
            409,
            "OPERATOR_ALREADY_WORKING",
            boundEmbroidery?'您已有尚未完成的报工，请先处理当前任务。':"您已有正在生产的任务；只有外协加工绣花工序支持多机并行。"
          );
        }
        const quantity = Number(task.plannedAmount);
        assert(
          Number.isSafeInteger(quantity) && quantity > 0,
          422,
          "BLACKLAKE_PLAN_AMOUNT_INVALID",
          `工序“${task.processName}”没有可用的计划数量，请先在黑湖核对。`
        );
        if(session.scope!=='review'){
          const latestUnits=assertCuttingWorker(session);
          if(selfWorkUnits)assert(latestUnits.length?latestUnits.includes(selfWorkUnit):selfWorkUnit==='',409,'SELF_WORK_UNIT_REQUIRED','工位绑定已变化，请刷新后选择本人当前工位。');
        }
        const assignment = store.claimFlowAssignment({
          id: selfAssignmentId || randomUUID(), operatorId: session.id, ...task,
          ...(selfWorkUnits ? {workUnitId:selfWorkUnit,stationName:selfWorkUnit} : {}),
          quantity,
          machineId,
          embroideryPart,
          baselineReportedAmount: nonNegativeInteger(reportedTaskAmount(task, store.isQualityOperator(session.id))),
          flowCodeHash: stableHash({ projectId: task.projectId }),
          flowCodeHint: String(task.projectId).slice(-4),
          startedAt: shanghaiTimestamp(new Date((now||Date.now)()))
        }, { allowParallel: !boundEmbroidery&&isEmbroideryProcessName(task.processName),boundEmbroidery });
        if (!assignment && selfAssignmentId) {
          const concurrent = findReplay();
          if (concurrent) return send(res,200,{assignment:presentAssignment(concurrent)});
        }
        if (!assignment && machineId && store.activeAssignmentByMachine(machineId)) {
          throw new AppError(409, "EMBROIDERY_MACHINE_IN_USE", `${machineId} 号机刚刚开始了其他任务，请扫描另一台机器。`);
        }
        assert(assignment, 409, "ASSIGNMENT_START_CONFLICT", "开工状态发生变化，请刷新后重试。");
        return send(res, 201, { assignment: presentAssignment(assignment) });
      }

      const finishDefaultMatch = req.method === "GET" && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/finish-default$/);
      if (finishDefaultMatch) {
        const assignmentId = decodeURIComponent(finishDefaultMatch[1]);
        const assignment = store.assignmentById(assignmentId);
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assertReviewProject(session, assignment, config);
        assert(!requiresQuantityReview(assignment), 409, "QUANTITY_REVIEW_REQUIRED", "这笔派单数量待核对，结束时只登记工时，暂不提交产量。");
        assert(assignment.status === "IN_PROGRESS", 409, "ASSIGNMENT_NOT_IN_PROGRESS", "这笔任务尚未开工或已经结束。");

        const localReportedAmount = store.succeededAmountForTaskSince({
          taskId: assignment.taskId,
          projectId: assignment.projectId,
          since: assignment.localReportBaseline == null ? assignment.startedAt : "",
          includeDefects: assignment.isQualityInspection
        });
        const localCumulativeAmount = assignment.baselineReportedAmount + Math.max(0,
          localReportedAmount - (assignment.localReportBaseline ?? 0));
        let blacklakeCumulativeAmount = assignment.baselineReportedAmount;
        try {
          const task = await blacklake.findTaskById(assignment.taskId, { fresh: true });
          blacklakeCumulativeAmount = nonNegativeInteger(reportedTaskAmount(task, assignment.isQualityInspection));
        } catch (error) {
          // 黑湖瞬时查询失败不应阻止工人结束；本地已成功写入的报工仍可给出可靠的并行剩余数。
          console.warn(JSON.stringify({
            event: "finish_default_blacklake_fallback",
            assignmentId,
            code: error.code || "BLACKLAKE_QUERY_FAILED"
          }));
        }
        const cumulativeQuantity = Math.max(localCumulativeAmount, blacklakeCumulativeAmount);
        const remainingQuantity = Math.max(0, assignment.targetQuantity - cumulativeQuantity);
        const machineWorkspace=url.searchParams.get('mode')==='embroidery'&&(!!assignment.machineId||assignment.assignmentMode===BOUND_EMBROIDERY_ASSIGNMENT);
        return send(res, 200, {
          quantityPolicy: "SERVER_DEFAULT",
          targetQuantity: assignment.targetQuantity,
          cumulativeQuantity,
          remainingQuantity,
          defaultQuantity: manualQuantityFor(session) ? null
            : assignment.endedAt&&!machineWorkspace ? assignment.goodQuantity : (remainingQuantity > 0 ? remainingQuantity : null),
          ...(assignment.isQualityInspection ? {
            defectReasons: availableDefectReasons,
            defectCode: defectCodesFromStored(assignment.defectCode)[0] || "",
            defectCodes: defectCodesFromStored(assignment.defectCode)
          } : {})
        });
      }

      const finishMatch = req.method === "POST" && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/finish$/);
      if (finishMatch) {
        const assignmentId = decodeURIComponent(finishMatch[1]);
        const idempotencyKey = String(req.headers["idempotency-key"] || "");
        assert(IDEMPOTENCY_PATTERN.test(idempotencyKey), 400, "INVALID_IDEMPOTENCY_KEY", "提交标识无效，请返回后重新确认。");
        const assignment = store.assignmentById(assignmentId);
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assertReviewProject(session, assignment, config);
        const input = await jsonBody(req);
        if (assignment.status === "QUANTITY_PENDING") return send(res, 200, { assignment: presentAssignment(assignment), quantityReviewPending: true, replayed: true });
        assert(!(assignment.status === "IN_PROGRESS" && input.quantityPolicy === "PENDING_REVIEW"), 409, "REPORT_QUANTITY_CONFIRMATION_REQUIRED", "正常报工已恢复数量确认，请刷新任务并使用新版数量确认页；不能只登记工时或用默认数自动代报。");
        assert(!(assignment.status === "IN_PROGRESS" && assignment.reportId), 409, "REPORT_RESULT_UNKNOWN", "这笔任务仍有关联报工记录，请先核对黑湖结果，不要重复提交。");
        const quantity = input.quantity === undefined ? assignment.goodQuantity : Number(input.quantity);
        const defectQuantity = input.defectQuantity === undefined ? 0 : Number(input.defectQuantity);
        assert(Number.isSafeInteger(defectQuantity) && defectQuantity >= 0, 422, "INVALID_DEFECT_QUANTITY", "不良数必须是 0 或正整数。");
        assert(assignment.isQualityInspection || defectQuantity === 0, 422, "NOT_QUALITY_PROCESS", "当前报工身份为普通人员，不能填写不良数；请联系管理员核对身份。");
        const requestedDefectCodes = (Array.isArray(input.defectCodes)
          ? input.defectCodes
          : input.defectCode ? [input.defectCode] : [])
          .map((code) => String(code || "").normalize("NFKC").trim())
          .filter((code, index, codes) => code && codes.indexOf(code) === index);
        if (defectQuantity > 0) {
          assert(availableDefectReasons.length > 0, 503, "DEFECT_REASONS_UNAVAILABLE", "不良原因尚未配置，请联系班组长。");
          assert(requestedDefectCodes.length > 0, 422, "DEFECT_REASON_REQUIRED", "有不良数时，请至少选择一个不良原因。");
          assert(requestedDefectCodes.every((code) => defectReasonByCode.has(code)), 422, "INVALID_DEFECT_REASON", "请选择列表中的不良原因。");
          assert(requestedDefectCodes.length <= defectQuantity, 422, "TOO_MANY_DEFECT_REASONS", "不良原因不能多于不良件数。");
        }
        const defectCodes = defectQuantity > 0 ? requestedDefectCodes : [];
        const defectCode = defectCodes.join(",");
        let defectItems;
        if(input.defectItems!==undefined){
          assert(Array.isArray(input.defectItems)&&input.defectItems.length===defectCodes.length&&new Set(input.defectItems.map(row=>row?.code)).size===input.defectItems.length&&input.defectItems.every(row=>row&&Object.keys(row).every(key=>['code','amount'].includes(key))&&defectCodes.includes(row.code)&&Number.isSafeInteger(row.amount)&&row.amount>0)&&input.defectItems.reduce((sum,row)=>sum+row.amount,0)===defectQuantity,422,'INVALID_DEFECT_DISTRIBUTION','请核对各不良品项数量，合计须等于不良数。');
          defectItems=[...input.defectItems].sort((a,b)=>a.code.localeCompare(b.code));
        }
        assert(Number.isSafeInteger(quantity) && quantity >= 0 && Number.isSafeInteger(quantity + defectQuantity) && quantity + defectQuantity > 0,
          422, "INVALID_REPORT_QUANTITY", assignment.isQualityInspection ? "请填写合格数和不良数，两项合计必须大于 0。" : "报工数量必须是大于 0 的整数。");
        const requestHash = stableHash({ operatorId: session.id, assignmentId, quantity, ...(defectQuantity ? { defectQuantity, defectCodes } : {}),...(defectItems?{defectItems}:{}) });
        const existing = store.reportByKey(idempotencyKey);
        const completionVersion=()=>session.scope!=='review'&&!assignment.machineId&&assignment.assignmentMode!==BOUND_EMBROIDERY_ASSIGNMENT&&entryProfile(session).appRole==='employee'
          ?{version:workspace().version(session)}:{};
        const groupSaved=(report,replayed)=>({
          assignment:presentAssignment(store.assignmentById(assignmentId)),report:publicReport(report),
          accepted:true,queued:false,status:groupApprovalPending,pendingGroupApproval:true,replayed,
          ...completionVersion()
        });
        if (existing) {
          assert(existing.request_hash === requestHash, 409, "IDEMPOTENCY_CONFLICT", "这次提交的内容已经改变，请返回后重新确认。");
          if(existing.status===groupApprovalPending)return send(res,200,groupSaved(existing,true));
          const queued=reportOutbox?.jobs.byKey('create:'+idempotencyKey);if(queued)return send(res,200,{assignment:presentAssignment(store.assignmentById(assignmentId)),report:publicReport(existing),...reportOutbox.receipt(queued),...completionVersion(),replayed:true});
          if (existing.status === "SUCCEEDED") return send(res, 200, { assignment: presentAssignment(store.assignmentById(assignmentId)), ...completionVersion(), replayed: true });
          if (existing.status === "PENDING") throw new AppError(409, "REPORT_PENDING", "这笔报工正在处理中，请稍后查看最近报工，不要重复点击。");
          if (existing.status === "UNKNOWN") throw new AppError(409, "REPORT_RESULT_UNKNOWN", "这笔报工已保留，黑湖结果尚未确认，请勿重复提交。");
          if (existing.status === "FAILED" && existing.error_code === "TASK_CLOSED") {
            throw new AppError(409, "TASK_CLOSED", existing.error_message || "黑湖工序已结束，本地任务已自动退出，可以重新扫码。");
          }
          if (isWorkOrderMissingFailure(existing)) {
            throw workOrderMissingError(existing.error_message);
          }
          throw new AppError(409, "REPORT_FAILED", existing.error_message || "这笔报工上次没有成功，请返回后重新提交。");
        }
        const needsGroupApproval=manualQuantityFor(session);
        if (needsGroupApproval) {
          assert((typeof input.quantity === "number" || typeof input.quantity === "string")
            && String(input.quantity).trim() !== "", 422, "REPORT_QUANTITY_REQUIRED", "请填写本次实际报工数量。");
        }
        const unsettled = store.unsettledByHash(requestHash);
        if (unsettled) {
          throw new AppError(409, "REPORT_RESULT_UNKNOWN", "刚才的相同报工已保留，黑湖结果尚未确认，请勿重复提交。");
        }
        assert(!store.orderRemoved(assignment.projectId),409,'WORK_ORDER_DELETED','黑湖已删除这张工单，未提交报工，原工时保留。');

        assert(assignment.status === "IN_PROGRESS", 409, "ASSIGNMENT_NOT_IN_PROGRESS", "这笔任务尚未开工或已经结束。");
        const endedAt = assignment.endedAt || shanghaiTimestamp(new Date(now ? now() : Date.now()));
        const durationSeconds = secondsBetween(assignment.startedAt, endedAt);
        const report = {
          id: randomUUID(), idempotencyKey, requestHash, operatorId: session.id,
          taskId: assignment.taskId, projectId: assignment.projectId, projectCode: assignment.projectCode,
          productName: assignment.productName, processName: assignment.processName,
          amount: quantity + defectQuantity, goodAmount: quantity,
          defectAmount: defectQuantity, defectCode, outputTime: endedAt,...(defectItems?{defectItems}:{})
        };
        let syncJob;
        const prepared = store.prepareAssignmentCompletion({
          assignmentId, operatorId: session.id, endedAt, durationSeconds, assessment: null, report,
          onPrepared:()=>{
            if(needsGroupApproval)groupReportReview.save(report,assignment,session);
            else if(reportOutbox&&session.scope!=='review')syncJob=reportOutbox.acceptCreate({report,assignment,operator:session,endedAt});
          }
        });
        assert(prepared, 409, "ASSIGNMENT_FINISH_CONFLICT", "任务状态已经变化，请刷新页面。");
        if(needsGroupApproval)return send(res,201,groupSaved(store.reportById(report.id),false));
        if(syncJob)return send(res,202,{assignment:presentAssignment(store.assignmentById(assignmentId)),report:publicReport(store.reportById(report.id)),...reportOutbox.receipt(syncJob),...completionVersion(),replayed:false});

        try {
          const result = await blacklake.createOutput({
            reportId: report.id,
            operator: session,
            task: {
              taskId: assignment.taskId, projectId: assignment.projectId,
              projectCode: assignment.projectCode
            },
            amount: quantity + defectQuantity,
            defectAmount: defectQuantity,
            defectCode: defectCodes[0] || "",
            defectCodes,
            ...(defectItems?{defectItems}:{}),
            outputTime: endedAt,
            actualStartedAt: assignment.startedAt,
            actualEndedAt: endedAt
          });
          let submittedReport,completed;
          store.db.exec('BEGIN IMMEDIATE');
          try{
            assertNewOutputLink(store.db,report.id,result?.id);
            submittedReport=store.markReportSucceeded(idempotencyKey,result.id);
            completed=store.completeAssignment(assignmentId);
            store.db.exec('COMMIT');
          }catch(error){store.db.exec('ROLLBACK');throw error;}
          return send(res, 201, { assignment: presentAssignment(completed), report: publicReport(submittedReport), ...completionVersion(), replayed: false });
        } catch (error) {
          if (error.writeOutcomeUnknown||["BLACKLAKE_TIMEOUT", "BLACKLAKE_UNAVAILABLE"].includes(error.code)) {
            store.markReportUnknown(idempotencyKey, error.code, "报工已保留，黑湖结果尚未确认，请勿重复提交。");
            store.reviewAssignment(assignmentId);
          } else if (error.code === "TASK_CLOSED") {
            const message = "黑湖工序已结束，本地任务已自动退出，可以重新扫码。";
            const cancelled = store.cancelAssignmentAfterRejectedReport({
              assignmentId,
              idempotencyKey,
              errorCode: "TASK_CLOSED",
              errorMessage: message,
              reason: "黑湖工序已结束，系统自动退出未完成报工"
            });
            if (!cancelled) {
              store.markReportFailed(idempotencyKey, "TASK_CLOSED", message);
              store.restoreAssignmentAfterFailure(assignmentId);
            }
            throw new AppError(409, "TASK_CLOSED", message);
          } else {
            const workOrderMissing = isWorkOrderMissingFailure(error);
            store.markReportFailed(
              idempotencyKey,
              workOrderMissing ? "WORK_ORDER_NOT_FOUND" : (error.code || "BLACKLAKE_ERROR"),
              error.message || "报工失败"
            );
            store.restoreAssignmentAfterFailure(assignmentId);
            if (workOrderMissing) throw workOrderMissingError(error.message);
          }
          throw error;
        }
      }

      const workerCancelMatch = req.method === "POST" && url.pathname.match(/^\/v1\/assignments\/([^/]+)\/cancel$/);
      if (workerCancelMatch) {
        const assignmentId = decodeURIComponent(workerCancelMatch[1]);
        const assignment = store.assignmentById(assignmentId);
        assert(assignment && assignment.operatorId === session.id, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。");
        assertReviewProject(session, assignment, config);
        assert(
          store.canWorkerCancelAssignment(assignmentId, session.id),
          409,
          "WORKER_CANCELLATION_NOT_ALLOWED",
          "只有黑湖明确提示工单已删除或不存在时，才能退出这单。其他情况请联系班组长。"
        );
        const cancelled = store.cancelAssignment(
          assignmentId,
          "黑湖工单已删除，工人取消未完成报工",
          shanghaiTimestamp(),
          "AUTHENTICATED_OPERATOR"
        );
        assert(cancelled, 409, "ASSIGNMENT_NOT_CANCELLABLE", "这笔任务的状态已经改变，请刷新后查看。");
        return send(res, 200, { assignment: presentAssignment(cancelled) });
      }

      throw new AppError(404, "NOT_FOUND", "接口不存在。");
    } catch (error) {
      const response = publicError(error);
      return send(res, response.status, response.body);
    } finally {
      const safePath = String(req.url || "").split("?")[0];
      console.log(JSON.stringify({ requestId, method: req.method, path: safePath, durationMs: Date.now() - startedAt }));
    }
  };
}

function requireSession(req, store) {
  const token = bearer(req);
  if (!token) throw new AppError(401, "UNAUTHORIZED", "登录已失效，请重新登录。");
  const session = store.session(token);
  if (!session) throw new AppError(401, "UNAUTHORIZED", "登录已失效，请重新登录。");
  return session;
}

function isWorkOrderMissingFailure(value) {
  const code = String(value?.code || value?.error_code || "").toUpperCase();
  const message = String(value?.message || value?.error_message || "");
  return code === "WORK_ORDER_NOT_FOUND" || /工单(?:编号)?.{0,20}(?:不存在|已删除)/.test(message);
}

function workOrderMissingError(detail) {
  const message = String(detail || "");
  return new AppError(
    409,
    "WORK_ORDER_NOT_FOUND",
    message.includes("工单") ? message : "黑湖中已找不到这张工单。可以退出这单，不会向黑湖提交数量。"
  );
}

function isReviewProjectAllowed(session, resource, config) {
  if (session.scope !== "review") return true;
  const projectId = optionalPositiveInteger(resource?.projectId);
  return Boolean(projectId && config.review?.allowedProjectIds?.includes(projectId));
}

function assertReviewProject(session, resource, config) {
  assert(
    isReviewProjectAllowed(session, resource, config),
    403,
    "REVIEW_WORK_ORDER_ONLY",
    "审核体验只能使用提审备注中指定的黑湖测试工单。"
  );
}

function bearer(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new AppError(413, "PAYLOAD_TOO_LARGE", "请求内容太大。");
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw new AppError(400, "INVALID_JSON", "请求格式不正确。"); }
}

function send(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (status === 204) return res.end();
  res.end(JSON.stringify(body));
}

function sendAsset(res, body, contentType, cacheControl = "no-store") {
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function normalizeReportingMode(value) {
  const mode = String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!mode) return "auto";
  assert(
    [REPORTING_MODES.STANDARD, REPORTING_MODES.EMBROIDERY].includes(mode),
    422,
    "INVALID_REPORTING_MODE",
    "请选择正确的报工模式。"
  );
  return mode;
}

function assertReportingModeAccess(profile, reportingMode) {
  if (reportingMode === "auto") return;
  assert(
    profile.reportingModes.includes(reportingMode),
    403,
    reportingMode === REPORTING_MODES.EMBROIDERY ? "EMBROIDERY_MODE_NOT_ALLOWED" : "REPORTING_MODE_NOT_ALLOWED",
    reportingMode === REPORTING_MODES.EMBROIDERY
      ? "当前人员没有绣花机报工权限。"
      : "当前人员没有切换到普通报工的权限。"
  );
}

function publicOperatorChoices(operators) {
  const nameCounts = new Map();
  for (const operator of operators) nameCounts.set(operator.name, (nameCounts.get(operator.name) || 0) + 1);
  return operators.map((operator) => ({
    blacklakeOperatorId: operator.blacklakeOperatorId,
    name: operator.name,
    description: operator.identitySource==='LOCAL' ? `本系统成员 · ${operator.memberCode}${operator.groupNames?.length ? " · "+operator.groupNames.join("、") : ""}` : operator.groupNames?.length
      ? operator.groupNames.join("、")
      : nameCounts.get(operator.name) > 1
        ? `同名人员 · 编号尾号 ${String(operator.blacklakeOperatorId).slice(-4)}`
        : ""
  }));
}

function publicReport(report) {
  const defectCodes = defectCodesFromStored(report.defect_code);
  return {
    id: report.id,
    projectCode: report.project_code,
    productName: report.product_name,
    processName: report.process_name,
    amount: report.amount,
    goodAmount: report.good_amount,
    defectAmount: report.defect_amount,
    defectCode: defectCodes[0] || "",
    defectCodes,
    status: report.status,
    outputTime: report.output_time,
    ...(report.submissionIdentity?{submissionIdentity:report.submissionIdentity}:{})
  };
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    projectCode: task.projectCode,
    productName: task.productName,
    processName: task.processName,
    processCode: task.processCode,
    stationName: task.stationName,
    plannedAmount: task.plannedAmount,
    completedAmount: task.completedAmount,
    dueDate: task.dueDate || "",
    unit: task.unit
  };
}

function publicAdminWorkOrders(projects, tasks, snapshots = []) {
  return projects.map((project, index) => {
    const processes = snapshots[index]?.tasks ?? tasks.filter((task) => Number.isSafeInteger(Number(project.projectId)) && Number(project.projectId) > 0
      ? task.projectId === Number(project.projectId)
      : task.projectCode === project.projectCode);
    const datedProcesses = processes.filter((task) => task.dueDate);
    const dueProcess = datedProcesses.find((task) => comparableProcessName(task.processName) === "外协加工KL") ||
      datedProcesses.find((task) => comparableProcessName(task.processName) === "外协加工") || datedProcesses.at(-1);
    return {
      // A code-only legacy record is ambiguous when Blacklake reuses a work-order
      // code. Do not promote it to whichever projectId a code lookup returns.
      projectId: optionalPositiveInteger(project.projectId),
      projectCode: project.projectCode || processes[0]?.projectCode || "",
      productName: processes[0]?.productName || "",
      dueDate: dueProcess?.dueDate || "",
      processSync: snapshots[index]?.sync,
      processes: processes.map((task) => ({
        taskId: task.taskId,
        sequence: task.sequence,
        processName: task.processName,
        processCode: task.processCode,
        stationName: task.stationName,
        plannedAmount: task.plannedAmount,
        reportedAmount: task.reportedGoodAmount ?? task.completedAmount ?? 0,
        remainingAmount: task.remnantAmount ?? Math.max(0, (task.plannedAmount || 0) - (task.reportedGoodAmount || task.completedAmount || 0)),
        processStatus: task.processStatus,
        processStatusDisplay: task.processStatusDisplay,
        dueDate: task.dueDate || "",
        unit: task.unit
      }))
    };
  });
}

function comparableProcessName(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

function publicBlacklakeOutput(output, task) {
  const id = String(output.id ?? "").trim();
  const taskId = optionalPositiveInteger(output.taskId);
  const quantity = nonNegativeInteger(output.workreportQuantity ?? output.numberofgoodProducts);
  if (!id || !taskId || quantity <= 0) return null;
  const startedAt = String(output.starttimeofReport || output.createdAt || "");
  const endedAt = String(output.endtimeofReport || output.updatedAt || output.createdAt || "");
  const durationSeconds = nonNegativeInteger(output.effectiveTime);
  const defectItems = Array.isArray(output.defectItemList) ? output.defectItemList : [];
  const defectCodes = defectItems.map((item) => String(item?.code || "").trim()).filter(Boolean);
  const defectReasonNames = defectItems.map((item) => String(item?.defectName || item?.name || item?.defectItemName || "").trim()).filter(Boolean);
  return {
    id: `blacklake-${id}`,
    source: "黑湖报工",
    operatorName: String(output.productionStaff || "未知人员"),
    projectId: optionalPositiveInteger(output.projectId),
    projectCode: String(output.projectCode || task?.projectCode || ""),
    taskId,
    productName: String(output.productName || task?.productName || "未命名产品"),
    processName: String(task?.processName || output.processName || output.processCode || "未命名工序"),
    stationName: String(task?.stationName || ""),
    quantity,
    goodQuantity: nonNegativeInteger(output.numberofgoodProducts ?? quantity),
    defectQuantity: nonNegativeInteger(output.numberofDefectives),
    defectCode: defectCodes[0] || "",
    defectCodes,
    defectReasonName: defectReasonNames.join("、"),
    status: "COMPLETED",
    productionStatus: "COMPLETED",
    publishedBy: "黑湖同步",
    attemptNumber: 1,
    publishedAt: startedAt,
    startedAt,
    endedAt,
    durationSeconds,
    effectiveDurationSeconds: durationSeconds,
    durationAssessment: null,
    hasProductionAnomaly: false,
    productionAnomalies: []
  };
}

function publicProcessOption(task) {
  return {
    taskId: task.taskId,
    sequence: task.sequence,
    processName: task.processName,
    stationName: task.stationName,
    processStatusDisplay: task.processStatusDisplay,
    defaultQuantity: task.plannedAmount,
    quantitySource: 'PLAN_AMOUNT'
  };
}

function groupDispatchProcessRecommendations(processes, history = {}) {
  const options = processes.map(publicProcessOption);
  const key = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const optionsByName = new Map();
  for (const option of options) {
    const name = key(option.processName);
    if (!optionsByName.has(name)) optionsByName.set(name, []);
    optionsByName.get(name).push(option);
  }
  const takeRanked = (rows, excluded = new Set()) => {
    const selected = [];
    const selectedNames = new Set();
    for (const row of rows || []) {
      const name = key(row.processName);
      if (!name || excluded.has(name) || selectedNames.has(name) || !optionsByName.has(name)) continue;
      selectedNames.add(name);
      selected.push(...optionsByName.get(name));
    }
    return { selected, selectedNames };
  };
  const frequent = takeRanked(history.supervisorFrequent);
  const system = takeRanked(history.systemRecommended, frequent.selectedNames);
  const recommendedNames = new Set([...frequent.selectedNames, ...system.selectedNames]);
  return {
    supervisorFrequent: frequent.selected,
    systemRecommended: system.selected,
    otherProcesses: options.filter((option) => !recommendedNames.has(key(option.processName)))
  };
}

function mergeProcessPreferenceRows(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const processName = String(row?.processName || "").normalize("NFKC").trim();
    if (!processName) continue;
    const key = processName.toLocaleLowerCase("zh-CN");
    const current = merged.get(key) || { processName, useCount: 0, lastUsedAt: "" };
    current.useCount += Math.max(0, Number(row.useCount) || 0);
    if (String(row.lastUsedAt || "") > current.lastUsedAt) current.lastUsedAt = String(row.lastUsedAt || "");
    merged.set(key, current);
  }
  return [...merged.values()].toSorted((left, right) =>
    right.useCount - left.useCount
    || right.lastUsedAt.localeCompare(left.lastUsedAt)
    || left.processName.localeCompare(right.processName, "zh-CN")
  );
}

function preferredEmbroideryProcess(processes = []) {
  return processes
    .filter((process) => isEmbroideryProcessName(process.processName))
    .toSorted((left, right) => Number(/KL\s*$/i.test(right.processName)) - Number(/KL\s*$/i.test(left.processName)))[0]
    || null;
}

function requiresQuantityReview(assignment) {
  return assignment?.status === "QUANTITY_PENDING";
}

function publicAssignment(assignment, defectReasonByCode = new Map()) {
  if (!assignment) return null;
  const defectCodes = defectCodesFromStored(assignment.defectCode);
  return {
    id: assignment.id,
    source: "现场报工",
    ...(assignment.submissionIdentity?{submissionIdentity:assignment.submissionIdentity}:{}),
    operatorName: assignment.operatorName,
    projectId: assignment.projectId,
    projectCode: assignment.projectCode,
    taskId: assignment.taskId,
    productName: assignment.productName,
    processName: assignment.processName,
    stationName: assignment.stationName,
    machineId: assignment.machineId || "",
    embroideryPart: assignment.embroideryPart || "",
    quantity: assignment.quantity,
    targetQuantity: assignment.targetQuantity,
    cancellationReason: assignment.cancellationReason || null,
    goodQuantity: assignment.goodQuantity,
    defectQuantity: assignment.defectQuantity,
    defectCode: defectCodes[0] || "",
    defectCodes,
    defectReasonName: defectCodes.map((code) => defectReasonByCode.get(code)?.name || "").filter(Boolean).join("、"),
    isQualityInspection: assignment.isQualityInspection,
    isEmbroidery: isEmbroideryProcessName(assignment.processName),
    isDispatched: assignment.assignmentMode === "DISPATCHED",
    quantityPolicy: requiresQuantityReview(assignment) ? "PENDING_REVIEW" : "SERVER_DEFAULT",
    quantityPending: assignment.status === "QUANTITY_PENDING",
    dispatchBatchId: assignment.dispatchBatchId || "",
    minDurationSeconds: null,
    maxDurationSeconds: null,
    status: assignment.status,
    publishedBy: assignment.publishedBy,
    attemptNumber: assignment.attemptNumber,
    publishedAt: assignment.publishedAt,
    startedAt: assignment.startedAt,
    pauses: assignment.pauses || [],
    paused: Boolean(assignment.paused),
    timingRevision: assignment.timingRevision || 0,
    endedAt: assignment.endedAt,
    durationSeconds: assignment.durationSeconds,
    effectiveDurationSeconds: assignment.effectiveDurationSeconds ?? assignment.durationSeconds,
    durationAssessment: assignment.durationAssessment,
    hasProductionAnomaly: Boolean(assignment.hasProductionAnomaly),
    productionStatus: assignment.productionStatus || assignment.status,
    productionAnomalies: (assignment.productionAnomalies || []).map((anomaly) => ({
      code: anomaly.code,
      title: anomaly.title,
      message: anomaly.message,
      severity: anomaly.severity,
      scope: anomaly.scope,
      elapsedSeconds: anomaly.elapsedSeconds,
      thresholdSeconds: anomaly.thresholdSeconds,
      baselineSeconds: anomaly.baselineSeconds ?? null,
      baselineSampleCount: anomaly.baselineSampleCount ?? 0,
      referenceAt: anomaly.referenceAt
    }))
  };
}

function defectCodesFromStored(value) {
  return String(value || "").split(",").map((code) => code.trim()).filter(Boolean);
}

function publicAnomalyRules(rules = {}) {
  return {
    deadlineGraceMinutes: Math.round((rules.deadlineGraceSeconds || 0) / 60),
    durationBaselineMinSamples: rules.durationBaselineMinSamples || 0,
    durationMultiplier: rules.durationMultiplier || 0,
    durationMinimumExcessMinutes: Math.round((rules.durationMinimumExcessSeconds || 0) / 60)
  };
}

function requireAdmin(req, config) {
  const key = String(req.headers["x-admin-key"] || "");
  const proxySecret = String(req.headers["x-admin-proxy-secret"] || "");
  const keyAccepted = Boolean(key) && safeEqualText(key, config.adminApiKey);
  const proxyAccepted = Boolean(config.adminProxySecret) && Boolean(proxySecret) && safeEqualText(proxySecret, config.adminProxySecret);
  if (!keyAccepted && !proxyAccepted) throw new AppError(401, "ADMIN_UNAUTHORIZED", "请先使用钉钉登录。");
}

function bindingError(status) {
  const errors = {
    CHALLENGE_INVALID: [401, "BINDING_EXPIRED", "首次绑定已过期，请重新打开小程序。"],
    OPERATOR_NOT_APPROVED: [409, "CONFIRMATION_CODE_REQUIRED", "请让班组长先为这个人生成确认码。"],
    CODE_INVALID: [422, "CONFIRMATION_CODE_INVALID", "确认码不正确，请让班组长核对。"],
    TOO_MANY_ATTEMPTS: [429, "TOO_MANY_CONFIRMATION_ATTEMPTS", "确认码错误次数过多，请重新打开小程序。"],
    WECHAT_ALREADY_BOUND: [409, "WECHAT_ALREADY_BOUND", "这个微信已经绑定其他人，请联系班组长。"],
    OPERATOR_ALREADY_BOUND: [409, "OPERATOR_ALREADY_BOUND", "这个人已经绑定其他微信，请让班组长先解除旧绑定。"]
  };
  const [httpStatus, code, message] = errors[status] || [500, "BINDING_FAILED", "绑定失败，请联系管理员。"]; 
  return new AppError(httpStatus, code, message);
}

function normalizeFlowCode(value) {
  const code = String(value || "").trim();
  assert(code.length >= 2 && code.length <= 1024, 400, "INVALID_FLOW_CODE", "流转码不正确，请重新扫描。");
  return code;
}

function normalizeStationCode(value) {
  let code = String(value || "").normalize("NFKC").trim();
  assert(code.length >= 1 && code.length <= 1024, 400, "INVALID_STATION_PROCESS_CODE", "工序码不正确，请重新扫描。");
  let taskIdText = "";
  try {
    const url = new URL(code);
    taskIdText = url.searchParams.get("taskId") ||
      url.searchParams.get("task_id") ||
      url.searchParams.get("taskid") || "";
    code = url.searchParams.get("processCode") ||
      url.searchParams.get("process_code") ||
      url.searchParams.get("code") || "";
  } catch {
    const taskMatch = code.match(/^(?:TASK(?:_?ID)?)\s*[:=]\s*(\d+)$/i);
    if (taskMatch) {
      taskIdText = taskMatch[1];
      code = "";
    } else {
      code = code.replace(/^(?:PROCESS(?:_?CODE)?)\s*[:=]\s*/i, "").trim();
    }
  }
  if (taskIdText) {
    const taskId = Number(taskIdText);
    assert(
      Number.isSafeInteger(taskId) && taskId > 0,
      400,
      "INVALID_STATION_PROCESS_CODE",
      "工序二维码中的任务编号不正确。"
    );
    return { taskId, processCode: "" };
  }
  code = code.trim();
  assert(
    code.length >= 1 && code.length <= 100 && !/[\u0000-\u001f\u007f]/.test(code),
    400,
    "INVALID_STATION_PROCESS_CODE",
    "工序二维码必须包含有效的黑湖工序编码。"
  );
  return { taskId: null, processCode: code };
}

function comparableProcessCode(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleUpperCase("en-US");
}

function shanghaiTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function secondsBetween(start, end) {
  const seconds = effectiveWorkSecondsBetween(start, end);
  assert(Number.isFinite(seconds), 500, "INVALID_ASSIGNMENT_TIME", "任务时间记录异常，请联系管理员。");
  return seconds;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function optionalPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
