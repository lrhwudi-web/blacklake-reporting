import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import { z } from "zod";
import { createAgentRunner } from "../src/agent-runtime.mjs";
import { loadAgentConfig } from "../src/config.mjs";

const settings = { ...loadAgentConfig({}), apiKey: "fixture-private-key", maxSteps: 3 };
function completion(delta, reason, usage) {
  return `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`;
}
const toolReply = (name = "lookup") => new Response(
  completion({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name, arguments: '{"id":7}' } }] }, null)
  + completion({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + "data: [DONE]\n\n",
  { headers: { "Content-Type": "text/event-stream" } });
const textReply = () => new Response(completion({ content: "工序累计 40 件。" }, null)
  + completion({}, "stop", { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 }) + "data: [DONE]\n\n",
  { headers: { "Content-Type": "text/event-stream" } });

test("SDK performs real provider protocol tool loop, forwards safe sources, sums usage and disables thinking", async () => {
  const requests = [];
  let executions = 0;
  const runner = createAgentRunner({ config: settings, tools: {
    lookup: tool({ inputSchema: z.object({ id: z.number().int() }), execute: ({ id }) => {
      executions++; assert.equal(id, 7);
      return { goodAmount: 40, sources: [{ title: "测试来源", url: "/admin?view=report" }] };
    } })
  }, fetch: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return requests.length === 1 ? toolReply() : textReply();
  } });
  const events = [];
  for await (const event of runner({ messages: [{ role: "user", content: "查询7" }], signal: new AbortController().signal })) events.push(event);
  assert.equal(executions, 1); assert.equal(requests.length, 2);
  assert.equal(requests[0].tool_choice, "required");
  assert.equal(requests[0].thinking.type, "disabled");
  assert.equal(requests[1].messages.some((item) => item.role === "tool" && item.content.includes("40")), true);
  assert.equal(events.filter((item) => item.type === "source").length, 1);
  assert.equal(events.find((item) => item.type === "usage").usage.totalTokens, 41);
  assert.equal(events.filter((item) => item.type === "delta").map((item) => item.text).join(""), "工序累计 40 件。");
});

test("tool exceptions cannot send secrets into provider context or browser events", async () => {
  const requests = [];
  const runner = createAgentRunner({ config: settings, tools: {
    lookup: tool({ inputSchema: z.object({ id: z.number() }), execute: () => { throw new Error("credential-secret-sentinel"); } })
  }, fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return requests.length === 1 ? toolReply() : textReply(); } });
  const events = [];
  for await (const event of runner({ messages: [{ role: "user", content: "查询" }], signal: new AbortController().signal })) events.push(event);
  assert.equal(JSON.stringify({ requests, events }).includes("credential-secret-sentinel"), false);
  assert.equal(JSON.stringify(requests[1]).includes("QUERY_UNAVAILABLE"), true);
  assert.equal(events.find((item) => item.type === "tool" && item.status === "complete").failed, true);
});

test("loop budget reserves the last step for an answer with tools disabled", async () => {
  const requests = [];
  const runner = createAgentRunner({ config: settings, tools: {
    lookup: tool({ inputSchema: z.object({ id: z.number() }), execute: () => ({ status: "unavailable", sources: [] }) })
  }, fetch: async (_url, options) => { const body = JSON.parse(options.body); requests.push(body); return body.tool_choice === "none" ? textReply() : toolReply(); } });
  for await (const _event of runner({ messages: [{ role: "user", content: "查询" }], signal: new AbortController().signal })) { /* consume */ }
  assert.equal(requests.length, 3);
  assert.equal(requests[2].tool_choice, "none");
});

test("agent settings validate limits and accept DeepSeek key without returning it to clients", () => {
  assert.equal(loadAgentConfig({ DEEPSEEK_API_KEY: "fixture-key" }).apiKey, "fixture-key");
  assert.equal(loadAgentConfig({ AGENT_ENABLED: "false" }).enabled, false);
  for (const env of [{ AGENT_MAX_STEPS: "100" }, { AGENT_TIMEOUT_MS: "1" }, { AGENT_BASE_URL: "http://example.com" }, { AGENT_BASE_URL: "https://user:secret@example.com" }]) {
    assert.throws(() => loadAgentConfig(env), { code: "INVALID_CONFIG" });
  }
});

test("provider failures neither log private prompts nor leak upstream response bodies", async () => {
  const captured = [];
  const original = console.error;
  console.error = (...values) => captured.push(values);
  try {
    const runner = createAgentRunner({ config: settings, tools: {}, fetch: async () => new Response(
      JSON.stringify({ error: { message: "provider-private-sentinel", type: "authentication_error" } }),
      { status: 401, headers: { "Content-Type": "application/json" } }) });
    await assert.rejects(async () => {
      for await (const _event of runner({ messages: [{ role: "user", content: "user-private-sentinel" }], signal: new AbortController().signal })) { /* consume */ }
    }, { code: "AGENT_MODEL_FAILED" });
    assert.deepEqual(captured, []);
  } finally { console.error = original; }
});
