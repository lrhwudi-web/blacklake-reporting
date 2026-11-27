import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../agent-chat.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ndjson = (events) => new Response(events.map((event) => JSON.stringify(event)).join('\n'));
function library() {
  const window = { location: { origin: 'https://report.example' } };
  vm.runInNewContext(source, { window, URL, TextDecoder, AbortController, DOMException, Date });
  return window.BlacklakeAgent;
}
function fakeRoot() {
  const nodes = new Map(), listeners = new Map();
  const root = {
    dataset: {}, innerHTML: '', listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, scrollHeight: 500, scrollTop: 0, clientHeight: 500, setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } });
      return nodes.get(selector);
    }
  };
  return root;
}
async function launch({ handler, status = { enabled: true, configured: true }, conversations = [], demo = false } = {}) {
  const calls = [], root = fakeRoot();
  let unauthorized = 0;
  const agent = library().create({
    onUnauthorized: () => { unauthorized++; },
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/status')) return status instanceof Response ? status : json(status);
      if (path.endsWith('/conversations')) return json({ conversations });
      return handler?.(path, options) || json({ id: 'old', messages: [] });
    }
  });
  agent.mount(root, { demo });
  await flush();
  const input = (value) => {
    root.querySelector('#agent-message-input').value = value;
    root.listeners.get('input')({ target: { id: 'agent-message-input', value } });
  };
  return { root, agent, calls, input, unauthorized: () => unauthorized };
}

test('NDJSON handles UTF-8 characters across chunks and an unterminated final done line', async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify({ type: 'delta', text: '工单进度' })}\n${JSON.stringify({ type: 'done', status: 'complete' })}`);
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const stream = new ReadableStream({ pull(controller) { chunks.length ? controller.enqueue(chunks.shift()) : controller.close(); } });
  const events = [];
  await library().consumeNdjson(new Response(stream), (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ['delta', 'done']);
  assert.equal(events[0].text, '工单进度');
});

test('a closed stream without done and malformed data are not counted as complete answers', async () => {
  await assert.rejects(library().consumeNdjson(ndjson([{ type: 'delta', text: '部分回答' }]), () => {}), /连接已中断/);
  await assert.rejects(library().consumeNdjson(new Response('{broken}\n'), () => {}), /连接异常/);
});

test('sources allow only same-origin admin destinations', () => {
  const safe = library().safeSourceUrl;
  assert.equal(safe('/admin?view=report', 'https://report.example'), '/admin?view=report');
  assert.equal(safe('https://report.example/admin/production-3d/', 'https://report.example'), '/admin/production-3d/');
  for (const value of ['javascript:alert(1)', 'https://external.example/admin', '//external.example/admin', '/api/auth/logout', '/administrator', '/admin/../private']) {
    assert.equal(safe(value, 'https://report.example'), '');
  }
});

test('answer formatting supports headings, lists, emphasis, local links and scrollable tables', () => {
  const html = library().formatAnswer('# 现场概况\n\n**已核对** `8F-01`\n\n- 第一项\n- 第二项\n\n1. 先查询\n2. 再查看\n\n| 工单 | 状态 |\n| --- | :---: |\n| WO-01 | **进行中** |\n\n[查看来源](/admin?view=production)', 'https://report.example');
  assert.match(html, /<h3>现场概况<\/h3>/);
  assert.match(html, /<strong>已核对<\/strong> <code>8F-01<\/code>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<ol><li>先查询<\/li><li>再查看<\/li><\/ol>/);
  assert.match(html, /class="agent-table-scroll" tabindex="0"/);
  assert.match(html, /<th scope="col">工单<\/th>/);
  assert.match(html, /<td><strong>进行中<\/strong><\/td>/);
  assert.match(html, /href="\/admin\?view=production" target="_blank" rel="noopener">查看来源<\/a>/);
});

test('answer formatting escapes raw HTML in every supported block and rejects unsafe links', () => {
  const html = library().formatAnswer('# <img src=x onerror=alert(1)>\n\n**<svg/onload=alert(1)>** `<script>alert(1)</script>`\n\n- <iframe src=evil>\n\n| <script> | 值 |\n| --- | --- |\n| <img src=x> | [坏链接](javascript:alert) |\n\n[外链](https://external.example/admin) [退出](/api/auth/logout) [引号](/admin?x="onmouseover="bad)', 'https://report.example');
  assert.doesNotMatch(html, /<(?:img|svg|script|iframe)\b|href="(?:javascript|https:|\/api)/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<td>&lt;img src=x&gt;<\/td>/);
  assert.match(html, /\[外链\]\(https:\/\/external.example\/admin\)/);
  assert.match(html, /href="\/admin\?x=%22onmouseover=%22bad"/);
});

test('partial streaming markdown remains visible and malformed tables stay plain text', () => {
  const format = library().formatAnswer;
  assert.equal(format('**正在查询', 'https://report.example'), '<p>**正在查询</p>');
  assert.equal(format('第一行\n第二行\n\n下一段', 'https://report.example'), '<p>第一行<br>第二行</p><p>下一段</p>');
  assert.doesNotMatch(format('| 工单 | 数量 |\n| --- |\n| A | 1 |', 'https://report.example'), /<table>/);
});

test('restores latest history with server-provided messages and only sends conversation id plus the new message', async () => {
  const page = await launch({ conversations: [{ id: 'first', title: '旧问题', updatedAt: '2026-10-20' }, { id: 'latest', title: '最近问题', updatedAt: '2026-10-22' }], handler: (path) => path.endsWith('/chat') ? ndjson([{ type: 'start', conversationId: 'latest', messageId: 'reply' }, { type: 'delta', text: '新回答' }, { type: 'done', status: 'complete' }]) : json({ id: 'latest', messages: [{ id: 'prior', role: 'assistant', content: '历史内容', status: 'complete' }, { role: 'system', content: '不应显示' }] }) });
  await flush();
  assert.ok(page.calls.some((call) => call.path.endsWith('/conversations/latest')));
  assert.match(page.root.querySelector('.agent-messages').innerHTML, /历史内容/);
  assert.doesNotMatch(page.root.querySelector('.agent-messages').innerHTML, /不应显示/);
  page.input('只看 8 楼');
  await page.agent.submit();
  const call = page.calls.find((call) => call.path.endsWith('/chat'));
  assert.deepEqual(JSON.parse(call.options.body), { conversationId: 'latest', message: '只看 8 楼' });
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers['x-admin-key'], undefined);
});

test('streamed model text and source titles cannot inject markup, and warnings stay visible', async () => {
  const page = await launch({ handler: () => ndjson([
    { type: 'start', conversationId: 'one', messageId: 'reply' },
    { type: 'tool', toolName: 'getWorkOrderProgress', status: 'running' },
    { type: 'source', source: { title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', scope: '当前 3 张工单', queriedAt: '2026-10-22T01:00:00Z', completeness: 'partial', warnings: ['部分工序暂不可用'] } },
    { type: 'delta', text: '<script>alert(1)</script> 数量待确认' },
    { type: 'tool', toolName: 'getWorkOrderProgress', status: 'complete' },
    { type: 'done', status: 'complete' }
  ]) });
  page.input('查进度'); await page.agent.submit();
  const html = page.root.querySelector('.agent-messages').innerHTML;
  assert.doesNotMatch(html, /<script>|<img |href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /部分工序暂不可用/);
  assert.match(html, /仅取得部分数据/);
  assert.match(page.root.querySelector('.agent-tools').innerHTML, /读取工单进度完成/);
});

test('stop cancels a pending stream and retains partial text as interrupted', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'start', conversationId: 'partial', messageId: 'reply' })}\n${JSON.stringify({ type: 'delta', text: '已查询到部分工单' })}\n`)); }, cancel() { cancelled = true; } });
  const page = await launch({ handler: () => new Response(stream) });
  page.input('查进度'); const pending = page.agent.submit(); await flush();
  page.root.listeners.get('click')({ target: { closest: () => ({ dataset: { agentAction: 'stop' } }) } });
  await pending;
  assert.equal(cancelled, true);
  assert.match(page.root.querySelector('.agent-messages').innerHTML, /已查询到部分工单/);
  assert.match(page.root.querySelector('.agent-messages').innerHTML, /回答已中断/);
  assert.equal(page.root.querySelector('.agent-stop').hidden, true);
});

test('unconfigured and demo pages never submit or manufacture answers', async () => {
  const page = await launch({ status: { enabled: true, configured: false, reason: '工作助手尚未配置完成' } });
  page.input('查进度'); await page.agent.submit();
  assert.equal(page.calls.some((call) => call.path.endsWith('/chat')), false);
  assert.match(page.root.querySelector('.agent-notice').textContent, /尚未配置完成/);
  const demo = await launch({ demo: true });
  assert.equal(demo.calls.length, 0);
  assert.equal(demo.root.querySelector('#agent-message-input').disabled, true);
});

test('401 reuses existing login recovery, while ordinary service errors do not', async () => {
  const loggedOut = await launch({ status: json({ error: '登录过期' }, 401) });
  assert.equal(loggedOut.unauthorized(), 1);
  const unavailable = await launch({ status: json({ error: '服务暂不可用' }, 503) });
  assert.equal(unavailable.unauthorized(), 0);
  assert.match(unavailable.root.querySelector('.agent-error').textContent, /服务暂不可用/);
});

test('late history responses do not replace a more recently selected conversation', async () => {
  let finishOld;
  const page = await launch({ handler: (path) => path.endsWith('/old') ? new Promise((resolve) => { finishOld = resolve; }) : json({ id: 'new', messages: [{ role: 'assistant', content: '最新会话', status: 'complete' }] }) });
  const oldRequest = page.agent.loadConversation('old');
  await page.agent.loadConversation('new');
  finishOld(json({ id: 'old', messages: [{ role: 'assistant', content: '过期会话', status: 'complete' }] }));
  await oldRequest;
  assert.match(page.root.querySelector('.agent-messages').innerHTML, /最新会话/);
  assert.doesNotMatch(page.root.querySelector('.agent-messages').innerHTML, /过期会话/);
});

test('IME Enter and Shift Enter do not send, ordinary Enter sends once', async () => {
  const page = await launch({ handler: () => ndjson([{ type: 'start', conversationId: 'one', messageId: 'reply' }, { type: 'done', status: 'complete' }]) });
  page.input('工单');
  const keydown = page.root.listeners.get('keydown');
  for (const options of [{ isComposing: true }, { shiftKey: true }, { keyCode: 229 }]) keydown({ key: 'Enter', target: { id: 'agent-message-input' }, preventDefault() {}, ...options });
  assert.equal(page.calls.filter((call) => call.path.endsWith('/chat')).length, 0);
  keydown({ key: 'Enter', target: { id: 'agent-message-input' }, preventDefault() {} });
  await flush();
  assert.equal(page.calls.filter((call) => call.path.endsWith('/chat')).length, 1);
});

test('leaving and remounting the home keeps the unsent draft without loading a second session', async () => {
  const page = await launch();
  page.input('尚未发送的问题');
  const nextRoot = fakeRoot();
  page.agent.mount(nextRoot);
  await flush();
  assert.equal(nextRoot.querySelector('#agent-message-input').value, '尚未发送的问题');
  assert.equal(page.calls.filter((call) => call.path.endsWith('/status')).length, 1);
  page.agent.newConversation();
  assert.equal(nextRoot.querySelector('#agent-message-input').value, '');
});

test('server error termination remains visibly incomplete instead of becoming a complete answer', async () => {
  const page = await launch({ handler: () => ndjson([{ type: 'start', conversationId: 'one', messageId: 'reply' }, { type: 'delta', text: '已收到部分数据' }, { type: 'done', status: 'error' }]) });
  page.input('查进度'); await page.agent.submit();
  assert.match(page.root.querySelector('.agent-messages').innerHTML, /这次回答未完成/);
});

test('a failed tool call is displayed as unavailable, not a successful query', async () => {
  const page = await launch({ handler: () => ndjson([
    { type: 'start', conversationId: 'one', messageId: 'reply' },
    { type: 'tool', toolName: 'getProductionSnapshot', toolCallId: 'tool-one', status: 'running' },
    { type: 'tool', toolName: 'getProductionSnapshot', toolCallId: 'tool-one', status: 'complete', failed: true },
    { type: 'done', status: 'complete' }
  ]) });
  page.input('查现场'); await page.agent.submit();
  assert.match(page.root.querySelector('.agent-tools').innerHTML, /查看生产现场未取得结果/);
  assert.doesNotMatch(page.root.querySelector('.agent-tools').innerHTML, /查看生产现场完成/);
});

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
async function launchWorkspace(search = '') {
  const nodes = new Map(), calls = [];
  let mountCount = 0, finishSession, finishAssignments;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', dataset: {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    URLSearchParams, structuredClone, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { activeElement: null, hidden: false, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { search, protocol: 'https:', origin: 'https://report.example', assign() {} }, addEventListener() {}, BlacklakeAgent: { create: () => ({ mount(container) { mountCount++; container.dataset.mounted = 'true'; } }) } },
    fetch: (path) => {
      calls.push(path);
      if (path.startsWith('/v1/admin/audit')) return Promise.resolve(json({ events: [], total: 0, facets: {} }));
      return new Promise((resolve) => { if (path === '/api/me') finishSession = resolve; else finishAssignments = resolve; });
    }
  });
  vm.runInContext(appSource.replace('  // Start the workspace after installing handlers.', '  globalThis.qa = { render };\n  // Start the workspace after installing handlers.'), context);
  assert.equal(mountCount, 0, 'conversation must not initialize before authentication');
  finishSession(json({ user: { name: '验收账号' } }));
  await flush();
  const beforeAssignments = mountCount;
  finishAssignments(json({ assignments: [], workOrders: [] }));
  await flush();
  return { context, node, calls, beforeAssignments, mountCount: () => mountCount };
}

test('home mounts after identity verification before ledger loading, and refresh preserves its mounted input', async () => {
  const page = await launchWorkspace();
  assert.equal(page.beforeAssignments, 1);
  page.context.qa.render(); page.context.qa.render();
  assert.equal(page.mountCount(), 1);
  assert.match(page.node('#app').innerHTML, /id="agent-home"/);
  assert.equal(page.calls.filter((path) => path === '/api/me').length, 1);
});

test('report and production deep links preserve the requested workspace', async () => {
  const report = await launchWorkspace('?view=report');
  assert.equal(report.mountCount(), 0);
  assert.match(report.node('#app').innerHTML, /reporting-workspace/);
  const production = await launchWorkspace('?view=production');
  assert.equal(production.mountCount(), 0);
  assert.match(production.node('#app').innerHTML, /id="production-3d-frame"/);
  const audit = await launchWorkspace('?view=audit');
  assert.equal(audit.mountCount(), 0);
  assert.match(audit.node('#app').innerHTML, /audit-module/);
  assert.ok(audit.calls.some((path) => path.startsWith('/v1/admin/audit')));
});
