import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';
const now=Date.parse('2026-11-04T12:00:00+08:00');
async function fixture(){
 const config={sessionSecret:'management-test-only-secret',adminApiKey:'management-test-admin',sessionDays:1,reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false}},store=new Store(':memory:',config);
 const people=[101,103,104].map(id=>store.upsertBlacklakeOperator({name:'测试人员'+id,blacklakeOperatorId:id}));store.setEntryProfile(101,{appRole:'floor8_leader'});
 const tokens=Object.fromEntries(people.map(p=>[p.blacklakeOperatorId,store.createSession(p.id).token]));let seq=0,writes=0,reads=0;
 const task={taskId:100,projectId:200,projectCode:'TEST-MANAGEMENT',productName:'测试产品',processName:'测试缝制',processStatus:10,plannedAmount:100,defaultReportAmount:100,reportedGoodAmount:0};const tasks=new Map([[100,task]]);
 const blacklake={listProjectTasks:async()=>[...tasks.values()],listWorkOrderProcesses:async()=>[...tasks.values()],findTaskById:async id=>{reads++;return tasks.get(Number(id));},findWorkOrderProcess:async(_code,id)=>tasks.get(Number(id)),createOutput:async()=>{writes++;return{id:'TEST-OUTPUT'};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{},defectReasons:[],now:()=>now}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{method='GET',body,key='management-operation-000001',admin=true,headers={}}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[103]}),...(method==='POST'?{'Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const seed=({id='task-'+(++seq),employeeId=103,status='READY',publishedAt='2026-11-04 08:00:00',owner=101,taskId=100+seq}={})=>{const person=people.find(p=>p.blacklakeOperatorId===employeeId),t={...task,taskId};tasks.set(taskId,t);const row=store.dispatchAssignment({id,operatorId:person.id,...t,quantity:100,stationName:'A-03',publishedAt,publishedBy:'测试组长',publishedByOperatorId:owner,flowCodeHash:'fixture'},{allowQueue:true});store.db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status,row.id);return row;};
 const detail=async id=>(await call('/v1/admin/management/tasks/'+id)).body;
 return{store,people,tokens,call,seed,detail,blacklake,tasks,writes:()=>writes,reads:()=>reads,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('管理接口管理员鉴权、日期边界和跨站写入保护',async()=>{const f=await fixture();try{
 assert.equal((await f.call('/v1/admin/management/people',{admin:false})).status,401);
 assert.equal((await f.call('/v1/admin/management/tasks?from=2026-02-30')).status,422);
 assert.equal((await f.call('/v1/admin/management/tasks?from=2026-11-05&to=2026-11-01')).status,422);
 assert.equal((await f.call('/v1/admin/management/tasks?limit=101')).status,422);
 assert.equal((await f.call('/v1/admin/management/people/103/queue',{method:'POST',headers:{origin:'https://evil.example'},body:{}})).status,403);
 }finally{await f.close();}});

test('员工和派工人查询从完整本地库分页，超过300条仍可按日期状态精确查到',async()=>{const f=await fixture();try{
 for(let i=0;i<315;i++)f.seed({id:'old-'+String(i).padStart(3,'0'),status:'COMPLETED',publishedAt:'2025-01-02 08:00:00',taskId:1000+i});f.seed({id:'new',employeeId:104,owner:999});
 const first=await f.call('/v1/admin/management/tasks?employeeId=103&dispatcherId=101&from=2025-01-01&to=2025-01-02&limit=100&status=COMPLETED');assert.equal(first.status,200);assert.equal(first.body.total,315);assert.equal(first.body.assignments.length,100);assert.equal(first.body.coverage.completeWithinScope,true);assert.match(first.body.coverage.scopeDescription,/不等于全厂/);
 const last=await f.call('/v1/admin/management/tasks?employeeId=103&from=2025-01-01&to=2025-01-02&limit=100&offset=300');assert.equal(last.body.assignments.length,15);assert(last.body.assignments.some(r=>r.id==='old-000'));
 assert.equal((await f.call('/v1/admin/management/tasks?employeeId=104&from=2025-01-01&to=2025-01-02')).body.total,0);
 }finally{await f.close();}});

test('任务、员工、派工人及当前队列可关联，详情保留原派工人与版本',async()=>{const f=await fixture();try{f.seed({id:'ready'});f.seed({id:'old-active',status:'IN_PROGRESS',employeeId:104,publishedAt:'2025-01-01 08:00:00'});
 const row=await f.detail('ready');assert.equal(row.assignment.publishedByOperatorId,101);assert.equal(row.assignment.blacklakeOperatorId,103);assert.equal(row.assignment.canReassign,true);assert(row.assignment.version);
 const person=await f.call('/v1/admin/management/people/104');assert.equal(person.body.current[0].id,'old-active');assert.equal((await f.call('/v1/admin/management/people')).body.people.length,3);
 }finally{await f.close();}});

test('漏报通过业务工单号查询可用工序，不要求管理员输入内部任务ID且拒绝歧义工单',async()=>{const f=await fixture();try{
 f.tasks.set(101,{...f.tasks.get(100),taskId:101,processStatus:20});f.tasks.set(102,{...f.tasks.get(100),taskId:102,projectCode:'OTHER'});
 const r=await f.call('/v1/admin/management/work-orders/options?code=TEST-MANAGEMENT');assert.equal(r.status,200);assert.equal(r.body.flowCode,'projectId=200');assert.deepEqual(r.body.processes.map(r=>r.taskId),[100]);
 f.tasks.set(103,{...f.tasks.get(100),taskId:103,projectId:999});assert.equal((await f.call('/v1/admin/management/work-orders/options?code=TEST-MANAGEMENT')).status,409);
 }finally{await f.close();}});

test('停用员工保留历史查询但不能被选为改派目标',async()=>{const f=await fixture();try{
 f.seed({id:'old',status:'COMPLETED',employeeId:104});f.store.db.prepare('UPDATE operators SET active=0 WHERE blacklake_operator_id=104').run();assert.equal((await f.call('/v1/admin/management/people/104')).status,200);
 f.seed({id:'moving'});const d=await f.detail('moving');const r=await f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',body:{employeeId:104,unitId:'A-04',expectedVersion:d.assignment.version,reason:'停用人员不能接单'}});assert.equal(r.status,409);
 }finally{await f.close();}});

test('待开始改派保留原派工人/时间，进入目标队尾且幂等回放不重复审计或上游读取',async()=>{const f=await fixture();try{f.seed({id:'moving',taskId:101});f.seed({id:'target-first',employeeId:104,taskId:102});const old=f.store.assignmentById('moving'),d=await f.detail('moving');
 const body={expectedVersion:d.assignment.version,employeeId:104,unitId:'A-04',reason:'人员安排调整'};const first=await f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',body});assert.equal(first.status,200);assert.equal(first.body.assignment.blacklakeOperatorId,104);assert.equal(first.body.assignment.publishedByOperatorId,101);assert.equal(first.body.assignment.publishedAt,old.publishedAt);
 assert.deepEqual(f.store.activeAssignments(f.people[2].id).map(r=>r.id),['target-first','moving']);assert.equal((await f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',body})).status,200);assert.equal(f.reads(),1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_recovery_events WHERE action='ADMIN_REASSIGN_READY'").get().n,1);assert.equal(f.writes(),0);
 assert.equal((await f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',body:{...body,reason:'修改了内容'}})).status,409);
 }finally{await f.close();}});

test('改派拒绝已开工、过期版本、组长作为员工、重复任务、上游关闭和查询失败',async()=>{const f=await fixture();try{
 f.seed({id:'moving',taskId:101});const version=(await f.detail('moving')).assignment.version;const post=(extra,key='management-reassign-check-0001')=>f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',key,body:{expectedVersion:version,employeeId:104,unitId:'A-04',reason:'测试改派约束',...extra}});
 assert.equal((await post({employeeId:101})).status,409);assert.equal((await post({expectedVersion:'old'})).status,409);
 f.seed({id:'duplicate',employeeId:104,taskId:101});assert.equal((await post({})).status,409);f.store.db.prepare("UPDATE assignments SET status='CANCELLED' WHERE id='duplicate'").run();
 f.tasks.get(101).processStatus=20;assert.equal((await post({})).status,409);f.tasks.get(101).processStatus=10;
 f.blacklake.findTaskById=async()=>{throw Error('offline');};assert.equal((await post({})).status,503);
 f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',started_at='2026-11-04 09:00:00' WHERE id='moving'").run();assert.equal((await post({})).status,409);assert.equal(f.writes(),0);
 }finally{await f.close();}});

test('改派审计失败整笔回滚，不改变人员和目标队列',async()=>{const f=await fixture();try{f.seed({id:'moving'});const d=await f.detail('moving');f.store.db.exec("CREATE TRIGGER reject_management_event BEFORE INSERT ON task_recovery_events BEGIN SELECT RAISE(ABORT,'test unavailable');END;");
 const r=await f.call('/v1/admin/management/tasks/moving/reassign',{method:'POST',body:{expectedVersion:d.assignment.version,employeeId:104,unitId:'A-04',reason:'测试审计失败'}});assert.equal(r.status,500);assert.equal(f.store.assignmentById('moving').operatorId,f.people[1].id);assert.equal(f.store.activeAssignments(f.people[2].id).length,0);
 }finally{await f.close();}});

test('完整待做队列调整顺序真正影响员工展示及开工约束，新派工排末尾',async()=>{const f=await fixture();try{f.seed({id:'first',taskId:101});f.seed({id:'second',taskId:102});const current=(await f.call('/v1/admin/management/people/103')).body.queue;
 const body={expectedVersion:current.version,assignmentIds:['second','first'],reason:'急单优先生产'};assert.equal((await f.call('/v1/admin/management/people/103/queue',{method:'POST',body})).status,200);
 f.seed({id:'new',taskId:103});assert.deepEqual(f.store.activeAssignments(f.people[1].id).map(r=>r.id),['second','first','new']);assert.throws(()=>f.store.startDispatchedAssignment('first',f.people[1].id,'2026-11-04 10:00:00'),/请先完成排在前面的任务/);
 assert.equal(f.store.startDispatchedAssignment('second',f.people[1].id,'2026-11-04 10:00:00').status,'IN_PROGRESS');assert.equal(f.writes(),0);
 }finally{await f.close();}});

test('队列排序拒绝过期、缺项、重复、他人任务及未知结果占用',async()=>{const f=await fixture();try{f.seed({id:'one',taskId:101});f.seed({id:'two',taskId:102});f.seed({id:'other',employeeId:104,taskId:103});let q=(await f.call('/v1/admin/management/people/103')).body.queue;
 for(const ids of [['one'],['one','one'],['one','other']])assert.equal((await f.call('/v1/admin/management/people/103/queue',{method:'POST',body:{expectedVersion:q.version,assignmentIds:ids,reason:'测试排序约束'}})).status,409);
 f.seed({id:'added',taskId:104});assert.equal((await f.call('/v1/admin/management/people/103/queue',{method:'POST',body:{expectedVersion:q.version,assignmentIds:['two','one'],reason:'队列过期'}})).status,409);
 f.store.db.prepare("UPDATE assignments SET status='NEEDS_REVIEW' WHERE id='added'").run();q=(await f.call('/v1/admin/management/people/103')).body.queue;assert.equal((await f.call('/v1/admin/management/people/103/queue',{method:'POST',body:{expectedVersion:q.version,assignmentIds:['two','one'],reason:'结果未知'}})).status,409);
 }finally{await f.close();}});

test('漏报补登记实际起止及工时，仅进入待核量，不自动提交；重复回执不造第二笔',async()=>{const f=await fixture();try{
 const body={employeeId:103,flowCode:'projectId=200',taskId:100,unitId:'A-03',actualStartedAt:'2026-11-04T08:00',actualEndedAt:'2026-11-04T09:00',reason:'员工忘记扫码登记'};
 const r=await f.call('/v1/admin/management/tasks/missing',{method:'POST',body});assert.equal(r.status,201);assert.equal(r.body.assignment.status,'QUANTITY_PENDING');assert.equal(r.body.assignment.durationSeconds,3600);assert.equal(f.writes(),0);
 const repeated=await f.call('/v1/admin/management/tasks/missing',{method:'POST',body});assert.equal(repeated.body.assignment.id,r.body.assignment.id);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,1);
 const quantity=await f.call('/v1/admin/task-recovery/assignments/'+r.body.assignment.id+'/quantity',{method:'POST',key:'management-quantity-confirm-0001',body:{expectedVersion:r.body.assignment.version,reason:'现场核对实际完成数量',quantity:60,defectQuantity:0,defectCodes:[]}});assert.equal(quantity.status,200);assert.equal(quantity.body.assignment.status,'COMPLETED');assert.equal(f.writes(),1);
 }finally{await f.close();}});

test('漏报补登记拒绝时间重叠、未来/无效时间及关闭工序，不造测试产量',async()=>{const f=await fixture();try{
 const body={employeeId:103,flowCode:'projectId=200',taskId:100,unitId:'A-03',actualStartedAt:'2026-11-04T08:00',actualEndedAt:'2026-11-04T09:00',reason:'测试补登记边界'};
 for(const extra of [{actualEndedAt:'2026-11-05T09:00'},{actualStartedAt:'2026-02-30T08:00'},{actualEndedAt:'2026-11-04T07:00'}])assert.equal((await f.call('/v1/admin/management/tasks/missing',{method:'POST',body:{...body,...extra}})).status,422);
 f.tasks.get(100).processStatus=null;assert.equal((await f.call('/v1/admin/management/tasks/missing',{method:'POST',body})).status,409);f.tasks.get(100).processStatus=10;
 f.seed({id:'existing',status:'IN_PROGRESS',taskId:101});f.store.db.prepare("UPDATE assignments SET started_at='2026-11-04 08:30:00' WHERE id='existing'").run();assert.equal((await f.call('/v1/admin/management/tasks/missing',{method:'POST',body})).status,409);assert.equal(f.writes(),0);
 }finally{await f.close();}});

test('已提交误报登记更正事项及外部处理凭据，原报工不被覆盖、不自动重报',async()=>{const f=await fixture();try{
 f.seed({id:'reported'});f.store.insertPendingReport({id:'report-1',idempotencyKey:'original-report-key',requestHash:'original-hash',operatorId:f.people[1].id,taskId:100,projectId:200,projectCode:'TEST-MANAGEMENT',productName:'测试产品',processName:'测试缝制',amount:50,goodAmount:50,defectAmount:0,defectCode:'',outputTime:'2026-11-04 09:00:00'});f.store.markReportSucceeded('original-report-key','OUTPUT-OLD');f.store.db.prepare("UPDATE assignments SET status='COMPLETED',report_id='report-1',started_at='2026-11-04 08:00:00',ended_at='2026-11-04 09:00:00',good_quantity=50 WHERE id='reported'").run();
 const before=f.store.db.prepare('SELECT * FROM reports').get(),detail=await f.detail('reported');const r=await f.call('/v1/admin/management/tasks/reported/corrections',{method:'POST',body:{expectedVersion:detail.assignment.version,reason:'原数量多填十件',goodQuantity:40,defectQuantity:0}});assert.equal(r.status,201);assert.equal(r.body.upstreamChanged,false);
 const c=(await f.detail('reported')).corrections[0];const body={expectedVersion:c.version,reason:'黑湖已人工更正并核对',evidence:'已由管理员在黑湖核对修正为合格四十件',blacklakeOutputId:'OUTPUT-CORRECTED',confirmedExternally:true};
 assert.equal((await f.call('/v1/admin/management/corrections/'+c.id+'/resolve',{method:'POST',key:'management-correction-resolve-0001',body:{...body,confirmedExternally:false}})).status,422);
 const done=await f.call('/v1/admin/management/corrections/'+c.id+'/resolve',{method:'POST',key:'management-correction-resolve-0001',body});assert.equal(done.status,200);assert.equal(done.body.verifiedAutomatically,false);assert.equal((await f.detail('reported')).corrections[0].status,'EXTERNAL_RECORDED');assert.deepEqual(f.store.db.prepare('SELECT * FROM reports').get(),before);assert.equal(f.writes(),0);
 }finally{await f.close();}});


test('改派不要求手写处理原因，操作人及修改前后值仍留档',async()=>{const f=await fixture();try{
 const row=f.seed({id:'no-reason-move'}),before=await f.detail(row.id);const result=await f.call('/v1/admin/management/tasks/'+row.id+'/reassign',{method:'POST',body:{expectedVersion:before.assignment.version,employeeId:104,unitId:'A-04'}});assert.equal(result.status,200);const detail=await f.detail(row.id);assert.equal(detail.assignment.blacklakeOperatorId,104);assert(detail.events.some(e=>e.action==='ADMIN_REASSIGN_READY'&&e.actor));
}finally{await f.close();}});
