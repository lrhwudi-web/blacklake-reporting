import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function workerPage({api={},wx={}}={}){
 let page;
 const pass=value=>value;
 runInNewContext(readFileSync(new URL('../workspace/pages/worker/worker.js',import.meta.url),'utf8'),{
  Page:value=>{page=value;},
  require:id=>id.endsWith('/layer-back')?{page:pass}:id.endsWith('/live-workspace')?{wrap:pass}:id.endsWith('/api')?api:{data:{},methods:{},refreshCurrentOrder:async()=>{}},
  wx,setTimeout:callback=>{callback();return 1;},clearTimeout:()=>{}
 });
 page.setData=values=>Object.assign(page.data,values);
 page.resetSelfDefects=()=>{};
 return page;
}

test('关闭数量弹窗保留草稿并允许回首页刷新',async()=>{
 const page=workerPage(),calls=[];
 page.returnToWork=async()=>calls.push('cancelEnd');
 Object.assign(page.data,{workerPanel:{kind:'quantity'},current:{id:'task',canConfirmQuantity:true,canReturnToWork:false},good:'12'});
 await page.closeWorkerPanel();
 assert.equal(page.data.workerPanel,null);
 assert.equal(page.data.good,'12');
 assert.deepEqual(calls,[]);
});

test('绣花结束后从收起按钮、遮罩及系统返回都能继续同一任务计时',async()=>{
 const markup=readFileSync(new URL('../workspace/pages/worker/worker.wxml',import.meta.url),'utf8');
 const handler=pattern=>markup.match(pattern)?.[1];
 const mask=handler(/class="worker-panel-mask[^"]*" bindtap="(\w+)"/);
 const button=handler(/id="worker-panel-dismiss"[^>]*bindtap="(\w+)"/);
 const layerBack={exports:{}};
 runInNewContext(readFileSync(new URL('../workspace/utils/layer-back.js',import.meta.url),'utf8'),{module:layerBack});
 for(const entry of [mask,button,'system']){
  const actions=[],page=workerPage({api:{executeExecutionAction:async(action,input,meta)=>{
   actions.push([action,input.assignmentId,meta.expectedTimingRevision]);
   return {assignment:{id:'task',status:'IN_PROGRESS',endedAt:null,timingRevision:2}};
  }}});
  page._layerBackKind='worker';
  page.refresh=async()=>{page.data.current.status='IN_PROGRESS';return true;};
  Object.assign(page.data,{embroideryMode:true,workerPanel:{kind:'quantity'},panelOpen:true,quantityDraftId:'task',good:'12',
   current:{id:'task',status:'AWAITING_QUANTITY',canConfirmQuantity:true,canReturnToWork:true,timingRevision:1}});
  if(entry==='system')await layerBack.exports.resolve(page).close();
  else await page[entry]();
  assert.deepEqual(actions,[['cancelEnd','task',1]],entry);
  assert.equal(page.data.current.status,'IN_PROGRESS');
  assert.equal(page.data.workerPanel,null);
  assert.equal(page.data.quantityDraftId,'');
 }
});

test('绣花返回计时已获回执，随后快照超时时仍能关闭数量窗并继续计时',async()=>{
 const page=workerPage({api:{executeExecutionAction:async()=>({
  assignment:{id:'task',status:'IN_PROGRESS',endedAt:null,timingRevision:2,paused:false}
 })}});
 page.refresh=async()=>{page.data.error='读取超时';return false;};
 page.updateWorkerClock=()=>{page.data.clockText=String(page.clockBaseSeconds);};
 const task={id:'task',status:'AWAITING_QUANTITY',elapsedSeconds:11,timingRevision:1,canConfirmQuantity:true,canReturnToWork:true};
 Object.assign(page.data,{embroideryMode:true,workerPanel:{kind:'quantity'},panelOpen:true,quantityDraftId:'task',good:'12',current:task,activeTask:task});
 await page.dismissWorkerPanel();
 assert.equal(page.data.workerPanel,null);
 assert.equal(page.data.current.canFinish,true);
 assert.equal(page.data.current.canConfirmQuantity,false);
 assert.equal(page.data.current.timingRevision,2);
 assert.equal(page.data.clockText,'11');
 assert.equal(page.data.error,'');
});

test('绣花工序关闭时还能收起数量窗并保留草稿，不请求继续计时',async()=>{
 const page=workerPage({api:{executeExecutionAction:async()=>assert.fail('工序不可返回时不能继续计时')}});
 Object.assign(page.data,{embroideryMode:true,workerPanel:{kind:'quantity'},quantityDraftId:'task',good:'12',
  current:{id:'task',status:'AWAITING_QUANTITY',canReturnToWork:false,canConfirmQuantity:false,canExitClosedSelfTask:true}});
 await page.dismissWorkerPanel();
 assert.equal(page.data.workerPanel,null);
 assert.equal(page.data.current.canExitClosedSelfTask,true);
 assert.equal(page.data.good,'12');
});

test('普通报工回执已保存后立即关窗，随后读取失败不会覆盖保存结果',async()=>{
 const toasts=[],page=workerPage({api:{executeExecutionAction:async()=>({
  accepted:true,queued:true,assignment:{id:'task',status:'COMPLETED'},version:2
 })},wx:{showToast:options=>toasts.push(options.title)}});
 let releaseRead;
 page.refresh=()=>new Promise(resolve=>{releaseRead=resolve;});
 Object.assign(page.data,{workerPanel:{kind:'quantity'},current:{id:'task',canConfirmQuantity:true},good:'12'});
 const confirm=page.confirmQuantity();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(page.data.workerPanel,null);
 assert.equal(page.data.current,null);
 assert.equal(page.data.version,2);
 assert.match(toasts[0],/已保存/);
 releaseRead(false);
 await confirm;
});

test('自主开工失败后的重试能请求该工单刷新并重新读工序',async()=>{
 let controller,refreshes=0,loads=0;
 runInNewContext(readFileSync(new URL('../workspace/utils/worker-self-service.js',import.meta.url),'utf8'),{
  module:{set exports(value){controller=value;}},
  require:id=>id.endsWith('/order-refresh')?{refreshCurrentOrder:async(_api,id)=>{assert.equal(id,21);refreshes++;}}
   :id.endsWith('/api')?{loadSelfServiceContext:async()=>{loads++;return {orderId:21,order:{id:21},processes:[],units:[]};}}
    :{presentProcesses:rows=>rows}
 });
 const page={...controller.methods,data:{...controller.data,selfServiceEnabled:true,canSelfStart:true,selfOrder:{id:21},
  workerPanel:{kind:'self'},error:'这道工序已关闭',selfError:'这道工序已关闭'},
  setData(values){Object.assign(this.data,values);}};
 await page.retrySelfProcesses();
 assert.equal(refreshes,1);
 assert.equal(loads,1);
 assert.equal(page.data.selfError,'');
});

test('员工工作台允许从报错状态退出本人已关闭的自主任务，取消确认时保留任务',async()=>{
 let page,modal,toast;
 const calls=[];
 const pass=page=>page;
 runInNewContext(readFileSync(new URL('../workspace/pages/worker/worker.js',import.meta.url),'utf8'),{
  Page:value=>{page=value;},
  require:id=>id.endsWith('/layer-back')?{page:pass}:id.endsWith('/live-workspace')?{wrap:pass}:{data:{},methods:{}},
  wx:{showModal:options=>{modal=options;},showToast:options=>{toast=options;}}
 });
 page.setData=values=>Object.assign(page.data,values);
 page.resetSelfDefects=()=>{};
 page.closeWorkerPanel=()=>{};
 page.run=async(action,input)=>{calls.push([action,input.assignmentId]);return true;};
 Object.assign(page.data,{activeTask:{id:'closed-task',canExitClosedSelfTask:true},error:'工单或工序已关闭',quantityDraftId:'closed-task',good:'12'});
 const cancel=page.exitClosedSelfTask();
 modal.success({confirm:false});
 await cancel;
 assert.deepEqual(calls,[]);
 assert.equal(page.data.good,'12');
 const confirm=page.exitClosedSelfTask();
 modal.success({confirm:true});
 await confirm;
 assert.deepEqual(calls,[['exitClosedSelfTask','closed-task']]);
 assert.equal(page.data.quantityDraftId,'');
 assert.match(toast.title,/下一单/);
});
