import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

const baseEnv = {
  BLACKLAKE_MODE: "mock",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  ADMIN_API_KEY: "test-admin-key-that-is-long-enough"
};

test("审核体验默认关闭，不要求配置审核凭据", () => {
  const config = loadConfig(baseEnv);
  assert.deepEqual(config.review, {
    enabled: false,
    accessCode: "",
    operatorId: 0,
    allowedProjectIds: [],
    sessionHours: 24
  });
  assert.deepEqual(config.reportingModeAdminOperatorIds, []);
});

test("审核体验启用时校验测试人员、审核码和工单白名单", () => {
  const config = loadConfig({
    ...baseEnv,
    REVIEW_MODE_ENABLED: "true",
    REVIEW_ACCESS_CODE: "review-access-2026",
    REVIEW_OPERATOR_ID: "31001",
    REVIEW_ALLOWED_PROJECT_IDS: "65001, 65002，65001",
    REVIEW_SESSION_HOURS: "48",
    REPORTING_MODE_ADMIN_OPERATOR_IDS: "4412231, 31002，4412231"
  });
  assert.deepEqual(config.review, {
    enabled: true,
    accessCode: "review-access-2026",
    operatorId: 31001,
    allowedProjectIds: [65001, 65002],
    sessionHours: 48
  });
  assert.deepEqual(config.reportingModeAdminOperatorIds, [4412231, 31002]);

  assert.throws(() => loadConfig({
    ...baseEnv,
    REVIEW_MODE_ENABLED: "true",
    REVIEW_ACCESS_CODE: "short",
    REVIEW_OPERATOR_ID: "31001",
    REVIEW_ALLOWED_PROJECT_IDS: "65001"
  }), /REVIEW_ACCESS_CODE/);
});
