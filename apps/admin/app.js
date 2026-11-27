// ERP reporting workspace with a left system menu, recent tabs, and a compact work-order ledger.
(() => {
  const app = document.querySelector("#app");
  const authDialog = document.querySelector("#auth-dialog");
  const authMessage = document.querySelector("#auth-message");
  const authRetry = document.querySelector("#auth-retry");
  const loginSpinner = document.querySelector(".login-spinner");
  const authTitle = document.querySelector(".login-progress h2");
  const authDescription = document.querySelector(".login-progress p");
  const confirmDialog = document.querySelector("#confirm-dialog");
  const peopleGroupsManager = window.createPeopleGroupsManager?.({ api, notify: showToast });
  const modules = [
    { key: "home", title: "首页", group: "工作台", icon: "home" },
    { key: "report", title: "报工管理", group: "生产执行", icon: "clipboard-list" },
    { key: "management", title: "人员与派工", group: "生产执行", icon: "users" },
    { key: "task-recovery", title: "待处理任务", group: "生产执行", icon: "clipboard-list" },
    { key: "data-sync", title: "数据同步", group: "生产执行", icon: "refresh" },
    { key: "production", title: "3D生产看板", group: "生产执行", icon: "cube" },
    { key: "embroidery", title: "绣花机看板", group: "生产执行", icon: "needle-thread" },
    { key: "people", title: "人员", group: "基础资料", icon: "users" },
    { key: "analytics", title: "统计分析", group: "经营分析", icon: "chart-bar" },
    { key: "weekly", title: "生产周报", group: "经营分析", icon: "clipboard-list" },
    { key: "audit", title: "审计日志", group: "系统管理", icon: "history" },
    { key: "dispatch-predictions", title: "派工预测反馈", group: "系统管理", icon: "chart-bar" }
  ];
  const statusMeta = {
    READY: { label: "待开始", tone: "orange" },
    IN_PROGRESS: { label: "进行中", tone: "blue" },
    NEEDS_REVIEW: { label: "待核对", tone: "orange" },
    QUANTITY_PENDING: { label: "待核量", tone: "orange" },
    COMPLETED: { label: "已完成", tone: "green" },
    EXCEPTION: { label: "异常", tone: "red" },
    REPORTING: { label: "提交中", tone: "blue" },
    CANCELLED: { label: "已取消", tone: "gray" },
    NOT_STARTED: { label: "未开始", tone: "gray" }
  };
  const machineStatusMeta = {
    RUNNING: { label: "生产中", tone: "running" },
    REPORTING: { label: "提交中", tone: "reporting" },
    NEEDS_REVIEW: { label: "待核对", tone: "review" },
    IDLE: { label: "空闲", tone: "idle" }
  };
  const embroideryPartOptions = Object.freeze([
    { key: "前幅", name: "前幅" },
    { key: "后幅", name: "后幅" }
  ]);
  const floor8StationIds = Object.freeze([
    ...Array.from({ length: 10 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 7 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
    "裁床一区", "裁床二区-1", "裁床二区-2", "手工剪线", "翻内袋", "包装/质检", "刺绣片检验"
  ]);
  const auxiliaryStationLabels = Object.freeze({
    "裁床一区": "裁1", "裁床二区-1": "裁2-1", "裁床二区-2": "裁2-2",
    "手工剪线": "剪线", "包装/质检": "包/检", "刺绣片检验": "片检"
  });
  const embroideryMachineListImage = "/admin/assets/embroidery-machine-list.0390558efd.webp";
  const embroideryMachineDetailImage = "/admin/assets/embroidery-machine-detail.c8f650b45a.webp";

  function isMobileViewport() {
    return typeof window !== "undefined" && Number(window.innerWidth || 0) > 0 && window.innerWidth <= 720;
  }

  function initialEmbroideryMachines() {
    const definitions = [
      ["01", "RUNNING", "WO-260907-003", "SG HT Arizona Cardinals", 150, "刘芮华", "前幅"],
      ["02", "RUNNING", "WO-260908-005", "MAP 熊猫PU白色刺绣直条", 120, "刘芮华", "后幅"],
      ["03", "IDLE"],
      ["04", "RUNNING", "WO-260906-018", "SG HT Buffalo Bills 蓝底", 120, "王师傅", "前幅"],
      ["05", "IDLE"],
      ["06", "RUNNING", "WO-260908-006", "SG Friends 紫黑底 Frame", 327, "陈小燕", "后幅"],
      ["07", "RUNNING", "WO-260906-017", "SG HT Jacksonville Jaguars", 65, "赵海英", "前幅"],
      ["08", "IDLE"],
      ["09", "RUNNING", "WO-260909-004", "SG HT Chicago Bears", 120, "王师傅", "后幅"],
      ["10", "IDLE"],
      ["11", "RUNNING", "WO-260907-010", "SG HT Seattle Seahawks", 55, "李姐", "前幅"],
      ["12", "IDLE"]
    ];
    return definitions.map(([id, status, code, product, quantity, operatorName, embroideryPart]) => ({
      id,
      status,
      model: "TAJIMA TMEZ-S1501",
      position: Number(id) <= 6 ? `中央通道左侧 ${id}` : `中央通道右侧 ${String(Number(id) - 6).padStart(2, "0")}`,
      current: code ? {
        code, product, quantity, operatorName, embroideryPart,
        processName: "外协加工KL", status: "IN_PROGRESS", startedAt: "今天 08:30"
      } : null,
      queue: []
    }));
  }

  const sidebarStorageKey = "blacklake.sidebarCollapsed.v1";
  function readSidebarPreference() {
    try { return window.localStorage?.getItem(sidebarStorageKey) === "true"; }
    catch { return false; }
  }

  const state = {
    sidebarCollapsed: readSidebarPreference(),
    currentUser: null,
    redirectingToLogin: false,
    authenticating: false,
    demo: false,
    filter: "ALL",
    search: "",
    detailSearch: "",
    peopleSearch: "",
    analyticsFocus: null,
    selectedId: null,
    detailTab: "workers",
    ledgerRecordsExpanded: false,
    expandedProcesses: new Set(),
    drawerRecordId: null,
    embroiderySearch: "",
    embroideryFilter: "UNASSIGNED",
    embroideryDueSort: "ASC",
    embroideryLayoutMode: "POSITION",
    embroiderySelectedMachineId: "08",
    embroideryInspectorOpen: !isMobileViewport(),
    embroideryMachines: initialEmbroideryMachines(),
    embroideryScheduleOrders: [],
    embroideryScheduleRestored: false,
    embroideryScheduleLoaded: false,
    embroideryScheduleLoading: false,
    embroideryScheduleRevision: 0,
    embroideryScheduleError: "",
    embroideryDirty: false,
    embroideryDraggedOrderId: null,
    embroideryDraggedAllocationId: null,
    embroideryDragTarget: null,
    embroideryDropHandled: false,
    embroideryPendingOrderId: null,
    embroideryAllocationDraft: null,
    embroideryAllocationSequence: 0,
    activeModule: "report",
    openTabs: [{ key: "home", title: "首页", closable: false }, { key: "report", title: "报工管理", closable: false }],
    anomalyRules: {
      deadlineGraceMinutes: 30,
      durationBaselineMinSamples: 5,
      durationMultiplier: 3,
      durationMinimumExcessMinutes: 60
    },
    anomalySummary: { total: 0, critical: 0, warning: 0, byCode: {} },
    refreshTimer: null,
    operators: [],
    unitRecommendations: [],
    operatorsLoaded: false,
    peopleTab: "stations",
    selectedStationId: "A-01",
    stationSearch: "",
    stationPersonSearch: "",
    stationDraftOperatorIds: [],
    auditEvents: [],
    auditTotal: 0,
    auditLoaded: false,
    auditLoading: false,
    auditError: "",
    auditQuery: "",
    auditEventType: "ALL",
    auditErrorCode: "ALL",
    auditActor: "ALL",
    auditFrom: "",
    auditTo: "",
    auditLimit: 50,
    auditOffset: 0,
    auditFacets: { errorCodes: [], actors: [] },
    orders: []
  };

  function syncEmbroideryMachines(assignments = []) {
    const activeStatuses = new Set(["IN_PROGRESS", "REPORTING", "NEEDS_REVIEW"]);
    for (const machine of state.embroideryMachines) {
      machine.current = null;
      machine.queue = [];
      machine.status = "IDLE";
    }
    for (const assignment of assignments) {
      const machineNumber = String(assignment.machineId || assignment.stationName || "").replace(/^(?:3F|MACHINE)-/i, "");
      const machine = state.embroideryMachines.find((item) => item.id === machineNumber);
      if (!machine || !assignment.isEmbroidery || !activeStatuses.has(assignment.status)) continue;
      const current = {
        assignmentId: assignment.id,
        code: assignment.projectCode || `任务-${assignment.taskId}`,
        product: assignment.productName || "未命名产品",
        quantity: hasUnconfirmedQuantity(assignment) ? null : Number(assignment.targetQuantity ?? assignment.quantity) || 0,
        quantityPending: isQuantityPending(assignment),
        quantityPolicy: assignment.quantityPolicy,
        operatorName: assignment.operatorName || "未识别工人",
        embroideryPart: assignment.embroideryPart || "未选择部位",
        processName: assignment.processName || "外协加工",
        status: assignment.status,
        startedAt: assignment.startedAt || "—"
      };
      if (!machine.current || String(current.startedAt).localeCompare(String(machine.current.startedAt)) > 0) {
        machine.current = current;
        machine.status = current.status === "IN_PROGRESS" ? "RUNNING" : current.status;
      }
    }
  }

  const demoOrders = [
    {
      id: "wo-018", code: "WO-240825-018", name: "手提袋补单", product: "手提袋 · 黑色", status: "NEEDS_REVIEW",
      planned: 300, completed: 236, updatedAt: "今天 14:36", owner: "缝制二组", exception: "1 笔待核对",
      processes: [
        { id: "p1", seq: 10, name: "裁片检验", station: "裁剪检验台", planned: 300, reported: 300, status: "COMPLETED", workers: 2 },
        { id: "p2", seq: 20, name: "提手加固线", station: "平车 04", planned: 300, reported: 300, status: "COMPLETED", workers: 2 },
        { id: "p3", seq: 30, name: "袋口压明线1", station: "平车 08", planned: 100, reported: 100, status: "NEEDS_REVIEW", workers: 2 },
        { id: "p4", seq: 40, name: "车缝袋身", station: "同步车 02", planned: 300, reported: 236, status: "IN_PROGRESS", workers: 3 },
        { id: "p5", seq: 50, name: "成品检验", station: "终检台", planned: 300, reported: 0, status: "IN_PROGRESS", workers: 0 }
      ],
      workers: [
        { name: "刘芮华", process: "袋口压明线1", amount: 50, duration: "38 分钟", status: "COMPLETED" },
        { name: "王师傅", process: "袋口压明线1", amount: 50, duration: "42 分钟", status: "NEEDS_REVIEW" },
        { name: "陈小燕", process: "车缝袋身", amount: 96, duration: "计时中", status: "IN_PROGRESS" },
        { name: "赵海英", process: "车缝袋身", amount: 80, duration: "计时中", status: "IN_PROGRESS" }
      ],
      records: [
        { id: "r1", time: "今天 14:36", worker: "王师傅", process: "袋口压明线1", amount: 50, duration: "42 分钟", source: "黑湖报工", status: "NEEDS_REVIEW", note: "黑湖返回超时，结果未知" },
        { id: "r2", time: "今天 14:31", worker: "刘芮华", process: "袋口压明线1", amount: 50, duration: "38 分钟", source: "黑湖报工", status: "COMPLETED", note: "已写入黑湖" },
        { id: "r3", time: "今天 13:48", worker: "赵海英", process: "车缝袋身", amount: 80, duration: "51 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" },
        { id: "r4", time: "今天 13:42", worker: "陈小燕", process: "车缝袋身", amount: 96, duration: "47 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" }
      ]
    },
    {
      id: "wo-017", code: "WO-240825-017", name: "帆布袋常规单", product: "帆布袋 · 米白", status: "IN_PROGRESS",
      planned: 500, completed: 310, updatedAt: "今天 14:28", owner: "缝制一组", exception: "",
      processes: [
        { id: "p1", seq: 10, name: "裁片检验", station: "裁剪检验台", planned: 500, reported: 500, status: "COMPLETED", workers: 2 },
        { id: "p2", seq: 20, name: "袋口卷边", station: "平车 03", planned: 500, reported: 500, status: "COMPLETED", workers: 4 },
        { id: "p3", seq: 30, name: "车缝袋身", station: "同步车 01", planned: 500, reported: 310, status: "IN_PROGRESS", workers: 4 },
        { id: "p4", seq: 40, name: "成品检验", station: "终检台", planned: 500, reported: 0, status: "IN_PROGRESS", workers: 0 }
      ],
      workers: [
        { name: "黄丽", process: "车缝袋身", amount: 90, duration: "计时中", status: "IN_PROGRESS" },
        { name: "周玉梅", process: "车缝袋身", amount: 80, duration: "45 分钟", status: "COMPLETED" },
        { name: "吴师傅", process: "车缝袋身", amount: 70, duration: "41 分钟", status: "COMPLETED" }
      ],
      records: [
        { id: "r5", time: "今天 14:28", worker: "周玉梅", process: "车缝袋身", amount: 80, duration: "45 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" },
        { id: "r6", time: "今天 14:12", worker: "吴师傅", process: "车缝袋身", amount: 70, duration: "41 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" }
      ]
    },
    {
      id: "wo-016", code: "WO-240825-016", name: "购物袋返单", product: "购物袋 · 藏青", status: "EXCEPTION",
      planned: 200, completed: 78, updatedAt: "今天 13:55", owner: "缝制三组", exception: "计划进度节点已逾期",
      processes: [
        { id: "p1", seq: 10, name: "面料裁切", station: "裁床 02", planned: 200, reported: 200, status: "COMPLETED", workers: 2 },
        { id: "p2", seq: 20, name: "提手固定", station: "平车 10", planned: 200, reported: 78, status: "EXCEPTION", workers: 1 },
        { id: "p3", seq: 30, name: "袋身合缝", station: "同步车 05", planned: 200, reported: 0, status: "IN_PROGRESS", workers: 0 }
      ],
      workers: [{ name: "郑师傅", process: "提手固定", amount: 78, duration: "3 小时 16 分", status: "EXCEPTION" }],
      records: [{ id: "r7", time: "今天 11:39", worker: "郑师傅", process: "提手固定", amount: 78, duration: "3 小时 16 分", source: "扫码报工", status: "EXCEPTION", note: "超过明确的计划节点" }]
    },
    {
      id: "wo-015", code: "WO-240825-015", name: "礼品袋急单", product: "礼品袋 · 酒红", status: "COMPLETED",
      planned: 120, completed: 120, updatedAt: "今天 12:18", owner: "样品组", exception: "",
      processes: [
        { id: "p1", seq: 10, name: "裁切", station: "裁床 01", planned: 120, reported: 120, status: "COMPLETED", workers: 1 },
        { id: "p2", seq: 20, name: "袋身缝制", station: "平车 01", planned: 120, reported: 120, status: "COMPLETED", workers: 2 },
        { id: "p3", seq: 30, name: "终检", station: "终检台", planned: 120, reported: 120, status: "COMPLETED", workers: 1 }
      ],
      workers: [{ name: "徐玲", process: "终检", amount: 120, duration: "34 分钟", status: "COMPLETED" }],
      records: [{ id: "r8", time: "今天 12:18", worker: "徐玲", process: "终检", amount: 120, duration: "34 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" }]
    },
    {
      id: "wo-014", code: "WO-240825-014", name: "束口袋返单", product: "束口袋 · 灰色", status: "COMPLETED",
      planned: 280, completed: 280, updatedAt: "昨天 17:42", owner: "缝制二组", exception: "",
      processes: [{ id: "p1", seq: 10, name: "整单完工", station: "终检台", planned: 280, reported: 280, status: "COMPLETED", workers: 5 }],
      workers: [{ name: "刘芮华", process: "整单完工", amount: 60, duration: "49 分钟", status: "COMPLETED" }],
      records: [{ id: "r9", time: "昨天 17:42", worker: "刘芮华", process: "整单完工", amount: 60, duration: "49 分钟", source: "扫码报工", status: "COMPLETED", note: "已写入黑湖" }]
    }
  ];

  const demoExceptionOrder = demoOrders.find((order) => order.id === "wo-016");
  if (demoExceptionOrder) {
    const anomalies = [
      {
        code: "PROCESS_STALLED", title: "工序超过计划进度节点", severity: "WARNING", scope: "PROCESS",
        message: "计划节点为今天 13:00，当前仍没有新的完成报工", elapsedSeconds: 3300, thresholdSeconds: 1800, recordId: "r7"
      },
      {
        code: "OPERATOR_NOT_FINISHED", title: "人员超过预计结束时间", severity: "WARNING", scope: "OPERATOR",
        message: "郑师傅超过预计结束时间 55 分钟仍未结束", elapsedSeconds: 3300, thresholdSeconds: 1800, recordId: "r7"
      }
    ];
    demoExceptionOrder.anomalies = anomalies;
    demoExceptionOrder.processes[1].anomalies = anomalies.filter((item) => item.scope === "PROCESS");
    demoExceptionOrder.workers[0].anomalies = anomalies;
    demoExceptionOrder.records[0].anomalies = anomalies;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  function statusBadge(status, compact = false, label = null) {
    const meta = statusMeta[status] || { label: status, tone: "gray" };
    return `<span class="status-badge ${meta.tone} ${compact ? "compact" : ""}"><i></i>${escapeHtml(label || meta.label)}</span>`;
  }

  function percent(order) {
    return order.planned ? Math.min(100, Math.round(order.completed / order.planned * 100)) : 0;
  }

  function filteredOrders() {
    const keyword = state.search.trim().toLocaleLowerCase("zh-CN");
    const focusedIds = state.analyticsFocus ? new Set(analyticsData(state.orders).groups.get(state.analyticsFocus)?.ids || []) : null;
    return state.orders.filter((order) => {
      if (focusedIds && !focusedIds.has(order.id)) return false;
      const matchStatus = state.filter === "ALL" || (state.filter === "IN_PROGRESS" ? order.status !== "COMPLETED" : order.status === state.filter);
      const people = order.workers.map((worker) => worker.name).join(" ");
      const haystack = `${order.code} ${order.name} ${order.product} ${people}`.toLocaleLowerCase("zh-CN");
      return matchStatus && (!keyword || haystack.includes(keyword));
    });
  }

  function selectedOrder() {
    const visibleOrders = filteredOrders();
    return visibleOrders.find((order) => order.id === state.selectedId) || visibleOrders[0];
  }

  function systemSidebar() {
    const groups = [...new Set(modules.map((item) => item.group))];
    const attentionCount = state.orders.filter((order) => ["EXCEPTION", "NEEDS_REVIEW", "QUANTITY_PENDING"].includes(order.status)).length;
    const toggleLabel = state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
    return `<aside class="system-sidebar">
      <div class="sidebar-brand"><span class="brand-mark">安</span><div><strong>安心报工</strong><small>生产执行系统</small></div><button type="button" class="sidebar-toggle" data-action="toggle-sidebar" aria-controls="system-navigation" aria-expanded="${!state.sidebarCollapsed}" aria-label="${toggleLabel}" title="${toggleLabel}">${sidebarIcon("layout-sidebar-left-collapse", "sidebar-collapse-icon")}${sidebarIcon("layout-sidebar-left-expand", "sidebar-expand-icon")}</button></div>
      <nav class="module-nav" id="system-navigation" aria-label="系统功能">${groups.map((group) => `<section><h2>${group}</h2>${modules.filter((item) => item.group === group).map((item) => `<button class="${state.activeModule === item.key ? "active" : ""}" data-action="open-module" data-module="${item.key}" aria-label="${item.title}" title="${item.title}" aria-current="${state.activeModule === item.key ? "page" : "false"}">${sidebarIcon(item.icon)}<span class="module-label">${item.title}</span>${item.key === "report" && attentionCount ? `<b>${attentionCount}</b>` : ""}</button>`).join("")}</section>`).join("")}</nav>
      <div class="sidebar-foot"><span class="sync-state"><i></i>${state.demo ? "演示数据" : state.syncWarning ? "数据同步待恢复" : "已连接黑湖"}</span><div><span class="avatar-button">${escapeHtml((state.currentUser?.name || state.currentUser?.displayName || "管").slice(0, 1))}</span><p><strong>${escapeHtml(state.currentUser?.name || state.currentUser?.displayName || state.currentUser?.username || "管理员")}</strong><small>钉钉账号</small></p></div></div>
    </aside>`;
  }

  function recentTabs() {
    return `<header class="recent-tabs"><div class="tab-strip">${state.openTabs.map((tab) => `<div class="recent-tab ${state.activeModule === tab.key ? "active" : ""}"><button class="tab-main" data-action="switch-tab" data-module="${tab.key}">${tab.title}</button>${tab.closable ? `<button class="tab-close" data-action="close-tab" data-module="${tab.key}" aria-label="关闭${tab.title}"><span></span></button>` : ""}</div>`).join("")}</div><div class="tab-actions"><button data-action="refresh">刷新</button><span class="tab-divider"></span><button data-action="not-ready">帮助</button></div></header>`;
  }

  function systemShell(content, extras = "") {
    return `<div class="erp-shell" data-sidebar-collapsed="${state.sidebarCollapsed}">${systemSidebar()}<section class="erp-stage">${recentTabs()}<div class="module-stage">${content}</div>${extras}</section></div>`;
  }

  function sidebarIcon(name, className = "") {
    return `<svg class="sidebar-icon ${className}" aria-hidden="true"><use href="#sidebar-${name}"/></svg>`;
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    try { window.localStorage?.setItem(sidebarStorageKey, String(state.sidebarCollapsed)); }
    catch { /* A blocked storage backend must not prevent this session's toggle. */ }
    // Update only the shell: rebuilding it would interrupt the Agent stream/input and reset module scroll.
    const shell = document.querySelector(".erp-shell");
    if (shell) shell.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
    const label = state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
    document.querySelectorAll('[data-action="toggle-sidebar"]').forEach((button) => {
      button.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    });
  }

  function ledgerIcon(name) {
    return `<svg class="ledger-icon" aria-hidden="true"><use href="#ledger-${name}"/></svg>`;
  }

  function ledgerProgress(order) {
    const processes = order.processes || [];
    const planned = Number(order.planned) > 0 && processes.some((process) => process.planKnown !== false && process.planned > 0) ? Number(order.planned) : null;
    const known = planned !== null && processes.length > 0 && order.routeComplete !== false
      && processes.every((process) => process.sequenceKnown !== false)
      && !["empty", "unavailable"].includes(order.processSync?.status);
    const completed = known ? Number(order.completed) || 0 : null;
    return { planned, completed, remaining: known ? Math.max(0, planned - completed) : null,
      percent: known ? Math.min(100, Math.round(completed / planned * 100)) : null };
  }

  function ledgerNumber(value) {
    return value == null ? "—" : Number(value).toLocaleString("zh-CN");
  }

  function filterBar() {
    const focusIds = state.analyticsFocus ? new Set(analyticsData(state.orders).groups.get(state.analyticsFocus)?.ids || []) : null;
    const scopeOrders = focusIds ? state.orders.filter((order) => focusIds.has(order.id)) : state.orders;
    const filters = [["ALL", "全部"], ["IN_PROGRESS", "进行中"], ["COMPLETED", "已完成"]];
    return `<div class="list-tools">
      ${state.analyticsFocus ? `<div class="analysis-focus">统计筛选：${escapeHtml(analyticsData(state.orders).groups.get(state.analyticsFocus)?.label || "关注工单")}<button data-action="clear-analysis-focus" aria-label="清除统计筛选">清除</button></div>` : ""}
      <label class="search-box">${ledgerIcon("search")}<input id="order-search" type="search" aria-label="搜索工单、产品、工人" value="${escapeHtml(state.search)}" placeholder="搜索工单、产品、工人" autocomplete="off"></label>
      <div class="filter-tabs">${filters.map(([key, label]) => {
        const count = key === "ALL" ? scopeOrders.length : scopeOrders.filter((item) => key === "IN_PROGRESS" ? item.status !== "COMPLETED" : item.status === key).length;
        return `<button class="${state.filter === key ? "active" : ""}" aria-pressed="${state.filter === key}" data-action="filter" data-filter="${key}">${label}<b>${count}</b></button>`;
      }).join("")}</div>
    </div>`;
  }

  function orderList({ ledger = false } = {}) {
    const orders = filteredOrders();
    const selectedId = orders.find((order) => order.id === state.selectedId)?.id || orders[0]?.id;
    if (!orders.length) return `<div class="empty-state"><span>⌕</span><strong>没有匹配的工单</strong><p>换个关键词或状态试试</p></div>`;
    return orders.map((order) => {
      const progress = percent(order);
      const selected = selectedId === order.id;
      if (ledger) {
        const amounts = ledgerProgress(order);
        return `<button class="ledger-row ${selected ? "selected" : ""}" aria-pressed="${selected}" data-action="select-order" data-id="${order.id}">
          <span class="ledger-identity"><span class="ledger-code" title="${escapeHtml(order.code)}">${escapeHtml(order.code)}</span><strong title="${escapeHtml(order.product)}">${escapeHtml(order.product)}</strong>${selected ? `<small>${order.processes.length} 道工序</small>` : ""}</span>
          <span class="ledger-number">${ledgerNumber(amounts.completed)}<small>/ ${ledgerNumber(amounts.planned)}</small></span>${statusBadge(order.status, true)}
        </button>`;
      }
      return `<button class="order-item ${selected ? "selected" : ""}" data-action="select-order" data-id="${order.id}">
        <div class="order-item-head"><strong>${escapeHtml(order.name)}</strong>${statusBadge(order.status, true)}</div>
        <div class="order-product">${escapeHtml(order.product)}</div>
        <div class="order-progress"><div><i style="width:${progress}%"></i></div><span>${order.completed} / ${order.planned}</span></div>
        <div class="order-foot"><span>${escapeHtml(order.code)}</span>${order.exception ? `<em>! ${escapeHtml(order.exception)}</em>` : `<span>${escapeHtml(order.updatedAt)}</span>`}</div>
      </button>`;
    }).join("");
  }

  function summary(order, compact = false) {
    return `<section class="detail-summary ledger-summary ${compact ? "compact" : ""}">
      <div class="summary-title"><div class="crumb">生产管理 / 报工管理 / ${escapeHtml(order.code)}</div><div><h1>${escapeHtml(order.name)}</h1>${statusBadge(order.status)}</div><p><span>工单号：${escapeHtml(order.code)}</span><span>更新于 ${escapeHtml(order.updatedAt)}</span></p></div>
      <div class="summary-actions"><button class="secondary-button" data-action="export" data-scope="processes">${ledgerIcon("upload")}导出工序</button><button class="primary-small" data-action="show-records">${ledgerIcon("file-text")}查看报工</button></div>
    </section>`;
  }

  function ledgerMetrics(order) {
    const values = ledgerProgress(order);
    return `<section class="ledger-metrics" aria-label="工单数量与进度">
      <div class="ledger-stat"><span>计划数量</span><div><strong>${ledgerNumber(values.planned)}</strong><small>件</small></div></div>
      <div class="ledger-stat"><span>末道工序累计</span><div><strong>${ledgerNumber(values.completed)}</strong><small>件</small></div></div>
      <div class="ledger-remaining"><span>${values.remaining === 0 ? "剩余" : "还差"}</span><strong>${ledgerNumber(values.remaining)}</strong><small>件</small></div>
      <div class="ledger-total-progress"><span>工单进度（按末道工序累计计算）</span><div><span class="ledger-progress-track"><i style="width:${values.percent ?? 0}%"></i></span><strong>${values.percent == null ? "—" : values.percent}<small>${values.percent == null ? "" : "%"}</small></strong></div><small>${values.completed == null ? "完整工艺尚未取得，暂不推断工单进度" : `${ledgerNumber(values.completed)} / ${ledgerNumber(values.planned)} 件`}</small></div>
    </section>`;
  }

  function ledgerOverruns(order) {
    return order.processes.filter((process) => process.planned > 0 && process.planKnown !== false && process.reported > process.planned);
  }

  function isQuantityPending(item) {
    return item?.quantityPending === true || (item?.assignmentStatus || item?.status) === "QUANTITY_PENDING";
  }

  function hasUnconfirmedQuantity(item) {
    return isQuantityPending(item) || item?.quantityPolicy === "PENDING_REVIEW";
  }

  function recordQuantityText(item, amount = item.amount) {
    return hasUnconfirmedQuantity(item) ? "待核量" : `${ledgerNumber(amount)} 件`;
  }

  function quantityPendingPanel(order) {
    const pending = order.records.filter(isQuantityPending);
    if (!pending.length) return "";
    return `<section class="review-panel"><div class="review-panel-head"><div><span class="warning-icon">!</span><div><h2>待核量 ${pending.length} 笔</h2><p>结束只记工时，暂未报送黑湖；数量规则确认后再处理。</p></div></div></div>${pending.map((record) => `<div class="review-line"><div><strong>${escapeHtml(record.worker)} · ${escapeHtml(record.process)}</strong><span>${escapeHtml(record.time)} · 待核量 · ${escapeHtml(record.duration)}</span></div><button data-action="open-record" data-id="${escapeHtml(record.id)}">查看详情</button></div>`).join("")}</section>`;
  }

  function ledgerAttention(order) {
    const pending = order.records.filter((record) => (record.assignmentStatus || record.status) === "NEEDS_REVIEW");
    const quantityPending = order.records.filter(isQuantityPending);
    const overruns = ledgerOverruns(order), anomaly = order.anomalies?.[0];
    const message = pending.length ? `有 ${pending.length} 笔报工待核对，请先确认黑湖结果`
      : quantityPending.length ? `有 ${quantityPending.length} 笔任务待核量，尚未计入产量`
      : anomaly ? anomaly.title : overruns.length ? `${overruns[0].name}已报 ${ledgerNumber(overruns[0].reported)} 件，计划 ${ledgerNumber(overruns[0].planned)} 件` : "";
    if (!message) return "";
    return `<div class="ledger-attention" role="status">${ledgerIcon("info-circle")}<strong>${escapeHtml(message)}</strong><button data-action="ledger-attention">查看明细 ${ledgerIcon("chevron-right")}</button></div>`;
  }

  function syncTime(value) {
    const date = new Date(value || "");
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "时间未知";
  }

  function processTable(order, { emphasized = false } = {}) {
    const sync = order.processSync;
    const note = sync?.status === "stale" ? `工序同步暂未恢复，沿用 ${syncTime(sync.updatedAt)} 的完整工序快照；不是实时进度。`
      : sync?.status === "unavailable" ? "工序暂时无法同步，以下仅为已取得的报工工序，不代表完整工艺；无需据此人工补资料。"
      : sync?.status === "empty" ? "本次黑湖查询未返回工序，以下仅显示已取得的报工记录；请核实工单关联或数据同步，不据此判定未开工。" : "";
    return `<section class="table-section process-section ${emphasized ? "emphasized" : ""}">
      <div class="section-heading"><h2>工序进度</h2><span>按工艺顺序展示计划和实际报工</span></div>
      ${note ? `<div class="sync-warning" role="status">${escapeHtml(note)}</div>` : ""}
      <div class="ledger-table-scroll" tabindex="0" aria-label="工序进度表，可横向滚动"><div class="data-table process-table">
        <div class="table-row table-head"><span>序号</span><span>工序名称</span><span>关联工位</span><span class="number">计划数量</span><span class="number">已报数量</span><span class="number">剩余数量</span><span>进度</span><span>状态</span><span>操作</span></div>
        ${order.processes.map((process, index) => {
          const expanded = state.expandedProcesses.has(process.id), planKnown = process.planKnown !== false && process.planned > 0;
          const remaining = planKnown ? Math.max(0, process.planned - process.reported) : null;
          const progress = planKnown ? Math.min(100, Math.round(process.reported / process.planned * 100)) : null;
          const over = planKnown && process.reported > process.planned, last = index === order.processes.length - 1;
          const relevantWorkers = order.workers.filter((worker) => process.taskId ? worker.taskId === process.taskId : worker.process === process.name);
          const relevantRecords = order.records.filter((record) => process.taskId ? record.taskId === process.taskId : record.process === process.name);
          return `<div class="process-group">
            <button class="table-row process-row ${expanded ? "expanded" : ""} ${last && process.reported > 0 && process.status !== "COMPLETED" ? "is-terminal" : ""}" aria-expanded="${expanded}" aria-label="${escapeHtml(process.name)}，查看人员与报工明细" data-action="toggle-process" data-id="${process.id}">
              <span class="process-index">${String(index + 1).padStart(2, "0")}</span><span class="process-name"><strong>${escapeHtml(process.name)}</strong></span>
              <span class="${!process.station || process.station === "—" ? "unlinked" : ""}">${escapeHtml(!process.station || process.station === "—" ? "未关联" : process.station)}</span>
              <span class="number">${ledgerNumber(planKnown ? process.planned : null)}</span><span class="number strong-number">${ledgerNumber(process.reported)}</span><span class="number ${last && remaining > 0 ? "remaining-number" : ""}">${ledgerNumber(remaining)}</span>
              <span class="process-progress ${process.status === "COMPLETED" ? "done" : ""}"><span class="ledger-progress-track"><i style="width:${progress ?? 0}%"></i></span><small>${progress == null ? "—" : progress + "%"}</small></span>
              <span class="process-state">${statusBadge(process.status, true)}${over ? `<small>已报超计划 ${ledgerNumber(process.reported - process.planned)} 件，建议核对</small>` : last && remaining > 0 && process.reported > 0 ? `<small>还差 ${ledgerNumber(remaining)} 件</small>` : ""}</span><span class="row-more">${ledgerIcon("dots")}</span>
            </button>
            ${expanded ? `<div class="parallel-detail">
              <div class="parallel-title"><strong>人员与报工明细</strong><span>本系统已确认：${relevantRecords.filter((item) => (item.assignmentStatus || item.status) === "COMPLETED").length} 笔，良品 ${relevantRecords.filter((item) => (item.assignmentStatus || item.status) === "COMPLETED").reduce((sum, item) => sum + (Number(item.goodQuantity ?? item.amount) || 0), 0)} 件 · 黑湖工序累计 ${ledgerNumber(process.reported)} 件</span></div>
              <div class="parallel-grid">${relevantWorkers.length ? relevantWorkers.map((worker) => `<div><span class="worker-avatar">${escapeHtml(worker.name.slice(0, 1))}</span><p><strong>${escapeHtml(worker.name)}</strong><small>${escapeHtml(worker.duration)}生产历时</small></p><b>${recordQuantityText(worker)}</b>${statusBadge(worker.status, true)}</div>`).join("") : `<p class="empty-inline">本系统尚无该工序的参与记录；黑湖其他入口的报工可能不在本地记录中。</p>`}</div>
            </div>` : ""}
          </div>`;
        }).join("") || '<div class="table-empty">尚未取得工序数据</div>'}
      </div></div>
    </section>`;
  }

  function recentLedgerRecords(order) {
    return order.records.filter((record) => ["COMPLETED", "NEEDS_REVIEW", "REPORTING", "QUANTITY_PENDING"].includes(record.assignmentStatus || record.status))
      .map((record, index) => ({ record, index, time: Date.parse(record.time) || 0 }))
      .sort((a, b) => b.time - a.time || a.index - b.index).map((item) => item.record);
  }

  function recentLedgerReports(order) {
    if (state.ledgerRecordsExpanded) return `<div class="ledger-records-full"><button class="ledger-back" data-action="hide-records">收起全部报工</button>${peopleAndRecords(order, true)}</div>`;
    const records = recentLedgerRecords(order);
    return `<section class="table-section detail-bottom recent-ledger-reports"><div class="section-heading"><h2>最近报工</h2>${records.length > 4 ? `<button data-action="show-records">查看全部 ${records.length} 笔</button>` : ""}</div>
      <div class="ledger-table-scroll" tabindex="0" aria-label="最近报工表，可横向滚动"><div class="ledger-recent-table"><div class="table-row table-head"><span>报工人</span><span>工序</span><span>报工数量</span><span>生产用时</span><span>状态</span><span>备注</span></div>
      ${records.slice(0, 4).map((record) => {
        const status = record.assignmentStatus || record.status, done = status === "COMPLETED";
        const note = done ? `${record.note && record.note !== "已同步" ? record.note + " · " : ""}本笔完成不代表整单完成` : record.note || "尚未确认成功";
        return `<button class="table-row record-row" data-action="open-record" data-id="${escapeHtml(record.id)}" title="${escapeHtml(record.time)}，点击查看详情"><span class="worker-cell"><i>${escapeHtml(record.worker.slice(0, 1))}</i><strong>${escapeHtml(record.worker)}</strong></span><span>${escapeHtml(record.process)}</span><span class="strong-number">${recordQuantityText(record, record.goodQuantity ?? record.amount)}</span><span>${escapeHtml(record.duration)}</span><span>${statusBadge(status, true, done ? "本笔已完成" : null)}</span><span>${escapeHtml(note)}</span></button>`;
      }).join("") || '<div class="table-empty">暂无已提交的报工记录；进行中的任务可点“查看报工”查看。</div>'}</div></div></section>`;
  }

  function peopleAndRecords(order, recordsOnly = false) {
    const activeTab = recordsOnly ? "records" : state.detailTab;
    const keyword = state.detailSearch.trim().toLocaleLowerCase("zh-CN");
    const workers = order.workers.filter((worker) => !keyword || `${worker.name} ${worker.process}`.toLocaleLowerCase("zh-CN").includes(keyword));
    const records = order.records.filter((record) => !keyword || `${record.worker} ${record.process} ${record.source} ${record.note}`.toLocaleLowerCase("zh-CN").includes(keyword));
    return `<section class="table-section detail-bottom ${recordsOnly ? "records-only" : ""}">
      <div class="detail-tabs">
        ${recordsOnly ? `<h2>全部报工记录</h2>` : `<button class="${activeTab === "workers" ? "active" : ""}" data-action="detail-tab" data-tab="workers">参与工人 <b>${order.workers.length}</b></button><button class="${activeTab === "records" ? "active" : ""}" data-action="detail-tab" data-tab="records">报工记录 <b>${order.records.length}</b></button>`}
        <div><label class="mini-search">⌕ <input id="detail-search" value="${escapeHtml(state.detailSearch)}" placeholder="搜索人员或工序"></label><button class="secondary-button" data-action="export">导出</button></div>
      </div>
      ${activeTab === "workers" ? workerTable(workers) : recordTable(records)}
    </section>`;
  }

  function workerTable(workers) {
    return `<div class="data-table people-table"><div class="table-row table-head"><span>工人</span><span>当前/最近工序</span><span class="number">报工数</span><span>生产历时</span><span>状态</span></div>${workers.length ? workers.map((worker) => `<div class="table-row"><span class="worker-cell"><i>${escapeHtml(worker.name.slice(0, 1))}</i><strong>${escapeHtml(worker.name)}</strong></span><span>${escapeHtml(worker.process)}</span><span class="number strong-number">${recordQuantityText(worker)}</span><span>${escapeHtml(worker.duration)}</span><span>${statusBadge(worker.status, true)}</span></div>`).join("") : `<div class="table-empty">没有匹配的人员</div>`}</div>`;
  }

  function recordTable(records) {
    return `<div class="data-table records-table"><div class="table-row table-head"><span>报工时间</span><span>工人</span><span>工序</span><span class="number">数量</span><span>生产历时</span><span>来源</span><span>结果</span></div>${records.length ? records.map((record) => `<button class="table-row record-row" data-action="open-record" data-id="${record.id}"><span>${escapeHtml(record.time)}</span><span>${escapeHtml(record.worker)}</span><span>${escapeHtml(record.process)}</span><span class="number strong-number">${recordQuantityText(record)}</span><span>${escapeHtml(record.duration)}</span><span>${escapeHtml(record.source)}</span><span>${statusBadge(record.status, true)}</span></button>`).join("") : `<div class="table-empty">没有匹配的报工记录</div>`}</div>`;
  }

  function anomalyPanel(order) {
    const anomalies = order.anomalies || [];
    if (!anomalies.length) return "";
    const rules = state.anomalyRules;
    return `<section class="anomaly-panel"><div class="anomaly-panel-head"><div><span class="anomaly-icon">!</span><div><h2>生产异常 ${anomalies.length} 项</h2><p>仅依据明确计划节点或净作业工时</p></div></div><span class="auto-rule">自动判定</span></div><div class="anomaly-lines">${anomalies.map((item) => `<button class="anomaly-line" ${item.recordId ? `data-action="open-record" data-id="${escapeHtml(item.recordId)}"` : ""}><span class="severity-dot ${item.severity === "CRITICAL" ? "critical" : ""}"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></span><b>›</b></button>`).join("")}</div><p class="rule-note">无计划节点或未扣除暂停时不判异常 · 计划逾期宽限 ${rules.deadlineGraceMinutes} 分钟</p></section>`;
  }

  function reviewPanel(order) {
    const pending = order.records.filter((record) => (record.assignmentStatus || record.status) === "NEEDS_REVIEW");
    if (!pending.length) return "";
    return `<section class="review-panel"><div class="review-panel-head"><div><span class="warning-icon">!</span><div><h2>待核对 ${pending.length} 笔</h2><p>请先在黑湖中查询，再确认本地记录状态。</p></div></div><button data-action="open-record" data-id="${pending[0].id}">查看详情</button></div>${pending.map((record) => `<div class="review-line"><div><strong>${escapeHtml(record.worker)} · ${escapeHtml(record.process)}</strong><span>${escapeHtml(record.time)} · ${recordQuantityText(record)} · ${escapeHtml(record.note)}</span></div><div><button class="confirm-missing" data-action="resolve" data-id="${record.id}" data-outcome="NOT_CREATED">黑湖没有记录</button><button class="confirm-created" data-action="resolve" data-id="${record.id}" data-outcome="CONFIRMED">黑湖已有记录</button></div></div>`).join("")}</section>`;
  }

  function reportingWorkspace(order) {
    const detail = order ? `${summary(order, true)}<div class="detail-scroll ledger-detail" tabindex="0" aria-label="工单详情滚动区域">${ledgerMetrics(order)}${ledgerAttention(order)}${processTable(order, { emphasized: true })}${recentLedgerReports(order)}</div>` : `<div class="page-empty">${state.orders.length ? "没有匹配的工单，请调整左侧搜索或筛选" : "暂无工单数据，可点击刷新重试"}</div>`;
    return `<main class="master-detail reporting-workspace ledger-simple"><aside class="master-pane"><div class="pane-title"><div><h2>工单台账</h2><span>紧凑模式</span></div><button class="text-button" data-action="refresh">${ledgerIcon("refresh")}刷新</button></div>${filterBar()}<div class="ledger-head"><span>工单 / 产品</span><span>进度</span><span>状态</span></div><div class="order-list ledger-list" tabindex="0" aria-label="工单列表滚动区域">${orderList({ ledger: true })}</div><div class="ledger-list-foot">${ledgerIcon("info-circle")}工单进度取末道工序累计</div></aside><article class="detail-pane">${detail}</article></main>`;
  }

  function recordDrawer(order) {
    if (!order || !state.drawerRecordId) return "";
    const record = order.records.find((item) => item.id === state.drawerRecordId);
    if (!record) return "";
    const cancelAction = (record.assignmentStatus || record.status) === "IN_PROGRESS" && record.source === "现场报工"
      ? `<div class="drawer-review"><h3>误开工处理</h3><p>仅用于确认无需报产量的误开工。已有实际产量应先报工，不要取消。</p><button class="confirm-missing" data-action="cancel-assignment" data-id="${escapeHtml(record.id)}">取消这笔开工</button></div>` : "";
    return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="record-drawer"><div class="drawer-head"><div><span>报工记录详情</span><strong>${escapeHtml(record.id.toUpperCase())}</strong></div><button data-action="close-drawer">×</button></div><div class="drawer-status">${statusBadge(record.status)}<span>${escapeHtml(record.note)}</span></div><dl><div><dt>工单</dt><dd>${escapeHtml(order.code)} · ${escapeHtml(order.name)}</dd></div><div><dt>产品</dt><dd>${escapeHtml(order.product)}</dd></div><div><dt>工序</dt><dd>${escapeHtml(record.process)}</dd></div><div><dt>报工人</dt><dd>${escapeHtml(record.worker)}</dd></div><div><dt>报工数量</dt><dd><b>${recordQuantityText(record)}</b>${record.defectQuantity ? `<small>（合格 ${record.goodQuantity} / 不良 ${record.defectQuantity}）</small>` : ""}</dd></div>${record.defectQuantity ? `<div><dt>不良原因</dt><dd>${escapeHtml(record.defectReasonName || "未记录")}</dd></div>` : ""}<div><dt>生产历时</dt><dd>${escapeHtml(record.duration)}</dd></div><div><dt>报工时间</dt><dd>${escapeHtml(record.time)}</dd></div><div><dt>数据来源</dt><dd>${escapeHtml(record.source)}</dd></div></dl>${record.anomalies?.length ? `<div class="drawer-anomalies"><h3>自动判定原因</h3>${record.anomalies.map((item) => `<div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p></div>`).join("")}<small>异常用于提示关注，不会自动结束或修改报工记录。</small></div>` : ""}${(record.assignmentStatus || record.status) === "NEEDS_REVIEW" ? `<div class="drawer-review"><h3>核对黑湖结果</h3><p>先在黑湖搜索该工单和操作人，确认是否已经生成产出记录。</p><button class="confirm-created" data-action="resolve" data-id="${record.id}" data-outcome="CONFIRMED">黑湖已有记录</button><button class="confirm-missing" data-action="resolve" data-id="${record.id}" data-outcome="NOT_CREATED">黑湖没有记录</button></div>` : ""}${cancelAction}<section id="record-insights" class="anomaly-analysis" aria-label="异常分析与核实"></section></aside>`;
  }

  function peopleModuleData() {
    const people = state.operators;
    const keyword = state.peopleSearch.trim().toLocaleLowerCase("zh-CN");
    const visiblePeople = people.filter((person) => !keyword || `${person.name} ${person.description || ""} ${person.blacklakeOperatorId}`.toLocaleLowerCase("zh-CN").includes(keyword));
    return { people, visiblePeople, loading: !state.demo && !state.operatorsLoaded };
  }

  function peopleTableRows({ visiblePeople, loading }) {
    const roles = [["employee", "员工"], ["floor8_leader", "8楼组长"], ["floor3_supervisor", "3楼主管"]];
    const machines = Array.from({ length: 12 }, (_, index) => `3F-${String(index + 1).padStart(2, "0")}`);
    const head = `<div class="module-table-row head"><span>人员</span><span>黑湖部门</span><span>小程序身份</span><span>3楼机台</span><span>报工归属</span><span>报工身份</span><span>开工方式</span><span>微信绑定</span></div>`;
    if (loading) return `${head}<div class="table-empty">正在读取人员…</div>`;
    if (!visiblePeople.length) return `${head}<div class="table-empty">没有匹配的人员</div>`;
    return head + visiblePeople.map((person) => `<div class="module-table-row">
      <span class="worker-identity"><span class="worker-cell"><i>${escapeHtml(person.name.slice(0, 1))}</i><strong>${escapeHtml(person.name)}</strong></span><small>${person.identitySource==='LOCAL'?'本系统成员 · '+escapeHtml(person.memberCode):'ID '+escapeHtml(person.blacklakeOperatorId)}</small></span>
      <span class="department-cell" title="${escapeHtml(person.description || "未设置")}">${escapeHtml(person.description || "未设置")}</span>
      <span><select class="profile-select" data-entry-role data-id="${person.blacklakeOperatorId}" aria-label="设置${escapeHtml(person.name)}的小程序身份" ${state.workerTypeSavingId===person.blacklakeOperatorId?'disabled':''}>${roles.map(([value, label]) => `<option value="${value}" ${person.appRole === value ? "selected" : ""}>${label}</option>`).join("")}</select></span>
      <span><select class="profile-select" data-work-unit data-id="${person.blacklakeOperatorId}" aria-label="设置${escapeHtml(person.name)}负责的3楼机台" ${person.appRole !== "employee"||person.workerType==='floor8'||state.workerTypeSavingId===person.blacklakeOperatorId ? "disabled" : ""}><option value="">不绑定</option>${machines.map((id) => `<option value="${id}" ${person.workUnitId === id ? "selected" : ""}>${id}</option>`).join("")}</select></span>
      <span class="reporting-access-cell"><select class="profile-select" data-worker-type data-id="${person.blacklakeOperatorId}" aria-label="设置${escapeHtml(person.name)}的报工归属" title="切换为8楼员工后可加入8楼派工；若原绑定3楼机台，会自动解除机台归属" ${person.appRole !== 'employee'||state.workerTypeSavingId===person.blacklakeOperatorId?'disabled':''}>${[['auto',`自动（当前${person.defaultReportingMode==='embroidery'?'绣花':'8楼'}）`],['floor8','8楼员工'],['embroidery','绣花员工']].map(([value,label])=>`<option value="${value}" ${(person.workerType||'auto')===value?'selected':''}>${label}</option>`).join('')}</select>${state.demo?`<button type="button" role="switch" aria-checked="${Boolean(person.canSwitchReportingMode)}" aria-label="允许${escapeHtml(person.name)}在手机切换普通／绣花报工" title="允许手机切换普通／绣花报工，不改变人员派工归属" class="permission-switch ${person.canSwitchReportingMode ? "active" : ""}" data-action="update-reporting-permission" data-id="${person.blacklakeOperatorId}" data-enabled="${!person.canSwitchReportingMode}" ${state.workerTypeSavingId===person.blacklakeOperatorId?'disabled':''}><i></i><b>${person.canSwitchReportingMode ? "手机可切换" : "手机固定模式"}</b></button>`:''}</span>
      <span><select class="profile-select" data-quality-role data-id="${person.blacklakeOperatorId}" aria-label="设置${escapeHtml(person.name)}的报工身份" title="质检人员结束任何工序填写合格数和不良数；普通人员填写普通数量" ${person.appRole!=='employee'||state.workerTypeSavingId===person.blacklakeOperatorId?'disabled':''}><option value="standard" ${person.qualityRole==='standard'||!person.qualityRole?'selected':''}>普通人员</option><option value="quality" ${person.qualityRole==='quality'?'selected':''}>质检人员</option><option value="quality_leader" ${person.qualityRole==='quality_leader'?'selected':''}>质检组长</option></select></span>
      <span><select class="profile-select" data-self-service data-id="${person.blacklakeOperatorId}" aria-label="设置${escapeHtml(person.name)}的开工方式" title="由后台指定谁可自主扫码或输入SKU开工；关闭后仍可完成原有任务" ${person.appRole!=='employee'||state.workerTypeSavingId===person.blacklakeOperatorId?'disabled':''}><option value="0" ${!person.selfServiceEnabled?'selected':''}>仅接派工</option><option value="1" ${person.selfServiceEnabled?'selected':''}>可自主报工</option></select></span>
      <span class="binding-cell"><span class="binding-state ${person.bound ? "bound" : "unbound"}">${person.bound ? "已绑定" : "未绑定"}</span>${person.bound ? `<button class="binding-action danger" data-action="unbind-operator" data-id="${person.blacklakeOperatorId}" data-name="${escapeHtml(person.name)}">解除</button>` : `<button class="binding-action" data-action="create-binding-code" data-id="${person.blacklakeOperatorId}">生成确认码</button>`}</span>
    </div>`).join("");
  }

  function peopleCountText({ people, visiblePeople, loading }) {
    return loading ? "正在读取人员…" : state.operatorsError || `显示 ${visiblePeople.length} / ${people.length} 人`;
  }

  function peopleSummaryStats() {
    return {
      total: state.operators.length,
      bound: state.operators.filter((person) => person.bound).length,
      configured: new Set(state.unitRecommendations.filter((item) => Number(item.blacklakeOperatorId)).map((item) => item.unitId)).size
    };
  }

  function floor8Employees() {
    return state.operators.filter((person) => person.appRole === "employee"
      && (typeof person.canReceiveFloor8Assignments==='boolean'?person.canReceiveFloor8Assignments:(person.floor8EmployeeOverride||person.defaultReportingMode !== "embroidery"&&!/绣花|刺绣/.test(person.description || "")))
      && !String(person.workUnitId || "").startsWith("3F-"));
  }

  function recommendedOperatorIds(unitId) {
    return state.unitRecommendations.filter((item) => item.unitId === unitId)
      .map((item) => Number(item.blacklakeOperatorId)).filter((id) => id > 0);
  }

  function stationDraftChanged(unitId) {
    const saved = recommendedOperatorIds(unitId);
    const draft = state.stationDraftOperatorIds;
    return saved.length !== draft.length || saved.some((id) => !draft.includes(id));
  }

  function stationRecommendationGrid() {
    const employeesById = new Map(state.operators.map((person) => [Number(person.blacklakeOperatorId), person]));
    const query = state.stationSearch.trim().toLocaleLowerCase("zh-CN");
    const groups = [
      ["A区", floor8StationIds.filter((id) => id.startsWith("A-"))],
      ["B区", floor8StationIds.filter((id) => id.startsWith("B-"))],
      ["辅助工位", floor8StationIds.filter((id) => !/^[AB]-/.test(id))]
    ];
    const result = groups.map(([label, unitIds]) => {
      const visible = unitIds.filter((unitId) => {
        const people = recommendedOperatorIds(unitId).map((id) => employeesById.get(id)).filter(Boolean);
        return !query || `${unitId} ${auxiliaryStationLabels[unitId] || ""} ${people.map((person) => `${person.name} ${person.blacklakeOperatorId}`).join(" ")}`.toLocaleLowerCase("zh-CN").includes(query);
      });
      if (!visible.length) return "";
      return `<section class="station-recommendation-group ${label === "辅助工位" ? "auxiliary" : ""}"><h3>${label}<span>${unitIds.length} ${label === "辅助工位" ? "处" : "个工位"}</span></h3><div>${visible.map((unitId) => {
        const people = recommendedOperatorIds(unitId).map((id) => employeesById.get(id)).filter(Boolean);
        const selected = state.selectedStationId === unitId;
        return `<button type="button" class="station-card ${selected ? "selected" : ""}" data-action="select-station" data-unit-id="${escapeHtml(unitId)}" aria-pressed="${selected}"><span class="station-card-head"><strong>${escapeHtml(unitId)}</strong><small class="${people.length ? "assigned" : ""}">${people.length ? `已安排 ${people.length} 人` : "未安排"}</small></span>${auxiliaryStationLabels[unitId] ? `<span class="station-short-label">${escapeHtml(auxiliaryStationLabels[unitId])}</span>` : ""}<span class="station-card-person">${people.length ? `${people.length > 1 ? `${people.length} 人 · ` : ""}${escapeHtml(people.map((person) => person.name).join("、"))}` : "选择人员"}</span></button>`;
      }).join("")}</div></section>`;
    }).join("");
    return result || '<div class="station-empty">没有匹配的工位或人员</div>';
  }

  function stationPersonList() {
    const query = state.stationPersonSearch.trim().toLocaleLowerCase("zh-CN");
    const people = floor8Employees().filter((person) => !query || `${person.name} ${person.description || ""} ${person.blacklakeOperatorId}`.toLocaleLowerCase("zh-CN").includes(query));
    if (!people.length) return `<p class="station-person-empty">${state.operatorsLoaded ? "没有匹配的8楼人员" : "正在读取人员…"}</p>`;
    return people.map((person) => {
      const selected = state.stationDraftOperatorIds.includes(Number(person.blacklakeOperatorId));
      return `<button type="button" class="station-person-option ${selected ? "selected" : ""}" data-action="choose-station-person" data-id="${escapeHtml(person.blacklakeOperatorId)}" aria-pressed="${selected}"><span class="station-person-avatar">${escapeHtml(person.name.slice(0, 1))}</span><span><strong>${escapeHtml(person.name)}</strong><small>ID ${escapeHtml(person.blacklakeOperatorId)}${person.description && person.description !== "未设置" ? ` · ${escapeHtml(person.description)}` : ""}</small></span><span class="station-person-check">${selected ? "已选" : ""}</span></button>`;
    }).join("");
  }

  function stationDetail() {
    const unitId = state.selectedStationId;
    const people = recommendedOperatorIds(unitId).map((id) => state.operators.find((item) => Number(item.blacklakeOperatorId) === id)).filter(Boolean);
    return `<div class="station-detail-head"><div><p>当前工位</p><h2>${escapeHtml(unitId)}</h2><span>8楼 · ${/^[AB]-/.test(unitId) ? `${unitId[0]}区` : "辅助工位"}${auxiliaryStationLabels[unitId] ? ` · ${escapeHtml(auxiliaryStationLabels[unitId])}` : ""}</span></div></div><div class="station-detail-current"><span>当前安排 · ${people.length} 人</span><div class="station-current-people">${people.length ? people.map((person) => `<span>${escapeHtml(person.name)}<small>ID ${escapeHtml(person.blacklakeOperatorId)}</small></span>`).join("") : "未安排"}</div></div><div class="station-detail-picker"><label for="station-person-search">选择人员（可多选）</label><input id="station-person-search" value="${escapeHtml(state.stationPersonSearch)}" placeholder="搜索姓名、部门或人员ID" autocomplete="off"><div id="station-person-list" class="station-person-list">${stationPersonList()}</div></div><div class="station-detail-actions"><button type="button" class="secondary-button" data-action="clear-station-person" ${!people.length ? "disabled" : ""}>清除安排</button><button type="button" class="primary-small" data-action="save-station-person" ${!stationDraftChanged(unitId) ? "disabled" : ""}>确认安排</button></div><p class="station-detail-note">组长进入此工位派工时，已安排人员会优先显示。</p>`;
  }

  function renderStationWorkspace() {
    const grid = document.querySelector("#station-recommendations");
    const detail = document.querySelector("#station-detail");
    const count = document.querySelector("#station-configured-count");
    if (grid) grid.innerHTML = stationRecommendationGrid();
    if (detail) detail.innerHTML = stationDetail();
    if (count) count.textContent = `${peopleSummaryStats().configured} / ${floor8StationIds.length}`;
  }

  function renderPeopleSearchResults() {
    const view = peopleModuleData();
    const count = document.querySelector("#people-count");
    const table = document.querySelector("#people-table");
    if (count) count.textContent = peopleCountText(view);
    if (table) table.innerHTML = peopleTableRows(view);
    renderStationWorkspace();
  }

  const embroideryDemoOrders = [
    ["emb-001", "WO-260909-001", "棒球帽绣花", 300, "2026-09-10", ["前幅", "后幅"]],
    ["emb-002", "WO-260909-002", "Polo衫胸花", 200, "2026-09-10", ["前幅", "后幅"]],
    ["emb-003", "WO-260908-007", "卫衣绣花", 150, "2026-09-11", ["前幅", "后幅"]],
    ["emb-004", "WO-260908-008", "T恤绣花", 120, "2026-09-11", ["前幅", "后幅"]],
    ["emb-005", "WO-260908-009", "运动裤绣花", 180, "2026-09-12", ["前幅", "后幅"]],
    ["emb-006", "WO-260907-013", "外套绣花", 260, "2026-09-12", ["前幅", "后幅"]],
    ["emb-007", "WO-260907-014", "手提袋绣花", 500, "2026-09-13", ["前幅", "后幅"]],
    ["emb-008", "WO-260907-015", "袜子绣花", 400, "2026-09-14", ["前幅", "后幅"]],
    ["emb-009", "WO-260906-021", "工作服绣花", 320, "2026-09-14", ["前幅", "后幅"]],
    ["emb-010", "WO-260906-022", "围裙绣花", 280, "2026-09-15", ["前幅", "后幅"]],
    ["emb-011", "WO-260906-023", "抱枕绣花", 150, "2026-09-15", ["前幅", "后幅"]],
    ["emb-012", "WO-260905-029", "毛巾绣花", 600, "2026-09-16", ["前幅", "后幅"]]
  ].map(([id, code, product, planned, dueDate, embroideryProcesses], index) => ({
    id, code, product, planned, dueDate, embroideryProcesses, status: "IN_PROGRESS",
    blacklakeEmbroideryProcess: { taskId: 9000 + index, name: index % 2 ? "外协加工" : "外协加工KL", processCode: index % 2 ? "WXJG" : "WXJG-KL" }
  }));

  function comparableEmbroideryProcessName(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  }

  function embroideryBlacklakeProcess(order) {
    const explicit = order?.blacklakeEmbroideryProcess;
    const processes = [
      ...(explicit ? [explicit] : []),
      ...(Array.isArray(order?.processes) ? order.processes : [])
    ];
    const matched = processes
      .map((process) => ({ process, comparable: comparableEmbroideryProcessName(process?.name || process?.processName) }))
      .filter(({ comparable }) => comparable === "外协加工KL" || comparable === "外协加工")
      .sort((left, right) => Number(right.comparable === "外协加工KL") - Number(left.comparable === "外协加工KL"))[0]?.process;
    if (!matched) return null;
    return {
      taskId: Number(matched.taskId) || null,
      name: String(matched.name || matched.processName).trim(),
      processCode: String(matched.processCode || "").trim()
    };
  }

  function normalizeEmbroideryPart(value) {
    const part = String(value || "").normalize("NFKC").trim();
    if (part === "前幅" || /^(帽前片|前片|前胸|正面)$/.test(part)) return "前幅";
    if (part === "后幅" || /^(帽后片|后片|后领|背面)$/.test(part)) return "后幅";
    return "";
  }

  function embroiderySourceOrders() {
    const live = state.orders.filter((order) => order.status !== "COMPLETED" && embroideryBlacklakeProcess(order));
    const seenIds = new Set(live.map((order) => order.id));
    const scheduled = state.embroideryScheduleOrders.filter((order) => !seenIds.has(order.id));
    const available = [...live, ...scheduled];
    if (!state.demo || available.length >= 8) return available;
    const seen = new Set(live.map((order) => order.code));
    return [...available, ...embroideryDemoOrders.filter((order) => !seen.has(order.code))].slice(0, 14);
  }

  function assignedEmbroideryOrderIds() {
    return new Set(state.embroideryMachines.flatMap((machine) => machine.queue.map((allocation) => allocation.orderId)));
  }

  function embroideryOrderById(orderId) {
    return embroiderySourceOrders().find((order) => order.id === orderId);
  }

  function embroideryProcessOptions(order) {
    return order ? embroideryPartOptions.map((part) => ({ ...part })) : [];
  }

  function embroideryAllocations() {
    return state.embroideryMachines.flatMap((machine) => machine.queue.map((allocation) => ({ ...allocation, machineId: machine.id })));
  }

  function embroideryAllocatedQuantity(orderId, excludeAllocationId = null, processKey = null) {
    return embroideryAllocations().reduce((total, allocation) => {
      if (allocation.orderId !== orderId || allocation.id === excludeAllocationId) return total;
      if (processKey && allocation.processKey !== processKey) return total;
      return total + Number(allocation.quantity || 0);
    }, 0);
  }

  function embroideryAssignedProcessKeys(orderId, excludeAllocationId = null) {
    return new Set(embroideryAllocations().filter((allocation) => allocation.orderId === orderId && allocation.id !== excludeAllocationId && allocation.processKey).map((allocation) => allocation.processKey));
  }

  function embroideryRemainingQuantity(orderId, excludeAllocationId = null, processKey = null) {
    const order = embroideryOrderById(orderId);
    if (!order) return 0;
    const planned = Number(order.planned || 0);
    if (processKey) return Math.max(0, planned - embroideryAllocatedQuantity(orderId, excludeAllocationId, processKey));
    return embroideryProcessOptions(order).reduce((total, process) => total + Math.max(0, planned - embroideryAllocatedQuantity(orderId, excludeAllocationId, process.key)), 0);
  }

  function embroideryOrderHasRemaining(order) {
    return embroideryProcessOptions(order).some((process) => embroideryRemainingQuantity(order.id, null, process.key) > 0);
  }

  function embroideryAllocationById(allocationId) {
    for (const machine of state.embroideryMachines) {
      const allocation = machine.queue.find((item) => item.id === allocationId);
      if (allocation) return { allocation, machine };
    }
    return null;
  }

  function nextEmbroideryAllocationId(orderId) {
    state.embroideryAllocationSequence += 1;
    return `emb-allocation-${orderId}-${Date.now()}-${state.embroideryAllocationSequence}`;
  }

  function embroideryDueDate(order) {
    return String(order?.dueDate || order?.deliveryDate || "").trim();
  }

  function toggleEmbroideryDueSort() {
    state.embroideryDueSort = state.embroideryDueSort === "DESC" ? "ASC" : "DESC";
  }

  function visibleEmbroideryOrders() {
    const keyword = state.embroiderySearch.trim().toLocaleLowerCase("zh-CN");
    return embroiderySourceOrders().filter((order) => {
      const allocated = embroideryAllocatedQuantity(order.id);
      if (state.embroideryFilter === "UNASSIGNED" && !embroideryOrderHasRemaining(order)) return false;
      if (state.embroideryFilter === "ASSIGNED" && allocated <= 0) return false;
      return !keyword || `${order.code} ${order.product} ${order.name || ""}`.toLocaleLowerCase("zh-CN").includes(keyword);
    }).sort((a, b) => {
      const leftDue = embroideryDueDate(a);
      const rightDue = embroideryDueDate(b);
      if (!leftDue && rightDue) return 1;
      if (leftDue && !rightDue) return -1;
      const dueOrder = leftDue.localeCompare(rightDue);
      if (dueOrder) return state.embroideryDueSort === "DESC" ? -dueOrder : dueOrder;
      return a.code.localeCompare(b.code, "zh-CN");
    });
  }

  function normalizeEmbroideryAllocation(item, machineId, index, usedByProcess) {
    const orderId = typeof item === "string" ? item : item?.orderId;
    const order = embroideryOrderById(orderId);
    if (!order) return null;
    const planned = Number(order.planned || 0);
    const fallbackProcess = embroideryProcessOptions(order)[0]?.key || "前幅";
    const processKey = normalizeEmbroideryPart(typeof item === "object" ? item.processKey || item.processName || fallbackProcess : fallbackProcess);
    if (!processKey) return null;
    const blacklakeProcess = embroideryBlacklakeProcess(order);
    if (!blacklakeProcess) return null;
    const usageKey = `${orderId}:${processKey}`;
    const used = usedByProcess.get(usageKey) || 0;
    const requested = typeof item === "string" ? planned : Math.floor(Number(item.quantity));
    const quantity = Math.min(Number.isFinite(requested) ? requested : 0, Math.max(0, planned - used));
    if (quantity < 1) return null;
    usedByProcess.set(usageKey, used + quantity);
    return {
      id: typeof item === "object" && typeof item.id === "string" ? item.id : `emb-legacy-${machineId}-${index}-${orderId}`,
      orderId,
      mode: "COMBINED",
      processKey,
      processName: processKey,
      blacklakeTaskId: blacklakeProcess.taskId,
      blacklakeProcessName: blacklakeProcess.name,
      blacklakeProcessCode: blacklakeProcess.processCode,
      quantity
    };
  }

  function restoreEmbroiderySchedule() {
    // Legacy compatibility stub. The live board never restores browser-side scheduling data.
  }

  function applyEmbroiderySchedule(schedule) {
    const machines = Array.isArray(schedule?.machines) ? schedule.machines : [];
    const orders = new Map();
    for (const machine of machines) for (const item of Array.isArray(machine?.queue) ? machine.queue : []) {
      if (!item?.orderId || orders.has(String(item.orderId))) continue;
      orders.set(String(item.orderId), {
        id: String(item.orderId),
        projectId: Number(item.projectId) || null,
        code: String(item.projectCode || ""),
        name: `${item.productName || "绣花"}工单`,
        product: String(item.productName || "未命名产品"),
        planned: Number(item.plannedQuantity) || Number(item.quantity) || 0,
        status: "IN_PROGRESS",
        blacklakeEmbroideryProcess: {
          taskId: Number(item.blacklakeTaskId) || null,
          name: String(item.blacklakeProcessName || ""),
          processCode: String(item.blacklakeProcessCode || "")
        }
      });
    }
    state.embroideryScheduleOrders = [...orders.values()];
    for (const machine of state.embroideryMachines) machine.queue = [];
    const usedByProcess = new Map();
    for (const entry of machines) {
      const machine = state.embroideryMachines.find((item) => item.id === String(entry?.id));
      if (!machine || !Array.isArray(entry.queue)) continue;
      const seenOnMachine = new Set();
      for (const [index, item] of entry.queue.entries()) {
        const allocation = normalizeEmbroideryAllocation(item, machine.id, index, usedByProcess);
        const allocationKey = allocation && `${allocation.orderId}:${allocation.processKey}`;
        if (!allocation || seenOnMachine.has(allocationKey)) continue;
        seenOnMachine.add(allocationKey);
        machine.queue.push(allocation);
      }
    }
    state.embroideryScheduleRevision = Number(schedule?.revision) || 0;
    state.embroideryScheduleLoaded = true;
    state.embroideryScheduleError = "";
    state.embroideryDirty = false;
  }

  function embroiderySchedulePayload() {
    return [];
  }

  async function loadEmbroiderySchedule({ preserveDirty = true } = {}) {
    void preserveDirty;
  }

  async function saveEmbroiderySchedule() {
    return false;
  }

  function assignEmbroideryOrder(orderId, machineId, slot, quantity, allocationId = null, details = {}) {
    const target = state.embroideryMachines.find((machine) => machine.id === machineId);
    const order = embroideryOrderById(orderId);
    const blacklakeProcess = embroideryBlacklakeProcess(order);
    if (!target || !order || !blacklakeProcess) return false;
    let allocation;
    let source;
    if (allocationId) {
      const found = embroideryAllocationById(allocationId);
      if (!found || found.allocation.orderId !== orderId) return false;
      allocation = found.allocation;
      source = found.machine;
      const duplicate = target.queue.find((item) => item.id !== allocationId && item.orderId === orderId && item.processKey === allocation.processKey);
      if (duplicate) {
        if (duplicate.quantity + allocation.quantity > Number(order.planned || 0)) return false;
        duplicate.quantity += allocation.quantity;
        source.queue = source.queue.filter((item) => item.id !== allocationId);
        state.embroiderySelectedMachineId = target.id;
        state.embroideryDirty = true;
        return true;
      }
      source.queue = source.queue.filter((item) => item.id !== allocationId);
    } else {
      const processKey = normalizeEmbroideryPart(details.processKey);
      if (!processKey || target.queue.some((item) => item.orderId === orderId && item.processKey === processKey)) return false;
      const process = embroideryProcessOptions(order).find((item) => item.key === processKey);
      if (!process) return false;
      const remaining = embroideryRemainingQuantity(orderId, null, processKey);
      const requested = quantity === undefined ? remaining : Math.floor(Number(quantity));
      if (!Number.isFinite(requested) || requested < 1 || requested > remaining) return false;
      allocation = {
        id: nextEmbroideryAllocationId(orderId), orderId, mode: "COMBINED", processKey, processName: process.name, quantity: requested,
        blacklakeTaskId: blacklakeProcess.taskId, blacklakeProcessName: blacklakeProcess.name, blacklakeProcessCode: blacklakeProcess.processCode
      };
    }
    const insertAt = Number.isFinite(Number(slot)) ? Math.max(0, Math.min(Number(slot), target.queue.length)) : target.queue.length;
    target.queue.splice(insertAt, 0, allocation);
    state.embroiderySelectedMachineId = target.id;
    state.embroideryDirty = true;
    return true;
  }

  function updateEmbroideryAllocation(allocationId, quantity) {
    const found = embroideryAllocationById(allocationId);
    if (!found) return false;
    return updateEmbroideryAllocationDetails(allocationId, quantity, found.allocation.processKey);
  }

  function updateEmbroideryProcessAllocation(allocationId, processKey) {
    const found = embroideryAllocationById(allocationId);
    if (!found) return false;
    return updateEmbroideryAllocationDetails(allocationId, found.allocation.quantity, processKey);
  }

  function updateEmbroideryAllocationDetails(allocationId, quantity, processKey) {
    const found = embroideryAllocationById(allocationId);
    const order = embroideryOrderById(found?.allocation.orderId);
    if (!found || !order) return false;
    const normalizedKey = normalizeEmbroideryPart(processKey);
    const process = embroideryProcessOptions(order).find((item) => item.key === normalizedKey);
    const requested = Math.floor(Number(quantity));
    const maximum = embroideryRemainingQuantity(order.id, allocationId, normalizedKey);
    const duplicate = found.machine.queue.find((item) => item.id !== allocationId && item.orderId === order.id && item.processKey === normalizedKey);
    const blacklakeProcess = embroideryBlacklakeProcess(order);
    if (!normalizedKey || !process || !blacklakeProcess || duplicate || !Number.isFinite(requested) || requested < 1 || requested > maximum) return false;
    found.allocation.processKey = process.key;
    found.allocation.processName = process.name;
    found.allocation.blacklakeTaskId = blacklakeProcess.taskId;
    found.allocation.blacklakeProcessName = blacklakeProcess.name;
    found.allocation.blacklakeProcessCode = blacklakeProcess.processCode;
    found.allocation.mode = "COMBINED";
    found.allocation.quantity = requested;
    state.embroideryDirty = true;
    return true;
  }

  function unassignEmbroideryAllocation(allocationId) {
    const found = embroideryAllocationById(allocationId);
    if (!found) return false;
    found.machine.queue = found.machine.queue.filter((allocation) => allocation.id !== allocationId);
    state.embroideryDirty = true;
    return true;
  }

  function unassignEmbroideryOrder(orderId) {
    let changed = false;
    for (const machine of state.embroideryMachines) {
      const next = machine.queue.filter((allocation) => allocation.orderId !== orderId);
      if (next.length !== machine.queue.length) changed = true;
      machine.queue = next;
    }
    if (changed) state.embroideryDirty = true;
    return changed;
  }

  function closeEmbroideryAllocationDialog() {
    state.embroideryAllocationDraft = null;
    confirmDialog.classList.add("hidden");
    confirmDialog.setAttribute("aria-hidden", "true");
  }

  function renderEmbroideryAllocationDialog() {
    return false;
  }

  function syncEmbroideryAllocationAvailability() {
    const draft = state.embroideryAllocationDraft;
    const processInput = document.querySelector("#embroidery-allocation-process");
    const quantityInput = document.querySelector("#embroidery-allocation-quantity");
    if (!draft || !processInput || !quantityInput) return;
    const processKey = processInput.value.trim();
    const allocated = processKey ? embroideryAllocatedQuantity(draft.orderId, draft.allocationId, processKey) : 0;
    const available = processKey ? embroideryRemainingQuantity(draft.orderId, draft.allocationId, processKey) : 0;
    draft.processKey = processKey;
    draft.available = available;
    quantityInput.max = String(available);
    if (Number(quantityInput.value) > available) quantityInput.value = String(available);
    const assignedLabel = document.querySelector("#allocation-process-assigned");
    const availableLabel = document.querySelector("#allocation-process-available");
    if (assignedLabel) assignedLabel.textContent = `${allocated} 件`;
    if (availableLabel) availableLabel.textContent = `${available} 件`;
    document.querySelectorAll("[data-action='embroidery-allocation-shortcut']").forEach((button) => {
      const next = button.dataset.kind === "all" ? available : button.dataset.kind === "half" ? Math.max(1, Math.ceil(available / 2)) : Math.min(100, available);
      button.dataset.quantity = String(next);
      button.textContent = button.dataset.kind === "all" ? "全部剩余" : button.dataset.kind === "half" ? `一半 ${next}` : `${next} 件`;
    });
  }

  function requestEmbroideryAllocation(orderId, machineId, slot, allocationId = null) {
    const order = embroideryOrderById(orderId);
    const machine = state.embroideryMachines.find((item) => item.id === machineId);
    if (!order || !machine) return false;
    if (!embroideryBlacklakeProcess(order)) {
      showToast("这张工单未找到“外协加工KL”或“外协加工”工序");
      return false;
    }
    const found = allocationId ? embroideryAllocationById(allocationId) : null;
    if (!found && !embroideryOrderHasRemaining(order)) {
      showToast("这张工单的全部工艺数量已经分配完成");
      return false;
    }
    state.embroideryAllocationDraft = { orderId, machineId, slot, allocationId: found?.allocation.id || null };
    state.embroiderySelectedMachineId = machineId;
    state.embroideryInspectorOpen = true;
    return renderEmbroideryAllocationDialog();
  }

  function confirmEmbroideryAllocation() {
    const draft = state.embroideryAllocationDraft;
    const order = embroideryOrderById(draft?.orderId);
    if (!draft || !order) return false;
    const processInput = document.querySelector("#embroidery-allocation-process");
    const quantityInput = document.querySelector("#embroidery-allocation-quantity");
    const processName = normalizeEmbroideryPart(processInput?.value);
    const quantity = Math.floor(Number(quantityInput?.value));
    const available = processName ? embroideryRemainingQuantity(draft.orderId, draft.allocationId, processName) : 0;
    if (!processName) {
      showToast("请选择前幅或后幅");
      processInput?.focus();
      return false;
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > available) {
      showToast(`请输入 1 到 ${available} 之间的整数`);
      quantityInput?.focus();
      return false;
    }
    const assigned = draft.allocationId
      ? updateEmbroideryAllocationDetails(draft.allocationId, quantity, processName)
      : assignEmbroideryOrder(draft.orderId, draft.machineId, draft.slot, quantity, null, { processKey: processName });
    if (!assigned) {
      showToast("分配失败，请检查是否重复或超过可分范围");
      return false;
    }
    const machineId = draft.machineId;
    closeEmbroideryAllocationDialog();
    state.embroideryPendingOrderId = embroideryOrderHasRemaining(order) ? order.id : null;
    render();
    showToast(`已将${processName} · ${quantity} 件排到 ${machineId} 号机，黑湖对应${embroideryBlacklakeProcess(order).name}`);
    return true;
  }

  function embroideryDropEffect() {
    return state.embroideryDraggedAllocationId ? "move" : "copy";
  }

  function embroideryStatus(machine) {
    const key = machine.current ? (machine.current.status === "IN_PROGRESS" ? "RUNNING" : machine.current.status) : "IDLE";
    const meta = machineStatusMeta[key] || machineStatusMeta.RUNNING;
    return `<span class="machine-state ${meta.tone}"><i></i>${meta.label}</span>`;
  }

  function embroideryOrderRows() {
    return "";
  }

  function machineStation(machine) {
    const selected = machine.id === state.embroiderySelectedMachineId;
    const current = machine.current;
    const statusKey = current ? (current.status === "IN_PROGRESS" ? "RUNNING" : current.status) : "IDLE";
    const status = machineStatusMeta[statusKey] || machineStatusMeta.RUNNING;
    return `<section class="embroidery-station ${selected ? "selected" : ""}" tabindex="0" data-action="select-machine" data-machine-id="${machine.id}" aria-label="${machine.id}号绣花机 ${status.label}">
      <img src="${embroideryMachineListImage}" alt="" width="720" height="307" loading="lazy" decoding="async" draggable="false">
      <div class="station-summary"><header><strong>${machine.id}</strong>${embroideryStatus(machine)}</header>${current ? `<p class="station-worker">${escapeHtml(current.operatorName)}</p><small>${escapeHtml(current.code)} · ${escapeHtml(current.embroideryPart)}</small><div class="station-task-line"><span>${escapeHtml(current.processName)}</span><b>${recordQuantityText(current, current.quantity)}</b></div>` : `<p class="station-idle">暂无生产任务</p><small>等待员工开工</small><div class="station-task-line"><span>—</span><b>空闲</b></div>`}</div>
    </section>`;
  }

  function machineQueueSlot(machine, index) {
    void machine;
    void index;
    return "";
  }

  function embroideryInspector() {
    const machine = state.embroideryMachines.find((item) => item.id === state.embroiderySelectedMachineId) || state.embroideryMachines[0];
    const current = machine.current;
    const statusKey = current ? (current.status === "IN_PROGRESS" ? "RUNNING" : current.status) : "IDLE";
    const status = machineStatusMeta[statusKey] || machineStatusMeta.RUNNING;
    return `<aside class="embroidery-inspector"><header><div><h2>${machine.id} 号机</h2>${embroideryStatus(machine)}</div><button type="button" class="inspector-close" data-action="toggle-embroidery-inspector" aria-label="关闭机台详情"></button></header>
      <img class="inspector-machine-image" src="${embroideryMachineDetailImage}" alt="${machine.id}号绣花机" width="1400" height="597" decoding="async">
      <dl><div><dt>机位编号</dt><dd>${machine.id}</dd></div><div><dt>设备型号</dt><dd>${escapeHtml(machine.model)}</dd></div><div><dt>当前位置</dt><dd>${escapeHtml(machine.position)}</dd></div><div><dt>设备状态</dt><dd>${status.label}</dd></div>${current ? `<div><dt>操作工人</dt><dd>${escapeHtml(current.operatorName)}</dd></div>` : ""}</dl>
      <section class="inspector-task"><h3>当前任务</h3>${current ? `<div><strong>${escapeHtml(current.operatorName)} · ${escapeHtml(current.embroideryPart)}</strong><span>${escapeHtml(current.code)}</span><span>${escapeHtml(current.product)}</span><small>${escapeHtml(current.processName)} · ${recordQuantityText(current, current.quantity)}</small><small>开工 ${escapeHtml(current.startedAt)}</small></div>` : `<p>暂无生产任务。</p>`}</section>
      <p class="inspector-readonly-note">现场任务按人员绑定的位置显示。</p>
    </aside>`;
  }

  function embroideryWorkspace() {
    const counts = {
      RUNNING: state.embroideryMachines.filter((machine) => machine.current).length,
      IDLE: state.embroideryMachines.filter((machine) => !machine.current).length
    };
    const source = state.embroideryLayoutMode === "LOAD"
      ? [...state.embroideryMachines].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || a.id.localeCompare(b.id))
      : state.embroideryMachines;
    const left = source.slice(0, 6);
    const right = source.slice(6, 12);
    return `<main class="embroidery-workspace read-only ${state.embroideryInspectorOpen ? "" : "inspector-closed"}">
      <header class="embroidery-toolbar"><div class="embroidery-toolbar-title"><h1>绣花机现场看板</h1><span class="machine-state running"><i></i>使用中 <b>${counts.RUNNING}</b></span><span class="machine-state idle"><i></i>空闲 <b>${counts.IDLE}</b></span><em>共 12 台</em><span class="mobile-allocation-hint">开工后自动更新</span></div><div class="embroidery-toolbar-actions"><button class="summary-toggle ${state.embroideryInspectorOpen ? "active" : ""}" data-action="toggle-embroidery-inspector" aria-expanded="${state.embroideryInspectorOpen}">机台详情</button><div class="segmented-control"><button class="${state.embroideryLayoutMode === "POSITION" ? "active" : ""}" data-action="embroidery-layout" data-layout="POSITION">按机位</button><button class="${state.embroideryLayoutMode === "LOAD" ? "active" : ""}" data-action="embroidery-layout" data-layout="LOAD">按状态</button></div><button class="primary-small" data-action="refresh">刷新</button></div></header>
      <section class="machine-floor"><div class="machine-bank">${left.map(machineStation).join("")}</div><div class="machine-aisle"><i></i><span>${state.embroideryLayoutMode === "POSITION" ? "绣花区通道" : "按状态排列"}</span><i></i></div><div class="machine-bank">${right.map(machineStation).join("")}</div></section>${state.embroideryInspectorOpen ? embroideryInspector() : ""}
    </main>`;
  }

  const auditEventMeta = Object.freeze({
    REPORT_SUCCEEDED: { label: "报工成功", tone: "green" },
    REPORT_FAILED: { label: "报工失败", tone: "red" },
    REPORT_UNKNOWN: { label: "结果待核对", tone: "orange" },
    REPORT_PENDING: { label: "报工提交中", tone: "blue" },
    ASSIGNMENT_CANCELLED: { label: "任务已取消", tone: "gray" },
    ASSIGNMENT_ACTION: { label: "任务操作", tone: "gray" }
  });

  const auditActorLabels = Object.freeze({
    AUTHENTICATED_OPERATOR: "工人",
    AUTHENTICATED_ADMIN: "管理员",
    SYSTEM: "系统"
  });

  function auditTime(value) {
    if (!value) return "—";
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(date);
  }

  function auditOption(value, label, selected) {
    return `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function auditRows() {
    if (state.auditLoading && !state.auditEvents.length) return `<div class="table-empty">正在读取审计日志…</div>`;
    if (state.auditError && !state.auditEvents.length) return `<div class="table-empty audit-error">${escapeHtml(state.auditError)}</div>`;
    if (!state.auditEvents.length) return `<div class="table-empty">当前筛选条件下没有审计记录</div>`;
    return state.auditEvents.map((event) => {
      const meta = auditEventMeta[event.eventType] || { label: event.eventType || "未知事件", tone: "gray" };
      const amount = event.eventType.startsWith("REPORT_") ? `<small>${Number(event.amount || 0)} 件</small>` : "";
      const error = event.errorCode ? `<b class="audit-code">${escapeHtml(event.errorCode)}</b>` : `<span class="audit-muted">—</span>`;
      const machine = event.machineId ? `${escapeHtml(event.machineId)} 号机${event.embroideryPart ? ` · ${escapeHtml(event.embroideryPart)}` : ""}` : "—";
      const actor = auditActorLabels[event.actor] || event.actor || "—";
      return `<div class="audit-row">
        <time>${escapeHtml(auditTime(event.eventTime))}</time>
        <span><i class="audit-event ${meta.tone}">${escapeHtml(meta.label)}</i>${amount}</span>
        <span class="audit-worker"><strong>${escapeHtml(event.operatorName || "—")}</strong><small>ID ${escapeHtml(event.blacklakeOperatorId || "—")}</small></span>
        <span class="audit-order"><strong>${escapeHtml(event.projectCode || "—")}</strong><small>${escapeHtml(event.processName || "—")} · 任务 ${escapeHtml(event.taskId || "—")}</small></span>
        <span>${machine}</span>
        <span>${error}</span>
        <span>${escapeHtml(actor)}</span>
        <span class="audit-reason" title="${escapeHtml(event.reason || "无补充原因")}">${escapeHtml(event.reason || "无补充原因")}</span>
      </div>`;
    }).join("");
  }

  function auditModule() {
    const eventOptions = [
      ["ALL", "全部事件"], ["REPORT_SUCCEEDED", "报工成功"], ["REPORT_FAILED", "报工失败"],
      ["REPORT_UNKNOWN", "结果待核对"], ["REPORT_PENDING", "报工提交中"],
      ["ASSIGNMENT_CANCELLED", "任务取消"], ["ASSIGNMENT_ACTION", "其他任务操作"]
    ];
    const errorCodes = state.auditErrorCode !== "ALL" && !state.auditFacets.errorCodes.includes(state.auditErrorCode)
      ? [state.auditErrorCode, ...state.auditFacets.errorCodes] : state.auditFacets.errorCodes;
    const actors = state.auditActor !== "ALL" && !state.auditFacets.actors.includes(state.auditActor)
      ? [state.auditActor, ...state.auditFacets.actors] : state.auditFacets.actors;
    const shownFrom = state.auditTotal ? state.auditOffset + 1 : 0;
    const shownTo = Math.min(state.auditOffset + state.auditEvents.length, state.auditTotal);
    return `<main class="secondary-module audit-module"><header><div><p>系统管理</p><h1>审计日志</h1><span>保留报工结果、失败原因和任务取消操作；页面只读，不修改生产数据</span></div><button class="primary-small" data-action="refresh-audit">刷新日志</button></header>
      <section class="module-panel audit-panel">
        <div class="audit-filters">
          <label class="search-box"><span>⌕</span><input id="audit-search" value="${escapeHtml(state.auditQuery)}" maxlength="100" placeholder="搜索工人、工单、机器、任务ID或原因"></label>
          <label><span>事件</span><select id="audit-event-type">${eventOptions.map(([value, label]) => auditOption(value, label, state.auditEventType)).join("")}</select></label>
          <label><span>错误码</span><select id="audit-error-code">${auditOption("ALL", "全部错误码", state.auditErrorCode)}${errorCodes.map((value) => auditOption(value, value, state.auditErrorCode)).join("")}</select></label>
          <label><span>操作人</span><select id="audit-actor">${auditOption("ALL", "全部操作人", state.auditActor)}${actors.map((value) => auditOption(value, auditActorLabels[value] || value, state.auditActor)).join("")}</select></label>
          <label><span>开始日期</span><input id="audit-from" type="date" value="${escapeHtml(state.auditFrom)}"></label>
          <label><span>结束日期</span><input id="audit-to" type="date" value="${escapeHtml(state.auditTo)}"></label>
          <div class="audit-filter-actions"><button class="secondary-button" data-action="reset-audit">重置</button><button class="primary-small" data-action="search-audit">查询</button></div>
        </div>
        ${state.auditError ? `<div class="audit-warning" role="status">${escapeHtml(state.auditError)}；当前保留上次成功结果。</div>` : ""}
        <div class="audit-summary"><span>共 ${state.auditTotal} 条记录${state.auditTotal ? `，当前显示 ${shownFrom}–${shownTo}` : ""}</span><small>时间按当前设备时区显示</small></div>
        <div class="audit-table"><div class="audit-row audit-head"><span>时间</span><span>事件</span><span>工人</span><span>工单 / 工序</span><span>机器</span><span>错误码</span><span>操作人</span><span>原因</span></div>${auditRows()}</div>
        <div class="audit-pagination"><button class="secondary-button" data-action="audit-page" data-offset="${Math.max(0, state.auditOffset - state.auditLimit)}" ${state.auditOffset <= 0 || state.auditLoading ? "disabled" : ""}>上一页</button><span>第 ${state.auditTotal ? Math.floor(state.auditOffset / state.auditLimit) + 1 : 1} / ${Math.max(1, Math.ceil(state.auditTotal / state.auditLimit))} 页</span><button class="secondary-button" data-action="audit-page" data-offset="${state.auditOffset + state.auditLimit}" ${state.auditOffset + state.auditLimit >= state.auditTotal || state.auditLoading ? "disabled" : ""}>下一页</button></div>
      </section>
    </main>`;
  }

  function secondaryModule(moduleKey) {
    if (moduleKey === "management") return `<main id="management" class="management" aria-label="人员与派工管理"></main>`;
    if (moduleKey === "task-recovery") return `<main id="task-recovery" class="task-recovery" aria-label="待处理任务"></main>`;
    if (moduleKey === "data-sync") return `<main id="data-sync" class="data-sync" aria-label="数据同步"></main>`;
    if (moduleKey === "dispatch-predictions") return `<main id="dispatch-feedback" class="dispatch-feedback" aria-label="派工预测反馈"></main>`;
    if (moduleKey === "home") return `<main id="agent-home" class="agent-home" aria-label="生产查询助手"></main>`;
    if (moduleKey === "weekly") return `<main id="weekly-report" class="weekly-report" aria-label="生产周报"></main>`;
    if (moduleKey === "production" && state.demo) return `<main class="secondary-module"><h1>3D生产看板</h1><p>此看板使用正式派单与黑湖数据。请<a href="/admin?view=production">登录正式页面</a>后查看。</p></main>`;
    if (moduleKey === "production") return `<main class="production-module"><iframe id="production-3d-frame" title="3D生产看板" src="/admin/production-3d/?embedded=1&workspace=1" allow="fullscreen"></iframe></main>`;
    if (moduleKey === "embroidery") return embroideryWorkspace();
    if (moduleKey === "audit") return auditModule();
    if (moduleKey === "people") {
      const view = peopleModuleData();
      const stats = peopleSummaryStats();
      return `<main class="secondary-module people-module"><header class="people-page-header"><div><p>基础资料</p><h1>人员与工位</h1><span>8楼工位安排与人员报工权限</span></div><button class="secondary-button" data-action="refresh-operators">刷新人员</button></header>
        <nav class="people-view-tabs" aria-label="人员与工位视图"><button type="button" data-action="people-tab" data-tab="stations" class="${state.peopleTab === "stations" ? "active" : ""}" aria-current="${state.peopleTab === "stations" ? "page" : "false"}">工位安排</button><button type="button" data-action="people-tab" data-tab="permissions" class="${state.peopleTab === "permissions" ? "active" : ""}" aria-current="${state.peopleTab === "permissions" ? "page" : "false"}">人员权限</button><button type="button" data-action="people-tab" data-tab="groups" class="${state.peopleTab === "groups" ? "active" : ""}" aria-current="${state.peopleTab === "groups" ? "page" : "false"}">人员分类</button><button type="button" data-action="people-tab" data-tab="members" class="${state.peopleTab==='members'?'active':''}">本系统成员</button></nav>
        ${state.peopleTab === "members" ? '<section id="local-member-manager"></section>' : state.peopleTab === "groups" ? peopleGroupsManager.render() : state.peopleTab === "stations" ? `<div class="people-workspace station-workspace"><section class="station-overview"><div class="station-overview-heading"><div><h2>8楼工位安排</h2><p>共 ${floor8StationIds.length} 处 · 已安排 <strong id="station-configured-count">${stats.configured} / ${floor8StationIds.length}</strong>${state.demo ? ' · <span class="station-demo-inline">演示数据 · <a href="?">登录正式页面</a>后使用黑湖人员</span>' : ""}</p></div><label class="station-search-label"><span class="sr-only">搜索工位或人员</span><input id="station-search" value="${escapeHtml(state.stationSearch)}" placeholder="搜索工位或人员姓名" autocomplete="off"></label></div><div id="station-recommendations" class="station-recommendation-grid">${stationRecommendationGrid()}</div></section><aside id="station-detail" class="station-detail">${stationDetail()}</aside></div>` : `<div class="people-workspace permission-workspace"><section class="module-panel people-directory-panel"><div class="module-toolbar"><div><strong>人员权限</strong><span id="people-count">${peopleCountText(view)}</span></div><label class="search-box"><span>⌕</span><input id="people-search" value="${escapeHtml(state.peopleSearch)}" placeholder="搜索姓名、部门或人员ID"></label></div><div id="people-table" class="module-table binding-table permission-table">${peopleTableRows(view)}</div></section></div>`}</main>`;
    }
    return analyticsModule();
  }

  // Snapshot observations, not delivery promises, employee rankings or cycle-time alarms.
  function analyticsData(orders) {
    const groups = new Map([
      ["closed", { label: "工序已全部完成", ids: [] }],
      ["closing", { label: "接近收尾", ids: [] }],
      ["moving", { label: "生产推进中", ids: [] }],
      ["unreported", { label: "暂无工序报工", ids: [] }],
      ["unknown", { label: "工序信息暂不可判定", ids: [] }],
      ["review", { label: "报工待核对", ids: [] }],
      ["quantityPending", { label: "任务待核量", ids: [] }],
      ["anomaly", { label: "规则关注项", ids: [] }]
    ]);
    let reviewCount = 0, quantityPendingCount = 0, anomalyCount = 0;
    const gaps = new Map();
    for (const order of orders) {
      const pending = order.records.filter((record) => (record.assignmentStatus || record.status) === "NEEDS_REVIEW");
      reviewCount += pending.length;
      if (pending.length) groups.get("review").ids.push(order.id);
      const quantityPending = order.records.filter(isQuantityPending);
      quantityPendingCount += quantityPending.length;
      if (quantityPending.length) groups.get("quantityPending").ids.push(order.id);
      if (order.anomalies?.length) {
        groups.get("anomaly").ids.push(order.id);
        anomalyCount += order.anomalies.length;
      }
      const processes = order.processes;
      const completeRoute = order.routeComplete === true && processes.length > 0;
      const allClosed = completeRoute && !quantityPending.length && processes.every((process) => process.status === "COMPLETED");
      const nearFinish = completeRoute && !allClosed && !pending.length && !quantityPending.length && processes.every((process) => process.planKnown !== false && process.planned > 0 && process.reported / process.planned >= 0.9);
      const stage = !completeRoute ? "unknown" : allClosed ? "closed" : nearFinish ? "closing" : processes.some((process) => process.reported > 0) ? "moving" : "unreported";
      groups.get(stage).ids.push(order.id);
      if (!completeRoute || allClosed) continue;
      const sequenceCounts = new Map();
      for (const process of processes) sequenceCounts.set(process.seq, (sequenceCounts.get(process.seq) || 0) + 1);
      for (let i = 1; i < processes.length; i++) {
        const before = processes[i - 1], after = processes[i];
        // Equal sequence is parallel; different plans are not directly comparable.
        if (before.sequenceKnown !== true || after.sequenceKnown !== true || before.planKnown === false || after.planKnown === false || sequenceCounts.get(before.seq) !== 1 || sequenceCounts.get(after.seq) !== 1 || before.seq >= after.seq || before.planned <= 0 || before.planned !== after.planned || after.status === "COMPLETED") continue;
        const difference = Math.max(0, Math.min(before.planned, before.reported) - Math.min(after.planned, after.reported));
        if (difference < Math.max(20, before.planned * 0.2)) continue;
        const key = `gap:${encodeURIComponent(after.name)}`;
        if (!gaps.has(key)) gaps.set(key, { key, name: after.name, difference: 0, ids: new Set() });
        const gap = gaps.get(key);
        gap.difference += difference;
        gap.ids.add(order.id);
      }
    }
    const rankedGaps = [...gaps.values()].sort((a, b) => b.ids.size - a.ids.size || b.difference - a.difference || a.name.localeCompare(b.name));
    for (const gap of rankedGaps) groups.set(gap.key, { label: `${gap.name} · 前后报工差`, ids: [...gap.ids] });
    const count = (key) => groups.get(key).ids.length;
    const insights = [];
    if (reviewCount) insights.push({ key: "review", title: `${reviewCount} 笔报工结果需要先核对`, detail: `涉及 ${count("review")} 张工单。先到黑湖确认是否写入，再处理本地状态，避免重复报工。`, action: "去核对", tone: "attention" });
    if (quantityPendingCount) insights.push({ key: "quantityPending", title: `${quantityPendingCount} 笔任务待核量`, detail: `涉及 ${count("quantityPending")} 张工单。结束只记工时，暂未报送黑湖，数量尚未计入产量。`, action: "查看任务", tone: "attention" });
    if (anomalyCount) insights.push({ key: "anomaly", title: `${count("anomaly")} 张工单有规则关注项`, detail: `共 ${anomalyCount} 项，按已配置的计划节点或净作业工时规则触发。请查看原因后判断，不自动认定生产异常。`, action: "查看原因", tone: "attention" });
    if (count("closing")) insights.push({ key: "closing", title: `${count("closing")} 张工单可以优先确认收尾`, detail: "完整工序均已报到计划的 90% 以上，且没有待核对记录。核实剩余生产和工序关闭状态，达到计划不等于已交付。", action: "查看收尾", tone: "positive" });
    if (rankedGaps.length) insights.push({ key: rankedGaps[0].key, title: `${rankedGaps[0].name}的前后报工差值得看看`, detail: `${rankedGaps[0].ids.size} 张工单出现较明显差距。先确认报工同步和实际流转，不能仅凭数量差认定瓶颈。`, action: "查看衔接", tone: "neutral" });
    if (count("unknown")) insights.push({ key: "unknown", title: `${count("unknown")} 张工单暂不能判断整体进展`, detail: "当前未取得可确认的完整工序，不等于需要人工补资料。进入工单可查看是同步失败还是查询未返回工序；不以少数已报工序推算整单进度。", action: "查看原因", tone: "neutral" });
    return { groups, rankedGaps: rankedGaps.slice(0, 3), insights: insights.slice(0, 3), reviewCount, quantityPendingCount, anomalyCount, total: orders.length, count };
  }

  function analyticsModule() {
    const data = analyticsData(state.orders);
    const headline = data.reviewCount ? `先核对 ${data.reviewCount} 笔报工，再看生产推进`
      : data.quantityPendingCount ? `${data.quantityPendingCount} 笔任务待核量，尚未计入产量`
      : data.anomalyCount ? `${data.count("anomaly")} 张工单有规则关注项，建议先核实`
      : data.count("closing") ? `${data.count("closing")} 张工单已接近收尾，可优先确认`
      : data.count("unknown") > data.total / 2 ? `${data.count("unknown")} 张工单工序信息暂不可判定，暂不推断进度`
      : data.count("closed") === data.total ? `${data.count("closed")} 张工单的全部工序已完成`
      : `${data.count("moving")} 张工单已有报工推进，${data.count("unreported")} 张暂无报工`;
    const drill = (key, label, className = "") => `<button class="${className}" data-action="analytics-drill" data-focus="${escapeHtml(key)}">${escapeHtml(label)} <span aria-hidden="true">↗</span></button>`;
    const stages = ["closed", "closing", "moving", "unreported", "unknown"];
    const staleOrders = state.orders.filter((order) => order.processSync?.status === "stale");
    const staleTimes = staleOrders.map((order) => order.processSync.updatedAt).filter(Boolean).sort();
    const snapshotNote = staleOrders.length ? `${staleOrders.length} 张沿用上次成功的工序数据，最早更新于 ${syncTime(staleTimes[0])}；相关结论仅供参考。` : "";
    return `<main class="secondary-module insights-module"><header><div><p>经营分析</p><h1>生产要点</h1><span>先看结论，需要时再进入工单</span></div><button class="secondary-button" data-action="export">导出分析摘要</button></header>
      ${state.syncWarning ? `<div class="sync-warning" role="status">${escapeHtml(state.syncWarning)} · 以下结论可能滞后</div>` : ""}
      ${!data.total ? `<section class="insight-empty"><h2>暂时没有足够数据形成结论</h2><p>接入工单后，这里会提炼生产进展和关注事项，不再逐条罗列数据。</p><button class="primary-small" data-action="refresh">刷新数据</button></section>` : `
      <section class="insight-brief"><div><span class="insight-eyebrow">当前判断</span><h2>${headline}</h2><p>基于当前已载入的 ${data.total} 张工单快照，不代表全厂或今日产量。${data.count("unknown") ? `其中 ${data.count("unknown")} 张尚未取得可确认的完整工序。` : "生产时长、正常暂停不直接作为异常依据。"}${escapeHtml(snapshotNote)}</p></div></section>
      <div class="insights-layout"><section class="insights-panel"><div class="insights-heading"><h2>建议先看</h2><span>最多 3 项，按处理优先级</span></div>${data.insights.length ? data.insights.map((insight, index) => `<article class="insight-item ${insight.tone}"><span class="insight-index">0${index + 1}</span><div><h3>${escapeHtml(insight.title)}</h3><p>${escapeHtml(insight.detail)}</p>${drill(insight.key, insight.action, "insight-link")}</div></article>`).join("") : `<div class="insight-empty"><h3>当前没有明确的优先处理项</h3><p>没有待核对或已触发的规则关注项，不代表没有风险；交期、暂停和实际交接信息仍需现场确认。</p></div>`}</section>
      <section class="insights-panel"><div class="insights-heading"><h2>生产处在哪个阶段</h2><span>按完整工序判断 · 工单数</span></div><div class="stage-distribution">${stages.map((key) => `<div class="stage-line"><div>${drill(key, data.groups.get(key).label)}<strong>${key !== "unknown" && data.count("unknown") === data.total ? '—<small> 暂不可判定</small>' : `${data.count(key)}<small> / ${data.total}</small>`}</strong></div><div class="stage-track" aria-hidden="true"><i class="stage-${key}" style="width:${data.count(key) / data.total * 100}%"></i></div></div>`).join("")}</div><p class="insight-note">${data.count("unknown") ? "未取得完整工序的工单不计入其他阶段；数字仅表示当前可确认的数量。" : ""}“接近收尾”要求每道工序均达到计划的 90%，不是只看最后一道；“暂无报工”不等于未开工或停工。</p></section></div>
      <section class="insights-panel gap-panel"><div class="insights-heading"><h2>前后工序报工差</h2><span>最多 3 类 · 先核实，不直接判瓶颈</span></div>${data.rankedGaps.length ? `<div class="gap-observations">${data.rankedGaps.map((gap) => `<article><h3>${escapeHtml(gap.name)}</h3><p><strong>${gap.ids.size}</strong> 张工单 · 前一道报工较多</p><span>计划范围内合计差 ${gap.difference} 件次</span>${drill(gap.key, "查看涉及工单", "insight-link")}</article>`).join("")}</div>` : `<p class="insight-note">当前可比工序中未发现达到观察门槛的报工差，或资料不足以比较。</p>`}<p class="insight-note">仅比较同计划量、顺序相邻且非同序号并行的工序；差值达到计划的 20% 且不少于 20 件才展示。工艺顺序不等于实际交接，差值不是在制库存，各工序差值不能相加当成品产量。</p></section>`}
      <details class="analytics-method"><summary>这些结论能说明什么，不能说明什么</summary><p>只使用当前载入的工单及工序累计数据，所有报工汇总仅计已确认记录。没有连续历史快照、可靠净工时与交期信息时，不推断日产趋势、效率排名或延期风险。正常长周期与中途停几天不直接判异常。明细仍在报工管理中，点击结论即可进入对应范围。</p></details></main>`;
  }

  function openModule(moduleKey) {
    const module = modules.find((item) => item.key === moduleKey);
    if (!module) return;
    if (!state.openTabs.some((tab) => tab.key === module.key)) {
      state.openTabs.push({ key: module.key, title: module.title, closable: !["home", "report"].includes(module.key) });
    }
    state.activeModule = module.key;
    state.drawerRecordId = null;
    render();
  }

  function closeModule(moduleKey) {
    const index = state.openTabs.findIndex((tab) => tab.key === moduleKey);
    if (index < 0 || !state.openTabs[index].closable) return;
    state.openTabs.splice(index, 1);
    if (state.activeModule === moduleKey) {
      state.activeModule = state.openTabs[Math.max(0, index - 1)]?.key || "report";
    }
    render();
  }

  // Embedded scene returns through the existing workspace, preserving its login and selection.
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== "return-to-reporting" || state.activeModule !== "production") return;
    const frame = document.querySelector("#production-3d-frame");
    if (!frame || event.source !== frame.contentWindow) return;
    openModule("report");
  });

  const scrollMemory = new Map();
  let agentChat = null;
  let productionInsights = null;
  let weeklyEntryReportId = new URLSearchParams(window.location.search).get("reportId") || "";
  let renderedView = null;
  let composing = false;
  function scrollKey(selector, view) {
    if (selector === ".order-list") return `list:${view.search}:${view.filter}`;
    return `${view.module}:${view.orderId}:${selector}`;
  }
  const scrollSelectors = [".order-list", ".detail-scroll", ".process-table", ".people-table", ".records-table", ".secondary-module", ".record-drawer"];
  function render() {
    if (composing) return;
    if(state.activeModule==='people'&&state.peopleTab==='members'&&document.querySelector('#local-member-manager')?.dataset.mounted==='true')return;
    if (state.activeModule === "task-recovery" && document.querySelector("#task-recovery")?.dataset?.mounted === "true") return;
    if (state.activeModule === "management" && document.querySelector("#management")?.dataset?.mounted === "true") return;
    // This independently refreshed view owns its camera; keep it mounted during background ledger refreshes.
    if (state.activeModule === "production" && document.querySelector("#production-3d-frame")?.tagName === "IFRAME") return;
    // The conversation owns its input and stream; ledger refreshes must not replace it.
    if (state.activeModule === "home" && renderedView?.module === "home" && document.querySelector("#agent-home")?.dataset?.mounted === "true") return;
    // Weekly edits and findings own their state; background ledger refreshes must preserve them.
    if (state.activeModule === "weekly" && renderedView?.module === "weekly" && document.querySelector("#weekly-report")?.dataset?.mounted === "true") return;
    if (state.activeModule === "dispatch-predictions" && renderedView?.module === "dispatch-predictions" && document.querySelector("#dispatch-feedback")?.dataset?.mounted === "true") return;
    if (renderedView) for (const selector of scrollSelectors) {
      const node = document.querySelector(selector);
      if (node) scrollMemory.set(scrollKey(selector, renderedView), [node.scrollTop, node.scrollLeft]);
    }
    while (scrollMemory.size > 500) scrollMemory.delete(scrollMemory.keys().next().value);
    const active = document.activeElement;
    const focus = active?.id && active.tagName === "INPUT" ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : active?.dataset?.findingField ? { findingField: active.dataset.findingField, key: active.dataset.key, start: active.selectionStart, end: active.selectionEnd } : null;
    const order = selectedOrder();
    if (state.activeModule !== "report") {
      app.innerHTML = systemShell(secondaryModule(state.activeModule));
    } else {
      state.selectedId = order?.id || null;
      app.innerHTML = systemShell(`${state.syncWarning ? `<div class="sync-warning" role="status">${escapeHtml(state.syncWarning)}</div>` : ""}${reportingWorkspace(order)}`, recordDrawer(order));
    }
    renderedView = { module: state.activeModule, orderId: order?.id, search: state.search, filter: state.filter };
    window.BlacklakeLocalMembers?.mount(state.activeModule==='people'&&state.peopleTab==='members'?document.querySelector('#local-member-manager'):null,{api,onChanged:()=>loadOperators()});
    window.BlacklakeManagement?.mount(state.activeModule === "management" ? document.querySelector("#management") : null,{api,onRecover:id=>{window.blacklakeRecoveryEntry=id;openModule('task-recovery');}});
    window.BlacklakeDataSync?.mount(state.activeModule==='data-sync'?document.querySelector('#data-sync'):null,{api});
    window.BlacklakeTaskRecovery?.mount(state.activeModule === "task-recovery" ? document.querySelector("#task-recovery") : null, { api, demo: state.demo, notify: showToast, assignmentId:window.blacklakeRecoveryEntry||'', onReview: async (id) => {
      await loadAssignments({ preserveSelection: true });
      const order = state.orders.find((item) => item.records.some((record) => record.id === id));
      if (!order) return showToast("暂未在当前报工范围找到任务，请刷新报工管理后核对。");
      openModule("report"); state.selectedId = order.id; state.drawerRecordId = id; render();
    } });
    window.BlacklakeDispatchFeedback?.mount(state.activeModule === "dispatch-predictions" ? document.querySelector("#dispatch-feedback") : null, { api, demo: state.demo });
    if (state.activeModule === "home" && window.BlacklakeAgent) {
      agentChat ||= window.BlacklakeAgent.create({ onUnauthorized: redirectToDingTalk });
      agentChat.mount(document.querySelector("#agent-home"), { demo: state.demo });
    }
    if (window.BlacklakeInsights) {
      productionInsights ||= window.BlacklakeInsights.create({ onUnauthorized: redirectToDingTalk });
      void productionInsights.mount(state.activeModule === "weekly" ? document.querySelector("#weekly-report") : null, { demo: state.demo, reportId: weeklyEntryReportId });
      if (state.activeModule === "weekly") weeklyEntryReportId = "";
      const record = state.activeModule === "report" ? order?.records.find((item) => item.id === state.drawerRecordId) : null;
      const context = record?.source === "现场报工" ? { assignmentId: record.id }
        : record?.taskId && order?.code ? { taskId: record.taskId, projectCode: order.code } : null;
      productionInsights.mountInspector(context ? document.querySelector("#record-insights") : null, context, { demo: state.demo });
    }
    for (const selector of scrollSelectors) {
      const node = document.querySelector(selector);
      const position = scrollMemory.get(scrollKey(selector, renderedView));
      if (node && position) { node.scrollTop = position[0]; node.scrollLeft = position[1]; }
    }
    if (focus) {
      const input = focus.id ? document.querySelector(`#${focus.id}`) : Array.from(document.querySelectorAll("[data-finding-field]")).find((node) => node.dataset.findingField === focus.findingField && node.dataset.key === focus.key);
      input?.focus({ preventScroll: true });
      if (typeof focus.start === "number") input?.setSelectionRange?.(focus.start, focus.end);
    }
  }

  function workOrderIdentity(item) {
    const projectId = Number(item?.projectId);
    if (Number.isSafeInteger(projectId) && projectId > 0) return `project:${projectId}`;
    const projectCode = String(item?.projectCode || "").trim();
    if (projectCode) return `code:${projectCode}`;
    const taskId = Number(item?.taskId);
    return Number.isSafeInteger(taskId) && taskId > 0 ? `task:${taskId}` : `record:${String(item?.id || "unknown")}`;
  }

  function liveOrders(assignments, workOrders = []) {
    const catalogs = new Map(workOrders.map((order) => [workOrderIdentity(order), order]));
    const groups = new Map();
    assignments.forEach((item) => {
      const key = workOrderIdentity(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return [...groups.entries()].map(([identity, items], orderIndex) => {
      const catalog = catalogs.get(identity);
      const code = String(items[0]?.projectCode || catalog?.projectCode || "").trim() || `任务-${items[0]?.taskId || "未知"}`;
      const anomalyMap = new Map();
      items.forEach((item) => (item.productionAnomalies || []).forEach((anomaly) => {
        const scopeKey = anomaly.scope === "PROCESS" ? item.processName : item.id;
        anomalyMap.set(`${anomaly.code}:${scopeKey}`, { ...anomaly, recordId: item.id, taskId: item.taskId, process: item.processName, worker: item.operatorName });
      }));
      const anomalies = [...anomalyMap.values()];
      const localProcessGroups = new Map();
      items.forEach((item) => {
        const key = item.taskId ? `task:${item.taskId}` : `name:${item.processName}`;
        if (!localProcessGroups.has(key)) localProcessGroups.set(key, []);
        localProcessGroups.get(key).push(item);
      });
      const catalogProcesses = catalog?.processes || [];
      const processSync = catalog?.processSync || { status: catalogProcesses.length ? "fresh" : "unavailable", updatedAt: null };
      const catalogTaskIds = new Set(catalogProcesses.map((process) => Number(process.taskId)));
      const toProcess = (source, processItems, index) => {
        const taskId = Number(source.taskId ?? processItems[0]?.taskId) || null;
        const name = source.processName || processItems[0]?.processName || "未命名工序";
        const processAnomalies = anomalies.filter((item) => taskId ? Number(item.taskId) === taskId : item.process === name);
        const localCompleted = processItems.filter((item) => item.status === "COMPLETED")
          .reduce((sum, item) => sum + (Number(item.goodQuantity ?? item.quantity) || 0), 0);
        const processPlanned = Number(source.plannedAmount) || Math.max(...processItems.map((item) => Number(item.targetQuantity ?? item.quantity) || 0), 0);
        const reported = Math.max(Number(source.reportedAmount) || 0, localCompleted);
        const blacklakeCompleted = Number(source.processStatus) === 20 ||
          /^(已完成|完成|已完工|完工|已结束|已关闭)$/.test(String(source.processStatusDisplay || "").trim());
        const processStatus = processAnomalies.length ? "EXCEPTION"
          : processItems.some((item) => item.status === "NEEDS_REVIEW") ? "NEEDS_REVIEW"
          : processItems.some(isQuantityPending) ? "QUANTITY_PENDING"
          : processItems.some((item) => ["IN_PROGRESS", "REPORTING"].includes(item.status)) ? "IN_PROGRESS"
          : blacklakeCompleted ? "COMPLETED"
          : reported > 0 ? "IN_PROGRESS"
          : "NOT_STARTED";
        return {
          id: taskId ? `task-${taskId}` : `live-p-${orderIndex}-${index}`,
          taskId,
          seq: source.sequence != null && source.sequence !== "" && Number.isFinite(Number(source.sequence)) ? Number(source.sequence) : (index + 1) * 10,
          sequenceKnown: source.sequence != null && source.sequence !== "" && Number.isFinite(Number(source.sequence)),
          planKnown: Number(source.plannedAmount) > 0,
          name,
          processCode: String(source.processCode || processItems[0]?.processCode || ""),
          station: source.stationName || processItems[0]?.stationName || "—",
          planned: processPlanned,
          reported,
          status: processStatus,
          workers: new Set(processItems.map((item) => item.operatorName).filter(Boolean)).size,
          anomalies: processAnomalies
        };
      };
      const processes = catalogProcesses.map((process, index) => {
        const processItems = localProcessGroups.get(`task:${process.taskId}`) || [];
        return toProcess(process, processItems, index);
      });
      for (const processItems of localProcessGroups.values()) {
        const taskId = Number(processItems[0]?.taskId);
        if (taskId && catalogTaskIds.has(taskId)) continue;
        processes.push(toProcess({}, processItems, processes.length));
      }
      processes.sort((left, right) => left.seq - right.seq || (left.taskId || 0) - (right.taskId || 0));
      const planned = Math.max(...processes.map((process) => process.planned), 0);
      const completed = processes.at(-1)?.reported || 0;
      const status = anomalies.length ? "EXCEPTION"
        : items.some((item) => item.status === "NEEDS_REVIEW") ? "NEEDS_REVIEW"
        : items.some(isQuantityPending) ? "QUANTITY_PENDING"
        : processes.length && processes.every((process) => process.status === "COMPLETED") ? "COMPLETED"
        : "IN_PROGRESS";
      const itemDuration = (item) => {
        const seconds = item.effectiveDurationSeconds ?? item.durationSeconds;
        if (seconds == null) return ["IN_PROGRESS", "REPORTING"].includes(item.status) ? "计时中" : "未记录";
        return ["IN_PROGRESS", "REPORTING"].includes(item.status) ? `已进行 ${formatDuration(seconds)}` : formatDuration(seconds);
      };
      return {
        id: `live-${encodeURIComponent(identity)}`, projectId: Number(catalog?.projectId ?? items[0].projectId) || null, code, name: `${items[0].productName || "生产"}工单`, product: items[0].productName || "未命名产品", dueDate: catalog?.dueDate || "", status,
        planned, completed, processSync, routeComplete: ["fresh", "stale"].includes(processSync.status) && catalogProcesses.length > 0 && processes.length === catalogProcesses.length, updatedAt: items[0].endedAt || items[0].startedAt || "刚刚", owner: "现场班组",
        exception: anomalies[0]?.title || (status === "NEEDS_REVIEW" ? "有待核对记录" : status === "QUANTITY_PENDING" ? "有待核量任务" : ""), processes, anomalies,
        workers: items.map((item) => ({ taskId: Number(item.taskId) || null, name: item.operatorName || "工人", process: item.processName, quantityPending: isQuantityPending(item), quantityPolicy: item.quantityPolicy, amount: hasUnconfirmedQuantity(item) ? null : item.status === "CANCELLED" ? 0 : Number(item.quantity) || 0, duration: itemDuration(item), status: isQuantityPending(item) ? "QUANTITY_PENDING" : item.productionStatus || item.status, anomalies: item.productionAnomalies || [] })),
        records: items.map((item) => ({ id: item.id, quantityPending: isQuantityPending(item), quantityPolicy: item.quantityPolicy, goodQuantity: hasUnconfirmedQuantity(item) ? null : item.goodQuantity ?? item.quantity, defectQuantity: hasUnconfirmedQuantity(item) ? null : item.defectQuantity || 0, defectReasonName: item.defectReasonName || "", assignmentStatus: item.status, taskId: Number(item.taskId) || null, time: item.endedAt || item.startedAt || "—", worker: item.operatorName || "工人", process: item.processName, amount: hasUnconfirmedQuantity(item) ? null : item.status === "CANCELLED" ? 0 : Number(item.quantity) || 0, duration: itemDuration(item), source: item.source || "现场报工", status: isQuantityPending(item) ? "QUANTITY_PENDING" : item.productionStatus || item.status, anomalies: item.productionAnomalies || [], note: isQuantityPending(item) ? "数量待核对，结束只记工时，暂未报送黑湖" : hasUnconfirmedQuantity(item) ? "数量规则待确认，结束时只记工时，暂不报送黑湖" : item.cancellationReason || item.productionAnomalies?.[0]?.message || (item.status === "NEEDS_REVIEW" ? "黑湖结果需要人工确认" : "已同步") }))
      };
    });
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    if (seconds < 60) return `${Math.floor(seconds)} 秒`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${hours ? `${hours} 小时 ` : ""}${minutes} 分钟`;
  }

  function csvText(rows) {
    return "\ufeff" + rows.map((row) => row.map((value) => {
      let text = String(value ?? "");
      // Do not allow imported names or notes to become spreadsheet formulas.
      if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
      return `"${text.replaceAll('"', '""')}"`;
    }).join(",")).join("\r\n");
  }

  function exportOrder(scope) {
    if (state.activeModule === "analytics") {
      const data = analyticsData(state.orders);
      const rows = [["类型", "项目", "结论或数量", "说明"],
        ["范围", "已载入工单", data.total, "当前快照，不代表全厂或今日产量"],
        ...["closed", "closing", "moving", "unreported", "unknown"].map((key) => ["生产分布", data.groups.get(key).label, data.count(key), "单位：工单"]),
        ...data.insights.map((item) => ["建议先看", item.title, "", item.detail]),
        ...data.rankedGaps.map((item) => ["前后报工差", item.name, `${item.ids.size} 张工单 / ${item.difference} 件次`, "仅为数量差观察，不代表在制库存或已确认瓶颈"]),
        ["数据状态", state.syncWarning ? "同步待恢复" : "当前已载入数据", "", state.syncWarning || "没有可靠历史、交期或净工时，不推断趋势、延期和效率排名"]];
      return downloadCsv(rows, "生产分析摘要");
    }
    const order = selectedOrder();
    if (!order) return showToast("请先选择工单");
    const keyword = state.detailSearch.trim().toLocaleLowerCase("zh-CN");
    let rows, label;
    if (scope === "processes") {
      label = "全部工序";
      rows = [["工单", "产品", "序号", "工序", "工位", "计划", "已报良品", "剩余", "本系统参与人数", "状态"], ...order.processes.map((item) => [order.code, order.product, item.seq, item.name, item.station, item.planned, item.reported, Math.max(0, item.planned - item.reported), item.workers, statusMeta[item.status]?.label || item.status])];
    } else if (state.detailTab === "workers") {
      label = "参与明细";
      rows = [["工单", "工人", "工序", "数量", "生产历时", "状态"], ...order.workers.filter((item) => !keyword || `${item.name} ${item.process}`.toLocaleLowerCase("zh-CN").includes(keyword)).map((item) => [order.code, item.name, item.process, hasUnconfirmedQuantity(item) ? "待核量" : item.amount, item.duration, statusMeta[item.status]?.label || item.status])];
    } else {
      label = "报工记录";
      rows = [["工单", "记录ID", "时间", "工人", "工序", "数量", "良品", "不良品", "不良原因", "生产历时", "来源", "结果", "备注"], ...order.records.filter((item) => !keyword || `${item.worker} ${item.process} ${item.source} ${item.note}`.toLocaleLowerCase("zh-CN").includes(keyword)).map((item) => [order.code, item.id, item.time, item.worker, item.process, hasUnconfirmedQuantity(item) ? "待核量" : item.amount, hasUnconfirmedQuantity(item) ? "待核量" : item.goodQuantity ?? item.amount, hasUnconfirmedQuantity(item) ? "待核量" : item.defectQuantity ?? 0, item.defectReasonName || "", item.duration, item.source, statusMeta[item.assignmentStatus || item.status]?.label || item.status, item.note])];
    }
    downloadCsv(rows, `${order.code}-${label}`);
  }

  function downloadCsv(rows, label) {
    const url = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${label}.csv`.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出${label} ${rows.length - 1} 行`);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    let data = {};
    if (response.status !== 204) {
      try { data = await response.json(); } catch { data = {}; }
    }
    if (!response.ok) {
      if (response.status === 401 && !state.demo) redirectToDingTalk();
      const error = new Error(data.error?.message || data.error || (response.status === 401 ? "钉钉登录已失效" : "操作失败"));
      error.status = response.status;
      error.code = data.error?.code || "";
      throw error;
    }
    return data;
  }

  let assignmentRequest = 0;
  let assignmentPayload = '';
  async function loadAssignments({ preserveSelection = false } = {}) {
    const requestId = ++assignmentRequest;
    let result;
    try { result = await api("/v1/admin/assignments"); }
    catch (error) {
      if (requestId === assignmentRequest) {
        state.syncWarning = "刷新失败，当前保留上次成功的数据。请检查连接后重试。";
        render();
      }
      throw error;
    }
    if (requestId !== assignmentRequest) return;
    const payload = JSON.stringify(result);
    if (preserveSelection && payload === assignmentPayload && state.syncWarning === (result.syncWarning || '')) return;
    assignmentPayload = payload;
    const previousId = state.selectedId;
    state.syncWarning = result.syncWarning || "";
    state.orders = liveOrders(result.assignments || [], result.workOrders || []);
    syncEmbroideryMachines(result.assignments || []);
    state.anomalyRules = { ...state.anomalyRules, ...(result.anomalyRules || {}) };
    state.anomalySummary = { ...state.anomalySummary, ...(result.anomalySummary || {}) };
    state.selectedId = preserveSelection && state.orders.some((order) => order.id === previousId) ? previousId : state.orders[0]?.id || null;
    render();
  }

  async function loadOperators() {
    state.operatorsLoaded = false;
    state.operatorsError = "";
    render();
    try {
      const result = await api("/v1/admin/operators");
      state.operators = result.operators || [];
      state.unitRecommendations = result.unitRecommendations || [];
      if (state.selectedStationId === "A-01" && state.unitRecommendations.length) {
        state.selectedStationId = state.unitRecommendations[0].unitId;
      }
      state.stationDraftOperatorIds = recommendedOperatorIds(state.selectedStationId);
    } catch (error) {
      state.operatorsError = "人员刷新失败，保留上次结果。请点击刷新重试。";
      throw error;
    } finally {
      state.operatorsLoaded = true;
      render();
    }
  }

  let auditRequest = 0;
  function auditDateBoundary(value, nextDay = false) {
    if (!value) return "";
    const date = new Date(`${value}T00:00:00`);
    if (nextDay) date.setDate(date.getDate() + 1);
    return date.toISOString();
  }

  async function loadAudit({ offset = state.auditOffset } = {}) {
    if (state.demo) {
      state.auditLoaded = true;
      state.auditOffset = 0;
      render();
      return;
    }
    const requestId = ++auditRequest;
    state.auditLoading = true;
    state.auditError = "";
    render();
    const params = new URLSearchParams({ limit: String(state.auditLimit), offset: String(Math.max(0, offset)) });
    if (state.auditQuery.trim()) params.set("q", state.auditQuery.trim());
    if (state.auditEventType !== "ALL") params.set("eventType", state.auditEventType);
    if (state.auditErrorCode !== "ALL") params.set("errorCode", state.auditErrorCode);
    if (state.auditActor !== "ALL") params.set("actor", state.auditActor);
    if (state.auditFrom) params.set("from", auditDateBoundary(state.auditFrom));
    if (state.auditTo) params.set("to", auditDateBoundary(state.auditTo, true));
    try {
      const result = await api(`/v1/admin/audit?${params}`);
      if (requestId !== auditRequest) return;
      state.auditEvents = result.events || [];
      state.auditTotal = Number(result.total || 0);
      state.auditOffset = Number(result.offset || 0);
      state.auditFacets = { errorCodes: result.facets?.errorCodes || [], actors: result.facets?.actors || [] };
      state.auditLoaded = true;
    } catch (error) {
      if (requestId === auditRequest) state.auditError = error.message || "审计日志读取失败";
      throw error;
    } finally {
      if (requestId === auditRequest) {
        state.auditLoading = false;
        render();
      }
    }
  }

  async function createBindingCode(blacklakeOperatorId) {
    if (state.demo) throw new Error("演示模式不能生成真实绑定码");
    const result = await api("/v1/admin/binding-codes", {
      method: "POST",
      body: JSON.stringify({ blacklakeOperatorId: Number(blacklakeOperatorId) })
    });
    confirmDialog.innerHTML = `<div class="dialog binding-code-box"><span>给工人输入</span><h2>${escapeHtml(result.name)}</h2><strong>${escapeHtml(result.confirmationCode)}</strong><p>10 分钟内有效，只能使用一次。请确认工人手机上选择的是这个姓名。</p><button class="primary" data-action="close-binding-code">已记下</button></div>`;
    confirmDialog.classList.remove("hidden");
    confirmDialog.setAttribute("aria-hidden", "false");
  }

  async function unbindOperator(blacklakeOperatorId, name) {
    if (state.demo) throw new Error("演示模式不能解除真实绑定");
    if (!window.confirm(`确认解除“${name}”的微信绑定？解除后旧微信会退出登录。`)) return;
    await api(`/v1/admin/bindings/${encodeURIComponent(blacklakeOperatorId)}`, { method: "DELETE" });
    await loadOperators();
    showToast("微信绑定已解除");
  }

  async function updateReportingPermission(blacklakeOperatorId, allowSwitch) {
    const operatorId = Number(blacklakeOperatorId);
    if(state.workerTypeSavingId===operatorId)throw new Error('请等待当前人员归属设置完成。');
    state.workerTypeSavingId=operatorId;renderPeopleSearchResults();
    try {
    if (state.demo) {
      const operator = state.operators.find((item) => Number(item.blacklakeOperatorId) === operatorId);
      if (!operator) throw new Error("没有找到这个黑湖人员 ID");
      operator.canSwitchReportingMode = Boolean(allowSwitch);
      operator.permissionSource = "manual";
      renderPeopleSearchResults();
      showToast(`已${allowSwitch ? "允许" : "禁止"}${operator.name}切换报工模式（演示）`);
      return;
    }
    const result = await api(`/v1/admin/operators/${encodeURIComponent(operatorId)}/reporting-permission`, {
      method: "PATCH",
      body: JSON.stringify({ allowSwitch: Boolean(allowSwitch) })
    });
    const index = state.operators.findIndex((item) => Number(item.blacklakeOperatorId) === operatorId);
    if (index >= 0) state.operators[index] = result.operator;
    renderPeopleSearchResults();
    showToast(`已${allowSwitch ? "允许" : "禁止"}${result.operator.name}切换报工模式`);
    }finally{state.workerTypeSavingId=null;renderPeopleSearchResults();}
  }

  async function updateQualityRole(blacklakeOperatorId,qualityRole) {
    const id=Number(blacklakeOperatorId),current=state.operators.find(person=>Number(person.blacklakeOperatorId)===id);
    if(!current||state.workerTypeSavingId===id)return;
    state.workerTypeSavingId=id;renderPeopleSearchResults();
    try{
      if(state.demo){Object.assign(current,{qualityRole,qualityRevision:(current.qualityRevision||0)+1});return;}
      const result=await api('/v1/admin/operators/'+id+'/quality-profile',{method:'PATCH',body:JSON.stringify({qualityRole,expectedRevision:current.qualityRevision||0})});
      if(result?.operator?.blacklakeOperatorId!==id||result.operator.qualityRole!==qualityRole||!Number.isSafeInteger(result.operator.qualityRevision))throw new Error('身份保存回执未确认，请刷新人员核对。');
      const index=state.operators.findIndex(person=>Number(person.blacklakeOperatorId)===id);if(index>=0)state.operators[index]=result.operator;
      showToast('已将'+current.name+'设置为'+(qualityRole==='quality_leader'?'质检组长':qualityRole==='quality'?'质检人员':'普通人员'));
    }catch(error){if(!error.status||error.status>=500||error.status===409){try{await loadOperators();}catch{}}throw error;}
    finally{state.workerTypeSavingId=null;renderPeopleSearchResults();}
  }

  async function updateSelfService(blacklakeOperatorId,enabled) {
    const id=Number(blacklakeOperatorId),current=state.operators.find(person=>Number(person.blacklakeOperatorId)===id);
    if(!current||state.workerTypeSavingId===id)return;
    state.workerTypeSavingId=id;renderPeopleSearchResults();
    try{
      if(state.demo){Object.assign(current,{selfServiceEnabled:enabled,selfServiceRevision:(current.selfServiceRevision||0)+1});return;}
      const result=await api(`/v1/admin/operators/${id}/self-service`,{method:'PATCH',body:JSON.stringify({enabled,expectedRevision:current.selfServiceRevision||0})});
      if(result?.operator?.blacklakeOperatorId!==id||result.operator.selfServiceEnabled!==enabled||!Number.isSafeInteger(result.operator.selfServiceRevision))throw new Error('权限保存回执未确认，请刷新人员核对。');
      const index=state.operators.findIndex(person=>Number(person.blacklakeOperatorId)===id);if(index>=0)state.operators[index]=result.operator;
      showToast(`已将${current.name}设置为${enabled?'可自主报工':'仅接派工'}`);
    }catch(error){if(!error.status||error.status>=500||error.status===409){try{await loadOperators();}catch{}}throw error;}
    finally{state.workerTypeSavingId=null;renderPeopleSearchResults();}
  }

  async function updateWorkerType(blacklakeOperatorId, workerType) {
    const id=Number(blacklakeOperatorId),current=state.operators.find(person=>Number(person.blacklakeOperatorId)===id);
    if(!current||state.workerTypeSavingId===id)return;
    state.workerTypeSavingId=id;renderPeopleSearchResults();
    try {
      if(state.demo){Object.assign(current,{workerType,workerTypeRevision:(current.workerTypeRevision||0)+1,canReceiveFloor8Assignments:workerType==='floor8'||workerType==='auto'&&!/绣花|刺绣/.test(current.description||''),defaultReportingMode:workerType==='embroidery'?'embroidery':workerType==='floor8'?'standard':/绣花|刺绣/.test(current.description||'')?'embroidery':'standard'});if(workerType==='floor8')current.workUnitId='';return;}
      const result=await api(`/v1/admin/operators/${id}/worker-type`,{method:'PATCH',body:JSON.stringify({workerType,expectedRevision:current.workerTypeRevision||0})});
      if(result?.operator?.blacklakeOperatorId!==id||result.operator.workerType!==workerType||!Number.isSafeInteger(result.operator.workerTypeRevision)||typeof result.operator.canReceiveFloor8Assignments!=='boolean')throw new Error('设置回执未确认，请刷新人员核对。');
      const index=state.operators.findIndex(person=>Number(person.blacklakeOperatorId)===id);if(index>=0)state.operators[index]=result.operator;
      showToast(`已将${current.name}设置为${workerType==='floor8'?'8楼员工':workerType==='embroidery'?'绣花员工':'自动归属'}`);
    }catch(error){if(!error.status||error.status>=500||error.status===409){try{await loadOperators();}catch{}}throw error;}
    finally{state.workerTypeSavingId=null;renderPeopleSearchResults();}
  }

  async function updateEntryProfile(blacklakeOperatorId, values) {
    const operatorId = Number(blacklakeOperatorId);
    if(state.workerTypeSavingId===operatorId)throw new Error('请等待当前人员归属设置完成。');
    state.workerTypeSavingId=operatorId;renderPeopleSearchResults();
    try {
    const current = state.operators.find((item) => Number(item.blacklakeOperatorId) === operatorId);
    if (!current) throw new Error("没有找到这个黑湖人员 ID");
    const body = {
      appRole: values.appRole ?? current.appRole ?? "employee",
      workUnitId: values.workUnitId ?? current.workUnitId ?? ""
    };
    if (state.demo) {
      Object.assign(current, body, {
        floor: body.appRole === "floor8_leader" ? 8 : body.appRole === "floor3_supervisor" ? 3 : null,
        entryView: body.appRole === "floor8_leader" ? "leader-assignment" : body.appRole === "floor3_supervisor" ? "floor3-supervisor" : "employee-reporting"
      });
      renderPeopleSearchResults();
      showToast(`已更新${current.name}的小程序身份（演示）`);
      return;
    }
    const result = await api(`/v1/admin/operators/${encodeURIComponent(operatorId)}/entry-profile`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    const index = state.operators.findIndex((item) => Number(item.blacklakeOperatorId) === operatorId);
    if (index >= 0) state.operators[index] = result.operator;
    renderPeopleSearchResults();
    showToast(`已更新${result.operator.name}的小程序身份`);
    }finally{state.workerTypeSavingId=null;renderPeopleSearchResults();}
  }

  async function updateUnitRecommendation(unitId, blacklakeOperatorIds) {
    const operatorIds = [...new Set((blacklakeOperatorIds || []).map(Number))].filter((id) => id > 0);
    if (state.demo) {
      state.unitRecommendations = state.unitRecommendations.filter((item) => item.unitId !== unitId);
      state.unitRecommendations.push(...operatorIds.map((blacklakeOperatorId) => ({ unitId, blacklakeOperatorId })));
      state.stationDraftOperatorIds = [...operatorIds];
      renderPeopleSearchResults();
      showToast(`${unitId} 已安排 ${operatorIds.length} 人（演示）`);
      return;
    }
    const result = await api(`/v1/admin/dispatch-units/${encodeURIComponent(unitId)}/recommended-operator`, {
      method: "PATCH",
      body: JSON.stringify({ blacklakeOperatorIds: operatorIds })
    });
    state.unitRecommendations = state.unitRecommendations.filter((item) => item.unitId !== unitId);
    state.unitRecommendations.push(...(result.recommendations || []));
    state.stationDraftOperatorIds = recommendedOperatorIds(unitId);
    renderPeopleSearchResults();
    showToast(`${unitId} 已安排 ${operatorIds.length} 人`);
  }

  function startAutoRefresh() {
    clearInterval(state.refreshTimer);
    if (state.demo) return;
    let refreshing = false;
    state.refreshTimer = setInterval(async () => {
      if (document.hidden || refreshing) return;
      const needsLedger = ['report', 'embroidery', 'people', 'analytics'].includes(state.activeModule)
        || state.activeModule === 'home' && !window.BlacklakeAgent;
      if (state.activeModule !== 'audit' && !needsLedger) return;
      refreshing = true;
      try {
        if (state.activeModule === "audit") await loadAudit();
        else await loadAssignments({ preserveSelection: true });
      } catch { /* Keep the last successful view. */ }
      finally { refreshing = false; }
    }, 60_000);
  }

  function useDemo() {
    state.demo = true;
    clearInterval(state.refreshTimer);
    state.orders = structuredClone(demoOrders);
    state.operators = [
      { blacklakeOperatorId: 4412231, name: "刘芮华", description: "未设置", appRole: "floor8_leader", floor: 8, workUnitId: "", defaultReportingMode: "standard", canSwitchReportingMode: true, permissionSource: "manual", bound: true },
      { blacklakeOperatorId: 51002, name: "绣花工人", description: "三楼绣花部", appRole: "employee", floor: null, workUnitId: "3F-01", defaultReportingMode: "embroidery", canSwitchReportingMode: true, permissionSource: "department", bound: true },
      { blacklakeOperatorId: 51003, name: "演示员工甲", description: "8楼生产部（演示）", appRole: "employee", floor: null, workUnitId: "", defaultReportingMode: "standard", canSwitchReportingMode: false, permissionSource: "default", bound: false },
      { blacklakeOperatorId: 51004, name: "演示员工乙", description: "8楼生产部（演示）", appRole: "employee", floor: null, workUnitId: "", defaultReportingMode: "standard", canSwitchReportingMode: false, permissionSource: "default", bound: false },
      { blacklakeOperatorId: 51005, name: "演示员工丙", description: "8楼生产部（演示）", appRole: "employee", floor: null, workUnitId: "", defaultReportingMode: "standard", canSwitchReportingMode: false, permissionSource: "default", bound: false }
    ];
    state.unitRecommendations = [{ unitId: "A-02", blacklakeOperatorId: 51003 }];
    state.selectedStationId = "A-02";
    state.stationDraftOperatorIds = [51003];
    state.operatorsLoaded = true;
    state.auditEvents = [
      { eventId: "action:demo-2", eventType: "ASSIGNMENT_CANCELLED", eventTime: "2026-09-14T02:09:10.000Z", operatorName: "刘芮华", blacklakeOperatorId: 4412231, projectCode: "WO-260914-001", productName: "演示产品", processName: "外协加工KL", taskId: 990201, machineId: "02", embroideryPart: "后幅", assignmentId: "demo-assignment", assignmentStatus: "CANCELLED", reportStatus: "FAILED", errorCode: "TASK_CLOSED", reason: "黑湖工序已结束，本地任务已自动退出", actor: "SYSTEM", amount: 1000 },
      { eventId: "report:demo-1", eventType: "REPORT_FAILED", eventTime: "2026-09-14T02:09:09.000Z", operatorName: "刘芮华", blacklakeOperatorId: 4412231, projectCode: "WO-260914-001", productName: "演示产品", processName: "外协加工KL", taskId: 990201, machineId: "02", embroideryPart: "后幅", assignmentId: "demo-assignment", assignmentStatus: "CANCELLED", reportStatus: "FAILED", errorCode: "TASK_CLOSED", reason: "黑湖未接受这次报工：工序状态已结束无法报工", actor: "AUTHENTICATED_OPERATOR", amount: 1000 }
    ];
    state.auditTotal = state.auditEvents.length;
    state.auditFacets = { errorCodes: ["TASK_CLOSED"], actors: ["AUTHENTICATED_OPERATOR", "SYSTEM"] };
    state.auditLoaded = true;
    state.orders.forEach((order) => { order.routeComplete = true; order.processes.forEach((process) => { process.sequenceKnown = true; process.planKnown = process.planned > 0; }); });
    state.anomalySummary = { total: 2, critical: 0, warning: 2, byCode: { PROCESS_STALLED: 1, OPERATOR_NOT_FINISHED: 1 } };
    state.selectedId = state.orders[0].id;
    authDialog.classList.add("hidden");
    render();
    showToast("已进入演示模式，所有操作仅在当前页面生效");
  }

  function returnCookie(value, maxAge) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `blacklake_admin_return=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  }

  function redirectToDingTalk() {
    if (state.redirectingToLogin) return;
    state.redirectingToLogin = true;
    showAuthDialog("需要登录钉钉", "当前尚未登录或会话已失效，完成验证后将返回管理后台。");
    authMessage.textContent = "正在前往钉钉登录…";
    authRetry.classList.add("hidden");
    loginSpinner.classList.remove("hidden");
    returnCookie("1", 300);
    window.location.assign("/api/auth/dingtalk/start");
  }

  function showAuthDialog(title, description) {
    authTitle.textContent = title;
    authDescription.textContent = description;
    authDialog.classList.remove("hidden");
    authDialog.setAttribute("aria-hidden", "false");
  }

  async function enterWithDingTalk() {
    if (state.authenticating) return;
    state.authenticating = true;
    authDialog.classList.add("hidden");
    authDialog.setAttribute("aria-hidden", "true");
    authMessage.textContent = "";
    authRetry.classList.add("hidden");
    loginSpinner.classList.remove("hidden");
    app.innerHTML = `<main class="auth-preview auth-preview-body" role="status"><span>安心报工</span><p>正在打开工作台…</p></main>`;
    try {
      const response = await fetch("/api/me", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (response.status === 401) return redirectToDingTalk();
      if (!response.ok) throw new Error("暂时无法验证登录状态，请重试");
      const account = await response.json();
      state.currentUser = account.user || account;
      const requestedView = new URLSearchParams(window.location.search).get("view");
      if (window.BlacklakeAgent && !requestedView) state.activeModule = "home";
      if (requestedView === "home") state.activeModule = "home";
      if (requestedView === "weekly") { state.activeModule = "weekly"; if (!state.openTabs.some((tab) => tab.key === "weekly")) state.openTabs.push({ key: "weekly", title: "生产周报", closable: true }); }
      returnCookie("", 0);
      // A valid existing session must not be presented as a new login while data loads.
      app.innerHTML = `<main class="auth-preview auth-preview-body" role="status"><span>安心报工</span><p>正在读取工单…</p></main>`;
      if (["home", "weekly"].includes(state.activeModule)) render();
      try {
        await loadAssignments();
      } catch {
        // loadAssignments retains data and shows an inline retry warning; only a 401 redirects.
        if (state.redirectingToLogin) return;
      }
      if (requestedView === "production") openModule("production");
      else if (requestedView === "report") openModule("report");
      else if (requestedView === "audit") {
        openModule("audit");
        try { await loadAudit({ offset: 0 }); } catch (error) { showToast(error.message); }
      }
      else if (requestedView === "dispatch-predictions") openModule("dispatch-predictions");
      else if (requestedView === "task-recovery") openModule("task-recovery");
      else if (requestedView === "management") openModule("management");
      startAutoRefresh();
    } catch (error) {
      state.redirectingToLogin = false;
      showAuthDialog("暂时无法打开工作台", "登录状态验证服务暂时不可用，请稍后重试。");
      loginSpinner.classList.add("hidden");
      authMessage.textContent = error.message || "暂时无法验证登录状态，请重试";
      authRetry.textContent = "重新尝试";
      authRetry.classList.remove("hidden");
    } finally {
      state.authenticating = false;
    }
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function askResolve(recordId, outcome) {
    const order = selectedOrder();
    const record = order.records.find((item) => item.id === recordId);
    if (!record) return;
    const confirmed = outcome === "CONFIRMED";
    confirmDialog.innerHTML = `<div class="dialog confirm-box"><span class="confirm-symbol ${confirmed ? "green" : "orange"}">${confirmed ? "✓" : "↺"}</span><h2>${confirmed ? "确认黑湖已有记录？" : "确认黑湖没有记录？"}</h2><p>${confirmed ? "本地记录将标记为已完成，不会再次提交。" : "本地记录将恢复为可重新报工状态。"}</p><div class="confirm-summary"><span>${escapeHtml(record.worker)}</span><strong>${escapeHtml(record.process)} · ${recordQuantityText(record)}</strong></div><div class="confirm-actions"><button data-action="cancel-resolve">取消</button><button class="${confirmed ? "confirm-created" : "confirm-missing"}" data-action="confirm-resolve" data-id="${recordId}" data-outcome="${outcome}">确认处理</button></div></div>`;
    confirmDialog.classList.remove("hidden");
    confirmDialog.setAttribute("aria-hidden", "false");
  }

  async function resolveRecord(recordId, outcome) {
    const order = selectedOrder();
    const record = order.records.find((item) => item.id === recordId);
    if (!record) return;
    if (!state.demo) {
      await api(`/v1/admin/assignments/${encodeURIComponent(recordId)}/resolve`, { method: "POST", body: JSON.stringify({ outcome }) });
      confirmDialog.classList.add("hidden");
      confirmDialog.setAttribute("aria-hidden", "true");
      state.drawerRecordId = null;
      await loadAssignments({ preserveSelection: true });
      showToast("核对已保存，工序和报工数据已刷新");
      return;
    }
    record.status = outcome === "CONFIRMED" ? "COMPLETED" : "IN_PROGRESS";
    record.note = outcome === "CONFIRMED" ? "人工确认：黑湖已有记录" : "人工确认：黑湖无记录，可重新报工";
    const worker = order.workers.find((item) => item.name === record.worker && item.process === record.process);
    if (worker) worker.status = record.status;
    order.status = order.records.some((item) => item.status === "NEEDS_REVIEW") ? "NEEDS_REVIEW" : order.status === "NEEDS_REVIEW" ? "IN_PROGRESS" : order.status;
    order.exception = order.status === "NEEDS_REVIEW" ? order.exception : "";
    state.drawerRecordId = null;
    confirmDialog.classList.add("hidden");
    render();
    showToast(outcome === "CONFIRMED" ? "已标记为黑湖已有记录" : "已恢复，可让工人重新报工");
  }

  function askCancelAssignment(recordId) {
    const record = selectedOrder()?.records.find((item) => item.id === recordId);
    if (!record || (record.assignmentStatus || record.status) !== "IN_PROGRESS") return;
    confirmDialog.innerHTML = `<div class="dialog confirm-box"><h2>取消这笔开工？</h2><p>不会向黑湖报产量。只适用于误开工；已完成的实际产量不能用取消代替报工。</p><div class="confirm-summary"><span>${escapeHtml(record.worker)}</span><strong>${escapeHtml(record.process)}</strong></div><div class="confirm-actions"><button data-action="cancel-resolve">返回</button><button class="confirm-missing" data-action="confirm-cancel-assignment" data-id="${escapeHtml(recordId)}">确认取消开工</button></div></div>`;
    confirmDialog.classList.remove("hidden");
    confirmDialog.setAttribute("aria-hidden", "false");
    document.querySelector('[data-action="confirm-cancel-assignment"]')?.focus();
  }

  async function cancelAssignment(recordId) {
    if (state.demo) throw new Error("演示模式不能取消真实任务");
    await api(`/v1/admin/assignments/${encodeURIComponent(recordId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
    state.drawerRecordId = null;
    confirmDialog.classList.add("hidden");
    await loadAssignments({ preserveSelection: true });
    showToast("已取消开工，已自动留痕且未报产量");
  }

  authRetry.addEventListener("click", enterWithDingTalk);

  document.addEventListener("compositionstart", (event) => {
    if (["order-search", "detail-search", "people-search", "station-search", "station-person-search", "audit-search"].includes(event.target.id)) composing = true;
  });
  document.addEventListener("compositionend", (event) => {
    if (!composing) return;
    composing = false;
    const fields = { "order-search": "search", "detail-search": "detailSearch", "people-search": "peopleSearch", "station-search": "stationSearch", "station-person-search": "stationPersonSearch", "audit-search": "auditQuery" };
    if (fields[event.target.id]) state[fields[event.target.id]] = event.target.value;
    if (event.target.id === "audit-search") return;
    if (event.target.id === "people-search") { renderPeopleSearchResults(); return; }
    if (event.target.id === "station-search") {
      const grid = document.querySelector("#station-recommendations");
      if (grid) grid.innerHTML = stationRecommendationGrid();
      return;
    }
    if (event.target.id === "station-person-search") {
      const list = document.querySelector("#station-person-list");
      if (list) list.innerHTML = stationPersonList();
      return;
    }
    render();
  });

  document.addEventListener("input", (event) => {
    const fields = { "order-search": "search", "detail-search": "detailSearch", "people-search": "peopleSearch", "station-search": "stationSearch", "station-person-search": "stationPersonSearch", "audit-search": "auditQuery" };
    const stateKey = fields[event.target.id];
    if (!stateKey) return;
    state[stateKey] = event.target.value;
    if (event.isComposing || composing) return;
    if (stateKey === "auditQuery") return;
    if (stateKey === "peopleSearch") {
      renderPeopleSearchResults();
      return;
    }
    if (stateKey === "stationSearch") {
      const grid = document.querySelector("#station-recommendations");
      if (grid) grid.innerHTML = stationRecommendationGrid();
      return;
    }
    if (stateKey === "stationPersonSearch") {
      const list = document.querySelector("#station-person-list");
      if (list) list.innerHTML = stationPersonList();
      return;
    }
    render();
  });

  document.addEventListener("change", (event) => {
    if(event.target.matches('[data-quality-role]')){updateQualityRole(event.target.dataset.id,event.target.value).catch(error=>{showToast(error.message);renderPeopleSearchResults();});return;}
    if(event.target.matches('[data-self-service]')){updateSelfService(event.target.dataset.id,event.target.value==='1').catch(error=>{showToast(error.message);renderPeopleSearchResults();});return;}
    if(event.target.matches('[data-worker-type]')) {
      updateWorkerType(event.target.dataset.id,event.target.value).catch(error=>{showToast(error.message);renderPeopleSearchResults();});
      return;
    }
    if (event.target.matches("[data-entry-role]")) {
      updateEntryProfile(event.target.dataset.id, { appRole: event.target.value, workUnitId: "" }).catch((error) => {
        showToast(error.message);
        renderPeopleSearchResults();
      });
      return;
    }
    if (event.target.matches("[data-work-unit]")) {
      updateEntryProfile(event.target.dataset.id, { workUnitId: event.target.value }).catch((error) => {
        showToast(error.message);
        renderPeopleSearchResults();
      });
      return;
    }
    const fields = {
      "audit-event-type": "auditEventType", "audit-error-code": "auditErrorCode",
      "audit-actor": "auditActor", "audit-from": "auditFrom", "audit-to": "auditTo"
    };
    const stateKey = fields[event.target.id];
    if (stateKey) state[stateKey] = event.target.value;
  });

  document.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" || event.target.id !== "audit-search" || event.isComposing) return;
    event.preventDefault();
    state.auditOffset = 0;
    try { await loadAudit({ offset: 0 }); } catch (error) { showToast(error.message); }
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "toggle-sidebar") { toggleSidebar(); return; }
    if (action === "analytics-drill") {
      const group = analyticsData(state.orders).groups.get(target.dataset.focus);
      if (!group?.ids.length) return showToast("当前没有符合这项结论的工单");
      state.analyticsFocus = target.dataset.focus;
      state.filter = "ALL"; state.search = ""; state.detailSearch = "";
      state.selectedId = group.ids[0]; state.expandedProcesses.clear();
      openModule("report");
    }
    if (action === "clear-analysis-focus") { state.analyticsFocus = null; render(); }
    if (action === "select-machine") {
      state.embroiderySelectedMachineId = target.dataset.machineId;
      state.embroideryInspectorOpen = true;
      render();
    }
    if (action === "embroidery-layout") { state.embroideryLayoutMode = target.dataset.layout; render(); }
    if (action === "toggle-embroidery-inspector") { state.embroideryInspectorOpen = !state.embroideryInspectorOpen; render(); }
    if (action === "open-module" || action === "switch-tab") {
      openModule(target.dataset.module);
      if (target.dataset.module === "people" && !state.demo && !state.operatorsLoaded) {
        try { await loadOperators(); } catch (error) { state.operatorsLoaded = true; render(); showToast(error.message); }
      }
      if (target.dataset.module === "audit" && !state.auditLoaded) {
        try { await loadAudit({ offset: 0 }); } catch (error) { showToast(error.message); }
      }
    }
    if (action === "close-tab") closeModule(target.dataset.module);
    if (action === "people-tab") { state.peopleTab = target.dataset.tab; render(); if (state.peopleTab === "groups") void peopleGroupsManager.load(); }
    if (action === "select-station") {
      state.selectedStationId = target.dataset.unitId;
      state.stationDraftOperatorIds = recommendedOperatorIds(state.selectedStationId);
      state.stationPersonSearch = "";
      renderStationWorkspace();
      if (Number(window.innerWidth || 0) > 0 && Number(window.innerWidth) <= 1100) document.querySelector("#station-detail")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    if (action === "choose-station-person") {
      const operatorId = Number(target.dataset.id);
      state.stationDraftOperatorIds = state.stationDraftOperatorIds.includes(operatorId)
        ? state.stationDraftOperatorIds.filter((id) => id !== operatorId)
        : [...state.stationDraftOperatorIds, operatorId];
      renderStationWorkspace();
    }
    if (action === "save-station-person") {
      target.disabled = true;
      try { await updateUnitRecommendation(state.selectedStationId, state.stationDraftOperatorIds); }
      catch (error) { showToast(error.message); renderStationWorkspace(); }
      finally { target.disabled = false; }
    }
    if (action === "clear-station-person") {
      target.disabled = true;
      try { await updateUnitRecommendation(state.selectedStationId, []); }
      catch (error) { showToast(error.message); renderStationWorkspace(); }
      finally { target.disabled = false; }
    }
    if (action === "select-order") { state.selectedId = target.dataset.id; state.detailSearch = ""; state.expandedProcesses.clear(); state.ledgerRecordsExpanded = false; state.drawerRecordId = null; render(); }
    if (action === "filter") { state.filter = target.dataset.filter; state.selectedId = filteredOrders()[0]?.id || null; state.expandedProcesses.clear(); state.ledgerRecordsExpanded = false; state.drawerRecordId = null; render(); }
    if (action === "detail-tab") { state.detailTab = target.dataset.tab; render(); }
    if (action === "toggle-process") { const id = target.dataset.id; if (state.expandedProcesses.has(id)) state.expandedProcesses.delete(id); else state.expandedProcesses.add(id); render(); }
    if (action === "collapse-all") { state.expandedProcesses = state.expandedProcesses.size ? new Set() : new Set(selectedOrder()?.processes.map((item) => item.id)); render(); }
    if (action === "open-record") { confirmDialog.classList.add("hidden"); state.drawerRecordId = target.dataset.id; render(); }
    if (action === "close-drawer") { state.drawerRecordId = null; render(); }
    if (action === "resolve") askResolve(target.dataset.id, target.dataset.outcome);
    if (action === "cancel-assignment") askCancelAssignment(target.dataset.id);
    if (action === "confirm-cancel-assignment") {
      target.disabled = true;
      try { await cancelAssignment(target.dataset.id); } catch (error) { showToast(error.message); }
      finally { target.disabled = false; }
    }
    if (action === "cancel-resolve") confirmDialog.classList.add("hidden");
    if (action === "close-binding-code") confirmDialog.classList.add("hidden");
    if (action === "create-binding-code") {
      try { await createBindingCode(target.dataset.id); } catch (error) { showToast(error.message); }
    }
    if (action === "unbind-operator") {
      try { await unbindOperator(target.dataset.id, target.dataset.name); } catch (error) { showToast(error.message); }
    }
    if (action === "update-reporting-permission") {
      target.disabled = true;
      try { await updateReportingPermission(target.dataset.id, target.dataset.enabled === "true"); } catch (error) { showToast(error.message); }
      finally { target.disabled = false; }
    }
    if (action === "refresh-operators") {
      if (state.demo) showToast("演示模式不读取黑湖人员");
      else try { await loadOperators(); showToast("黑湖人员已刷新"); } catch (error) { showToast(error.message); }
    }
    if (action === "refresh-audit") {
      target.disabled = true;
      try { await loadAudit(); showToast("审计日志已刷新"); } catch (error) { showToast(error.message); }
      finally { target.disabled = false; }
    }
    if (action === "search-audit") {
      state.auditOffset = 0;
      try { await loadAudit({ offset: 0 }); } catch (error) { showToast(error.message); }
    }
    if (action === "reset-audit") {
      state.auditQuery = ""; state.auditEventType = "ALL"; state.auditErrorCode = "ALL";
      state.auditActor = "ALL"; state.auditFrom = ""; state.auditTo = ""; state.auditOffset = 0;
      try { await loadAudit({ offset: 0 }); } catch (error) { showToast(error.message); }
    }
    if (action === "audit-page") {
      try { await loadAudit({ offset: Number(target.dataset.offset || 0) }); } catch (error) { showToast(error.message); }
    }
    if (action === "confirm-resolve") {
      target.disabled = true;
      try { await resolveRecord(target.dataset.id, target.dataset.outcome); } catch (error) { showToast(error.message); }
      finally { target.disabled = false; }
    }
    if (action === "refresh") {
      target.disabled = true;
      if (state.activeModule === "weekly") { await productionInsights?.refreshList(); target.disabled = false; return; }
      if (state.activeModule === "production") document.querySelector("#production-3d-frame")?.contentWindow?.postMessage({ type: "refresh-production-scene" }, window.location.origin);
      if (state.demo) { showToast("演示数据已刷新"); } else { try { if (state.activeModule === "people") await loadOperators(); else if (state.activeModule === "audit") await loadAudit(); else await loadAssignments({ preserveSelection: true }); showToast("当前数据已刷新"); } catch (error) { showToast(error.message); } }
      target.disabled = false;
    }
    if (action === "export") exportOrder(target.dataset.scope);
    if (action === "show-records") { state.detailTab = "records"; state.ledgerRecordsExpanded = true; render(); document.querySelector(".detail-bottom")?.scrollIntoView({ block: "start" }); }
    if (action === "hide-records") { state.ledgerRecordsExpanded = false; render(); }
    if (action === "ledger-attention") {
      const order = selectedOrder();
      if (order) {
        confirmDialog.innerHTML = `<div class="dialog ledger-attention-dialog"><div class="ledger-dialog-title"><h2>工单提醒</h2><button class="secondary-button" data-action="close-binding-code">关闭</button></div>${reviewPanel(order)}${quantityPendingPanel(order)}${anomalyPanel(order)}${ledgerOverruns(order).map((process) => `<section class="ledger-overrun-detail"><strong>${escapeHtml(process.name)}</strong><p>已报 ${ledgerNumber(process.reported)} 件，计划 ${ledgerNumber(process.planned)} 件，超出 ${ledgerNumber(process.reported - process.planned)} 件。请核对黑湖累计与计划；此提醒不会修改工序状态。</p></section>`).join("")}</div>`;
        confirmDialog.classList.remove("hidden"); confirmDialog.setAttribute("aria-hidden", "false");
      }
    }
    if (action === "not-ready") {
      confirmDialog.innerHTML = `<div class="dialog"><h2>报工管理使用说明</h2><p>左侧搜索和筛选工单，左右两栏可独立滚动。点击工序行查看参与记录；“查看报工”可直达下方记录。</p><p>工序已报为累计良品，工单累计完成取末道工序。达到计划数量不等于工序已关闭，完成状态以黑湖工序状态为依据。本系统记录不一定包含黑湖其他入口的历史报工。</p><p>长期工单、正常暂停本身不算异常；待核对记录需先到黑湖确认，避免重复提交。</p><button class="primary" data-action="close-binding-code">知道了</button></div>`;
      confirmDialog.classList.remove("hidden");
      confirmDialog.setAttribute("aria-hidden", "false");
    }
  });

  // Start the workspace after installing handlers.
  app.innerHTML = `<main class="auth-preview auth-preview-body" role="status"><span>安心报工</span><p>正在打开工作台…</p></main>`;
  const entryParams = new URLSearchParams(window.location.search);
  if (entryParams.get("demo") === "1") { useDemo(); if (["home", "weekly"].includes(entryParams.get("view"))) openModule(entryParams.get("view")); }
  else if (entryParams.has("auth_error")) {
    returnCookie("", 0);
    showAuthDialog("钉钉登录未完成", "请重新尝试，完成账号验证后进入管理后台。");
    loginSpinner.classList.add("hidden");
    authMessage.textContent = "钉钉登录未完成，请重新登录";
    authRetry.classList.remove("hidden");
  } else enterWithDingTalk();
})();
