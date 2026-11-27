import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadDefectReasons } from "../src/defect-reasons.mjs";

test("载入工厂现有黑湖不良原因编号", async () => {
  const reasons = await loadDefectReasons(resolve("data/analysis/defect-reasons.json"));
  assert.equal(reasons.length, 7);
  assert.equal(new Set(reasons.map((reason) => reason.code)).size, reasons.length);
  assert.deepEqual(reasons[0], { code: "BL202501090006", name: "车缝不良" });
  assert.deepEqual(reasons.at(-1), { code: "BL202504030001", name: "图案不符" });
});

test("不良原因配置拒绝重复编号", async () => {
  const directory = mkdtempSync(join(tmpdir(), "defect-reasons-"));
  const path = join(directory, "reasons.json");
  writeFileSync(path, JSON.stringify({ reasons: [
    { code: "D1", name: "原因一" },
    { code: "D1", name: "原因二" }
  ] }));
  await assert.rejects(loadDefectReasons(path), /不良原因编号重复/);
});
