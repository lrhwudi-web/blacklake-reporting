import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {createApp} from '../src/app.mjs';
import {nativeFixture} from './native-report-fixture.mjs';
import {UpstreamReports} from '../src/upstream-reports.mjs';

async function fixture(){
 let at=Date.parse('2026-11-10T18:00:00+08:00'),deleted=false,reopens=0;const config={sessionSecret:'upstream-history-isolated',sessionDays:1,adminApiKey:'synthetic-admin',agent:{enabled:false},review:{enabled:false},dataSync:{allowNext:true}},store=new Store(':memory:',config),driver=nativeFixture(),blacklake=driver.client;
 const people=[{blacklakeOperatorId:101,name:'组长甲'},{blacklakeOperatorId:102,name:'组长乙'},{blacklakeOperatorId:201,name:'测试员工'},{blacklakeOperatorId:202,name:'质检组长'}],operators=people.map(p=>store.upsertBlacklakeOperator(p));
 for(const id of [101,102])store.setEntryProfile(id,{appRole:'floor8_leader'});store.setQualityProfile(202,'quality_leader',0,'synthetic');
 const info={projectId:501,projectCode:'TEST-WO',productName:'合成产品',projectStatus:'10',projectPriority:0},task={taskId:1,projectId:501,projectCode:'TEST-WO',processName:'测试工序',processStatus:20,plannedAmount:100,reportedGoodAmount:100,reportedDefectAmount:0};
 blacklake.listOperators=async()=>people;blacklake.listWorkOrderProcesses=async()=>[{...task,reportedGoodAmount:driver.remote.fineAmount}];blacklake.readWorkOrderDetails=async()=>info;blacklake.findTaskById=async()=>({...task,reportedGoodAmount:driver.remote.fineAmount});
 const native=blacklake.nativeRequest.bind(blacklake);blacklake.nativeRequest=async(path,input,options)=>{if(path==='/api/dytin/project/process/update'){reopens++;task.processStatus=input.projectProcess.processStatus;return {code:'01000000'};}return native(path,input,options);};
 const read=blacklake.readOutputForCorrection.bind(blacklake);blacklake.readOutputForCorrection=async(...args)=>{if(deleted)throw Object.assign(Error('confirmed absence'),{definiteAbsence:true});return read(...args);};blacklake.deleteOutputConfirmed=async()=>{deleted=true;};
 const sync=new BlacklakeSync({store,blacklake,now:()=>at}),remote=await blacklake.readOutputForCorrection('1001',{production:true}),raw={reportingId:1001,projectId:501,projectCode:'TEST-WO',taskId:1,productionStaffId:201,productionStaff:'测试员工',numberofgoodProducts:100,numberofDefectives:0,effectiveTime:5700,createdAt:'2026-11-10 14:20:00'};
 sync.indexOrder(info);sync.save('order',501,{info,tasks:[task]});sync.save('people','all',people);sync.save('order-reports',501,{ids:['1001']});
 store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,created_at,raw_json,correction_json,correction_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('1001',501,1,raw.createdAt,JSON.stringify(raw),JSON.stringify(remote),at,at);
 const app=createApp({config,store,blacklake,wechat:{},dataSync:sync,defectReasons:[{code:'D1',name:'测试不良'}],now:()=>at}),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const tokens=operators.map(o=>store.createSession(o.id).token);
 const call=async(path,{who=0,admin=false,method='GET',body,key='upstream-op-12345'}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Key':config.adminApiKey}:{Authorization:'Bearer '+tokens[who]}),'Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const path='/v1/workspace/process-reports/501/1',editor=()=>call(path+'/blacklake%3A1001/editor'),change=(body,options={})=>call(path+'/blacklake%3A1001/edit',{method:'POST',body,...options});
 const input=editor=>({expectedVersion:editor.report.version,expectedRemoteVersion:editor.report.remoteVersion,goodQuantity:90,defectQuantity:10,defectCodes:['D1'],defectItems:[{code:'D1',amount:10}],operatorId:201,startedAt:remote.startedAt,endedAt:remote.endedAt,durationSeconds:5700,materialProcess:'历史用料',punchMinutes:200});
 return {store,sync,driver,blacklake,people,call,path,editor,change,input,reopens:()=>reopens,advance:ms=>at+=ms,now:()=>at,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}
test('工单工序入口为所有组长和质检组长显示黑湖历史修改删除，普通员工只读',async()=>{const f=await fixture();try{
 for(const who of [0,1,3]){const list=await f.call(f.path,{who});assert.equal(list.status,200);assert.equal(list.body.permission,'all-process-reports');assert.equal(list.body.reports[0].id,'blacklake:1001');assert.equal(list.body.reports[0].canEdit,true);assert.equal(list.body.reports[0].canDelete,true);assert.equal((await f.call(f.path+'/blacklake%3A1001/editor',{who})).status,200);}
 const worker=await f.call(f.path,{who:2});assert.equal(worker.body.reports[0].canEdit,false);assert.equal((await f.call(f.path+'/blacklake%3A1001/editor',{who:2})).status,403);
 assert.equal((await f.call('/v1/workspace/process-reports/502/1/blacklake%3A1001/editor')).status,404);assert.equal((await f.call('/v1/workspace/process-reports/501/2/blacklake%3A1001/editor')).status,404);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
}finally{await f.close();}});
test('历史数量工时及不良编辑可靠排队，原位回读，重复提交不重发；降低数量后检查重开',async()=>{const f=await fixture();try{
 const editor=await f.editor();assert.equal(editor.status,200,JSON.stringify(editor.body));const input=f.input(editor.body),saved=await f.change(input);assert.equal(saved.body.queued,true,JSON.stringify(saved.body));assert.equal(f.driver.remote.fineAmount,100);
 const replay=await f.change(input);assert.equal(replay.body.sync.id,saved.body.sync.id);const pending=await f.call(f.path);assert.equal(pending.body.reports[0].canManage,true);assert.equal(pending.body.reports[0].canEdit,false);assert.equal(pending.body.reports[0].sync.state,'QUEUED');assert.equal(pending.body.sync.pending,true);assert(pending.body.reports[0].managementBlockedReason);
 await f.sync.tick();assert.equal(f.driver.remote.fineAmount,90);assert.equal(f.driver.remote.defectsAmount,10);assert.equal(f.sync.jobs.get(saved.body.sync.id).state,'SUCCEEDED');
 const updated=await f.call(f.path);assert.equal(updated.body.reports[0].goodQuantity,90);assert.equal(updated.body.reports[0].defectiveQuantity,10);assert.equal(updated.body.reports[0].canEdit,true);
 await f.sync.tick();assert.equal(f.reopens(),1);assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);
}finally{await f.close();}});
test('其他组长可删除历史，删除墓碑不复活，且不更改任何派工归属',async()=>{const f=await fixture();try{
 const editor=await f.call(f.path+'/blacklake%3A1001/editor',{who:1});const result=await f.call(f.path+'/blacklake%3A1001/delete',{who:1,method:'POST',body:{expectedVersion:editor.body.report.version},key:'other-leader-delete-history'});assert.equal(result.body.queued,true);await f.sync.tick();assert.equal(f.sync.jobs.get(result.body.sync.id).state,'SUCCEEDED');assert.equal((await f.call(f.path)).body.reports.length,0);assert.equal(f.store.db.prepare('SELECT deleted FROM blacklake_output_index').get().deleted,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
}finally{await f.close();}});
test('历史写入回执丢失保留待核对，管理员只读确认并重开，不重复更正',async()=>{const f=await fixture();try{
 const editor=await f.editor();f.driver.setMode('after-write');const saved=await f.change(f.input(editor.body));await f.sync.tick();let job=f.sync.jobs.get(saved.body.sync.id);assert.equal(job.state,'UNKNOWN');assert.equal(f.driver.remote.fineAmount,90);f.advance(300000);await f.sync.tick();assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,1);
 const result=await f.call('/v1/admin/data-sync/jobs/'+job.id+'/reconcile',{admin:true,method:'POST',body:{expectedVersion:f.sync.jobVersion(job)}});assert.equal(result.body.status,'SUCCEEDED',JSON.stringify(result.body));assert.equal((await f.call(f.path)).body.reports[0].goodQuantity,90);assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,1);
}finally{await f.close();}});
test('外部变更或入队后撤销组长权限在写入前阻止覆盖',async()=>{
 for(const mode of ['remote','role']){const f=await fixture();try{const editor=await f.editor(),saved=await f.change(f.input(editor.body));if(mode==='remote'){f.driver.remote.fineAmount=105;f.driver.remote.outputAmount=105;}else f.store.setEntryProfile(101,{appRole:'employee'});await f.sync.tick();assert.equal(f.sync.jobs.get(saved.body.sync.id).state,'FAILED');assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,0);}finally{await f.close();}}
});
test('缓存与确认回执落库后重启只恢复成功，不重新写入历史报工',async()=>{const f=await fixture();try{
 const editor=await f.editor(),input={...f.input(editor.body),goodQuantity:110,defectQuantity:0,defectCodes:[],defectItems:[]},saved=await f.change(input),job=f.sync.jobs.claim();assert.equal(job.id,saved.body.sync.id);
 const service=new UpstreamReports({store:f.store,sync:f.sync,blacklake:f.blacklake,listPeople:async()=>f.people,now:f.now});await service.execute(job);assert.equal(f.sync.jobs.get(job.id).state,'RUNNING');f.advance(121000);await f.sync.tick();assert.equal(f.sync.jobs.get(job.id).state,'SUCCEEDED');assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,1);
}finally{await f.close();}});

test('首次打开历史详情按需同步，缺失历史人员保留原身份，审批中拒绝写入',async()=>{const f=await fixture();try{
 f.store.db.prepare('UPDATE blacklake_output_index SET correction_json=NULL,correction_at=NULL').run();
 const opening=f.editor();await new Promise(resolve=>setTimeout(resolve,50));assert(f.sync.jobs.byKey('read:output:1001'));await f.sync.tick();
 assert.equal((await opening).status,200);assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,0);
 f.people.splice(f.people.findIndex(p=>p.blacklakeOperatorId===201),1);const historical=await f.editor();assert.equal(historical.status,200);assert(historical.body.people.some(p=>p.operatorId===201));
 f.driver.remote.blInApprove=true;const remote=await f.blacklake.readOutputForCorrection('1001',{production:true});f.store.db.prepare('UPDATE blacklake_output_index SET correction_json=?').run(JSON.stringify(remote));
 const blocked=await f.editor();assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,'BLACKLAKE_REPORT_IN_APPROVAL');assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,0);
}finally{await f.close();}});

test('完整方案计算期间权限被撤销也不发出历史更正',async()=>{const f=await fixture();try{
 const editor=await f.editor(),saved=await f.change(f.input(editor.body)),prepare=f.blacklake.prepareOutputCorrection.bind(f.blacklake);
 f.blacklake.prepareOutputCorrection=async(...args)=>{const plan=await prepare(...args);f.store.setEntryProfile(101,{appRole:'employee'});return plan;};
 await f.sync.tick();assert.equal(f.sync.jobs.get(saved.body.sync.id).state,'FAILED');assert.equal(f.driver.calls.filter(c=>c.url.endsWith('/update')).length,0);
}finally{await f.close();}});

test('历史编辑平衡手动工时扣减，允许提高到实际跨度；变更时间不受原报工时刻限制',async()=>{
 for(const seconds of [3000,12000]){const f=await fixture();try{
  f.driver.setMode('recompute-effective');const editor=await f.editor(),input={...f.input(editor.body),durationSeconds:seconds},saved=await f.change(input);
  assert.equal(saved.status,200,JSON.stringify(saved.body));await f.sync.tick();assert.equal(f.sync.jobs.get(saved.body.sync.id).state,'SUCCEEDED');assert.equal(f.driver.remote.effectiveTime,seconds);
  assert.equal(f.driver.remote.planRestTime+f.driver.remote.unplanShutdownTime,12000-seconds);
 }finally{await f.close();}}
 const f=await fixture();try{f.driver.setMode('validate-report-time');const e=await f.editor(),input={...f.input(e.body),startedAt:'2026-11-10 15:00:00',endedAt:'2026-11-10 17:00:00',durationSeconds:7200,punchMinutes:120},saved=await f.change(input);assert.equal(saved.status,200,JSON.stringify(saved.body));await f.sync.tick();assert.equal(f.sync.jobs.get(saved.body.sync.id).state,'SUCCEEDED');assert.equal(f.driver.remote.createdAt,'2026-11-10 17:00:00');}finally{await f.close();}
});
