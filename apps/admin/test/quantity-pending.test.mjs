import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as sceneData from '../production-3d/data.js';

async function workspace() {
  let source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  source = source.slice(0, source.lastIndexOf('  // Start the workspace after installing handlers.'));
  source += 'globalThis.qa = { state, liveOrders, processTable, recentLedgerRecords, recentLedgerReports, workerTable, recordTable, reviewPanel, recordDrawer, ledgerAttention, exportOrder, analyticsData, syncEmbroideryMachines };})();';
  const nodes = new Map();
  const context = vm.createContext({ URLSearchParams, structuredClone, setTimeout, clearTimeout, clearInterval,
    document: { querySelectorAll: () => [], addEventListener() {}, querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', addEventListener() {}, classList: { add() {}, remove() {} } });
      return nodes.get(selector);
    } }, window: { location: { search: '' }, addEventListener() {} }
  });
  vm.runInContext(source, context);
  return { ...context.qa, context };
}

const pending = { id: 'quantity-pending', projectId: 1, projectCode: 'WO-PENDING', productName: '产品', taskId: 5,
  operatorName: '甲', processName: '车缝', status: 'QUANTITY_PENDING', quantityPending: true, quantityPolicy: 'PENDING_REVIEW',
  quantity: 100, goodQuantity: 100, defectQuantity: 0, source: 'DISPATCHED', durationSeconds: 60,
  endedAt: '2026-10-22T01:00:00Z' };

test('已完工待核量保留台账与生产历时，参考数量不进入实际报工或完成状态', async () => {
  const api = await workspace();
  const order = api.liveOrders([pending], [{ projectId: 1, processes: [{ taskId: 5, processName: '车缝', sequence: 1, plannedAmount: 100, reportedAmount: 0, processStatus: 20 }] }])[0];
  assert.equal(order.status, 'QUANTITY_PENDING');
  assert.equal(order.processes[0].status, 'QUANTITY_PENDING');
  assert.equal(order.processes[0].reported, 0);
  assert.equal(order.workers[0].amount, null);
  assert.equal(order.records[0].amount, null);
  assert.equal(order.records[0].goodQuantity, null);
  assert.equal(order.records[0].defectQuantity, null);
  assert.match(order.records[0].duration, /1 分钟/);
  assert.match(order.records[0].note, /暂未报送黑湖/);
  assert.equal(api.recentLedgerRecords(order).length, 1);
  api.state.drawerRecordId = pending.id;
  for (const html of [api.workerTable(order.workers), api.recordTable(order.records), api.recentLedgerReports(order), api.recordDrawer(order)]) {
    assert.match(html, /待核量/);
    assert.doesNotMatch(html, /100 件|0 件|null 件|— 件|已同步|已完成|data-action="resolve"|data-action="cancel-assignment"/);
  }
  assert.equal(api.reviewPanel(order), '');
  assert.match(api.ledgerAttention(order), /待核量/);
  const analytics = api.analyticsData([order]);
  assert.equal(analytics.count('closed'), 0);
  assert.equal(analytics.count('closing'), 0);
  assert.ok(analytics.insights.some(item => /待核量/.test(item.title)));
});

test('数量口径未确认的待开始和生产中任务保留状态，参考量不冒充报工数', async () => {
  const api = await workspace();
  for (const status of ['READY', 'IN_PROGRESS']) {
    const order = api.liveOrders([{ ...pending, status, quantityPending: false, endedAt: null }])[0];
    assert.equal(order.workers[0].status, status);
    assert.equal(order.records[0].status, status);
    assert.equal(order.records[0].amount, null);
    assert.equal(order.records[0].goodQuantity, null);
    assert.equal(order.records[0].defectQuantity, null);
    assert.match(api.recordTable(order.records), /待核量/);
    assert.doesNotMatch(api.recordTable(order.records), /100 件|0 件|null 件|已同步/);
    assert.doesNotMatch(order.records[0].note, /已同步|结束只记工时，暂未/);
  }
});

test('待核量与已确认报工并存时汇总只累加确认数量', async () => {
  const api = await workspace();
  const order = api.liveOrders([pending, { ...pending, id: 'confirmed', status: 'COMPLETED', quantityPending: false, quantityPolicy: null, quantity: 8, goodQuantity: 7, defectQuantity: 1 }])[0];
  api.state.expandedProcesses.add(order.processes[0].id);
  assert.equal(order.processes[0].reported, 7);
  assert.match(api.processTable(order), /本系统已确认：1 笔，良品 7 件/);
  assert.match(api.processTable(order), /<b>待核量<\/b>/);
});

test('人员及报工CSV将待核量导出为明确文本，不输出参考量或零', async () => {
  const api = await workspace();
  api.state.orders = api.liveOrders([pending]);
  api.state.activeModule = 'report';
  let blob;
  api.context.Blob = Blob;
  api.context.URL = { createObjectURL(value) { blob = value; return 'blob:test'; }, revokeObjectURL() {} };
  api.context.document.body = { append() {} };
  api.context.document.createElement = () => ({ click() {}, remove() {} });
  for (const status of ['QUANTITY_PENDING', 'IN_PROGRESS', 'READY']) for (const tab of ['workers', 'records']) {
    api.state.orders = api.liveOrders([{ ...pending, status, quantityPending: status === 'QUANTITY_PENDING' }]);
    api.state.detailTab = tab;
    api.exportOrder();
    const csv = await blob.text();
    assert.match(csv, /待核量/);
    assert.doesNotMatch(csv, /"100"|"0"|已同步|已完成/);
  }
});

test('3D已完工待核量释放工位，同人新任务成为唯一当前活动，旧记录仍可追踪', async () => {
  assert.equal(sceneData.activeStatuses.has('QUANTITY_PENDING'), false);
  const source = await readFile(new URL('../production-3d/app.js', import.meta.url), 'utf8');
  const oldTask = { ...pending, stationName: 'A-01' };
  const nextTask = { ...pending, id: 'next-task', projectId: 2, projectCode: 'WO-NEXT', status: 'IN_PROGRESS', quantityPending: false, endedAt: null, stationName: 'B-01' };
  const snapshot = { floors: { '8': [
    { id: 'A-01', state: 'attention', assignments: [oldTask] },
    { id: 'B-01', state: 'running', assignments: [nextTask] },
    { id: 'A-02', state: 'unknown', assignments: [] }
  ] } };
  const start = source.indexOf('function renderDetail(');
  const end = source.indexOf('\nfunction ', start + 1);
  const unitsStart = source.indexOf('function units()');
  const unitsEnd = source.indexOf('\nfunction ', unitsStart + 1);
  const context = vm.createContext({ ...sceneData, snapshot, details: { mini: () => '' }, floor: '8', loaded: true,
    statusNames: { attention: '待处理', available: '无活动任务', running: '生产中' }, tones: { attention: 'attention', available: 'idle', running: 'running' }, names: { '8': '8楼' },
    fmt: value => String(value), icon: () => '' });
  vm.runInContext(source.slice(unitsStart, unitsEnd) + '\n' + source.slice(start, end) + ';globalThis.renderDetail = renderDetail;globalThis.units = units;', context);
  const units = context.units();
  assert.equal(units[0].state, 'available');
  assert.equal(units[0].assignments.length, 0);
  assert.equal(units[1].state, 'running');
  assert.deepEqual(Array.from(units.flatMap(unit => unit.assignments), item => item.id), ['next-task']);
  assert.equal(units[2].state, 'unknown');
  const reusedUnit = sceneData.currentUnit({ id: 'A-01', state: 'attention', assignments: [oldTask, { ...nextTask, stationName: 'A-01' }] });
  assert.equal(reusedUnit.state, 'running');
  assert.deepEqual(reusedUnit.assignments.map(item => item.id), ['next-task']);
  const html = context.renderDetail(units[0], null, false, {});
  assert.match(html, /当前没有活动任务/);
  assert.doesNotMatch(html, /待核量|WO-PENDING|100 件|0 件|已同步|已完成/);
  const activeHtml = context.renderDetail(units[1], null, false, {});
  assert.match(activeHtml, /生产中/);
  assert.match(activeHtml, /WO-NEXT/);
  assert.match(activeHtml, /待核量/);
  assert.doesNotMatch(activeHtml, /WO-PENDING|100 件|0 件|已同步|已完成/);
  const orders = sceneData.sceneOrders({ assignments: [oldTask, nextTask] }, snapshot, '8');
  assert.equal(orders.length, 2);
  assert.ok(orders.find(order => order.projectId === 1).records.some(record => record.status === 'QUANTITY_PENDING'));
});

test('同人旧任务待核量与新任务生产中并存，机台只计新活动而台账保留两笔', async () => {
  const api = await workspace();
  const oldTask = { ...pending, machineId: '01', isEmbroidery: true };
  const nextTask = { ...pending, id: 'next-task', projectId: 2, projectCode: 'WO-NEXT', machineId: '02', isEmbroidery: true, status: 'IN_PROGRESS', quantityPending: false, endedAt: null };
  api.syncEmbroideryMachines([oldTask, nextTask]);
  assert.equal(api.state.embroideryMachines.find(item => item.id === '01').status, 'IDLE');
  assert.equal(api.state.embroideryMachines.find(item => item.id === '02').current.assignmentId, 'next-task');
  assert.equal(api.state.embroideryMachines.filter(item => item.current).length, 1);
  const orders = api.liveOrders([oldTask, nextTask]);
  assert.equal(orders.length, 2);
  const oldOrder = orders.find(order => order.projectId === 1);
  assert.match(api.ledgerAttention(oldOrder), /待核量/);
  assert.equal(api.recentLedgerRecords(oldOrder)[0].id, pending.id);
  assert.equal(oldOrder.records[0].amount, null);
});
