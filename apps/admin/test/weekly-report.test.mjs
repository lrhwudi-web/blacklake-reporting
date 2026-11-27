import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../weekly-report.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function library() {
  const window = { location: { origin: 'https://report.example' } };
  vm.runInNewContext(source, { window, URL, AbortController, Date });
  return window.BlacklakeInsights;
}
function fakeRoot() {
  const nodes = new Map(), listeners = new Map(), counts = new Map();
  return {
    dataset: {}, innerHTML: '', scrollTop: 0, listeners, counts,
    addEventListener(name, handler) { listeners.set(name, handler); counts.set(name, (counts.get(name) || 0) + 1); },
    querySelectorAll() { return []; },
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, { disabled: true }); return nodes.get(selector); }
  };
}
function report(id = 'report-a') {
  const value = structuredClone(library().demoReport());
  value.id = id; value.snapshot.mode = 'fixture'; value.snapshot.findings[0].key = 'over-plan:1:2';
  value.snapshot.findings[0].reason = 'PLAN_OUTDATED'; value.snapshot.findings[0].note = '已核对计划版本';
  value.snapshot.summary = ['程序确认第一句。', '程序确认第二句。', '程序确认第三句。'];
  return value;
}
async function launch({ current = report(), handler, aiAvailable = true, demo = false } = {}) {
  const root = fakeRoot(), calls = [], lib = library(); let unauthorized = 0;
  const controller = lib.create({ onUnauthorized() { unauthorized++; }, fetchImpl: async (path, options) => {
    calls.push({ path, options });
    const custom = await handler?.(path, options);
    if (custom) return custom;
    if (path === '/v1/admin/weekly-reports') return json({ reports: current ? [current] : [], aiAvailable });
    if (path.startsWith('/v1/admin/weekly-reports/')) return json({ report: current, aiAvailable });
    if (path.startsWith('/v1/admin/production-findings?')) return json({ findings: current?.snapshot.findings || [], aiAvailable });
    throw new Error(`Unexpected request: ${path}`);
  } });
  await controller.mount(root, { demo });
  return { lib, root, controller, calls, unauthorized: () => unauthorized };
}
const input = (root, field, value, key) => root.listeners.get('input')({ target: { dataset: key ? { findingField: field, key } : { weeklyField: field }, value } });
const change = (root, field, value, key) => root.listeners.get('change')({ target: { dataset: key ? { findingField: field, key } : { weeklyField: field }, value } });

test('evidence and analysis escape untrusted text, reject unsafe destinations and preserve source quantities', () => {
  const lib = library();
  const html = lib.evidenceHtml([{ source: '<script>bad</script>', url: 'javascript:alert(1)', recordId: '<img>', createdAt: '2026-10-12T01:00:00Z', totalQuantity: null, goodQuantity: 0, defectQuantity: 0, productionStaff: '<svg>', personIdentityBasis: '姓名不等于唯一身份', complete: false }, { source: '来源', url: '/admin?view=report', assignmentId: 'source-id' }]);
  assert.doesNotMatch(html, /<script>|<img>|<svg>|href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /报工总数<\/dt><dd>未知/);
  assert.match(html, /良品数量<\/dt><dd>0/);
  assert.match(html, /2026-10-12T01:00:00Z/);
  assert.match(html, /姓名不等于唯一身份/);
  assert.match(html, /部分数据，范围不完整/);
  assert.match(html, /打开台账（需按此 ID 核对）/);
  for (const url of ['https://outside.example/admin', '//outside.example/admin', '/api/auth/logout', '/admin/../private']) assert.doesNotMatch(lib.evidenceHtml([{ url }]), /href=/);
  const finding = report().snapshot.findings[0];
  const findingHtml = lib.findingHtml(finding, { analysis: { mode: 'AI_DRAFT', facts: ['<img onerror=x>'], possibleCauses: ['<script>'], warning: '<svg>', revision: 0 }, draft: { status: 'NEW', reason: 'OTHER', note: '</textarea><script>' } }, true);
  assert.doesNotMatch(findingHtml, /<img|<script|<svg/);
  assert.match(findingHtml, /AI 辅助分析/);
});

test('summary uses only open risks while the detail section retains every case and deterministic draft summary', async () => {
  const current = report(); current.managementNote = '';
  current.snapshot.findings = Array.from({ length: 6 }, (_, index) => ({ ...current.snapshot.findings[0], key: `case-${index}`, title: `事项${index}`, status: index === 0 ? 'CONFIRMED_NORMAL' : index === 1 ? 'RESOLVED' : 'NEW' }));
  const summary = library().summaryHtml(current);
  assert.doesNotMatch(summary, /事项0|事项1|事项5/);
  assert.match(summary, /事项2/); assert.match(summary, /事项4/);
  assert.match(summary, /程序确认第一句。 程序确认第二句。 程序确认第三句。/);
  current.snapshot.risks = [current.snapshot.findings[4]];
  assert.doesNotMatch(library().summaryHtml(current), /事项2/);
  const page = await launch({ current });
  assert.equal((page.root.innerHTML.match(/class="pi-finding"/g) || []).length, 6);
  assert.match(page.root.innerHTML, /事项0/);
});

test('group and pagination evidence show total versus sampled records and explicit duplicate coverage', () => {
  const html = library().evidenceHtml([
    { evidenceType: 'group_summary', recordCount: 8, sampleCount: 5, sampleTruncated: true, membersDigest: 'internal-digest' },
    { evidenceType: 'pagination_summary', duplicateCount: 3, conflictingIdCount: 0, repeatedPage: true, membersDigest: 'other-internal-digest' }
  ]);
  assert.match(html, /组内总条数<\/dt><dd>8/);
  assert.match(html, /展示样本条数<\/dt><dd>5/);
  assert.match(html, /是，仅展示部分样本/);
  assert.match(html, /分页重复条数<\/dt><dd>3/);
  assert.match(html, /同 ID 内容冲突<\/dt><dd>0/);
  assert.match(html, /是，分页完整性受影响/);
  assert.doesNotMatch(html, /internal-digest/);
  const complete = library().evidenceHtml([{ evidenceType: 'group_summary', recordCount: 2, sampleCount: 2, sampleTruncated: false }, { evidenceType: 'pagination_summary', duplicateCount: null, conflictingIdCount: null, repeatedPage: false }]);
  assert.match(complete, /否，已展示全部样本/);
  assert.match(complete, /分页重复条数<\/dt><dd>未知/);
  assert.match(complete, /是否出现重复页<\/dt><dd>否/);
});

test('carried-forward case provenance survives latest finding and feedback responses without snapshot metadata', async () => {
  const current = report(), key = current.snapshot.findings[0].key;
  const observedAt = '2026-10-10T02:00:00Z';
  const historical = { ...current.snapshot.findings[0], carriedForward: true, observationNote: '历史核查事项；本轮未重新取得对应业务证据，事实仍以最近观测时间为准。', observedAt };
  current.snapshot.findings = [historical]; current.snapshot.risks = [historical];
  const latest = { ...report().snapshot.findings[0], revision: 2, observedAt, facts: ['最近保存的证据'] };
  const page = await launch({ current, handler: (path, options) => {
    if (path.startsWith('/v1/admin/production-findings?')) return json({ findings: [latest] });
    if (path.endsWith('/feedback')) return json({ finding: { ...latest, ...JSON.parse(options.body), revision: 3 } });
  } });
  assert.match(page.root.innerHTML, /历史待复查 · /);
  assert.match(page.root.innerHTML, /本轮未重新取得对应业务证据/);
  assert.match(page.root.innerHTML, /最近观测：/);
  assert.ok(page.root.innerHTML.includes(new Date(observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })));
  assert.match(page.root.innerHTML, /最近保存的证据/);
  input(page.root, 'note', '本次人工核查说明', key);
  await page.controller.findingAction('feedback', key);
  assert.match(page.root.innerHTML, /本轮未重新取得对应业务证据/);
  assert.match(page.root.innerHTML, /本次人工核查说明/);
});

test('quantities stay grouped, unavailable comparisons remain unavailable, and all task progress is expandable', () => {
  const snapshot = report().snapshot;
  snapshot.metrics = { current: { groups: [{ productName: '产品甲', processName: '裁剪', unit: '件', recordCount: 2, totalQuantity: 17, goodQuantity: null, defectQuantity: 0 }, { productName: '产品乙', processName: '缝制', unit: '米', recordCount: 1, totalQuantity: 29, goodQuantity: 29, defectQuantity: 0 }] }, comparison: { groups: [{ productName: '甲', processName: '裁剪', unit: '件', currentGoodQuantity: null, previousGoodQuantity: 0, comparable: false, percentChange: null, note: '缺少可靠数量' }] } };
  snapshot.progress = Array.from({ length: 7 }, (_, index) => ({ projectCode: `WORK-${index}`, taskId: index + 1, plannedAmount: 10, reportedGoodAmount: 12, closed: false }));
  const html = library().dataDetailsHtml(snapshot);
  assert.match(html, /产品甲/); assert.match(html, /产品乙/);
  assert.match(html, /<td>17<\/td><td>未知<\/td><td>0<\/td>/);
  assert.doesNotMatch(html, /<td>46<\/td>/);
  assert.match(html, /不可比/); assert.match(html, /WORK-6/);
  assert.match(html, /未关闭/); assert.doesNotMatch(html, /已关闭/);
});

test('numeric draft generation works without AI and never triggers analysis or sending', async () => {
  const generated = report(); generated.managementNote = '';
  const page = await launch({ current: null, aiAvailable: false, handler: (path, options) => options.method === 'POST' ? json({ report: generated }) : undefined });
  await page.controller.reportAction('generate');
  assert.match(page.root.innerHTML, /程序确认第一句/);
  assert.match(page.root.innerHTML, /仍可生成数字草稿、填写备注并审阅/);
  const writes = page.calls.filter(({ options }) => options.method);
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/v1/admin/weekly-reports');
  assert.deepEqual(JSON.parse(writes[0].options.body), {});
  await page.controller.reportAction('analyze');
  assert.equal(page.calls.filter(({ options }) => options.method).length, 1);
  input(page.root, 'startDate', '2026-10-13');
  await page.controller.reportAction('generate');
  assert.match(page.root.innerHTML, /请选择周一/);
  assert.equal(page.calls.filter(({ options }) => options.method).length, 1);
});

test('manual edits are saved before review, revisions are exact and input events preserve the active DOM', async () => {
  let current = report();
  const page = await launch({ current, handler: (path, options) => {
    if (options.method === 'PATCH') { const body = JSON.parse(options.body); current = { ...current, ...body, revision: current.revision + 1 }; return json({ report: current }); }
    if (path.endsWith('/review')) { current = { ...current, status: 'REVIEWED', revision: current.revision + 1 }; return json({ report: current }); }
  } });
  const original = page.root.innerHTML;
  input(page.root, 'managementNote', '核对后确认的管理备注');
  input(page.root, 'coordination', '暂无');
  assert.equal(page.root.innerHTML, original);
  assert.equal(page.root.querySelector('[data-insight-action="save"]').disabled, false);
  await page.controller.reportAction('review');
  await page.controller.reportAction('analyze');
  assert.equal(page.calls.filter(({ options }) => options.method).length, 0);
  await page.controller.reportAction('save');
  const patch = page.calls.find(({ options }) => options.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), { revision: 1, managementNote: '核对后确认的管理备注', coordination: '暂无' });
  assert.equal(patch.options.credentials, 'same-origin');
  await page.controller.reportAction('review');
  const review = page.calls.find(({ path }) => path.endsWith('/review'));
  assert.deepEqual(JSON.parse(review.options.body), { revision: 2 });
  assert.match(page.root.innerHTML, /此版本已标记为已审阅，未发送/);
});

test('report conflicts preserve draft inputs through list refresh and navigation; frozen evidence requires a new draft', async () => {
  let code = 'WEEKLY_REVISION_CONFLICT';
  const page = await launch({ handler: (path, options) => options.method ? json({ error: { code, message: '冲突' } }, 409) : undefined });
  input(page.root, 'managementNote', '未提交人工内容');
  await page.controller.reportAction('save');
  assert.match(page.root.innerHTML, /未提交人工内容/);
  assert.match(page.root.innerHTML, /服务端版本已更新/);
  await page.controller.mount(null);
  const newRoot = fakeRoot(); await page.controller.mount(newRoot);
  await page.controller.refreshList();
  assert.match(newRoot.innerHTML, /未提交人工内容/);
  await page.controller.loadReport('report-a', { discardDraft: true });
  code = 'WEEKLY_EVIDENCE_CHANGED';
  await page.controller.reportAction('review');
  assert.match(newRoot.innerHTML, /请生成新的周报草稿后再审阅/);
});

test('saved feedback initializes controls and select changes persist to the shared case used in the drawer', async () => {
  const current = report(), original = current.snapshot.findings[0], key = original.key;
  const page = await launch({ current, handler: (path, options) => {
    if (path.endsWith('/inspect')) return json({ findings: [original], aiAvailable: true, warnings: [], scope: '当前工序' });
    if (path.endsWith('/feedback')) return json({ finding: { ...original, ...JSON.parse(options.body), revision: 2 } });
  } });
  assert.match(page.root.innerHTML, /value="PLAN_OUTDATED" selected/);
  assert.match(page.root.innerHTML, /已核对计划版本<\/textarea>/);
  change(page.root, 'status', 'CONFIRMED_NORMAL', key);
  change(page.root, 'reason', 'NORMAL_OVERPRODUCTION', key);
  input(page.root, 'note', '已对照原始记录，确认为正常超产', key);
  await page.controller.findingAction('feedback', key);
  const write = page.calls.find(({ path }) => path.endsWith('/feedback'));
  assert.deepEqual(JSON.parse(write.options.body), { revision: 1, status: 'CONFIRMED_NORMAL', reason: 'NORMAL_OVERPRODUCTION', note: '已对照原始记录，确认为正常超产' });
  const drawer = fakeRoot(); page.controller.mountInspector(drawer, { assignmentId: 'local-a' });
  await page.controller.inspect();
  assert.match(drawer.innerHTML, /已确认正常/);
  assert.match(drawer.innerHTML, /确认为正常超产/);
  assert.equal(page.calls.filter(({ path }) => path.endsWith('/analyze')).length, 0);
});

test('a case conflict can reload the latest evidence while keeping user input for a deliberate retry', async () => {
  const current = report(), finding = current.snapshot.findings[0], key = finding.key; let attempts = 0;
  const page = await launch({ current, handler: (path, options) => {
    if (path.endsWith('/feedback')) return ++attempts === 1 ? json({ error: { message: '版本已变化' } }, 409) : json({ finding: { ...finding, ...JSON.parse(options.body), revision: 4 } });
    if (path.endsWith(encodeURIComponent(key))) return json({ finding: { ...finding, revision: 3, facts: ['新证据'] } });
  } });
  input(page.root, 'note', '人工说明保留', key);
  await page.controller.findingAction('feedback', key);
  assert.match(page.root.innerHTML, /读取最新案例并保留输入/);
  await page.controller.findingAction('reload-finding', key);
  assert.match(page.root.innerHTML, /新证据/); assert.match(page.root.innerHTML, /人工说明保留/);
  await page.controller.findingAction('feedback', key);
  assert.equal(JSON.parse(page.calls.filter(({ path }) => path.endsWith('/feedback')).at(-1).options.body).revision, 3);
});

test('inspection uses its availability and coverage directly, and an empty partial result never means normal', async () => {
  const calls = [], drawer = fakeRoot();
  const controller = library().create({ fetchImpl: async (path) => { calls.push(path); return json({ findings: [], aiAvailable: false, scope: '关联工序快照', warnings: ['上游读取失败，数据不完整'] }); } });
  controller.mountInspector(drawer, { taskId: 20, projectCode: 'WORK-A' });
  assert.equal(calls.length, 0);
  await controller.inspect();
  assert.deepEqual(calls, ['/v1/admin/production-findings/inspect']);
  assert.match(drawer.innerHTML, /关联工序快照/); assert.match(drawer.innerHTML, /上游读取失败/);
  assert.match(drawer.innerHTML, /不代表已经确认正常/);
});

test('changed evidence clearly separates prior feedback from the reopened case and retains escaped history', () => {
  const finding = { ...report().snapshot.findings[0], status: 'INVESTIGATING', evidenceChanged: true, revision: 3, events: [{ action: 'FEEDBACK', revision: 2, createdAt: '2026-10-22T00:00:00Z', detail: { status: 'CONFIRMED_NORMAL', reason: 'NORMAL_OVERPRODUCTION', note: '<script>历史反馈</script>' } }, { action: 'EVIDENCE_CHANGED', revision: 3, detail: { status: 'INVESTIGATING' } }] };
  const html = library().findingHtml(finding);
  assert.match(html, /此前反馈，不能代替对新证据的确认/);
  assert.match(html, /核查记录 · 2 次/);
  assert.match(html, /来源证据变化/);
  assert.match(html, /&lt;script&gt;历史反馈/);
  assert.doesNotMatch(html, /<script>/);
  const truncated = library().findingHtml({ ...finding, eventsTotal: 70, eventsTruncated: true });
  assert.match(truncated, /核查记录 · 70 次/);
  assert.match(truncated, /仅展示最近 50 条，完整记录已保存/);
});

test('switching records aborts stale inspection and prevents old evidence appearing under a new record', async () => {
  const pending = [];
  const controller = library().create({ fetchImpl: (path, options) => new Promise((resolve) => pending.push({ resolve, options })) });
  const first = fakeRoot(), second = fakeRoot();
  controller.mountInspector(first, { assignmentId: 'record-a' });
  const a = controller.inspect();
  controller.mountInspector(second, { assignmentId: 'record-b' });
  assert.equal(pending[0].options.signal.aborted, true);
  const b = controller.inspect();
  const original = report().snapshot.findings[0];
  pending[1].resolve(json({ findings: [{ ...original, key: 'b', title: '当前记录证据' }], aiAvailable: true })); await b;
  pending[0].resolve(json({ findings: [{ ...original, key: 'a', title: '过期记录证据' }], aiAvailable: true })); await a;
  assert.match(second.innerHTML, /当前记录证据/); assert.doesNotMatch(second.innerHTML, /过期记录证据/);
  controller.mountInspector(null);
});

test('stale report responses cannot replace a later selection and remounting does not duplicate handlers', async () => {
  const pending = new Map();
  const page = await launch({ current: null, handler: (path) => path.includes('/weekly-reports/') ? new Promise((resolve) => pending.set(path.split('/').at(-1), resolve)) : undefined });
  const a = page.controller.loadReport('report-a'); const b = page.controller.loadReport('report-b');
  pending.get('report-b')(json({ report: { ...report('report-b'), managementNote: '后选周报' }, aiAvailable: true })); await b;
  pending.get('report-a')(json({ report: { ...report('report-a'), managementNote: '先选周报' }, aiAvailable: true })); await a;
  assert.match(page.root.innerHTML, /后选周报/); assert.doesNotMatch(page.root.innerHTML, /先选周报/);
  await page.controller.mount(page.root);
  assert.equal(page.root.counts.get('click'), 1); assert.equal(page.root.counts.get('change'), 1);
});

test('401 uses the existing sign-in handler and demo mode never reads or writes production cases', async () => {
  const page = await launch({ handler: () => json({ error: { message: '需要登录' } }, 401) });
  assert.equal(page.unauthorized(), 1);
  const demo = await launch({ demo: true });
  await demo.controller.reportAction('generate');
  await demo.controller.findingAction('analyze-finding', 'demo:overproduction');
  demo.controller.mountInspector(fakeRoot(), { assignmentId: 'a' }, { demo: true }); await demo.controller.inspect();
  assert.equal(demo.calls.length, 0);
});

function appHarness({ search = '', startup = false } = {}) {
  const nodes = new Map(), listeners = new Map(), mounts = [], calls = [], chats = [];
  const node = (selector) => { if (!nodes.has(selector)) nodes.set(selector, { ...fakeRoot(), tagName: 'DIV', classList: { add() {}, remove() {} }, setAttribute() {} }); return nodes.get(selector); };
  const insights = { mount(root, options) { mounts.push({ root, options }); if (root) root.dataset.mounted = 'true'; }, mountInspector() {}, async refreshList() { calls.push('weekly-refresh'); } };
  const context = vm.createContext({ URLSearchParams, structuredClone, setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, setInterval: () => 1,
    document: { activeElement: null, querySelector: node, querySelectorAll: () => [], addEventListener(name, handler) { listeners.set(name, handler); } },
    window: { location: { search, origin: 'https://report.example', protocol: 'https:', assign() {} }, addEventListener() {}, BlacklakeInsights: { create: () => insights }, BlacklakeAgent: { create: () => ({ mount(root) { root.dataset.mounted = 'true'; chats.push('mount'); } }) } },
    fetch: async (path) => { calls.push(path); return json(path === '/api/me' ? { user: { name: 'fixture' } } : { assignments: [], workOrders: [] }); }
  });
  const code = startup ? appSource : `${appSource.slice(0, appSource.lastIndexOf('  // Start the workspace after installing handlers.'))}globalThis.qa={state,render,openModule};})();`;
  vm.runInContext(code, context);
  return { ...context.qa, nodes, node, mounts, calls, chats, listeners };
}

test('weekly navigation preserves mounted drafts during ledger refresh and leaves the homepage chat mounted', async () => {
  const page = appHarness();
  page.openModule('weekly');
  page.node('#weekly-report').innerHTML = '尚未保存的周报编辑';
  const count = page.mounts.length; page.render();
  assert.equal(page.mounts.length, count);
  assert.equal(page.node('#weekly-report').innerHTML, '尚未保存的周报编辑');
  await page.listeners.get('click')({ target: { closest: () => ({ dataset: { action: 'refresh' } }) } });
  assert.deepEqual(page.calls, ['weekly-refresh']);
  page.openModule('home'); const chatCount = page.chats.length; page.render();
  assert.equal(page.chats.length, chatCount);
  assert.match(page.node('#app').innerHTML, /data-module="weekly"/);
});

test('authenticated weekly deep link passes reportId once and does not open the homepage', async () => {
  const page = appHarness({ search: '?view=weekly&reportId=report-deep-link', startup: true });
  await settle();
  const mounted = page.mounts.filter(({ root }) => root);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].options.reportId, 'report-deep-link');
  assert.match(page.node('#app').innerHTML, /id="weekly-report"/);
  assert.equal(page.chats.length, 0);
});
