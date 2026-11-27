import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture(options) {
  let page; const calls=[],toasts=[];
  vm.runInNewContext(readFileSync(new URL('../pages/report/report.js',import.meta.url),'utf8'),{
    Page:p=>page=p, getApp:()=>({globalData:{}}),
    require:p=>p.endsWith('work-time')?{workTimeBreakdown}:{request:async(path,opts)=>{
      calls.push({path,opts});return path.endsWith('/options')?options():{assignment:{id:'self-task',status:'IN_PROGRESS',quantity:280,startedAt:new Date().toISOString()}};
    }},
    wx:{showToast:v=>toasts.push(v),vibrateShort(){},showModal(){}},setInterval:()=>1,clearInterval(){},Date
  });
  page.setData=(v,cb)=>{Object.assign(page.data,v);cb?.();};
  Object.assign(page.data,{ready:true,cuttingSelfService:true,selfServiceMode:true,selectionMode:'manual',operator:{name:'测试员工'}});
  return {page,calls,toasts};
}
const processes=Array.from({length:20},(_,i)=>({taskId:i+1,sequence:i+1,processName:'工序'+(i+1),defaultQuantity:280}));
const base={workOrder:{projectCode:'WO-TEST'},processes,featuredProcesses:processes.slice(0,2),selfWorkUnits:['裁床一区'],recommendedProcess:{taskId:18}};
const tap=id=>({currentTarget:{dataset:{taskId:id}}});

test('自主扫码直接展示完整工序并定位后段历史推荐，选择不自动开工',async()=>{
  const {page,calls}=fixture(()=>base);await page.loadFlowOptions('projectId=201');
  assert.equal(page.data.stage,'select');assert.equal(page.data.processes.length,20);
  assert.equal(page.data.selectedProcess.taskId,18);assert.equal(page.data.selfProcessScrollTarget,'self-process-18');
  assert.equal(page.data.selfRecommendedTaskId,18);assert.equal(page.data.subheadline,'');
  page.chooseProcess(tap(4));assert.equal(page.data.stage,'select');assert.equal(page.data.selectedProcess.taskId,4);
  assert.equal(page.data.selfRecommendedTaskId,18);assert.equal(calls.length,1);
  await page.startSelectedProcess();const start=calls.find(c=>c.path.endsWith('/start'));
  assert.equal(start.opts.data.taskId,4);assert.equal(start.opts.data.selfService,'employee');assert.equal(start.opts.data.workUnitId,'裁床一区');assert.equal(page.data.stage,'working');
});

test('新工单无有效推荐时清除旧推荐，不擅自选第一项，未知数量保持未知',async()=>{
  let options=base;const {page,calls}=fixture(()=>options);await page.loadFlowOptions('projectId=201');
  options={...base,recommendedProcess:{taskId:999},processes:[{taskId:30,sequence:3,processName:'未知数量工序'}]};
  await page.loadFlowOptions('projectId=202');assert.equal(page.data.selectedProcess,undefined);
  assert.equal(page.data.selfRecommendedTaskId,null);assert.equal(page.data.selfProcessScrollTarget,'');
  assert.equal(page.data.processes[0].defaultQuantity,undefined);
  await page.startSelectedProcess();assert.equal(calls.some(c=>c.path.endsWith('/start')),false);
});

test('多工位仍需选择后才开工，选工序与扫码入口在提交期间保持保护',async()=>{
  const {page,calls,toasts}=fixture(()=>({...base,selfWorkUnits:['裁床一区','整理台']}));await page.loadFlowOptions('projectId=201');
  await page.startSelectedProcess();assert.equal(calls.length,1);assert.match(toasts[0].title,/工位/);
  page.setSelectionMode({currentTarget:{dataset:{mode:'station'}}});assert.equal(page.data.selectionMode,'manual');
  page.data.submitting=true;page.chooseProcess(tap(2));assert.equal(page.data.selectedProcess.taskId,18);
  page.data.submitting=false;page.chooseSelfWorkUnit({detail:{value:2}});await page.startSelectedProcess();assert.equal(calls.at(-1).opts.data.workUnitId,'整理台');
});

test('普通旧流程继续按原推荐确认，不改为自主选择列表',async()=>{
  const {page}=fixture(()=>base);page.data.selfServiceMode=false;page.data.selectionMode='station';
  await page.loadFlowOptions('projectId=201');assert.equal(page.data.stage,'confirm-start');
  assert.equal(page.data.selfRecommendedTaskId,null);assert.equal(page.data.selfProcessScrollTarget,'');
});

test('进度卡展示完整路线但已关闭不接受选择，旧后端缺进度保持未知',async()=>{
 const options={...base,processOverview:[{taskId:99,sequence:1,processName:'已关闭工序',closed:true,selectable:false,percentLabel:'100%',statusLabel:'已关闭'},...base.processes.map(p=>({...p,selectable:true,percentLabel:'45%',statusLabel:'进行中'}))]};
 const {page,calls}=fixture(()=>options);await page.loadFlowOptions('projectId=201');assert.equal(calls[0].opts.data.includeProgress,true);assert.equal(page.data.selfProcessOverview.length,21);
 page.chooseProcess(tap(99));assert.equal(page.data.selectedProcess.taskId,18);assert.equal(page.data.selfProcessOverview[0].selectable,false);
 const old=fixture(()=>base).page;await old.loadFlowOptions('projectId=201');assert.equal(old.data.selfProcessOverview[0].percentLabel,'—');assert.equal(old.data.selfProcessOverview[0].statusLabel,'进度未确认');
});
