import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function recentPage(request) {
  let page;
  let stopped = 0;
  vm.runInNewContext(readFileSync(new URL("../pages/recent/recent.js", import.meta.url), "utf8"), {
    Page(definition) { page = definition; },
    require: () => ({ request }),
    wx: { showToast() {}, stopPullDownRefresh() { stopped += 1; } }
  });
  page.setData = (values) => Object.assign(page.data, values);
  return { page, stopped: () => stopped };
}

test("最近任务首次加载失败保留错误及重试，不能显示真实空态", async () => {
  const { page } = recentPage(async () => { throw new Error("网络连接失败，请检查网络后再试。"); });
  await page.loadAssignments();
  const markup = readFileSync(new URL("../pages/recent/recent.wxml", import.meta.url), "utf8");
  const emptyCondition = markup.match(/wx:if="\{\{([^}]+)\}\}">\s*<view class="status-empty">还没有/)[1];
  assert.equal(vm.runInNewContext(emptyCondition, { ...page.data }), false, "请求失败不能渲染无记录提示");
  assert.equal(page.data.loading, false);
  assert.equal(page.data.loaded, false);
  assert.match(page.data.loadError, /网络连接失败/);
  assert.equal(page.data.assignments.length, 0);
  assert.match(markup, /wx:if="\{\{loadError\}\}"/);
  assert.match(markup, /bindtap="loadAssignments"/);
  assert.match(markup, /wx:if="\{\{loaded && !loading && !loadError && assignments.length === 0\}\}"/);
});

test("重试期间显示加载状态，成功返回空数组后才显示确实无记录", async () => {
  let finish;
  let calls = 0;
  const { page } = recentPage(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("暂时断网"));
    return new Promise((resolve) => { finish = resolve; });
  });
  await page.loadAssignments();
  const retry = page.loadAssignments();
  assert.equal(page.data.loading, true);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.loaded, false);
  finish({ assignments: [] });
  await retry;
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.assignments.length, 0);
});

test("已有任务刷新失败时保留记录并持续说明刷新失败，下拉结束", async () => {
  let calls = 0;
  const { page, stopped } = recentPage(async () => {
    calls += 1;
    if (calls > 1) throw new Error("刷新断网");
    return { assignments: [{ id: "completed-1", status: "COMPLETED", durationSeconds: 3720 }] };
  });
  await page.loadAssignments();
  await page.onPullDownRefresh();
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.assignments[0].id, "completed-1");
  assert.equal(page.data.assignments[0].statusText, "已完成");
  assert.equal(page.data.assignments[0].durationText, "1小时2分钟");
  assert.match(page.data.loadError, /刷新断网/);
  assert.equal(stopped(), 1);
});

test("迟到的旧成功或失败响应不覆盖新的最近任务结果", async () => {
  for (const staleFailure of [false, true]) {
    const pending = [];
    const { page } = recentPage(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    const first = page.loadAssignments();
    const second = page.loadAssignments();
    pending[1].resolve({ assignments: [{ id: "new", status: "NEEDS_REVIEW" }] });
    await second;
    if (staleFailure) pending[0].reject(new Error("过期错误"));
    else pending[0].resolve({ assignments: [{ id: "old", status: "COMPLETED" }] });
    await first;
    assert.equal(page.data.assignments[0].id, "new");
    assert.equal(page.data.assignments[0].statusText, "等待核对");
    assert.equal(page.data.loadError, "");
    assert.equal(page.data.loading, false);
  }
});

test("旧请求先结束不能提前隐藏当前请求的加载提示", async () => {
  const pending = [];
  const { page } = recentPage(() => new Promise((resolve) => { pending.push(resolve); }));
  const first = page.loadAssignments();
  const second = page.loadAssignments();
  pending[0]({ assignments: [] });
  await first;
  assert.equal(page.data.loading, true);
  pending[1]({ assignments: [] });
  await second;
  assert.equal(page.data.loading, false);
});

test("退出最近任务页后不再用请求响应更新已卸载页面", async () => {
  let finish;
  const { page } = recentPage(() => new Promise((resolve) => { finish = resolve; }));
  const loading = page.loadAssignments();
  page.onUnload();
  let updates = 0;
  page.setData = () => { updates += 1; };
  finish({ assignments: [] });
  await loading;
  assert.equal(updates, 0);
});
