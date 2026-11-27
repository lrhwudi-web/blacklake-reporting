import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';

async function fixture(){
 const config={sessionSecret:'cutting-fixture-secret',sessionDays:30,reportingModeAdminOperatorIds:[],agent:{enabled:false}};
 const store=new Store(':memory:',config), people=[{blacklakeOperatorId:301,name:'测试裁床员'},{blacklakeOperatorId:302,name:'测试普通员工'}];
 const operators=people.map(p=>store.upsertBlacklakeOperator(p));const tokens=operators.map(p=>store.createSession(p.id).token);
 store.setDispatchUnitRecommendations('裁床一区',[301]);
 store.setSelfServicePermission(301,true,0,'TEST:authorized-cutting-worker');
 const tasks=[{taskId:11,processName:'裁床下料',processCode:'CUT1'},{taskId:12,processName:'合缝',processCode:'SEW'},{taskId:13,processName:'裁床裁切',processCode:'CUT2'}].map(p=>({...p,projectId:201,projectCode:'WO-CUT',productName:'测试品',plannedAmount:100,defaultReportAmount:100,reportedGoodAmount:0}));
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>tasks,findWorkOrderProcess:async(_flow,id)=>{const p=tasks.find(p=>p.taskId===Number(id));if(!p)throw Error('not found');return p;},searchWorkOrdersBySku:async()=>[{projectId:201,projectCode:'WO-CUT'},{projectId:202,projectCode:'WO-CUT2'}],createOutput:()=>assert.fail('开工不能写黑湖产量')};
 const rules={profiles:[{blacklakeOperatorId:301,staff:'测试裁床员',processCode:'CUT1',enabled:true,reportCount:30,workOrderCount:4,dominantShare:.9}],sourcePeriod:{from:'2026-01-01',to:'2026-08-24'},sourceRecordCount:30};
 const server=createServer(createApp({config,store,blacklake,wechat:{},dispatchPredictionRules:rules}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,body,person=0,key='cutting-start-000000001')=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[person],'Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
 const start=(body={},person=0,key)=>call('/v1/flow/start',{flowCode:'projectId=201',taskId:11,reportingMode:'standard',selfService:'cutting',...body},person,key);
 return {store,operators,call,start,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('自主权限、SKU多工单及本人历史推荐覆盖当前可用工序',async()=>{const f=await fixture();try{
 assert.equal((await f.call('/v1/me')).body.cuttingSelfService,true);assert.equal((await f.call('/v1/me',null,1)).body.cuttingSelfService,false);
 const options=await f.call('/v1/flow/options',{flowCode:'projectId=201',reportingMode:'standard',selfService:'employee'});assert.equal(options.status,200);assert.deepEqual(options.body.processes.map(p=>p.taskId),[11,12,13]);assert.equal(options.body.recommendedProcess.taskId,11);
 assert.equal((await f.call('/v1/flow/work-orders/search',{sku:'TEST'})).body.workOrders.length,2);assert.equal((await f.call('/v1/flow/work-orders/search',{sku:'TEST'},1)).status,403);
 assert.equal((await f.start({taskId:12,selfService:'employee'})).status,201);assert.equal((await f.start({},1)).status,403);
}finally{await f.close();}});
test('裁床直接开工携带工位，重复/并发请求只产生一笔，已有任务阻止另开',async()=>{const f=await fixture();try{
 const results=await Promise.all([f.start(),f.start()]);assert.ok(results.every(r=>[200,201].includes(r.status)));assert.equal(results[0].body.assignment.id,results[1].body.assignment.id);
 const assignment=results[0].body.assignment;assert.equal(assignment.status,'IN_PROGRESS');assert.equal(assignment.stationName,'裁床一区');assert.equal(assignment.isDispatched,false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,1);
 assert.equal((await f.start({taskId:13},0,'cutting-start-000000002')).status,409);
 assert.equal((await f.start({taskId:13})).status,409);
}finally{await f.close();}});
test('工位不再隐式授权，多工位不猜选；缺少编号或后台撤权不能开工',async()=>{const f=await fixture();try{
 assert.equal((await f.start({},0,'')).status,422);f.store.setDispatchUnitRecommendations('裁床二区-1',[301]);assert.equal((await f.start()).status,409);
 assert.equal((await f.start({workUnitId:'裁床二区-1'})).status,201);
 f.store.setDispatchUnitRecommendations('裁床一区',[]);f.store.setDispatchUnitRecommendations('裁床二区-1',[]);
 assert.equal((await f.call('/v1/me')).body.selfServiceEnabled,true);
 f.store.setSelfServicePermission(301,false,1,'TEST:revoke-self-service');assert.equal((await f.start()).status,403);
}finally{await f.close();}});
