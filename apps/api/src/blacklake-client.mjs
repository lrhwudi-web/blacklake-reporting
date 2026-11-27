import { createHash } from "node:crypto";
import {AsyncLocalStorage} from 'node:async_hooks';
import { AppError, assert } from "./errors.mjs";
import {materialFieldPayload,customFieldReadbackMatches} from './report-custom-fields.mjs';
import {readNativeReport,prepareNativeCorrection,writeNativeCorrection} from './native-report-correction.mjs';
import {inspectCreateReceipt,readCreatedOutput,unknownCreateOutcome} from './report-create-receipt.mjs';
import {timestampMs} from './work-time.mjs';

const MOCK_OPERATORS = [
  { name: "张师傅", phone: "13800138001", blacklakeOperatorId: 31001 },
  { name: "王阿姨", phone: "13800138002", blacklakeOperatorId: 31002 }
];

const MOCK_TASKS = [
  {
    taskId: 880101,
    projectId: 65001,
    projectCode: "GD-2026-0812-01",
    productCode: "SKU-A12",
    productName: "铝合金支架 A12",
    processName: "去毛刺",
    processCode: "GX-01",
    stationName: "3号工作台",
    plannedAmount: 120,
    completedAmount: 48,
    unit: "件",
    sequence: 1,
    processStatus: 10,
    processStatusDisplay: "执行中",
    reportedGoodAmount: 0,
    remnantAmount: 120
  },
  {
    taskId: 880102,
    projectId: 65001,
    projectCode: "GD-2026-0812-01",
    productCode: "SKU-A12",
    productName: "连接板 B06",
    processName: "外观检查",
    processCode: "GX-02",
    stationName: "质检台",
    plannedAmount: 80,
    completedAmount: 20,
    unit: "件",
    sequence: 2,
    processStatus: 0,
    processStatusDisplay: "未开始",
    reportedGoodAmount: 0,
    remnantAmount: 80
  }
];

const mockFlowIndexes = new Map();

// Confirmed OpenAPI shape: customFieldValues[name=图片, type=11].value is an HTTPS URL.
// Unrelated attachments and work-order QR codes are not product images.
function workOrderProductImages(row) {
  const images = [];
  for (const field of Array.isArray(row.customFieldValues) ? row.customFieldValues : []) {
    if ((field.name || field.customFieldMetadata?.name) !== "图片") continue;
    if (field.customFieldMetadata?.type != null && Number(field.customFieldMetadata.type) !== 11) continue;
    if (typeof field.value !== "string" || !field.value.trim()) continue;
    try {
      const url = new URL(field.value.trim());
      if (url.protocol !== "https:" || url.username || url.password) continue;
      if (!images.includes(url.href)) images.push(url.href);
    } catch { /* A missing picture must not break SKU search. */ }
  }
  return images.slice(0, 8);
}

export class BlacklakeClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cachedToken = config.staticToken || "";
    this.loginPromise = null;
    this.taskCache = new Map();
    this.outputProjectCodes = new Map();
    this.operatorCache = null;
    this.workOrderCatalog = null;
    this.workOrderCatalogPromise = null;
    this.writeChain = Promise.resolve();
    this.priorityContext=new AsyncLocalStorage();
    this.repeatedReadContext=new AsyncLocalStorage();
    this.repeatReads=new Map();
    // Native web contract + real test 444384123 verified and restored 2026-11-10.
    this.supportsFullReportCorrection = true;
  }

  withPriority(fn){return this.priorityContext.run(true,fn);}
  withDeferredRepeatedReads(fn){return this.repeatedReadContext.run(true,fn);}

  async verifyOperator({ name, phone }) {
    if (this.config.mode === "mock") {
      const operator = MOCK_OPERATORS.find((item) => item.name === name && item.phone === phone);
      if (!operator) throw new AppError(404, "OPERATOR_NOT_FOUND", "姓名或手机号不对，请检查后再试。");
      return operator;
    }

    // OpenAPI 文档未提供稳定的“按姓名+手机号查人员”契约。
    // 正式环境先由管理员通过 operator:add 建立经核验的人员映射，避免每次登录全量拉取人员。
    throw new AppError(404, "OPERATOR_NOT_BOUND", "您的账号还没有绑定，请联系班组长。此提示只需处理一次。");
  }

  async listOperators({ fresh = false } = {}) {
    if (this.config.mode === "mock") {
      return MOCK_OPERATORS.map((operator) => ({
        blacklakeOperatorId: operator.blacklakeOperatorId,
        name: operator.name,
        groupNames: []
      }));
    }
    if (!fresh && this.operatorCache?.expiresAt > Date.now()) {
      return this.operatorCache.operators.map((operator) => ({ ...operator, groupNames: [...operator.groupNames] }));
    }

    const operators = [];
    const pageSize = 100;
    for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
      const response = await this.request(this.config.userQueryPath, {
        page: { pageNum, pageSize }
      });
      const page = unwrapList(response);
      for (const raw of page) {
        const blacklakeOperatorId = Number(pick(raw, ["id", "userId", "operatorId"]));
        const name = String(pick(raw, ["name", "realName", "displayName", "username"]) || "").trim();
        if (!Number.isSafeInteger(blacklakeOperatorId) || blacklakeOperatorId <= 0 || !name || raw.fake === true) continue;
        operators.push({
          blacklakeOperatorId,
          name,
          groupNames: Array.isArray(raw.groupNames) ? raw.groupNames.map(String).filter(Boolean) : []
        });
      }
      if (page.length < pageSize) break;
      if (pageNum === 100) throw new AppError(502, "BLACKLAKE_OPERATOR_PAGINATION_LIMIT", "黑湖人员数量超过查询上限，请联系管理员。");
    }

    const unique = [...new Map(operators.map((operator) => [operator.blacklakeOperatorId, operator])).values()]
      .toSorted((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.blacklakeOperatorId - right.blacklakeOperatorId);
    this.operatorCache = { operators: unique, expiresAt: Date.now() + 5 * 60_000 };
    return unique.map((operator) => ({ ...operator, groupNames: [...operator.groupNames] }));
  }

  async findTask(criteria) {
    const tasks = await this.listTasks(criteria);
    const task = tasks.find((item) =>
      (!criteria.taskId || item.taskId === criteria.taskId) &&
      (!criteria.projectCode || item.projectCode === criteria.projectCode) &&
      (!criteria.processCode || item.processCode === criteria.processCode)
    );
    if (!task) throw new AppError(404, "TASK_NOT_FOUND", "没有找到这个任务，请检查任务 ID 和工单号。");
    return { ...task };
  }

  async findTaskById(taskId, { fresh = false } = {}) {
    const normalizedTaskId = Number(taskId);
    if (!Number.isSafeInteger(normalizedTaskId) || normalizedTaskId <= 0) {
      throw new AppError(400, "INVALID_STATION_PROCESS_CODE", "工序二维码中的任务编号不正确。");
    }
    if (this.config.mode === "mock") {
      const task = MOCK_TASKS.find((item) => item.taskId === normalizedTaskId);
      if (!task) throw stationProcessNotFound();
      return { ...task };
    }

    const cacheKey = `task-by-id:${normalizedTaskId}`;
    const cached = this.taskCache.get(cacheKey);
    if (!fresh && cached && cached.expiresAt > Date.now()) return { ...cached.task };

    const response = await this.request(this.config.taskQueryPath, {
      id: normalizedTaskId,
      page: { pageNum: 1, pageSize: 20 }
    });
    const matches = unwrapList(response)
      .filter((item) => Number(pick(item, ["id", "taskId", "projectProcessId"])) === normalizedTaskId)
      .map((item) => normalizeTask(item, {}));
    if (matches.length !== 1) throw stationProcessNotFound();
    const task = matches[0];
    this.taskCache.set(cacheKey, { task, expiresAt: Date.now() + 60_000 });
    return { ...task };
  }

  async listTasks(criteria) {
    if (this.config.mode === "mock") {
      return MOCK_TASKS.filter((item) =>
        (!criteria.taskId || item.taskId === criteria.taskId) &&
        (!criteria.projectCode || item.projectCode === criteria.projectCode) &&
        (!criteria.processCode || item.processCode === criteria.processCode)
      ).map((item) => ({ ...item }));
    }

    const cacheKey = `tasks:${JSON.stringify(criteria)}`;
    const cached = this.taskCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.tasks.map((task) => ({ ...task }));

    const request = { page: { pageNum: 1, pageSize: 20 } };
    if (!criteria.projectCode) {
      throw new AppError(400, "PROJECT_CODE_REQUIRED", "正式环境的任务码必须包含工单编号，请联系班组长更新二维码。");
    }
    if (criteria.taskId) request.id = criteria.taskId;
    if (criteria.projectCode) request.projectCode = criteria.projectCode;
    if (criteria.processCode) request.processCode = criteria.processCode;
    if (!request.projectCode) throw new AppError(400, "INVALID_TASK_CODE", "二维码缺少工单编号。");

    const response = await this.request(this.config.taskQueryPath, request);
    const items = unwrapList(response);
    const tasks = items.map((item) => normalizeTask(item, criteria)).filter((task) =>
      (!criteria.taskId || task.taskId === criteria.taskId) &&
      (!criteria.projectCode || task.projectCode === criteria.projectCode) &&
      (!criteria.processCode || task.processCode === criteria.processCode)
    );
    this.taskCache.set(cacheKey, { tasks, expiresAt: Date.now() + 10_000 });
    if (this.taskCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of this.taskCache) if (value.expiresAt <= now) this.taskCache.delete(key);
    }
    return tasks.map((task) => ({ ...task }));
  }

  async listProjectTasks({ projectIds = [], projectCodes = [] } = {}, { deadline = Infinity } = {}) {
    const ids = [...new Set(projectIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].toSorted((a, b) => a - b);
    const codes = [...new Set(projectCodes.map((code) => String(code || "").trim()).filter(Boolean))].toSorted();
    if (!ids.length && !codes.length) return [];

    if (this.config.mode === "mock") {
      return MOCK_TASKS.filter((task) =>
        (!ids.length || ids.includes(task.projectId)) &&
        (!codes.length || codes.includes(task.projectCode))
      ).toSorted(compareProjectTasks).map((task) => ({ ...task }));
    }

    const cacheKey = `project-tasks:${ids.join(",")}|${codes.join(",")}`;
    const cached = this.taskCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.tasks.map((task) => ({ ...task }));

    const selectors = [];
    for (let index = 0; index < ids.length; index += 50) selectors.push({ projectIds: ids.slice(index, index + 50) });
    for (const projectCode of codes) selectors.push({ projectCode });

    const tasksById = new Map();
    const pageSize = 100;
    for (const selector of selectors) {
      for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
        if (Date.now() >= deadline) throw new AppError(504, "BLACKLAKE_SYNC_DEFERRED", "本次工序同步超出时间预算，将稍后重试。");
        const response = await this.request(this.config.taskQueryPath, {
          ...selector,
          page: { pageNum, pageSize }
        });
        const page = unwrapList(response);
        for (const raw of page) {
          const task = normalizeTask(raw, { projectCode: selector.projectCode || "" });
          const matchesSelector = selector.projectIds
            ? selector.projectIds.includes(task.projectId)
            : task.projectCode === selector.projectCode;
          if (matchesSelector) tasksById.set(task.taskId, task);
        }
        if (page.length < pageSize) break;
        if (pageNum === 100) throw new AppError(502, "BLACKLAKE_TASK_PAGINATION_LIMIT", "黑湖工序数量超过查询上限，请联系管理员。");
      }
    }

    const tasks = [...tasksById.values()].toSorted(compareProjectTasks);
    this.taskCache.set(cacheKey, { tasks, expiresAt: Date.now() + 30_000 });
    return tasks.map((task) => ({ ...task }));
  }

  async searchWorkOrdersBySku(sku) {
    const normalizedSku = String(sku || "").normalize("NFKC").trim().toLocaleUpperCase("en-US");
    if (this.config.mode === "mock") {
      return [...new Map(MOCK_TASKS.filter((task) =>
        String(task.productCode || "").normalize("NFKC").trim().toLocaleUpperCase("en-US") === normalizedSku
      ).map((task) => [task.projectId, {
        projectId: task.projectId, projectCode: task.projectCode,
        productCode: task.productCode, productName: task.productName
      }])).values()];
    }
    const projects = await this.listWorkOrderCatalog();
    return projects.filter((project) => project.productCode.normalize("NFKC").trim()
      .toLocaleUpperCase("en-US") === normalizedSku).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.projectId - left.projectId
    );
  }

  async queryWorkOrderCatalogPage({year=new Date().getFullYear(),pageNum=1,pageSize=100,updatedFrom,updatedTo}) {
    assert(Number.isInteger(year)&&year>=2001&&year<=2100&&Number.isInteger(pageNum)&&pageNum>0&&pageNum<=10000&&pageSize===100,422,'INVALID_CATALOG_PAGE','工单目录分页无效。');
    const incremental=updatedFrom!==undefined||updatedTo!==undefined,from=timestampMs(updatedFrom),to=timestampMs(updatedTo);
    if(incremental)assert(Number.isFinite(from)&&Number.isFinite(to)&&from<=to&&to-from<=2*86400000,422,'INVALID_CATALOG_WINDOW','工单更新时间范围无效。');
    if(this.config.mode==='mock'){const records=(await this.listWorkOrderCatalog()).filter(p=>year==null||p.projectCode.includes(String(year))).map(p=>({...p,plannedAmount:null,actualAmount:null}));return {records:pageNum===1?records:[],hasMore:false};}
    // queryList requires a nonempty text filter; queryList3 supports creation
    // ranges of at most two years. The mirror walks every year, not code prefixes.
    const response=await this.request('/api/dytin/external/project/queryList3',{...(incremental?{updatedAtGte:updatedFrom,updatedAtLte:updatedTo}:{createdAtGte:year+'-01-01 00:00:00',createdAtLte:year+'-12-31 23:59:59'}),page:{pageNum,pageSize}});
    const rawTotal=pick(response,['page.total','data.total','data.page.total','result.total','total']),total=rawTotal==null?null:Number(rawTotal);
    const rows=pick(response,['data.list','data.records','data.items','data.rows','data.results','data.content','data.page.list','data.page.records','data.data','result.list','result.records','list','records','rows','data'])??(response.data===null&&total===0?[]:null);
    assert(String(response.code)==='01000000'&&Array.isArray(rows)&&rows.length<=pageSize&&rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row))&&(total===null||String(rawTotal).trim()&&Number.isSafeInteger(total)&&total>=rows.length),502,'BLACKLAKE_PROJECT_FORMAT','黑湖工单分页结构无效，目录未标记为完整。');
    const records=rows.map(row=>{
      const numeric=value=>value!=null&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
      const projectId=Number(row.id??row.projectId);assert(Number.isSafeInteger(projectId)&&projectId>0&&typeof row.projectCode==='string'&&row.projectCode,502,'BLACKLAKE_PROJECT_FORMAT','黑湖工单身份字段不完整。');
      if(incremental){const at=timestampMs(row.updateTime??row.updatedAt);assert(at>=from&&at<=to,502,'BLACKLAKE_PROJECT_WINDOW_UNCONFIRMED','黑湖工单不在请求的更新时间范围内，未推进同步水位。');}
      return {projectId,projectCode:row.projectCode,productCode:String(row.productCode||''),productName:String(row.productName||''),productSpecification:String(row.productSpec||row.productSpecification||''),productImageUrls:workOrderProductImages(row),projectStatus:row.status==null?null:String(row.status),projectPriority:numeric(row.priority),plannedAmount:numeric(row.planAmount),actualAmount:numeric(row.actualAmount),unit:typeof row.projectUnit==='string'?row.projectUnit:null,planStartTime:row.planStartTime||null,planEndTime:row.planEndTime||null,createdAt:row.createdAt??row.createTime??null,updatedAt:row.updateTime??row.updatedAt??null};
    });
    const hasMore=total===null?rows.length===pageSize:pageNum*pageSize<total;
    assert(!hasMore||rows.length===pageSize,502,'BLACKLAKE_PROJECT_FORMAT','黑湖工单分页不完整，未推进同步水位。');
    return {records,hasMore,total};
  }

  async readWorkOrderPresence(projectId){
    const id=Number(projectId);assert(Number.isSafeInteger(id)&&id>0,422,'INVALID_WORK_ORDER','工单编号无效。');
    if(this.config.mode==='mock'){const task=MOCK_TASKS.find(row=>row.projectId===id);return task?{present:true,projectCode:task.projectCode}:{present:false,code:'01002021'};}
    try{
      const response=await this.nativeRequest('/api/dytin/project/web/detail',{projectId:id}),row=response?.data?.project;
      assert(String(response?.code)==='01000000'&&Number(row?.id??row?.projectId)===id&&typeof row.projectCode==='string'&&row.projectCode,502,'BLACKLAKE_ORDER_PRESENCE_UNCONFIRMED','黑湖工单身份无法确认。');
      return {present:true,projectCode:row.projectCode};
    }catch(error){
      if(error.upstreamStatus===200&&error.upstreamCode==='01002021'&&error.code==='WORK_ORDER_NOT_FOUND')return {present:false,code:error.upstreamCode};
      throw error;
    }
  }

  async listWorkOrderCatalog() {
    if (this.workOrderCatalog) {
      if (this.workOrderCatalog.expiresAt <= Date.now() && !this.workOrderCatalogPromise) {
        this.refreshWorkOrderCatalog().catch((error) => {
          console.warn(JSON.stringify({ event: "sku_catalog_refresh_failed", code: error.code || "BLACKLAKE_UNAVAILABLE" }));
        });
      }
      return this.workOrderCatalog.projects;
    }
    return this.refreshWorkOrderCatalog();
  }

  async refreshWorkOrderCatalog() {
    if (this.workOrderCatalogPromise) return this.workOrderCatalogPromise;
    this.workOrderCatalogPromise = (async () => {
      const year = new Date().getFullYear();
      const projectsById = new Map();
      for (const yearPart of [year, year - 1]) {
        const pageSize = 100;
        for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
          const response = await this.request("/api/dytin/external/project/queryList", {
            projectCode: String(yearPart), page: { pageNum, pageSize }
          });
          const rows = unwrapList(response);
          for (const row of rows) {
            const projectId = Number(pick(row, ["id", "projectId"]));
            if (!Number.isSafeInteger(projectId) || projectId <= 0) continue;
            const projectCode = String(row.projectCode || "").trim();
            const productCode = String(row.productCode || "").trim();
            if (!projectCode || !productCode) continue;
            projectsById.set(projectId, {
              projectId, projectCode, productCode,
              productName: String(row.productName || "未命名产品"),
              projectStatus: String(row.status ?? "").trim(),
              productImageUrls: workOrderProductImages(row),
              createdAt: String(row.createTime || row.createdAt || "")
            });
          }
          if (rows.length < pageSize) break;
          if (pageNum === 100) throw new AppError(502, "BLACKLAKE_PROJECT_PAGINATION_LIMIT", "黑湖工单数量超过查询上限，请联系管理员。");
        }
      }
      const projects = [...projectsById.values()];
      this.workOrderCatalog = { projects, expiresAt: Date.now() + 10 * 60_000 };
      return projects;
    })();
    try { return await this.workOrderCatalogPromise; }
    finally { this.workOrderCatalogPromise = null; }
  }

  async listWorkOrderProcesses(flowCode, { includeCompleted = false, fresh = false } = {}) {
    const code = String(flowCode || "").trim();
    if (!code) throw new AppError(400, "INVALID_FLOW_CODE", "流转码为空，请重新扫描。");

    if (this.config.mode === "mock") {
      return withDefaultQuantities(MOCK_TASKS.map((task) => ({ ...task })))
        .filter((task) => includeCompleted || !isCompletedTask(task));
    }

    const projectId = parseWorkOrderProjectId(code);
    const cacheKey = `work-order:${projectId}`;
    const cached = this.taskCache.get(cacheKey);
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      return cached.tasks.filter((task) => includeCompleted || !isCompletedTask(task)).map((task) => ({ ...task }));
    }
    const tasksById = new Map();
    for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
      const response = await this.request(this.config.taskQueryPath, {
        projectIds: [projectId], page: { pageNum, pageSize: 100 }
      });
      const page = unwrapList(response);
      for (const item of page) if (Number(item.projectId) === projectId) {
        const task = normalizeTask(item, {}); tasksById.set(task.taskId, task);
      }
      if (page.length < 100) break;
      if (pageNum === 100) throw new AppError(502, "BLACKLAKE_TASK_PAGINATION_LIMIT", "黑湖工序数量超过查询上限，请联系管理员。");
    }
    const tasks = [...tasksById.values()].toSorted(compareProjectTasks);

    const prepared = withDefaultQuantities(tasks);
    this.taskCache.set(cacheKey, { tasks: prepared, expiresAt: Date.now() + 10_000 });
    return prepared.filter((task) => includeCompleted || !isCompletedTask(task)).map((task) => ({ ...task }));
  }

  // Read one exact project; never infer project totals from operation totals.
  async readWorkOrderDetails(projectId, projectCode, {fresh=false}={}) {
    const id = Number(projectId);
    if (!Number.isSafeInteger(id) || id <= 0 || !projectCode) throw new AppError(400, 'INVALID_WORK_ORDER', '工单编号无效。');
    if (this.config.mode === 'mock') {
      const task = MOCK_TASKS.find(task => task.projectId === id);
      if (!task) throw new AppError(404, 'WORK_ORDER_NOT_FOUND', '没有找到这张工单。');
      return { projectId:id, projectCode:task.projectCode, productCode:task.productCode || '', productName:task.productName,
        productImageUrls:[], projectStatus:null, plannedAmount:null, actualAmount:null, unit:null, planStartTime:null, planEndTime:null, updatedAt:null };
    }
    const cacheKey = 'work-order-details:' + id, cached = this.taskCache.get(cacheKey);
    if (!fresh && cached?.expiresAt > Date.now() && cached.details.projectCode === projectCode) return structuredClone(cached.details);
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      const response = await this.request('/api/dytin/external/project/queryList', { projectCode, page:{pageNum,pageSize:100} });
      const rows = unwrapList(response), row = rows.find(row => Number(row.id ?? row.projectId) === id);
      if (row) {
        if (row.projectCode !== projectCode) throw new AppError(409, 'WORK_ORDER_CHANGED', '工单资料已变化，请重新扫描核对。');
        const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
        const details = { projectId:id, projectCode, productCode:String(row.productCode || ''), productName:String(row.productName || ''),
          productImageUrls:workOrderProductImages(row), projectStatus:row.status == null ? null : String(row.status),projectPriority:row.priority==null?null:Number(row.priority),
          plannedAmount:number(row.planAmount), actualAmount:number(row.actualAmount), unit:typeof row.projectUnit === 'string' ? row.projectUnit : null,
          planStartTime:row.planStartTime || null, planEndTime:row.planEndTime || null, createdAt:row.createdAt??row.createTime??null,updatedAt:row.updateTime??row.updatedAt??null,productSpecification:String(row.productSpec||row.productSpecification||'') };
        this.taskCache.set(cacheKey,{details,expiresAt:Date.now()+10_000});return structuredClone(details);
      }
      if (rows.length < 100) break;
      if (pageNum === 20) throw new AppError(502, 'BLACKLAKE_PROJECT_PAGINATION_LIMIT', '工单资料未能完整核对，请稍后重试。');
    }
    throw new AppError(404, 'WORK_ORDER_NOT_FOUND', '没有找到对应工单资料，请重新扫描核对。');
  }

  async findWorkOrderProcess(flowCode, taskId) {
    const normalizedTaskId = Number(taskId);
    if (!Number.isSafeInteger(normalizedTaskId) || normalizedTaskId <= 0) {
      throw new AppError(400, "INVALID_PROCESS_SELECTION", "请选择正确的工序。");
    }
    const processes = await this.listWorkOrderProcesses(flowCode);
    const task = processes.find((item) => item.taskId === normalizedTaskId);
    if (!task) {
      throw new AppError(409, "PROCESS_NOT_AVAILABLE", "这道工序已经完成或不属于当前工单，请重新选择。");
    }
    return { ...task };
  }

  async findCurrentProcess(flowCode) {
    const code = String(flowCode || "").trim();
    if (!code) throw new AppError(400, "INVALID_FLOW_CODE", "流转码为空，请重新扫描。");
    if (this.config.mode === "mock") {
      const index = mockFlowIndexes.get(code) || 0;
      const task = MOCK_TASKS[index];
      if (!task) throw new AppError(409, "FLOW_COMPLETED", "这张流转卡的全部工序已经完成。");
      return { ...task };
    }

    const projectId = parseWorkOrderProjectId(code);
    const currentResponse = await this.request(
      this.config.currentProcessPath,
      { projectIds: [projectId] }
    );
    const current = unwrapList(currentResponse)
      .find((item) => Number(item.projectId) === projectId);
    if (!current) {
      throw new AppError(404, "CURRENT_PROCESS_NOT_FOUND", "黑湖没有返回这张工单的当前工序，请确认工单状态。");
    }
    const currentProcessId = Number(current.currentProcessId);
    if (!Number.isSafeInteger(currentProcessId) || currentProcessId <= 0) {
      throw new AppError(409, "FLOW_COMPLETED", "这张工单没有可报工的当前工序，可能已经全部完成。");
    }

    const taskResponse = await this.request(this.config.taskQueryPath, {
      projectIds: [projectId],
      processIds: [currentProcessId],
      page: { pageNum: 1, pageSize: 100 }
    });
    // 黑湖当前版本会忽略 processIds 并返回该工单的全部任务，因此必须在本地精确匹配。
    const matches = unwrapList(taskResponse).filter((item) =>
      Number(item.projectId) === projectId && Number(item.processId) === currentProcessId
    );
    if (matches.length !== 1) {
      throw new AppError(
        502,
        "CURRENT_TASK_AMBIGUOUS",
        matches.length
          ? "黑湖返回了多条当前工序任务，请联系管理员核对工单。"
          : "黑湖当前工序没有对应的生产任务，请联系管理员核对工单。"
      );
    }

    const raw = matches[0];
    const task = normalizeTask(raw, {});
    task.reportAmount = optionalPositiveNumber(pick(raw, [
      "reportAmount", "outputAmount", "planAmount", "plannedAmount", "amount"
    ]));
    return task;
  }

  async createOutput({ reportId, operator, task, amount, defectAmount, defectCode, defectCodes, defectItems, outputTime, actualStartedAt, actualEndedAt, approveStatus = this.config.approveStatus, onCreateEvidence }) {
    const selectedDefectCodes = [...new Set((Array.isArray(defectCodes) && defectCodes.length ? defectCodes : defectCode ? [defectCode] : [])
      .map((code) => String(code || "").trim()).filter(Boolean))];
    if(defectItems!==undefined)assert(Array.isArray(defectItems)&&defectItems.length===selectedDefectCodes.length&&new Set(defectItems.map(row=>row?.code)).size===defectItems.length&&defectItems.every(row=>row&&selectedDefectCodes.includes(row.code)&&Number.isSafeInteger(row.amount)&&row.amount>0)&&defectItems.reduce((sum,row)=>sum+row.amount,0)===defectAmount,422,'INVALID_DEFECT_DISTRIBUTION','不良品项数量合计必须等于不良数。');
    const defectList = defectItems??distributeDefects(defectAmount, selectedDefectCodes);
    const payload = {
      projectCode: task.projectCode,
      projectId: task.projectId,
      projectProcessId: task.taskId,
      operatorId: operator.blacklakeOperatorId,
      operatorName: operator.name,
      outputAmount: amount,
      fineAmount: amount - defectAmount,
      defectsAmount: defectAmount,
      defectList,
      outputTime,
      ...(actualStartedAt ? { planStartTime: actualStartedAt } : {}),
      ...(actualEndedAt ? { planEndTime: actualEndedAt } : {}),
      pricingType: 1,
      approveStatus
    };

    if (this.config.mode === "mock") {
      for (const [code, index] of mockFlowIndexes) {
        if (MOCK_TASKS[index]?.taskId === task.taskId) mockFlowIndexes.set(code, index + 1);
      }
      return { id: `MOCK-${Date.now()}`, payload };
    }

    const evidence=onCreateEvidence||(reportId?data=>console.info(JSON.stringify({event:'blacklake_report_create_receipt',reportId,...data})):()=>{});
    let observed=false,sentAt,uncertain;
    try{
      const receipt=await this.request(this.config.outputAddPath,payload,{write:true,strictOutput:'create',
        beforeSend:()=>{sentAt=Date.now();observed=false;},onReceipt:data=>{observed=true;evidence({...data,sentAt});}});
      this.taskCache.clear();
      if(receipt.id){
        this.outputProjectCodes.set(receipt.id,payload.projectCode);
        if(this.outputProjectCodes.size>10000)this.outputProjectCodes.delete(this.outputProjectCodes.keys().next().value);
        return {id:receipt.id,payload};
      }
      uncertain=unknownCreateOutcome('BLACKLAKE_OUTPUT_ID_MISSING');
    }catch(error){
      if(error.definiteFailure||sentAt===undefined)throw error;
      this.taskCache.clear();
      if(!observed)evidence({stage:'response',sentAt,format:'unavailable',outcome:'unconfirmed-transport',code:['BLACKLAKE_TIMEOUT','BLACKLAKE_UNAVAILABLE'].includes(error.code)?error.code:null});
      uncertain=error.writeOutcomeUnknown?error:unknownCreateOutcome();
    }
    let found;
    try{found=await readCreatedOutput(this,payload,sentAt);}
    catch(error){found={outcome:'lookup-unavailable',httpStatus:Number.isInteger(error.upstreamStatus)?error.upstreamStatus:null};}
    evidence({stage:'readback',outcome:found.outcome,...(found.matches===undefined?{}:{matches:found.matches}),...(found.httpStatus==null?{}:{httpStatus:found.httpStatus})});
    if(found.id)return {id:found.id,payload,readbackConfirmed:true};
    throw uncertain;
  }

  // Official OpenAPI: queryList3 {id}, modify {outputId,...quantity fields},
  // delete {outputIds:[id]} -> code 01000000 and numeric deleted count.
  async readOutputForCorrection(outputId,{production=false,resume,onReadStep}={}) {
    const id=Number(outputId);
    if(!Number.isSafeInteger(id)||id<=0)throw new AppError(422,'BLACKLAKE_OUTPUT_ID_INVALID','黑湖报工编号无效，不能修改或删除。');
    let output;
    if(resume&&String(resume.id)===String(id))output=structuredClone(resume);
    else {
    let page;const projectCode=this.outputProjectCodes.get(String(id));
    try{page=await this.queryOutputPage({id,...(projectCode?{projectCode}:{})},{pageSize:2});}
    catch(error){
      if(projectCode||error.upstreamCode!=='1011')throw error;
      // queryList3 currently requires projectCode even with an exact output id.
      const detail=await this.nativeRequest('/api/dytin/output/web/detail',{outputId:id});
      assert(String(detail?.code)==='01000000'&&String(detail.data?.outputId)===String(id)&&typeof detail.data?.projectCode==='string'&&detail.data.projectCode,502,'BLACKLAKE_REPORT_DETAIL_INVALID','报工工单身份未能确认。');
      page=await this.queryOutputPage({id,projectCode:detail.data.projectCode},{pageSize:2});
    }
    if(page.records.length!==1||(page.total!==null&&page.total!==1)){const error=new AppError(409,'BLACKLAKE_REPORT_NOT_UNIQUE','未查到唯一对应的黑湖报工，请后台核对。');error.definiteAbsence=page.records.length===0&&(page.total===null||page.total===0);throw error;}
    const raw=page.records[0],key=raw.reportingId??raw.id??raw.outputId;
    const numeric=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))?Number(value):NaN;
    output={id:key,projectId:raw.projectId,projectCode:raw.projectCode,
      projectProcessId:raw.taskId??raw.projectProcessId,operatorId:raw.productionStaffId??raw.operatorId,
      startedAt:raw.starttimeofReport??raw.planStartTime,endedAt:raw.endtimeofReport??raw.planEndTime,
      fineAmount:numeric(raw.numberofgoodProducts??raw.fineAmount),defectsAmount:numeric(raw.numberofDefectives??raw.defectsAmount),
      defectItems:(raw.defectItemList||raw.defectList||[]).map(item=>({code:String(item.code||item.defectCode||''),amount:numeric(item.amount??item.defectAmount??item.quantity)})).sort((a,b)=>a.code.localeCompare(b.code)),
      defectCodes:[...new Set((raw.defectItemList||raw.defectList||[]).map(item=>String(item.code||item.defectCode||'')).filter(Boolean))].sort()};
    if(String(key)!==String(id)||!Number.isFinite(output.fineAmount)||!Number.isFinite(output.defectsAmount))throw new AppError(502,'BLACKLAKE_REPORT_DETAIL_INVALID','无法确认黑湖报工明细，请勿修改或删除。');
    if(Object.hasOwn(raw,'effectiveTime'))output.effectiveTime=raw.effectiveTime;
    if(Object.hasOwn(raw,'customFieldValues'))output.customFieldValues=raw.customFieldValues;
    if(onReadStep)await onReadStep(structuredClone(output));
    }
    if(production){
      const native=await readNativeReport(this,id);
      if(String(native.projectId)!==String(output.projectId)||String(native.projectProcessId)!==String(output.projectProcessId)||String(native.operatorId)!==String(output.operatorId)
        ||native.fineAmount!==output.fineAmount||native.defectsAmount!==output.defectsAmount||native.planStartTime!==output.startedAt||native.planEndTime!==output.endedAt)throw new AppError(409,'REPORT_REMOTE_CHANGED','黑湖网页详情与公开接口不一致，请刷新核对。');
      Object.assign(output,{native,effectiveTime:native.effectiveTime,customFieldValues:native.customFieldValues,defectItems:native.defects.map(f=>({code:String(f.code),amount:Number(f.amount)})).sort((a,b)=>a.code.localeCompare(b.code)),defectCodes:[...new Set(native.defects.map(f=>String(f.code)))].sort()});
    }
    return output;
  }

  nativeRequest(path,payload,options={}){return this.request(path,payload,{...options,native:true});}
  async reopenProcessConfirmed(taskId,projectId){
    const response=await this.nativeRequest('/api/dytin/project/process/update',{projectProcess:{projectProcessId:Number(taskId),processStatus:10}},{write:true,retryAuth:false});
    this.taskCache.clear();
    assert(String(response?.code)==='01000000',409,'PROCESS_REOPEN_UNCONFIRMED','工序重开结果待核对，请勿重复操作。');
    const task=await this.findTaskById(taskId,{fresh:true});
    assert(Number(task.taskId)===Number(taskId)&&Number(task.projectId)===Number(projectId)&&Number(task.processStatus)===10,409,'PROCESS_REOPEN_UNCONFIRMED','工序尚未确认开启，请在后台核对。');
    return task;
  }
  prepareOutputCorrection(original,input){return prepareNativeCorrection(this,original,input);}

  async readReportFieldMetadata(){
    const fields=[];
    for(let pageNum=1;pageNum<=20;pageNum++){
      const response=await this.request('/api/dytin/external/customField/queryCustomFieldMetadata',{targetType:4,page:{pageNum,pageSize:100}});
      if(String(response?.code)!=='01000000'||!Array.isArray(response.data)||response.data.length>100)throw new AppError(502,'BLACKLAKE_CUSTOM_FIELDS_UNSAFE','无法确认完整的黑湖报工字段定义。');
      fields.push(...response.data);
      if(response.data.length<100)return fields;
    }
    throw new AppError(502,'BLACKLAKE_CUSTOM_FIELDS_UNSAFE','黑湖报工字段超过读取上限，尚未提交。');
  }

  async updateOutputConfirmed(original,{goodAmount,defectAmount,defectCodes,defectItems,operatorId,operatorName,startedAt,endedAt,durationSeconds,materialProcess,nativePlan}) {
    const id=Number(original.id);
    if(!Number.isSafeInteger(id)||id<=0)throw new AppError(422,'BLACKLAKE_OUTPUT_ID_INVALID','黑湖报工编号无效。');
    if(durationSeconds!==undefined){
      if(!this.supportsFullReportCorrection||!nativePlan){const error=new AppError(409,'BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED','黑湖完整报工同步尚未就绪，本次未提交。');error.definiteFailure=true;throw error;}
      return writeNativeCorrection(this,original,nativePlan);
    }
    // OpenAPI optional fields are omitted: never resend identity, timestamps,
    // pricing, custom fields or effective hours when editing quantities only.
    const payload={outputId:id,outputAmount:goodAmount+defectAmount,fineAmount:goodAmount,defectsAmount:defectAmount,
      defectList:defectItems??distributeDefects(defectAmount,defectCodes),
      ...(operatorId!==undefined?{operatorId,operatorName}:{}),...(startedAt?{planStartTime:startedAt}:{}),...(endedAt?{planEndTime:endedAt}:{})};
    if(materialProcess!==undefined){
      try{
        if(goodAmount!==original.fineAmount||defectAmount!==original.defectsAmount||operatorId!==undefined&&String(operatorId)!==String(original.operatorId)||startedAt&&startedAt!==original.startedAt||endedAt&&endedAt!==original.endedAt)throw new AppError(409,'BLACKLAKE_FORMULA_RECALC_NOT_VERIFIED','涉及公式依赖的修改须先验证完整同步，本次尚未提交。');
        payload.customFieldValueList=materialFieldPayload(original.customFieldValues,await this.readReportFieldMetadata(),materialProcess);
        const fresh=await this.readOutputForCorrection(id);
        if(JSON.stringify(fresh)!==JSON.stringify(original))throw new AppError(409,'REPORT_REMOTE_CHANGED','黑湖报工已变化，本次尚未提交。');
      }
      catch(error){error.definiteFailure=true;throw error;}
    }
    let response;
    try {response=await this.request('/api/dytin/external/output/modify',payload,{write:true,retryAuth:false});}
    catch(error){if(error.upstreamStatus>=400&&error.upstreamStatus<500||['1001','01000002'].includes(error.upstreamCode))error.definiteFailure=true;throw error;}
    this.taskCache.clear();
    if(String(response?.code)!=='01000000')throw new AppError(409,'BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖修改回执待核对，不能重复提交。');
    const verified=await this.readOutputForCorrection(id);
    if(verified.fineAmount!==goodAmount||verified.defectsAmount!==defectAmount
      ||String(verified.operatorId)!==String(operatorId??original.operatorId)||String(verified.projectProcessId)!==String(original.projectProcessId)
      ||(original.projectId!=null&&String(verified.projectId)!==String(original.projectId))
      ||(startedAt&&verified.startedAt!==startedAt)||(endedAt&&verified.endedAt!==endedAt)
      ||(defectItems&&JSON.stringify(verified.defectItems)!==JSON.stringify([...defectItems].sort((a,b)=>a.code.localeCompare(b.code))))
      ||JSON.stringify(verified.defectCodes)!==JSON.stringify([...new Set(defectCodes)].sort())
      ||(payload.customFieldValueList&&!customFieldReadbackMatches(verified.customFieldValues,payload.customFieldValueList)))throw new AppError(409,'BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖修改结果待核对，不能重复提交。');
    return verified;
  }

  async deleteOutputConfirmed(outputId) {
    const id=Number(outputId);
    if(!Number.isSafeInteger(id)||id<=0)throw new AppError(422,'BLACKLAKE_OUTPUT_ID_INVALID','黑湖报工编号无效。');
    let response;
    try {response=await this.request('/api/dytin/external/output/delete',{outputIds:[id]},{write:true,retryAuth:false});}
    catch(error){if(error.upstreamStatus>=400&&error.upstreamStatus<500||['1001','01000002'].includes(error.upstreamCode))error.definiteFailure=true;throw error;}
    if(String(response?.code)==='01000000'&&response.data===1){this.taskCache.clear();return;}
    throw new AppError(409,'BLACKLAKE_REPORT_DELETE_UNCONFIRMED','黑湖删除数量或回执待核对，不能重复提交。');
  }

  // Strict single-page read for reports that must retain pagination evidence.
  // Existing queryOutputs callers keep their original array-returning contract.
  async queryOutputPage(filters = {}, { pageNum = 1, pageSize = 100, requireSuccess = false } = {}) {
    if (!Number.isSafeInteger(pageNum) || pageNum < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AppError(400, "INVALID_OUTPUT_PAGE", "报工页码必须为正整数，每页数量必须在1至100之间。");
    }
    if (this.config.mode === "mock") return { records: [], total: 0, pageNum, pageSize };
    const response = await this.request(this.config.outputQueryPath, { ...filters, page: { pageNum, pageSize } }, requireSuccess?{strictOutput:'read'}:{});
    const rawTotal = pick(response, ["data.total", "data.totalCount", "data.page.total", "result.total", "page.total", "page.totalCount", "total", "totalCount"]);
    const total = rawTotal === undefined ? null : Number(rawTotal);
    // The real incremental endpoint returns data:null with page.total:0 for
    // a verified empty interval. A null body without that evidence stays invalid.
    const records = pick(response, ["data.list", "data.records", "data.items", "data.rows", "data.results", "data.content", "data.page.list", "data.page.records", "data.data", "result.list", "result.records", "list", "records", "rows", "data"])
      ?? (response.data===null&&rawTotal!==undefined&&total===0?[]:null);
    if (!Array.isArray(records) || records.length > pageSize || records.some((row) => !row || typeof row !== "object" || Array.isArray(row))
      || (total !== null && ((typeof rawTotal !== "number" && typeof rawTotal !== "string") || String(rawTotal).trim() === "" || !Number.isSafeInteger(total) || total < records.length))) {
      throw new AppError(502, "BLACKLAKE_OUTPUT_PAGE_FORMAT", "黑湖报工分页结构异常，不能判断查询是否完整。");
    }
    for(const row of records){const id=row.reportingId??row.id??row.outputId;if(id!=null&&typeof row.projectCode==='string'&&row.projectCode)this.outputProjectCodes.set(String(id),row.projectCode);if(this.outputProjectCodes.size>10000)this.outputProjectCodes.delete(this.outputProjectCodes.keys().next().value);}
    return { records, total, pageNum, pageSize };
  }

  async queryOutputs(filters = {}, { pageSize = 100, maxPages = 10_000, maxRecords = Infinity } = {}) {
    if (this.config.mode === "mock") return [];
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AppError(400, "INVALID_PAGE_SIZE", "黑湖报工查询每页数量必须在 1 到 100 之间。");
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new AppError(400, "INVALID_MAX_PAGES", "最大分页数必须是正整数。");
    }
    if (maxRecords !== Infinity && (!Number.isSafeInteger(maxRecords) || maxRecords < 1)) {
      throw new AppError(400, "INVALID_MAX_RECORDS", "最大记录数必须是正整数。");
    }

    const records = [];
    for (let pageNum = 1; pageNum <= maxPages && records.length < maxRecords; pageNum += 1) {
      const response = await this.request(this.config.outputQueryPath, {
        ...filters,
        page: { pageNum, pageSize }
      });
      const pageRecords = unwrapList(response);
      const remaining = maxRecords === Infinity ? pageRecords.length : maxRecords - records.length;
      records.push(...pageRecords.slice(0, remaining));
      if (pageRecords.length < pageSize) return records;
    }

    if (records.length >= maxRecords) return records;
    throw new AppError(502, "BLACKLAKE_PAGINATION_LIMIT", `报工查询超过 ${maxPages} 页，请缩小时间范围后重试。`);
  }

  async request(path, payload, { retryAuth = true, write = false, native = false, strictOutput, beforeSend, onReceipt } = {}) {
    if (write&&!this.requestBudget) await this.limitWriteRate();
    let token;try{token=await this.token();}catch(error){if(write){error.writeNotSent=true;error.definiteFailure=true;}throw error;}
    const send=async()=>{
    let response;
    try {
      if(write)this.repeatReads.clear();
      beforeSend?.();
      response = await this.fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AUTH": token,...(native?{'X-CLIENT':'lite-web','X-ENTRANCE-CLIENT':'0','User-Agent':'BlacklakeReporting/1.0'}:{}) },
        body: JSON.stringify(payload),
        ...(strictOutput?{redirect:'error'}:{}),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      if (error.name === "TimeoutError") throw new AppError(504, "BLACKLAKE_TIMEOUT", "黑湖响应超时，请稍后重试。等待期间不要重复点击。");
      throw new AppError(502, "BLACKLAKE_UNAVAILABLE", "暂时无法连接黑湖，请稍后再试。");
    } finally {
      if(write)this.repeatReads.clear();
    }

    this.requestBudget?.response(response.status,response.headers?.get?.('retry-after'));
    if(strictOutput){
      let raw='',data,bodyReadFailed=false;
      try{raw=await response.text();}catch{bodyReadFailed=true;}
      if(raw)try{data=JSON.parse(raw);}catch{}
      return {response,data,receipt:inspectCreateReceipt(response,raw,data,{bodyReadFailed})};
    }
    let data;try{data=await parseResponse(response);}catch(error){error.upstreamStatus=response.status;throw error;}
    return {response,data};
    };
    const limitedRead=!write&&(path===this.config.taskQueryPath||path===this.config.currentProcessPath||/^\/api\/dytin\/external\/project\/queryList[23]?$/.test(path));
    const repeatKey=this.requestBudget&&limitedRead?createHash('sha256').update(path+'\n'+canonicalRequestJSON(payload)).digest('hex'):undefined;
    const run=()=>this.requestBudget?this.requestBudget.run(send,{kind:write?'write':'read',priority:this.priorityContext.getStore()===true,repeatKey,deferRepeated:this.repeatedReadContext.getStore()===true}):send();
    let result;try{result=repeatKey?await this.sharedRepeatRead(repeatKey,run):await run();}
    catch(error){if(write&&['BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(error.code)){error.writeNotSent=true;error.definiteFailure=true;}throw error;}
    const {response,data,receipt}=result;
    if(strictOutput){
      onReceipt?.(receipt.evidence);
      if(receipt.success)return strictOutput==='create'?receipt:data;
      if(receipt.rejected&&isAuthFailure(response,data)&&!this.config.staticToken){
        this.cachedToken='';
        if(retryAuth&&response.status===401)return this.request(path,payload,{retryAuth:false,write,native,strictOutput,beforeSend,onReceipt});
      }
      if(strictOutput==='read')throw Object.assign(new AppError(502,'BLACKLAKE_OUTPUT_READBACK_UNCONFIRMED','黑湖查询未返回可确认的结果。'),{upstreamStatus:response.status});
      if(receipt.rejected){
        const error=isAuthFailure(response,data)?new AppError(502,'BLACKLAKE_AUTH_FAILED','黑湖登录已失效，尚未完成报工。'):blacklakeError(response.status,data);
        if(error.code==='BLACKLAKE_REJECTED')error.message='黑湖明确拒绝本次报工。';
        throw Object.assign(error,{upstreamStatus:response.status,definiteFailure:true});
      }
      throw unknownCreateOutcome();
    }
    if (isAuthFailure(response, data) && retryAuth && !this.config.staticToken) {
      this.cachedToken = "";
      return this.request(path, payload, { retryAuth: false, write, native });
    }
    if (!response.ok || isBusinessFailure(data)) {
      const error = blacklakeError(response.status, data);
      // Diagnostic metadata is deliberately separate from public error details.
      error.upstreamStatus = response.status;
      const code = String(data?.code ?? data?.errorCode ?? "");
      if (/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) error.upstreamCode = code;
      throw error;
    }
    return repeatKey?structuredClone(data):data;
  }

  async sharedRepeatRead(key,run){
    const now=()=>this.requestBudget?.now?.()??Date.now();
    const previous=this.repeatReads.get(key);
    if(previous&&(!previous.expiresAt||previous.expiresAt>now()))return previous.promise;
    const current={expiresAt:0};
    // Store the shared request before starting it. A write invalidates the
    // entry; an older in-flight read can resolve its callers but cannot refill it.
    this.repeatReads.set(key,current);
    current.promise=Promise.resolve().then(run).then(result=>{
      if(result.response.ok&&String(result.data?.code)==='01000000'&&!isBusinessFailure(result.data))current.expiresAt=now()+10000;
      else if(this.repeatReads.get(key)===current)this.repeatReads.delete(key);
      return result;
    },error=>{if(this.repeatReads.get(key)===current)this.repeatReads.delete(key);throw error;});
    if(this.repeatReads.size>500)for(const [id,entry] of this.repeatReads){if(entry.expiresAt&&id!==key){this.repeatReads.delete(id);if(this.repeatReads.size<=500)break;}}
    return current.promise;
  }

  async limitWriteRate() {
    const previous = this.writeChain;
    let release;
    this.writeChain = new Promise((resolve) => { release = resolve; });
    await previous;
    await new Promise((resolve) => setTimeout(resolve, 110));
    release();
  }

  async token() {
    if (this.cachedToken) return this.cachedToken;
    if (this.loginPromise) return this.loginPromise;
    if (!this.config.loginPath) throw new AppError(500, "BLACKLAKE_AUTH_CONFIG", "黑湖登录路径尚未配置。");

    this.loginPromise = this.login().finally(() => { this.loginPromise = null; });
    this.cachedToken = await this.loginPromise;
    return this.cachedToken;
  }

  async login() {
    const send=async()=>{
    let response;
    try {
      const password = loginPassword(this.config.password);
      response = await this.fetch(`${this.config.baseUrl}${this.config.loginPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CLIENT": this.config.client || "lite-web" },
        body: JSON.stringify(this.config.loginType === "2"
          ? { phone: this.config.phone, username: this.config.account, password }
          : {
              type: "1",
              code: this.config.factoryCode,
              username: this.config.account,
              password
            }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch {
      throw new AppError(502, "BLACKLAKE_LOGIN_FAILED", "无法登录黑湖，请联系管理员检查接口账号。");
    }

    this.requestBudget?.response(response.status,response.headers?.get?.('retry-after'));
    let data;try{data=await parseResponse(response);}catch(error){error.upstreamStatus=response.status;throw error;}
    return {response,data};
    };
    const {response,data}=this.requestBudget?await this.requestBudget.run(send,{kind:'login',priority:this.priorityContext.getStore()===true}):await send();
    const token = typeof data.data === "string"
      ? data.data
      : pick(data, ["data.token", "data.accessToken", "token", "accessToken", "result.token"]);
    if (!response.ok || isBusinessFailure(data) || !token) {
      const error=new AppError(502, "BLACKLAKE_LOGIN_FAILED", "黑湖登录失败，请联系管理员检查接口账号和登录字段。");error.upstreamStatus=response.status;throw error;
    }
    return token;
  }
}

function canonicalRequestJSON(payload) {
  return JSON.stringify(payload, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value);
}

function loginPassword(password) {
  const value = String(password || "");
  return /^[a-f0-9]{56}$/i.test(value) ? value.toLowerCase() : createHash("sha3-224").update(value).digest("hex");
}

function parseWorkOrderProjectId(code) {
  const printedCode = /^projectId=(\d+)$/.exec(code);
  if (printedCode) {
    const projectId = Number(printedCode[1]);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new AppError(400, "INVALID_FLOW_CODE", "黑湖工单二维码缺少有效的工单 ID，请重新生成二维码。");
    }
    return projectId;
  }

  let url;
  try {
    url = new URL(code);
  } catch {
    throw new AppError(400, "INVALID_FLOW_CODE", "这不是黑湖工单二维码，请重新扫描。");
  }
  if (url.protocol !== "https:" || url.hostname !== "liteapp.blacklake.cn" ||
      url.pathname !== "/pages/index/workOrderDetail/index") {
    throw new AppError(400, "INVALID_FLOW_CODE", "这不是黑湖工单外链二维码，请重新扫描。");
  }
  const projectId = Number(url.searchParams.get("id"));
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new AppError(400, "INVALID_FLOW_CODE", "黑湖工单二维码缺少有效的工单 ID，请重新生成二维码。");
  }
  return projectId;
}

function normalizeTask(raw, criteria) {
  // Preserve missingness for analytical consumers without changing reporting defaults.
  const presentNumber = (paths) => {
    const value = pick(raw, paths);
    return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  };
  const task = {
    quantityPresence: {
      plannedAmount: presentNumber(["planAmount", "plannedAmount", "amount"]),
      reportedGoodAmount: presentNumber(["fineAmount", "approvedFineAmount", "completedAmount", "actualAmount"]),
      reportedDefectAmount: presentNumber(["defectsAmount", "defectAmount"]),
      sequence: presentNumber(["seq", "sequence", "sort", "order"])
    },
    taskId: Number(pick(raw, ["id", "taskId", "projectProcessId"])),
    projectId: optionalNumber(pick(raw, ["projectId", "project.id", "projectInfo.id"])),
    projectCode: String(pick(raw, ["projectCode", "project.code", "projectInfo.code"]) || criteria.projectCode || ""),
    productName: String(pick(raw, ["productName", "product.name", "project.productName", "projectInfo.productName"]) || "未命名产品"),
    processName: String(pick(raw, ["processName", "process.name", "projectProcessName"]) || "未命名工序"),
    processCode: String(pick(raw, ["processCode", "process.code"]) || criteria.processCode || ""),
    stationName: String(pick(raw, ["stationName", "workstationName", "workstation.name"]) || ""),
    plannedAmount: optionalNumber(pick(raw, ["planAmount", "plannedAmount", "amount"])) || 0,
    completedAmount: optionalNumber(pick(raw, ["actualAmount", "completedAmount", "outputAmount"])) || 0,
    sequence: optionalNumber(pick(raw, ["seq", "sequence", "sort", "order"])) || 0,
    processStatus: optionalNumber(pick(raw, ["processStatus", "status"])),
    processPriority: optionalNumber(pick(raw,["priority"])),
    processStatusDisplay: String(pick(raw, ["processStatusDisplay", "statusDisplay", "statusName"]) || ""),
    dueDate: dateOnly(pick(raw, ["processEndTime", "dueDate", "deliveryDate"])),
    reportedGoodAmount: optionalNumber(pick(raw, ["fineAmount", "approvedFineAmount", "completedAmount", "actualAmount"])) || 0,
    reportedDefectAmount: optionalNumber(pick(raw, ["defectsAmount", "defectAmount"])) || 0,
    remnantAmount: optionalNumber(pick(raw, ["remnantAmount", "remainingAmount"])),
    unit: String(pick(raw, ["unitName", "unit.name", "unit"]) || "件")
  };
  if (!Number.isSafeInteger(task.taskId) || task.taskId <= 0) {
    throw new AppError(502, "BLACKLAKE_TASK_FORMAT", "黑湖任务数据缺少任务 ID，请联系管理员检查字段映射。");
  }
  return task;
}

function withDefaultQuantities(tasks) {
  return tasks.toSorted((left, right) =>
    (left.sequence || Number.MAX_SAFE_INTEGER) - (right.sequence || Number.MAX_SAFE_INTEGER) ||
    left.taskId - right.taskId
  ).map(task => ({
    ...task,
    defaultReportAmount: optionalPositiveNumber(task.plannedAmount),
    quantitySource: 'PLAN_AMOUNT'
  }));
}

function compareProjectTasks(left, right) {
  return String(left.projectCode || "").localeCompare(String(right.projectCode || ""), "zh-CN") ||
    (left.sequence || Number.MAX_SAFE_INTEGER) - (right.sequence || Number.MAX_SAFE_INTEGER) ||
    left.taskId - right.taskId;
}

function isCompletedTask(task) {
  const display = String(task.processStatusDisplay || "").trim();
  const completedByStatus = Number(task.processStatus) === 20 ||
    /^(已完成|完成|已完工|完工|已结束|已关闭)$/.test(display);
  // Quantity reaching plan is not an instruction to close: workers may still report extra output.
  return completedByStatus;
}

function stationProcessNotFound() {
  return new AppError(
    404,
    "STATION_PROCESS_NOT_FOUND",
    "这个工序码不属于当前工单，或该工序已经完成。请确认工位后重新扫描。"
  );
}

function unwrapList(response) {
  const candidates = [
    pick(response, [
      "data.list", "data.records", "data.items", "data.rows", "data.results", "data.content",
      "data.page.list", "data.page.records", "data.data", "result.list", "result.records",
      "list", "records", "rows"
    ]),
    response.data
  ];
  return candidates.find(Array.isArray) || [];
}

function pick(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const segment of path.split(".")) value = value?.[segment];
    if (value !== undefined && value !== null) return value;
  }
}

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalPositiveNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function dateOnly(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\D|$)/);
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function distributeDefects(defectAmount, defectCodes) {
  if (!defectAmount || defectCodes.length === 0) return [];
  if (!Number.isSafeInteger(defectAmount) || defectAmount < defectCodes.length) {
    throw new AppError(422, "INVALID_DEFECT_DISTRIBUTION", "不良原因不能多于不良件数。");
  }
  const amountPerReason = Math.floor(defectAmount / defectCodes.length);
  const remainder = defectAmount % defectCodes.length;
  return defectCodes.map((code, index) => ({
    code,
    amount: amountPerReason + (index < remainder ? 1 : 0)
  }));
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

function isBusinessFailure(data) {
  const statusCode = Number(data?.statusCode);
  const code = Number(data?.code);
  const normalizedCode = String(data?.code ?? "").toLowerCase();
  if (["01000000", "0100x1111"].includes(normalizedCode)) return false;
  return data?.success === false ||
    (Number.isFinite(statusCode) && statusCode >= 400) ||
    data?.code === -1 || data?.code === "-1" ||
    (Number.isFinite(code) && code >= 400);
}

function isAuthFailure(response, data) {
  return response.status === 401 || response.status === 403 ||
    String(data?.code || data?.statusCode || "") === "401" ||
    String(data?.subCode || "").toUpperCase() === "USER_VERIFICATION_ERROR";
}

function blacklakeError(status, data) {
  const original = String(pick(data, ["message", "msg", "error.message", "errorMsg"]) || "黑湖拒绝了这次操作。");
  const lower = original.toLowerCase();
  if (lower.includes("token") || original.includes("登录") || original.includes("认证") || data?.subCode === "USER_VERIFICATION_ERROR") {
    return new AppError(502, "BLACKLAKE_AUTH_FAILED", "黑湖登录已失效，请稍后再试或联系管理员。");
  }
  if (/工单(?:编号)?.{0,20}(?:不存在|已删除)/.test(original)) {
    return new AppError(409, "WORK_ORDER_NOT_FOUND", "黑湖中已找不到这张工单。可以退出这单，不会向黑湖提交数量。");
  }
  if (original.includes("关闭") || original.includes("完工") || original.includes("已结束")) {
    return new AppError(409, "TASK_CLOSED", "这个任务已经结束，不能再报工，请联系班组长。");
  }
  if (original.includes("数量") || original.includes("计划数")) return new AppError(422, "AMOUNT_REJECTED", "报工数量不符合黑湖规则，请检查数量或联系班组长。");
  return new AppError(status >= 400 && status < 500 ? 422 : 502, "BLACKLAKE_REJECTED", `黑湖未接受这次报工：${original.slice(0, 120)}`);
}
