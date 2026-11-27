import test from 'node:test';
import assert from 'node:assert/strict';
import {BlacklakeClient} from '../src/blacklake-client.mjs';

const input={operator:{blacklakeOperatorId:101,name:'PRIVATE_PERSON'},task:{projectId:30,taskId:31,projectCode:'TEST'},amount:12,defectAmount:2,defectCodes:['D1'],outputTime:'2026-11-19 10:00:00',actualStartedAt:'2026-11-19 09:00:00',actualEndedAt:'2026-11-19 10:00:00'};
const stamp=ms=>new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' ');
const row=(fields={})=>({reportingId:4001,projectId:30,taskId:31,productionStaffId:101,numberofgoodProducts:10,numberofDefectives:2,defectItemList:[{code:'D1',amount:2}],starttimeofReport:input.actualStartedAt,endtimeofReport:input.actualEndedAt,createdAt:stamp(Date.now()),...fields});
const ok=data=>Response.json({code:'01000000',data});
const page=(data,total=data.length)=>Response.json({code:'01000000',data,page:{total}});
function fixture(write,read=()=>page([])){
 const calls=[],evidence=[];
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'PRIVATE_TOKEN',timeoutMs:1000,outputAddPath:'/add',outputQueryPath:'/query'},async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push({path,body});
  return path==='/add'?write():read(body);
 });
 client.limitWriteRate=async()=>{};
 return {calls,evidence,submit:()=>client.createOutput({...input,onCreateEvidence:data=>evidence.push(data)})};
}
test('已确认成功的具名 reportingId 被解析，响应证据不带人员、原正文或令牌',async()=>{
 const f=fixture(()=>ok({reportingId:'4001',token:'PRIVATE_TOKEN',name:'PRIVATE_PERSON',note:'PRIVATE_BODY'}));
 assert.equal((await f.submit()).id,'4001');
 assert.deepEqual(f.calls.map(c=>c.path),['/add']);
 assert.equal(f.evidence[0].outcome,'accepted-with-id');
 assert(f.evidence[0].idFields['data.reportingId']);
 assert.doesNotMatch(JSON.stringify(f.evidence),/PRIVATE_/);
});
test('成功但未取得编号，首次提交立即用工单查询及精确回读关联，只写一次',async()=>{
 const f=fixture(()=>ok(1),query=>{assert.equal(query.projectCode,'TEST');return page([row()]);});
 const result=await f.submit();
 assert.equal(result.id,'4001');assert.equal(result.readbackConfirmed,true);
 assert.deepEqual(f.calls.map(c=>c.path),['/add','/query','/query']);
 assert.equal(f.calls[2].body.id,4001);
 assert.equal(f.evidence[0].outcome,'accepted-without-id');
 assert.equal(f.evidence[0].dataType,'number');
});
test('异常或互相矛盾的回执不能当成功，也不能触发第二次创建',async()=>{
 for(const [reply,format] of [
  [()=>new Response(null,{status:204}),'empty'],
  [()=>new Response('<html>PRIVATE_BODY</html>'),'non-json'],
  [()=>Response.json({error:{message:'PRIVATE_BODY'},data:{id:4001}}),'object'],
  [()=>Response.json({code:'01000000',success:false,data:{id:4001}}),'object'],
  [()=>Response.json({code:'01000000',statusCode:500,data:{id:4001}}),'object'],
  [()=>ok({id:4001,outputId:4002}),'object'],
 ]){
  const f=fixture(reply);
  await assert.rejects(f.submit(),e=>e.writeOutcomeUnknown===true);
  assert.deepEqual(f.calls.map(c=>c.path),['/add','/query']);
  assert.equal(f.evidence[0].format,format);
  assert.doesNotMatch(JSON.stringify(f.evidence),/PRIVATE_/);
 }
});
test('回查遇到多候选、旧记录、分页未完、精确回读变化或限流，不能关联也不能变成写重试',async()=>{
 for(const read of [
  ()=>page([row(),row({reportingId:4002})]),
  ()=>page([row({createdAt:'2026-01-01 00:00:00'})]),
  ()=>page([row()],101),
  q=>page([row(q.id?{numberofgoodProducts:9}:{})]),
  ()=>new Response('PRIVATE_BODY',{status:429}),
 ]){
  const f=fixture(()=>ok(null),read);
  await assert.rejects(f.submit(),e=>e.writeOutcomeUnknown===true&&e.upstreamStatus!==429);
  assert.equal(f.calls.filter(c=>c.path==='/add').length,1);
 }
});
test('明确拒绝和创建请求自身的限流不进行回读',async()=>{
 const rejected=fixture(()=>Response.json({code:-1,success:false,message:'PRIVATE_BODY'}));
 await assert.rejects(rejected.submit(),e=>e.definiteFailure===true&&!String(e.message).includes('PRIVATE_'));
 assert.deepEqual(rejected.calls.map(c=>c.path),['/add']);
 assert.equal(rejected.evidence[0].outcome,'rejected');
 const limited=fixture(()=>new Response('PRIVATE_BODY',{status:429}));
 await assert.rejects(limited.submit(),e=>e.upstreamStatus===429&&e.definiteFailure===true);
 assert.deepEqual(limited.calls.map(c=>c.path),['/add']);
 const conflicting=fixture(()=>Response.json({code:'01000000',data:{id:4001}},{status:429}));
 await assert.rejects(conflicting.submit(),e=>e.writeOutcomeUnknown===true&&e.upstreamStatus!==429);
 assert.deepEqual(conflicting.calls.map(c=>c.path),['/add','/query']);
});

test('提交连接中断但黑湖已创建时，首次回读收敛且不重发',async()=>{
 const f=fixture(()=>{throw Object.assign(Error('PRIVATE_BODY'),{name:'TimeoutError'});},()=>page([row()]));
 assert.equal((await f.submit()).id,'4001');
 assert.equal(f.evidence[0].outcome,'unconfirmed-transport');
 assert.equal(f.evidence[0].code,'BLACKLAKE_TIMEOUT');
 assert.deepEqual(f.calls.map(c=>c.path),['/add','/query','/query']);
});
