import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {workTimeBreakdown} from '../src/work-time.mjs';
import {employeeDailySummary} from '../src/employee-daily-summary.mjs';

const stamp=time=>'2026-11-09 '+time;
const milliseconds=time=>Date.parse('2026-11-09T'+time+'+08:00');
async function fixture(path=':memory:') {
  const config={sessionSecret:'timer-isolated-test',sessionDays:1,agent:{enabled:false}};
  const store=new Store(path,config),workers=[301,302].map(id=>store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'同名测试员工'}));
  const tokens=workers.map(w=>store.createSession(w.id).token),review=store.createSession(workers[0].id,{scope:'review'}).token;
  const seed=(id='timer-a',worker=workers[0])=>{
    store.dispatchAssignment({id,operatorId:worker.id,taskId:201,projectId:101,projectCode:'TIMER',productName:'测试产品',processName:'车耳朵',quantity:10,stationName:'A-03',publishedAt:stamp('08:00:00'),publishedBy:'测试组长',flowCodeHash:'fixture'});
    store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',started_at=? WHERE id=?").run(stamp('11:00:00'),id);return id;
  };
  seed();let clock=milliseconds('11:30:00');const outputs=[];
  const blacklake={createOutput:async input=>{outputs.push(input);return{id:'output-timer'};}};
  const server=createServer(createApp({config,store,blacklake,wechat:{},now:()=>clock}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call=async(action,{id='timer-a',person=0,revision=0,key='timer-'+randomUUID(),body}={})=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/assignments/'+id+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(person===null?{}:{Authorization:'Bearer '+(person==='review'?review:tokens[person])})},body:JSON.stringify(body||{expectedRevision:revision})});
    return {status:r.status,body:await r.json()};
  };
  return {config,store,workers,seed,call,outputs,at:time=>clock=milliseconds(time),close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('午休和暂停取并集，跨日/重叠/未恢复暂停，客户端与服务端逐项一致',()=>{
  const sandbox={module:{exports:{}}};vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/work-time.js',import.meta.url),'utf8'),sandbox);
  const cases=[
    [stamp('11:00:00'),stamp('14:00:00'),[{startedAt:stamp('11:45:00'),endedAt:stamp('13:45:00')}],3600,5400,1800],
    [stamp('11:00:00'),stamp('12:30:00'),[{startedAt:stamp('11:30:00'),endedAt:null}],1800,1800,1800],
    [stamp('11:00:00'),stamp('14:00:00'),[{startedAt:stamp('12:05:00'),endedAt:stamp('13:00:00')}],5400,5400,0],
    [stamp('11:00:00'),'2026-11-10 14:00:00',[{startedAt:stamp('23:00:00'),endedAt:'2026-11-10 01:00:00'}],22*3600,3*3600,2*3600],
    [stamp('11:00:00'),stamp('14:00:00'),[{startedAt:stamp('10:00:00'),endedAt:stamp('11:30:00')},{startedAt:stamp('11:15:00'),endedAt:stamp('12:15:00')}],1800,5400,3600]
  ];
  for(const [a,b,pauses,e,l,p] of cases){const actual=workTimeBreakdown(a,b,pauses);assert.equal(actual.effectiveSeconds,e);assert.equal(actual.lunchSeconds,l);assert.equal(actual.pauseSeconds,p);assert.equal(actual.elapsedSeconds,e+l+p);assert.deepEqual(JSON.parse(JSON.stringify(sandbox.module.exports.workTimeBreakdown(a,b,pauses))),actual);}
});

test('暂停/继续只操作本人活动任务，鉴权/体验/状态/过时请求保护',async()=>{
  const f=await fixture();try{
    assert.equal((await f.call('pause',{person:null})).status,401);
    assert.equal((await f.call('pause',{person:1})).status,404);
    assert.equal((await f.call('pause',{person:'review'})).status,403);
    assert.equal((await f.call('pause',{revision:-1})).status,422);
    assert.equal((await f.call('resume')).status,409);
    let r=await f.call('pause');assert.equal(r.status,200);assert.equal(r.body.assignment.paused,true);assert.equal(r.body.assignment.status,'IN_PROGRESS');
    assert.equal(f.store.hasActiveAssignmentForBlacklakeOperator(301),true);
    assert.equal((await f.call('pause')).status,409);
    f.at('11:45:00');r=await f.call('resume',{revision:1});assert.equal(r.status,200);assert.equal(r.body.assignment.paused,false);
    assert.equal((await f.call('pause',{revision:0})).body.error.code,'TIMER_VERSION_CHANGED');
    f.store.db.prepare("UPDATE assignments SET status='NEEDS_REVIEW' WHERE id='timer-a'").run();assert.equal((await f.call('pause',{revision:2})).status,409);
    assert.equal(f.outputs.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_actions WHERE action IN (\'PAUSE_TIMER\',\'RESUME_TIMER\')').get().n,2);
  }finally{await f.close();}
});

test('重复与延迟重放不额外暂停，不能复用操作标识改变请求',async()=>{
  const f=await fixture();try{
    const key='timer-'+randomUUID();await f.call('pause',{key});await f.call('pause',{key});
    assert.equal(f.store.assignmentPauses('timer-a').length,1);
    f.at('11:45:00');await f.call('resume',{revision:1});
    const replay=await f.call('pause',{key});assert.equal(replay.status,200);assert.equal(replay.body.assignment.paused,false);assert.equal(replay.body.assignment.timingRevision,2);
    assert.equal((await f.call('resume',{key,revision:2})).status,409);
  }finally{await f.close();}
});

test('暂停跨午休后直接结束，保存净工时；黑湖仍传原始起止，今日统计一致',async()=>{
  const f=await fixture();try{
    f.at('11:45:00');await f.call('pause');f.at('14:00:00');
    const result=await f.call('finish',{body:{quantity:10}});assert.equal(result.status,201);
    assert.equal(result.body.assignment.durationSeconds,2700);assert.equal(result.body.assignment.paused,false);
    assert.equal(f.outputs[0].actualStartedAt,stamp('11:00:00'));assert.equal(f.outputs[0].actualEndedAt,stamp('14:00:00'));
    assert.equal(employeeDailySummary(f.store,301,{now:()=>milliseconds('15:00:00')}).workSeconds,2700);
    assert.equal((await f.call('resume',{revision:1})).status,409);
  }finally{await f.close();}
});

test('多机暂停独立，今日工时先扣各任务暂停再合并并行区间',async()=>{
  const f=await fixture();try{
    f.seed('timer-b',f.workers[1]);
    f.store.db.prepare("UPDATE assignments SET operator_id=?,process_name='外协加工绣花',machine_id=CASE id WHEN 'timer-a' THEN '01' ELSE '02' END WHERE id IN ('timer-a','timer-b')").run(f.workers[0].id);
    f.at('11:30:00');await f.call('pause');
    assert.equal(f.store.assignmentById('timer-b').paused,false);
    f.store.db.prepare("UPDATE assignments SET status='COMPLETED',ended_at=? WHERE id IN ('timer-a','timer-b')").run(stamp('14:00:00'));
    assert.equal(employeeDailySummary(f.store,301,{now:()=>milliseconds('15:00:00')}).workSeconds,5400);
  }finally{await f.close();}
});

test('SQLite关闭重开后暂停区间/修订/幂等回执仍然存在',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'timer-')),path=join(dir,'test.sqlite');let f=await fixture(path);const id=f.workers[0].id,key='timer-'+randomUUID(),config=f.config;
  try{await f.call('pause',{key});await f.close();f=null;const store=new Store(path,config);try{
    assert.equal(store.assignmentById('timer-a').paused,true);assert.equal(store.assignmentById('timer-a').timingRevision,1);
    const result=store.changeAssignmentTimer({assignmentId:'timer-a',operatorId:id,action:'pause',expectedRevision:0,operationId:key,at:stamp('14:00:00')});assert.equal(result.pauses.length,1);
    assert.equal(workTimeBreakdown(result.startedAt,stamp('14:00:00'),result.pauses).effectiveSeconds,1800);
  }finally{store.close();}}finally{if(f)await f.close();rmSync(dir,{recursive:true,force:true});}
});
