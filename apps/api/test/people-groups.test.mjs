import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {PeopleGroups} from '../src/people-groups.mjs';

async function fixture(){
 const config={sessionSecret:'group-fixture-secret',sessionDays:30,adminApiKey:'group-admin-test-key',adminProxySecret:'group-proxy-test-key',reportingModeAdminOperatorIds:[],agent:{enabled:false}};
 const store=new Store(':memory:',config);
 let people=[{blacklakeOperatorId:101,name:'测试甲',groupNames:['KL工厂']},{blacklakeOperatorId:102,name:'测试乙',groupNames:['KL工厂','后道']},{blacklakeOperatorId:103,name:'测试丙',groupNames:[]},{blacklakeOperatorId:900,name:'测试组长',groupNames:['管理']}];
 const operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(900,{appRole:'floor8_leader'});
 const leaderToken=store.createSession(operators[3].id).token,workerToken=store.createSession(operators[0].id).token;
 const blacklake={listOperators:async()=>people,createOutput:()=>assert.fail('分类操作不得写黑湖产量')};
 const server=createServer(createApp({config,store,blacklake,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{method='GET',body,admin=true,token}={})=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
 const save=(groups,expectedRevision=0)=>call('/v1/admin/people-groups',{method:'PUT',body:{groups,expectedRevision}});
 return {store,call,save,leaderToken,workerToken,setPeople:p=>people=p,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('组长overview返回有序分类及全部位置，仅显示元数据；改序和删除后再次读取同步且不允许匿名',async()=>{
 const f=await fixture();try{
  const groups=[{id:'b',name:'后道',blacklakeOperatorIds:[102]},{id:'empty',name:'空分类',blacklakeOperatorIds:[]},{id:'a',name:'缝制',blacklakeOperatorIds:[101]}];
  assert.equal((await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition:2,expectedRevision:0}})).status,200);
  const read=()=>f.call('/v1/dispatch/overview',{admin:false,token:f.leaderToken});
  const first=await read();assert.equal(first.status,200);assert.deepEqual(first.body.peopleGroupConfig,{revision:1,allPosition:2,groups:groups.map(({id,name})=>({id,name}))});
  assert.deepEqual(first.body.employees.find(e=>e.blacklakeOperatorId===101).departments,['缝制']);
  assert.equal((await f.call('/v1/dispatch/overview',{admin:false})).status,401);
  assert.equal((await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups:[groups[2],groups[0]],allPosition:0,expectedRevision:1}})).status,200);
  const changed=await read();assert.deepEqual(changed.body.peopleGroupConfig,{revision:2,allPosition:0,groups:[{id:'a',name:'缝制'},{id:'b',name:'后道'}]});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,0);
 }finally{await f.close();}
});

test('分类顺序按保存数组持久化，重读与审计保留顺序及空分类，成员/工位不变',async()=>{
 const f=await fixture();try{
  const groups=[{id:'order-a',name:'后道',blacklakeOperatorIds:[101,102]},{id:'order-empty',name:'待安排',blacklakeOperatorIds:[]},{id:'order-b',name:'裁床',blacklakeOperatorIds:[102,103]}];
  const saved=await f.save(groups);assert.equal(saved.status,200);
  const reordered=[groups[2],groups[0],groups[1]],changed=await f.save(reordered,saved.body.revision);assert.equal(changed.status,200);
  assert.deepEqual(changed.body.groups,reordered);assert.deepEqual((await f.call('/v1/admin/people-groups')).body.groups,reordered);
  const event=f.store.db.prepare('SELECT previous_json,next_json FROM dispatch_people_group_events ORDER BY rowid DESC LIMIT 1').get();assert.deepEqual(JSON.parse(event.previous_json),groups);assert.deepEqual(JSON.parse(event.next_json),reordered);
  assert.equal((await f.save(groups,saved.body.revision)).status,409);assert.deepEqual((await f.call('/v1/admin/people-groups')).body.groups,reordered);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,0);assert.deepEqual(f.store.dispatchUnitRecommendations(),[]);
 }finally{await f.close();}
});

test('分类默认继承部门但GET不固化；保存后新增、改名、多分类与删除同步到派工而不删除人员',async()=>{
 const f=await fixture();try{
  const first=await f.call('/v1/admin/people-groups');assert.equal(first.status,200);assert.equal(first.body.managed,false);assert.deepEqual(first.body.groups.map(g=>g.name),['KL工厂','后道']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_people_group_config').get().n,0);
  const sourceId=first.body.groups[0].id;
  const saved=await f.save([{id:sourceId,name:'缝制组',blacklakeOperatorIds:[101,102]},{name:'临时组',blacklakeOperatorIds:[102,103]}]);assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
  const overview=await f.call('/v1/dispatch/overview',{admin:false,token:f.leaderToken});assert.equal(overview.status,200);assert.deepEqual(overview.body.employees.find(p=>p.blacklakeOperatorId===102).departments,['缝制组','临时组']);
  assert.equal(overview.body.employees.length,3);assert.equal(overview.body.employees.some(p=>p.blacklakeOperatorId===900),false);
  assert.equal((await f.save([],1)).status,200);
  const after=await f.call('/v1/dispatch/overview',{admin:false,token:f.leaderToken});assert.equal(after.body.employees.length,3);assert.ok(after.body.employees.every(p=>p.departments.length===0));
  const reload=await f.call('/v1/admin/people-groups');assert.equal(reload.body.managed,true);assert.deepEqual(reload.body.groups,[]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM operators').get().n,4);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_people_group_events').get().n,2);
 }finally{await f.close();}
});

test('分类写入校验保留全部、拒绝重名/非法成员，管理员外的员工或组长均不可管理',async()=>{
 const f=await fixture();try{
  for(const name of ['','全部','全部部门','a'.repeat(41),'组\n名'])assert.equal((await f.save([{name,blacklakeOperatorIds:[]}])).status,422);
  assert.equal((await f.save([{name:'KL',blacklakeOperatorIds:[]},{name:'ｋｌ',blacklakeOperatorIds:[]}])).status,422);
  assert.equal((await f.save([{name:'非法组',blacklakeOperatorIds:[999]}])).status,409);
  assert.equal((await f.save([{name:'组',blacklakeOperatorIds:['101']}])).status,422);
  for(const token of [undefined,f.workerToken,f.leaderToken])for(const method of ['GET','PUT'])assert.equal((await f.call('/v1/admin/people-groups',{admin:false,token,method,...(method==='PUT'?{body:{groups:[],expectedRevision:0}}:{})})).status,401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_people_group_events').get().n,0);
 }finally{await f.close();}
});

test('并发编辑通过版本保护拒绝覆盖；移出的员工保留历史分类关系但不进入当前名单',async()=>{
 const f=await fixture();try{
  const group={id:'custom',name:'自定义',blacklakeOperatorIds:[101,102]};
  const results=await Promise.all([f.save([group]),f.save([{...group,name:'另一管理员'}])]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  f.setPeople([{blacklakeOperatorId:101,name:'测试甲',groupNames:['新上游部门']}]);
  const read=await f.call('/v1/admin/people-groups');assert.deepEqual(read.body.groups[0].blacklakeOperatorIds,[101,102]);assert.equal(read.body.employees.length,1);
  assert.equal((await f.save([{...read.body.groups[0],name:'继续修改'}],1)).status,200);
  assert.equal((await f.save([{name:'新成员',blacklakeOperatorIds:[103]}],2)).status,409);
 }finally{await f.close();}
});

test('分类与删除结果重启后持久保存，审计和版本连续，不改变工位绑定',()=>{
 const dir=mkdtempSync(join(tmpdir(),'people-groups-')),file=join(dir,'test.sqlite'),config={sessionSecret:'test',sessionDays:1};
 try{
  let store=new Store(file,config);store.setDispatchUnitRecommendations('A-01',[101]);let groups=new PeopleGroups(store.db);
  groups.save([{id:'g1',name:'临时',blacklakeOperatorIds:[101]}],0,'admin');groups.save([],1,'admin');store.close();
  store=new Store(file,config);groups=new PeopleGroups(store.db);assert.deepEqual(groups.read().groups,[]);assert.equal(groups.read().revision,2);assert.equal(groups.read().managed,true);
  assert.deepEqual(store.dispatchUnitRecommendations().map(r=>r.blacklakeOperatorId),[101]);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_people_group_events').get().n,2);store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('全部只调整显示位置，普通分类名称/成员与返回数组保持，位置纳入版本和审计',async()=>{
 const f=await fixture();try{
  const groups=[{id:'g-a',name:'缝制',blacklakeOperatorIds:[101]},{id:'g-b',name:'后道',blacklakeOperatorIds:[102,103]}];
  assert.equal((await f.call('/v1/admin/people-groups')).body.allPosition,0);
  const saved=await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition:1,expectedRevision:0}});assert.equal(saved.status,200);assert.equal(saved.body.allPosition,1);assert.deepEqual(saved.body.groups,groups);
  const changed=await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition:2,expectedRevision:1}});assert.equal(changed.status,200);assert.equal((await f.call('/v1/admin/people-groups')).body.allPosition,2);
  const e=f.store.db.prepare('SELECT * FROM dispatch_people_group_events ORDER BY rowid DESC LIMIT 1').get();assert.equal(e.previous_all_position,1);assert.equal(e.next_all_position,2);assert.deepEqual(JSON.parse(e.previous_json),groups);assert.deepEqual(JSON.parse(e.next_json),groups);
  assert.equal((await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition:0,expectedRevision:1}})).status,409);assert.equal((await f.call('/v1/admin/people-groups')).body.allPosition,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);assert.deepEqual(f.store.dispatchUnitRecommendations(),[]);
 }finally{await f.close();}
});

test('全部位置校验、旧请求省略位置的保留与删除后的边界收敛',async()=>{
 const f=await fixture();try{const groups=[{id:'g-a',name:'缝制',blacklakeOperatorIds:[101]}];for(const allPosition of [-1,2,0.5,'1',null])assert.equal((await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition,expectedRevision:0}})).status,422);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM dispatch_people_group_events').get().n,0);
  assert.equal((await f.call('/v1/admin/people-groups',{method:'PUT',body:{groups,allPosition:1,expectedRevision:0}})).status,200);assert.equal((await f.save(groups,1)).body.allPosition,1);assert.equal((await f.save([],2)).body.allPosition,0);
 }finally{await f.close();}
});

test('旧分类表与审计加列默认全部在首位，修改位置重启保留且旧数组可读',()=>{
 const dir=mkdtempSync(join(tmpdir(),'people-all-position-')),file=join(dir,'test.sqlite'),config={sessionSecret:'test',sessionDays:1};let store;
 try{store=new Store(file,config);store.db.exec("CREATE TABLE dispatch_people_group_config(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,groups_json TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE dispatch_people_group_events(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,previous_json TEXT NOT NULL,next_json TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const items=[{id:'old-group',name:'旧分类',blacklakeOperatorIds:[101]}];store.db.prepare("INSERT INTO dispatch_people_group_config(id,revision,groups_json,updated_by) VALUES(1,7,?,'OLD')").run(JSON.stringify(items));store.db.prepare("INSERT INTO dispatch_people_group_events(id,revision,previous_json,next_json,actor) VALUES('old',7,'[]',?,'OLD')").run(JSON.stringify(items));
  const groups=new PeopleGroups(store.db);assert.equal(groups.read().allPosition,0);assert.deepEqual(groups.read().groups,items);assert.equal(store.db.prepare("SELECT next_all_position FROM dispatch_people_group_events WHERE id='old'").get().next_all_position,0);groups.save(items,7,'admin',[],{allPosition:1});store.close();store=new Store(file,config);assert.equal(new PeopleGroups(store.db).read().allPosition,1);assert.deepEqual(JSON.parse(store.db.prepare('SELECT groups_json FROM dispatch_people_group_config').get().groups_json),items);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('位置审计失败回滚分类位置、版本和普通分类数组',()=>{
 const store=new Store(':memory:',{sessionSecret:'all-position-audit'});try{const g=new PeopleGroups(store.db),items=[{id:'g-a',name:'缝制',blacklakeOperatorIds:[101]}];g.save(items,0,'admin');store.db.exec("CREATE TRIGGER fail_group_audit BEFORE INSERT ON dispatch_people_group_events BEGIN SELECT RAISE(ABORT,'TEST AUDIT FAILURE');END");assert.throws(()=>g.save(items,1,'admin',[],{allPosition:1}),/TEST AUDIT FAILURE/);assert.equal(g.read().allPosition,0);assert.equal(g.read().revision,1);assert.deepEqual(g.read().groups,items);}finally{store.close();}
});
