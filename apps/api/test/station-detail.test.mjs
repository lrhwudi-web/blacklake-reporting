import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';

async function fixture(){
 const config={sessionSecret:'station-detail-synthetic-only',sessionDays:1,agent:{enabled:false},review:{enabled:false}},store=new Store(':memory:',config),tokens={};
 for(const[id,name,role]of[[101,'组长甲','floor8_leader'],[102,'组长乙','floor8_leader'],[201,'主管','floor3_supervisor'],[301,'员工甲','employee'],[302,'员工乙','employee']]){const p=store.upsertBlacklakeOperator({blacklakeOperatorId:id,name});if(role!=='employee')store.setEntryProfile(id,{appRole:role});tokens[id]=store.createSession(p.id).token;}
 const calls=[];let tasks=[],fail=false;
 const blacklake={listProjectTasks:async(...args)=>{calls.push(args);if(fail)throw Error('PRIVATE UPSTREAM FAILURE');return tasks;}};
 const server=createServer(createApp({config,store,blacklake,wechat:{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path='/v1/dispatch/units/A-03',who=101)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:who?{Authorization:'Bearer '+tokens[who]}:{}});return{status:response.status,body:await response.json()};};
 const seed=({id='task-current',worker=301,taskId=102,projectId=200,unit='A-03',status='IN_PROGRESS',owner=102}={})=>{const p=store.findOperatorByBlacklakeId(worker);store.dispatchAssignment({id,operatorId:p.id,taskId,projectId,projectCode:'TEST-'+projectId,productName:'测试产品',processName:'同名工序',quantity:100,stationName:unit.startsWith('3F-')?'':unit,machineId:unit.startsWith('3F-')?unit:'',publishedAt:'2026-11-05 08:00:00',publishedBy:'组长乙',publishedByOperatorId:owner,flowCodeHash:'synthetic'},{allowQueue:true});store.db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status,id);};
 return{store,tokens,calls,call,seed,setTasks:v=>tasks=v,setFail:()=>fail=true,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
const process=(taskId,sequence,good=0,extra={})=>({taskId,projectId:200,sequence,processName:'同名工序',plannedAmount:100,reportedGoodAmount:good,quantityPresence:{plannedAmount:true,reportedGoodAmount:true,sequence:true},processStatus:10,processStatusDisplay:'执行中',...extra});

test('现场工位详情鉴权和楼层约束，禁止员工、匿名及任意工位查询',async()=>{
 const f=await fixture();try{assert.equal((await f.call(undefined,null)).status,401);assert.equal((await f.call(undefined,301)).status,403);assert.equal((await f.call('/v1/dispatch/units/3F-01')).status,422);assert.equal((await f.call('/v1/dispatch/units/A-03',201)).status,422);assert.equal((await f.call('/v1/dispatch/units/not-a-station')).status,422);assert.equal((await f.call('/v1/dispatch/units/3F-01',201)).status,200);assert.equal((await f.call('/v1/dispatch/units/'+encodeURIComponent('包装/质检'))).status,200);}finally{await f.close();}
});
test('多人当前占用共享但个人派工历史继续隔离；按任务ID定位，保留已结束步骤及102%',async()=>{
 const f=await fixture();try{f.seed();f.seed({id:'ready-other',worker:302,taskId:103,status:'READY'});f.store.setDispatchUnitRecommendations('A-03',[301,302]);f.setTasks([process(103,3,102),process(101,1,100,{processStatus:20}),process(102,2,97)]);
  const before=f.store.db.prepare('SELECT * FROM assignments ORDER BY id').all(),result=await f.call();assert.equal(result.status,200);const data=result.body;assert.equal(data.residents.length,2);assert.equal(data.assignments.length,2);const current=data.assignments.find(a=>a.id==='task-current');assert.deepEqual(current.steps.map(p=>p.taskId),[101,102,103]);assert.deepEqual(current.steps.map(p=>p.percentLabel),['100%','97%','102%']);assert.equal(current.steps[0].closed,true);assert.equal(current.steps[2].closed,false);assert.deepEqual(current.steps.filter(p=>p.current).map(p=>p.taskId),[102]);assert.equal(data.assignments.find(a=>a.id==='ready-other').statusLabel,'待开始');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0][0],{projectIds:[200]});assert.deepEqual(f.store.db.prepare('SELECT * FROM assignments ORDER BY id').all(),before);assert.equal('publishedBy' in current,false);
  const own=await f.call('/v1/dispatch/history?includeActive=true');assert.equal(own.body.total,0);
 }finally{await f.close();}
});
test('数量缺失、零计划和未确认序号不伪装成0%或已完成，当前上游关闭独立提示',async()=>{
 const f=await fixture();try{f.seed();f.setTasks([process(101,1,0,{quantityPresence:{reportedGoodAmount:false}}),process(102,0,0,{plannedAmount:0,processStatus:20}),process(103,3,0)]);const d=(await f.call()).body.assignments[0];assert.equal(d.steps.find(p=>p.taskId===101).percent,null);assert.equal(d.steps.find(p=>p.taskId===102).percentLabel,'未确认');assert.equal(d.steps.find(p=>p.taskId===103).percentLabel,'0%');assert.equal(d.currentProcessClosed,true);assert.equal(d.orderUnconfirmed,true);}finally{await f.close();}
});
test('上游失败和当前工序缺失仍保留本地任务，禁止猜同名工序或串工单',async()=>{
 const f=await fixture();try{f.seed();f.setFail();let d=(await f.call()).body.assignments[0];assert.equal(d.operatorName,'员工甲');assert.equal(d.steps[0].current,true);assert.equal(d.steps[0].percent,null);assert.match(d.progressError,/暂未取得/);assert.doesNotMatch(JSON.stringify(d),/PRIVATE/);}finally{await f.close();}
 const g=await fixture();try{g.seed();g.setTasks([process(999,1,100,{projectId:201}),process(104,2,50)]);const d=(await g.call()).body.assignments[0];assert.equal(d.steps.some(p=>p.taskId===999),false);assert.equal(d.steps.find(p=>p.current).taskId,102);assert.match(d.progressError,/未在黑湖/);}finally{await g.close();}
});
test('常驻绑定不当成正在生产，已结束和待核量不占工位，无任务不请求上游',async()=>{
 const f=await fixture();try{f.store.setDispatchUnitRecommendations('A-03',[301]);f.seed({status:'COMPLETED'});f.seed({id:'pending',worker:302,status:'QUANTITY_PENDING',taskId:104});const d=(await f.call()).body;assert.equal(d.assignments.length,0);assert.equal(d.residents[0].activeHere,false);assert.equal(f.calls.length,0);assert.match(d.coverage.localSource,/不代表人员实时到岗/);}finally{await f.close();}
});

test('体验身份即使挂在组长人员上也拒绝；3楼绑定可见但不暴露手机号，旧零值缺存在标记仍未知',async()=>{
 const f=await fixture();try{f.tokens.review=f.store.createSession(f.store.findOperatorByBlacklakeId(101).id,{scope:'review'}).token;assert.equal((await f.call(undefined,'review')).status,403);
 f.store.setEntryProfile(301,{appRole:'employee',workUnitId:'3F-01'});f.seed({unit:'3F-01'});f.setTasks([process(102,1,0,{quantityPresence:undefined})]);const result=await f.call('/v1/dispatch/units/3F-01',201);assert.equal(result.status,200);assert.equal(result.body.residents[0].name,'员工甲');assert.equal(result.body.assignments[0].steps[0].percent,null);assert.equal('phoneLast4' in result.body.residents[0],false);
 }finally{await f.close();}
});
