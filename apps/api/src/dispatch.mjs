import { APP_ROLES } from "./entry-profile.mjs";
import { assert } from "./errors.mjs";

export const FLOOR3_MACHINE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `3F-${String(index + 1).padStart(2, "0")}`)
);

export const FLOOR8_STATION_IDS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`)
]);

export const FLOOR8_UNIT_IDS = Object.freeze([
  ...FLOOR8_STATION_IDS,
  "手工剪线",
  "翻内袋",
  "包装/质检",
  "刺绣片检验",
  "裁床一区",
  "裁床二区-1",
  "裁床二区-2"
]);

export function unitsForRole(appRole) {
  if (appRole === APP_ROLES.FLOOR3_SUPERVISOR) return FLOOR3_MACHINE_IDS;
  if (appRole === APP_ROLES.FLOOR8_LEADER) return FLOOR8_UNIT_IDS;
  return [];
}

export function normalizeDispatchUnit(value, appRole) {
  const unitId = String(value || "").normalize("NFKC").trim();
  assert(unitsForRole(appRole).includes(unitId), 422, "INVALID_WORK_UNIT", "请选择当前楼层中的正确工位或机器。");
  return unitId;
}

export function resolveEmployeePlacements({ operatorIds, bindings, placements, unitId }) {
  const supplied = placements !== undefined;
  if (supplied) {
    assert(Array.isArray(placements) && placements.length === operatorIds.length,
      422, "INVALID_EMPLOYEE_PLACEMENTS", "请为每名所选人员确认工位。");
    const ids = placements.map((item) => Number(item?.blacklakeOperatorId));
    assert(new Set(ids).size === ids.length && ids.every((id) => operatorIds.includes(id)),
      422, "INVALID_EMPLOYEE_PLACEMENTS", "工位人员与所选人员不一致，请重新选择。");
  }
  return operatorIds.map((blacklakeOperatorId) => {
    const boundUnitIds = [...new Set(bindings.filter((item) => item.blacklakeOperatorId === blacklakeOperatorId
      && FLOOR8_UNIT_IDS.includes(item.unitId)).map((item) => item.unitId))];
    const placement = supplied ? placements.find((item) => Number(item.blacklakeOperatorId) === blacklakeOperatorId) : null;
    if (placement) assert(["binding", "manual"].includes(placement.source), 422,
      "INVALID_PLACEMENT_SOURCE", "请重新确认工位来源。");
    const source = placement?.source || (unitId ? "manual" : "binding");
    if (source === "binding") {
      assert(boundUnitIds.length === 1, 409, "WORK_UNIT_SELECTION_REQUIRED",
        "所选人员未绑定唯一工位，请明确选择工位后重试。");
      if (placement) assert(placement.unitId === boundUnitIds[0], 409, "WORK_UNIT_BINDING_CHANGED",
        "人员的工位绑定已变化，请刷新并重新核对后派工。");
    }
    return { blacklakeOperatorId, source,
      unitId: normalizeDispatchUnit(placement ? placement.unitId : unitId || boundUnitIds[0], APP_ROLES.FLOOR8_LEADER) };
  });
}

export function unitState(assignment) {
  if (Array.isArray(assignment)) {
    const states = assignment.map((item) => unitState(item));
    if (states.includes("attention")) return "attention";
    if (states.includes("running")) return "running";
    if (states.includes("scheduled")) return "scheduled";
    return "available";
  }
  if (!assignment) return "available";
  if (assignment.status === "READY") return "scheduled";
  if (assignment.status === "IN_PROGRESS") return "running";
  if (["REPORTING", "NEEDS_REVIEW"].includes(assignment.status)) return "attention";
  return "available";
}
