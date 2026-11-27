import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {IntegrationJobs,assertSyncCanDisable} from '../src/integration-jobs.mjs';
import {ReportOutbox} from '../src/report-outbox.mjs';
import {createApp} from '../src/app.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {PeopleGroups,liReportGroupId} from '../src/people-groups.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function fixture({allowNext=true,workerId=102}={}){
 let at=Date.parse('2026-11-13T00:00:00Z');const config={sessionSecret:'synthetic-sync-test',sessionDays:1,adminApiKey:'synthetic-admin',reportingModeAdminOperatorIds:[],floor8EmployeeIds:[],agent:{enabled:false},review:{enabled:false},dataSync:{allowNext}},store=new Store(':memory:',config),calls=[],outputs=new Map();
 const people=[{blacklakeOperatorId:101,name:'同步测试组长',groupNames:['测试']},{blacklakeOperatorId:workerId,name:'同步测试员工',groupNames:['测试']}],operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});
 const info=id=>({projectId:id,projectCode:'2026-SYNC-'+id,productCode:'SKU-'+id,productName:'合成产品',projectStatus:'10',projectPriority:0,plannedAmount:100,actualAmount:0,productImageUrls:[],unit:'件'}),tasks=id=>[{taskId:id*10+1,projectId:id,projectCode:'2026-SYNC-'+id,processName:'合成工序',processStatus:10,processPriority:0,plannedAmount:100,reportedGoodAmount:0,reportedDefectAmount:0}];
 const blacklake={supportsFullReportCorrection:true,listOperators:async()=>{calls.push(['people']);return people;},queryWorkOrderCatalogPage:async p=>{calls.push(['catalog',p]);return {records:[info(201),info(202)],hasMore:false};},listWorkOrderCatalog:async()=>[info(201),info(202)],listWorkOrderProcesses:async code=>{const id=Number(code.slice(10));calls.push(['tasks',id]);return tasks(id);},readWorkOrderDetails:async id=>{calls.push(['details',id]);return info(id);},findTaskById:async id=>{calls.push(['check',id]);return tasks(Math.floor(id/10))[0];},queryOutputPage:async()=>({records:[],total:0}),
  createOutput:async input=>{calls.push(['write',input.task.projectId]);if(blacklake.writeError)throw blacklake.writeError;const id=String(12000+outputs.size);outputs.set(id,{id,projectId:input.task.projectId,projectProcessId:input.task.taskId,operatorId:input.operator.blacklakeOperatorId,fineAmount:input.amount-input.defectAmount,defectsAmount:input.defectAmount,defectCodes:input.defectCodes,defectItems:[],startedAt:input.actualStartedAt,endedAt:input.actualEndedAt,approveStatus:input.approveStatus});return {id};},
  readOutputForCorrection:async id=>{calls.push(['output',String(id)]);assert(outputs.has(String(id)));return structuredClone(outputs.get(String(id)));},updateOutputConfirmed:async(remote,input)=>{calls.push(['edit',remote.projectId]);outputs.set(String(remote.id),{...remote,fineAmount:input.goodAmount,defectsAmount:input.defectAmount,defectCodes:input.defectCodes});},deleteOutputConfirmed:async id=>{calls.push(['delete',String(id)]);outputs.delete(String(id));}};
 const sync=new BlacklakeSync({store,blacklake,now:()=>at,historyDays:0});for(const id of [201,202]){sync.indexOrder(info(id));sync.save('order',id,{info:info(id),tasks:tasks(id)});}sync.save('people','all',people);for(const year of [2026,2025])sync.save('catalog',year,{pageNum:1});sync.save('history-day','2026-11-13',{pageNum:1});
 const tokens=operators.map(o=>store.createSession(o.id).token),server=createServer(createApp({config,store,blacklake,wechat:{},dataSync:sync,now:()=>at}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{worker=false,admin=false,method='GET',body,key,headers={}}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[worker?1:0]}),'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 let n=0;const action=async(action,input,worker=false)=>{const snapshot=await call('/v1/workspace/'+(worker?'worker':'tasks'),{worker});return call('/v1/workspace/actions',{worker,method:'POST',key:'sync-test-action-'+(++n),body:{action,input,meta:{expectedVersion:snapshot.body.version}}});};
 const dispatch=async(orderId=201)=>{const r=await action('dispatch',{orderId,processId:orderId*10+1,workerIds:['102'],placements:[{workerId:'102',unitId:'A-03'}],priority:'NORMAL'});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.assignmentIds[0];};
 const finish=async()=>{const id=await dispatch();assert.equal((await action('start',{assignmentId:id},true)).status,200);at+=10000;assert.equal((await action('end',{assignmentId:id},true)).status,200);const result=await call('/v1/assignments/'+id+'/finish',{worker:true,method:'POST',key:'sync-test-finish-'+id,body:{quantity:80,defectQuantity:0}});assert.equal(result.status,202,JSON.stringify(result.body));return {id,result};};
 return {store,sync,calls,outputs,blacklake,call,action,dispatch,finish,setAt:v=>{at=v;},advance:v=>{at+=v;},close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('绣花员工在共用工作台选择外协工序并管理多台机，沿用实际报工和机台权限',async()=>{
 const f=await fixture();
 try{
  f.store.setWorkerType(102,'embroidery',0,'test');
  f.store.setSelfServicePermission(102,true,0,'test');
  const {info,tasks}=f.sync.snapshot('order',201).data;
  const stitch={...tasks[0],productName:info.productName,processName:'外协加工KL',reportedGoodAmount:20};
  f.sync.save('order',201,{info,tasks:[stitch,{...tasks[0],taskId:2012}]});
  f.blacklake.findWorkOrderProcess=async(code,id)=>{assert.equal(code,'projectId=201');return {...stitch,taskId:Number(id)};};
  f.blacklake.findTaskById=async()=>stitch;
  const appWorker='/v1/workspace/worker?mode=embroidery';
  const view=async()=> (await f.call(appWorker,{worker:true})).body;
  assert.equal((await f.call(appWorker)).status,403);
  assert.equal((await f.call('/v1/workspace/worker',{worker:true})).status,403);
  const selected=await f.call('/v1/workspace/self/201?mode=embroidery',{worker:true});
  assert.equal(selected.status,200,JSON.stringify(selected.body));
  assert.deepEqual(selected.body.processes.map(row=>row.id),[2011]);
  assert.equal((await f.call('/v1/orders?status=OPEN',{worker:true})).status,200);
  assert.equal((await f.call('/v1/workspace/scan?mode=embroidery',{worker:true,method:'POST',body:{flowCode:'projectId=201'}})).status,200);
  const machine=await f.call('/v1/flow/embroidery-machine',{worker:true,method:'POST',body:{flowCode:'projectId=201',taskId:2011,machineCode:'机台01'}});
  assert.deepEqual(machine.body.parts,['前幅','后幅']);
  const start=(id,part,key)=>f.call('/v1/flow/start',{worker:true,method:'POST',key,body:{flowCode:'projectId=201',taskId:2011,machineId:id,embroideryPart:part,selfService:'embroidery',reportingMode:'embroidery'}});
  const first=await start('01','前幅','machine-start-first');
  assert.equal(first.status,201,JSON.stringify(first.body));
  const a=first.body.assignment.id;
  assert.equal(f.store.activeAssignmentByMachine('3F-01').id,a);
  assert.equal(f.store.activeAssignmentsByUnit('3F-01')[0].id,a);
  const supervisorTask={id:'synthetic-machine-queue',operatorId:f.store.findOperatorByBlacklakeId(101).id,
    ...stitch,machineId:'3F-03',embroideryPart:'前幅',quantity:100,flowCodeHash:'synthetic-machine-flow',publishedBy:'合成主管',publishedByOperatorId:101,publishedAt:first.body.assignment.publishedAt};
  assert.equal(f.store.dispatchAssignments([{...supervisorTask,machineId:'3F-01'}]),undefined);
  assert.equal(f.store.dispatchAssignments([supervisorTask])[0].id,supervisorTask.id);
  assert.equal((await start('03','前幅','machine-start-alias')).body.error.code,'EMBROIDERY_MACHINE_IN_USE');
  assert.equal((await start('01','前幅','machine-start-first')).body.assignment.id,a);
  assert.equal((await start('02','前幅','machine-start-first')).body.error.code,'START_KEY_REUSED');
  assert.equal((await start('01','后幅','machine-start-conflict')).body.error.code,'EMBROIDERY_MACHINE_IN_USE');
  const second=await start('02','后幅','machine-start-second');
  assert.equal(second.status,201,JSON.stringify(second.body));
  assert.deepEqual((await view()).assignments.map(row=>row.machineId).sort(),['01','02']);
  const clock=(action,revision,key)=>f.call('/v1/assignments/'+a+'/'+action,{worker:true,method:'POST',key,body:{expectedRevision:revision}});
  const begin=Date.parse(first.body.assignment.startedAt.replace(' ','T')+'+08:00');
  f.setAt(begin+60000);
  const ended=await clock('end',0,'machine-timer-end-one');
  assert.equal(ended.status,200,JSON.stringify(ended.body));
  assert.equal((await view()).assignments.find(row=>row.id===a).status,'AWAITING_QUANTITY');
  assert.equal((await f.call('/v1/assignments/'+a+'/finish-default?mode=embroidery',{worker:true})).body.defaultQuantity,80);
  f.advance(10000);
  assert.equal((await clock('cancel-end',1,'machine-timer-cancel-end')).status,200);
  assert.equal(f.store.assignmentById(a).endedAt,null);
  assert.equal(f.store.assignmentPauses(a).length,1);
  f.advance(10000);
  assert.equal((await clock('end',2,'machine-timer-end-two')).status,200);
  const saved=await f.call('/v1/assignments/'+a+'/finish',{worker:true,method:'POST',key:'machine-quantity-save',body:{quantity:31}});
  assert.equal(saved.status,202,JSON.stringify(saved.body));
  for(let i=0;i<8&&f.store.assignmentById(a).status!=='COMPLETED';i++)await f.sync.tick();
  assert.equal(f.store.assignmentById(a).status,'COMPLETED');
  assert.equal(f.store.assignmentById(second.body.assignment.id).status,'IN_PROGRESS');
  assert.equal((await view()).assignments.find(row=>row.id===a).reports[0].goodQuantity,31);
  assert.equal(f.store.assignmentById(a).durationSeconds,70);
  assert.equal((await f.call('/v1/workspace/actions?mode=embroidery',{worker:true,method:'POST',body:{action:'dispatch'}})).status,403);
  const exit='/v1/assignments/'+second.body.assignment.id+'/exit-closed-machine';
  f.blacklake.listWorkOrderProcesses=async()=>[stitch];
  assert.equal((await f.call(exit,{worker:true,method:'POST',body:{}})).status,409);
  f.blacklake.listWorkOrderProcesses=async()=>[{...stitch,processStatus:20}];
  assert.equal((await f.call(exit,{worker:true,method:'POST',body:{}})).body.assignment.status,'CANCELLED');
 }finally{await f.close();}
});

test('绣花按人开工，后台绑定只记录位置，无绑定也能报工',async()=>{
 const f=await fixture();
 try{
  f.store.setWorkerType(102,'embroidery',0,'test');
  f.store.setSelfServicePermission(102,true,0,'test');
  f.store.setEntryProfile(102,{appRole:'employee',workUnitId:'3F-01'});
  const {info,tasks}=f.sync.snapshot('order',201).data;
  const stitch={...tasks[0],productName:info.productName,processName:'外协加工KL',reportedGoodAmount:20};
  f.sync.save('order',201,{info,tasks:[stitch]});
  f.blacklake.findWorkOrderProcess=async()=>stitch;
  f.blacklake.findTaskById=async()=>stitch;
  const start=(key,extra={})=>f.call('/v1/flow/start',{worker:true,method:'POST',key,body:{
    flowCode:'projectId=201',taskId:2011,embroideryPart:'后幅',selfService:'embroidery-bound',reportingMode:'embroidery',...extra}});
  const clock=(id,action,body,key)=>f.call('/v1/assignments/'+id+'/'+action,{worker:true,method:'POST',body,key});
  const [first,replay]=await Promise.all([start('bound-embroidery-first',{machineId:'12'}),start('bound-embroidery-first')]);
  assert.deepEqual([first.status,replay.status].sort(),[200,201],JSON.stringify([first.body,replay.body]));
  const id=first.body.assignment.id;
  assert.equal(replay.body.assignment.id,id);
  assert.equal(f.store.assignmentById(id).stationName,'3F-01');
  assert.equal(f.store.assignmentById(id).machineId,'');
  assert.equal(f.store.activeAssignmentsByUnit('3F-01')[0].id,id);
  assert.equal(f.store.activeAssignmentByMachine('3F-01'),undefined);
  assert.equal((await start('bound-embroidery-next')).body.error.code,'OPERATOR_ALREADY_WORKING');
  const view=()=>f.call('/v1/workspace/worker?mode=embroidery',{worker:true});
  assert.equal((await view()).body.assignments[0].id,id);
  f.advance(60000);
  assert.equal((await clock(id,'end',{expectedRevision:0},'bound-embroidery-end')).status,200);
  const endedView=(await view()).body.assignments.find(row=>row.id===id);
  assert.equal(endedView.status,'AWAITING_QUANTITY');
  assert.equal(endedView.canReturnToWork,true);
  f.advance(10000);
  const resumed=await clock(id,'cancel-end',{expectedRevision:endedView.timingRevision},'bound-embroidery-return');
  assert.equal(resumed.status,200,JSON.stringify(resumed.body));
  const resumedView=(await view()).body.assignments.find(row=>row.id===id);
  assert.equal(resumedView.status,'IN_PROGRESS');
  assert.equal(resumedView.canFinish,true);
  assert.equal(resumedView.elapsedSeconds,60);
  assert.equal(f.store.assignmentById(id).reportId,null);
  assert.equal(f.calls.filter(row=>row[0]==='write').length,0);
  f.advance(10000);
  assert.equal((await clock(id,'end',{expectedRevision:resumedView.timingRevision},'bound-embroidery-end-again')).status,200);
  assert.equal(f.store.assignmentById(id).durationSeconds,70);
  assert.equal((await f.call('/v1/assignments/'+id+'/finish-default?mode=embroidery',{worker:true})).body.defaultQuantity,80);
  assert.equal((await clock(id,'finish',{quantity:17},'bound-embroidery-finish')).status,202);
  for(let i=0;i<8&&f.store.assignmentById(id).status!=='COMPLETED';i++)await f.sync.tick();
  assert.equal(f.store.assignmentById(id).status,'COMPLETED');
  f.store.setEntryProfile(102,{appRole:'employee',workUnitId:''});
  const unbound=await start('unbound-embroidery-next');
  assert.equal(unbound.status,201,JSON.stringify(unbound.body));
  assert.equal(f.store.assignmentById(unbound.body.assignment.id).stationName,'');
  f.advance(60000);
  assert.equal((await clock(unbound.body.assignment.id,'end',{expectedRevision:0},'unbound-embroidery-end')).status,200);
  assert.equal((await clock(unbound.body.assignment.id,'finish',{quantity:5},'unbound-embroidery-finish')).status,202);
  const reportPath='/v1/workspace/process-reports/201/2011';
  for(const worker of [false,true]){
   const details=await f.call(reportPath,{worker});
   assert.equal(details.status,200);
   assert.equal(details.body.canEditReports,!worker);
   assert(details.body.reports.some(row=>row.productionWorkerName==='同步测试员工'&&row.goodQuantity===17));
  }
 }finally{await f.close();}
});

test('新增报工同步后按工单合并刷新，列表读回黑湖累计良品和剩余数',async()=>{
 const f=await fixture(),date='2026-11-13';
 try{
  const {tasks}=f.sync.snapshot('order',201).data;
  const output=(id,good)=>({reportingId:id,projectId:201,taskId:2011,projectCode:'2026-SYNC-201',numberofgoodProducts:good,createdAt:date+' 08:00:00'});
  f.blacklake.queryOutputPage=async()=>({records:[output(7901,50),output(7902,29)],total:2});
  f.blacklake.listWorkOrderProcesses=async()=>{f.calls.push(['tasks',201]);return [{...tasks[0],reportedGoodAmount:79}];};
  f.sync.request('history-day',date,{date,pageNum:1});
  await f.sync.tick();
  assert.equal(f.sync.orderReports(201,'2026-SYNC-201').records.length,2);
  const queued=f.sync.jobs.byKey('read:order:201');
  assert.equal(queued.state,'QUEUED');
  assert.equal(f.sync.jobs.byKey('read:order:202'),null);
  f.sync.pruneObsoleteReads();
  assert.equal(f.sync.jobs.get(queued.id).state,'QUEUED');
  for(let i=0;i<6&&f.sync.jobs.get(queued.id).state!=='SUCCEEDED';i++)await f.sync.tick();
  assert.equal(f.sync.jobs.get(queued.id).state,'SUCCEEDED');
  const result=(await f.call('/v1/orders?watch=201')).body.watchedOrders[0].processes[0];
  assert.equal(result.goodQuantity,79);
  assert.equal(result.remainingQuantity,21);
  f.sync.request('history-day',date,{date,pageNum:1});
  for(let i=0;i<4;i++)await f.sync.tick();
  assert.equal(f.sync.jobs.get(queued.id).generation,queued.generation);
  assert.equal(f.calls.filter(row=>row[0]==='tasks').length,1);
 }finally{await f.close();}
});

test('报工同步在两段工单读取之间到达时，重新读取累计数量',async()=>{
 const f=await fixture(),date='2026-11-13';
 try{
  const {tasks}=f.sync.snapshot('order',201).data;
  let good=0;
  f.blacklake.listWorkOrderProcesses=async()=>[{...tasks[0],reportedGoodAmount:good}];
  f.blacklake.queryOutputPage=async()=>({records:[{reportingId:7901,projectId:201,taskId:2011,numberofgoodProducts:79,createdAt:date+' 08:00:00'}],total:1});
  f.sync.request('order',201,{projectId:201,reason:'audit'});
  f.sync.request('history-day',date,{date,pageNum:1});
  await f.sync.tick();
  assert.equal(f.sync.snapshot('order',201).sync.complete,false);
  good=79;await f.sync.tick();
  const job=f.sync.jobs.byKey('read:order:201');
  assert.equal(job.generation,2);
  await f.sync.tick();await f.sync.tick();
  assert.equal(f.sync.order(201).processes[0].goodQuantity,79);
  assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED');
 }finally{await f.close();}
});

test('单工单报工扫描发现新增时共享缓存刷新，模糊搜索的别单不加入队列',async()=>{
 const f=await fixture();
 try{
  f.blacklake.queryOutputPage=async()=>({records:[
   {reportingId:7901,projectId:201,taskId:2011,numberofgoodProducts:79},
   {reportingId:7902,projectId:202,taskId:2021,numberofgoodProducts:8}
  ],total:2});
  f.sync.request('order-reports',201,{projectId:201,projectCode:'2026-SYNC-201',pageNum:1});
  await f.sync.tick();
  assert.equal(f.sync.jobs.byKey('read:order:201').payload.reportProgress,true);
  assert.equal(f.sync.jobs.byKey('read:order:202'),null);
 }finally{await f.close();}
});

test('上海时间 03:10 安排缺失工序、过期工序、月度补齐和旧报工回查',async()=>{
 const f=await fixture();
 try{
  const before=Date.parse('2026-11-24T03:09:59+08:00');
  f.setAt(before);
  f.store.db.prepare("DELETE FROM blacklake_sync_snapshots WHERE kind='order' AND target='201'").run();
  f.store.db.prepare("INSERT INTO blacklake_output_index(output_id,project_id,task_id,output_time,created_at,raw_json,updated_at) VALUES('11',202,2021,'2026-11-23 08:00:00','2026-11-23 08:00:00','{}',?)").run(before);
  f.sync.save('history-day','2026-11-02',{watermark:'2026-11-02 23:59:59'});
  f.sync.scheduleNightly();
  assert.equal(f.sync.jobs.byKey('read:order:201'),null);
  f.advance(1000);f.sync.scheduleNightly();
  for(const id of [201,202])assert.equal(f.sync.jobs.byKey('read:order:'+id).payload.reason,'nightly');
  assert.equal(f.sync.jobs.byKey('read:history-day:2026-11-01').payload.to,'2026-11-01 23:59:59');
  assert.equal(f.sync.jobs.byKey('read:history-day:2026-11-02'),null);
  assert.equal(f.sync.jobs.byKey('read:history-day:2026-11-23').payload.to,'2026-11-23 23:59:59');
  assert.equal(f.sync.jobs.byKey('read:order-reports:202').payload.projectCode,'2026-SYNC-202');
  const unchanged=f.sync.jobs.byKey('read:order:201').generation;
  f.sync.scheduleNightly();
  assert.equal(f.sync.jobs.byKey('read:order:201').generation,unchanged);
  f.sync.request('catalog','all-head',{pageNum:1});
  assert.equal(f.sync.jobs.claim({lane:'background'}).kind,'catalog');
 }finally{await f.close();}
});

test('目录增量为新执行中工单排工序，重叠窗口去重并可按已加载工单批量回读缓存',async()=>{
 const f=await fixture();
 try{
  const indexed=f.sync.snapshot('order',201).data.info;
  f.blacklake.queryWorkOrderCatalogPage=async()=>({records:[{...indexed,projectId:203,projectCode:'2026-SYNC-203'},{...indexed,projectId:204,projectCode:'2026-SYNC-204',projectStatus:'20'}],total:2,hasMore:false});
  const payload={pageNum:1,updatedFrom:'2026-11-13 07:49:00',updatedTo:'2026-11-13 07:59:00'};
  f.sync.request('catalog','all-head',payload);await f.sync.tick();
  const first=f.sync.jobs.byKey('read:order:203');
  assert.equal(first.payload.reason,'catalog-delta');
  assert.equal(f.sync.jobs.byKey('read:order:204'),null);
  f.sync.pruneObsoleteReads();
  assert.equal(f.sync.jobs.get(first.id).state,'QUEUED');
  const response=await f.call('/v1/orders?watch=201,203');
  assert.equal(response.status,200);
  assert.deepEqual(response.body.watchedOrders.map(row=>[row.id,row.processesLoaded,row.sync.pending]),[[201,true,false],[203,false,true]]);
  assert.equal((await f.call('/v1/orders?watch=201,nope')).status,422);
  assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('共享快照显示队首派工已关闭时，跳过前仍检查黑湖当前状态',async()=>{
 const f=await fixture();
 try{
  const first=await f.dispatch(),next=await f.dispatch(202);
  const {info,tasks}=f.sync.snapshot('order',201).data;
  const closed=tasks.map(task=>({...task,processStatus:20}));
  f.sync.save('order',201,{info,tasks:closed});
  const before=(await f.call('/v1/workspace/worker',{worker:true})).body;
  assert.equal(before.assignments.find(row=>row.id===first).canSkipClosedAssignment,true);
  assert.equal((await f.action('skipClosedAssignment',{assignmentId:first},true)).status,409);
  assert.equal(f.store.assignmentById(first).status,'READY');
  f.blacklake.listWorkOrderProcesses=async()=>closed;
  assert.equal((await f.action('skipClosedAssignment',{assignmentId:first},true)).status,200);
  assert.equal(f.store.assignmentById(first).status,'CANCELLED');
  assert.equal((await f.action('start',{assignmentId:next},true)).status,200);
  assert.equal(f.outputs.size,0);
 }finally{await f.close();}
});

test('李组先审后报，待审和同步均不挡下一单，批准以已核对的数量版本为准',async()=>{
 const f=await fixture({allowNext:false});
 try{
  const groups=new PeopleGroups(f.store.db);
  groups.save([{id:liReportGroupId,name:'合成小组',blacklakeOperatorIds:[102],leaderIds:[101]}],0,'test');
  const first=await f.dispatch(),next=await f.dispatch(202);
  assert.equal((await f.action('start',{assignmentId:first},true)).status,200);
  f.advance(60000);
  assert.equal((await f.action('end',{assignmentId:first},true)).status,200);
  const beforeSave=(await f.call('/v1/workspace/worker',{worker:true})).body;
  const ready=beforeSave.assignments.find(row=>row.id===next);
  assert.equal(ready.canStart,false);
  assert.equal(ready.canStartAfterReport,true);
  const saved=await f.call('/v1/assignments/'+first+'/finish',{worker:true,method:'POST',key:'group-finish-'+first,body:{quantity:24}});
  assert.equal(saved.status,201,JSON.stringify(saved.body));assert.equal(saved.body.pendingGroupApproval,true);
  const reportId=saved.body.report.id, base='/v1/workspace/process-reports/201/2011/'+reportId;
  const readReport=async approval=>{
   const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
   f.setAt(Math.max(Date.now(),Date.parse('2026-11-13T00:01:01Z')));
   const result=await f.call('/v1/workspace/reports?from='+day+'&to='+day+'&approval='+approval);
   assert.equal(result.status,200,JSON.stringify(result.body));return result.body.records.find(row=>row.id===reportId);
  };
  assert.equal(f.sync.jobs.byKey('create:group-finish-'+first),null);
  assert.equal(f.outputs.size,0);
  const work=(await f.call('/v1/workspace/worker',{worker:true})).body;
  assert.equal(saved.body.version,work.version);
  assert.equal(work.assignments.find(task=>task.id===first).reports[0].sync.label,'待组长审批');
  assert.equal((await f.action('start',{assignmentId:next},true)).status,200);

  const pending=await readReport('pending');
  assert.equal(pending.goodQuantity,24);assert.equal(pending.canApprove,true);
  const approval=(revision,key,worker=false)=>f.call(base+'/approval',{method:'POST',key,worker,
   body:{approved:true,expectedStatus:0,expectedApprovalRevision:revision}});
  assert.equal((await approval(pending.approvalRevision,'approval-by-employee',true)).status,403);
  assert.equal((await f.call(base+'/editor',{worker:true})).status,403);
  groups.save([{id:liReportGroupId,name:'合成小组',blacklakeOperatorIds:[102],leaderIds:[]}],1,'test');
  assert.equal((await approval(pending.approvalRevision,'approval-by-unbound-leader')).status,403);
  groups.save([{id:liReportGroupId,name:'合成小组',blacklakeOperatorIds:[],leaderIds:[101]}],2,'test');
  const editor=(await f.call(base+'/editor')).body.report;
  assert.equal(editor.quantityOnly,true);
  const edit=await f.call(base+'/edit',{method:'POST',key:'group-edit-quantity',body:{
   expectedVersion:editor.version,goodQuantity:19,defectQuantity:0,defectCodes:[],defectItems:[]
  }});
  assert.equal(edit.status,200,JSON.stringify(edit.body));
  assert.equal((await approval(pending.approvalRevision,'approval-stale-version')).status,409);
  assert.equal(f.sync.jobs.byKey('create:group-finish-'+first),null);
  const revised=await readReport('pending');
  assert.equal(revised.goodQuantity,19);
  const results=await Promise.all([
   approval(revised.approvalRevision,'group-approve-first'),
   approval(revised.approvalRevision,'group-approve-second')
  ]);
  const winningKey=results[0].status===202?'group-approve-first':'group-approve-second';
  assert.deepEqual(results.map(result=>result.status).sort(),[202,409]);
  assert.equal((await approval(revised.approvalRevision,winningKey)).body.replayed,true);
  assert.equal((await readReport('approved')).syncState,'QUEUED');
  assert.equal(f.outputs.size,0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE kind='report-create'").get().n,1);
  await f.sync.tick();
  assert.equal(f.outputs.size,1);
  const [remote]=f.outputs.values();
  assert.equal(remote.fineAmount,19);assert.equal(remote.approveStatus,10);
  assert.equal((await readReport('approved')).syncState,'SUCCEEDED');
  assert.equal(f.store.assignmentById(next).status,'IN_PROGRESS');
 }finally{await f.close();}
});

test('先审后报的黑湖写入结果不明时，原任务保持结束且后台不重发',async()=>{
 const f=await fixture({allowNext:false});
 try{
  new PeopleGroups(f.store.db).save([{id:liReportGroupId,name:'合成小组',blacklakeOperatorIds:[102],leaderIds:[101]}],0,'test');
  const first=await f.dispatch(),next=await f.dispatch(202);
  assert.equal((await f.action('start',{assignmentId:first},true)).status,200);
  f.advance(60000);
  assert.equal((await f.action('end',{assignmentId:first},true)).status,200);
  const saved=await f.call('/v1/assignments/'+first+'/finish',{worker:true,method:'POST',key:'group-unknown-'+first,body:{quantity:12}});
  assert.equal(saved.status,201,JSON.stringify(saved.body));
  const reportId=saved.body.report.id;
  const approval=await f.call('/v1/workspace/process-reports/201/2011/'+reportId+'/approval',{
   method:'POST',key:'group-approve-unknown',body:{approved:true,expectedStatus:0,expectedApprovalRevision:0}
  });
  assert.equal(approval.status,202,JSON.stringify(approval.body));
  f.blacklake.writeError=Object.assign(Error('Synthetic response lost'),{code:'BLACKLAKE_TIMEOUT',writeOutcomeUnknown:true});
  await f.sync.tick();
  assert.equal(f.store.reportById(reportId).status,'UNKNOWN');
  assert.equal(f.store.assignmentById(first).status,'COMPLETED');
  assert.equal((await f.action('start',{assignmentId:next},true)).status,200);
  f.advance(120000);
  for(let i=0;i<4;i++)await f.sync.tick();
  assert.equal(f.calls.filter(call=>call[0]==='write').length,1);
  assert.equal(f.sync.jobs.get(approval.body.sync.id).state,'UNKNOWN');
 }finally{await f.close();}
});

test('60人读取已有42件即时返回，不触发黑湖；版本不变返回轻量状态，权限变化仍返回完整新版本',async t=>{const f=await fixture();try{
 f.sync.save('order-reports',201,{ids:[]});const raw={reportingId:461742918,projectId:201,taskId:2011,productionStaffId:102,productionStaff:'合成员工',numberofgoodProducts:42,numberofDefectives:0,createdAt:'2026-11-14 14:43:39'};
 f.store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,raw_json,updated_at) VALUES(?,?,?,?,?)').run('461742918',201,2011,JSON.stringify(raw),Date.now());f.advance(600000);
 const times=[];await Promise.all(Array.from({length:60},async()=>{const at=performance.now(),r=await f.call('/v1/workspace/process-reports/201/2011',{worker:true});times.push(performance.now()-at);assert.equal(r.status,200);assert.equal(r.body.reports[0].goodQuantity,42);}));assert.equal(f.calls.length,0);assert.equal(f.sync.jobs.byKey('read:order:201'),null);assert.equal(f.sync.jobs.byKey('read:order-reports:201'),null);
 const first=await f.call('/v1/workspace/process-reports/201/2011'),same=await f.call('/v1/workspace/process-reports/201/2011?version='+first.body.version);assert.equal(same.body.notModified,true);assert.equal(same.body.reports,undefined);f.store.setEntryProfile(101,{appRole:'employee'});const changed=await f.call('/v1/workspace/process-reports/201/2011?version='+first.body.version);assert.equal(changed.body.notModified,undefined);assert.equal(changed.body.canEditReports,false);assert(changed.body.reports);
 times.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scenario:'60 concurrent local-only process report requests',samples:times.length,p95Ms:Math.round(times[Math.ceil(times.length*.95)-1]*100)/100,upstreamRequests:f.calls.length,fieldDevices:false}));
}finally{await f.close();}});

test('工序记录包含黑湖历史与其他入口，员工和组长同样可读，未同步不能冒充零条',async()=>{const f=await fixture();try{
 const raw={reportingId:45678,projectId:201,taskId:2011,productionStaffId:999,productionStaffName:'历史生产员工',numberofgoodProducts:100,numberofDefectives:0,effectiveTime:3600,createdAt:'2025-01-01 09:00:00'};
 f.store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,created_at,raw_json,updated_at) VALUES(?,?,?,?,?,?)').run('45678',201,2011,raw.createdAt,JSON.stringify(raw),Date.now());
 for(const worker of [true,false]){const r=await f.call('/v1/workspace/process-reports/201/2011',{worker});assert.equal(r.status,200);assert.equal(r.body.reports.length,1);assert.equal(r.body.reports[0].productionWorkerName,'历史生产员工');assert.equal(r.body.reports[0].reportedSeconds,3600);assert.equal(r.body.reports[0].canEdit,!worker);assert.equal(r.body.reports[0].canDelete,!worker);assert.equal(r.body.complete,false);}
 assert.equal(f.calls.length,0);assert(f.sync.jobs.byKey('read:order-reports:201'));
}finally{await f.close();}});

test('列表、详情、工序和网站共享SQLite快照，多人打开不会请求黑湖',async()=>{const f=await fixture();try{
 for(let n=0;n<5;n++){assert.equal((await f.call('/v1/orders')).status,200);assert.equal((await f.call('/v1/orders/201')).body.order.id,201);assert.equal((await f.call('/v1/orders/201/processes')).body.processes.length,1);}
 assert.equal(f.calls.length,0);f.advance(600000);const stale=await f.call('/v1/orders/201');assert.equal(stale.body.sync.status,'stale');assert.equal(stale.body.order.processes.length,1);assert.equal(f.calls.length,0);assert.equal(f.sync.jobs.list().jobs.filter(j=>j.kind==='order'&&j.target==='201').length,0);
}finally{await f.close();}});

test('插单能从目录搜到从未派工的新单，只给所选工单加载工序',async()=>{const f=await fixture();try{
 f.sync.indexOrder({projectId:300,projectCode:'2026-SYNC-300',productCode:'TODAY-300',productName:'合成新单',projectStatus:'10'});
 const initial=await f.call('/v1/workspace/tasks?active=1');assert.deepEqual(initial.body.assignments,[]);
 const found=await f.call('/v1/orders?status=OPEN&projectCode=TODAY-300');assert.equal(found.status,200);assert.deepEqual(found.body.orders.map(row=>row.id),[300]);
 assert.equal(f.sync.jobs.byKey('read:order:300'),null);
 const waiting=await f.call('/v1/orders/300/processes');assert.equal(waiting.body.error.code,'BLACKLAKE_DATA_SYNCING');
 assert.equal((await f.call('/v1/workspace/context/300')).body.processesLoaded,false);
 const target=f.sync.jobs.byKey('read:order:300');assert(target);
 assert.equal(f.sync.jobs.list().jobs.filter(row=>row.kind==='order').length,1);
 await f.sync.tick();const ready=await f.call('/v1/orders/300/processes');
 assert.equal(ready.status,200);assert.equal(ready.body.processes[0].id,3001);
 assert.deepEqual(f.calls.filter(row=>['tasks','details'].includes(row[0])),[['tasks',300]]);
}finally{await f.close();}});

const orderOps='/v1/workspace/orders/201/operations';
const submitOrder=async (f,key,change={})=>{
 const snapshot=await f.call(orderOps);
 assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));
 const input={orderId:201,priority:'NONE',status:'IN_PROGRESS',syncPriority:false,...change};
 return f.call('/v1/workspace/actions',{method:'POST',key,body:{action:'updateOrder',input,meta:{expectedVersion:snapshot.body.version}}});
};
const advanceOrderToWrite=async f=>{
 await f.sync.tick(); // Yield the queued write until the exact order is checked.
 await f.sync.tick();await f.sync.tick();
 f.advance(1200);await f.sync.tick();
};

test('获授权员工的工单操作经后台发送和黑湖回读后更新',async()=>{const f=await fixture({workerId:3602917});try{
 f.store.setQualityProfile(3602917,'quality_leader',0,'test');
 let priority=0,writes=0;
 const details=f.blacklake.readWorkOrderDetails;
 f.blacklake.readWorkOrderDetails=async id=>({...await details(id),projectPriority:priority});
 f.blacklake.nativeRequest=async(path,input)=>{assert.equal(path,'/api/dytin/project/priority/update');priority=input.priority;writes++;};
 const snapshot=await f.call(orderOps,{worker:true});
 assert.equal(snapshot.status,200);
 const key='quality-order-background-test';
 const body={action:'updateOrder',input:{orderId:201,priority:'URGENT',status:'IN_PROGRESS',syncPriority:false},meta:{expectedVersion:snapshot.body.version}};
 const accepted=await f.call('/v1/workspace/actions',{worker:true,method:'POST',key,body});
 assert.equal(accepted.body.queued,true,JSON.stringify(accepted.body));
 assert.equal(writes,0);
 await advanceOrderToWrite(f);
 await f.sync.tick();await f.sync.tick();
 const done=await f.call(orderOps+'?operationId='+key,{worker:true});
 assert.equal(done.body.receipt?.status,'SUCCEEDED',JSON.stringify(done.body));
 assert.equal(done.body.order.priority,'URGENT');
 assert.equal(writes,1);
}finally{await f.close();}});

test('冷却时组长仍能提交和查询进度，只有后台定向读取和一次修改',async()=>{const f=await fixture();try{
 let priority=0,writes=0;
 const details=f.blacklake.readWorkOrderDetails;
 f.blacklake.readWorkOrderDetails=async id=>({...await details(id),projectPriority:priority});
 f.blacklake.nativeRequest=async(_path,input)=>{writes++;priority=input.priority;};
 const id='shared-order-queued-priority';
 f.sync.save('control','rate-limit',{until:Date.parse('2026-11-13T00:01:00Z')});
 const accepted=await submitOrder(f,id,{priority:'URGENT'});
 assert.equal(accepted.body.status,'PENDING',JSON.stringify(accepted.body));
 assert.equal(accepted.body.accepted,true);
 const path=orderOps+'?operationId='+id;
 for(let n=0;n<5;n++){const progress=await f.call(path);assert.equal(progress.body.receipt.checking,true);assert.equal(progress.body.sync.phase,'cooldown');}
 assert.equal(await f.sync.tick(),false);assert.equal(f.calls.length,0);assert.equal(writes,0);
 await f.dispatch();
 f.advance(61000);await advanceOrderToWrite(f);
 assert.equal(writes,1);assert.equal((await f.call(path)).body.receipt.status,'UNKNOWN');
 await f.sync.tick();await f.sync.tick();
 const done=await f.call(path);assert.equal(done.body.order.priority,'URGENT');assert.equal(done.body.receipt.status,'SUCCEEDED');
 assert.equal(done.body.canManage,true);assert.equal(writes,1);
 assert.deepEqual(f.calls,[['tasks',201],['details',201],['tasks',201],['details',201]]);
}finally{await f.close();}});

test('工单编辑避免覆盖外部改动，超时后若黑湖已写入只核对不重复执行',async()=>{const f=await fixture();try{
 let priority=0,writes=0;
 const details=f.blacklake.readWorkOrderDetails;
 f.blacklake.readWorkOrderDetails=async id=>({...await details(id),projectPriority:priority});
 f.blacklake.nativeRequest=async(_path,input)=>{writes++;priority=input.priority;throw Object.assign(Error('lost response'),{code:'BLACKLAKE_TIMEOUT'});};
 const stale='shared-order-external-change';
 assert.equal((await submitOrder(f,stale,{priority:'URGENT'})).body.status,'PENDING');
 priority=1;await advanceOrderToWrite(f);
 const rejected=await f.call(orderOps+'?operationId='+stale);
 assert.equal(rejected.body.receipt.status,'FAILED');assert.equal(rejected.body.canManage,true);
 assert.equal(rejected.body.order.priority,'EXPEDITED');assert.equal(writes,0);
 const lost='shared-order-response-lost';
 assert.equal((await submitOrder(f,lost,{priority:'URGENT'})).body.status,'PENDING');
 await advanceOrderToWrite(f);assert.equal(writes,1);
 assert.equal((await f.call(orderOps+'?operationId='+lost)).body.receipt.status,'UNKNOWN');
 await f.sync.tick();await f.sync.tick();
 assert.equal((await f.call(orderOps+'?operationId='+lost)).body.receipt.status,'SUCCEEDED');
 assert.equal(writes,1);
}finally{await f.close();}});

test('旧紧急标记和已结束工单的旧反转记录可定向自动核对，纯优先级不拦派工',async()=>{const f=await fixture();try{
 const before=(await f.call(orderOps)).body.order;
 const put=f.store.db.prepare('INSERT INTO workspace_order_operations(actor,operation_id,order_id,request_hash,status,before_json,target_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
 const row=id=>f.store.db.prepare('SELECT status,target_json,result_json FROM workspace_order_operations WHERE operation_id=?').get(id);
 const old='2026-11-13 07:55:00',actor='floor8_leader:101';
 put.run(actor,'old-urgent-201',201,'original','UNKNOWN',JSON.stringify(before),JSON.stringify({status:'IN_PROGRESS',priority:'URGENT',syncPriority:false}),old,old);
 await f.dispatch();
 assert.equal(row('old-urgent-201').status,'UNKNOWN');
 assert.equal((await f.call(orderOps)).body.pending.checking,true);
 await f.sync.tick();await f.sync.tick();
 assert.equal(row('old-urgent-201').status,'SUPERSEDED');
 assert.equal(JSON.parse(row('old-urgent-201').target_json).priority,'URGENT');
 const details=f.blacklake.readWorkOrderDetails;
 f.blacklake.readWorkOrderDetails=async id=>({...await details(id),projectStatus:'20'});
 put.run(actor,'old-reopen-201',201,'original','UNKNOWN',JSON.stringify({...before,status:'FINISHED'}),JSON.stringify({status:'IN_PROGRESS',priority:'NONE',syncPriority:false}),old,old);
 assert.equal((await f.call(orderOps)).body.pending.checking,true);
 assert.equal(f.store.orderStatusPending(201),true);
 await f.sync.tick();await f.sync.tick();
 assert.equal(row('old-reopen-201').status,'SUPERSEDED');
 assert.equal((await f.call(orderOps)).body.canManage,true);
 assert.equal((await f.call(orderOps)).body.order.status,'FINISHED');
 assert.deepEqual(f.calls,[['tasks',201],['details',201],['tasks',201],['details',201]]);
}finally{await f.close();}});

test('单工单刷新保留进行中的操作、未复原的工序优先级和未确认的工单状态变更',async()=>{const f=await fixture();try{
 const before=(await f.call('/v1/workspace/orders/201/operations')).body.order;
 const put=f.store.db.prepare('INSERT INTO workspace_order_operations(actor,operation_id,order_id,request_hash,status,before_json,target_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
 const read=f.store.db.prepare('SELECT status FROM workspace_order_operations WHERE operation_id=?');
 const tasks=f.blacklake.listWorkOrderProcesses,details=f.blacklake.readWorkOrderDetails;
 for(const scenario of [
  {receipt:'PENDING'},
  {receipt:'UNKNOWN',syncPriority:true,processPriority:2},
  {receipt:'UNKNOWN',targetStatus:'FINISHED'},
  {receipt:'UNKNOWN',priority:null}
 ]){
  const id='protected-order-operation';
  f.blacklake.listWorkOrderProcesses=async code=>(await tasks(code)).map(t=>({...t,processPriority:scenario.processPriority??0}));
  f.blacklake.readWorkOrderDetails=async id=>({...await details(id),projectPriority:scenario.priority===null?null:0});
  put.run('floor8_leader:101',id,201,'synthetic',scenario.receipt,JSON.stringify(before),
    JSON.stringify({status:scenario.targetStatus??'IN_PROGRESS',priority:'URGENT',syncPriority:!!scenario.syncPriority}),'2026-11-13 08:00:00','2026-11-13 08:00:00');
  const accepted=await f.call('/v1/orders/201/refresh',{method:'POST',body:{}});
  assert.equal(accepted.status,202);await f.sync.tick();await f.sync.tick();
  assert.equal(f.sync.orderRefreshState(201).completed,true);
  assert.equal(read.get(id).status,scenario.receipt);
  f.store.db.prepare('DELETE FROM workspace_order_operations WHERE operation_id=?').run(id);
 }
}finally{await f.close();}});

test('结束工单在读取新快照前始终拦住派工；核对完成后按已结束处理',async()=>{const f=await fixture();try{
 let status='10';
 const read=f.blacklake.readWorkOrderDetails;
 f.blacklake.readWorkOrderDetails=async id=>({...await read(id),projectStatus:status});
 f.blacklake.nativeRequest=async()=>{status='20';};
 const write=await submitOrder(f,'close-shared-order-confirmed',{status:'FINISHED'});
 assert.equal(write.body.status,'PENDING');await advanceOrderToWrite(f);
 assert.equal((await f.call('/v1/orders/201')).body.order.status,'IN_PROGRESS');
 const input={orderId:201,processId:2011,workerIds:['102'],placements:[{workerId:'102',unitId:'A-03'}],priority:'NORMAL'};
 let result=await f.action('dispatch',input);assert.equal(result.body.error.code,'WORKSPACE_ORDER_RESULT_UNKNOWN');
 await f.sync.tick();await f.sync.tick();
 assert.equal((await f.call('/v1/orders/201')).body.order.status,'FINISHED');
 result=await f.action('dispatch',input);
 assert.equal(result.status,409,JSON.stringify(result.body));
 assert.match(result.body.error.message,/工单或工序已关闭/);
}finally{await f.close();}});

test('黑湖正在冷却时人员分类、本地成员和选人工序推荐仍读共享快照',async()=>{const f=await fixture();try{
 let upstream=0;f.blacklake.listOperators=async()=>{upstream++;throw Error('synthetic global cooldown');};
 const groups=await f.call('/v1/admin/people-groups',{admin:true});assert.equal(groups.status,200,JSON.stringify(groups.body));assert(groups.body.leaders.some(p=>p.blacklakeOperatorId===101));
 const members=await f.call('/v1/admin/local-members',{admin:true});assert.equal(members.status,200,JSON.stringify(members.body));assert(members.body.submitters.some(p=>p.id===102));assert.equal(upstream,0);
 f.blacklake.listWorkOrderProcesses=async()=>{upstream++;throw Error('synthetic global cooldown');};const prediction=await f.call('/v1/dispatch/prediction',{method:'POST',body:{flowCode:'projectId=201',blacklakeOperatorIds:[102]}});assert.equal(prediction.status,200,JSON.stringify(prediction.body));assert.equal(upstream,0);
}finally{await f.close();}});

test('确认数量与出站队列同事务落库，立即释放员工，成功后只刷新关联工单',async()=>{const f=await fixture();try{
 const {id,result}=await f.finish();assert.equal(result.body.queued,true);assert.equal(f.store.assignmentById(id).status,'COMPLETED');assert.equal(f.store.reportById(f.store.assignmentById(id).reportId).status,'PENDING');assert.equal(f.outputs.size,0);
 const replay=await f.call('/v1/assignments/'+id+'/finish',{worker:true,method:'POST',key:'sync-test-finish-'+id,body:{quantity:80,defectQuantity:0}});assert.equal(replay.body.replayed,true);assert.equal(f.sync.jobs.list().jobs.filter(j=>j.mode==='write').length,1);
 const next=await f.dispatch();assert.equal((await f.action('start',{assignmentId:next},true)).status,200);await f.sync.tick();assert.equal(f.outputs.size,1);assert.equal(f.store.reportById(f.store.assignmentById(id).reportId).status,'SUCCEEDED');
 const refreshed=f.sync.jobs.list().jobs.filter(j=>j.mode==='read'&&j.kind==='order');assert.deepEqual([...new Set(refreshed.map(j=>j.target))],['201']);assert.equal(f.sync.snapshot('order',202).sync.pending,false);
}finally{await f.close();}});

test('429明确拒绝可退避重试，超时结果未知停止重发并在后台显示',async()=>{
 for(const unknown of [false,true]){const f=await fixture();try{
  const {id}=await f.finish();f.blacklake.writeError=Object.assign(Error('synthetic'),unknown?{code:'BLACKLAKE_TIMEOUT'}:{code:'BLACKLAKE_REJECTED',upstreamStatus:429});await f.sync.tick();let job=f.sync.jobs.list().jobs.find(j=>j.mode==='write');assert.equal(job.state,unknown?'UNKNOWN':'RETRY');assert.equal(f.store.assignmentById(id).status,'COMPLETED');
  const status=await f.call('/v1/admin/data-sync',{admin:true});assert(status.body.jobs.some(j=>j.id===job.id&&j.needsReview===unknown));
  f.advance(3600000);delete f.blacklake.writeError;await f.sync.tick();assert.equal(f.calls.filter(c=>c[0]==='write').length,unknown?1:2);if(!unknown)assert.equal(f.outputs.size,1);
 }finally{await f.close();}}
});

test('过期租约只重试尚未写出的任务，写入边界后恢复为待核对，旧执行器被隔离',()=>{
 const store=new Store(':memory:',{sessionSecret:'queue-test',sessionDays:1});let at=1000;const jobs=new IntegrationJobs(store.db,{now:()=>at});
 try{const a=jobs.enqueue({key:'a',mode:'write',kind:'report-create',target:'a',reportId:'r-a'});const first=jobs.claim();assert.equal(first.id,a.id);assert.equal(jobs.recover().length,0);at+=120001;jobs.recover();const second=jobs.claim();assert.equal(second.attempts,2);assert.throws(()=>jobs.sending(first.id,first.attempts),/状态/);jobs.sending(second.id,second.attempts);at+=120001;jobs.recover();assert.equal(jobs.get(a.id).state,'UNKNOWN');assert.equal(jobs.claim(),null);assert.throws(()=>jobs.retry(a.id,'ADMIN'),/核对/);}finally{store.close();}
});

test('报工修改和删除先保存意图，后台确认后只更新同一工单，旧入口也不能重复改',async()=>{const f=await fixture();try{
 const {id}=await f.finish();await f.sync.tick();for(let n=0;n<3;n++)await f.sync.tick();
 const editor=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(editor.status,200,JSON.stringify(editor.body));
 const input={expectedVersion:editor.body.report.version,goodQuantity:79,defectQuantity:0,defectCodes:[]},key='sync-test-edit-operation';
 let result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',key,body:input});assert.equal(result.body.queued,true,JSON.stringify(result.body));assert.equal(f.outputs.get('12000').fineAmount,80);
 const duplicate=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',key,body:input});assert.equal(duplicate.body.sync.id,result.body.sync.id);
 const changed=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',key,body:{...input,goodQuantity:78}});assert.equal(changed.status,409);
 await f.sync.tick();assert.equal(f.outputs.get('12000').fineAmount,79);assert.equal(f.store.reportById(f.store.assignmentById(id).reportId).good_amount,79);assert.equal(f.store.assignmentById(id).publishedByOperatorId,101);
 const reopen=f.sync.jobs.list().jobs.find(j=>j.kind==='process-reopen');assert(reopen,'数量更正和重开检查必须一同持久化');assert.equal(reopen.payload.projectId,201);assert.equal(reopen.payload.taskId,2011);
 for(let n=0;n<12&&f.sync.jobs.byKey('read:output:12000')?.state!=='SUCCEEDED';n++)await f.sync.tick();const fresh=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(fresh.status,200,JSON.stringify(fresh.body));
 result=await f.call('/v1/dispatch/reports/'+id+'/delete',{method:'POST',key:'sync-test-delete-operation',body:{expectedVersion:fresh.body.report.version}});assert.equal(result.body.queued,true);await f.sync.tick();assert.equal(f.outputs.size,0);assert.equal(f.store.reportById(f.store.assignmentById(id).reportId).status,'DELETED');assert.equal(f.sync.snapshot('order',202).sync.pending,false);
 assert.equal(f.calls.filter(c=>c[0]==='edit').length,1);assert.equal(f.calls.filter(c=>c[0]==='delete').length,1);
}finally{await f.close();}});

test('未知报工只能经后台匹配身份、数量、时间后关联，不重发且保留审计',async()=>{const f=await fixture();try{
 const original=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await original(input);throw Object.assign(Error('response lost'),{code:'BLACKLAKE_TIMEOUT'});};const {id}=await f.finish();await f.sync.tick();const job=f.sync.jobs.list().jobs.find(j=>j.mode==='write');assert.equal(job.state,'UNKNOWN');const publicJob=f.sync.publicJob(job);
 f.outputs.set('13000',{...f.outputs.get('12000'),id:'13000',operatorId:999});
 let response=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,method:'POST',body:{expectedVersion:publicJob.version,outputId:'13000'}});assert.equal(response.status,409);assert.equal(f.sync.jobs.get(job.id).state,'UNKNOWN');
 response=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,method:'POST',body:{expectedVersion:publicJob.version,outputId:'12000'}});assert.equal(response.body.status,'SUCCEEDED',JSON.stringify(response.body));assert.equal(f.store.reportById(f.store.assignmentById(id).reportId).blacklake_output_id,'12000');assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
 const detail=await f.call('/v1/admin/data-sync/jobs/'+job.id,{admin:true});assert(detail.body.events.some(e=>e.event==='READBACK_CONFIRMED'));assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/retry',{admin:true,method:'POST',body:{expectedVersion:publicJob.version}})).status,409);
}finally{await f.close();}});

test('手动刷新只更新当前工单：关闭工序被外部开启后读回新状态，多人重复点击合并',async()=>{const f=await fixture();try{
 const before=f.sync.snapshot('order',201).data;before.tasks[0].processStatus=20;f.sync.save('order',201,before);
 const responses=await Promise.all(Array.from({length:12},()=>f.call('/v1/orders/201/refresh',{worker:true,method:'POST',body:{}})));
 assert(responses.every(r=>r.status===202),JSON.stringify(responses[0]));assert.equal(new Set(responses.map(r=>r.body.sync.refresh.generation)).size,1);
 const job=f.sync.jobs.byKey('read:order:201');assert.equal(job.payload.reason,'manual');assert.equal(f.sync.jobs.byKey('read:order:202'),null);
 assert.equal((await f.call('/v1/orders/201',{worker:true})).body.order.processes[0].closed,true);
 await f.sync.tick();await f.sync.tick();const latest=await f.call('/v1/orders/201',{worker:true});assert.equal(latest.body.order.processes[0].closed,false);assert.equal(latest.body.sync.refresh.completed,true);
 assert.deepEqual(f.calls.filter(c=>['tasks','details'].includes(c[0])).map(c=>c.slice(0,2)),[['tasks',201],['details',201]]);
}finally{await f.close();}});

test('手动刷新丢弃点击前的工序检查点，已停车读取可显式恢复，其他工单不动',async()=>{const f=await fixture();try{
 f.sync.request('order',201,{projectId:201,reason:'audit'});await f.sync.tick();const prior=f.sync.jobs.byKey('read:order:201');assert(f.sync.jobs.progress({...prior,claimed_generation:prior.claimed_generation}).tasks);
 const response=await f.call('/v1/orders/201/refresh',{method:'POST',body:{}});assert.equal(response.status,202);await f.sync.tick();await f.sync.tick();assert.equal(f.calls.filter(c=>c[0]==='tasks').length,2);
 const job=f.sync.jobs.byKey('read:order:201');f.store.db.prepare("UPDATE integration_jobs SET state='FAILED',safe_retry=1,result_json='{\"consecutiveFailures\":5}' WHERE id=?").run(job.id);
 assert.equal((await f.call('/v1/orders/201/refresh',{worker:true,method:'POST',body:{}})).status,202);assert.equal(f.sync.jobs.get(job.id).state,'QUEUED');
 assert.equal((await f.call('/v1/orders/202/refresh',{method:'POST',body:{quantity:1}})).status,422);assert.equal(f.sync.jobs.byKey('read:order:202'),null);
 f.advance(60001);f.sync.pruneObsoleteReads();assert.equal(f.sync.jobs.get(job.id).state,'QUEUED');
}finally{await f.close();}});

test('自动核对丢失编号的已创建报工，只关联唯一精确匹配，不重发创建',async()=>{const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};await f.finish();await f.sync.tick();
 const job=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create');assert.equal(job.state,'UNKNOWN');
 f.blacklake.queryOutputPage=async()=>({records:[...f.outputs.values()].map(r=>({...r,taskId:r.projectProcessId,productionStaffId:r.operatorId,starttimeofReport:r.startedAt,endtimeofReport:r.endedAt,numberofgoodProducts:r.fineAmount,numberofDefectives:r.defectsAmount})),total:1});
 f.sync.recovery.schedule();await f.sync.tick();
 assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED');assert.equal(f.store.reportById(job.report_id).blacklake_output_id,'12000');assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
 assert(f.store.db.prepare("SELECT 1 FROM integration_job_events WHERE job_id=? AND event='AUTO_REVIEW_CONFIRMED'").get(job.id));
}finally{await f.close();}});

test('真实客户端回执经过出站队列：首次完成回查并落库，或保留原报工继续派工',async()=>{
 for(const outcome of ['confirmed','read-throttled','already-linked']){
  const f=await fixture();try{
   const first=await f.finish(),job=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create');
   if(outcome==='already-linked')f.store.db.prepare("INSERT INTO reports(id,idempotency_key,request_hash,operator_id,task_id,project_code,product_name,process_name,output_time,status,amount,defect_amount,good_amount,defect_code,blacklake_output_id) VALUES('old', 'old', 'old', ?,2011,'TEST','合成产品','合成工序','2026-11-13 08:00:00','SUCCEEDED',80,0,80,'','12000')").run(f.store.reportById(job.report_id).operator_id);
   const calls=[];let row;
   const live=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'PRIVATE_TOKEN',timeoutMs:1000,outputAddPath:'/add',outputQueryPath:'/query'},async(url,options)=>{
    const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push(path);
    if(path==='/add'){
     row={reportingId:12000,projectId:body.projectId,taskId:body.projectProcessId,productionStaffId:body.operatorId,
      numberofgoodProducts:body.fineAmount,numberofDefectives:body.defectsAmount,starttimeofReport:body.planStartTime,endtimeofReport:body.planEndTime,
      createdAt:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ')};
     return Response.json({code:'01000000',data:null,msg:'PRIVATE_BODY'});
    }
    assert(f.store.db.prepare("SELECT 1 FROM integration_job_events WHERE job_id=? AND event='CREATE_RESPONSE_EVIDENCE'").get(job.id),'回查前应已经写入脱敏回执');
    return outcome==='read-throttled'?new Response(null,{status:429}):Response.json({code:'01000000',data:[row],page:{total:1}});
   });
   live.limitWriteRate=async()=>{};f.blacklake.createOutput=live.createOutput.bind(live);
   await f.sync.tick();
   const current=f.sync.jobs.get(job.id),report=f.store.reportById(job.report_id),confirmed=outcome==='confirmed';
   assert.equal(current.state,confirmed?'SUCCEEDED':'UNKNOWN');
   assert.equal(current.safe_retry,0);assert.equal(report.blacklake_output_id,confirmed?'12000':null);
   if(confirmed)assert.equal(current.result.readbackConfirmed,true);
   assert.equal(f.store.assignmentById(first.id).status,'COMPLETED');
   assert.deepEqual(calls,outcome==='read-throttled'?['/add','/query']:['/add','/query','/query']);
   const evidence=f.store.db.prepare("SELECT data_json FROM integration_job_events WHERE job_id=? AND event='CREATE_RESPONSE_EVIDENCE' ORDER BY id").all(job.id).map(r=>JSON.parse(r.data_json));
   assert.equal(evidence[0].outcome,'accepted-without-id');assert.equal(evidence.length,2);assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE_/);
   if(!confirmed)assert.equal(f.sync.publicJob(current).automation.category,'automatic');
  }finally{await f.close();}
 }
});

test('工单优先级和两种可派状态之间的待核对不占用整单派工资格，结束和未知状态仍保护',async()=>{
 const f=await fixture();try{
  const insert=f.store.db.prepare("INSERT INTO workspace_order_operations(actor,operation_id,order_id,request_hash,status,before_json,target_json,created_at,updated_at) VALUES ('fixture',?,201,'fixture','UNKNOWN',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  for(const [i,before,target,blocked] of [[0,'IN_PROGRESS','IN_PROGRESS',false],[1,'IN_PROGRESS','NOT_STARTED',false],[2,'NOT_STARTED','IN_PROGRESS',false],[3,'IN_PROGRESS','FINISHED',true],[4,'FINISHED','IN_PROGRESS',true],[5,'UNKNOWN','IN_PROGRESS',true]]){
   insert.run('fixture-'+i,JSON.stringify({status:before}),JSON.stringify({status:target}));
   assert.equal(f.store.orderStatusPending(201),blocked);
   f.store.db.prepare("UPDATE workspace_order_operations SET status='SUPERSEDED' WHERE operation_id=?").run('fixture-'+i);
  }
 }finally{await f.close();}
});

test('员工计时与确认数量从本地快照区分工单和工序计划剩余，未知不冒充零',async()=>{const f=await fixture();try{
 const id=await f.dispatch();assert.equal((await f.action('start',{assignmentId:id},true)).status,200);f.advance(30000);
 assert.equal((await f.action('end',{assignmentId:id},true)).status,200);
 const cached=f.sync.snapshot('order',201).data,info={...cached.info,plannedAmount:150,actualAmount:40};
 f.sync.indexOrder(info);f.sync.save('order',201,{info,tasks:[{...cached.tasks[0],plannedAmount:100,reportedGoodAmount:42,remnantAmount:48}]});
 f.calls.length=0;
 const read=async()=>{const r=await f.call('/v1/workspace/worker',{worker:true});assert.equal(r.status,200);return r.body.assignments.find(a=>a.id===id);};
 const first=await read();assert.equal(first.reportPlanQuantity,100);assert.equal(first.reportRemainingQuantity,48);assert.equal(first.processPlanQuantity,48);assert.equal(first.orderInfo.remainingQuantity,110);
 f.sync.save('order',201,{info,tasks:[{...cached.tasks[0],plannedAmount:100,reportedGoodAmount:0,quantityPresence:{reportedGoodAmount:false}}]});
 const unknown=await read();assert.equal(unknown.reportRemainingQuantity,null);assert.equal(unknown.processPlanQuantity,null);
 f.sync.save('order',201,{info,tasks:[{...cached.tasks[0],plannedAmount:100,reportedGoodAmount:101}]});
 const zero=await read();assert.equal(zero.reportRemainingQuantity,0);assert.equal(zero.processPlanQuantity,0);assert.deepEqual(f.calls,[]);
}finally{await f.close();}});

test('自动核对空结果或多条相同记录均保持UNKNOWN，零新增写入',async()=>{for(const count of [0,2]){const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};await f.finish();await f.sync.tick();const parent=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create'),r=[...f.outputs.values()][0];
 f.blacklake.queryOutputPage=async()=>({records:Array.from({length:count},(_,n)=>({...r,id:13000+n,taskId:r.projectProcessId,productionStaffId:r.operatorId,starttimeofReport:r.startedAt,endtimeofReport:r.endedAt,numberofgoodProducts:r.fineAmount,numberofDefectives:r.defectsAmount})),total:count});
 f.sync.recovery.schedule();await f.sync.tick();assert.equal(f.sync.jobs.get(parent.id).state,'UNKNOWN');assert.equal(f.calls.filter(c=>c[0]==='write').length,1);assert.equal(f.sync.recovery.meta(parent.id).needsHuman,count===2);
 assert.equal(f.sync.publicJob(f.sync.jobs.get(parent.id)).automation.category,count===2?'human':'automatic');
}finally{await f.close();}}});

test('缺回执连续三次查空仍保护原报工，但作为系统排查而非人工确认',async()=>{const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};
 await f.finish();await f.sync.tick();
 const parent=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create');
 f.sync.recovery.save(parent.id,{round:2,nextAt:0});
 f.sync.recovery.schedule();await f.sync.tick();
 const job=f.sync.jobs.get(parent.id);
 assert.equal(job.state,'UNKNOWN');assert.equal(f.sync.publicJob(job).automation.category,'system');
 const human=await f.call('/v1/admin/data-sync?attention=human',{admin:true});
 assert.equal(human.body.automation.human,0);assert.equal(human.body.jobTotal,0);
 const system=await f.call('/v1/admin/data-sync?attention=system',{admin:true});
 assert.equal(system.body.jobTotal,1);assert.deepEqual(system.body.jobs.map(j=>j.id),[job.id]);
 assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
}finally{await f.close();}});

test('已暂停的后台核对可按退避继续只读查证，原写任务仍保持UNKNOWN',async()=>{const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};
 await f.finish();await f.sync.tick();
 const parent=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create');
 f.sync.recovery.schedule();
 const read=f.sync.jobs.byKey('read:write-review:'+parent.id);
 f.store.db.prepare("UPDATE integration_jobs SET state='FAILED',safe_retry=1 WHERE id=?").run(read.id);
 f.advance(30*60000+1);f.sync.recovery.schedule();
 assert.equal(f.sync.jobs.get(read.id).state,'QUEUED');
 await f.sync.tick();assert.equal(f.sync.jobs.get(read.id).state,'SUCCEEDED');
 assert.equal(f.sync.jobs.get(parent.id).state,'UNKNOWN');assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
}finally{await f.close();}});

test('自动核对跨页检查唯一性，第一页有匹配也不提前关联',async()=>{const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};await f.finish();await f.sync.tick();const parent=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create'),r=[...f.outputs.values()][0];
 const raw={...r,id:13000,taskId:r.projectProcessId,productionStaffId:r.operatorId,starttimeofReport:r.startedAt,endtimeofReport:r.endedAt,numberofgoodProducts:r.fineAmount,numberofDefectives:r.defectsAmount};
 f.blacklake.queryOutputPage=async(_,page)=>({records:page.pageNum===1?[raw,...Array.from({length:99},()=>({...raw,projectId:999}))]:[{...raw,id:13001}],total:101});
 f.sync.recovery.schedule();await f.sync.tick();assert.equal(f.sync.jobs.get(parent.id).state,'UNKNOWN');await f.sync.tick();assert.equal(f.sync.jobs.get(parent.id).state,'UNKNOWN');assert.equal(f.sync.recovery.meta(parent.id).needsHuman,true);assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
}finally{await f.close();}});

test('候选匹配后仍精确回读核对，远端数量变化不误关联',async()=>{const f=await fixture();try{
 const create=f.blacklake.createOutput;f.blacklake.createOutput=async input=>{await create(input);return {};};await f.finish();await f.sync.tick();const parent=f.sync.jobs.list().jobs.find(j=>j.kind==='report-create'),r=[...f.outputs.values()][0];
 f.blacklake.queryOutputPage=async()=>({records:[{...r,taskId:r.projectProcessId,productionStaffId:r.operatorId,starttimeofReport:r.startedAt,endtimeofReport:r.endedAt,numberofgoodProducts:r.fineAmount,numberofDefectives:r.defectsAmount}],total:1});f.blacklake.readOutputForCorrection=async()=>({...r,fineAmount:79});
 f.sync.recovery.schedule();await f.sync.tick();assert.equal(f.sync.jobs.get(parent.id).state,'UNKNOWN');assert.equal(f.store.reportById(parent.report_id).blacklake_output_id,null);assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
}finally{await f.close();}});

test('自动恢复每分钟最多一个读取探测，失败后持久退避，不能自动重发未知写',async()=>{const f=await fixture();try{
 const jobs=[];for(const id of [201,202]){const j=f.sync.request('materials',id+':1',{projectId:id,pageNum:1});jobs.push(j);f.store.db.prepare("UPDATE integration_jobs SET state='FAILED',safe_retry=1,error_code='BLACKLAKE_SYNC_FAILED',updated_at=updated_at-600000,result_json=? WHERE id=?").run(JSON.stringify({consecutiveFailures:5}),j.id);}
 f.sync.handlers.set('materials',async()=>{throw Error('still unavailable');});f.sync.recovery.schedule();assert.equal(jobs.filter(j=>f.sync.jobs.get(j.id).state==='QUEUED').length,1);await f.sync.tick();const probed=jobs.find(j=>f.sync.recovery.meta(j.id).round===1);assert.equal(f.sync.jobs.get(probed.id).state,'FAILED');const next=f.sync.recovery.meta(probed.id).nextAt;
 f.sync.recovery.schedule();assert.equal(jobs.filter(j=>f.sync.jobs.get(j.id).state==='QUEUED').length,0);f.advance(60001);f.sync.recovery.schedule();assert.equal(f.sync.jobs.get(probed.id).state,'FAILED');assert.equal(f.sync.recovery.meta(probed.id).nextAt,next);
 assert(f.sync.recovery.summary().automatic>=1);assert.equal(f.calls.filter(c=>c[0]==='write').length,0);
}finally{await f.close();}});

test('明确核对未写入后才允许重试，取消同步保留本地记录',async()=>{for(const cancel of [false,true]){const f=await fixture();try{
 const {id}=await f.finish();if(cancel){const job=f.sync.jobs.list().jobs.find(j=>j.mode==='write'),response=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/cancel',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version}});assert.equal(response.body.status,'CANCELLED');await f.sync.tick();assert.equal(f.calls.filter(c=>c[0]==='write').length,0);assert.equal(f.store.assignmentById(id).status,'COMPLETED');assert(f.store.reportById(job.report_id));continue;}
 f.blacklake.writeError=Object.assign(Error('timeout'),{code:'BLACKLAKE_TIMEOUT'});await f.sync.tick();let job=f.sync.jobs.list().jobs.find(j=>j.mode==='write');
 assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/retry',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version}})).status,409);
 assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/confirm-absent',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version,confirmedAbsent:false}})).status,409);
 assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/confirm-absent',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version,confirmedAbsent:true}})).status,200);job=f.sync.jobs.get(job.id);assert.equal(job.safe_retry,1);
 delete f.blacklake.writeError;assert.equal((await f.call('/v1/admin/data-sync/jobs/'+job.id+'/retry',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version}})).status,200);await f.sync.tick();assert.equal(f.outputs.size,1);
}finally{await f.close();}}});

test('队列插入失败会回滚报工，不能把未可靠保存的数量当完成',async()=>{const f=await fixture();try{
 const id=await f.dispatch();await f.action('start',{assignmentId:id},true);await f.action('end',{assignmentId:id},true);const enqueue=f.sync.jobs.enqueue.bind(f.sync.jobs);f.sync.jobs.enqueue=options=>{if(options.mode==='write')throw Error('synthetic queue unavailable');return enqueue(options);};
 const result=await f.call('/v1/assignments/'+id+'/finish',{worker:true,method:'POST',key:'atomic-queue-failure',body:{quantity:12,defectQuantity:0}});assert.equal(result.status,500);assert.equal(f.store.assignmentById(id).status,'IN_PROGRESS');assert.equal(f.store.assignmentById(id).reportId,null);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);assert.equal(f.outputs.size,0);
}finally{await f.close();}});

test('SQLite重开保留工单快照和分页游标，失败后从下一页继续',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blacklake-sync-')),file=path.join(dir,'test.sqlite'),config={sessionSecret:'synthetic-persistence',sessionDays:1};let store,at=1000;const pages=[];let fail=true;
 const blacklake={queryWorkOrderCatalogPage:async input=>{pages.push(input.pageNum);if(input.pageNum===2&&fail)throw Object.assign(Error('rate'),{code:'RATE_LIMIT',upstreamStatus:429});return {records:[{projectId:input.pageNum,projectCode:'2026-'+input.pageNum,productCode:'S'+input.pageNum}],hasMore:input.pageNum===1};}};
 try{store=new Store(file,config);let sync=new BlacklakeSync({store,blacklake,now:()=>at,historyDays:0});sync.request('catalog',2026,{year:2026,pageNum:1});await sync.tick();assert.equal(sync.snapshot('catalog',2026).sync.complete,false);store.close();store=new Store(file,config);sync=new BlacklakeSync({store,blacklake,now:()=>at,historyDays:0});await sync.tick();assert.deepEqual(pages,[1,2]);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM blacklake_order_index').get().n,1);at+=20001;fail=false;await sync.tick();assert.deepEqual(pages,[1,2,2]);assert.equal(sync.snapshot('catalog',2026).sync.complete,true);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM blacklake_order_index').get().n,2);}finally{store?.close();const absolute=path.resolve(dir);assert(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(absolute,{recursive:true,force:true});}
});

test('后台确认已完成报工不会打断员工下一单的开始版本',async()=>{const f=await fixture();try{
 await f.finish();const next=await f.dispatch(),before=await f.call('/v1/workspace/worker',{worker:true});await f.sync.tick();
 const started=await f.call('/v1/workspace/actions',{worker:true,method:'POST',key:'start-after-background-sync',body:{action:'start',input:{assignmentId:next},meta:{expectedVersion:before.body.version}}});assert.equal(started.status,200,JSON.stringify(started.body));assert.equal(f.store.assignmentById(next).status,'IN_PROGRESS');
}finally{await f.close();}});

test('工序同步失败保留完整旧路线，首次未同步不会伪装成零道工序',async()=>{const f=await fixture();try{
 f.blacklake.listWorkOrderProcesses=async()=>[];f.sync.request('order',201,{projectId:201},true);await f.sync.tick();assert.equal(f.sync.snapshot('order',201).data.tasks.length,1);assert.equal(f.sync.snapshot('order',201).sync.status,'stale');
 f.store.db.prepare("DELETE FROM blacklake_sync_snapshots WHERE kind='order' AND target='202'").run();const details=await f.call('/v1/orders/202');assert.equal(details.status,200);assert.equal(details.body.fetchedAt,null);assert.equal(details.body.order.processesLoaded,false);const processes=await f.call('/v1/orders/202/processes');assert.equal(processes.status,503);assert.equal(processes.body.error.code,'BLACKLAKE_DATA_SYNCING');
}finally{await f.close();}});

test('修改已发出后的429按待核对处理，管理员只读核对即可收敛，不能自动重写',async()=>{const f=await fixture();try{
 const {id}=await f.finish();for(let n=0;n<4;n++)await f.sync.tick();const editor=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(editor.status,200);
 const edit=f.blacklake.updateOutputConfirmed;f.blacklake.updateOutputConfirmed=async(...args)=>{await edit(...args);throw Object.assign(Error('readback rate limited'),{code:'BLACKLAKE_REJECTED',upstreamStatus:429});};
 const accepted=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',key:'mutation-partial-429',body:{expectedVersion:editor.body.report.version,goodQuantity:77,defectQuantity:0,defectCodes:[]}});await f.sync.tick();const job=f.sync.jobs.get(accepted.body.sync.id);assert.equal(job.state,'UNKNOWN');assert.equal(job.safe_retry,0);assert.equal(f.outputs.get('12000').fineAmount,77);
 const confirmed=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,method:'POST',body:{expectedVersion:f.sync.publicJob(job).version}});assert.equal(confirmed.body.status,'SUCCEEDED',JSON.stringify(confirmed.body));assert.equal(f.calls.filter(c=>c[0]==='edit').length,1);assert.equal(f.store.reportById(job.report_id).good_amount,77);
}finally{await f.close();}});

test('管理员定向刷新同样拒绝跨站来源、额外参数和非管理员',async()=>{const f=await fixture();try{
 const path='/v1/admin/data-sync/refresh',options={admin:true,method:'POST',body:{projectId:201}};
 assert.equal((await f.call(path,{...options,admin:false})).status,401);
 for(const headers of [{'Sec-Fetch-Site':'cross-site'},{Origin:'https://untrusted.invalid'},{Origin:'null'}])assert.equal((await f.call(path,{...options,headers})).status,403);
 assert.equal((await f.call(path,{...options,body:{projectId:201,all:true}})).status,422);
 assert.equal(f.sync.jobs.byKey('read:order:201'),null);
 assert.equal((await f.call(path,options)).status,202);assert.equal(f.calls.length,0);
 assert.equal(f.sync.jobs.byKey('read:order:201').target,'201');assert.equal(f.sync.jobs.byKey('read:order:202'),null);
}finally{await f.close();}});

test('已完成任务从现有共享快照恢复完整产品资料，不安排历史工单重刷',async()=>{const f=await fixture();try{
 await f.finish();f.store.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED' WHERE mode='read'").run();const state=await f.call('/v1/workspace/worker',{worker:true});assert.equal(state.body.sources.orders,'blacklake-snapshot');
 const task=state.body.assignments[0];assert.equal(task.orderInfo.productCode,'SKU-201');assert.equal(task.processPlanQuantity,100);
 assert.equal(f.sync.jobs.byKey('read:order:201'),null);assert.equal(f.calls.length,0);
}finally{await f.close();}});

test('重启恢复不受后台100条分页限制，全部未知创建任务均转待核对',()=>{
 const store=new Store(':memory:',{sessionSecret:'synthetic-recovery',sessionDays:1}),sync=new BlacklakeSync({store,blacklake:{}}),seen=[];
 try{
  const operator=store.upsertBlacklakeOperator({blacklakeOperatorId:101,name:'合成恢复测试'});
  for(let n=0;n<125;n++){const reportId='recovery-'+n;store.db.prepare("INSERT INTO reports(id,idempotency_key,request_hash,operator_id,task_id,project_code,product_name,process_name,output_time,status,amount,defect_amount,good_amount,defect_code) VALUES(?,?,?,?,11,'TEST','合成产品','合成工序','2026-11-13 08:00:00','PENDING',1,0,1,'')").run(reportId,reportId,reportId,operator.id);const job=sync.jobs.enqueue({key:reportId,mode:'write',kind:'report-create',target:reportId,reportId,payload:{idempotencyKey:reportId}});store.db.prepare("UPDATE integration_jobs SET state='UNKNOWN' WHERE id=?").run(job.id);}
  const outbox=new ReportOutbox({store,sync,blacklake:{},leaderReports:()=>null});sync.onRecovered=job=>seen.push(job.id);outbox.recover();assert.equal(new Set(seen).size,125);
 }finally{store.close();}
});

test('成功回执落库后队列未收尾就重启，恢复本地回执而不降级或重复上报',async()=>{const f=await fixture();try{
 const {id}=await f.finish();await f.sync.tick();const reportId=f.store.assignmentById(id).reportId,job=f.sync.jobs.list().jobs.find(j=>j.mode==='write');
 f.store.db.prepare("UPDATE integration_jobs SET state='RUNNING',phase='SENDING',lease_until=0 WHERE id=?").run(job.id);
 const outbox=new ReportOutbox({store:f.store,sync:f.sync,blacklake:f.blacklake,leaderReports:()=>null});outbox.recover();
 assert.equal(f.store.reportById(reportId).status,'SUCCEEDED');assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED');assert.equal(f.sync.jobs.get(job.id).result.localReceiptRecovered,true);
 for(let n=0;n<5;n++)await f.sync.tick();assert.equal(f.calls.filter(c=>c[0]==='write').length,1);assert.equal(f.outputs.size,1);
}finally{await f.close();}});

test('关闭同步前必须处理全部已接受写任务，明确取消后才可关闭',()=>{
 const store=new Store(':memory:',{sessionSecret:'synthetic-disable',sessionDays:1});try{assert.doesNotThrow(()=>assertSyncCanDisable(store.db));const jobs=new IntegrationJobs(store.db),job=jobs.enqueue({key:'unsettled',mode:'write',kind:'report-create',target:'synthetic',reportId:'synthetic'});
 for(const state of ['QUEUED','RUNNING','RETRY','UNKNOWN','FAILED']){store.db.prepare('UPDATE integration_jobs SET state=? WHERE id=?').run(state,job.id);assert.throws(()=>assertSyncCanDisable(store.db),e=>e.code==='SYNC_OUTBOX_NOT_DRAINED');}
 for(const state of ['SUCCEEDED','CANCELLED']){store.db.prepare('UPDATE integration_jobs SET state=? WHERE id=?').run(state,job.id);assert.doesNotThrow(()=>assertSyncCanDisable(store.db));}
 }finally{store.close();}
});

test('历史报工完整分页后才供统计，JSON筛选参数化且删除标记不被导入复活',async()=>{const f=await fixture();try{
 f.store.db.prepare("DELETE FROM blacklake_sync_snapshots WHERE kind='history-day'").run();const date='2026-11-13',records=Array.from({length:101},(_,n)=>({reportingId:n+1,projectId:n%2?202:201,projectCode:n===0?"2026-'特殊":'2026-普通',taskId:2011,productionStaffId:n%2?101:102,numberofgoodProducts:1,createdAt:date+' 08:00:00',outputTime:date+' 08:00:00'}));
 f.blacklake.queryOutputPage=async(filters,page)=>({records:records.slice((page.pageNum-1)*100,page.pageNum*100),total:101});
 assert.throws(()=>f.sync.outputPage({createdAtGte:date+' 00:00:00',createdAtLte:date+' 23:59:59'}),e=>e.code==='BLACKLAKE_DATA_SYNCING');
 await f.sync.tick();assert.equal(f.sync.snapshot('history-day',date).sync.complete,false);assert.throws(()=>f.sync.outputPage(),e=>e.code==='BLACKLAKE_DATA_SYNCING');await f.sync.tick();
 const query={createdAtGte:date+' 00:00:00',createdAtLte:date+' 23:59:59'};assert.equal(f.sync.outputPage(query).total,101);assert.equal(f.sync.outputPage({...query,operatorId:102,projectId:201}).total,51);assert.equal(f.sync.outputPage({...query,projectCode:"2026-'特殊"}).total,1);assert.equal(f.sync.outputPage({...query,projectCode:"' OR 1=1 --"}).total,0);
 f.sync.invalidateOrder(201,{outputId:1,deleted:true});f.sync.request('history-day',date,{date,pageNum:1},true);for(let n=0;n<4;n++)await f.sync.tick();assert.equal(f.sync.outputPage({...query,id:1}).total,0);
}finally{await f.close();}});

test('过期读取执行器不得覆盖接管后的工单快照',async()=>{const f=await fixture();try{
 let release,entered;const ready=new Promise(resolve=>{entered=resolve;});f.blacklake.listWorkOrderProcesses=async()=>{entered();await new Promise(resolve=>{release=resolve;});return [{taskId:2011,projectId:201,projectCode:'2026-SYNC-201',plannedAmount:1}];};
 f.sync.request('order',201,{projectId:201},true);const old=f.sync.tick();await ready;f.advance(120001);f.sync.jobs.recover();const next=f.sync.jobs.claim();f.sync.save('order',201,{info:{projectId:201,projectCode:'2026-SYNC-201',plannedAmount:200},tasks:[]});f.sync.jobs.finish(next.id,{attempt:next.attempts});release();await old;
 assert.equal(f.sync.snapshot('order',201).data.info.plannedAmount,200);assert.equal(f.sync.jobs.get(next.id).state,'SUCCEEDED');
}finally{await f.close();}});

test('入队后撤回组长权限，后台执行前拒绝原修改意图且没有黑湖写入',async()=>{const f=await fixture();try{
 const {id}=await f.finish();for(let n=0;n<4;n++)await f.sync.tick();const editor=await f.call('/v1/dispatch/reports/'+id+'/editor');
 const accepted=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',key:'revoke-after-queue',body:{expectedVersion:editor.body.report.version,goodQuantity:77,defectQuantity:0,defectCodes:[]}});assert.equal(accepted.body.queued,true);
 f.store.setEntryProfile(101,{appRole:'employee'});await f.sync.tick();assert.equal(f.sync.jobs.get(accepted.body.sync.id).state,'FAILED');assert.equal(f.calls.filter(c=>c[0]==='edit').length,0);assert.equal(f.outputs.get('12000').fineAmount,80);
}finally{await f.close();}});

test('黑湖429触发全局持久退避，不轮流用其他同步任务继续撞限流',async()=>{const f=await fixture();try{
 await f.finish();f.blacklake.writeError=Object.assign(Error('rate'),{code:'BLACKLAKE_REJECTED',upstreamStatus:429});await f.sync.tick();const calls=f.calls.length;
 f.sync.request('order',202,{projectId:202});for(let n=0;n<8;n++)await f.sync.tick();assert.equal(f.calls.length,calls);assert.equal(f.sync.jobs.byKey('read:order:202').state,'QUEUED');
 const restarted=new BlacklakeSync({store:f.store,blacklake:f.blacklake,now:()=>Date.parse('2026-11-13T00:00:00Z')+10000});await restarted.tick();assert.equal(f.calls.length,calls);
 f.advance(20000);delete f.blacklake.writeError;await f.sync.tick();assert.equal(f.outputs.size,1);
}finally{await f.close();}});

test('工序主动刷新强制读该工单历史，多页完成后确认新请求；普通打开零上游',async()=>{const f=await fixture();try{
 const path='/v1/workspace/process-reports/201/2011';f.sync.save('order-reports',201,{ids:[]});let reads=0;
 f.blacklake.queryOutputPage=async(filters,page)=>{reads++;assert.equal(filters.projectCode,'2026-SYNC-201');return {records:[{reportingId:String(600+page.pageNum),projectId:201,taskId:2011,productionStaffId:102,productionStaff:'同步测试员工',numberofgoodProducts:42,numberofDefectives:0,effectiveTime:60,createdAt:'2026-11-13 08:00:00'}],total:101};};
 assert.equal((await f.call(path)).status,200);assert.equal(reads,0);
 const first=await f.call(path+'/refresh',{method:'POST',body:{}});assert.equal(first.status,200,JSON.stringify(first.body));assert(first.body.sync.refresh.requestId);assert.equal(first.body.sync.refresh.completed,false);
 const second=await f.call(path+'/refresh',{method:'POST',body:{}});assert.equal(first.body.sync.refresh.requestId,second.body.sync.refresh.requestId);
 await f.sync.tick();assert.equal((await f.call(path)).body.sync.refresh.completed,false);for(let n=0;n<8&&!f.sync.reportRefreshState(201).completed;n++)await f.sync.tick();
 const done=await f.call(path);assert.equal(done.body.sync.refresh.completed,true);assert.equal(done.body.sync.refresh.requestId,first.body.sync.refresh.requestId);assert.equal(done.body.reports.length,2);assert.equal(reads,2);
 assert.equal((await f.call('/v1/workspace/process-reports/201/2021/refresh',{method:'POST',body:{}})).status,404);
}finally{await f.close();}});

test('黑湖关联人员按黑湖数量和工时展示，本地独有人员及UNKNOWN保留原值，计时归属不被重写',async()=>{const f=await fixture();try{
 const {id}=await f.finish();await f.sync.tick();const assignment=f.store.assignmentById(id),reportId=assignment.reportId;assert.equal(f.store.reportById(reportId).status,'SUCCEEDED');
 f.store.db.prepare("UPDATE reports SET created_at='2026-11-13 00:00:00' WHERE id=?").run(reportId);
 const raw={reportingId:'12000',projectId:201,taskId:2011,productionStaffId:102,productionStaff:'黑湖员工新名称',numberofgoodProducts:62,numberofDefectives:0,effectiveTime:123,createdAt:'2026-11-13 08:00:00',starttimeofReport:'2026-11-13 07:00:00',endtimeofReport:'2026-11-13 07:02:03'};
 f.store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,raw_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(output_id) DO UPDATE SET raw_json=excluded.raw_json,correction_json=NULL,updated_at=excluded.updated_at').run('12000',201,2011,JSON.stringify(raw),Date.now());
 const before=JSON.stringify(f.store.assignmentById(id));let r=await f.call('/v1/workspace/process-reports/201/2011');assert.equal(r.body.reports.length,1);assert.equal(r.body.reports[0].goodQuantity,62);assert.equal(r.body.reports[0].reportedSeconds,123);assert.equal(r.body.reports[0].productionWorkerName,'黑湖员工新名称');
 let stats=await f.call('/v1/workspace/reports?from=2026-11-13&to=2026-11-13');assert.equal(stats.body.records.find(r=>r.id===reportId).goodQuantity,62);assert.equal(stats.body.records.find(r=>r.id===reportId).startedAt,'2026-11-12T23:00:00.000Z');assert.equal(JSON.stringify(f.store.assignmentById(id)),before);
 const lock=f.sync.jobs.enqueue({key:'pending-authority-test',mode:'write',kind:'report-edit',target:id,reportId,payload:{}});f.store.db.prepare("UPDATE integration_jobs SET state='UNKNOWN' WHERE id=?").run(lock.id);
 r=await f.call('/v1/workspace/process-reports/201/2011');assert.equal(r.body.reports[0].goodQuantity,80);
 f.store.db.prepare("UPDATE integration_jobs SET state='CANCELLED' WHERE id=?").run(lock.id);
 f.store.db.prepare('UPDATE operators SET blacklake_operator_id=? WHERE id=?').run(1000000000001,assignment.operatorId);
 r=await f.call('/v1/workspace/process-reports/201/2011');assert.equal(r.body.reports[0].goodQuantity,80);
}finally{await f.close();}});

test('旧的在途工单报工读取不能覆盖点击后的新请求或假报刷新完成',async()=>{const f=await fixture();try{
 f.sync.save('order-reports',201,{ids:[]});let resolve,entered;const gate=new Promise(r=>entered=r);let calls=0;f.blacklake.queryOutputPage=async()=>{calls++;if(calls===1){entered();return new Promise(r=>resolve=r);}return {records:[],total:0};};
 f.sync.request('order-reports',201,{projectId:201,projectCode:'2026-SYNC-201',pageNum:1});const running=f.sync.tick();await gate;
 const requested=await f.call('/v1/workspace/process-reports/201/2011/refresh',{method:'POST',body:{}});const token=requested.body.sync.refresh.requestId;
 resolve({records:[{reportingId:77,projectId:201,taskId:2011,createdAt:'2026-11-13 08:00:00'}],total:200});await running;
 assert.equal(f.sync.jobs.byKey('read:order-reports:201').payload.requestId,token);assert.equal(f.store.db.prepare('SELECT 1 FROM blacklake_output_index WHERE output_id=?').get('77'),undefined);
 for(let n=0;n<8&&!f.sync.reportRefreshState(201).completed;n++)await f.sync.tick();assert.equal(f.sync.reportRefreshState(201).completed,true);assert.equal(calls,2);
}finally{await f.close();}});
