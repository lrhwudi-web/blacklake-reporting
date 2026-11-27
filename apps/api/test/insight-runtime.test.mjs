import test from "node:test";
import assert from "node:assert/strict";
import { createInsightRunner, validateInsight } from "../src/insight-runtime.mjs";

test("insight SDK structured completion keeps evidence read-only and disables thinking", async () => {
  const requests = [];
  const run = createInsightRunner({ config: { baseURL: "https://mock.invalid/v1", apiKey: "fixture-only", model: "fixture" },
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture", choices: [
        { index: 0, message: { role: "assistant", content: JSON.stringify({ possibleCauses: ["可能为计划未更新，需核实。"], nextChecks: ["核对原始报工。"] }) }, finish_reason: "stop" }
      ], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }), { headers: { "content-type": "application/json" } });
    } });
  const result = await run({ kind: "finding", evidence: { facts: ["计划100，累计200"] }, signal: new AbortController().signal });
  assert.match(result.possibleCauses[0], /可能/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].thinking.type, "disabled");
  assert.equal(requests[0].response_format.type, "json_object");
  assert.match(requests[0].messages.at(-1).content, /possibleCauses/);
  assert.equal(requests[0].tools, undefined);
  assert.match(JSON.stringify(requests[0].messages), /NEEDS_REVIEW/);
});

test("AI narratives reject unexpected fields, empty or oversized output", () => {
  for (const value of [{ summary: [] }, { summary: ["x".repeat(351)] }, { summary: ["一", "二", "三", "四"] }, { summary: ["结论"], facts: ["伪造事实"] }]) {
    assert.throws(() => validateInsight("weekly", value), { code: "INSIGHT_INVALID_OUTPUT" });
  }
});
