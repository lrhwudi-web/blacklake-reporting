import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function fixture(){
 const config={sessionSecret:'dispatch-owner-test-only',adminApiKey:'dispatch-owner-admin-test',sessionDays:1,reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false}},store=new Store(':memory:',config);
 const people=[101,102,201,202].map((id,index)=>store.upsertBlacklakeOperator({name:index<2?'同名组长':'同名主管',blacklakeOperatorId:id}));
 for(const person of people)store.setEntryProfile(person.blacklakeOperatorId,{appRole:person.blacklakeOperatorId<200?'floor8_leader':'floor3_supervisor'});
 const tokens=Object.fromEntries(people.map(p=>[p.blacklakeOperatorId,store.createSession(p.id).token]));
 const server=createServer(createApp({config,store,blacklake:{},wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));let next=1000;
 const seed=({id,owner=101,status='READY',date=today(),unit='A-03',name='同名组长',person}={})=>{
  const worker=person||store.upsertBlacklakeOperator({name:'测试员工'+(++next),blacklakeOperatorId:next});
  const row=store.dispatchAssignment({id:id||'owner-task-'+(++next),operatorId:worker.id,taskId:++next,projectId:200,projectCode:'TEST-OWNER',productName:'测试产品',processName:'测试工序',quantity:100,stationName:unit.startsWith('3F-')?'':unit,machineId:unit.startsWith('3F-')?unit:'',publishedBy:name,publishedByOperatorId:owner,publishedAt:date+' 12:00:00',flowCodeHash:'owner-fixture'},{allowQueue:true});
  store.db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status,row.id);return store.assignmentById(row.id);
 };
 const call=async(path,{owner=101,admin=false,method='GET',body}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[owner]})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 return{store,people,tokens,seed,call,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('同名同楼层组长派工列表、总数、截断和跨日未结束记录均按本人ID隔离',async()=>{
 const f=await fixture();try{
  f.seed({id:'own-today'});f.seed({id:'own-old',date:'2000-01-01',status:'IN_PROGRESS'});f.seed({id:'own-pending',date:'2000-01-01',status:'QUANTITY_PENDING'});
  f.seed({id:'other-today',owner:102});f.seed({id:'other-old',owner:102,date:'2000-01-01'});f.seed({id:'unknown',owner:null});f.seed({id:'own-other-floor',unit:'3F-01'});
  for(const query of ['includeActive=true','includeActive=true&publishedByOperatorId=102&ownerId=102&dispatcherId=102']){
   const result=await f.call('/v1/dispatch/history?'+query);assert.equal(result.status,200);assert.equal(result.body.total,3);assert.deepEqual(result.body.assignments.map(r=>r.id).sort(),['own-old','own-pending','own-today']);
  }
  const limited=await f.call('/v1/dispatch/history?includeActive=true&limit=1');assert.equal(limited.body.total,3);assert.equal(limited.body.assignments.length,1);assert.equal(limited.body.truncated,true);
  assert.deepEqual((await f.call('/v1/dispatch/history')).body.assignments.map(r=>r.id),['own-today']);
  assert.deepEqual((await f.call('/v1/dispatch/history?includeActive=true',{owner:102})).body.assignments.map(r=>r.id).sort(),['other-old','other-today']);
 }finally{await f.close();}
});

test('3楼主管同样按本人ID隔离，并继续受楼层限制',async()=>{
 const f=await fixture();try{f.seed({id:'first-supervisor',owner:201,unit:'3F-01'});f.seed({id:'second-supervisor',owner:202,unit:'3F-02'});f.seed({id:'wrong-floor',owner:201});
  assert.deepEqual((await f.call('/v1/dispatch/history',{owner:201})).body.assignments.map(r=>r.id),['first-supervisor']);
  assert.deepEqual((await f.call('/v1/dispatch/history',{owner:202})).body.assignments.map(r=>r.id),['second-supervisor']);
 }finally{await f.close();}
});

test('改名不丢本人历史，缺少归属不按同名归给组长，管理员仍可处理全部任务',async()=>{
 const f=await fixture();try{f.seed({id:'own-before-rename'});f.seed({id:'null-owner',owner:null});f.seed({id:'zero-owner',owner:0});f.seed({id:'other-owner',owner:102});
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:101,name:'更名后的组长'});
  const own=await f.call('/v1/dispatch/history');assert.deepEqual(own.body.assignments.map(r=>r.id),['own-before-rename']);
  const admin=await f.call('/v1/admin/task-recovery',{admin:true});assert.equal(admin.status,200);assert.equal(admin.body.assignments.length,4);
 }finally{await f.close();}
});

test('猜测他人派工ID不能撤销或探测状态，伪造派工人参数不生效，本人撤销照常审计',async()=>{
 const f=await fixture();try{f.seed({id:'own'});for(const [i,status]of ['READY','IN_PROGRESS','COMPLETED'].entries()){
  const row=f.seed({id:'other-'+i,owner:102,status});const result=await f.call('/v1/dispatch/assignments/'+row.id+'/cancel',{method:'POST',body:{reason:'误派',publishedByOperatorId:102,actor:'DISPATCHER:102:伪造'}});
  assert.equal(result.status,404);assert.equal(result.body.error.code,'ASSIGNMENT_NOT_FOUND');assert.equal(f.store.assignmentById(row.id).status,status);
 }
 const unknown=f.seed({id:'unknown-owner',owner:null});assert.equal((await f.call('/v1/dispatch/assignments/'+unknown.id+'/cancel',{method:'POST',body:{reason:'误派'}})).status,404);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignment_actions').get().n,0);
 const own=await f.call('/v1/dispatch/assignments/own/cancel',{method:'POST',body:{reason:'本人误派',actor:'伪造'}});assert.equal(own.status,200);assert.equal(own.body.assignment.status,'CANCELLED');
 assert.equal(f.store.db.prepare('SELECT actor FROM assignment_actions').get().actor,'DISPATCHER:101:同名组长');
 }finally{await f.close();}
});

test('撤销事务二次校验归属，鉴权后归属变化也不能误撤销',async()=>{
 const f=await fixture();try{f.seed({id:'race'});const cancel=f.store.cancelDispatchedAssignment.bind(f.store);
  f.store.cancelDispatchedAssignment=input=>{f.store.db.prepare('UPDATE assignments SET published_by_operator_id=102 WHERE id=?').run(input.id);return cancel(input);};
  const result=await f.call('/v1/dispatch/assignments/race/cancel',{method:'POST',body:{reason:'测试竞争'}});assert.equal(result.status,409);assert.equal(f.store.assignmentById('race').status,'READY');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignment_actions').get().n,0);
 }finally{await f.close();}
});

test('数据层缺少有效派工人ID时拒绝读取与撤销，员工仍能收到不同组长的任务',async()=>{
 const f=await fixture();try{
  const worker=f.store.upsertBlacklakeOperator({blacklakeOperatorId:9001,name:'共享接单员工'});f.tokens[9001]=f.store.createSession(worker.id).token;
  f.seed({id:'from-first',person:worker});f.seed({id:'from-second',owner:102,person:worker});
  const rows=await f.call('/v1/assignments/current',{owner:9001});assert.equal(rows.status,200);assert.deepEqual(rows.body.assignments.map(r=>r.id).sort(),['from-first','from-second']);
  for(const owner of [undefined,null,0,-1,'bad']){
   assert.equal(f.store.dispatchHistory({unitIds:['A-03'],from:today()+' 00:00:00',to:'2999-01-01',publishedByOperatorId:owner}).total,0);
   assert.equal(f.store.cancelDispatchedAssignment({id:'from-first',unitIds:['A-03'],reason:'测试',actor:'伪造',endedAt:today()+' 13:00:00',publishedByOperatorId:owner}),undefined);
  }
 }finally{await f.close();}
});

test('重启不再通过唯一姓名为缺失归属的旧记录猜测派工人',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dispatch-owner-')),file=join(directory,'test.sqlite'),config={sessionSecret:'owner-reopen-test'};let store;
 try{store=new Store(file,config);const person=store.upsertBlacklakeOperator({blacklakeOperatorId:101,name:'唯一姓名组长'}),worker=store.upsertBlacklakeOperator({blacklakeOperatorId:102,name:'测试员工'});
  store.dispatchAssignment({id:'legacy',operatorId:worker.id,taskId:1,projectId:2,projectCode:'TEST',productName:'测试产品',processName:'测试',quantity:1,stationName:'A-03',publishedBy:person.name,publishedAt:today()+' 12:00:00',flowCodeHash:'fixture'});store.close();
  store=new Store(file,config);assert.equal(store.db.prepare('SELECT published_by_operator_id AS owner FROM assignments WHERE id=?').get('legacy').owner,null);
 }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});


test('本人撤销待开始派工无需填写原因，归属限制及操作审计保留',async()=>{const f=await fixture();try{
 const row=f.seed();const result=await f.call('/v1/dispatch/assignments/'+row.id+'/cancel',{method:'POST',body:{}});assert.equal(result.status,200);assert.equal(result.body.assignment.status,'CANCELLED');
 const stored=f.store.db.prepare('SELECT cancellation_reason FROM assignments WHERE id=?').get(row.id);assert.equal(stored.cancellation_reason,'');const audit=f.store.db.prepare('SELECT actor FROM assignment_actions WHERE assignment_id=? ORDER BY rowid DESC LIMIT 1').get(row.id);assert.match(audit.actor,/101/);
}finally{await f.close();}});
