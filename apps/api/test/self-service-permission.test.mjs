import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';
async function fixture(){
 const config={sessionSecret:'self-service-permission-fixture',adminApiKey:'self-service-admin-fixture',sessionDays:30,reportingModeAdminOperatorIds:[],agent:{enabled:false}},store=new Store(':memory:',config);
 const people=[{name:'测试裁床员',blacklakeOperatorId:301,groupNames:[]},{name:'测试其他员工',blacklakeOperatorId:302,groupNames:[]},{name:'测试组长',blacklakeOperatorId:303,groupNames:[]}],operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(303,{appRole:'floor8_leader'});store.setDispatchUnitRecommendations('裁床一区',[301]);const tokens=operators.map(o=>store.createSession(o.id).token);
 const task={taskId:11,projectId:201,projectCode:'WO-SELF',productName:'测试品',processName:'裁床下料',processCode:'CUT',plannedAmount:100,defaultReportAmount:100,processStatus:10,reportedGoodAmount:0};
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>[task],findWorkOrderProcess:async()=>task,searchWorkOrdersBySku:async()=>[{projectId:201,projectCode:'WO-SELF'}],createOutput:()=>assert.fail('权限设置/开工不得向黑湖报产量')};
 const server=createServer(createApp({config,store,blacklake,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{admin=false,person=0,method='GET',body,key,headers={}}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[person]}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const set=async(enabled,{id=301,revision=store.selfServicePermission(id).revision,...options}={})=>call('/v1/admin/operators/'+id+'/self-service',{admin:true,method:'PATCH',body:{enabled,expectedRevision:revision},...options});
 return{store,operators,call,set,blacklake,task,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('裁床绑定不再自动赋权，后台开关决定/me与扫码/SKU/直接请求',async()=>{const f=await fixture();try{
 const me=await f.call('/v1/me');assert.equal(me.body.selfServiceEnabled,false);assert.equal(me.body.cuttingSelfService,false);
 for(const path of ['/v1/flow/options','/v1/flow/start','/v1/flow/work-orders/search'])assert.equal((await f.call(path,{method:'POST',key:'self_permission_test_start',body:{flowCode:'projectId=201',taskId:11,sku:'TEST',reportingMode:'standard'}})).status,403);
 const enabled=await f.set(true);assert.equal(enabled.status,200);assert.equal(enabled.body.operator.selfServiceEnabled,true);assert.equal((await f.call('/v1/me')).body.selfServiceEnabled,true);
 assert.equal((await f.call('/v1/flow/work-orders/search',{method:'POST',body:{sku:'TEST'}})).status,200);
 assert.equal((await f.set(false)).status,200);assert.equal((await f.call('/v1/flow/options',{method:'POST',body:{flowCode:'projectId=201'}})).status,403);
}finally{await f.close();}});
test('后台可给非裁床员工独立配置，权限不更改归属/部门/工位或手机模式开关',async()=>{const f=await fixture();try{
 f.store.setReportingModeSwitchPermission(302,false);const before=f.store.entryProfile(302);const result=await f.set(true,{id:302});assert.equal(result.status,200);assert.equal(result.body.operator.selfServiceEnabled,true);assert.equal((await f.call('/v1/me',{person:1})).body.selfServiceEnabled,true);assert.deepEqual(f.store.entryProfile(302),before);assert.equal(f.store.reportingModeSwitchPermission(302),false);assert.equal(f.store.dispatchUnitRecommendations().some(r=>r.blacklakeOperatorId===302),false);
}finally{await f.close();}});
test('员工和跨站不能给自己开权限，非法值/旧版本/组长被拒绝',async()=>{const f=await fixture();try{
 assert.equal((await f.set(true,{admin:false})).status,401);assert.equal((await f.set(true,{headers:{Origin:'https://evil.invalid'}})).status,403);assert.equal((await f.set('true')).status,422);assert.equal((await f.set(true,{id:303})).status,409);assert.equal((await f.set(true)).status,200);assert.equal((await f.set(false,{revision:0})).status,409);assert.equal((await f.set(true)).status,200);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM operator_self_service_events').get().n,1);
}finally{await f.close();}});
test('审计故障回滚权限，已开工任务不因禁用自主开工而中断',async()=>{const f=await fixture();try{
 f.store.db.exec("CREATE TRIGGER reject_self_permission BEFORE INSERT ON operator_self_service_events BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");assert.equal((await f.set(true)).status,500);assert.equal(f.store.selfServicePermission(301).enabled,false);f.store.db.exec('DROP TRIGGER reject_self_permission');await f.set(true);
 const o=f.operators[0];f.store.dispatchAssignment({id:'old-running',operatorId:o.id,taskId:11,projectId:201,projectCode:'TEST',productName:'测试品',processName:'裁床下料',quantity:100,stationName:'裁床一区',flowCodeHash:'fixture',publishedAt:'2026-11-03 08:00:00'});f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',started_at='2026-11-03 08:00:00' WHERE id='old-running'").run();assert.equal((await f.set(false)).status,200);assert.equal(f.store.assignmentById('old-running').status,'IN_PROGRESS');assert.equal((await f.call('/v1/assignments/current')).body.assignment.id,'old-running');
}finally{await f.close();}});

test('查工单期间后台撤权，真正写入开工前再次拦截',async()=>{const f=await fixture();let release;try{
 await f.set(true);let reached;const entered=new Promise(r=>reached=r),gate=new Promise(r=>release=r);f.blacklake.findWorkOrderProcess=async()=>{reached();await gate;return f.task;};
 const request=f.call('/v1/flow/start',{method:'POST',key:'self_service_race_test_01',body:{flowCode:'projectId=201',taskId:11,reportingMode:'standard'}});await entered;await f.set(false);release();assert.equal((await request).status,403);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,0);
}finally{release?.();await f.close();}});

test('非裁床员工开启后可选择其他普通工序，无工位不猜填站位',async()=>{const f=await fixture();try{
 const sewing={...f.task,taskId:12,processName:'合缝',processCode:'SEW'};f.blacklake.listWorkOrderProcesses=async()=>[f.task,sewing];f.blacklake.findWorkOrderProcess=async(_flow,id)=>Number(id)===12?sewing:f.task;
 await f.set(true,{id:302});const options=await f.call('/v1/flow/options',{person:1,method:'POST',body:{flowCode:'projectId=201',reportingMode:'standard',selfService:'employee'}});assert.equal(options.status,200);assert.deepEqual(options.body.processes.map(p=>p.taskId),[11,12]);assert.deepEqual(options.body.selfWorkUnits,[]);
 const done=await f.call('/v1/flow/start',{person:1,method:'POST',key:'employee_generic_start_01',body:{flowCode:'projectId=201',taskId:12,reportingMode:'standard',selfService:'employee',workUnitId:''}});assert.equal(done.status,201);assert.equal(done.body.assignment.stationName,'');assert.equal(done.body.assignment.status,'IN_PROGRESS');
}finally{await f.close();}});
