import { readFile } from "node:fs/promises";

const CODE_PATTERN = /^[\p{L}\p{N}_.-]{1,100}$/u;

export async function loadDefectReasons(path) {
  if (!path) return [];
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!parsed || !Array.isArray(parsed.reasons)) {
    throw new Error("不良原因配置必须包含 reasons 数组。");
  }

  const seen = new Set();
  return parsed.reasons.map((item) => {
    const code = String(item?.code || "").normalize("NFKC").trim();
    const name = String(item?.name || "").normalize("NFKC").trim();
    if (!CODE_PATTERN.test(code) || !name || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error("不良原因配置包含无效的编号或名称。");
    }
    if (seen.has(code)) throw new Error(`不良原因编号重复：${code}`);
    seen.add(code);
    return Object.freeze({ code, name });
  });
}
