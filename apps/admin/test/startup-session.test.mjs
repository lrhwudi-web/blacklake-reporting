import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const response = (status, payload = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function launch({ me = () => response(200, { user: { name: '验收账号' } }), assignments = () => response(200, { assignments: [], workOrders: [] }), search = '' } = {}) {
  const nodes = new Map(), calls = [], redirects = [], shown = [];
  const initialClass = html.match(/id="auth-dialog" class="([^"]*)"/)?.[1] || '';
  const node = (selector) => {
    if (!nodes.has(selector)) {
      const classes = new Set(selector === '#auth-dialog' ? initialClass.split(' ') : []);
      const listeners = new Map();
      nodes.set(selector, {
        innerHTML: '', textContent: '', listeners, addEventListener(type, listener) { listeners.set(type, listener); },
        setAttribute() {},
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); if (selector === '#auth-dialog' && name === 'hidden') shown.push(true); },
          contains: (name) => classes.has(name)
        }
      });
    }
    return nodes.get(selector);
  };
  const context = vm.createContext({
    URLSearchParams, structuredClone, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { activeElement: null, hidden: false, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { search, protocol: 'https:', origin: 'https://report.example', assign(url) { redirects.push(url); } }, addEventListener() {} },
    fetch: async (url) => { calls.push(url); return url === '/api/me' ? me() : assignments(); }
  });
  vm.runInContext(source, context);
  return { node, calls, redirects, shown };
}

test('刷新初始HTML不会先闪出钉钉登录遮罩', () => {
  assert.match(html, /id="auth-dialog" class="[^"]*\bhidden\b/);
});

test('已有会话先静默验证，工单慢加载期间也不显示登录遮罩', async () => {
  let finishSession, finishAssignments;
  const page = launch({ me: () => new Promise(resolve => { finishSession = resolve; }), assignments: () => new Promise(resolve => { finishAssignments = resolve; }) });
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), true);
  finishSession(response(200, { user: { name: '验收账号' } }));
  await settle();
  assert.deepEqual(page.calls, ['/api/me', '/v1/admin/assignments']);
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), true);
  assert.equal(page.shown.length, 0);
  finishAssignments(response(200, { assignments: [], workOrders: [] }));
  await settle();
  assert.equal(page.shown.length, 0);
  assert.deepEqual(page.redirects, []);
});

test('连续刷新五次复用现有会话，不跳转钉钉授权', async () => {
  for (let i = 0; i < 5; i++) {
    const page = launch();
    await settle();
    assert.equal(page.node('#auth-dialog').classList.contains('hidden'), true);
    assert.equal(page.shown.length, 0);
    assert.deepEqual(page.redirects, []);
    assert.equal(page.calls.filter(path => path === '/api/me').length, 1);
  }
});

test('会话确实失效才显示登录并跳转，未认证前不读取工单', async () => {
  const page = launch({ me: () => response(401) });
  await settle();
  assert.deepEqual(page.redirects, ['/api/auth/dingtalk/start']);
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), false);
  assert.deepEqual(page.calls, ['/api/me']);
});

test('工单读取失败显示数据重试提示，不把有效会话误判为登录失败', async () => {
  const page = launch({ assignments: () => response(503, { error: '工单暂不可用' }) });
  await settle();
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), true);
  assert.equal(page.shown.length, 0);
  assert.match(page.node('#app').innerHTML, /刷新失败/);
  assert.deepEqual(page.redirects, []);
});

test('工单接口返回401时仍按实际会话失效处理', async () => {
  const page = launch({ assignments: () => response(401) });
  await settle();
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), false);
  assert.deepEqual(page.redirects, ['/api/auth/dingtalk/start']);
});

test('会话服务临时失败可重试验证，恢复后不强制重做钉钉授权', async () => {
  let attempts = 0;
  const page = launch({ me: () => ++attempts === 1 ? response(503) : response(200, { user: { name: '验收账号' } }) });
  await settle();
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), false);
  assert.match(page.node('.login-progress h2').textContent, /暂时/);
  assert.deepEqual(page.redirects, []);
  await page.node('#auth-retry').listeners.get('click')();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), true);
  assert.deepEqual(page.redirects, []);
});

test('钉钉回调失败仍提供明确错误及可用重试入口', () => {
  const page = launch({ search: '?auth_error=1' });
  assert.equal(page.node('#auth-dialog').classList.contains('hidden'), false);
  assert.match(page.node('#auth-message').textContent, /登录未完成/);
});
