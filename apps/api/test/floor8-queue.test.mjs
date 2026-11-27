import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';
import {compileDispatchPredictionRules,predictDispatch,predictProcessForEmployees} from '../src/dispatch-prediction.mjs';
async function fixture(){
 const config={sessionSecret:'floor8-queue-test-only',sessionDays:30,adminApiKey:'floor8-queue-admin',reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false}},store=new Store(':memory:',config);
 const people=[{name:'队列测试组长',blacklakeOperatorId:101,groupNames:[]},{name:'队列测试员工',blacklakeOperatorId:102,groupNames:[]},{name:'其他测试员工',blacklakeOperatorId:103,groupNames:[]}],operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});const tokens=operators.map(o=>store.createSession(o.id).token),outputs=[];
 const tasks=[11,12,13,14].map((id,i)=>({taskId:id,projectId:201+i,projectCode:'TEST-'+(201+i),productName:'测试产品',processName:'测试缝制'+i,plannedAmount:100,defaultReportAmount:100,processStatus:10,reportedGoodAmount:0,reportedDefectAmount:0}));
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>tasks,findWorkOrderProcess:async(_flow,id)=>tasks.find(t=>t.taskId===Number(id)),findTaskById:async id=>({...tasks.find(t=>t.taskId===Number(id))}),createOutput:async data=>{outputs.push(data);return{id:'test-output-'+outputs.length};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{},defectReasons:[{code:'D-1',name:'测试不良'}]}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{person=0,admin=false,method='GET',body,key}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[person]}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const assign=(taskId,{peopleIds=[102],person=0,...extra}={})=>call('/v1/dispatch/assign',{person,method:'POST',body:{flowCode:'projectId='+tasks.find(t=>t.taskId===taskId).projectId,taskId,unitId:'A-03',blacklakeOperatorIds:peopleIds,...extra}});
 const start=id=>call('/v1/assignments/'+id+'/start',{person:1,method:'POST',body:{}});
 const finish=id=>call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'queue-finish-'+id,body:{quantity:72,defectQuantity:0,defectCodes:[]}});
 return{store,operators,tasks,outputs,call,assign,start,finish,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('同一8楼员工待开始和生产中都可排多单，FIFO且完成后下一单仍待开始',async()=>{const f=await fixture();try{
 const a=await f.assign(11),b=await f.assign(12);assert.equal(a.status,201);assert.equal(b.status,201);const aId=a.body.assignment.id,bId=b.body.assignment.id;
 const skipped=await f.start(bId);assert.equal(skipped.status,409);assert.equal(skipped.body.error.code,'QUEUE_ORDER_REQUIRED');assert.equal(f.store.assignmentById(bId).startedAt,null);
 assert.equal((await f.start(aId)).status,200);const c=await f.assign(13);assert.equal(c.status,201);assert.equal((await f.start(bId)).status,409);
 assert.equal((await f.finish(aId)).status,201);const current=await f.call('/v1/assignments/current',{person:1});assert.equal(current.body.assignment.id,bId);assert.equal(current.body.assignment.status,'READY');assert.equal(current.body.assignment.startedAt,null);assert.equal((await f.start(bId)).status,200);
}finally{await f.close();}});

test('重复同一工单工序拒绝，重发和并发不会重复入队',async()=>{const f=await fixture();try{
 const results=await Promise.all([f.assign(11),f.assign(11)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(results.find(r=>r.status===409).body.error.code,'DUPLICATE_QUEUED_TASK');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,1);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('并发排两张不同单均保留，并发开工最多一笔进入生产',async()=>{const f=await fixture();try{
 const rows=await Promise.all([f.assign(11),f.assign(12)]);assert(rows.every(r=>r.status===201));const tasks=f.store.activeAssignments(f.operators[1].id);const results=await Promise.all(tasks.map(t=>f.start(t.id)));assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status='IN_PROGRESS'").get().n,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status='READY'").get().n,1);
}finally{await f.close();}});

test('组长看到真实空闲和可排队状态，不把生产中冒充空闲',async()=>{const f=await fixture();try{
 const a=await f.assign(11);await f.start(a.body.assignment.id);await f.assign(12);const overview=await f.call('/v1/dispatch/overview');const employee=overview.body.employees.find(p=>p.blacklakeOperatorId===102);assert.equal(employee.available,false);assert.equal(employee.canQueue,true);assert.equal(employee.queuedCount,1);assert.match(employee.dispatchStateLabel,/生产中/);
}finally{await f.close();}});

test('结果待核对优先展示并拦开工及继续派单，防被待开始队列盖住',async()=>{const f=await fixture();try{
 const a=await f.assign(11);await f.start(a.body.assignment.id);const b=await f.assign(12);f.store.db.prepare("UPDATE assignments SET status='NEEDS_REVIEW' WHERE id=?").run(a.body.assignment.id);
 assert.equal((await f.call('/v1/assignments/current',{person:1})).body.assignment.id,a.body.assignment.id);assert.equal((await f.start(b.body.assignment.id)).status,409);assert.equal((await f.assign(13)).status,409);assert.equal(f.store.dispatchQueueState(102).canQueue,false);
}finally{await f.close();}});

test('已结束待核量释放生产占用，队列继续；旧补量未知但已结束也不重占生产',async()=>{const f=await fixture();try{
 const a=await f.assign(11);await f.start(a.body.assignment.id);const b=await f.assign(12);
 f.store.db.prepare("UPDATE assignments SET status='QUANTITY_PENDING',quantity_policy='PENDING_REVIEW',ended_at=started_at WHERE id=?").run(a.body.assignment.id);assert.equal((await f.start(b.body.assignment.id)).status,200);assert.equal((await f.assign(13)).status,201);
 f.store.db.prepare("UPDATE assignments SET status='NEEDS_REVIEW' WHERE id=?").run(a.body.assignment.id);assert.equal(f.store.dispatchQueueState(102).canQueue,true);
}finally{await f.close();}});

test('组长撤销队首待开始任务后下一单顺延，历史保留原因',async()=>{const f=await fixture();try{
 const a=await f.assign(11),b=await f.assign(12);const cancelled=await f.call('/v1/dispatch/assignments/'+a.body.assignment.id+'/cancel',{method:'POST',body:{reason:'测试误派，保留历史'}});assert.equal(cancelled.status,200);assert.equal(f.store.assignmentById(a.body.assignment.id).status,'CANCELLED');assert.equal((await f.start(b.body.assignment.id)).status,200);
}finally{await f.close();}});

test('排队期间默认数量发生变化，真正开工时刷新而不沿用旧计划',async()=>{const f=await fixture();try{
 const a=await f.assign(11),b=await f.assign(12);assert.equal(b.body.assignment.quantity,100);await f.start(a.body.assignment.id);await f.finish(a.body.assignment.id);f.tasks[1].defaultReportAmount=15;f.tasks[1].plannedAmount=72;
 const next=await f.start(b.body.assignment.id);assert.equal(next.status,200);assert.equal(next.body.assignment.targetQuantity,72);const defaults=await f.call('/v1/assignments/'+b.body.assignment.id+'/finish-default',{person:1});assert.equal(defaults.body.defaultQuantity,72);
}finally{await f.close();}});

test('关闭工序或未知默认数不偷偷开工，不能越过前单',async()=>{const f=await fixture();try{
 const a=await f.assign(11),b=await f.assign(12);f.tasks[0].processStatus=20;assert.equal((await f.start(a.body.assignment.id)).status,409);assert.equal((await f.start(b.body.assignment.id)).status,409);assert.equal(f.store.assignmentById(a.body.assignment.id).status,'READY');assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('批量排单若有人重复则整批回滚；员工不能伪造组长排单',async()=>{const f=await fixture();try{
 await f.assign(11);const before=f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n;assert.equal((await f.assign(11,{peopleIds:[103,102]})).status,409);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,before);assert.equal((await f.assign(12,{person:1,allowQueue:true})).status,403);
}finally{await f.close();}});

test('已手选的可排队人员仍按本人历史推荐工序，不自动选忙碌人员',()=>{
 const rules=compileDispatchPredictionRules({generatedAt:'2026-11-04T00:00:00Z',summary:{recordCount:100,period:{from:'2026-01-01',to:'2026-11-03'}},staffProfiles:[{staff:'测试甲',dominantProcess:'P-1',reportCount:100,workOrderCount:10,dominantShare:.95}]});
 const employees=[{blacklakeOperatorId:102,name:'测试甲',available:false,canQueue:true,boundUnitIds:['A-03']}],processes=[{taskId:11,processCode:'P-1',processName:'合缝'}];
 assert.equal(predictProcessForEmployees({rules,employees,processes,selectedEmployeeIds:[102]}).taskId,11);assert.equal(predictDispatch({rules,employees,processes,taskId:11}).candidates.length,0);
});

test('队首的最新默认数未知时保留待开始，不自动用旧计划开工',async()=>{const f=await fixture();try{
 const row=await f.assign(11);f.tasks[0].defaultReportAmount=72;f.tasks[0].plannedAmount=0;const response=await f.start(row.body.assignment.id);assert.equal(response.status,422);assert.equal(f.store.assignmentById(row.body.assignment.id).status,'READY');assert.equal(f.store.assignmentById(row.body.assignment.id).startedAt,null);
}finally{await f.close();}});
