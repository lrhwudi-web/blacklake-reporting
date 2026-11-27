import test from 'node:test';
import assert from 'node:assert/strict';
import {BlacklakeRequestBudget} from '../src/blacklake-request-budget.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {nativeFixture} from './native-report-fixture.mjs';

test('总量、写入和登录分别控制小时额度；重启不清空',async()=>{
 let at=120000,saved,calls=0;
 const options={totalPerHour:5,writePerHour:2,loginPerHour:1,totalQps:5,writeQps:2,now:()=>at,save:v=>saved=v};
 const budget=new BlacklakeRequestBudget(options),fn=()=>++calls;
 await budget.run(fn,{kind:'write'});await budget.run(fn,{kind:'write'});
 await assert.rejects(budget.run(fn,{kind:'write'}),{code:'BLACKLAKE_REQUEST_DEFERRED'});
 await budget.run(fn,{kind:'login'});await assert.rejects(budget.run(fn,{kind:'login'}),{code:'BLACKLAKE_REQUEST_DEFERRED'});
 await budget.run(fn);await budget.run(fn);
 at+=1001;const resumed=new BlacklakeRequestBudget({...options,load:()=>saved});
 await assert.rejects(resumed.run(fn,{priority:true}),{code:'BLACKLAKE_REQUEST_DEFERRED'});
 assert.deepEqual(resumed.status().usage,{total:5,write:2,login:1});
 at+=3600000+60000;await resumed.run(fn,{kind:'write'});assert.equal(calls,6);
});
test('执行中的请求可并行，总 QPS 20 和写 QPS 10 各自生效',async()=>{
 let at=120000;const budget=new BlacklakeRequestBudget({now:()=>at,maxWaitMs:0});let calls=0;
 const fn=()=>++calls;
 await Promise.all(Array.from({length:10},()=>budget.run(fn,{kind:'write'})));
 await assert.rejects(budget.run(fn,{kind:'write'}),{code:'BLACKLAKE_REQUEST_DEFERRED'});
 await Promise.all(Array.from({length:10},()=>budget.run(fn,{priority:true})));
 await assert.rejects(budget.run(fn,{priority:true}),{code:'BLACKLAKE_REQUEST_DEFERRED'});
 assert.equal(calls,20);at+=1000;
 await Promise.all(Array.from({length:10},()=>budget.run(fn,{kind:'write'})));assert.equal(calls,30);
});
test('429遵循Retry-After并持久冷却，恢复后降速',async()=>{
 let at=120000,saved;const budget=new BlacklakeRequestBudget({now:()=>at,save:v=>saved=v});await budget.run(()=>1);budget.response(429,'240');assert.equal(budget.state.cooldownUntil,at+240000);assert.equal(budget.status().penalty,1);
 const resumed=new BlacklakeRequestBudget({now:()=>at,load:()=>saved});let called=false;await assert.rejects(resumed.run(()=>called=true),{code:'BLACKLAKE_RATE_COOLDOWN'});assert.equal(called,false);at+=240001;await resumed.run(()=>called=true);assert.equal(called,true);assert.equal(resumed.status().last30Minutes.rateLimited,1);
});
test('并行上限满时优先取写入，超时排队不外发',async()=>{
 const budget=new BlacklakeRequestBudget({maxInFlight:2,maxWaitMs:1000});let release;const calls=[],gate=new Promise(r=>release=r);
 const first=budget.run(()=>{calls.push('first');return gate;}),second=budget.run(()=>{calls.push('second');return gate;});
 await new Promise(r=>setTimeout(r,0));assert.equal(budget.status().inFlight,2);
 const low=budget.run(()=>calls.push('background')),high=budget.run(()=>calls.push('write'),{kind:'write'});release();await Promise.all([first,second,low,high]);assert.deepEqual(calls,['first','second','write','background']);
 const blocked=new BlacklakeRequestBudget({maxInFlight:1,maxWaitMs:10});let done;const active=blocked.run(()=>new Promise(r=>done=r));await new Promise(r=>setTimeout(r,0));let sent=false;await assert.rejects(blocked.run(()=>sent=true),{code:'BLACKLAKE_REQUEST_DEFERRED'});assert.equal(sent,false);done();await active;
});
test('登录、原生与OpenAPI全部经过同一预算，POST业务上下文覆盖查询链',async()=>{
 const calls=[],roles=[],client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',loginPath:'/login',account:'synthetic',password:'synthetic',timeoutMs:1000},async url=>{calls.push(url);return Response.json(url.endsWith('/login')?{code:'01000000',data:'synthetic-token'}:{code:'01000000',data:{}});});
 client.requestBudget={run:async(fn,{priority})=>{roles.push(priority);return fn();},response:()=>{}};
 await client.withPriority(async()=>{await client.nativeRequest('/native',{});await client.request('/query',{});});assert.equal(calls.length,3);assert.deepEqual(roles,[true,true,true]);await client.request('/background',{});assert.equal(roles.at(-1),false);
});

test('相同工单和任务参数十秒内不重复发出，其他工单和写入可以继续',async()=>{
 let at=100000,saved;const calls=[],options={maxWaitMs:100,now:()=>at,save:v=>saved=v};
 const taskPath='/api/dytin/external/task/queryList2',client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000,taskQueryPath:taskPath},async(url,req)=>{
  calls.push([url,JSON.parse(req.body)]);return Response.json({code:'01000000',data:[]});
 });
 client.requestBudget=new BlacklakeRequestBudget(options);
 const body={projectIds:[201],page:{pageNum:1,pageSize:100}};
 await Promise.all([client.request(taskPath,body),client.request(taskPath,{page:{pageSize:100,pageNum:1},projectIds:[201]})]);at+=100;
 assert.equal(calls.length,1);
 await client.request(taskPath,{...body,projectIds:[202]});at+=100;
 await client.nativeRequest('/api/dytin/project/priority/update',{projectId:201,priority:2},{write:true});at+=100;
 client.requestBudget=new BlacklakeRequestBudget({...options,load:()=>saved});
 await assert.rejects(client.request(taskPath,body),e=>e.code==='BLACKLAKE_REQUEST_DEFERRED');
 at=110001;await client.request(taskPath,body);
 assert.equal(calls.length,4);
});

test('限速只证明当前写请求未发出；后续回读被限速不能变成明确失败',async()=>{
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async()=>{throw Error('must not send');});client.requestBudget={run:()=>Promise.reject(Object.assign(Error('budget'),{code:'BLACKLAKE_REQUEST_DEFERRED',retryAfterMs:1000}))};
 await assert.rejects(client.request('/write',{}, {write:true}),e=>e.writeNotSent===true&&e.definiteFailure===true);
 await assert.rejects(client.request('/readback',{}),e=>!e.writeNotSent&&!e.definiteFailure);
});

test('429即使返回非JSON也触发统一冷却，所有后续入口都不再发出HTTP',async()=>{
 let calls=0;const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async()=>{calls++;return new Response('rate limited',{status:429,headers:{'Retry-After':'180'}});}),budget=new BlacklakeRequestBudget();client.requestBudget=budget;
 await assert.rejects(client.request('/query',{}),e=>e.upstreamStatus===429);assert.equal(calls,1);assert(budget.state.cooldownUntil>=Date.now()+179000);await assert.rejects(client.nativeRequest('/native',{}),e=>e.code==='BLACKLAKE_RATE_COOLDOWN');assert.equal(calls,1);
});

test('完整原生更正在写前被限速可安全延期，已写后的回读被限速必须保留未知',async()=>{
 for(const afterWrite of [false,true]){const f=nativeFixture(),original=await f.client.readOutputForCorrection(1001,{production:true}),input={goodAmount:80,defectAmount:0,defectCodes:[],defectItems:[],operatorId:201,operatorName:'测试员工',startedAt:'2026-11-10 11:00:00',endedAt:'2026-11-10 14:20:00',durationSeconds:5700,planRestTime:5400,unplanShutdownTime:900,materialProcess:''},plan=await f.client.prepareOutputCorrection(original,input);let steps=0;
  f.client.requestBudget={response:()=>{},run:async fn=>{steps++;if(afterWrite?f.calls.some(c=>c.url.endsWith('/update')):steps===2)throw Object.assign(Error('budget'),{code:'BLACKLAKE_REQUEST_DEFERRED'});return fn();}};
  await assert.rejects(f.client.updateOutputConfirmed(original,{...input,nativePlan:plan}),e=>e.code==='BLACKLAKE_REQUEST_DEFERRED'&&(afterWrite?!e.definiteFailure:e.definiteFailure===true));assert.equal(f.remote.fineAmount,afterWrite?80:100);assert.equal(f.calls.filter(c=>c.url.endsWith('/update')).length,afterWrite?1:0);
 }
});
