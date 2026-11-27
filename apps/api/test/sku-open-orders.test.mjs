import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {createApp} from '../src/app.mjs';
import {Store} from '../src/store.mjs';

const picture='https://images.example.test/product.png';
const raw=(id,status,extra={})=>({id,projectCode:'TEST-'+id,productCode:'SKU-OPEN',productName:'测试产品',status,
  customFieldValues:[{name:'图片',customFieldMetadata:{type:11},value:picture}],...extra});
function catalog(rows){const client=new BlacklakeClient({mode:'live'});let calls=0;
  client.request=async(_path,input)=>{calls++;return {data:input.projectCode===String(new Date().getFullYear())?rows:[]};};
  return {client,calls:()=>calls};
}
async function fixture(rows){
  const {client}=catalog(rows),config={sessionSecret:'sku-open-test-only',sessionDays:1,reportingModeAdminOperatorIds:[],agent:{enabled:false}};
  const store=new Store(':memory:',config);
  const worker=store.upsertBlacklakeOperator({blacklakeOperatorId:301,name:'测试员工'});
  const leader=store.upsertBlacklakeOperator({blacklakeOperatorId:302,name:'测试组长'});
  const denied=store.upsertBlacklakeOperator({blacklakeOperatorId:303,name:'未授权员工'});
  store.setSelfServicePermission(301,true,0,'TEST:sku-open');store.setEntryProfile(302,{appRole:'floor8_leader'});
  const tokens=[worker,leader,denied].map(p=>store.createSession(p.id).token);
  const server=createServer(createApp({config,store,blacklake:client,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const search=async(path,person=0)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[person]},body:JSON.stringify({sku:'SKU-OPEN'})});return {status:r.status,body:await r.json()};};
  return {client,search,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('SKU目录保留真实工单状态和图片，历史查询仍能读取已结束工单',async()=>{
  const f=catalog([raw(1,'10'),raw(2,'20')]);const rows=await f.client.searchWorkOrdersBySku('SKU-OPEN');
  assert.equal(rows.find(r=>r.projectId===1).projectStatus,'10');assert.equal(rows.find(r=>r.projectId===2).projectStatus,'20');
  assert.deepEqual(rows.find(r=>r.projectId===1).productImageUrls,[picture]);
  await f.client.searchWorkOrdersBySku('SKU-OPEN');assert.equal(f.calls(),2);
});

test('员工与组长SKU搜索均隐藏已结束工单，六张只保留一张且图片不丢',async()=>{
  const f=await fixture([raw(1,'10'),...Array.from({length:5},(_,i)=>raw(i+2,'20'))]);
  try{for(const [path,person]of [['/v1/flow/work-orders/search',0],['/v1/dispatch/work-orders/search',1]]){
    const result=await f.search(path,person);assert.equal(result.status,200);assert.deepEqual(result.body.workOrders.map(r=>r.projectId),[1]);
    assert.deepEqual(result.body.workOrders[0].productImageUrls,[picture]);
  }
  assert.equal((await f.search('/v1/flow/work-orders/search',2)).status,403);
  assert.equal((await f.search('/v1/dispatch/work-orders/search',0)).status,403);
  }finally{await f.close();}
});

test('只按工单结束状态过滤，计划数量已达到、未知状态或工序关闭不误隐藏',async()=>{
  const f=await fixture([raw(1,'10',{planAmount:100,actualAmount:120,processStatus:20}),raw(2,undefined),raw(3,null),raw(4,'未知'),raw(5,20),raw(6,' 已结束 ')]);
  try{const result=await f.search('/v1/flow/work-orders/search');assert.equal(result.status,200);assert.deepEqual(result.body.workOrders.map(r=>r.projectId).sort(),[1,2,3,4]);}
  finally{await f.close();}
});

test('匹配的工单全已结束时返回空列表，不改变共享历史目录',async()=>{
  const f=await fixture([raw(1,20),raw(2,'20')]);
  try{const result=await f.search('/v1/flow/work-orders/search');assert.equal(result.status,200);assert.deepEqual(result.body.workOrders,[]);assert.equal((await f.client.searchWorkOrdersBySku('SKU-OPEN')).length,2);}
  finally{await f.close();}
});
