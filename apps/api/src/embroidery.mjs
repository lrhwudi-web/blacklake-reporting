export const EMBROIDERY_MACHINE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"))
);

export const EMBROIDERY_PARTS = Object.freeze(["前幅", "后幅"]);
export const BOUND_EMBROIDERY_ASSIGNMENT = 'SELF_EMBROIDERY';

export const REPORTING_MODES = Object.freeze({
  STANDARD: "standard",
  EMBROIDERY: "embroidery"
});

export function isEmbroideryDepartment(groupNames) {
  return (Array.isArray(groupNames) ? groupNames : [])
    .some((name) => /绣花|刺绣/.test(String(name || "").normalize("NFKC")));
}

export function reportingProfile(operator, adminOperatorIds = [], permissionOverride) {
  const embroidery = isEmbroideryDepartment(operator?.groupNames);
  const configuredAdministrator = adminOperatorIds.includes(Number(operator?.blacklakeOperatorId));
  const canSwitch = typeof permissionOverride === "boolean"
    ? permissionOverride
    : embroidery || configuredAdministrator;
  const defaultReportingMode = embroidery ? REPORTING_MODES.EMBROIDERY : REPORTING_MODES.STANDARD;
  return {
    reportingModes: canSwitch
      ? [REPORTING_MODES.EMBROIDERY, REPORTING_MODES.STANDARD]
      : [defaultReportingMode],
    defaultReportingMode
  };
}


export function isEmbroideryProcessName(value) {
  const name = String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleUpperCase("en-US");
  return name === "外协加工" || name === "外协加工KL";
}

export function normalizeEmbroideryPart(value) {
  const part = String(value || "").normalize("NFKC").trim();
  return EMBROIDERY_PARTS.includes(part) ? part : "";
}

export function normalizeEmbroideryMachineCode(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (!raw) return "";
  let candidate = raw;
  try {
    const url = new URL(raw);
    candidate = url.searchParams.get("machineId")
      || url.searchParams.get("machine")
      || url.pathname.match(/(?:^|\/)(?:embroidery\/)?machine\/([0-9]{1,2})(?:\/|$)/i)?.[1]
      || "";
  } catch {
    candidate = raw.match(/^(?:绣花机|机台|EMBROIDERY[\s:_-]*MACHINE|MACHINE)?[\s:_-]*([0-9]{1,2})$/i)?.[1] || "";
  }
  const id = /^\d{1,2}$/.test(String(candidate)) ? String(Number(candidate)).padStart(2, "0") : "";
  return EMBROIDERY_MACHINE_IDS.includes(id) ? id : "";
}


export function emptyEmbroideryMachines() {
  return EMBROIDERY_MACHINE_IDS.map((id) => ({ id, queue: [] }));
}
