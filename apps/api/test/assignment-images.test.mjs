import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';
import{Store}from'../src/store.mjs';import{createApp}from'../src/app.mjs';
import{BlacklakeClient}from'../src/blacklake-client.mjs';
async function fixture(realClient=false){
 const config={sessionSecret:'assignment-images-isolated',sessionDays:1,agent:{enabled:false}},store=new Store(':memory:',config),tokens=[];
 const people=[301,302].map(id=>store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'同名员工'}));
 for(const p of people)tokens.push(store.createSession(p.id).token);
 for(const [i,p]of people.entries())store.dispatchAssignment({id:'image-task-'+i,operatorId:p.id,taskId:201+i,projectId:101+i,projectCode:'WO-'+(101+i),productName:'样例产品',processName:'车耳朵',quantity:100,stationName:'A-03',publishedAt:'2026-11-06 08:00:00',publishedBy:'测试组长',flowCodeHash:'fixture'});
 let fail=false,mismatch=false,delay=null,urls=['https://images.example.test/101.png'];const calls=[];
 const blacklake=realClient?new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'TEST',timeoutMs:1000},async(url,options)=>{
  calls.push([url,JSON.parse(options.body)]);return new Response(JSON.stringify({code:'01000000',data:{list:[{id:101,projectCode:'WO-101',customFieldValues:[{name:'图片',customFieldMetadata:{type:11},value:'https://images.example.test/real-client.png'}]}]}}));
 }):{readWorkOrderDetails:async(id,code)=>{calls.push([id,code]);if(delay)await delay;if(fail)throw Error('PRIVATE_URL_OR_SECRET');return{projectId:mismatch?999:id,projectCode:code,productImageUrls:urls};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(id='image-task-0',who=0)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/assignments/'+id+'/product-images',{headers:who===null?{}:{Authorization:'Bearer '+tokens[who]}});return{status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
 return{store,calls,call,setDelay:v=>delay=v,setFail:v=>fail=v,setMismatch:v=>mismatch=v,setUrls:v=>urls=v,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('员工仅能读取本人任务产品图，匿名/同名他人/不存在均受保护且不调用上游',async()=>{const f=await fixture();try{
 assert.equal((await f.call('image-task-0',null)).status,401);assert.equal((await f.call('image-task-0',1)).status,404);assert.equal((await f.call('missing')).status,404);assert.equal(f.calls.length,0);
 const before=f.store.db.prepare('SELECT * FROM assignments ORDER BY id').all(),result=await f.call();assert.equal(result.status,200);assert.deepEqual(result.body,{assignmentId:'image-task-0',projectId:101,projectCode:'WO-101',productImageUrls:['https://images.example.test/101.png']});assert.equal(result.cache,'private, no-store');assert.deepEqual(f.calls,[[101,'WO-101']]);assert.deepEqual(f.store.db.prepare('SELECT * FROM assignments ORDER BY id').all(),before);
}finally{await f.close();}});
test('无图片明确空数组，上游失败可重试但不泄露私有错误、不更改任务',async()=>{const f=await fixture();try{
 f.setUrls([]);assert.deepEqual((await f.call()).body.productImageUrls,[]);f.setFail(true);const r=await f.call();assert.equal(r.status,502);assert.equal(r.body.error.code,'PRODUCT_IMAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_URL/);assert.equal(f.store.assignmentById('image-task-0').status,'READY');f.setFail(false);assert.equal((await f.call()).status,200);
}finally{await f.close();}});
test('拒绝上游返回不同工单的图片，不能用任务ID或名称猜配',async()=>{const f=await fixture();try{
 f.setMismatch(true);const r=await f.call();assert.equal(r.status,502);assert.equal(r.body.error.code,'PRODUCT_IMAGE_MISMATCH');assert.equal('productImageUrls' in r.body,false);
}finally{await f.close();}});
test('图片读取期间改派后原员工不能再收到该任务图片',async()=>{const f=await fixture();let release;try{
 f.setDelay(new Promise(r=>release=r));const result=f.call();while(!f.calls.length)await new Promise(r=>setTimeout(r,1));
 const other=f.store.findOperatorByBlacklakeId(302);f.store.db.prepare('UPDATE assignments SET operator_id=? WHERE id=?').run(other.id,'image-task-0');release();const response=await result;assert.equal(response.status,404);assert.equal('productImageUrls' in response.body,false);
}finally{release?.();await f.close();}});
test('本人图片接口串通真实BlacklakeClient方法和图片字段，不使用自造方法替身',async()=>{const f=await fixture(true);try{
 const r=await f.call();assert.equal(r.status,200);assert.deepEqual(r.body.productImageUrls,['https://images.example.test/real-client.png']);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'https://fixture.invalid/api/dytin/external/project/queryList');assert.equal(f.calls[0][1].projectCode,'WO-101');
}finally{await f.close();}});
