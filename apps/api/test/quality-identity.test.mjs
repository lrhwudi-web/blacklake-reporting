import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';import {QuantityResolution} from '../src/quantity-resolution.mjs';
async function fixture(){
 const config={sessionSecret:'quality-identity-fixture',adminApiKey:'quality-admin-fixture',sessionDays:30,reportingModeAdminOperatorIds:[],agent:{enabled:false}},store=new Store(':memory:',config);
 const people=[{name:'测试普通员工',blacklakeOperatorId:301,groupNames:[]},{name:'测试质检人员',blacklakeOperatorId:302,groupNames:[]}],operators=people.map(p=>store.upsertBlacklakeOperator(p)),tokens=operators.map(o=>store.createSession(o.id).token),writes=[];
 for(const p of people)store.setSelfServicePermission(p.blacklakeOperatorId,true,0,'TEST');
 const tasks=[{taskId:11,projectId:201,projectCode:'TEST-WO',productName:'测试产品',processName:'合缝',processCode:'SEW',plannedAmount:100,defaultReportAmount:100,processStatus:10,reportedGoodAmount:0,reportedDefectAmount:0},{taskId:12,projectId:201,projectCode:'TEST-WO',productName:'测试产品',processName:'外观检测',processCode:'QC',plannedAmount:100,defaultReportAmount:100,processStatus:10,reportedGoodAmount:0,reportedDefectAmount:0}];
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>tasks,findWorkOrderProcess:async(_flow,id)=>tasks.find(p=>p.taskId===Number(id)),findTaskById:async id=>tasks.find(p=>p.taskId===Number(id)),createOutput:async payload=>{writes.push(payload);return{id:'test-output-'+writes.length};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{},defectReasons:[{code:'D-1',name:'测试不良'}]}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{admin=false,person=0,method='GET',body,key,headers={}}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[person]}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const set=async(role,{id=302,revision=store.qualityProfile(id).qualityRevision,...options}={})=>call('/v1/admin/operators/'+id+'/quality-profile',{admin:true,method:'PATCH',body:{qualityRole:role,expectedRevision:revision},...options});
 const start=async(person,taskId=11)=>call('/v1/flow/start',{person,method:'POST',key:'quality-start-'+person+'-'+taskId,body:{flowCode:'projectId=201',taskId,reportingMode:'standard',selfService:'employee'}});
 return {store,operators,call,set,start,writes,tasks,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('普通人员做检测仍是普通数量，质检人员做合缝仍显示合格/不良',async()=>{const f=await fixture();try{
 assert.equal((await f.set('quality')).status,200);const normal=await f.start(0,12),quality=await f.start(1,11);assert.equal(normal.status,201);assert.equal(quality.status,201);assert.equal(normal.body.assignment.isQualityInspection,false);assert.equal(quality.body.assignment.isQualityInspection,true);
 assert.equal(f.store.activeAssignments(f.operators[1].id)[0].isQualityInspection,true);
 const one=await f.call('/v1/assignments/'+normal.body.assignment.id+'/finish-default');const two=await f.call('/v1/assignments/'+quality.body.assignment.id+'/finish-default',{person:1});assert.equal(one.body.defectReasons,undefined);assert.deepEqual(two.body.defectReasons,[{code:'D-1',name:'测试不良'}]);
}finally{await f.close();}});

test('身份决定服务端不良数校验，质检必须选原因并提交合格加不良',async()=>{const f=await fixture();try{
 await f.set('quality');const a=await f.start(0,12),b=await f.start(1,11);
 assert.equal((await f.call('/v1/assignments/'+a.body.assignment.id+'/finish',{method:'POST',key:'normal-forge-defects',body:{quantity:70,defectQuantity:2,defectCodes:['D-1'],isQualityInspection:true}})).status,422);
 const path='/v1/assignments/'+b.body.assignment.id+'/finish';assert.equal((await f.call(path,{person:1,method:'POST',key:'quality-no-reason',body:{quantity:70,defectQuantity:2}})).status,422);
 const done=await f.call(path,{person:1,method:'POST',key:'quality-valid-reason',body:{quantity:70,defectQuantity:2,defectCodes:['D-1']}});assert.equal(done.status,201);assert.equal(f.writes.length,1);assert.equal(f.writes[0].amount,72);assert.equal(f.writes[0].defectAmount,2);assert.equal(done.body.assignment.goodQuantity,70);
}finally{await f.close();}});

test('报工身份独立于归属/自主权限/机台/部门，管理员版本和同源保护',async()=>{const f=await fixture();try{
 const before=f.store.entryProfile(302),permission=f.store.selfServicePermission(302);assert.equal((await f.set('quality',{admin:false})).status,401);assert.equal((await f.set('quality',{headers:{Origin:'https://evil.invalid'}})).status,403);assert.equal((await f.set('quality',{headers:{'sec-fetch-site':'cross-site'}})).status,403);assert.equal((await f.set('invalid')).status,422);
 const done=await f.set('quality');assert.equal(done.body.operator.qualityRole,'quality');assert.equal(done.body.operator.qualityRevision,1);assert.deepEqual(f.store.entryProfile(302),before);assert.deepEqual(f.store.selfServicePermission(302),permission);assert.equal(f.store.workerTypeProfile(302).workerType,'auto');
 assert.equal((await f.set('standard',{revision:0})).status,409);assert.equal((await f.set('quality')).status,200);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM operator_quality_events').get().n,1);
}finally{await f.close();}});

test('审计故障回滚身份；活动和结果未知任务阻止改身份',async()=>{const f=await fixture();try{
 f.store.db.exec("CREATE TRIGGER reject_quality_audit BEFORE INSERT ON operator_quality_events BEGIN SELECT RAISE(ABORT,'fixture audit'); END");assert.equal((await f.set('quality')).status,500);assert.equal(f.store.qualityProfile(302).qualityRole,'standard');f.store.db.exec('DROP TRIGGER reject_quality_audit');
 const task=await f.start(1,11);for(const status of ['READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW']){f.store.db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status,task.body.assignment.id);assert.equal((await f.set('quality')).status,409);}assert.equal(f.writes.length,0);
}finally{await f.close();}});

test('任务保留报工身份快照，后台核量与历史不随后来人员设置改写',async()=>{const f=await fixture();try{
 await f.set('quality');const started=await f.start(1,11),id=started.body.assignment.id;
 f.store.db.prepare("UPDATE assignments SET status='QUANTITY_PENDING',quantity_policy='PENDING_REVIEW',ended_at=started_at,duration_seconds=0 WHERE id=?").run(id);
 assert.equal((await f.set('standard')).status,200);const quantities=new QuantityResolution({store:f.store,blacklake:{},defectReasons:[]});assert.equal(quantities.detail(id).assignment.isQualityInspection,true);assert.equal(f.store.assignmentById(id).isQualityInspection,true);
 f.store.db.prepare("UPDATE assignments SET status='COMPLETED' WHERE id=?").run(id);assert.equal(f.store.assignmentById(id).isQualityInspection,true);
}finally{await f.close();}});

test('旧记录不批改：已报检测保留历史形态，旧未报任务按人员身份',async()=>{const f=await fixture();try{
 const started=await f.start(0,12),id=started.body.assignment.id;f.store.db.prepare('UPDATE assignments SET quality_inspection=NULL WHERE id=?').run(id);assert.equal(f.store.assignmentById(id).isQualityInspection,false);
 f.store.db.prepare("UPDATE assignments SET status='COMPLETED' WHERE id=?").run(id);assert.equal(f.store.assignmentById(id).isQualityInspection,true);
 const row=f.store.db.prepare('SELECT quality_inspection FROM assignments WHERE id=?').get(id);assert.equal(row.quality_inspection,null);
}finally{await f.close();}});

test('派工和自主开工统一按人员，质检余量扣合格加不良',async()=>{const f=await fixture();try{
 await f.set('quality');const pending=f.store.dispatchAssignment({id:'dispatch-quality',operatorId:f.operators[1].id,taskId:11,projectId:201,projectCode:'TEST',productName:'测试品',processName:'合缝',quantity:100,stationName:'A-03',publishedAt:'2026-11-04 08:00:00',flowCodeHash:'fixture'});assert.equal(pending.isQualityInspection,true);assert.equal(f.store.assignmentById('dispatch-quality').isQualityInspection,true);
 f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',started_at=published_at WHERE id=?").run(pending.id);f.tasks[0].reportedGoodAmount=70;f.tasks[0].reportedDefectAmount=2;
 const defaults=await f.call('/v1/assignments/'+pending.id+'/finish-default',{person:1});assert.equal(defaults.body.remainingQuantity,28);
}finally{await f.close();}});

test('旧待核量未存身份时，修改人员身份使旧核量版本失效',async()=>{const f=await fixture();try{
 const started=await f.start(1,11),id=started.body.assignment.id;
 f.store.db.prepare("UPDATE assignments SET quality_inspection=NULL,status='QUANTITY_PENDING',quantity_policy='PENDING_REVIEW',ended_at=started_at,duration_seconds=0 WHERE id=?").run(id);
 const path='/v1/admin/task-recovery/assignments/'+id;const before=await f.call(path,{admin:true});assert.equal(before.body.assignment.isQualityInspection,false);
 assert.equal((await f.set('quality')).status,200);const after=await f.call(path,{admin:true});assert.equal(after.body.assignment.isQualityInspection,true);assert.notEqual(before.body.assignment.version,after.body.assignment.version);
 const stale=await f.call(path+'/quantity',{admin:true,method:'POST',key:'old-identity-quantity',body:{expectedVersion:before.body.assignment.version,reason:'现场核量测试',quantity:70,defectQuantity:0,defectCodes:[]}});assert.equal(stale.status,409);assert.equal(f.writes.length,0);
}finally{await f.close();}});
