import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { effectiveWorkSecondsBetween as serverSeconds } from "../src/work-time.mjs";

const miniProgramSource = await readFile(
  new URL("../../miniprogram/utils/work-time.js", import.meta.url),
  "utf8"
);
const sandbox = { module: { exports: {} } };
vm.runInNewContext(miniProgramSource, sandbox);
const miniProgramSeconds = sandbox.module.exports.effectiveWorkSecondsBetween;

const CASES = [
  ["2026-08-20 10:00:00", "2026-08-20 11:00:00", 3600],
  ["2026-08-20 11:30:00", "2026-08-20 14:00:00", 3600],
  ["2026-08-20 12:00:00", "2026-08-20 13:30:00", 0],
  ["2026-08-20 12:15:00", "2026-08-20 13:00:00", 0],
  ["2026-08-20 13:00:00", "2026-08-20 14:00:00", 1800],
  ["2026-08-20 11:00:00", "2026-08-21 14:00:00", 24 * 3600],
  ["2026-08-20 11:59:59", "2026-08-20 12:00:01", 1]
];

test("每天 12:00 至 13:30 不计入有效工作时间", () => {
  for (const [start, end, expected] of CASES) {
    assert.equal(serverSeconds(start, end), expected, `${start} -> ${end}`);
    assert.equal(miniProgramSeconds(start, end), expected, `小程序 ${start} -> ${end}`);
  }
});

test("小程序实时计时接受当前毫秒时间戳", () => {
  const endMs = Date.parse("2026-08-20T14:00:00+08:00");
  assert.equal(miniProgramSeconds("2026-08-20 11:30:00", endMs), 3600);
});
