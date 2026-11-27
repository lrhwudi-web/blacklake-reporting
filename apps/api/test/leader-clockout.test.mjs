import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {PeopleGroups,validatePeopleGroups} from '../src/people-groups.mjs';
import {LeaderClockout,nextClockout,startClockoutScheduler} from '../src/leader-clockout.mjs';
import {createApp} from '../src/app.mjs';

function fixture(){
  const config={sessionSecret:'clockout-isolated-test',sessionDays:1,agent:{enabled:false}},store=new Store(':memory:',config),groups=new PeopleGroups(store.db);
  const people=[101,102,201,202,203,204,205].map(id=>store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'测试-'+id}));
  store.setEntryProfile(101,{appRole:'floor8_leader'});store.setEntryProfile(102,{appRole:'floor8_leader'});
  groups.save([{id:'team-a',name:'一组',blacklakeOperatorIds:[201,202],leaderIds:[101]},{id:'team-b',name:'二组',blacklakeOperatorIds:[202,203],leaderIds:[101]},{id:'team-c',name:'三组',blacklakeOperatorIds:[204],leaderIds:[102]}],0,'test');
  let at=Date.parse('2026-11-11T17:59:00+08:00'),serial=0;
  const service=new LeaderClockout({store,now:()=>at});
  function seed(workerId,status='IN_PROGRESS',{owner=101,paused=false}={}){
    const id='task-'+(++serial),operator=people.find(person=>person.blacklakeOperatorId===workerId);
    store.dispatchAssignment({id,operatorId:operator.id,taskId:serial,projectId:501,projectCode:'TEST',productName:'测试',processName:'工序',quantity:100,stationName:'A-01',publishedByOperatorId:owner,publishedBy:'测试组长',publishedAt:'2026-11-11 16:00:00',flowCodeHash:'test'},{allowQueue:true});
    store.db.prepare('UPDATE assignments SET status=?,started_at=? WHERE id=?').run(status,status==='READY'?null:'2026-11-11 17:00:00',id);
    if(paused)store.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at) VALUES(?,?)').run(id,'2026-11-11 17:10:00');
    return id;
  }
  const key=(suffix='manual')=>'clockout-test-operation-'+suffix;
  return {config,store,groups,service,people,seed,key,now:()=>at,setTime:value=>{at=Date.parse(value);},close:()=>store.close()};
}

test('分类绑定跨派工组长、去重成员；原子暂停且保留数量/起止/报工，重复请求不重复计时',()=>{
  const f=fixture();try{
    const own=f.seed(201),otherLeader=f.seed(202,'IN_PROGRESS',{owner:102}),paused=f.seed(203,'IN_PROGRESS',{paused:true}),outside=f.seed(204),ready=f.seed(201,'READY');
    const before=f.service.preview(101);assert.equal(before.employeeCount,3);assert.equal(before.taskCount,2);assert.equal(before.alreadyPausedCount,1);
    const result=f.service.pause(101,{expectedVersion:before.version},f.key());assert.equal(result.pausedCount,2);assert.equal(result.employeeCount,2);
    for(const id of [own,otherLeader]){const task=f.store.assignmentById(id);assert.equal(task.paused,true);assert.equal(task.status,'IN_PROGRESS');assert.equal(task.startedAt,'2026-11-11 17:00:00');assert.equal(task.quantity,100);assert.equal(task.endedAt,null);assert.equal(task.reportId,null);}
    assert.equal(f.store.assignmentPauses(paused).length,1);assert.equal(f.store.assignmentById(outside).paused,false);assert.equal(f.store.assignmentById(ready).status,'READY');
    assert.deepEqual(f.service.pause(101,{expectedVersion:before.version},f.key()),result);assert.equal(f.store.assignmentPauses(own).length,1);
    assert.equal(f.service.preview(101).taskCount,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
    const manifest=f.service.preview(101);assert.equal(manifest.pausedTasks.length,2);assert.equal(manifest.pausedTasksTruncated,false);assert(manifest.pausedTasks.some(task=>task.id===otherLeader));assert(!f.service.preview(102).pausedTasks.some(task=>task.id===otherLeader));
  }finally{f.close();}
});

test('提交中/待核量/未知结果、已结束以及已停用员工不会被暂停',()=>{
  const f=fixture();try{
    const running=f.seed(201);f.seed(202,'REPORTING');f.seed(203,'NEEDS_REVIEW');f.seed(201,'QUANTITY_PENDING');f.seed(202,'COMPLETED');
    f.store.db.prepare('UPDATE operators SET active=0 WHERE blacklake_operator_id=201').run();
    const view=f.service.preview(101);assert.equal(view.taskCount,0);assert.equal(view.protectedCount,2);assert.equal(f.service.pause(101,{expectedVersion:view.version},f.key()).pausedCount,0);assert.equal(f.store.assignmentPauses(running).length,0);
  }finally{f.close();}
});

test('两个组长的定时、同名操作标识、下班回执和负责分类互相独立',()=>{
  const f=fixture();try{
    const first=f.seed(201),second=f.seed(204,'IN_PROGRESS',{owner:102}),key=f.key('same-owner-independent');
    f.service.saveSchedule(101,{expectedRevision:0,enabled:true,time:'18:00',days:[1,2,3,4,5]},key);
    f.service.saveSchedule(102,{expectedRevision:0,enabled:true,time:'19:00',days:[6,7]},key);
    assert.equal(f.service.preview(101).schedule.time,'18:00');assert.equal(f.service.preview(102).schedule.time,'19:00');
    const secondVersion=f.service.preview(102).version;
    f.service.pause(101,{expectedVersion:f.service.preview(101).version},f.key('same-pause'));
    assert.equal(f.store.assignmentById(first).paused,true);assert.equal(f.store.assignmentById(second).paused,false);assert.equal(f.service.preview(102).lastRun,null);assert.equal(f.service.preview(102).version,secondVersion);
    f.service.pause(102,{expectedVersion:secondVersion},f.key('same-pause'));
    assert.deepEqual(f.service.preview(101).pausedTasks.map(row=>row.id),[first]);assert.deepEqual(f.service.preview(102).pausedTasks.map(row=>row.id),[second]);
    assert.equal(f.store.assignmentPauses(first).length,1);assert.equal(f.store.assignmentPauses(second).length,1);
  }finally{f.close();}
});

test('分类/任务变化拦截旧确认；数据库故障全量回滚，不留部分暂停',()=>{
  const f=fixture();try{
    const a=f.seed(201),before=f.service.preview(101);f.seed(202);
    assert.throws(()=>f.service.pause(101,{expectedVersion:before.version},f.key()),{code:'CLOCKOUT_SCOPE_CHANGED'});assert.equal(f.store.assignmentPauses(a).length,0);
    f.store.db.exec(`CREATE TRIGGER fail_pause BEFORE INSERT ON assignment_pauses WHEN NEW.assignment_id='task-2' BEGIN SELECT RAISE(ABORT,'isolated failure'); END`);
    assert.throws(()=>f.service.pause(101,{expectedVersion:f.service.preview(101).version},f.key('rollback')));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM leader_clockout_runs').get().n,0);
  }finally{f.close();}
});

test('后台绑定校验组长身份，旧客户端保存/排序不丢绑定，移除分类即时撤权',()=>{
  const f=fixture();try{
    assert.throws(()=>validatePeopleGroups([{name:'新组',blacklakeOperatorIds:[201],leaderIds:[201]}],new Set([201]),new Set([101])),{code:'PEOPLE_GROUP_LEADER_UNAVAILABLE'});
    const old=f.groups.read(),legacy=old.groups.map(({leaderIds,...group})=>group);f.groups.save(legacy,old.revision,'old-client');
    assert.deepEqual(f.groups.read().groups[0].leaderIds,[101]);
    const view=f.service.preview(101),latest=f.groups.read();f.groups.save(latest.groups.filter(group=>group.id==='team-c'),latest.revision,'test');
    assert.equal(f.service.preview(101).groups.length,0);assert.throws(()=>f.service.pause(101,{expectedVersion:view.version},f.key()),{code:'CLOCKOUT_TEAM_MISSING'});
  }finally{f.close();}
});

test('定时保存幂等/版本、北京时间跨日和每周规则，不隐式开启',()=>{
  const f=fixture();try{
    assert.equal(f.service.preview(101).schedule.enabled,false);
    const input={expectedRevision:0,enabled:true,time:'18:00',days:[1,2,3,4,5]},saved=f.service.saveSchedule(101,input,f.key('schedule'));
    assert.equal(saved.nextRunAt,'2026-11-11 18:00:00');assert.deepEqual(f.service.saveSchedule(101,input,f.key('schedule')),saved);
    assert.throws(()=>f.service.saveSchedule(101,input,f.key('stale')),{code:'CLOCKOUT_SCHEDULE_CHANGED'});
    assert.throws(()=>f.service.saveSchedule(101,{...input,time:'25:00'},f.key('bad')),{code:'CLOCKOUT_TIME_INVALID'});
    assert.throws(()=>f.service.saveSchedule(101,{...input,days:[]},f.key('empty')),{code:'CLOCKOUT_DAYS_INVALID'});
    assert.equal(nextClockout({time:'18:00',days:[1,2,3,4,5]},Date.parse('2026-11-13T18:00:00+08:00')),'2026-11-16 18:00:00');
    assert.equal(nextClockout({time:'00:01',days:[1,2,3,4,5,6,7]},Date.parse('2026-11-11T23:59:00+08:00')),'2026-11-12 00:01:00');
  }finally{f.close();}
});

test('服务端轮询无需页面；重建服务不重复执行，关闭定时立即生效',async()=>{
  const f=fixture();let stop;try{
    const id=f.seed(201);f.service.saveSchedule(101,{expectedRevision:0,enabled:true,time:'18:00',days:[3]},f.key('schedule'));
    const joined=f.seed(204,'IN_PROGRESS',{owner:102}),latest=f.groups.read();latest.groups[0].blacklakeOperatorIds.push(204);f.groups.save(latest.groups,latest.revision,'membership-updated');
    const restarted=new LeaderClockout({store:f.store,now:f.now});f.setTime('2026-11-11T18:00:20+08:00');
    stop=startClockoutScheduler(restarted,{intervalMs:10,onError:error=>{throw error;}});
    await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.store.assignmentById(id).paused,true);assert.equal(f.store.assignmentById(joined).paused,true);assert.equal(f.store.assignmentPauses(id).length,1);
    restarted.runDue();assert.equal(f.store.assignmentPauses(id).length,1);assert.equal(restarted.schedule(101).nextRunAt,'2026-11-18 18:00:00');
    restarted.saveSchedule(101,{expectedRevision:1,enabled:false,time:'18:00',days:[3]},f.key('off'));assert.equal(restarted.schedule(101).nextRunAt,null);
  }finally{stop?.();f.close();}
});

test('定时使用最新分类；停机超5分钟记录错过、不在次日误暂停，失去组长身份不执行',()=>{
  const f=fixture();try{
    const id=f.seed(201);f.service.saveSchedule(101,{expectedRevision:0,enabled:true,time:'18:00',days:[1,2,3,4,5,6,7]},f.key('schedule'));
    f.setTime('2026-11-12T08:00:00+08:00');f.service.runDue();assert.equal(f.store.assignmentById(id).paused,false);assert.equal(f.service.preview(101).lastRun.status,'MISSED');
    f.store.setEntryProfile(101,{appRole:'employee'});f.setTime('2026-11-12T18:00:00+08:00');f.service.runDue();assert.equal(f.store.assignmentById(id).paused,false);
    assert.equal(f.store.db.prepare('SELECT status FROM leader_clockout_runs ORDER BY executed_at DESC LIMIT 1').get().status,'DISABLED_SCOPE');
  }finally{f.close();}
});

test('下班等同代点计时暂停，员工本人直接继续且派工/数量/队列字段保持',()=>{
  const f=fixture();try{
    const id=f.seed(201,'IN_PROGRESS',{owner:102}),before=f.store.db.prepare('SELECT status,task_id,project_id,operator_id,quantity,started_at,ended_at,report_id,queue_position,published_by_operator_id FROM assignments WHERE id=?').get(id);
    f.service.pause(101,{expectedVersion:f.service.preview(101).version},f.key());
    assert.deepEqual(f.store.db.prepare('SELECT status,task_id,project_id,operator_id,quantity,started_at,ended_at,report_id,queue_position,published_by_operator_id FROM assignments WHERE id=?').get(id),before);
    const timing=f.store.assignmentById(id).timingRevision;f.setTime('2026-11-11T18:20:00+08:00');
    const employee=f.people.find(person=>person.blacklakeOperatorId===201);
    assert.throws(()=>f.store.changeAssignmentTimer({assignmentId:id,operatorId:f.people[0].id,action:'resume',expectedRevision:timing,operationId:f.key('foreign'),at:'2026-11-11 18:20:00'}),{code:'ASSIGNMENT_NOT_FOUND'});
    const result=f.store.changeAssignmentTimer({assignmentId:id,operatorId:employee.id,action:'resume',expectedRevision:timing,operationId:f.key('worker-resume'),at:'2026-11-11 18:20:00'});
    assert.equal(result.paused,false);assert.equal(result.status,'IN_PROGRESS');assert.equal(result.pauses.at(-1).endedAt,'2026-11-11 18:20:00');assert.equal(f.service.preview(101).taskCount,1);
    assert.equal(typeof f.service.resume,'undefined');
  }finally{f.close();}
});
test('某组定时事务失败不影响其他组，失败有持久回执且不留下半批暂停',()=>{
  const f=fixture();try{
    const broken=f.seed(201),other=f.seed(204);
    for(const owner of [101,102])f.service.saveSchedule(owner,{expectedRevision:0,enabled:true,time:'18:00',days:[3]},f.key('schedule-'+owner));
    f.store.db.exec(`CREATE TRIGGER fail_one_team BEFORE INSERT ON assignment_pauses WHEN NEW.assignment_id='task-1' BEGIN SELECT RAISE(ABORT,'isolated team failure'); END`);
    f.setTime('2026-11-11T18:00:00+08:00');f.service.runDue();
    assert.equal(f.store.assignmentById(broken).paused,false);assert.equal(f.store.assignmentById(other).paused,true);
    assert.equal(f.service.preview(101).lastRun.status,'FAILED');assert.equal(f.service.preview(102).lastRun.status,'SUCCEEDED');
    f.service.runDue();assert.equal(f.store.assignmentPauses(other).length,1);
  }finally{f.close();}
});

test('HTTP分类暂停仅组长可发起，员工沿用本人计时暂停/继续，不读取黑湖',async()=>{
  const f=fixture();let server;try{
    const leader=f.people[0],worker=f.people[2],tokens=[leader,worker].map(person=>f.store.createSession(person.id).token),review=f.store.createSession(leader.id,{scope:'review'}).token;
    const id=f.seed(201);server=createServer(createApp({config:f.config,store:f.store,blacklake:{listOperators:async()=>[],findTaskById:async()=>{throw Error('timer must not query lifecycle state');},readWorkOrderDetails:async()=>{throw Error('timer must not query lifecycle state');}},wechat:{},now:f.now}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const call=async(path,{token=tokens[0],method='GET',body,key=f.key('http')}={})=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
    for(const token of [tokens[1],review])assert.equal((await call('/v1/dispatch/clock-out',{token})).status,403);
    const preview=(await call('/v1/dispatch/clock-out')).body;
    assert.equal((await call('/v1/dispatch/clock-out',{method:'POST',body:{expectedVersion:preview.version,employeeIds:[204]}})).status,422);
    assert.equal((await call('/v1/dispatch/clock-out',{method:'POST',body:{expectedVersion:preview.version}})).body.pausedCount,1);
    const timer=(action,revision,key)=>call('/v1/assignments/'+id+'/'+action,{token:tokens[1],method:'POST',body:{expectedRevision:revision},key});
    const resumed=await timer('resume',f.store.assignmentById(id).timingRevision,f.key('employee-resume'));assert.equal(resumed.status,200);assert.equal(resumed.body.assignment.paused,false);assert.equal(resumed.body.assignment.status,'IN_PROGRESS');
    const paused=await timer('pause',f.store.assignmentById(id).timingRevision,f.key('employee-pause'));assert.equal(paused.status,200);assert.equal(paused.body.assignment.paused,true);
    assert.equal((await call('/v1/dispatch/clock-out/assignments/'+id+'/resume',{method:'POST',body:{expectedRevision:f.store.assignmentById(id).timingRevision}})).status,404);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});
