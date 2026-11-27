import { loadConfig } from "../src/config.mjs";

const [assignmentId, rawOutcome, blacklakeOutputId = ""] = process.argv.slice(2);
const outcome = String(rawOutcome || "").toUpperCase();
if (!assignmentId || !["CONFIRMED", "NOT_CREATED"].includes(outcome)) {
  console.error("用法：npm run assignment:resolve -- <任务ID> CONFIRMED [黑湖报工ID]");
  console.error("   或：npm run assignment:resolve -- <任务ID> NOT_CREATED");
  process.exit(1);
}

const config = loadConfig();
const response = await fetch(`http://${config.host}:${config.port}/v1/admin/assignments/${encodeURIComponent(assignmentId)}/resolve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Admin-Key": config.adminApiKey },
  body: JSON.stringify({ outcome, blacklakeOutputId })
});
const data = await response.json();
if (!response.ok) {
  console.error(data.error?.message || "核对结果保存失败");
  process.exit(1);
}
console.log(outcome === "CONFIRMED" ? "已确认黑湖存在记录，任务已完成。" : "已确认黑湖没有记录，任务已恢复为进行中，可重新结束报工。");
