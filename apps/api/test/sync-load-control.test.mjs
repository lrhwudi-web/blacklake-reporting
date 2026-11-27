import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';

function fixture(){let at=Date.parse('2026-11-16T09:00:00+08:00');const store=new Store(':memory:',{sessionSecret:'load-control-isolated',sessionDays:1}),blacklake={},sync=new BlacklakeSync({store,blacklake,now:()=>at,refreshPolicy:{order:300000,people:1800000,materials:21600000}});return {store,sync,blacklake,advance:ms=>at+=ms,close:()=>store.close()};}
test('60人翻页只读工单镜像，不安排每页20张详情刷新；同单详情共享一次刷新',()=>{const f=fixture();try{
 for(let id=1;id<=60;id++)f.sync.indexOrder({projectId:id,projectCode:'WO-'+id,projectStatus:'10'});f.sync.ensureScheduled=()=>{};
 for(let n=0;n<60;n++){assert.equal(f.sync.list({pageNum:n%3+1}).orders.length,20);}assert.equal(f.sync.jobs.list().jobs.filter(j=>j.kind==='order').length,0);
 for(let n=0;n<60;n++)f.sync.order(1);assert.equal(f.sync.jobs.list().jobs.filter(j=>j.kind==='order').length,1);
 f.sync.save('order',1,{info:{projectId:1,projectCode:'WO-1',projectStatus:'10'},tasks:[]});f.store.db.prepare('DELETE FROM integration_job_events').run();f.store.db.prepare('DELETE FROM integration_jobs').run();f.advance(61000);for(let n=0;n<60;n++)f.sync.order(1);assert.equal(f.sync.jobs.list().jobs.length,0);f.advance(240001);f.sync.order(1);assert.equal(f.sync.jobs.list().jobs.length,0,'浏览完整本地资料不再因TTL触发重查');
}finally{f.close();}});

test('读取连续五次失败转待处理，页面和定时刷新不复活，人工重试可恢复',async()=>{const f=fixture();try{
 let calls=0;f.sync.handlers.set('materials',async()=>{calls++;throw Error('synthetic upstream broken');});f.sync.save('materials','1:1',{items:[{id:'known'}]});f.sync.request('materials','1:1',{projectId:1,pageNum:1});
 for(let n=0;n<5;n++){await f.sync.tick();f.advance(1000000);}let job=f.sync.jobs.byKey('read:materials:1:1');assert.equal(job.state,'FAILED');assert.equal(f.sync.publicJob(job).label,'待处理');assert.equal(calls,5);
 for(let n=0;n<60;n++){f.sync.section(1,'materials');f.sync.request('materials','1:1',{projectId:1,pageNum:1},true);}await f.sync.tick();assert.equal(calls,5);assert.equal(f.sync.section(1,'materials').items[0].id,'known');
 f.sync.jobs.retry(job.id,'test-admin',job);f.sync.handlers.set('materials',async()=>({records:1}));await f.sync.tick();job=f.sync.jobs.get(job.id);assert.equal(job.state,'SUCCEEDED');assert.equal(f.sync.readFailures(job),0);
}finally{f.close();}});

test('本地限速排队不消耗读取失败次数，也不会越过写边界自动重发回读未知',async()=>{const f=fixture();try{
 f.sync.handlers.set('materials',async()=>{throw Object.assign(Error('waiting'),{code:'BLACKLAKE_REQUEST_DEFERRED',retryAfterMs:2000});});f.sync.request('materials','1',{projectId:1});
 for(let n=0;n<8;n++){await f.sync.tick();f.advance(3000);}const read=f.sync.jobs.byKey('read:materials:1');assert.equal(read.state,'QUEUED');assert.equal(read.result.consecutiveFailures,0);
 f.store.db.prepare('DELETE FROM integration_job_events').run();f.store.db.prepare('DELETE FROM integration_jobs').run();
 for(const notSent of [true,false]){const job=f.sync.jobs.enqueue({key:'write-'+notSent,mode:'write',kind:'report-edit',target:'test'});f.sync.writeHandler=async j=>{f.sync.jobs.sending(j.id,j.attempts);throw Object.assign(Error('budget'),{code:'BLACKLAKE_REQUEST_DEFERRED',retryAfterMs:1000,...(notSent?{writeNotSent:true,definiteFailure:true}:{})});};await f.sync.tick();assert.equal(f.sync.jobs.get(job.id).state,notSent?'RETRY':'UNKNOWN');f.store.db.prepare('DELETE FROM integration_job_events').run();f.store.db.prepare('DELETE FROM integration_jobs').run();}
}finally{f.close();}});

test('旧任务按连续失败事件停车，成功过的高累计次数任务不误停，UNKNOWN写保持',()=>{const f=fixture();try{
 for(const [key,success]of [['bad',false],['healthy',true]]){const j=f.sync.jobs.enqueue({key:'read:'+key,mode:'read',kind:'history',target:key});for(let n=0;n<6;n++)f.sync.jobs.event(j.id,'RETRY','SYSTEM',{code:'READ_FAILED'});if(success)f.sync.jobs.event(j.id,'SUCCEEDED');f.store.db.prepare("UPDATE integration_jobs SET state='RETRY',error_code='READ_FAILED',attempts=350 WHERE id=?").run(j.id);}
 const w=f.sync.jobs.enqueue({key:'existing-unknown',mode:'write',kind:'report-create',target:'w'});f.store.db.prepare("UPDATE integration_jobs SET state='UNKNOWN' WHERE id=?").run(w.id);f.sync.parkExhaustedReads();assert.equal(f.sync.jobs.byKey('read:bad').state,'FAILED');assert.equal(f.sync.jobs.byKey('read:healthy').state,'RETRY');assert.equal(f.sync.jobs.get(w.id).state,'UNKNOWN');
}finally{f.close();}});
