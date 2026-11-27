import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture(request=async()=>({})) {
  const time={module:{exports:{}}};vm.runInNewContext(readFileSync(new URL('../utils/work-time.js',import.meta.url),'utf8'),time);
  let page;const calls=[],toasts=[];
  class Clock extends Date { static now(){return Date.parse('2026-11-09T14:00:00+08:00');} }
  vm.runInNewContext(readFileSync(new URL('../pages/report/report.js',import.meta.url),'utf8'),{
    Page:value=>page=value,getApp:()=>({globalData:{sessionToken:'test'}}),require:path=>path.endsWith('work-time')?time.module.exports:{request:async(path,options)=>{calls.push({path,options});return request(path,options);}},
    Date:Clock,setInterval:()=>1,clearInterval(){},wx:{showToast:v=>toasts.push(v),getStorageSync(){},setStorageSync(){},removeStorageSync(){}}
  });
  page.setData=values=>Object.assign(page.data,values);
  const assignment={id:'task-a',status:'IN_PROGRESS',startedAt:'2026-11-09 11:00:00',attemptNumber:1,timingRevision:0,pauses:[],paused:false,quantity:10};
  Object.assign(page.data,{ready:true,stage:'working',assignment,activeAssignments:[assignment]});
  return {page,calls,toasts};
}

test('有效计时展示午休、暂停扣除；午休状态自动切换，手动暂停不随午休结束恢复',()=>{
  const {page}=fixture();page.data.assignment.pauses=[{startedAt:'2026-11-09 11:45:00',endedAt:'2026-11-09 13:45:00'}];page.updateElapsed();
  assert.equal(page.data.elapsedText,'01:00:00');assert.equal(page.data.lunchText,'01:30:00');assert.equal(page.data.pauseText,'00:30:00');
  page.syncTimerClock('2026-11-09 12:30:00');page.updateElapsed();assert.equal(page.data.timerStatus,'午休中');assert.equal(page.data.elapsedText,'00:45:00');
  page.data.assignment.paused=true;page.data.assignment.pauses=[{startedAt:'2026-11-09 11:45:00',endedAt:null}];page.syncTimerClock('2026-11-09 14:00:00');page.updateElapsed();
  assert.equal(page.data.timerStatus,'已暂停');assert.equal(page.data.elapsedText,'00:45:00');assert.equal(page.data.pauseText,'00:45:00');
});

test('连续点击暂停只写一次，等待服务端确认后才改变计时',async()=>{
  let release;const f=fixture(()=>new Promise(r=>release=r));const pending=f.page.toggleTimer();
  await f.page.toggleTimer();assert.equal(f.calls.length,1);assert.equal(f.page.data.assignment.paused,false);assert.equal(f.page.data.submitting,true);
  assert.equal(f.calls[0].options.data.expectedRevision,0);
  release({assignment:{...f.page.data.assignment,paused:true,timingRevision:1,pauses:[{startedAt:'2026-11-09 13:45:00',endedAt:null}]}});await pending;
  assert.equal(f.page.data.assignment.paused,true);assert.equal(f.page.data.timerStatus,'已暂停');assert.equal(f.page.data.submitting,false);
});

test('暂停响应丢失不冒充成功、不自动重写；刷新后按服务器状态恢复',async()=>{
  let reads=0;const f=fixture(async path=>{if(path.endsWith('/pause'))throw Error('network');reads++;return{assignment:{...f.page.data.assignment,paused:true,timingRevision:1},assignments:[{...f.page.data.assignment,paused:true,timingRevision:1}]};});
  await f.page.toggleTimer();assert(f.page.data.timerError);assert.equal(f.page.data.assignment.paused,false);
  await f.page.confirmFinish();await f.page.finishWork();assert.equal(f.calls.length,1);
  await f.page.toggleTimer();assert.equal(reads,1);assert.equal(f.page.data.timerError,'');assert.equal(f.page.data.assignment.paused,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/pause')).length,1);
});

test('迟到的暂停响应不覆盖另一个机台或已销毁页面',async()=>{
  for(const unload of [false,true]){let release;const f=fixture(()=>new Promise(r=>release=r));const original={...f.page.data.assignment},pending=f.page.toggleTimer();
    if(unload)f.page.pageUnloaded=true;else f.page.data.assignment={...original,id:'task-b'};
    release({assignment:{...original,paused:true,timingRevision:1}});await pending;
    assert.equal(f.page.data.assignment.paused,false);assert.equal(f.page.data.assignment.id,unload?'task-a':'task-b');
  }
});
