import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { sceneOrders, progress } from '../../admin/production-3d/data.js';

const key='scene-test-admin-key-at-least-32-characters';
async function request({authorized=true,path='/v1/admin/production-scene',rows={}}={}) {
  let reads=0; const store={activeAssignmentsByUnit(id){reads++;return rows[id]||[];}};
  const handler=createApp({config:{adminApiKey:key,adminProxySecret:'',blacklake:{mode:'mock'}},store,blacklake:{},wechat:{},processInferenceRules:{}});
  const result={headers:{}}; const res={setHeader(k,v){result.headers[k]=v;},writeHead(status,headers){result.status=status;Object.assign(result.headers,headers);},end(body){result.body=body;}};
  await handler({method:'GET',url:path,headers:authorized?{'x-admin-key':key}:{}},res);
  result.status=res.statusCode ?? result.status;result.reads=reads;return result;
}
test('3D现场数据要求原管理员认证，未登录不读取任务',async()=>{const r=await request({authorized:false});assert.equal(r.status,401);assert.equal(r.reads,0);});
test('3D现场返回全部位置、多人工位与旧机台编号，不虚构仓库库存',async()=>{
  const r=await request({rows:{'MACHINE-01':[{id:'legacy',status:'IN_PROGRESS',machineId:'MACHINE-01',operatorName:'旧机台员工'}],'3F-01':[{id:'queued',status:'READY',machineId:'3F-01'}],'A-01':[{id:'a',status:'IN_PROGRESS',operatorName:'甲'},{id:'b',status:'NEEDS_REVIEW',operatorName:'乙'}]}});
  assert.equal(r.status,200);const data=JSON.parse(r.body);assert.equal(data.floors['3'].length,12);assert.equal(data.floors['8'].length,24);
  assert.equal(data.floors['8'].find(unit=>unit.id==='翻内袋')?.state,'available');
  assert.equal(data.floors['3'][0].state,'running');assert.equal(data.floors['3'][0].assignments[0].id,'legacy');assert.equal(data.floors['8'][0].state,'attention');assert.equal(data.floors['8'][0].assignments.length,2);
  assert.deepEqual(data.warehouse,{connected:false,layout:'schematic'});assert.equal(data.floors['8'][1].state,'available');
});
test('同编号工单按projectId分别展示，黑湖累计值不混入活动任务数量',()=>{
  const records=[{id:'a',projectId:1,projectCode:'SAME',machineId:'MACHINE-01',taskId:11},{id:'b',projectId:2,projectCode:'SAME',machineId:'3F-02',taskId:22}];
  const orders=sceneOrders({assignments:records,workOrders:records.map((a,i)=>({...a,processes:[{processName:'工序',plannedAmount:100,reportedAmount:i?25:50}]}))},{floors:{'3':[]}},'3');
  assert.deepEqual(orders.map(o=>o.id),['project:1','project:2']);assert.equal(progress(orders[0].processes[0]),50);assert.equal(progress(orders[1].processes[0]),25);assert.equal(progress({}),null);
});
test('3D资源按白名单提供，源码中没有模拟报工与演示数量',async()=>{const r=await request({authorized:false,path:'/admin/production-3d/app.js'});assert.equal(r.status,200);const source=String(r.body);assert.doesNotMatch(source,/DEMO-|模拟一次报工|prototypeSnapshot/);assert.match(source,/\/v1\/admin\/production-scene/);assert.match(source,/credentials:'same-origin'/);const invalid=await request({authorized:false,path:'/admin/production-3d/vendor/../../../../api/src/config.mjs'});assert.notEqual(invalid.status,200);});
