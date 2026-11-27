import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {processProgress} from '../src/process-progress.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
const task=(good,status=10,plan=100)=>({plannedAmount:plan,reportedGoodAmount:good,processStatus:status,quantityPresence:{plannedAmount:true,reportedGoodAmount:true}});
test('工序进度0/45/72/109按累计良品与计划计算，超额不自动关闭',()=>{
 for(const good of [0,45,72,109]){const p=processProgress(task(good,good===0?0:10));assert.equal(p.percent,good);assert.equal(p.closed,false);assert.equal(p.statusLabel,good===0?'未开始':good>100?'超计划':'进行中');}
 assert.equal(processProgress(task(100)).closed,false);assert.equal(processProgress(task(100)).statusLabel,'进行中');
});
test('关闭使用实际黑湖状态，缺量仍可知道已关闭；未知和零计划不伪装0%',()=>{
 assert.equal(processProgress({processStatus:20}).closed,true);assert.equal(processProgress({processStatusDisplay:'已关闭'}).statusLabel,'已关闭');
 for(const t of [{},task(10,10,0),{...task(0),quantityPresence:{plannedAmount:true,reportedGoodAmount:false}},{plannedAmount:100,reportedGoodAmount:0},{...task(20),plannedAmount:Infinity}])assert.equal(processProgress(t).percent,null);
 assert.equal(processProgress(task(0)).statusLabel,'进行中');assert.equal(processProgress({...task(45),processStatus:null}).statusLabel,'状态未确认');
});
function clientFor(rows){const pages=[];return {pages,client:new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'TEST',taskQueryPath:'/tasks',timeoutMs:1000},async(_url,opts)=>{const page=JSON.parse(opts.body).page;pages.push(page.pageNum);return new Response(JSON.stringify({code:'01000000',data:{list:rows.slice((page.pageNum-1)*100,page.pageNum*100)}}));})};}
const raw=(id,fineAmount,status=10)=>({id,projectId:201,projectCode:'TEST-WO',processCode:'P'+id,processName:'工序'+id,seq:id,planAmount:100,fineAmount,processStatus:status});
test('完整工序超过100项分页，缓存复用，默认可选列表仍排除关闭且保留超计划',async()=>{
 const {client,pages}=clientFor(Array.from({length:101},(_,i)=>raw(i+1,i===1?109:0,i===0?20:10)));
 const all=await client.listWorkOrderProcesses('projectId=201',{includeCompleted:true});assert.equal(all.length,101);assert.deepEqual(pages,[1,2]);
 const active=await client.listWorkOrderProcesses('projectId=201');assert.equal(active.length,100);assert(active.some(p=>p.taskId===2));assert.deepEqual(pages,[1,2]);
 await assert.rejects(client.findWorkOrderProcess('projectId=201',1),e=>e.code==='PROCESS_NOT_AVAILABLE');
});
async function fixture(rows){
 const config={sessionSecret:'progress-fixture-secret',sessionDays:1,agent:{enabled:false}},store=new Store(':memory:',config);
 const person=store.upsertBlacklakeOperator({name:'测试员工',blacklakeOperatorId:301});store.setSelfServicePermission(301,true,0,'TEST');
 const token=store.createSession(person.id).token,{client}=clientFor(rows);client.listOperators=async()=>[{name:'测试员工',blacklakeOperatorId:301}];
 const server=createServer(createApp({config,store,blacklake:client,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,data,authorized=true)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
 return {call,store,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('自主完整进度只读包含关闭项，推荐和开工候选不包含关闭，旧客户端响应兼容',async()=>{
 const f=await fixture([raw(1,100,20),raw(2,45),raw(3,109)]);try{
 const input={flowCode:'projectId=201',reportingMode:'standard',selfService:'employee',includeProgress:true};
 const before=f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n;
 const r=await f.call('/v1/flow/options',input);assert.equal(r.status,200);assert.equal(r.body.processOverview.length,3);assert.equal(r.body.processOverview[0].closed,true);assert.equal(r.body.processOverview[0].selectable,false);assert.equal(r.body.processOverview[1].percent,45);assert.equal(r.body.processOverview[2].statusLabel,'超计划');assert.deepEqual(r.body.processes.map(p=>p.taskId),[2,3]);assert.equal(r.body.progressSource.source,'BLACKLAKE');
 const legacy=await f.call('/v1/flow/options',{...input,includeProgress:false});assert.equal(legacy.status,200);assert.equal(legacy.body.processOverview,undefined);assert.deepEqual(legacy.body.processes.map(p=>p.taskId),[2,3]);
 assert.equal((await f.call('/v1/flow/options',input,false)).status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,before);
 }finally{await f.close();}
});
test('全部关闭工单可只读查看进度，仍没有任何可开工项',async()=>{
 const f=await fixture([raw(1,50,20)]);try{const r=await f.call('/v1/flow/options',{flowCode:'projectId=201',selfService:'employee',includeProgress:true,reportingMode:'standard'});assert.equal(r.status,200);assert.deepEqual(r.body.processes,[]);assert.equal(r.body.processOverview[0].selectable,false);assert.equal(r.body.recommendedProcess,null);}finally{await f.close();}
});
