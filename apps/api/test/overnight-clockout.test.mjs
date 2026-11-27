import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {PeopleGroups} from '../src/people-groups.mjs';
import {LeaderClockout} from '../src/leader-clockout.mjs';
import {OvernightClockout,overnightWindow,startOvernightClockoutScheduler} from '../src/overnight-clockout.mjs';
import {TaskRecovery} from '../src/task-recovery.mjs';
import {effectiveWorkSecondsBetween} from '../src/work-time.mjs';
import {loadConfig} from '../src/config.mjs';

function fixture({path=':memory:',policy='team-first'}={}){
 const store=new Store(path,{sessionSecret:'overnight-isolated-test-only',sessionDays:1}),groups=new PeopleGroups(store.db);
 const people=[101,102,201,202,203,204,205,206,207].map(id=>store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'测试-'+id}));
 store.setEntryProfile(101,{appRole:'floor8_leader'});store.setEntryProfile(102,{appRole:'floor8_leader'});
 groups.save([{id:'a',name:'一组',blacklakeOperatorIds:[201,202],leaderIds:[101]},{id:'b',name:'二组',blacklakeOperatorIds:[203,204],leaderIds:[102]}],groups.read().revision,'test');
 let at=Date.parse('2026-11-13T02:00:10+08:00'),serial=0;
 const leaderClockout=new LeaderClockout({store,now:()=>at});
 const service=new OvernightClockout({store,leaderClockout,now:()=>at,referencePolicy:policy});
 const person=id=>people.find(p=>p.blacklakeOperatorId===id);
 function seed(worker=201,{status='IN_PROGRESS',start='2026-11-12 08:00:00',end=null,paused=null}={}){
  const id='overnight-task-'+(++serial);
  store.dispatchAssignment({id,operatorId:person(worker).id,taskId:serial,projectId:500+serial,projectCode:'TEST-'+serial,productName:'测试',processName:'工序',quantity:100,stationName:'A-03',publishedByOperatorId:101,publishedBy:'测试组长',publishedAt:'2026-11-12 07:00:00',flowCodeHash:'test'},{allowQueue:true});
  store.db.prepare('UPDATE assignments SET status=?,started_at=?,ended_at=? WHERE id=?').run(status,start,end,id);
  if(paused)pause(id,paused);return id;
 }
 function pause(id,start,end=null,source='employee'){store.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at,ended_at,source) VALUES(?,?,?,?)').run(id,start,end,source);}
 function run(owner,time,{kind='manual',status='SUCCEEDED',date='2026-11-12'}={}){
  store.db.prepare('INSERT INTO leader_clockout_runs VALUES(?,?,?,?,?,?,?)').run('reference-'+(++serial),owner,kind,status,null,date+' '+time,'{}');
 }
 const done=(worker,end,options={})=>seed(worker,{status:'COMPLETED',end:'2026-11-12 '+end,...options});
 return {store,groups,service,leaderClockout,person,seed,pause,run,done,setTime:value=>{at=Date.parse(value);},close:()=>store.close()};
}
function using(work,options){const f=fixture(options);try{return work(f);}finally{f.close();}}
const pauseAt=(f,id)=>f.store.assignmentPauses(id).at(-1)?.startedAt;

test('按北京时间02:00分班，02:00前完全不处理；跨年日期正确',()=>{
 assert.equal(overnightWindow(Date.parse('2026-11-13T01:59:59+08:00')),null);
 assert.deepEqual(overnightWindow(Date.parse('2027-01-01T02:00:00+08:00')),{businessDate:'2026-12-31',from:'2026-12-31 02:00:00',cutoff:'2027-01-01 02:00:00'});
 using(f=>{const id=f.seed();f.setTime('2026-11-13T01:59:59+08:00');assert.equal(f.service.runDue(),null);assert.equal(pauseAt(f,id),undefined);assert.equal(f.service.status().runs.length,0);});
});

test('优先本组最近成功下班；其他组和历史记录不会覆盖；任务数量队列和报工不变',()=>using(f=>{
 f.run(101,'17:00:00');f.run(101,'18:00:00');f.run(102,'20:00:00');f.run(101,'21:00:00',{status:'FAILED'});f.run(101,'22:00:00',{status:'MISSED'});
 f.run(101,'23:00:00',{date:'2026-11-11'});f.run(101,'03:00:00',{date:'2026-11-13'});
 const id=f.seed(),before=f.store.db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
 const result=f.service.runDue();assert.equal(result.pausedCount,1);assert.equal(pauseAt(f,id),'2026-11-12 18:00:00');
 assert.deepEqual(f.store.db.prepare('SELECT * FROM assignments WHERE id=?').get(id),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
 const detail=new TaskRecovery(f.store).detail(id);assert.equal(detail.overnightClockout.referenceKind,'team-leader');assert.equal(detail.events[0].action,'AUTO_OVERNIGHT_PAUSE');assert.equal(detail.events[0].actualAt,'2026-11-12 18:00:00');assert.equal(detail.events[0].after.timerPaused,true);
 assert.equal(f.service.status().runs[0].status,'SUCCEEDED');
}));

test('本组无记录用其他组长最后一次成功执行；仅设置定时和失败执行不算',()=>using(f=>{
 f.leaderClockout.saveSchedule(101,{expectedRevision:0,enabled:true,time:'18:00',days:[1,2,3,4,5,6,7]},'overnight-schedule-test');
 f.run(102,'18:30:00',{kind:'scheduled'});f.run(101,'19:00:00',{status:'DISABLED_SCOPE'});const id=f.seed();f.service.runDue();
 assert.equal(pauseAt(f,id),'2026-11-12 18:30:00');assert.equal(new TaskRecovery(f.store).detail(id).overnightClockout.referenceKind,'other-leader');
}));

test('实际一键下班回执可作为缺漏任务的参考，不依赖真实黑湖',()=>using(f=>{
 f.setTime('2026-11-12T18:00:00+08:00');f.leaderClockout.pause(101,{expectedVersion:f.leaderClockout.preview(101).version},'overnight-real-clockout-run');
 const id=f.seed();f.setTime('2026-11-13T02:00:00+08:00');f.service.runDue();assert.equal(pauseAt(f,id),'2026-11-12 18:00:00');
}));

test('可配置全局最后组长或仅本组，两种策略互不混淆',()=>{
 using(f=>{f.run(101,'18:00:00');f.run(102,'20:00:00');const id=f.seed();f.service.runDue();assert.equal(pauseAt(f,id),'2026-11-12 20:00:00');},{policy:'global-last'});
 using(f=>{f.run(102,'20:00:00');const id=f.seed();f.done(202,'17:00:00');f.done(203,'19:00:00');f.service.runDue();assert.equal(pauseAt(f,id),'2026-11-12 18:00:00');},{policy:'team-only'});
});

test('没有组长下班时按每人最后结束时间取中位数；重复报工不多投票',()=>using(f=>{
 const id=f.seed();f.done(202,'17:00:00');f.done(203,'18:00:00');f.done(204,'19:00:00');f.done(205,'18:00:00');
 for(let i=0;i<12;i++)f.done(202,'12:00:00');
 const result=f.service.runDue();assert.equal(result.majoritySampleCount,4);assert.equal(result.workingEmployeeCount,5);assert.equal(result.needsReviewCount,0);assert.equal(pauseAt(f,id),'2026-11-12 18:00:00');
 assert.equal(new TaskRecovery(f.store).detail(id).overnightClockout.referenceKind,'majority');
}));

test('午夜结束属于前一班，奇数中位数不受极晚结束拉偏',()=>using(f=>{
 const id=f.seed();f.done(202,'23:50:00');f.done(203,'00:10:00',{end:'2026-11-13 00:10:00'});f.done(204,'01:50:00',{end:'2026-11-13 01:50:00'});
 const result=f.service.runDue();assert.equal(result.majoritySampleCount,3);assert.equal(pauseAt(f,id),'2026-11-13 00:10:00');
}));

test('同人另一任务暂停不能掩盖仍在工作的任务；截止点后结束和暂停按截止点重建',()=>using(f=>{
 f.seed();f.done(202,'12:00:00');f.seed(202,{end:'2026-11-13 03:00:00',status:'COMPLETED'});
 f.seed(202,{paused:'2026-11-12 15:00:00'});f.done(203,'18:00:00');f.done(204,'19:00:00');
 const majority=f.service.majority(overnightWindow(Date.parse('2026-11-13T04:00:00+08:00')),f.service.people());
 assert.equal(majority.count,2);assert.equal(majority.population,4);assert.equal(majority.at,null);
}));

test('截止点后才暂停不计作下班；已暂停但后续仍有未结束工作不投早期结束票',()=>using(f=>{
 f.seed();f.done(202,'12:00:00');const late=f.seed(202);f.pause(late,'2026-11-13 02:10:00');
 f.done(203,'12:00:00');f.seed(203,{paused:'2026-11-12 18:00:00'});f.done(204,'19:00:00');
 const majority=f.service.majority(overnightWindow(Date.parse('2026-11-13T03:00:00+08:00')),f.service.people());assert.equal(majority.count,1);assert.equal(majority.at,null);
}));

test('整班都暂停的旧任务不计入当班分母；暂停本身不生成结束样本',()=>using(f=>{
 const id=f.seed();f.done(202,'18:00:00');f.done(203,'18:20:00');
 f.seed(204,{start:'2026-11-10 08:00:00',paused:'2026-11-10 18:00:00'});f.seed(205,{start:'2026-11-10 08:00:00',paused:'2026-11-10 18:00:00'});
 const result=f.service.runDue();assert.equal(result.workingEmployeeCount,3);assert.equal(result.majoritySampleCount,2);assert.equal(result.alreadyPausedCount,2);assert.equal(pauseAt(f,id),'2026-11-12 18:10:00');
}));

test('样本不足时用可核实的邻近结束或最后活动，低置信度保留待核对',()=>{
 for(const count of [0,1,2])using(f=>{
  const id=f.seed();if(!count)f.pause(id,'2026-11-12 17:15:00','2026-11-12 17:20:00');if(count===2)f.seed(205);for(let n=0;n<count;n++)f.done(202+n,'18:00:00');
  const result=f.service.runDue(),detail=new TaskRecovery(f.store).detail(id).overnightClockout;
  assert.equal(pauseAt(f,id),'2026-11-12 '+(count?'18:00:00':'17:20:00'));
  assert(result.needsReviewCount>0);assert.equal(detail.status,'PAUSED_NEEDS_REVIEW');
  assert.equal(detail.referenceKind,count?'employee-end':'task-activity');
 });
});

test('参考早于开工或最后恢复时不回拨；02:00后新活动和新任务不改动',()=>using(f=>{
 f.run(101,'18:00:00');const started=f.seed(201,{start:'2026-11-12 19:00:00'}),resumed=f.seed(202),newActivity=f.seed(203);
 f.pause(resumed,'2026-11-12 17:00:00','2026-11-12 20:00:00');f.pause(newActivity,'2026-11-12 17:00:00','2026-11-13 03:00:00');const newTask=f.seed(204,{start:'2026-11-13 02:01:00'});
 f.setTime('2026-11-13T04:00:00+08:00');const result=f.service.runDue();assert.equal(result.pausedCount,1);assert.equal(result.skippedCount,2);assert.equal(result.needsReviewCount,2);
 assert.equal(pauseAt(f,started),undefined);assert.equal(pauseAt(f,resumed),'2026-11-12 20:00:00');assert.equal(f.store.assignmentById(newActivity).paused,false);assert.equal(pauseAt(f,newTask),undefined);
 assert.equal(new TaskRecovery(f.store).detail(newActivity).overnightClockout.status,'SKIPPED_NEW_ACTIVITY');
}));

test('中位数17:21:51早于最后活动17:23:55时取其后最接近的结束，已暂停记录不再改',()=>using(f=>{
 const target=f.seed(201);f.pause(target,'2026-11-12 17:19:00','2026-11-12 17:23:55');
 f.done(202,'17:19:38');f.done(203,'17:21:51');f.done(204,'17:25:06');
 const paused=f.seed(205,{paused:'2026-11-12 17:23:00'}),previous=f.store.assignmentPauses(paused);
 f.service.runDue();const detail=new TaskRecovery(f.store).detail(target).overnightClockout;
 assert.equal(detail.referenceKind,'employee-end');assert.equal(detail.referenceAt,'2026-11-12 17:25:06');
 assert.equal(detail.pauseAt,'2026-11-12 17:25:06');assert.equal(detail.status,'PAUSED_NEEDS_REVIEW');
 assert.deepEqual(f.store.assignmentPauses(paused),previous);
}));

test('班次没有可核实活动时不制造补暂停时间',()=>using(f=>{
 const id=f.seed(201,{start:'2026-11-10 08:00:00'});const result=f.service.runDue();
 assert.equal(result.needsReviewCount,1);assert.equal(pauseAt(f,id),undefined);
 assert.equal(new TaskRecovery(f.store).detail(id).overnightClockout.status,'SKIPPED_NO_REFERENCE');
}));

test('较晚的本人暂停可作待核对参考，旧自动补暂停不得被传用',()=>using(f=>{
 const id=f.seed(201);f.pause(id,'2026-11-12 17:19:00','2026-11-12 17:23:55');
 f.pause(f.seed(202),'2026-11-12 17:24:00',null,'overnight');
 f.pause(f.seed(203),'2026-11-12 17:25:11');
 f.service.runDue();const detail=new TaskRecovery(f.store).detail(id).overnightClockout;
 assert.equal(detail.referenceKind,'employee-pause');assert.equal(detail.pauseAt,'2026-11-12 17:25:11');assert.equal(detail.status,'PAUSED_NEEDS_REVIEW');
}));

test('员工暂停、插单暂停、待开始、核量、提交中、未知结果和停用/管理身份保持',()=>using(f=>{
 f.run(101,'18:00:00');
 const running=f.seed(),paused=f.seed(202,{paused:'2026-11-12 18:00:00'}),queue=f.seed(203,{status:'PAUSED',paused:'2026-11-12 18:00:00'});
 const protectedIds=['READY','QUANTITY_PENDING','REPORTING','NEEDS_REVIEW','COMPLETED','CANCELLED'].map(status=>f.seed(204,{status}));
 const inactive=f.seed(205);f.store.db.prepare('UPDATE operators SET active=0 WHERE blacklake_operator_id=205').run();const leader=f.seed(101);
 const before=JSON.stringify(f.store.assignmentPauses(paused)),result=f.service.runDue();assert.equal(result.pausedCount,1);assert.equal(result.alreadyPausedCount,1);assert.equal(f.store.assignmentById(running).paused,true);
 assert.equal(JSON.stringify(f.store.assignmentPauses(paused)),before);assert.equal(f.store.assignmentPauses(queue).length,1);for(const id of [...protectedIds,inactive,leader])assert.equal(pauseAt(f,id),undefined);
}));

test('重复执行及新建服务幂等，暂停后员工能自行恢复；午休与已有暂停不重复计时',()=>using(f=>{
 f.run(101,'18:00:00');const id=f.seed();f.pause(id,'2026-11-12 16:00:00','2026-11-12 16:30:00');
 const first=f.service.runDue(),reopened=new OvernightClockout({store:f.store,leaderClockout:f.leaderClockout,now:()=>Date.parse('2026-11-13T08:00:00+08:00')});
 assert.equal(reopened.runDue().replayed,true);assert.equal(first.pausedCount,1);assert.equal(f.store.assignmentPauses(id).length,2);
 let task=f.store.assignmentById(id);assert.equal(effectiveWorkSecondsBetween(task.startedAt,'2026-11-13 08:00:00',task.pauses),8*3600);
 f.store.changeAssignmentTimer({assignmentId:id,operatorId:task.operatorId,action:'resume',expectedRevision:task.timingRevision,operationId:'overnight-employee-resume',at:'2026-11-13 08:00:00'});
 task=f.store.assignmentById(id);assert.equal(task.paused,false);assert.equal(effectiveWorkSecondsBetween(task.startedAt,'2026-11-13 09:00:00',task.pauses),9*3600);assert.equal(task.status,'IN_PROGRESS');assert.equal(task.endedAt,null);assert.equal(task.reportId,null);
 assert.equal(reopened.runDue().pausedCount,1);assert.equal(f.store.assignmentById(id).paused,false);
}));

test('事务中途失败全量回滚，之后可安全重试',()=>using(f=>{
 const first=f.seed(),second=f.seed(202);f.run(101,'18:00:00');
 f.store.db.exec(`CREATE TRIGGER fail_overnight BEFORE INSERT ON assignment_pauses WHEN NEW.assignment_id='${second}' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
 assert.throws(()=>f.service.runDue(),/synthetic failure/);assert.equal(pauseAt(f,first),undefined);assert.equal(f.service.status().runs.length,0);assert.equal(new TaskRecovery(f.store).detail(first).eventsTotal,0);
 f.store.db.exec('DROP TRIGGER fail_overnight');assert.equal(f.service.runDue().pausedCount,2);
}));

test('SQLite重开保留每日回执；下一业务日重新计算',()=>{
 const dir=mkdtempSync(join(tmpdir(),'blacklake-overnight-')),path=join(dir,'test.sqlite');let f;
 try{f=fixture({path});const id=f.seed();f.run(101,'18:00:00');f.service.runDue();f.close();f=null;
  f=fixture({path});assert.equal(f.service.runDue().replayed,true);assert.equal(pauseAt(f,id),'2026-11-12 18:00:00');
  f.setTime('2026-11-14T02:00:00+08:00');const next=f.service.runDue();assert.equal(next.businessDate,'2026-11-13');assert.equal(next.alreadyPausedCount,1);assert.equal(f.service.status().runs.length,2);
 }finally{f?.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert(basename(dir).startsWith('blacklake-overnight-'));rmSync(dir,{recursive:true,force:true});}
});

test('无效计时留待核对，定时启停和错误回调有效',()=>using(f=>{
 const id=f.seed(201,{start:'2026-11-12 08:99:00'});const result=f.service.runDue();assert.equal(result.pausedCount,0);assert.equal(result.needsReviewCount,1);assert.equal(pauseAt(f,id),undefined);
 let calls=0,errors=0;const stop=startOvernightClockoutScheduler({runDue(){calls++;throw Error('synthetic');}},{onError(){errors++;},intervalMs:60000});stop();assert.equal(calls,1);assert.equal(errors,1);startOvernightClockoutScheduler(null)();
}));

test('自动补暂停默认启用，有关闭开关且非法策略启动即拒绝',()=>{
 const env={BLACKLAKE_MODE:'mock',SESSION_SECRET:'test-session-secret-that-is-long-enough',ADMIN_API_KEY:'test-admin-key-that-is-long-enough'};
 assert.deepEqual(loadConfig(env).overnightClockout,{enabled:true,referencePolicy:'team-first'});
 assert.deepEqual(loadConfig({...env,OVERNIGHT_CLOCKOUT_ENABLED:'false',OVERNIGHT_CLOCKOUT_REFERENCE_POLICY:'team-only'}).overnightClockout,{enabled:false,referencePolicy:'team-only'});
 assert.throws(()=>loadConfig({...env,OVERNIGHT_CLOCKOUT_REFERENCE_POLICY:'unknown'}),{code:'INVALID_CONFIG'});
});
