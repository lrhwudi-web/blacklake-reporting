import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function workspace() {
  let source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  source = source.slice(0, source.lastIndexOf('  // Start the workspace after installing handlers.'));
  source += 'globalThis.qa = { state, openModule };})();';
  const messages = new Map(), nodes = new Map();
  let frame = null, fetches = 0;
  const context = vm.createContext({
    URLSearchParams, structuredClone, setTimeout, clearTimeout, clearInterval,
    document: {
      activeElement: null, querySelectorAll: () => [], addEventListener() {},
      querySelector(selector) {
        if (selector === '#production-3d-frame') return frame;
        if (!nodes.has(selector)) {
          let html = '';
          nodes.set(selector, {
            addEventListener() {}, classList: { add() {}, remove() {} },
            get innerHTML() { return html; },
            set innerHTML(value) {
              html = value;
              if (selector === '#app') frame = value.includes('id="production-3d-frame"')
                ? { tagName: 'IFRAME', contentWindow: {} } : null;
            }
          });
        }
        return nodes.get(selector);
      }
    },
    window: { location: { search: '', origin: 'https://report.example' }, addEventListener(type, listener) { messages.set(type, listener); } },
    fetch: async () => { fetches++; throw new Error('module navigation must not restart login'); }
  });
  vm.runInContext(source, context);
  return { ...context.qa, messages, nodes, frame: () => frame, fetches: () => fetches };
}

async function scene({ embedded = true, standalone = false, legacyParent = false } = {}) {
  const source = await readFile(new URL('../production-3d/app.js', import.meta.url), 'utf8');
  const messages = [];
  const window = {
    location: { search: embedded ? legacyParent ? '?embedded=1' : '?embedded=1&workspace=1' : '', origin: 'https://report.example' },
    parent: { postMessage(message, origin) { messages.push({ message, origin }); } }
  };
  if (standalone) window.parent = window;
  // Exercise the real click handler, if installed. Without it the existing _top link reloads /admin.
  const handlerSource = source.match(/function returnToReporting\(event\) \{[\s\S]*?\n\}/)?.[0];
  const click = handlerSource ? vm.runInNewContext(`(${handlerSource})`, { window, URLSearchParams }) : () => {};
  const link = { getAttribute: () => '/admin' };
  return {
    messages,
    click(overrides = {}) {
      const event = { button: 0, target: { closest: () => link }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
      click(event);
      return event;
    }
  };
}

test('内嵌3D返回在当前后台切换，连续五次不重启登录且保留工单选择', async () => {
  const parent = await workspace();
  const child = await scene();
  parent.state.currentUser = { name: '已登录管理员' };
  parent.state.search = '验证';
  parent.state.orders = [{ id: 'order-42', code: 'WO-42', product: '验证产品', status: 'IN_PROGRESS', processes: [], records: [], workers: [], anomalies: [] }];
  parent.state.selectedId = 'order-42';
  const account = parent.state.currentUser;
  for (let i = 0; i < 5; i++) {
    parent.openModule('production');
    const frame = parent.frame();
    const click = child.click();
    assert.equal(click.defaultPrevented, true, '当前返回链接会整页重新加载后台并再次显示登录遮罩');
    const sent = child.messages.at(-1);
    assert.equal(sent.origin, 'https://report.example');
    assert.equal(typeof parent.messages.get('message'), 'function');
    parent.messages.get('message')({ origin: sent.origin, source: frame.contentWindow, data: sent.message });
    assert.equal(parent.state.activeModule, 'report');
    assert.equal(parent.frame(), null);
    assert.equal(parent.state.currentUser, account);
    assert.equal(parent.state.selectedId, 'order-42');
    assert.equal(parent.state.search, '验证');
  }
  assert.equal(parent.fetches(), 0);
});

test('返回消息只接受当前3D iframe的同源请求', async () => {
  const parent = await workspace();
  parent.openModule('production');
  const listener = parent.messages.get('message');
  assert.equal(typeof listener, 'function');
  const valid = { origin: 'https://report.example', source: parent.frame().contentWindow, data: { type: 'return-to-reporting' } };
  for (const changed of [{ origin: 'https://other.example' }, { source: {} }, { data: { type: 'unknown' } }]) {
    listener({ ...valid, ...changed });
    assert.equal(parent.state.activeModule, 'production');
  }
  listener(valid);
  assert.equal(parent.state.activeModule, 'report');
  parent.openModule('production');
  listener(valid);
  assert.equal(parent.state.activeModule, 'production', '已卸载iframe的旧消息不能切走当前页面');
});

test('独立3D页及新标签打开操作保留普通返回链接', async () => {
  for (const options of [{ embedded: false }, { standalone: true }]) {
    const child = await scene(options);
    assert.equal(child.click().defaultPrevented, false);
    assert.equal(child.messages.length, 0);
  }
  const child = await scene();
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(child.click(modifiers).defaultPrevented, false);
  }
  assert.equal(child.messages.length, 0);
});

test('发布前已打开的旧后台仍能通过普通链接返回，避免新旧资源混用时失去返回入口', async () => {
  const child = await scene({ legacyParent: true });
  assert.equal(child.click().defaultPrevented, false);
  assert.equal(child.messages.length, 0);
});

test('品牌入口和同步失败说明均接入同一返回交互', async () => {
  const html = await readFile(new URL('../production-3d/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../production-3d/app.js', import.meta.url), 'utf8');
  assert.match(html, /<a\b[^>]*data-return-workspace[^>]*aria-label="返回报工管理"/);
  assert.match(js, /<a\b[^>]*data-return-workspace[^>]*>返回报工管理<\/a>/);
  assert.match(js, /document\.addEventListener\('click', returnToReporting\)/);
});
