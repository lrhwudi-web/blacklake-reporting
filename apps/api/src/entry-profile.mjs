import { assert } from "./errors.mjs";

export const APP_ROLES = Object.freeze({
  EMPLOYEE: "employee",
  FLOOR8_LEADER: "floor8_leader",
  FLOOR3_SUPERVISOR: "floor3_supervisor"
});

export const APP_ROLE_OPTIONS = Object.freeze([
  { value: APP_ROLES.EMPLOYEE, label: "员工", floor: null },
  { value: APP_ROLES.FLOOR8_LEADER, label: "8楼组长", floor: 8 },
  { value: APP_ROLES.FLOOR3_SUPERVISOR, label: "3楼主管", floor: 3 }
]);

export function normalizeEntryProfile(input = {}) {
  const appRole = String(input.appRole || APP_ROLES.EMPLOYEE).trim();
  assert(APP_ROLE_OPTIONS.some((item) => item.value === appRole), 422, "INVALID_APP_ROLE", "请选择正确的小程序身份。");
  const roleOption = APP_ROLE_OPTIONS.find((item) => item.value === appRole);
  const workUnitId = String(input.workUnitId || "").normalize("NFKC").trim().slice(0, 50);
  return {
    appRole,
    floor: roleOption.floor,
    workUnitId: appRole === APP_ROLES.EMPLOYEE ? workUnitId : ""
  };
}

export function publicEntryProfile(profile = {}) {
  const normalized = normalizeEntryProfile(profile);
  return {
    ...normalized,
    entryView: normalized.appRole === APP_ROLES.FLOOR8_LEADER
      ? "leader-assignment"
      : normalized.appRole === APP_ROLES.FLOOR3_SUPERVISOR
        ? "floor3-supervisor"
        : "employee-reporting"
  };
}

export function assertDispatcher(profile) {
  assert(
    [APP_ROLES.FLOOR8_LEADER, APP_ROLES.FLOOR3_SUPERVISOR].includes(profile?.appRole),
    403,
    "DISPATCH_NOT_ALLOWED",
    "当前人员没有派单权限。"
  );
}
