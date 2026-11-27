import { randomUUID } from "node:crypto";
import { assert } from "./errors.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINAL_STATUSES = new Set(["complete", "interrupted", "error"]);
const MAX_TURNS = 40;
const MAX_CONTEXT_CHARACTERS = 48000;

// This store owns conversation history only. Production state must be queried
// again by tools; storing an answer does not make it current business data.
export class AgentStore {
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_conversations_owner_updated
        ON agent_conversations(owner, updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
        turn_number INTEGER NOT NULL CHECK(turn_number BETWEEN 1 AND 40),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending', 'complete', 'interrupted', 'error')),
        sources_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '{}',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(conversation_id, turn_number, role)
      );
      CREATE INDEX IF NOT EXISTS agent_messages_conversation_turn
        ON agent_messages(conversation_id, turn_number);
    `);
    // Construct once at server startup. A killed process cannot resume a model
    // stream; make that explicit and allow a new turn after restart.
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE agent_conversations SET updated_at = ?
        WHERE id IN (SELECT conversation_id FROM agent_messages WHERE status = 'pending')`).run(now);
      this.db.prepare("UPDATE agent_messages SET status = 'interrupted', updated_at = ? WHERE status = 'pending'").run(now);
    });
  }

  list(owner) {
    validateOwner(owner);
    return this.db.prepare(`SELECT id, title, updated_at AS updatedAt
      FROM agent_conversations WHERE owner = ? ORDER BY updated_at DESC, rowid DESC LIMIT 30`).all(owner)
      .map((row) => ({ ...row }));
  }

  get(owner, id) {
    validateOwner(owner);
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
    const conversation = this.db.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM agent_conversations WHERE id = ? AND owner = ?`).get(id, owner);
    if (!conversation) return null;
    const messages = this.db.prepare(`SELECT m.id, m.role, m.content, m.status, m.sources_json, m.created_at AS createdAt
      FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id
      WHERE c.id = ? AND c.owner = ? ORDER BY m.turn_number, CASE m.role WHEN 'user' THEN 0 ELSE 1 END`).all(id, owner);
    return {
      ...conversation,
      messages: messages.map(({ sources_json, ...message }) => ({
        ...message,
        sources: publicSources(JSON.parse(sources_json))
      }))
    };
  }

  beginTurn(owner, conversationId, message) {
    validateOwner(owner);
    assert(typeof message === "string" && message.trim().length > 0 && message.length <= 4000,
      400, "AGENT_INVALID_MESSAGE", "请输入 1–4000 字的问题。");
    assert(conversationId === null || conversationId === undefined || (typeof conversationId === "string" && UUID_PATTERN.test(conversationId)),
      404, "AGENT_CONVERSATION_NOT_FOUND", "找不到该对话，请开始新对话。");
    return this.transaction(() => {
      const now = new Date().toISOString();
      const id = conversationId || randomUUID();
      if (conversationId) {
        assert(this.db.prepare("SELECT id FROM agent_conversations WHERE id = ? AND owner = ?").get(id, owner),
          404, "AGENT_CONVERSATION_NOT_FOUND", "找不到该对话，请开始新对话。");
      } else {
        const title = Array.from(message.trim().replace(/\s+/g, " ")).slice(0, 60).join("");
        this.db.prepare("INSERT INTO agent_conversations(id, owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, owner, title, now, now);
      }
      assert(!this.db.prepare("SELECT id FROM agent_messages WHERE conversation_id = ? AND status = 'pending' LIMIT 1").get(id),
        409, "AGENT_CONVERSATION_BUSY", "这个对话正在回答，请等待或先停止。");
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?").get(id).count;
      assert(count < MAX_TURNS * 2, 409, "AGENT_CONVERSATION_LIMIT", "这个对话已达到 40 轮，请开始新对话。");
      const history = this.db.prepare(`SELECT m.role, m.content FROM agent_messages m
        JOIN agent_messages a ON a.conversation_id = m.conversation_id AND a.turn_number = m.turn_number AND a.role = 'assistant'
        JOIN agent_conversations c ON c.id = m.conversation_id
        WHERE c.id = ? AND c.owner = ? AND m.status = 'complete' AND a.status = 'complete'
        ORDER BY m.turn_number, CASE m.role WHEN 'user' THEN 0 ELSE 1 END`).all(id, owner).map((row) => ({ ...row }));
      const contextCharacters = history.reduce((total, item) => total + item.content.length, message.trim().length);
      assert(contextCharacters <= MAX_CONTEXT_CHARACTERS, 409, "AGENT_CONTEXT_LIMIT", "这个对话内容较长，请开始新对话后继续查询。");
      const messageId = randomUUID();
      const assistantId = randomUUID();
      const turn = count / 2 + 1;
      const insert = this.db.prepare(`INSERT INTO agent_messages
        (id, conversation_id, turn_number, role, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(messageId, id, turn, "user", message.trim(), "complete", now, now);
      insert.run(assistantId, id, turn, "assistant", "", "pending", now, now);
      this.db.prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ? AND owner = ?").run(now, id, owner);
      history.push({ role: "user", content: message.trim() });
      return { conversationId: id, messageId, assistantId, history };
    });
  }

  finishTurn(owner, conversationId, assistantId, { content = "", status, sources = [], usage = {}, toolCalls = [] } = {}) {
    validateOwner(owner);
    assert(typeof conversationId === "string" && UUID_PATTERN.test(conversationId) && typeof assistantId === "string" && UUID_PATTERN.test(assistantId),
      404, "AGENT_CONVERSATION_NOT_FOUND", "找不到该对话，请开始新对话。");
    assert(FINAL_STATUSES.has(status), 400, "AGENT_INVALID_STATUS", "对话状态无效。");
    assert(typeof content === "string" && content.length <= 100000, 400, "AGENT_INVALID_RESPONSE", "回答内容无效或过长。");
    const sourcesJson = JSON.stringify(publicSources(sources));
    const usageJson = JSON.stringify(auditUsage(usage));
    const toolCallsJson = JSON.stringify(auditTools(toolCalls));
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT m.status FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id
        WHERE c.id = ? AND c.owner = ? AND m.id = ? AND m.role = 'assistant'`).get(conversationId, owner, assistantId);
      assert(row, 404, "AGENT_CONVERSATION_NOT_FOUND", "找不到该对话，请开始新对话。");
      assert(row.status === "pending", 409, "AGENT_TURN_FINISHED", "这条回答已结束，不能覆盖。");
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE agent_messages SET content = ?, status = ?, sources_json = ?, usage_json = ?, tool_calls_json = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ? AND status = 'pending'`).run(content, status, sourcesJson, usageJson, toolCallsJson, now, assistantId, conversationId);
      this.db.prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ? AND owner = ?").run(now, conversationId, owner);
      return { conversationId, messageId: assistantId, status };
    });
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

function validateOwner(owner) {
  assert(typeof owner === "string" && owner.length >= 1 && owner.length <= 256 && !/[\u0000-\u001f]/.test(owner),
    401, "ADMIN_UNAUTHORIZED", "请先使用钉钉登录。");
}

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function publicSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).filter((source) => source && typeof source === "object").map((source) => ({
    title: text(source.title, 200),
    url: safeSourceUrl(source.url),
    scope: text(source.scope, 2000),
    queriedAt: text(source.queriedAt, 50),
    completeness: text(source.completeness, 200),
    warnings: Array.isArray(source.warnings) ? source.warnings.slice(0, 12).map((warning) => text(warning, 1000)) : []
  }));
}

function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  if (/^\/admin(?:[/?#]|$)/.test(value) && !/[\\\u0000-\u001f]/.test(value)) return value;
  return "";
}

function auditUsage(value) {
  const result = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"]) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

function auditTools(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 60).filter((item) => item && typeof item === "object").map((item) => ({
    toolName: text(item.toolName, 100),
    toolCallId: text(item.toolCallId, 200),
    status: text(item.status, 40),
    ...(Number.isFinite(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {})
  }));
}
