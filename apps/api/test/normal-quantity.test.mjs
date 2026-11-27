import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';import {BlacklakeClient} from '../src/blacklake-client.mjs';
async function fixture({quality=false,inherit=false}={}){
 const config={sessionSecret:'normal-quantity-regression-secret',sessionDays:30,adminApiKey:'normal-quantity-admin-secret',reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false}};
 const store=new Store(':memory:',config),people=[{name:'测试组长',blacklakeOperatorId:101},{name:'测试员工',blacklakeOperatorId:103}];
 const operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});const tokens=operators.map(o=>store.createSession(o.id).token),outputs=[];
 if(quality)store.setQualityProfile(103,'quality',0,'TEST');
 const rows=[...(inherit?[{id:99,seq:1,processName:'上一工序',fineAmount:72,defectsAmount:3,processStatus:20}]:[]),{id:100,seq:inherit?2:1,processName:quality?'成品质检':'测试缝制',fineAmount:0,processStatus:10}].map(r=>({projectId:200,projectCode:'TEST-WO',planAmount:100,...r}));
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://blacklake.invalid',staticToken:'TEST',taskQueryPath:'/tasks',timeoutMs:1000},async()=>new Response(JSON.stringify({code:'01000000',data:rows}),{status:200}));
 const processes=await client.listWorkOrderProcesses('https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=200');const task=processes.find(t=>t.taskId===100);
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>processes,findWorkOrderProcess:async()=>task,findTaskById:async()=>task,createOutput:async value=>{outputs.push(value);return{id:'test-output-'+outputs.length};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{},defectReasons:[{code:'D-1',name:'测试不良'}]}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{person=1,method='GET',body,key,admin=false}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[person]}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
 const assign=async()=>{const result=await call('/v1/dispatch/assign',{person:0,method:'POST',body:{flowCode:'FLOW-NORMAL',unitId:'A-03',taskId:100,blacklakeOperatorIds:[103]}});assert.equal(result.status,201);return result.body.assignment;};
 return{store,call,assign,task,outputs,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('正常8楼报工恢复计划默认数，确认后提交黑湖，不再自动待核量',async()=>{const f=await fixture();try{
 const row=await f.assign();assert.equal(row.quantityPolicy,'SERVER_DEFAULT');await f.call(`/v1/assignments/${row.id}/start`,{method:'POST',body:{}});
 const defaults=await f.call(`/v1/assignments/${row.id}/finish-default`);assert.equal(defaults.status,200);assert.equal(defaults.body.defaultQuantity,100);
 const done=await f.call(`/v1/assignments/${row.id}/finish`,{method:'POST',key:'normal_quantity_finish_01',body:{quantity:87,defectQuantity:0,defectCodes:[]}});assert.equal(done.status,201);assert.equal(done.body.assignment.status,'COMPLETED');assert.equal(f.outputs[0].amount,87);
}finally{await f.close();}});
test('8楼普通和质检派单不继承上一工序良品，使用当前计划',async()=>{const f=await fixture({inherit:true});try{
 assert.equal(f.task.defaultReportAmount,100);const row=await f.assign();await f.call(`/v1/assignments/${row.id}/start`,{method:'POST',body:{}});const defaults=await f.call(`/v1/assignments/${row.id}/finish-default`);assert.equal(defaults.status,200);assert.equal(defaults.body.defaultQuantity,100);assert.equal(defaults.body.targetQuantity,100);
}finally{await f.close();}});
test('8楼质检恢复合格/不良和原因校验，实际良品与不良均提交',async()=>{const f=await fixture({quality:true,inherit:true});try{
 const row=await f.assign();await f.call(`/v1/assignments/${row.id}/start`,{method:'POST',body:{}});const defaults=await f.call(`/v1/assignments/${row.id}/finish-default`);assert.equal(defaults.status,200);assert.equal(defaults.body.defaultQuantity,100);assert.equal(defaults.body.defectReasons.length,1);
 const invalid=await f.call(`/v1/assignments/${row.id}/finish`,{method:'POST',key:'normal_quality_missing_reason',body:{quantity:70,defectQuantity:2}});assert.equal(invalid.status,422);assert.equal(f.outputs.length,0);
 const done=await f.call(`/v1/assignments/${row.id}/finish`,{method:'POST',key:'normal_quality_confirmed_01',body:{quantity:70,defectQuantity:2,defectCodes:['D-1']}});assert.equal(done.status,201);assert.equal(done.body.assignment.status,'COMPLETED');assert.equal(done.body.assignment.goodQuantity,70);assert.equal(done.body.assignment.defectQuantity,2);assert.equal(f.outputs[0].amount,72);assert.equal(f.outputs[0].defectAmount,2);
}finally{await f.close();}});
test('旧活动任务的宽泛待核量标记不再阻断数量，旧客户端只发策略不能偷偷代报',async()=>{const f=await fixture();try{
 const row=await f.assign();f.store.db.prepare("UPDATE assignments SET quantity_policy='PENDING_REVIEW' WHERE id=?").run(row.id);await f.call(`/v1/assignments/${row.id}/start`,{method:'POST',body:{}});
 const current=await f.call('/v1/assignments/current');assert.equal(current.body.assignment.quantityPolicy,'SERVER_DEFAULT');assert.equal((await f.call(`/v1/assignments/${row.id}/finish-default`)).status,200);
 const legacy=await f.call(`/v1/assignments/${row.id}/finish`,{method:'POST',key:'legacy_policy_without_quantity',body:{quantityPolicy:'PENDING_REVIEW'}});assert.equal(legacy.status,409);assert.equal(f.outputs.length,0);assert.equal(f.store.assignmentById(row.id).status,'IN_PROGRESS');
}finally{await f.close();}});
test('只有后台代完工才进入待核量，历史待核量重放不自动提交产量',async()=>{const f=await fixture();try{
 const row=await f.assign();await f.call(`/v1/assignments/${row.id}/start`,{method:'POST',body:{}});const detail=await f.call('/v1/admin/task-recovery/assignments/'+row.id,{admin:true});
 const endedAt=new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ');const recovered=await f.call('/v1/admin/task-recovery/assignments/'+row.id+'/finish',{admin:true,method:'POST',key:'admin_only_pending_quantity',body:{expectedVersion:detail.body.assignment.version,actualEndedAt:endedAt,reason:'员工漏结束，数量尚未确认'}});assert.equal(recovered.status,200);assert.equal(recovered.body.assignment.status,'QUANTITY_PENDING');assert.equal(f.outputs.length,0);
 const replay=await f.call(`/v1/assignments/${row.id}/finish`,{method:'POST',key:'legacy_replay_after_admin',body:{quantityPolicy:'PENDING_REVIEW'}});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(f.outputs.length,0);
}finally{await f.close();}});
