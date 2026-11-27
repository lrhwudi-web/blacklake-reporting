import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../workspace/utils/order-operations.js',import.meta.url),'utf8');
const order={id:201,code:'TEST-201',priority:'NONE',status:'IN_PROGRESS'};

function fixture(api,canOperateOrders=true){
  const module={exports:{}},timers=new Map(),toasts=[];
  let serial=0;
  runInNewContext(source,{module,require:name=>name==='./api'?api:{DURATION:260},
    getApp:()=>({globalData:{entry:{appRole:'employee',canOperateOrders}}}),wx:{showToast:toast=>toasts.push(toast.title)},
    setTimeout:(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;},clearTimeout:id=>timers.delete(id)});
  const {data,methods}=module.exports;
  const page={...methods,data:{...data,operationPanel:{...order,priority:'URGENT',version:42,syncPriority:false,canManage:true},operationOpen:true,
    loadedOrders:[order],snapshotOrders:[order],sourceMode:'live',reduceMotion:true},
    setData(values){Object.assign(this.data,values);},applyFilters(){}};
  const run=async delay=>{
    const [id,timer]=[...timers].find(([,timer])=>timer.delay===delay);
    timers.delete(id);await timer.fn();
  };
  return {page,timers,toasts,run};
}

test('操作入口只在获授权的员工工单列表显示和加载',async()=>{
  const worker=readFileSync(new URL('../workspace/pages/worker/worker.wxml',import.meta.url),'utf8');
  const leader=readFileSync(new URL('../workspace/pages/orders/orders.wxml',import.meta.url),'utf8');
  assert.match(worker,/<button[^>]+wx:if="{{canOperateOrders}}"[^>]+catchtap="openOrderOperations"/);
  assert.doesNotMatch(leader,/catchtap="openOrderOperations"/);
  let reads=0;
  const api={loadOrderOperations:async()=>{reads++;return {order,version:42,canManage:true};}};
  for(const allowed of [false,true]){
    const {page}=fixture(api,allowed);
    Object.assign(page.data,{operationPanel:null,visibleWorkerOrders:[order]});
    await page.openOrderOperations({currentTarget:{dataset:{id:201}}});
    assert.equal(Boolean(page.data.operationPanel),allowed);
  }
  assert.equal(reads,1);
});

test('工单提交后可继续浏览，后台确认前不更新卡片或显示成功',async()=>{
  let writes=0,loads=0,operationId;
  const f=fixture({
    executeExecutionAction:async(_action,_input,meta)=>{writes++;operationId=meta.operationId;return {status:'PENDING',operationId,queued:true};},
    loadOrderOperations:async(id,key)=>{loads++;assert.equal(id,201);assert.equal(key,operationId);return {order:{...order,priority:'URGENT'},version:43,receipt:{status:'SUCCEEDED'}};}
  });
  await f.page.saveOrderOperations();
  assert.equal(f.page.data.operationSaving,false);
  assert.equal(f.page.data.operationPanel.checking,true);
  assert.match(f.page.data.operationStatus,/后台/);
  assert.equal(f.page.data.loadedOrders[0].priority,'NONE');
  assert.equal(loads,0);
  await f.page.saveOrderOperations();assert.equal(writes,1);
  await f.run(2500);await f.run(100);
  assert.equal(f.page.data.loadedOrders[0].priority,'URGENT');assert.deepEqual(f.toasts,['工单已更改']);
  assert.equal(f.page.data.operationPanel,null);assert.equal(f.timers.size,0);
});

test('冷却期间状态可见，关闭弹窗取消轮询且不重复提交',async()=>{
  let loads=0,writes=0;
  const f=fixture({
    executeExecutionAction:async()=>{writes++;},
    loadOrderOperations:async()=>{loads++;return {order,version:42,canManage:false,pending:{checking:true},sync:{phase:'cooldown'}};}
  });
  await f.page.reloadOrderOperations();
  assert.match(f.page.data.operationStatus,/可刷新这张工单/);
  assert.equal([...f.timers.values()][0].delay,8000);
  f.page.closeOrderOperations();await f.run(100);
  assert.equal(f.timers.size,0);assert.equal(loads,1);assert.equal(writes,0);
});

test('终止等待的旧操作可手动刷新单张工单，核对后恢复编辑',async()=>{
  let refreshes=0,settled=false;
  const f=fixture({
    refreshOrderDetail:async id=>{assert.equal(id,201);refreshes++;settled=true;},
    loadOrderOperations:async()=>({order,version:42,canManage:settled,pending:settled?null:{checking:false}})
  });
  await f.page.reloadOrderOperations();
  assert.match(f.page.data.operationError,/仍待核对/);assert.equal(f.timers.size,0);
  await f.page.refreshOrderOperations();
  assert.equal(refreshes,1);assert.equal(f.page.data.operationError,'');assert.equal(f.page.data.operationPanel.canManage,true);
});
