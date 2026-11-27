import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {createApp} from '../src/app.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {PeopleGroups,liReportGroupId} from '../src/people-groups.mjs';
import {nativeFixture} from './native-report-fixture.mjs';

async function fixture(){
 let now=Date.parse('2026-11-16T10:00:00Z');const config={sessionSecret:'manual-report-synthetic',sessionDays:1,adminApiKey:'synthetic',reportingModeAdminOperatorIds:[],floor8EmployeeIds:[],agent:{enabled:false},review:{enabled:false}},store=new Store(':memory:',config),drivers=new Map(),calls=[];
 const people=[{blacklakeOperatorId:101,name:'合成组长',groupNames:['一组']},{blacklakeOperatorId:102,name:'合成员工',groupNames:['一组']},{blacklakeOperatorId:103,name:'合成质检组长',groupNames:['质检']}],operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});store.setQualityProfile(103,'quality_leader',0,'TEST');
 const info={projectId:501,projectCode:'TEST-WO',productName:'合成品',projectStatus:'10',projectPriority:0,plannedAmount:100},task={taskId:1,projectId:501,projectCode:'TEST-WO',processName:'合成工序',processStatus:10,plannedAmount:100,reportedGoodAmount:0,reportedDefectAmount:0};
 const blacklake={supportsFullReportCorrection:true,listOperators:async()=>people,findTaskById:async()=>task,queryOutputPage:async()=>({records:[],total:0}),
  createOutput:async input=>{calls.push('create');if(blacklake.createBeforeError)throw blacklake.createBeforeError;const d=nativeFixture(),id=String(8000+drivers.size);Object.assign(d.remote,{id:Number(id),outputId:Number(id),projectId:input.task.projectId,projectProcessId:input.task.taskId,projectCode:input.task.projectCode,operatorId:input.operator.blacklakeOperatorId,operatorName:input.operator.name,outputAmount:input.amount,fineAmount:input.amount-input.defectAmount,defectsAmount:input.defectAmount,defects:input.defectItems,planStartTime:input.actualStartedAt,planEndTime:input.actualEndedAt,createdAt:input.outputTime,planRestTime:0,unplanShutdownTime:0,effectiveTime:3600,clockOnRecordId:null,approveStatus:input.approveStatus??0});drivers.set(id,d);if(blacklake.createAfterError)throw blacklake.createAfterError;return {id};},
  readOutputForCorrection:async(id,options)=>{calls.push('read');if(blacklake.readError)throw blacklake.readError;return drivers.get(String(id)).client.readOutputForCorrection(id,options);},
  prepareOutputCorrection:(remote,input)=>drivers.get(String(remote.id)).client.prepareOutputCorrection(remote,input),
  updateOutputConfirmed:async(remote,input)=>{calls.push('correct');if(blacklake.correctionBeforeError)throw blacklake.correctionBeforeError;return drivers.get(String(remote.id)).client.updateOutputConfirmed(remote,input);},
  deleteOutputConfirmed:async id=>{drivers.delete(String(id));calls.push('delete');}};
 const sync=new BlacklakeSync({store,blacklake,now:()=>now,historyDays:0});sync.indexOrder(info);sync.save('order',501,{info,tasks:[task]});sync.save('people','all',people);
 const tokens=operators.map(o=>store.createSession(o.id).token),server=createServer(createApp({config,store,blacklake,wechat:{},dataSync:sync,now:()=>now,defectReasons:Array.from({length:7},(_,i)=>({code:'D'+i,name:'合成不良'+i}))}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{person=0,admin=false,body,key='manual-test-unique-operation',method=body?'POST':'GET'}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':'synthetic'}:{Authorization:'Bearer '+tokens[person]}),'Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const base='/v1/workspace/process-reports/501/1',input={operatorId:102,goodQuantity:90,defectQuantity:2,defectItems:[{code:'D6',amount:2}],startedAt:'2026-11-16 09:00:00',endedAt:'2026-11-16 10:00:00',durationSeconds:3000,materialProcess:'合成用料'},create=(change={},options={})=>call(base+'/create',{...options,body:{...input,...change}}),writeJob=()=>sync.jobs.list().jobs.find(j=>j.kind==='manual-report-create');
 return {store,sync,call,base,input,create,writeJob,blacklake,drivers,calls,task,operators,setAt:value=>{now=value;},advance:()=>{now+=3600000;},close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('新建权限与阅读独立，组长和质检组长可建，普通员工只读，七项不良同源',async()=>{const f=await fixture();try{
 for(const person of [0,1,2]){const r=await f.call(f.base+'/create-context',{person});assert.equal(r.status,person===1?403:200,JSON.stringify(r.body));if(person!==1){assert.equal(r.body.defectReasons.length,7);assert.equal(r.body.people.length,3);}}
 assert.equal((await f.create({},{person:1})).status,403);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
 assert.equal((await f.call(f.base,{person:1})).body.canCreateReports,false);
}finally{await f.close();}});

test('新建原子保存且重复提交幂等，不改变进行中任务、队列、计时或派工记录',async()=>{const f=await fixture();try{
 const o=f.operators[1];f.store.dispatchAssignment({id:'active-original',operatorId:o.id,taskId:2,projectId:502,projectCode:'OTHER',productName:'原任务',processName:'原工序',quantity:10,stationName:'A-03',machineId:'',publishedByOperatorId:101,publishedBy:'合成组长',publishedAt:'2026-11-16 08:00:00',flowCodeHash:'TEST'},{allowQueue:true});f.store.startDispatchedAssignment('active-original',o.id,'2026-11-16 08:01:00');
 const before=JSON.stringify(f.store.assignmentById('active-original')),r=await f.create();assert.equal(r.status,202,JSON.stringify(r.body));assert.equal(r.body.queued,true);assert.equal((await f.create()).body.sync.id,r.body.sync.id);assert.equal((await f.create({goodQuantity:91})).status,409);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.store.assignmentById('active-original')),before);
 const job=f.writeJob(),a=f.store.assignmentById(job.target);assert.equal(a.assignmentMode,'MANUAL_REPORT');assert.equal(a.status,'COMPLETED');assert.equal(a.publishedByOperatorId,null);
 let records=await f.call(f.base,{person:1});assert.equal(records.body.reports[0].goodQuantity,90);assert.equal(records.body.reports[0].canEdit,false);
 await f.sync.tick();assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED',JSON.stringify(f.sync.jobs.get(job.id)));assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(f.store.reportById(job.report_id).status,'SUCCEEDED');assert.equal(f.drivers.get('8000').remote.effectiveTime,3000);assert.equal(f.drivers.get('8000').remote.customFieldValues.find(v=>v.fieldId===964471).value,'合成用料');assert.equal(JSON.stringify(f.store.assignmentById('active-original')),before);
 records=await f.call(f.base);assert.equal(records.body.reports[0].canEdit,true);assert.equal(records.body.reports[0].reportedSeconds,3000);
 await f.sync.tick();await f.sync.tick();
 const editor=await f.call(f.base+'/'+job.report_id+'/editor');assert.equal(editor.status,200,JSON.stringify(editor.body));assert.equal(editor.body.report.operatorId,102);
 const deleted=await f.call(f.base+'/'+job.report_id+'/delete',{key:'manual-delete-operation',body:{expectedVersion:editor.body.report.version}});assert.equal(deleted.body.queued,true);await f.sync.tick();assert.equal(f.store.reportById(job.report_id).status,'DELETED');
}finally{await f.close();}});

test('无效人员、不良数量、未来时间、工时和已关闭工序不能生成记录',async()=>{const f=await fixture();try{
 for(const input of [{operatorId:999},{goodQuantity:-1},{defectItems:[{code:'D6',amount:1}]},{defectItems:[{code:'UNKNOWN',amount:2}]},{endedAt:'2027-01-01 10:00:00'},{durationSeconds:4000},{startedAt:'2026-11-16 11:00:00'},{startedAt:f.input.endedAt,durationSeconds:0},{durationSeconds:0}])assert.equal((await f.create(input)).status,422,JSON.stringify(input));
 assert.equal(f.sync.jobs.list().jobs.filter(job=>job.mode==='write').length,0);
 f.sync.save('order',501,{info:{projectId:501,projectCode:'TEST-WO',projectStatus:10},tasks:[{...f.task,processStatus:20}]});assert.equal((await f.create()).status,409);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
}finally{await f.close();}});

test('目标小组代建报工先本地审批，以复核的数量及原工时和用料一次提交黑湖',async()=>{
 const f=await fixture();
 try{
  new PeopleGroups(f.store.db).save([{id:liReportGroupId,name:'合成一组',blacklakeOperatorIds:[102],leaderIds:[101]}],0,'test');
  const saved=await f.create();
  assert.equal(saved.status,202,JSON.stringify(saved.body));
  const {reportId}=saved.body;
  assert.equal(saved.body.pendingGroupApproval,true);
  assert.equal(f.store.reportById(reportId).status,'GROUP_APPROVAL_PENDING');
  assert.equal((await f.create()).body.reportId,reportId);
  assert.equal((await f.create({goodQuantity:91})).status,409);
  assert.equal(f.writeJob(),undefined);
  await f.sync.tick();
  assert.equal(f.calls.length,0);

  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  f.setAt(Date.now());
  const list=await f.call('/v1/workspace/reports?from='+day+'&to='+day+'&approval=pending');
  assert.equal(list.status,200,JSON.stringify(list.body));
  const pending=list.body.records.find(row=>row.id===reportId);
  assert.equal(pending.canApprove,true);
  const path=f.base+'/'+reportId;
  const approve=(revision,person=0)=>f.call(path+'/approval',{person,key:'manual-group-approval',body:{approved:true,expectedStatus:0,expectedApprovalRevision:revision}});
  assert.equal((await approve(pending.approvalRevision,1)).status,403);
  assert.equal((await approve(pending.approvalRevision,2)).status,403);
  const editor=(await f.call(path+'/editor')).body.report;
  assert.equal(editor.quantityOnly,true);
  assert.equal((await f.call(path+'/edit',{body:{expectedVersion:editor.version,goodQuantity:83,defectQuantity:1,defectItems:[{code:'D4',amount:1}]}})).status,200);
  assert.equal((await approve(pending.approvalRevision)).status,409);
  assert.equal(f.writeJob(),undefined);

  const approved=await approve(pending.approvalRevision+1);
  assert.equal(approved.status,202,JSON.stringify(approved.body));
  assert.equal((await approve(pending.approvalRevision+1)).body.sync.id,approved.body.sync.id);
  assert.equal((await f.create()).body.sync.id,approved.body.sync.id);
  for(let attempt=0;attempt<4&&f.writeJob().state==='QUEUED';attempt++)await f.sync.tick();
  const job=f.writeJob(),remote=f.drivers.get('8000').remote;
  assert.equal(job.state,'SUCCEEDED',JSON.stringify(job));
  assert.equal(f.calls.filter(call=>call==='create').length,1);
  assert.equal(f.store.reportById(reportId).blacklake_output_id,'8000');
  assert.deepEqual({person:remote.operatorId,good:remote.fineAmount,items:remote.defects,duration:remote.effectiveTime,
   start:remote.planStartTime,end:remote.planEndTime,approval:remote.approveStatus,material:remote.customFieldValues.find(field=>field.fieldId===964471).value},
  {person:102,good:83,items:[{code:'D4',amount:1}],duration:3000,start:f.input.startedAt,end:f.input.endedAt,approval:10,material:'合成用料'});
 }finally{await f.close();}
});

test('创建后遇到读取限流重试只补齐资料，不再次创建；补齐超时只读核对收敛',async()=>{const f=await fixture();try{
 await f.create();f.blacklake.readError=Object.assign(Error('deferral'),{code:'BLACKLAKE_REQUEST_DEFERRED',definiteFailure:true,retryAfterMs:1000});await f.sync.tick();let job=f.writeJob();assert.equal(job.state,'RETRY');assert.equal(f.store.reportById(job.report_id).blacklake_output_id,'8000');delete f.blacklake.readError;
 f.advance();f.blacklake.updateOutputConfirmed=async(remote,input)=>{const d=f.drivers.get(String(remote.id));d.setMode('after-write');return d.client.updateOutputConfirmed(remote,input);};await f.sync.tick();job=f.writeJob();assert.equal(job.state,'UNKNOWN');assert.equal(f.calls.filter(x=>x==='create').length,1);f.advance();await f.sync.tick();assert.equal(f.calls.filter(x=>x==='create').length,1);
 const reconciled=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version}});assert.equal(reconciled.body.status,'SUCCEEDED',JSON.stringify(reconciled.body));assert.equal(f.store.reportById(job.report_id).status,'SUCCEEDED');
}finally{await f.close();}});

test('手工新建首次缺可信回执，回查后先保存编号，再补工时和用料',async()=>{const f=await fixture();try{
 const calls=[];let raw;
 const live=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'TEST',timeoutMs:1000,outputAddPath:'/add',outputQueryPath:'/query'},async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push(path);
  if(path==='/add'){
   const d=nativeFixture();Object.assign(d.remote,{id:8000,outputId:8000,...body,defects:body.defectList,planRestTime:0,unplanShutdownTime:0,effectiveTime:3600,clockOnRecordId:null});f.drivers.set('8000',d);
   raw={id:8000,...body,createdAt:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ')};
   return new Response('',{status:200});
  }
  return Response.json({code:'01000000',data:[raw],page:{total:1}});
 });
 live.limitWriteRate=async()=>{};f.blacklake.createOutput=live.createOutput.bind(live);
 const read=f.blacklake.readOutputForCorrection;
 f.blacklake.readOutputForCorrection=(id,options)=>{assert.equal(f.store.reportById(f.writeJob().report_id).blacklake_output_id,'8000');return read(id,options);};
 assert.equal((await f.create()).status,202);await f.sync.tick();
 const job=f.writeJob();assert.equal(job.state,'SUCCEEDED',JSON.stringify(job));
 assert.deepEqual(calls,['/add','/query','/query']);
 assert.equal(f.drivers.get('8000').remote.effectiveTime,3000);
 assert.equal(f.drivers.get('8000').remote.customFieldValues.find(v=>v.fieldId===964471).value,'合成用料');
}finally{await f.close();}});

test('创建丢回执不得重发，后台匹配编号后继续补齐完整字段，不能取消已创建记录',async()=>{const f=await fixture();try{
 f.blacklake.createAfterError=Object.assign(Error('timeout'),{code:'BLACKLAKE_TIMEOUT'});await f.create();await f.sync.tick();let job=f.writeJob();assert.equal(job.state,'UNKNOWN');assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/retry',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version}})).status,409);
 f.drivers.get('8000').remote.operatorId=999;assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version,outputId:'8000'}})).status,409);f.drivers.get('8000').remote.operatorId=102;
 const linked=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version,outputId:'8000'}});assert.equal(linked.body.status,'QUEUED',JSON.stringify(linked.body));job=f.writeJob();assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/cancel',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version}})).status,409);assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/confirm-absent',{admin:true,body:{expectedVersion:f.sync.publicJob(job).version,confirmedAbsent:true}})).status,409);
 delete f.blacklake.createAfterError;await f.sync.tick();assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED');assert.equal(f.calls.filter(x=>x==='create').length,1);
}finally{await f.close();}});

test('队列落库失败回滚全部新建报工，不留下已完成的伪任务',async()=>{const f=await fixture();try{const enqueue=f.sync.jobs.enqueue.bind(f.sync.jobs);f.sync.jobs.enqueue=input=>{if(input.mode==='write')throw Error('synthetic queue failure');return enqueue(input);};assert.equal((await f.create()).status,500);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);assert.equal(f.calls.length,0);}finally{await f.close();}});

test('本系统成员固定实际归属与代报人，新建完成后员工个人记录可见',async()=>{const f=await fixture();try{
 const member=await f.store.members.save({name:'合成本地员工',submitAsId:102,groupNames:['一组'],operationId:'create-local-manual-member'},{actor:'TEST',upstream:f.blacklake});
 const r=await f.create({operatorId:member.personId});assert.equal(r.status,202,JSON.stringify(r.body));const job=f.writeJob();assert.equal(f.store.members.snapshot(job.report_id).submitAsId,102);assert.equal(f.store.members.snapshot(job.report_id).actualOperatorId,member.id);
 await f.sync.tick();assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED',JSON.stringify(f.sync.jobs.get(job.id)));assert.equal(f.drivers.get('8000').remote.operatorId,102);assert.equal(f.store.reportById(job.report_id).operator_id,member.id);assert.equal((await f.call(f.base)).body.reports[0].productionWorkerName,'合成本地员工');
}finally{await f.close();}});

test('补齐阶段服务中断保留创建编号并转待核对；不能因重启再次新建',async()=>{const f=await fixture();try{
 await f.create();f.blacklake.readError=Object.assign(Error('defer'),{code:'BLACKLAKE_REQUEST_DEFERRED',definiteFailure:true,retryAfterMs:1000});await f.sync.tick();let job=f.writeJob();assert.equal(job.state,'RETRY');assert.equal(f.store.reportById(job.report_id).blacklake_output_id,'8000');
 f.store.db.prepare("UPDATE integration_jobs SET state='RUNNING',phase='SENDING',lease_until=0 WHERE id=?").run(job.id);f.advance();delete f.blacklake.readError;await f.sync.tick();job=f.writeJob();assert.equal(job.state,'UNKNOWN');assert.equal(f.store.reportById(job.report_id).status,'UNKNOWN');assert.equal(f.calls.filter(x=>x==='create').length,1);
}finally{await f.close();}});
