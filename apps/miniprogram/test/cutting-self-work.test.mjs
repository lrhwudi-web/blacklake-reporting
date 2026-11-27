import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function setup(handler){let page;const scans=[],modals=[];vm.runInNewContext(readFileSync(new URL('../pages/report/report.js',import.meta.url),'utf8'),{Page:p=>page=p,getApp:()=>({globalData:{}}),require:path=>path.endsWith('work-time')?{workTimeBreakdown}:{request:handler},wx:{scanCode:v=>scans.push(v),showToast(){},showModal:v=>modals.push(v),vibrateShort(){}},setInterval:()=>1,clearInterval(){},Date});page.setData=v=>Object.assign(page.data,v);Object.assign(page.data,{ready:true,cuttingSelfService:true,operator:{name:'测试裁床员'}});return {page,scans,modals};}
const options={workOrder:{projectCode:'WO-CUT'},selfWorkUnits:['裁床一区'],processes:[{taskId:11,processName:'裁床开料',sequence:1}],recommendedProcess:{taskId:11},recommendationEvidence:{reportCount:30}};
test('员工SKU返回多工单由本人选择，历史工序自动带入，一次点击开工不派单',async()=>{
 const calls=[];const {page}=setup(async(path,opts)=>{calls.push({path,opts});if(path.endsWith('/search'))return {workOrders:[{projectId:201},{projectId:202}]};if(path.endsWith('/options'))return options;return {assignment:{id:'self',status:'IN_PROGRESS',quantity:100,startedAt:new Date().toISOString()}};});
 page.onSkuInput({detail:{value:'SKU-1'}});await page.searchSkuWorkOrders();assert.equal(page.data.skuResults.length,2);
 await page.selectSkuWorkOrder({currentTarget:{dataset:{projectId:202}}});assert.equal(page.data.flowCode,'projectId=202');assert.equal(page.data.stage,'select');assert.equal(page.data.selectedProcess.taskId,11);
 await page.startSelectedProcess();const start=calls.find(c=>c.path.endsWith('/start'));assert.equal(start.opts.data.selfService,'employee');assert.equal(start.opts.data.workUnitId,'裁床一区');assert.ok(start.opts.idempotencyKey);assert.equal(page.data.stage,'working');assert.equal(calls.some(c=>c.path.includes('/dispatch/assign')),false);
});
test('裁床开工回执未知时重试沿用同一标识，普通员工不能由入口自主开工',async()=>{
 const keys=[];const {page}=setup(async(path,opts)=>{if(path.endsWith('/options'))return options;keys.push(opts.idempotencyKey);throw Error('network');});page.openSelfWork();await page.loadFlowOptions('projectId=201');
 await page.startSelectedProcess();await page.startSelectedProcess();assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
 page.data.cuttingSelfService=false;page.data.stage='waiting';assert.equal(page.openSelfWork(),false);page.scanSelfWork();
});
test('扫码失败有反馈，当前任务只读刷新不覆盖正在选择的自主开工界面',async()=>{
 const {page,scans}=setup(async()=>({assignment:null,assignments:[]}));page.scanSelfWork();scans[0].fail({errMsg:'scanCode:fail'});assert.ok(page.data.scanError);
 page.data.stage='confirm-start';await page.loadAssignment();assert.equal(page.data.stage,'confirm-start');
 page.data.activeAssignments=[{id:'ready'}];assert.equal(page.openSelfWork(),false);
});
