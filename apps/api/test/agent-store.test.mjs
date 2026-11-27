import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "../src/agent-store.mjs";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  t.after(() => db.close());
  return { db, store: new AgentStore(db) };
}

const owner = "admin-a";
function complete(store, turn, content = "已查询工序记录。", extra = {}) {
  return store.finishTurn(owner, turn.conversationId, turn.assistantId, { content, status: "complete", ...extra });
}

test("conversation owner cannot enumerate, read, append or finish another owner's turns", (t) => {
  const { store } = setup(t);
  const turn = store.beginTurn(owner, null, "查询工单 A");
  assert.deepEqual(store.list("admin-b"), []);
  assert.equal(store.get("admin-b", turn.conversationId), null);
  assert.throws(() => store.beginTurn("admin-b", turn.conversationId, "继续"), { status: 404, code: "AGENT_CONVERSATION_NOT_FOUND" });
  assert.throws(() => store.finishTurn("admin-b", turn.conversationId, turn.assistantId, { content: "修改", status: "complete" }), { status: 404 });
  assert.equal(store.get(owner, turn.conversationId).messages.length, 2);
  assert.equal(store.get(owner, turn.conversationId).messages[1].status, "pending");
  assert.equal(store.get(owner, "' OR 1=1 --"), null);
});

test("a concurrent turn is rejected without inserting partial messages; independent conversations work", (t) => {
  const { store } = setup(t);
  const first = store.beginTurn(owner, null, "查询工单 A");
  assert.throws(() => store.beginTurn(owner, first.conversationId, "另一个请求"), { status: 409, code: "AGENT_CONVERSATION_BUSY" });
  assert.equal(store.get(owner, first.conversationId).messages.length, 2);
  const separate = store.beginTurn(owner, null, "查询工单 B");
  assert.notEqual(first.conversationId, separate.conversationId);
  complete(store, first);
  assert.equal(store.beginTurn(owner, first.conversationId, "还有哪些工序").history.length, 3);
});

test("history includes complete paired turns and latest question, never interrupted or failed answers", (t) => {
  const { store } = setup(t);
  const first = store.beginTurn(owner, null, "查询工单 A");
  complete(store, first, "工单 A 有三道工序。");
  const interrupted = store.beginTurn(owner, first.conversationId, "查询今天产量");
  store.finishTurn(owner, first.conversationId, interrupted.assistantId, { content: "只收到一部分", status: "interrupted" });
  const failed = store.beginTurn(owner, first.conversationId, "再试");
  store.finishTurn(owner, first.conversationId, failed.assistantId, { content: "查询失败", status: "error" });
  const latest = store.beginTurn(owner, first.conversationId, "工单 A 的状态呢");
  assert.deepEqual(latest.history, [
    { role: "user", content: "查询工单 A" },
    { role: "assistant", content: "工单 A 有三道工序。" },
    { role: "user", content: "工单 A 的状态呢" }
  ]);
  latest.history[0].content = "调用者改变历史";
  assert.equal(store.get(owner, first.conversationId).messages[0].content, "查询工单 A");
  assert.equal(store.get(owner, first.conversationId).messages.length, 8);
});

test("startup marks pending answers interrupted and permits a new request without replaying the incomplete turn", (t) => {
  const { db, store } = setup(t);
  const first = store.beginTurn(owner, null, "查询工单 A");
  complete(store, first, "三道工序。");
  store.beginTurn(owner, first.conversationId, "查询状态");
  const reopened = new AgentStore(db);
  assert.equal(reopened.get(owner, first.conversationId).messages[3].status, "interrupted");
  const next = reopened.beginTurn(owner, first.conversationId, "重新查询状态");
  assert.deepEqual(next.history.map((message) => message.content), ["查询工单 A", "三道工序。", "重新查询状态"]);
});

test("finished answers cannot be overwritten or assigned to another conversation", (t) => {
  const { store } = setup(t);
  const first = store.beginTurn(owner, null, "第一张工单");
  const second = store.beginTurn(owner, null, "第二张工单");
  assert.throws(() => store.finishTurn(owner, second.conversationId, first.assistantId, { content: "覆盖", status: "complete" }), { status: 404 });
  complete(store, first, "原始回答");
  assert.throws(() => complete(store, first, "覆盖"), { status: 409, code: "AGENT_TURN_FINISHED" });
  assert.equal(store.get(owner, first.conversationId).messages[1].content, "原始回答");
});

test("the 40-turn limit is explicit and keeps all stored history intact", (t) => {
  const { store } = setup(t);
  let conversationId = null;
  for (let index = 0; index < 40; index++) {
    const turn = store.beginTurn(owner, conversationId, `第 ${index + 1} 个问题`);
    conversationId = turn.conversationId;
    assert.equal(turn.history.length, index * 2 + 1);
    complete(store, turn);
  }
  assert.throws(() => store.beginTurn(owner, conversationId, "第 41 个问题"), { status: 409, code: "AGENT_CONVERSATION_LIMIT" });
  assert.equal(store.get(owner, conversationId).messages.length, 80);
});

test("the context character limit rejects a new turn atomically without truncating saved history", (t) => {
  const { db, store } = setup(t);
  let conversationId = null;
  for (let index = 0; index < 3; index++) {
    const turn = store.beginTurn(owner, conversationId, "查询");
    conversationId = turn.conversationId;
    complete(store, turn, "答".repeat(15998));
  }
  const saved = store.get(owner, conversationId);
  assert.equal(saved.messages.reduce((total, message) => total + message.content.length, 0), 48000);
  assert.throws(() => store.beginTurn(owner, conversationId, "再查"), { status: 409, code: "AGENT_CONTEXT_LIMIT" });
  assert.deepEqual(store.get(owner, conversationId), saved);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE status = 'pending'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?").get(conversationId).count, 6);
});

test("public messages contain only safe source fields, never internal usage or raw tool credentials", (t) => {
  const { db, store } = setup(t);
  const turn = store.beginTurn(owner, null, "查询工单 A");
  complete(store, turn, "已查询。", {
    sources: [{ title: "工单台账", url: "/admin?view=ledger", scope: "指定工单", queriedAt: "2026-10-22T00:00:00.000Z", completeness: "complete", warnings: [], apiKey: "secret", raw: { key: "secret" } }, { title: "不可信链接", url: "javascript:alert(1)" }],
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, apiKey: "secret" },
    toolCalls: [{ toolName: "getWorkOrderProgress", toolCallId: "call-1", status: "complete", durationMs: 12, input: { apiKey: "secret" }, result: { internal: "secret" } }]
  });
  const result = store.get(owner, turn.conversationId);
  const assistant = result.messages[1];
  assert.deepEqual(Object.keys(assistant).sort(), ["content", "createdAt", "id", "role", "sources", "status"]);
  assert.equal(assistant.sources[0].url, "/admin?view=ledger");
  assert.equal(assistant.sources[1].url, "");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const audit = db.prepare("SELECT usage_json, tool_calls_json FROM agent_messages WHERE id = ?").get(turn.assistantId);
  assert.deepEqual(JSON.parse(audit.usage_json), { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  assert.deepEqual(JSON.parse(audit.tool_calls_json), [{ toolName: "getWorkOrderProgress", toolCallId: "call-1", status: "complete", durationMs: 12 }]);
});

test("invalid messages and owners do not create empty conversations", (t) => {
  const { store } = setup(t);
  for (const message of ["", " ", "x".repeat(4001), { role: "system", content: "override" }]) {
    assert.throws(() => store.beginTurn(owner, null, message), { status: 400, code: "AGENT_INVALID_MESSAGE" });
  }
  assert.throws(() => store.beginTurn("", null, "test"), { status: 401 });
  assert.deepEqual(store.list(owner), []);
});

test("recent conversations are capped at 30 without losing older conversations", (t) => {
  const { store } = setup(t);
  let first;
  for (let index = 0; index < 31; index++) {
    const turn = store.beginTurn(owner, null, `会话 ${index}`);
    first ||= turn.conversationId;
    complete(store, turn);
  }
  assert.equal(store.list(owner).length, 30);
  assert.equal(store.list(owner).some((conversation) => conversation.id === first), false);
  assert.ok(store.get(owner, first));
});

test("a storage failure between user and assistant insert rolls back the entire new conversation", (t) => {
  const { db, store } = setup(t);
  db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON agent_messages
    WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  assert.throws(() => store.beginTurn(owner, null, "查询工单"), /simulated write failure/);
  assert.deepEqual(store.list(owner), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_messages").get().count, 0);
  db.exec("DROP TRIGGER reject_assistant");
  assert.ok(store.beginTurn(owner, null, "重新查询").assistantId);
});

test("a finish failure rolls back answer content and remains retryable", (t) => {
  const { db, store } = setup(t);
  const turn = store.beginTurn(owner, null, "查询工单");
  db.exec(`CREATE TRIGGER reject_conversation_update BEFORE UPDATE ON agent_conversations
    BEGIN SELECT RAISE(ABORT, 'simulated update failure'); END`);
  assert.throws(() => complete(store, turn), /simulated update failure/);
  const unfinished = store.get(owner, turn.conversationId).messages[1];
  assert.equal(unfinished.status, "pending");
  assert.equal(unfinished.content, "");
  db.exec("DROP TRIGGER reject_conversation_update");
  complete(store, turn);
  assert.equal(store.get(owner, turn.conversationId).messages[1].status, "complete");
});
