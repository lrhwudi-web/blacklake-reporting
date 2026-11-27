import { resolve } from "node:path";
import { assert } from "./errors.mjs";

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimal(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function positiveIntegerList(value, label) {
  const text = String(value || "").trim();
  if (!text) return [];
  const values = text.split(/[\s,，]+/).filter(Boolean).map((item) => Number(item));
  assert(
    values.every((item) => Number.isSafeInteger(item) && item > 0),
    500,
    "INVALID_CONFIG",
    `${label} 必须是用逗号分隔的正整数。`
  );
  return [...new Set(values)];
}

function parseStationCodeAliases(value) {
  const text = String(value || "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert(false, 500, "INVALID_CONFIG", "STATION_CODE_ALIASES 必须是 JSON 对象。");
  }
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), 500, "INVALID_CONFIG", "STATION_CODE_ALIASES 必须是 JSON 对象。");
  const aliases = {};
  for (const [taskIdText, processCodeValue] of Object.entries(parsed)) {
    const taskId = Number(taskIdText);
    const processCode = String(processCodeValue || "").normalize("NFKC").trim();
    assert(Number.isSafeInteger(taskId) && taskId > 0, 500, "INVALID_CONFIG", "STATION_CODE_ALIASES 包含无效的旧任务 ID。");
    assert(processCode.length >= 1 && processCode.length <= 100 && !/[\u0000-\u001f\u007f]/.test(processCode), 500, "INVALID_CONFIG", "STATION_CODE_ALIASES 包含无效的工序编码。");
    aliases[String(taskId)] = processCode;
  }
  return aliases;
}

export function loadConfig(env = process.env) {
  const blacklake = loadBlacklakeConfig(env);
  const mode = blacklake.mode;
  const sessionSecret = env.SESSION_SECRET || (mode === "mock" ? "local-development-secret-change-me" : "");
  const adminApiKey = env.ADMIN_API_KEY || (mode === "mock" ? "local-admin-key-change-me-123456" : "");
  const adminProxySecret = env.ADMIN_PROXY_SECRET || "";
  const reviewEnabled = boolean(env.REVIEW_MODE_ENABLED);
  const reviewAccessCode = String(env.REVIEW_ACCESS_CODE || "").trim();
  const reviewOperatorId = integer(env.REVIEW_OPERATOR_ID, 0);
  const reviewAllowedProjectIds = positiveIntegerList(env.REVIEW_ALLOWED_PROJECT_IDS, "REVIEW_ALLOWED_PROJECT_IDS");
  const reviewSessionHours = integer(env.REVIEW_SESSION_HOURS, 24);
  const reportingModeAdminOperatorIds = positiveIntegerList(
    env.REPORTING_MODE_ADMIN_OPERATOR_IDS,
    "REPORTING_MODE_ADMIN_OPERATOR_IDS"
  );
  const overnightReferencePolicy=env.OVERNIGHT_CLOCKOUT_REFERENCE_POLICY||'team-first';
  assert(['team-first','global-last','team-only'].includes(overnightReferencePolicy),500,'INVALID_CONFIG','OVERNIGHT_CLOCKOUT_REFERENCE_POLICY 必须是 team-first、global-last 或 team-only。');

  assert(["mock", "live"].includes(mode), 500, "INVALID_CONFIG", "BLACKLAKE_MODE 只能是 mock 或 live。");
  assert(sessionSecret.length >= 32, 500, "INVALID_CONFIG", "SESSION_SECRET 至少需要 32 个字符。");
  assert(adminApiKey.length >= 32, 500, "INVALID_CONFIG", "ADMIN_API_KEY 至少需要 32 个字符。");
  assert(!adminProxySecret || adminProxySecret.length >= 32, 500, "INVALID_CONFIG", "ADMIN_PROXY_SECRET 至少需要 32 个字符。");
  if (reviewEnabled) {
    assert(reviewAccessCode.length >= 8 && reviewAccessCode.length <= 64, 500, "INVALID_CONFIG", "REVIEW_ACCESS_CODE 必须是 8–64 个字符。");
    assert(reviewOperatorId > 0, 500, "INVALID_CONFIG", "REVIEW_OPERATOR_ID 必须是有效的黑湖测试人员 ID。");
    assert(reviewAllowedProjectIds.length > 0, 500, "INVALID_CONFIG", "REVIEW_ALLOWED_PROJECT_IDS 至少要配置一个黑湖测试工单 ID。");
    assert(reviewSessionHours >= 1 && reviewSessionHours <= 168, 500, "INVALID_CONFIG", "REVIEW_SESSION_HOURS 必须在 1–168 小时之间。");
  }

  const config = {
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 4180),
    databasePath: resolve(env.DATABASE_PATH || "./data/reporting.sqlite"),
    processInferenceRulesPath: resolve(env.PROCESS_INFERENCE_RULES_PATH || "./data/analysis/process-inference-rules.json"),
      dispatchPredictionRulesPath: resolve(env.DISPATCH_PREDICTION_RULES_PATH || "./data/analysis/dispatch-prediction-rules.json"),
    defectReasonsPath: resolve(env.DEFECT_REASONS_PATH || "./data/analysis/defect-reasons.json"),
    stationCodeAliases: parseStationCodeAliases(env.STATION_CODE_ALIASES),
    sessionSecret,
    adminApiKey,
    adminProxySecret,
    sessionDays: integer(env.SESSION_DAYS, 30),
    dataSync:{enabled:boolean(env.BLACKLAKE_DATA_SYNC_ENABLED,false),allowNext:boolean(env.BLACKLAKE_QUEUE_ALLOW_NEXT,true),historyDays:integer(env.BLACKLAKE_SYNC_HISTORY_DAYS,2),refreshMs:integer(env.BLACKLAKE_SYNC_REFRESH_MS,60000),intervalMs:integer(env.BLACKLAKE_SYNC_INTERVAL_MS,1200),maxReadFailures:5,
      refreshPolicy:{order:300000,people:1800000,catalog:900000,'order-reports':300000,materials:21600000,history:600000,'history-day':300000,output:60000}},
    requestBudget:{totalPerHour:integer(env.BLACKLAKE_TOTAL_PER_HOUR,10000),totalQps:integer(env.BLACKLAKE_TOTAL_QPS,20),writePerHour:integer(env.BLACKLAKE_WRITE_PER_HOUR,5000),writeQps:integer(env.BLACKLAKE_WRITE_QPS,10),loginPerHour:integer(env.BLACKLAKE_LOGIN_PER_HOUR,75),cooldownMs:integer(env.BLACKLAKE_RATE_COOLDOWN_MS,120000)},
    overnightClockout:{enabled:boolean(env.OVERNIGHT_CLOCKOUT_ENABLED,true),referencePolicy:overnightReferencePolicy},
    reportingModeAdminOperatorIds,
    review: {
      enabled: reviewEnabled,
      accessCode: reviewAccessCode,
      operatorId: reviewOperatorId,
      allowedProjectIds: reviewAllowedProjectIds,
      sessionHours: reviewSessionHours
    },
    anomalyRules: loadAnomalyRules(env),
    agent: loadAgentConfig(env),
    wechat: {
      mock: mode === "mock",
      appId: env.WECHAT_APP_ID || "",
      appSecret: env.WECHAT_APP_SECRET || "",
      code2SessionUrl: env.WECHAT_CODE2SESSION_URL || "https://api.weixin.qq.com/sns/jscode2session",
      timeoutMs: integer(env.WECHAT_REQUEST_TIMEOUT_MS, 8000)
    },
    blacklake
  };

  assert(config.wechat.code2SessionUrl.startsWith("https://"), 500, "INVALID_CONFIG", "微信登录地址必须使用 HTTPS。");
  assert(config.wechat.timeoutMs >= 1000 && config.wechat.timeoutMs <= 30000, 500, "INVALID_CONFIG", "微信登录超时时间必须在 1–30 秒之间。");
  assert(config.dataSync.historyDays>=0&&config.dataSync.historyDays<=366&&config.dataSync.refreshMs>=10000&&config.dataSync.intervalMs>=250,500,'INVALID_SYNC_CONFIG','同步历史范围或调度间隔不正确。');
  const quota=config.requestBudget;
  assert(quota.totalPerHour>=1&&quota.totalPerHour<=10000&&quota.totalQps>=1&&quota.totalQps<=20&&quota.writePerHour>=1&&quota.writePerHour<=Math.min(5000,quota.totalPerHour)&&quota.writeQps>=1&&quota.writeQps<=Math.min(10,quota.totalQps)&&quota.loginPerHour>=1&&quota.loginPerHour<=75&&quota.cooldownMs>=1000,500,'INVALID_REQUEST_BUDGET','黑湖统一限速参数无效。');

  return config;
}

export function loadAgentConfig(env = process.env) {
  const config = {
    enabled: boolean(env.AGENT_ENABLED, true),
    apiKey: String(env.AGENT_API_KEY || env.DEEPSEEK_API_KEY || "").trim(),
    baseURL: String(env.AGENT_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, ""),
    model: String(env.AGENT_MODEL || "deepseek-flash").trim(),
    timeoutMs: integer(env.AGENT_TIMEOUT_MS, 60000),
    maxSteps: integer(env.AGENT_MAX_STEPS, 6),
    maxOutputTokens: integer(env.AGENT_MAX_OUTPUT_TOKENS, 1800)
  };
  let endpoint;
  try { endpoint = new URL(config.baseURL); } catch { /* validated below */ }
  assert(endpoint && endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    500, "INVALID_CONFIG", "AGENT_BASE_URL 必须是不含凭据和查询参数的 HTTPS 地址。");
  assert(config.model.length > 0 && config.model.length <= 100, 500, "INVALID_CONFIG", "AGENT_MODEL 不正确。");
  assert(config.timeoutMs >= 5000 && config.timeoutMs <= 120000, 500, "INVALID_CONFIG", "AGENT_TIMEOUT_MS 必须在 5000–120000 之间。");
  assert(config.maxSteps >= 2 && config.maxSteps <= 8, 500, "INVALID_CONFIG", "AGENT_MAX_STEPS 必须在 2–8 之间。");
  assert(config.maxOutputTokens >= 256 && config.maxOutputTokens <= 4000, 500, "INVALID_CONFIG", "AGENT_MAX_OUTPUT_TOKENS 必须在 256–4000 之间。");
  return config;
}

export function loadAnomalyRules(env = process.env) {
  const values = {
    deadlineGraceMinutes: integer(env.ANOMALY_DEADLINE_GRACE_MINUTES, 30),
    durationBaselineMinSamples: integer(env.ANOMALY_DURATION_BASELINE_MIN_SAMPLES, 5),
    durationMultiplier: decimal(env.ANOMALY_DURATION_MULTIPLIER, 3),
    durationMinimumExcessMinutes: integer(env.ANOMALY_DURATION_MINIMUM_EXCESS_MINUTES, 60)
  };
  assert(values.deadlineGraceMinutes >= 0 && values.deadlineGraceMinutes <= 1440, 500, "INVALID_CONFIG", "ANOMALY_DEADLINE_GRACE_MINUTES 必须在 0–1440 之间。");
  assert(values.durationBaselineMinSamples >= 3 && values.durationBaselineMinSamples <= 100, 500, "INVALID_CONFIG", "ANOMALY_DURATION_BASELINE_MIN_SAMPLES 必须在 3–100 之间。");
  assert(values.durationMultiplier >= 1.1 && values.durationMultiplier <= 10, 500, "INVALID_CONFIG", "ANOMALY_DURATION_MULTIPLIER 必须在 1.1–10 之间。");
  assert(values.durationMinimumExcessMinutes >= 5 && values.durationMinimumExcessMinutes <= 1440, 500, "INVALID_CONFIG", "ANOMALY_DURATION_MINIMUM_EXCESS_MINUTES 必须在 5–1440 之间。");
  return {
    deadlineGraceSeconds: values.deadlineGraceMinutes * 60,
    durationBaselineMinSamples: values.durationBaselineMinSamples,
    durationMultiplier: values.durationMultiplier,
    durationMinimumExcessSeconds: values.durationMinimumExcessMinutes * 60
  };
}

export function loadBlacklakeConfig(env = process.env) {
  const mode = env.BLACKLAKE_MODE || "mock";
  assert(["mock", "live"].includes(mode), 500, "INVALID_CONFIG", "BLACKLAKE_MODE 只能是 mock 或 live。");

  const config = {
    mode,
    baseUrl: (env.BLACKLAKE_BASE_URL || "https://liteweb.blacklake.cn").replace(/\/$/, ""),
    staticToken: env.BLACKLAKE_STATIC_TOKEN || "",
    loginPath: env.BLACKLAKE_LOGIN_PATH || "/api/user/v1/users/_login",
    loginType: String(env.BLACKLAKE_LOGIN_TYPE || "1"),
    client: env.BLACKLAKE_CLIENT || "lite-web",
    factoryCode: env.BLACKLAKE_CODE || env.BLACKLAKE_FACTORY_CODE || "",
    account: env.BLACKLAKE_USERNAME || env.BLACKLAKE_ACCOUNT || "",
    phone: env.BLACKLAKE_PHONE || "",
    password: env.BLACKLAKE_PASSWORD || "",
    taskQueryPath: env.BLACKLAKE_TASK_QUERY_PATH || "/api/dytin/external/task/queryList2",
    currentProcessPath: env.BLACKLAKE_CURRENT_PROCESS_PATH || "/api/dytin/external/project/queryList/expand",
    outputQueryPath: env.BLACKLAKE_OUTPUT_QUERY_PATH || "/api/dytin/external/output/queryList3",
    userQueryPath: env.BLACKLAKE_USER_QUERY_PATH || "/api/dytin/external/user/queryList2",
    outputAddPath: env.BLACKLAKE_OUTPUT_ADD_PATH || "/api/dytin/external/output/add",
    approveStatus: integer(env.BLACKLAKE_APPROVE_STATUS, 0),
    timeoutMs: integer(env.BLACKLAKE_REQUEST_TIMEOUT_MS, 12000)
  };

  if (mode === "live") {
    assert(config.baseUrl.startsWith("https://"), 500, "INVALID_CONFIG", "正式模式必须使用 HTTPS 黑湖域名。");
    assert(["1", "2"].includes(config.loginType), 500, "INVALID_CONFIG", "BLACKLAKE_LOGIN_TYPE 只能是 1 或 2。");
    const credentialsReady = config.loginType === "1"
      ? config.factoryCode && config.account && config.password
      : config.phone && config.account && config.password;
    assert(
      config.staticToken || credentialsReady,
      500,
      "INVALID_CONFIG",
      "正式模式需要配置 BLACKLAKE_STATIC_TOKEN，或完整的黑湖 OpenAPI 登录凭据。"
    );
  }

  return config;
}
