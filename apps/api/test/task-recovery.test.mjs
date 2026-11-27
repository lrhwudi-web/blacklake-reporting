import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";
import { TaskRecovery, shanghaiTime } from "../src/task-recovery.mjs";
import { AppError } from "../src/errors.mjs";

async function fixture() {
  const config={sessionSecret:"task-recovery-test-secret-32-characters",adminApiKey:"task-recovery-admin-key-32-characters",adminProxySecret:"task-recovery-proxy-secret-32-chars",sessionDays:30,reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false}};
  const store=new Store(":memory:",config), people=[{name:"测试员工",blacklakeOperatorId:103,groupNames:[]},{name:"测试组长",blacklakeOperatorId:101,groupNames:[]}];
  const worker=store.upsertBlacklakeOperator(people[0]),leader=store.upsertBlacklakeOperator(people[1]);store.setEntryProfile(101,{appRole:"floor8_leader"});
  const tokens={worker:store.createSession(worker.id).token,leader:store.createSession(leader.id).token};
  let clock=Date.now(),taskError=null,taskStatus=10,taskProjectId=200,reads=0;
  const blacklake={listOperators:async()=>people,findTaskById:async(id,options)=>{reads++;assert.equal(options.fresh,true);if(taskError)throw taskError;return{taskId:id,projectId:taskProjectId,processStatus:taskStatus,plannedAmount:100,reportedGoodAmount:200};}};
  const server=createServer(createApp({config,store,blacklake,wechat:{},now:()=>clock}));await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const call=async(path,{role="admin",method="GET",body,key,headers={}}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{"Content-Type":"application/json",...(role==="admin"?{"X-Admin-Key":config.adminApiKey}:role?{Authorization:"Bearer "+tokens[role]}:{}),...(key?{"Idempotency-Key":key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
  const yesterday=()=>shanghaiTime(clock-86400000).slice(0,10);
  const seed=({id="task-test",status="IN_PROGRESS",station="A-03",machine="",person=worker,publishedAt=yesterday()+" 08:50:00"}={})=>{
    const value=store.dispatchAssignment({id,operatorId:person.id,taskId:100,projectId:200,projectCode:"TEST-WO",productName:"测试产品",processName:"测试工序",quantity:100,stationName:station,machineId:machine,publishedBy:"测试组长",publishedByOperatorId:101,publishedAt,flowCodeHash:"test-flow",quantityPolicy:machine?"SERVER_DEFAULT":"PENDING_REVIEW"});assert(value);
    store.db.prepare("UPDATE assignments SET status=?,started_at=?,ended_at=?,duration_seconds=? WHERE id=?").run(status,status==="READY"?null:yesterday()+" 09:00:00",status==="QUANTITY_PENDING"?shanghaiTime(clock):null,status==="QUANTITY_PENDING"?81000:null,id);return value;
  };
  const detail=async(id="task-test")=>{const r=await call(`/v1/admin/task-recovery/assignments/${id}`);assert.equal(r.status,200);return r.body;};
  const act=async(action,body={},id="task-test",key="recovery_"+randomUUID())=>call(`/v1/admin/task-recovery/assignments/${id}/${action}`,{method:"POST",key,body:{expectedVersion:(await detail(id)).assignment.version,reason:"当面核实漏登记",...body}});
  return{store,config,worker,leader,people,tokens,call,seed,detail,act,yesterday,now:()=>clock,setClock:v=>{clock=v;},taskError:v=>{taskError=v;},taskStatus:v=>{taskStatus=v;},taskProjectId:v=>{taskProjectId=v;},reads:()=>reads,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
const root="/v1/admin/task-recovery";

test("待处理任务有完整分页，优先未完，并按人员/跨日/待开始时长筛选",async()=>{
 const f=await fixture();try{
  f.seed({id:"old-ready",status:"READY"});
  for(let i=0;i<105;i++){const person=f.store.upsertBlacklakeOperator({name:"已完成测试"+i,blacklakeOperatorId:1000+i});f.seed({id:"done-"+i,status:"COMPLETED",person});}
  const all=await f.call(root+"?status=ALL&limit=10");assert.equal(all.body.total,106);assert.equal(all.body.assignments[0].id,"old-ready");assert.equal(all.body.assignments[0].canCancelReady,true);
  const page=await f.call(root+"?status=ALL&limit=10&offset=100");assert.equal(page.body.assignments.length,6);
  const waiting=await f.call(root+"?category=WAITING_LONG&q=测试员工");assert.equal(waiting.body.total,1);
  assert.equal((await f.call(root+"?waitingMinutes=0")).status,422);assert.equal((await f.call(root+"?limit=101")).status,422);
 }finally{await f.close();}
});

test("8楼代完工只进待核量，实际时间生效，审计与幂等回执完整，旧客户端重进可接单",async()=>{
 const f=await fixture();try{
  f.seed();const before=await f.detail(),key="recovery_"+randomUUID(),body={expectedVersion:before.assignment.version,actualEndedAt:f.yesterday()+" 17:00:00",reason:"员工漏点结束，现场核实"};
  const result=await f.call(root+"/assignments/task-test/finish",{method:"POST",key,body});assert.equal(result.status,200);assert.equal(result.body.assignment.status,"QUANTITY_PENDING");assert.equal(result.body.assignment.durationSeconds,23400);assert(!f.store.hasActiveAssignmentForBlacklakeOperator(103));assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n,0);
  const audit=await f.detail();assert.equal(audit.events.length,1);assert.equal(audit.events[0].before.status,"IN_PROGRESS");assert.equal(audit.events[0].after.status,"QUANTITY_PENDING");assert.match(audit.events[0].actor,/^ADMIN:/);
  const repeat=await f.call(root+"/assignments/task-test/finish",{method:"POST",key,body});assert.equal(repeat.status,200);assert.equal(repeat.body.replayed,true);assert.equal((await f.detail()).events.length,1);
  const changed=await f.call(root+"/assignments/task-test/finish",{method:"POST",key,body:{...body,reason:"修改同一请求内容"}});assert.equal(changed.status,409);
  const replay=await f.call(root+"/operations/"+key);assert.equal(replay.body.replayed,true);
  const current=await f.call("/v1/assignments/current",{role:"worker"});assert.equal(current.status,200);assert.equal(current.body.assignment,null);
  const late=await f.call("/v1/assignments/task-test/finish",{role:"worker",method:"POST",key:"legacy_finish_"+randomUUID(),body:{quantityPolicy:"PENDING_REVIEW"}});assert.equal(late.status,200);assert.equal(late.body.replayed,true);assert.equal(late.body.assignment.endedAt,body.actualEndedAt);
 }finally{await f.close();}
});

test("补录结束时间保留前后值，拒绝早于开工/未来/非法日期及篡改参数",async()=>{
 const f=await fixture();try{
  f.seed({status:"QUANTITY_PENDING"});const before=await f.detail();const changed=await f.act("correct-time",{actualEndedAt:f.yesterday()+" 17:00:00"});assert.equal(changed.status,200);assert.equal(changed.body.assignment.durationSeconds,23400);const detail=await f.detail();assert.equal(detail.events[0].before.endedAt,before.assignment.endedAt);assert.equal(detail.events[0].after.endedAt,f.yesterday()+" 17:00:00");
  for(const actualEndedAt of [f.yesterday()+" 08:59:59","2099-01-01 10:00:00","2026-02-31 12:00:00"]){assert.equal((await f.act("correct-time",{actualEndedAt})).status,422);}
  assert.equal((await f.act("correct-time",{actualEndedAt:f.yesterday()+" 16:00:00",quantity:100})).status,422);assert.equal((await f.detail()).events.length,1);
 }finally{await f.close();}
});

test("状态版本保护员工并发完工；待核对/提交中/非8楼/已报量禁止代完工",async()=>{
 const f=await fixture();try{
  f.seed();const stale=(await f.detail()).assignment.version;
  f.store.db.prepare("UPDATE assignments SET status='QUANTITY_PENDING' WHERE id='task-test'").run();
  const r=await f.call(root+"/assignments/task-test/finish",{method:"POST",key:"recovery_"+randomUUID(),body:{expectedVersion:stale,reason:"现场核实漏结束",actualEndedAt:f.yesterday()+" 17:00:00"}});assert.equal(r.status,409);assert.equal((await f.detail()).events.length,0);
  for(const status of ["REPORTING","NEEDS_REVIEW","COMPLETED"]){f.store.db.prepare("UPDATE assignments SET status=? WHERE id='task-test'").run(status);assert.equal((await f.act("finish",{actualEndedAt:f.yesterday()+" 17:00:00"})).status,409);}
  f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',machine_id='3F-01',station_name='' WHERE id='task-test'").run();assert.equal((await f.act("finish",{actualEndedAt:f.yesterday()+" 17:00:00"})).status,409);
  f.store.db.prepare("UPDATE assignments SET machine_id='',station_name='A-03',assignment_mode='SELF_SCAN' WHERE id='task-test'").run();assert.equal((await f.act("finish",{actualEndedAt:f.yesterday()+" 17:00:00"})).status,409);
 }finally{await f.close();}
});

test("后台撤销READY并留原因；员工先开工后旧页面不能撤销",async()=>{
 const f=await fixture();try{
  f.seed({status:"READY"});const version=(await f.detail()).assignment.version;f.store.startDispatchedAssignment("task-test",f.worker.id,shanghaiTime());
  const conflict=await f.call(root+"/assignments/task-test/cancel-ready",{method:"POST",key:"recovery_"+randomUUID(),body:{expectedVersion:version,reason:"误派，尚未生产"}});assert.equal(conflict.status,409);
  f.store.db.prepare("UPDATE assignments SET status='READY',started_at=NULL WHERE id='task-test'").run();const cancelled=await f.act("cancel-ready");assert.equal(cancelled.status,200);assert.equal(cancelled.body.assignment.status,"CANCELLED");assert(!f.store.hasActiveAssignmentForBlacklakeOperator(103));assert.equal((await f.detail()).events[0].action,"ADMIN_CANCEL_READY");
 }finally{await f.close();}
});

test("换绑要求实名核验与先处理活动任务；旧会话撤销，新确认码可走原绑定协议且不落明文审计",async()=>{
 const f=await fixture();try{
  f.store.createOperatorBindingCode({blacklakeOperatorId:103,code:"123456"});const old=f.store.createWechatBindingChallenge("old-test-subject");assert.equal(f.store.completeWechatBinding({challengeToken:old.token,blacklakeOperatorId:103,code:"123456"}).status,"BOUND");
  f.seed({status:"READY"});let context=await f.call(root+"/operators/103");assert.equal(context.body.canRecover,false);
  const key="binding_"+randomUUID(),body=()=>({expectedVersion:context.body.version,reason:"手机损坏，当面核对本人",identityConfirmed:true,confirmedName:"测试员工"});
  assert.equal((await f.call(root+"/operators/103/recover-binding",{method:"POST",key,body:body()})).status,409);
  await f.act("cancel-ready");context=await f.call(root+"/operators/103");
  assert.equal((await f.call(root+"/operators/103/recover-binding",{method:"POST",key,body:{...body(),confirmedName:"其他人"}})).status,422);
  const response=await f.call(root+"/operators/103/recover-binding",{method:"POST",key,body:body()});assert.equal(response.status,200);assert.match(response.body.confirmationCode,/^\d{6}$/);assert.equal(f.store.session(f.tokens.worker),undefined);assert.equal((await f.call(root+"/operators/103")).body.bound,false);
  const event=f.store.db.prepare("SELECT * FROM task_recovery_events WHERE action='ADMIN_RECOVER_BINDING'").get();assert(!event.after_json.includes(response.body.confirmationCode));assert(!f.store.db.prepare("SELECT response_json FROM task_recovery_operations WHERE operation_id=?").get(key).response_json.includes(response.body.confirmationCode));
  const replay=await f.call(root+"/operations/"+key);assert.equal(replay.body.confirmationCode,response.body.confirmationCode);
  const fresh=f.store.createWechatBindingChallenge("new-test-subject");assert.equal(f.store.completeWechatBinding({challengeToken:fresh.token,blacklakeOperatorId:103,code:response.body.confirmationCode}).status,"BOUND");
  const used=await f.call(root+"/operations/"+key);assert.equal(used.body.codeUsed,true);assert.equal(used.body.confirmationCode,"");assert.equal((await f.call(root+"/operators/103")).body.bound,true);
 }finally{await f.close();}
});

test("换绑上下文变化会拒绝操作；过期确认码不再显示",async()=>{
 const f=await fixture();try{
  let context=(await f.call(root+"/operators/103")).body;const body={expectedVersion:context.version,reason:"手机损坏，核对本人",identityConfirmed:true,confirmedName:"测试员工"};const key="binding_"+randomUUID();f.store.createSession(f.worker.id);
  assert.equal((await f.call(root+"/operators/103/recover-binding",{method:"POST",key,body})).status,409);
  context=(await f.call(root+"/operators/103")).body;assert.equal((await f.call(root+"/operators/103/recover-binding",{method:"POST",key,body:{...body,expectedVersion:context.version}})).status,200);
  f.setClock(f.now()+600001);const replay=await f.call(root+"/operations/"+key);assert.equal(replay.body.confirmationCode,"");assert.equal(replay.body.codeExpired,true);
 }finally{await f.close();}
});

test("新接口沿用管理员认证、同源保护，普通员工/组长和伪造字段不可操作",async()=>{
 const f=await fixture();try{
  f.seed();for(const role of [null,"worker","leader"])assert.equal((await f.call(root,{role})).status,401);
  const path=root+"/assignments/task-test/finish",body={expectedVersion:(await f.detail()).assignment.version,reason:"现场核实漏结束",actualEndedAt:f.yesterday()+" 17:00:00"};
  assert.equal((await f.call(path,{method:"POST",body,key:"recovery_"+randomUUID(),headers:{Origin:"https://evil.test"}})).status,403);
  assert.equal((await f.call(path,{method:"POST",body})).status,400);
  assert.equal((await f.call(path,{method:"POST",body:{...body,status:"COMPLETED"},key:"recovery_"+randomUUID()})).status,422);
  assert.equal(f.store.assignmentById("task-test").status,"IN_PROGRESS");
 }finally{await f.close();}
});

test("有活动任务禁止改身份/机台，原值保存允许，任务处置后允许修改",async()=>{
 const f=await fixture();try{
  f.seed({status:"READY"});const path="/v1/admin/operators/103/entry-profile";
  assert.equal((await f.call(path,{method:"PATCH",body:{appRole:"floor8_leader"}})).status,409);assert.equal((await f.call(path,{method:"PATCH",body:{appRole:"employee",workUnitId:"3F-01"}})).status,409);assert.equal((await f.call(path,{method:"PATCH",body:{appRole:"employee"}})).status,200);
  await f.act("cancel-ready");assert.equal((await f.call(path,{method:"PATCH",body:{appRole:"floor8_leader"}})).status,200);
 }finally{await f.close();}
});

test("旧小程序开工前重验黑湖：关闭/删除/查询失败/归属变化均保留READY，达到计划不当关闭",async()=>{
 const f=await fixture();try{
  f.seed({status:"READY"});const start=()=>f.call("/v1/assignments/task-test/start",{role:"worker",method:"POST",body:{}});
  f.taskStatus(20);assert.equal((await start()).status,409);assert.equal(f.store.assignmentById("task-test").status,"READY");
  f.taskStatus(10);f.taskError(new AppError(404,"STATION_PROCESS_NOT_FOUND","test"));assert.equal((await start()).status,409);f.taskError(new Error("network"));assert.equal((await start()).status,503);
  f.taskError(null);f.taskProjectId(999);assert.equal((await start()).status,409);f.taskProjectId(200);f.taskStatus(null);assert.equal((await start()).status,503);f.taskStatus(10);assert.equal((await start()).status,200);assert.equal(f.reads(),6);
 }finally{await f.close();}
});

test("多人同工序开工合并10秒窗口核验，窗口后重新查询黑湖",async()=>{
 const f=await fixture();try{
  f.seed({id:"first",status:"READY"});const other=f.store.upsertBlacklakeOperator({name:"其他员工",blacklakeOperatorId:104});f.seed({id:"second",person:other,status:"READY"});const token=f.store.createSession(other.id).token;
  const first=await f.call("/v1/assignments/first/start",{role:"worker",method:"POST",body:{}});assert.equal(first.status,200);
  const second=await f.call("/v1/assignments/second/start",{role:null,method:"POST",headers:{Authorization:"Bearer "+token},body:{}});assert.equal(second.status,200);assert.equal(f.reads(),1);
  const third=f.store.upsertBlacklakeOperator({name:"第三员工",blacklakeOperatorId:105});f.seed({id:"third",person:third,status:"READY"});const thirdToken=f.store.createSession(third.id).token;f.setClock(f.now()+10001);f.taskStatus(20);
  assert.equal((await f.call("/v1/assignments/third/start",{role:null,method:"POST",headers:{Authorization:"Bearer "+thirdToken},body:{}})).status,409);assert.equal(f.reads(),2);assert.equal(f.store.assignmentById("third").status,"READY");
 }finally{await f.close();}
});

test("审计写入失败整笔代完工回滚，同一请求可在故障解除后恢复",async()=>{
 const f=await fixture();try{
  f.seed();const version=(await f.detail()).assignment.version,key="rollback_"+randomUUID(),body={expectedVersion:version,reason:"本人核实漏结束",actualEndedAt:f.yesterday()+" 17:00:00"};
  f.store.db.exec("CREATE TRIGGER fail_recovery_event BEFORE INSERT ON task_recovery_events BEGIN SELECT RAISE(ABORT,'isolated audit failure');END;");
  assert.equal((await f.call(root+"/assignments/task-test/finish",{method:"POST",key,body})).status,500);assert.equal(f.store.assignmentById("task-test").status,"IN_PROGRESS");assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_recovery_operations").get().n,0);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions").get().n,0);
  f.store.db.exec("DROP TRIGGER fail_recovery_event");assert.equal((await f.call(root+"/assignments/task-test/finish",{method:"POST",key,body})).status,200);
 }finally{await f.close();}
});

test("换绑审计失败时旧绑定、会话和原确认码全部保持",async()=>{
 const f=await fixture();try{
  f.store.createOperatorBindingCode({blacklakeOperatorId:103,code:"123456"});const old=f.store.createWechatBindingChallenge("old-phone-audit-failure");assert.equal(f.store.completeWechatBinding({challengeToken:old.token,blacklakeOperatorId:103,code:"123456"}).status,"BOUND");
  const context=(await f.call(root+"/operators/103")).body;f.store.db.exec("CREATE TRIGGER fail_binding_audit BEFORE INSERT ON task_recovery_events BEGIN SELECT RAISE(ABORT,'isolated binding audit failure');END;");
  const before=f.store.db.prepare("SELECT id,used_at FROM operator_binding_codes ORDER BY id").all();const result=await f.call(root+"/operators/103/recover-binding",{method:"POST",key:"rollback_"+randomUUID(),body:{expectedVersion:context.version,reason:"本人到场，手机损坏",identityConfirmed:true,confirmedName:"测试员工"}});
  assert.equal(result.status,500);assert.equal((await f.call(root+"/operators/103")).body.bound,true);assert(f.store.session(f.tokens.worker));assert.deepEqual(f.store.db.prepare("SELECT id,used_at FROM operator_binding_codes ORDER BY id").all(),before);
 }finally{await f.close();}
});

test("同工位其他员工任务保持占用；处置不修改工位绑定或其他任务",async()=>{
 const f=await fixture();try{
  f.seed();const other=f.store.upsertBlacklakeOperator({name:"其他员工",blacklakeOperatorId:104});f.seed({id:"other-task",person:other});f.store.setDispatchUnitRecommendations("A-03",[103,104]);const bindings=f.store.dispatchUnitRecommendations();
  assert.equal((await f.act("finish",{actualEndedAt:f.yesterday()+" 17:00:00"})).status,200);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE station_name='A-03' AND status IN ('READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW')").get().n,1);assert.equal(f.store.assignmentById("other-task").status,"IN_PROGRESS");assert.deepEqual(f.store.dispatchUnitRecommendations(),bindings);
 }finally{await f.close();}
});


test('后台撤销未开始任务可省略处理原因，仍校验版本并自动留操作人',async()=>{const f=await fixture();try{
 f.seed({status:'READY'});const r=await f.call('/v1/admin/task-recovery/assignments/task-test');const result=await f.call('/v1/admin/task-recovery/assignments/task-test/cancel-ready',{method:'POST',key:'no_reason_cancel_test_001',body:{expectedVersion:r.body.assignment.version}});assert.equal(result.status,200);assert.equal(result.body.assignment.status,'CANCELLED');const detail=await f.call('/v1/admin/task-recovery/assignments/task-test');assert(detail.body.events.length>0);assert(detail.body.events.at(0).actor);
}finally{await f.close();}});
