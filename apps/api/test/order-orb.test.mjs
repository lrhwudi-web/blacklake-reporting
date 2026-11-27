import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {BlacklakeClient} from '../src/blacklake-client.mjs';import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';
const raw={id:201,projectCode:'TEST-201',productCode:'6017594',productName:'样例产品',status:'10',planAmount:'150.000',actualAmount:'0',projectUnit:'个',planStartTime:'2026-11-05 00:00:00',planEndTime:'2026-12-11 00:00:00',updateTime:'2026-11-05 15:19:00',customFieldValues:[{name:'图片',customFieldMetadata:{type:11},value:'https://images.example.test/product.png'},{name:'其他附件',value:'https://images.example.test/private.png'}]};
const client=(rows,onCall=()=>{})=>new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'TEST',timeoutMs:1000},async(url,options)=>{onCall(JSON.parse(options.body));return new Response(JSON.stringify({code:'01000000',data:{list:rows}}));});
test('工单详情直接映射已确认的项目字段，保留零与缺失差异，图片仅取图片字段',async()=>{
 let calls=0;const c=client([raw],()=>calls++),r=await c.readWorkOrderDetails(201,'TEST-201');
 assert.equal(r.plannedAmount,150);assert.equal(r.actualAmount,0);assert.equal(r.planStartTime,raw.planStartTime);assert.equal(r.unit,'个');assert.deepEqual(r.productImageUrls,['https://images.example.test/product.png']);
 r.productImageUrls.push('https://bad.test');assert.equal((await c.readWorkOrderDetails(201,'TEST-201')).productImageUrls.length,1);assert.equal(calls,1);
 const missing=await client([{...raw,planAmount:'',actualAmount:null}]).readWorkOrderDetails(201,'TEST-201');assert.equal(missing.plannedAmount,null);assert.equal(missing.actualAmount,null);
});
test('工单资料按编号查询后再精确匹配ID，拒绝近似工单及同ID编号不一致',async()=>{
 const c=client([{...raw,id:202}]);await assert.rejects(c.readWorkOrderDetails(201,'TEST-201'),e=>e.code==='WORK_ORDER_NOT_FOUND');
 await assert.rejects(client([{...raw,projectCode:'OTHER'}]).readWorkOrderDetails(201,'TEST-201'),e=>e.code==='WORK_ORDER_CHANGED');
 await assert.rejects(c.readWorkOrderDetails(0,'TEST-201'),e=>e.code==='INVALID_WORK_ORDER');
});
test('工单资料完整分页而不误取首页近似工单，未结束分页不会当成空资料',async()=>{
 let calls=0;const c=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'TEST',timeoutMs:1000},async(url,options)=>{const q=JSON.parse(options.body);calls++;assert.equal(q.projectCode,'TEST-201');return new Response(JSON.stringify({code:'01000000',data:{list:q.page.pageNum===1?Array.from({length:100},(_,i)=>({...raw,id:i+1000})):[raw]}}));});
 assert.equal((await c.readWorkOrderDetails(201,'TEST-201')).projectId,201);assert.equal(calls,2);
});
async function fixture(metadataError=false){
 const store=new Store(':memory:',{sessionSecret:'orb-api-fixture',sessionDays:1}),tokens={};
 for(const[id,role]of[[101,'floor8_leader'],[102,'employee'],[103,'floor3_supervisor']]){const p=store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'样例'+id});if(role!=='employee')store.setEntryProfile(id,{appRole:role});tokens[id]=store.createSession(p.id).token;}
 const tasks=[{taskId:1,projectId:201,projectCode:'TEST-201',productName:'样例产品',processName:'已关闭工序',processStatus:20,plannedAmount:150,reportedGoodAmount:150},{taskId:2,projectId:201,projectCode:'TEST-201',productName:'样例产品',processName:'超计划工序',processStatus:10,plannedAmount:150,reportedGoodAmount:160}];
 const blacklake={listWorkOrderProcesses:async(code,options)=>{assert.equal(options.includeCompleted,true);return tasks;},readWorkOrderDetails:async()=>{if(metadataError)throw Error('upstream unavailable');return{projectId:201,projectCode:'TEST-201',productName:'样例产品',actualAmount:0,plannedAmount:150};},createOutput(){assert.fail('详情不得报工');}};
 const server=createServer(createApp({config:{sessionSecret:'orb-api-fixture',sessionDays:1,agent:{enabled:false}},store,blacklake,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return{store,tasks,call:async id=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/dispatch/work-order/detail',{method:'POST',headers:{'Content-Type':'application/json',...(id?{Authorization:'Bearer '+tokens[id]}:{})},body:JSON.stringify({flowCode:'projectId=201'})});return{status:r.status,body:await r.json()};},close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('仅组长读取详情，关闭/超计划只读，整体数量不跨工序相加且无派工报工写入',async()=>{
 const f=await fixture();try{const r=await f.call(101);assert.equal(r.status,200);assert.equal(r.body.workOrder.actualAmount,0);assert.equal(r.body.processOverview[0].closed,true);assert.equal(r.body.processOverview[1].overPlan,true);assert.equal(r.body.source.cacheSeconds,10);assert.equal((await f.call(102)).status,403);assert.equal((await f.call(103)).status,403);assert.equal((await f.call()).status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);}finally{await f.close();}
});
test('上游工单资料失败可继续只读查看工序，缺失量不置零，跨单工序拒绝混合',async()=>{
 const f=await fixture(true);try{const r=await f.call(101);assert.equal(r.status,200);assert.equal(r.body.metadataStatus,'unavailable');assert.equal(r.body.workOrder.actualAmount,undefined);assert.equal(r.body.processOverview.length,2);f.tasks[1].projectId=999;assert.equal((await f.call(101)).status,502);}finally{await f.close();}
});
