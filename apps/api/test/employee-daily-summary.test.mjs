import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';import {employeeDailySummary} from '../src/employee-daily-summary.mjs';
const NOW=()=>Date.parse('2026-11-05T22:00:00+08:00');
async function fixture(){
 const config={sessionSecret:'daily-summary-test-only',sessionDays:30,adminApiKey:'daily-summary-admin',reportingModeAdminOperatorIds:[],agent:{enabled:false}},store=new Store(':memory:',config);
 const worker=store.upsertBlacklakeOperator({name:'同名测试员工',blacklakeOperatorId:301}),other=store.upsertBlacklakeOperator({name:'同名测试员工',blacklakeOperatorId:302});let serial=0;
 const tokens=[worker,other].map(o=>store.createSession(o.id).token),review=store.createSession(worker.id,{scope:'review'}).token;
 function seed({person=worker,status='COMPLETED',start='2026-11-05 08:00:00',end='2026-11-05 09:00:00',quantityPolicy=''}={}){
  const id='summary-'+(++serial);store.db.prepare(`INSERT INTO assignments(id,operator_id,task_id,project_id,project_code,product_name,process_name,quantity,min_duration_seconds,max_duration_seconds,status,published_at,started_at,ended_at,duration_seconds,quantity_policy)
    VALUES (?,?,?,201,'TEST','测试产品','测试缝制',100,0,2147483647,?,'2026-11-05 07:00:00',?,?,999999,?)`).run(id,person.id,serial,status,start,end,quantityPolicy);return id;
 }
 const server=createServer(createApp({config,store,blacklake:{},wechat:{},now:NOW}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path='/v1/assignments/current',{person=0,scope,anonymous=false}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:anonymous?{}:{Authorization:'Bearer '+(scope==='review'?review:tokens[person])}});return{status:r.status,body:await r.json()};};
 return {store,worker,other,seed,call,summary:()=>employeeDailySummary(store,301,{now:NOW}),close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('统计按本人稳定ID及上海结束日期，同名他人和跨日边界不串入',async()=>{const f=await fixture();try{
 f.seed();f.seed({person:f.other});f.seed({end:'2026-11-04 23:59:59',start:'2026-11-04 23:00:00'});f.seed({end:'2026-11-06 00:00:00',start:'2026-11-05 23:00:00'});const s=f.summary();assert.equal(s.completedCount,1);assert.equal(s.workSeconds,3600);assert.equal(s.date,'2026-11-05');assert.equal(s.timezone,'Asia/Shanghai');assert.equal(s.source,'local_assignments');assert.match(s.scopeDescription,/本系统/);
 const response=await f.call('/v1/assignments/current?blacklakeOperatorId=302&date=2026-11-04');assert.equal(response.status,200);assert.equal(response.body.todaySummary.completedCount,1);
}finally{await f.close();}});

test('超过最近10条仍完整统计；无任务是明确零，不是设计稿固定数字',async()=>{const f=await fixture();try{
 assert.equal(f.summary().completedCount,0);assert.equal(f.summary().workSeconds,0);for(let i=0;i<25;i++)f.seed();const s=f.summary();assert.equal(s.completedCount,25);assert.equal(s.workSeconds,3600);assert.equal(f.store.recentAssignments(f.worker.id,10).length,10);
}finally{await f.close();}});

test('并行与重叠工时去重且午休只扣一次，不累加多台机器时间',async()=>{const f=await fixture();try{
 f.seed({start:'2026-11-05 08:00:00',end:'2026-11-05 14:00:00'});f.seed({start:'2026-11-05 10:00:00',end:'2026-11-05 15:00:00'});const s=f.summary();assert.equal(s.completedCount,2);assert.equal(s.workSeconds,5.5*3600);
}finally{await f.close();}});

test('跨夜任务只计今日部分，昨日结束与生产中未结束不算今日完成',async()=>{const f=await fixture();try{
 f.seed({start:'2026-11-04 23:00:00',end:'2026-11-05 01:00:00'});f.seed({status:'IN_PROGRESS',start:'2026-11-05 02:00:00',end:null});const s=f.summary();assert.equal(s.completedCount,1);assert.equal(s.workSeconds,3600);
}finally{await f.close();}});

test('待核量/结果未知与已取消不冒充已完成，不良数量不影响单数',async()=>{const f=await fixture();try{
 f.seed();for(const status of ['QUANTITY_PENDING','REPORTING','NEEDS_REVIEW','CANCELLED'])f.seed({status});const s=f.summary();assert.equal(s.completedCount,1);assert.equal(s.quantityPendingCount,1);assert.equal(s.resultPendingCount,2);assert.equal(s.workSeconds,3600);
}finally{await f.close();}});

test('工时缺失不当零，结束日期缺失标明统计不完整',async()=>{const f=await fixture();try{
 f.seed({start:null});let s=f.summary();assert.equal(s.completedCount,1);assert.equal(s.workSeconds,null);assert.equal(s.unknownDurationCount,1);f.seed({end:null});s=f.summary();assert.equal(s.undatedCount,1);assert.equal(s.completeWithinScope,false);assert.equal(s.workSeconds,null);
}finally{await f.close();}});

test('必须鉴权，体验身份不返回个人统计，查询无业务写入',async()=>{const f=await fixture();try{
 f.seed();const before=JSON.stringify(f.store.db.prepare('SELECT * FROM assignments').all());assert.equal((await f.call(undefined,{anonymous:true})).status,401);assert.equal((await f.call(undefined,{scope:'review'})).body.todaySummary,null);assert.equal((await f.call()).body.todaySummary.completedCount,1);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM assignments').all()),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,0);
}finally{await f.close();}});

test('统计失败不阻断员工接收任务，返回可重试统计错误',async()=>{const f=await fixture();try{
 f.seed({status:'READY',end:null});const prepare=f.store.db.prepare.bind(f.store.db);f.store.db.prepare=sql=>{if(sql.includes('SELECT a.status,a.started_at,a.ended_at'))throw Error('fixture stats read failed');return prepare(sql);};const response=await f.call();assert.equal(response.status,200);assert.equal(response.body.assignments.length,1);assert.equal(response.body.todaySummary,null);assert.match(response.body.todaySummaryError,/统计/);
}finally{await f.close();}});
