import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {PeopleGroups} from '../src/people-groups.mjs';
import {AppError} from '../src/errors.mjs';
import {LeaderClockout} from '../src/leader-clockout.mjs';
import {OvernightClockout} from '../src/overnight-clockout.mjs';

async function fixture(){
 const config={sessionSecret:'workspace-isolated-tests-only',sessionDays:30,adminApiKey:'workspace-test-admin',reportingModeAdminOperatorIds:[],agent:{enabled:false},review:{enabled:false},floor8EmployeeIds:[]},store=new Store(':memory:',config);
 const people=[{name:'测试组长甲',blacklakeOperatorId:101,groupNames:['生产']},{name:'测试员工甲',blacklakeOperatorId:102,groupNames:['生产']},{name:'测试员工乙',blacklakeOperatorId:103,groupNames:['生产']},{name:'测试组长乙',blacklakeOperatorId:104,groupNames:['生产']},{name:'授权质检组长',blacklakeOperatorId:3602917,groupNames:['生产']}];
 const operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});store.setEntryProfile(104,{appRole:'floor8_leader'});const tokens=operators.map(o=>store.createSession(o.id).token),outputs=[];
 let at=Date.parse('2026-11-12T00:00:00Z'),serial=0;
 const project={status:'10',priority:0},orderWrites=[];
 const tasks=[11,12,13].map((taskId,i)=>({taskId,projectId:201,projectCode:'2026-TEST-201',productCode:'SKU-ABC',productName:'测试产品',processName:'测试缝制'+i,plannedAmount:100,reportedGoodAmount:0,reportedDefectAmount:0,processStatus:10,processPriority:0}));
 const blacklake={listOperators:async()=>people,listWorkOrderProcesses:async()=>tasks,readWorkOrderDetails:async()=>({projectId:201,projectCode:'2026-TEST-201',productCode:'SKU-ABC',productName:'测试产品',projectStatus:project.status,projectPriority:project.priority,plannedAmount:100,actualAmount:0,unit:'个',productImageUrls:[]}),listWorkOrderCatalog:async()=>[{projectId:201,projectCode:'2026-TEST-201',productCode:'SKU-ABC',productName:'测试产品',projectStatus:project.status}],findWorkOrderProcess:async(_flow,id)=>tasks.find(t=>t.taskId===Number(id)),findTaskById:async id=>tasks.find(t=>t.taskId===Number(id)),createOutput:async input=>{outputs.push(input);return{id:'test-output-'+outputs.length};},nativeRequest:async(path,input)=>{orderWrites.push({path,input});if(path.endsWith('/priority/update')){project.priority=input.priority;if(input.isSyncTask)tasks.forEach(t=>t.processPriority=input.priority);}if(path.endsWith('/finish'))project.status='20';if(path.endsWith('/revert'))project.status=project.status==='20'?'10':'0';if(path.endsWith('/start'))project.status='10';if(blacklake.orderMode==='response-lost')throw Object.assign(Error('response lost'),{code:'BLACKLAKE_TIMEOUT'});return{data:{}};}};
 const server=createServer(createApp({config,store,blacklake,wechat:{},defectReasons:[{code:'D1',name:'测试不良'},{code:'D2',name:'尺寸不良'}],now:()=>at}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(path,{person=0,method='GET',body,key,admin=false}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{Authorization:'Bearer '+tokens[person],'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...(admin?{'X-Admin-Key':config.adminApiKey}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const snapshot=async person=>{const response=await call(person===0||person===3?'/v1/workspace/tasks':'/v1/workspace/worker',{person});assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
 const action=async(action,input,{person=0,key='workspace-operation-'+(++serial),version}={})=>call('/v1/workspace/actions',{person,method:'POST',key,body:{action,input,meta:{expectedVersion:version??(await snapshot(person)).version}}});
 const dispatch=(processId,{person=0,workerId='102',priority='NORMAL'}={})=>action('dispatch',{orderId:201,processId,workerIds:[workerId],placements:[{workerId,unitId:'A-03'}],priority},{person});
 return {store,people,operators,tasks,outputs,blacklake,project,orderWrites,call,snapshot,action,dispatch,at:value=>at=Date.parse(value),close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('黑湖关闭工序后员工能退出本人暂停的自主任务并开始下一单',async()=>{const f=await fixture();try{
 f.store.setSelfServicePermission(102,true,0,'test');f.store.setDispatchUnitRecommendation('A-03',102,'test');
 const first=await f.action('selfStart',{orderId:201,processId:11,unitId:'A-03'},{person:1});
 assert.equal(first.status,200);
 const id=first.body.assignmentId,next=(await f.dispatch(12)).body.assignmentIds[0];
 f.tasks[0].reportedGoodAmount=100;
 f.at('2026-11-12T00:10:00Z');
 assert.equal((await f.call('/v1/assignments/'+id+'/pause',{person:1,method:'POST',key:'worker-pause-self-test',body:{expectedRevision:0}})).status,200);
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:id},{person:1})).status,409);
 f.tasks[0].processStatus=null;
 f.at('2026-11-12T00:15:00Z');
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:id},{person:1})).status,409);
 f.at('2026-11-12T00:20:00Z');
 f.tasks[0].processStatus=20;
 const blocked=await f.action('end',{assignmentId:id},{person:1});
 assert.equal(blocked.status,409);assert.match(blocked.body.error.message,/工单或工序已关闭/);
 const closed=await f.snapshot(1);
 assert.equal(closed.assignments.find(task=>task.id===id).canExitClosedSelfTask,true);
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:id},{person:2})).status,403);
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:next},{person:1})).status,403);
 const exitOptions={person:1,version:closed.version,key:'worker-closed-self-exit-test'};
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:id},exitOptions)).status,200);
 assert.equal((await f.action('exitClosedSelfTask',{assignmentId:id},exitOptions)).body.replayed,true);
 assert.equal(f.store.assignmentById(id).status,'CANCELLED');
 assert.equal(f.store.assignmentById(id).durationSeconds,600);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(id).n,0);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM assignment_actions WHERE assignment_id=? AND action='SELF_TASK_EXITED_CLOSED'").get(id).n,1);
 assert.equal(f.outputs.length,0);
 assert.equal((await f.action('start',{assignmentId:next},{person:1})).status,200);
}finally{await f.close();}});

test('员工可跳过确认关闭的队首派工并开始下一单',async()=>{const f=await fixture();try{
 const closed=(await f.dispatch(11)).body.assignmentIds[0],next=(await f.dispatch(12)).body.assignmentIds[0];
 f.tasks[0].processStatus=20;
 f.at('2026-11-12T00:01:00Z');
 const state=await f.snapshot(1);
 assert.equal(state.assignments.find(row=>row.id===closed).canSkipClosedAssignment,true);
 assert.equal(state.assignments.find(row=>row.id===next).canStart,false);
 assert.equal((await f.action('skipClosedAssignment',{assignmentId:closed},{person:2})).status,403);
 f.tasks[0].processStatus=10;
 assert.equal((await f.action('skipClosedAssignment',{assignmentId:closed},{person:1})).status,409);
 assert.equal(f.store.assignmentById(closed).status,'READY');
 f.tasks[0].processStatus=20;
 const options={person:1,version:state.version,key:'worker-skip-closed-dispatch'};
 assert.equal((await f.action('skipClosedAssignment',{assignmentId:closed},options)).status,200);
 assert.equal((await f.action('skipClosedAssignment',{assignmentId:closed},options)).body.replayed,true);
 const skipped=f.store.assignmentById(closed);
 assert.equal(skipped.status,'CANCELLED');
 assert.equal(skipped.startedAt,null);
 assert.equal(skipped.reportId,null);
 assert.equal((await f.action('start',{assignmentId:next},{person:1})).status,200);
 assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('指定小组按员工归属手填报工数量，计划数仍保留，同一组长派给其他员工时仍可预填',async()=>{const f=await fixture();try{
 const groups=new PeopleGroups(f.store.db);
 groups.save([{id:'dept-836f3b4d8b271aa34e48',name:'测试剪线组',blacklakeOperatorIds:[102],leaderIds:[101]}],0,'test');
 f.tasks[0].reportedGoodAmount=12;f.tasks[1].reportedGoodAmount=42;
 const member=(await f.dispatch(11,{person:3})).body.assignmentIds[0],other=(await f.dispatch(12,{person:3,workerId:'103'})).body.assignmentIds[0];
 for(const [id,person] of [[member,1],[other,2]]){
  assert.equal((await f.action('start',{assignmentId:id},{person})).status,200);
  const defaults=await f.call('/v1/assignments/'+id+'/finish-default',{person});
  assert.equal(defaults.body.defaultQuantity,person===1?null:58);
  assert.equal((await f.action('end',{assignmentId:id},{person})).status,200);
 }
 const memberView=(await f.snapshot(1)).assignments.find(task=>task.id===member);
 assert.equal(memberView.canConfirmQuantity,true);assert.equal(memberView.processPlanQuantity,null);assert.equal(memberView.reportRemainingQuantity,88);assert.equal(memberView.orderInfo.planQuantity,100);
 assert.equal((await f.snapshot(2)).assignments.find(task=>task.id===other).processPlanQuantity,58);
 assert.equal((await f.snapshot(3)).assignments.find(task=>task.id===member).processPlanQuantity,100);
 const path='/v1/assignments/'+member+'/finish';
 const defaults=await f.call(path+'-default',{person:1});
 assert.equal(defaults.status,200);assert.equal(defaults.body.defaultQuantity,null);assert.equal(defaults.body.targetQuantity,100);
 const key='workspace-explicit-quantity';
 const submit=body=>f.call(path,{person:1,method:'POST',key,body});
 assert.equal((await submit({})).body.error.code,'REPORT_QUANTITY_REQUIRED');
 assert.equal((await submit({quantity:''})).status,422);assert.equal(f.outputs.length,0);
 const done=await submit({quantity:17});assert.equal(done.status,201,JSON.stringify(done.body));
 assert.equal(done.body.report.goodAmount,17);assert.equal(done.body.pendingGroupApproval,true);
 assert.equal(done.body.assignment.status,'COMPLETED');assert.equal(f.outputs.length,0);
 assert.equal((await submit({quantity:17})).body.replayed,true);assert.equal(f.outputs.length,0);
 groups.save([{id:'dept-836f3b4d8b271aa34e48',name:'调整后的组名',blacklakeOperatorIds:[103],leaderIds:[101]}],1,'test');
 assert.equal((await f.call('/v1/assignments/'+other+'/finish-default',{person:2})).body.defaultQuantity,null);
 groups.save([{id:'dept-836f3b4d8b271aa34e48',name:'调整后的组名',blacklakeOperatorIds:[102],leaderIds:[101]}],2,'test');
 const ordinary=await f.call('/v1/assignments/'+other+'/finish',{person:2,method:'POST',key:'workspace-ordinary-report',body:{quantity:23}});
 assert.equal(ordinary.status,201,JSON.stringify(ordinary.body));assert.equal(ordinary.body.pendingGroupApproval,undefined);
 assert.equal(f.outputs[0].amount,23);
}finally{await f.close();}});

test('组长代启停保留员工计时版本、幂等回执和归属',async()=>{const f=await fixture();try{
 const groups=new PeopleGroups(f.store.db);
 groups.save([{id:'team',name:'测试班组',blacklakeOperatorIds:[102],leaderIds:[101,104]}],0,'test');
 const id=(await f.dispatch(11)).body.assignmentIds[0],queued=(await f.dispatch(12)).body.assignmentIds[0],outside=(await f.dispatch(11,{workerId:'103'})).body.assignmentIds[0];
 const item=async(person,taskId=id)=>(await f.snapshot(person)).assignments.find(row=>row.id===taskId);
 assert.equal((await item(0)).leaderTimerAction,'leaderStartTimer');assert.equal((await item(0,queued)).leaderTimerDisabled,true);
 assert.equal((await item(0,outside)).leaderTimerAction,null);
 for(const [person,taskId] of [[1,id],[3,id],[0,outside]])assert.equal((await f.action('leaderStartTimer',{assignmentId:taskId},{person})).status,403);
 assert.equal((await f.action('leaderStartTimer',{assignmentId:queued})).status,409);
 assert.equal((await f.action('leaderStartTimer',{assignmentId:id})).status,200);
 f.at('2026-11-12T00:10:00Z');
 const pause={key:'leader-timer-pause-test',version:(await f.snapshot(0)).version};
 assert.equal((await f.action('leaderPauseTimer',{assignmentId:id},pause)).status,200);
 assert.equal((await f.action('leaderPauseTimer',{assignmentId:id},pause)).body.replayed,true);
 assert.equal((await item(1)).timerPauseSource,'leader');assert.equal((await item(1)).timingRevision,1);
 assert.equal((await f.action('leaderStartTimer',{assignmentId:id},{version:pause.version})).body.error.code,'WORKSPACE_VERSION_CHANGED');
 f.at('2026-11-12T00:20:00Z');
 assert.equal((await f.action('leaderStartTimer',{assignmentId:id})).status,200);
 assert.equal((await item(1)).timerPaused,false);assert.equal((await item(1)).timingRevision,2);assert.equal((await item(1)).elapsedSeconds,600);
 assert.equal(f.store.assignmentById(id).publishedByOperatorId,101);assert.equal(f.store.assignmentById(id).operatorId,f.operators[1].id);
 const audits=f.store.db.prepare("SELECT action,actor FROM assignment_actions WHERE assignment_id=? AND action LIKE 'LEADER_%' ORDER BY id").all(id);
 assert.deepEqual(audits.map(row=>[row.action,row.actor]),[['LEADER_START','floor8_leader:101'],['LEADER_PAUSE_TIMER','floor8_leader:101'],['LEADER_RESUME_TIMER','floor8_leader:101']]);
 f.at('2026-11-12T00:30:00Z');assert.equal((await f.action('end',{assignmentId:id},{person:1})).status,200);
 assert.equal((await f.action('leaderPauseTimer',{assignmentId:id})).status,409);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('派工预检按员工给出拦截原因，显式确认可派人员并忽略无关员工开工',async()=>{const f=await fixture();try{
 const busy=(await f.dispatch(11,{person:3,workerId:'103'})).body.assignmentIds[0];
 await f.action('start',{assignmentId:busy},{person:2});
 const both={orderId:201,processId:12,workerIds:['102','103'],placements:[{workerId:'102',unitId:'A-03'},{workerId:'103',unitId:'A-03'}],priority:'URGENT'};
 const preview=input=>f.call('/v1/workspace/preview',{method:'POST',body:input});
 const confirm=(input,plan,serial)=>f.call('/v1/workspace/actions',{method:'POST',key:'dispatch-scoped-test-'+serial,body:{action:'dispatch',input,meta:{expectedVersion:plan.version,dispatchVersion:plan.dispatchVersion}}});
 const mixed=await preview(both);assert.equal(mixed.status,200);assert.deepEqual(mixed.body.workerIds,['102']);
 assert.equal(mixed.body.blocked[0].workerId,'103');assert.match(mixed.body.blocked[0].reason,/其他组长/);assert.equal(mixed.body.blocked[0].orderCode,'2026-TEST-201');
 assert.deepEqual((await preview({...both,priority:'NORMAL'})).body.workerIds,['102','103']);
 const only={...both,workerIds:['102'],placements:[both.placements[0]]};
 await f.action('end',{assignmentId:busy},{person:2});
 const ordinary=await preview({...both,priority:'NORMAL'});assert.deepEqual(ordinary.body.workerIds,['102']);assert.match(ordinary.body.blocked[0].reason,/确认数量/);
 assert.equal((await confirm(both,mixed.body,'reject-extra')).status,409);
 const outcome=await confirm(only,mixed.body,'eligible');assert.equal(outcome.status,200,JSON.stringify(outcome.body));assert.equal(outcome.body.assignmentIds.length,1);
 assert.equal((await confirm(only,mixed.body,'eligible')).body.replayed,true);
 assert.equal((await f.snapshot(2)).assignments.find(task=>task.id===busy).status,'AWAITING_QUANTITY');
 const another={...only,processId:13,priority:'NORMAL'},next=await preview(another);
 await f.action('start',{assignmentId:outcome.body.assignmentIds[0]},{person:1});
 assert.equal((await confirm(another,next.body,'selected-changed')).body.error.code,'WORKSPACE_DISPATCH_CHANGED');
 const now=await preview(another);f.tasks[2].processStatus=20;
 assert.equal((await confirm(another,now.body,'process-closed')).status,409);
 assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('超过 2000 条完结历史仍能看当前任务、派工和分页找旧记录',async()=>{const f=await fixture();try{
 const first=(await f.dispatch(11)).body.assignmentIds[0];
 const columns=f.store.db.prepare('PRAGMA table_info(assignments)').all().map(row=>row.name);
 const values=columns.map(name=>({id:"'closed-history-'||printf('%05d',n)",status:"'COMPLETED'",ended_at:"'2026-11-15 18:00:00'"})[name]||'a.'+name);
 f.store.db.prepare(`WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<2005) INSERT INTO assignments(${columns.join(',')}) SELECT ${values.join(',')} FROM assignments a CROSS JOIN history WHERE a.id=?`).run(first);
 const view=await f.snapshot(0);assert(view.assignments.some(row=>row.id===first&&row.status==='READY'));
 const latest=await f.call('/v1/workspace/assignment-history?start=2026-11-15&end=2026-11-15');assert.equal(latest.status,200);assert.equal(latest.body.assignments.length,80);assert.equal(latest.body.hasMore,true);
 const old=await f.call('/v1/workspace/assignment-history?page=26');assert.equal(old.body.assignments.length,5);assert.equal(old.body.hasMore,false);
 assert.equal((await f.call('/v1/workspace/assignment-history',{person:1})).status,403);
 const input={orderId:201,processId:12,workerIds:['102'],placements:[{workerId:'102',unitId:'A-03'}],priority:'NORMAL'};
 const plan=await f.call('/v1/workspace/preview',{method:'POST',body:input});assert.equal(plan.status,200);
 const sent=await f.call('/v1/workspace/actions',{method:'POST',key:'dispatch-history-safe',body:{action:'dispatch',input,meta:{expectedVersion:plan.body.version,dispatchVersion:plan.body.dispatchVersion}}});assert.equal(sent.status,200,JSON.stringify(sent.body));
}finally{await f.close();}});

test('凌晨补暂停通过正式工作台显示系统暂停，员工可自行开始和结束且保留队列',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});
 const next=(await f.dispatch(12)).body.assignmentIds[0];const leaderClockout=new LeaderClockout({store:f.store});
 f.store.db.prepare('INSERT INTO leader_clockout_runs VALUES(?,?,?,?,?,?,?)').run('overnight-workspace-reference',101,'manual','SUCCEEDED',null,'2026-11-12 18:00:00','{}');
 const overnight=new OvernightClockout({store:f.store,leaderClockout,now:()=>Date.parse('2026-11-13T02:00:10+08:00')});
 f.at('2026-11-13T02:00:10+08:00');assert.equal(overnight.runDue().pausedCount,1);
 let snapshot=await f.snapshot(1),task=snapshot.assignments.find(row=>row.id===id);assert.equal(task.timerPauseSource,'overnight');assert.equal(task.timerPaused,true);assert.equal(task.canResumeTimer,true);assert.equal(task.status,'IN_PROGRESS');assert.equal(task.elapsedSeconds,8.5*3600);assert.equal(f.outputs.length,0);
 f.at('2026-11-13T08:00:00+08:00');const resumed=await f.call('/v1/assignments/'+id+'/resume',{person:1,method:'POST',key:'workspace-overnight-employee-resume',body:{expectedRevision:task.timingRevision}});assert.equal(resumed.status,200,JSON.stringify(resumed.body));
 snapshot=await f.snapshot(1);task=snapshot.assignments.find(row=>row.id===id);assert.equal(task.timerPaused,false);assert.equal(snapshot.assignments.find(row=>row.id===next).status,'READY');
 f.at('2026-11-13T09:00:00+08:00');const ended=await f.action('end',{assignmentId:id},{person:1});assert.equal(ended.status,200,JSON.stringify(ended.body));assert.equal(f.store.assignmentById(id).durationSeconds,9.5*3600);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('组长工序详情可跨派工人管理报工，普通员工保持只读',async()=>{const f=await fixture();try{
 const dispatched=await f.dispatch(11),id=dispatched.body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});f.at('2026-11-12T01:00:00Z');await f.action('end',{assignmentId:id},{person:1});await f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'leader-process-finish',body:{quantity:100,defectQuantity:0}});
 const reportId=f.store.assignmentById(id).reportId,path='/v1/workspace/process-reports/201/11',list=await f.call(path);assert.equal(list.status,200);assert.equal(list.body.permission,'all-process-reports');assert.equal(list.body.reports[0].id,reportId);assert.equal(list.body.reports[0].canEdit,true);assert.equal(list.body.reports[0].canDelete,true);assert.equal('assignments'in list.body,false);
 const other=await f.call(path,{person:3});assert.equal(other.body.reports[0].canEdit,true);assert.equal(other.body.reports[0].canDelete,true);
 const worker=await f.call(path,{person:1});assert.equal(worker.body.reports[0].canEdit,false);assert.equal((await f.call(path+'/'+reportId+'/editor',{person:1})).status,403);assert.equal((await f.call(path+'/'+reportId+'/delete',{person:1,method:'POST',key:'worker-forbidden-delete',body:{expectedVersion:'x'}})).status,403);
}finally{await f.close();}});

test('质检组长可跨组长和自主任务修改删除，普通质检拒绝、归属不被改写',async()=>{const f=await fixture();try{
 f.store.setQualityProfile(102,'quality',0,'test');f.store.setQualityProfile(102,'quality_leader',1,'test');assert.equal(f.store.isQualityOperator(f.operators[1].id),true);
 const id=(await f.dispatch(11,{person:3,workerId:'103'})).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:2});f.at('2026-11-12T00:10:00Z');await f.action('end',{assignmentId:id},{person:2});await f.call('/v1/assignments/'+id+'/finish',{person:2,method:'POST',key:'quality-target-finish',body:{quantity:12,defectQuantity:0,defectCodes:[]}});
 const row=f.store.assignmentById(id),reportId=row.reportId,base='/v1/workspace/process-reports/201/11/'+reportId;
 let remote={id:row.blacklakeOutputId||'test-output-1',projectId:201,projectProcessId:11,operatorId:103,fineAmount:12,defectsAmount:0,defectCodes:[],startedAt:row.startedAt,endedAt:row.endedAt,customFieldValues:[]},deleted=false;
 f.blacklake.supportsFullReportCorrection=true;f.blacklake.readOutputForCorrection=async()=>{if(deleted)throw Object.assign(Error('deleted'),{definiteAbsence:true});return structuredClone(remote);};
 f.blacklake.updateOutputConfirmed=async(_,input)=>{remote={...remote,fineAmount:input.goodAmount,defectsAmount:input.defectAmount,defectCodes:input.defectCodes,defectItems:input.defectItems||[]};};f.blacklake.deleteOutputConfirmed=async()=>{deleted=true;};
 let list=await f.call('/v1/workspace/process-reports/201/11',{person:1});assert.equal(list.body.canEditReports,true);assert.equal(list.body.reports[0].canDelete,true);
 assert.equal((await f.call(base+'/editor',{person:2})).status,403);assert.equal((await f.call(base.replace('/201/','/999/')+'/editor',{person:1})).status,404);
 let editor=await f.call(base+'/editor',{person:1});assert.equal(editor.status,200,JSON.stringify(editor.body));
 const changed=await f.call(base+'/edit',{person:1,method:'POST',key:'quality-cross-owner-edit',body:{expectedVersion:editor.body.report.version,goodQuantity:11,defectQuantity:0,defectCodes:[]}});assert.equal(changed.body.status,'SUCCEEDED',JSON.stringify(changed.body));assert.equal(remote.fineAmount,11);
 assert.equal(f.store.assignmentById(id).publishedByOperatorId,104);assert.equal(f.store.assignmentById(id).operatorId,f.operators[2].id);
 editor=await f.call(base+'/editor',{person:1});const result=await f.call(base+'/delete',{person:1,method:'POST',key:'quality-cross-owner-delete',body:{expectedVersion:editor.body.report.version}});assert.equal(result.body.status,'SUCCEEDED',JSON.stringify(result.body));assert.equal(deleted,true);assert.equal((await f.call('/v1/workspace/process-reports/201/11',{person:1})).body.reports.length,0);
 f.store.setQualityProfile(102,'quality',2,'test');assert.equal((await f.call(base+'/editor',{person:1})).status,403);
}finally{await f.close();}});

test('员工只开始组长排到当前的任务，累计工时与核量锁保持',async()=>{const f=await fixture();try{
 const first=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:first},{person:1});f.at('2026-11-12T00:10:00Z');const urgent=(await f.dispatch(12,{priority:'URGENT'})).body.assignmentIds[0];await f.action('start',{assignmentId:urgent},{person:1});
 f.at('2026-11-12T00:15:00Z');assert.equal((await f.action('start',{assignmentId:first},{person:1})).status,409);assert.equal((await f.action('insertAssignment',{assignmentId:first})).status,200);assert.equal((await f.action('start',{assignmentId:first},{person:1})).status,200);let snap=await f.snapshot(1);assert.equal(snap.assignments.filter(t=>t.status==='IN_PROGRESS').length,1);assert.equal(snap.assignments.find(t=>t.isEmployeeCurrent).id,first);assert.equal(snap.assignments.find(t=>t.id===urgent).status,'PAUSED');assert.equal(snap.assignments.find(t=>t.id===first).elapsedSeconds,600);
 assert.equal((await f.action('start',{assignmentId:urgent},{person:2})).status,409);f.at('2026-11-12T00:20:00Z');await f.action('end',{assignmentId:first},{person:1});assert.equal((await f.action('start',{assignmentId:urgent},{person:1})).status,409);assert.equal(f.store.assignmentById(first).durationSeconds,900);
}finally{await f.close();}});

test('正式扫码读取未加载工单，二维码和唯一条码归属核验、模糊匹配不误开工',async()=>{const f=await fixture();try{
 for(const flowCode of ['projectId=201','https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=201','SKU-ABC']){const response=await f.call('/v1/workspace/scan',{person:1,method:'POST',body:{flowCode}});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.order.id,201);}
 assert.equal((await f.call('/v1/workspace/scan',{method:'POST',body:{flowCode:'SKU'}})).status,422);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('黑湖工单尚无工序仍显示完整资料，空工序不误报归属错误或允许派工',async()=>{const f=await fixture();try{
 f.tasks.splice(0);
 const detail=await f.call('/v1/orders/201');assert.equal(detail.status,200,JSON.stringify(detail.body));assert.equal(detail.body.order.id,201);assert.equal(detail.body.order.code,'2026-TEST-201');assert.deepEqual(detail.body.order.processes,[]);
 const processes=await f.call('/v1/orders/201/processes');assert.equal(processes.status,200);assert.deepEqual(processes.body.processes,[]);assert.equal(processes.body.complete,true);
 assert.equal((await f.call('/v1/workspace/scan',{method:'POST',body:{flowCode:'SKU-ABC'}})).status,200);
 assert.equal((await f.dispatch(11)).status,409);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);
}finally{await f.close();}});

test('空工序回退仍精确核对工单身份，返回他单工序不能绕过校验',async()=>{const f=await fixture();try{
 f.tasks[0].projectId=999;
 const wrongTasks=await f.call('/v1/orders/201');assert.equal(wrongTasks.status,502);assert.equal(wrongTasks.body.error.code,'WORKSPACE_ORDER_MISMATCH');
 f.tasks.splice(0);const missing=await f.call('/v1/orders/999');assert.equal(missing.status,404);
}finally{await f.close();}});

test('原版新工作台：真实SQLite派工、员工开始/结束/返回、原提交链路只上报一次',async()=>{const f=await fixture();try{
 const created=await f.dispatch(11);assert.equal(created.status,200,JSON.stringify(created.body));const id=created.body.assignmentIds[0];assert.equal(f.store.assignmentById(id).status,'READY');
 const snapshot=await f.snapshot(1);assert.equal(snapshot.assignments[0].canStart,true);assert.equal(snapshot.source,'workspace-live');assert.equal(snapshot.sources.assignments,'local_sqlite');
 f.at('2026-11-12T00:05:00Z');assert.equal((await f.action('start',{assignmentId:id},{person:1})).status,200);f.at('2026-11-12T00:15:00Z');assert.equal((await f.action('end',{assignmentId:id},{person:1})).status,200);assert.equal((await f.snapshot(1)).assignments[0].status,'AWAITING_QUANTITY');assert.equal(f.outputs.length,0);
 f.at('2026-11-12T00:20:00Z');assert.equal((await f.action('cancelEnd',{assignmentId:id},{person:1})).status,200);f.at('2026-11-12T00:25:00Z');assert.equal((await f.action('end',{assignmentId:id},{person:1})).status,200);
 const result=await f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'workspace-real-finish-once',body:{quantity:70,defectQuantity:0,defectCodes:[]}});assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(f.outputs.length,1);assert.equal(f.store.assignmentById(id).durationSeconds,900);assert.equal(f.store.assignmentById(id).status,'COMPLETED');
}finally{await f.close();}});

test('原版新工作台：插单暂停项排到当前后员工自行开始，无需组长启动并保留累计工时',async()=>{const f=await fixture();try{
 const first=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:first},{person:1});f.at('2026-11-12T00:10:00Z');const next=await f.dispatch(12,{priority:'URGENT'});assert.equal(next.status,200,JSON.stringify(next.body));assert.equal(f.store.assignmentById(first).status,'PAUSED');
 let snap=await f.snapshot(1);assert.equal(snap.assignments.find(t=>t.isEmployeeCurrent).id,next.body.assignmentIds[0]);assert.equal(snap.assignments.find(t=>t.id===first).elapsedSeconds,600);
 assert.equal((await f.action('start',{assignmentId:first},{person:1})).status,409);f.at('2026-11-12T00:20:00Z');assert.equal((await f.action('insertAssignment',{assignmentId:first})).status,200);assert.equal((await f.action('start',{assignmentId:first},{person:1})).status,200);
 snap=await f.snapshot(1);assert.equal(snap.assignments.find(t=>t.id===first).canFinish,true);assert.equal(snap.assignments.find(t=>t.id===first).elapsedSeconds,600);f.at('2026-11-12T00:25:00Z');assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===first).elapsedSeconds,900);assert.equal(f.store.assignmentById(first).startedAt,'2026-11-12 08:00:00');assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('员工计时暂停后组长可插入现有任务，排回原单自行开始且暂停不重复计时',async()=>{const f=await fixture();try{
 const first=(await f.dispatch(11)).body.assignmentIds[0],second=(await f.dispatch(12)).body.assignmentIds[0];await f.action('start',{assignmentId:first},{person:1});
 f.at('2026-11-12T00:10:00Z');const paused=await f.call('/v1/assignments/'+first+'/pause',{person:1,method:'POST',key:'employee-pause-before-insert-01',body:{expectedRevision:0}});assert.equal(paused.status,200,JSON.stringify(paused.body));
 f.at('2026-11-12T00:20:00Z');const inserted=await f.action('insertAssignment',{assignmentId:second});assert.equal(inserted.status,200,JSON.stringify(inserted.body));
 assert.equal(f.store.assignmentById(first).status,'PAUSED');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(first).n,1);
 const employeePause=f.store.db.prepare("SELECT started_at,ended_at FROM assignment_pauses WHERE assignment_id=? AND source='employee'").get(first);assert.equal(employeePause.started_at,'2026-11-12 08:10:00');assert.equal(employeePause.ended_at,null,'manual timer pause remains independent from queue interruption');
 assert.equal((await f.snapshot(1)).assignments.find(t=>t.isEmployeeCurrent).id,second);assert.equal((await f.action('start',{assignmentId:second},{person:1})).status,200);
 f.at('2026-11-12T00:30:00Z');assert.equal((await f.action('insertAssignment',{assignmentId:first})).status,200);const ready=(await f.snapshot(1)).assignments.find(t=>t.id===first);assert.equal(ready.canStart,true);assert.equal(ready.elapsedSeconds,600);
 assert.equal((await f.action('start',{assignmentId:first},{person:1})).status,200);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(first).n,0);
 f.at('2026-11-12T00:35:00Z');assert.equal((await f.action('end',{assignmentId:first},{person:1})).status,200);assert.equal(f.store.assignmentById(first).durationSeconds,900);assert.equal(f.store.assignmentById(first).startedAt,'2026-11-12 08:00:00');assert.equal(f.outputs.length,0);
 }finally{await f.close();}});

test('员工已暂停时加急新派工和队列切换均不产生两个未结束暂停',async()=>{for(const mode of ['urgent','reorder']){const f=await fixture();try{
 const first=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:first},{person:1});
 const second=mode==='reorder'?(await f.dispatch(12)).body.assignmentIds[0]:null;
 f.at('2026-11-12T00:10:00Z');assert.equal((await f.call('/v1/assignments/'+first+'/pause',{person:1,method:'POST',key:'employee-pause-switch-'+mode,body:{expectedRevision:0}})).status,200);
 f.at('2026-11-12T00:20:00Z');const switched=mode==='urgent'?await f.dispatch(12,{priority:'URGENT'}):await f.action('reorderQueue',{workerId:'102',assignmentIds:[second,first]});assert.equal(switched.status,200,JSON.stringify(switched.body));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(first).n,1);assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===first).elapsedSeconds,600);assert.equal(f.outputs.length,0);
 }finally{await f.close();}}});

test('一键下班暂停后可插单，组长恢复任务仍保留计时暂停，由员工自行继续',async()=>{const f=await fixture();try{
 new PeopleGroups(f.store.db).save([{id:'team-a',name:'甲组',blacklakeOperatorIds:[102],leaderIds:[101]}],0,'test');
 const first=(await f.dispatch(11)).body.assignmentIds[0],second=(await f.dispatch(12)).body.assignmentIds[0];await f.action('start',{assignmentId:first},{person:1});
 f.at('2026-11-12T00:10:00Z');const preview=await f.call('/v1/dispatch/clock-out');assert.equal((await f.call('/v1/dispatch/clock-out',{method:'POST',key:'clockout-before-urgent-insert',body:{expectedVersion:preview.body.version}})).status,200);
 f.at('2026-11-12T00:20:00Z');const version=(await f.snapshot(0)).version,options={key:'same-clockout-insert-operation',version};const inserted=await f.action('insertAssignment',{assignmentId:second},options);assert.equal(inserted.status,200,JSON.stringify(inserted.body));assert.equal((await f.action('insertAssignment',{assignmentId:second},options)).body.replayed,true);
 const old=(await f.snapshot(1)).assignments.find(t=>t.id===first);assert.equal(old.timerPauseSource,'clockout');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(first).n,1);
 assert.equal((await f.action('cancelAssignment',{assignmentId:second})).status,200);f.at('2026-11-12T00:30:00Z');assert.equal((await f.action('resume',{assignmentId:first})).status,200);
 let task=(await f.snapshot(1)).assignments.find(t=>t.id===first);assert.equal(task.timerPaused,true);assert.equal(task.timerPauseSource,'clockout');assert.equal(task.elapsedSeconds,600);
 f.at('2026-11-12T00:35:00Z');assert.equal((await f.call('/v1/assignments/'+first+'/resume',{person:1,method:'POST',key:'employee-resume-after-queue',body:{expectedRevision:task.timingRevision}})).status,200);
 f.at('2026-11-12T00:40:00Z');assert.equal((await f.action('end',{assignmentId:first},{person:1})).status,200);assert.equal(f.store.assignmentById(first).durationSeconds,900);assert.equal(f.outputs.length,0);
 }finally{await f.close();}});

test('原版新工作台：跨组长和员工越权、陈旧版本及关闭工序无部分写入',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0],state=await f.snapshot(0),before=f.store.db.prepare('SELECT * FROM assignments').all();
 assert.equal((await f.action('cancelAssignment',{assignmentId:id},{person:3})).status,409);assert.equal((await f.action('insertAssignment',{assignmentId:id},{person:1})).status,409);
 assert.equal((await f.action('reorderQueue',{workerId:'102',assignmentIds:[id]},{version:state.version+1})).status,409);
 f.tasks[0].processStatus=20;assert.equal((await f.action('start',{assignmentId:id},{person:1})).status,409);assert.deepEqual(f.store.db.prepare('SELECT * FROM assignments').all(),before);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('原版新工作台：幂等重发不重复派工，未知上游和未实现写入不伪成功',async()=>{const f=await fixture();try{
 const snapshot=await f.snapshot(0),input={orderId:201,processId:11,workerIds:['102'],placements:[{workerId:'102',unitId:'A-03'}],priority:'NORMAL'},meta={key:'workspace-replay-same-key',version:snapshot.version};
 const first=await f.action('dispatch',input,meta),again=await f.action('dispatch',input,meta);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(again.body.replayed,true);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,1);
 assert.equal((await f.action('restoreReport',{reportId:'missing'})).status,422);assert.equal((await f.action('updateOrder',{orderId:201,status:'FINISHED'})).status,422);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('原版新工作台：旧派工入口遵守工单处理中与待核对锁，整批原子拒绝',async()=>{const f=await fixture();try{
 await f.snapshot(0);
 const assignment=(id,projectId,operatorIndex)=>({id,operatorId:f.operators[operatorIndex].id,taskId:11,projectId,projectCode:'TEST-'+projectId,productName:'测试产品',processName:'查片',quantity:100,stationName:'A-03',publishedByOperatorId:101,publishedAt:'2026-11-12 08:00:00',flowCodeHash:'test'});
 f.store.db.prepare("INSERT INTO workspace_order_operations(actor,operation_id,order_id,request_hash,status,before_json,target_json,created_at,updated_at) VALUES('test','lock',201,'hash','PENDING','{}','{}','now','now')").run();
 for(const status of ['PENDING','UNKNOWN']){
  f.store.db.prepare("UPDATE workspace_order_operations SET status=? WHERE operation_id='lock'").run(status);
  assert.throws(()=>f.store.dispatchAssignments([assignment('allowed-first',202,2),assignment('locked-second',201,1)],{allowQueue:true}),error=>error.code==='WORKSPACE_ORDER_RESULT_UNKNOWN');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);
 }
 f.store.db.prepare("UPDATE workspace_order_operations SET status='SUCCEEDED' WHERE operation_id='lock'").run();
 assert.equal(f.store.dispatchAssignment(assignment('unlocked',201,1),{allowQueue:true}).id,'unlocked');
}finally{await f.close();}});

test('原版新工作台：编号、SKU、产品名模糊查找及鉴权边界',async()=>{const f=await fixture();try{
 for(const value of ['TEST','sku ab','测试产品']){const response=await f.call('/v1/orders?projectCode='+encodeURIComponent(value));assert.equal(response.status,200);assert.equal(response.body.orders.length,1);assert.equal(response.body.scope.globalHistory,false);}
 const response=await f.call('/v1/workspace/tasks',{person:1});assert.equal(response.body.canManage,false);
}finally{await f.close();}});

test('原版新工作台：当前首项结束后可返回计时，后方加急单不能误拦',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});await f.dispatch(12,{priority:'URGENT'});await f.action('insertAssignment',{assignmentId:id});await f.action('start',{assignmentId:id},{person:1});await f.action('end',{assignmentId:id},{person:1});
 assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===id).canReturnToWork,true);assert.equal((await f.action('cancelEnd',{assignmentId:id},{person:1})).status,200);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('原版新工作台：自主质检逐项不良精确传给原提交链路，撤销不产生报工',async()=>{const f=await fixture();try{
 f.store.setSelfServicePermission(102,true,0,'test');f.store.setDispatchUnitRecommendation('A-03',102,'test');f.tasks[2].processName='质检';
 const first=await f.action('selfStart',{orderId:201,processId:13,unitId:'A-03'},{person:1});assert.equal(first.status,200,JSON.stringify(first.body));const id=first.body.assignmentId;assert.equal(f.store.assignmentById(id).isQualityInspection,true);
 await f.action('end',{assignmentId:id},{person:1});assert.equal((await f.action('cancelSelfReport',{assignmentId:id},{person:1})).status,200);assert.equal(f.outputs.length,0);
 const second=await f.action('selfStart',{orderId:201,processId:13,unitId:'A-03'},{person:1});await f.action('end',{assignmentId:second.body.assignmentId},{person:1});
 const input={quantity:95,defectQuantity:5,defectCodes:['D1','D2'],defectItems:[{code:'D1',amount:4},{code:'D2',amount:1}]},result=await f.call('/v1/assignments/'+second.body.assignmentId+'/finish',{person:1,method:'POST',key:'workspace-self-defects-once',body:input});
 assert.equal(result.status,201,JSON.stringify(result.body));assert.deepEqual(f.outputs[0].defectItems,input.defectItems);const snapshot=await f.snapshot(1);assert.deepEqual(snapshot.assignments.find(t=>t.id===second.body.assignmentId).reports[0].defectItems,[{code:'D1',quantity:4},{code:'D2',quantity:1}]);
}finally{await f.close();}});

test('原版新工作台：午休与暂停按原净工时统计，开始前和核量等待不增长',async()=>{const f=await fixture();try{
 f.at('2026-11-12T03:30:00Z');const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});f.at('2026-11-12T04:30:00Z');assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===id).elapsedSeconds,1800);
 f.at('2026-11-12T05:45:00Z');assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===id).elapsedSeconds,2700);await f.action('end',{assignmentId:id},{person:1});f.at('2026-11-12T06:00:00Z');assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===id).elapsedSeconds,2700);
}finally{await f.close();}});

test('原版新工作台：工序记录可见本系统其他员工，个人记录保持本人范围',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11,{workerId:'103'})).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:2});await f.action('end',{assignmentId:id},{person:2});await f.call('/v1/assignments/'+id+'/finish',{person:2,method:'POST',key:'workspace-other-worker-finish',body:{quantity:12,defectQuantity:0,defectCodes:[]}});
 const process=await f.call('/v1/workspace/process-reports/201/11',{person:1});assert.equal(process.status,200,JSON.stringify(process.body));assert.equal(process.body.reports[0].productionWorkerName,'测试员工乙');assert.equal(process.body.reports[0].canEdit,false);assert.equal(process.body.reports[0].canDelete,false);assert.equal((await f.snapshot(1)).assignments.length,0);
}finally{await f.close();}});

test('原版新工作台：上游报工结果未知保留NEEDS_REVIEW，禁止第二次提交',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});await f.action('end',{assignmentId:id},{person:1});let attempts=0;f.blacklake.createOutput=async()=>{attempts++;throw new AppError(504,'BLACKLAKE_TIMEOUT','timeout');};
 const finish=()=>f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'workspace-unknown-finish',body:{quantity:12,defectQuantity:0,defectCodes:[]}});assert.equal((await finish()).status,504);assert.equal((await finish()).status,409);assert.equal(attempts,1);assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===id).status,'NEEDS_REVIEW');
}finally{await f.close();}});

test('原版新工作台：一键下班按负责分类隔离且只暂停计时，员工可自行继续',async()=>{const f=await fixture();try{
 new PeopleGroups(f.store.db).save([{id:'team-a',name:'甲组',blacklakeOperatorIds:[102],leaderIds:[101]},{id:'team-b',name:'乙组',blacklakeOperatorIds:[103],leaderIds:[104]}],0,'test');
 const a=(await f.dispatch(11)).body.assignmentIds[0],b=(await f.dispatch(11,{person:3,workerId:'103'})).body.assignmentIds[0];await f.action('start',{assignmentId:a},{person:1});await f.action('start',{assignmentId:b},{person:2});
 const preview=await f.call('/v1/dispatch/clock-out');const pause=await f.call('/v1/dispatch/clock-out',{method:'POST',key:'workspace-clock-out-team-a',body:{expectedVersion:preview.body.version}});assert.equal(pause.status,200,JSON.stringify(pause.body));
 const worker=(await f.snapshot(1)).assignments.find(t=>t.id===a);assert.equal(worker.status,'IN_PROGRESS');assert.equal(worker.timerPaused,true);assert.equal(worker.timerPauseSource,'clockout');assert.equal((await f.snapshot(2)).assignments.find(t=>t.id===b).timerPaused,false);
 const resume=await f.call('/v1/assignments/'+a+'/resume',{person:1,method:'POST',key:'workspace-resume-clock-out',body:{expectedRevision:worker.timingRevision}});assert.equal(resume.status,200);assert.equal((await f.snapshot(1)).assignments.find(t=>t.id===a).timerPaused,false);
}finally{await f.close();}});

test('原版新工作台：工单优先级和状态按官方合同写入、回读、幂等且员工不能修改',async()=>{const f=await fixture();try{
 let snapshot=await f.call('/v1/workspace/orders/201/operations');assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));assert.equal((await f.call('/v1/workspace/orders/201/operations',{person:1})).status,403);
 const input={orderId:201,priority:'EXPEDITED',status:'IN_PROGRESS',syncPriority:true},meta={key:'workspace-order-priority-once',version:snapshot.body.version};const result=await f.action('updateOrder',input,meta);assert.equal(result.body.status,'SUCCEEDED',JSON.stringify(result.body));assert.deepEqual(f.orderWrites[0],{path:'/api/dytin/project/priority/update',input:{projectId:201,priority:1,isSyncTask:true}});
 assert.equal((await f.action('updateOrder',input,meta)).body.replayed,true);assert.equal(f.orderWrites.length,1);snapshot=await f.call('/v1/workspace/orders/201/operations');const finish=await f.action('updateOrder',{...input,status:'FINISHED',syncPriority:false},{key:'workspace-order-finish-once',version:snapshot.body.version});assert.equal(finish.body.status,'SUCCEEDED');assert.equal(f.project.status,'20');assert.deepEqual(f.orderWrites.at(-1).input,{projectStatusFlow:{projectIds:[201]}});
}finally{await f.close();}});

test('员工端工单操作只对指定质检组长授权，保留改动回执的归属',async()=>{const f=await fixture();try{
 const operations='/v1/workspace/orders/201/operations',person=4;
 f.store.setQualityProfile(3602917,'quality_leader',0,'test');
 f.store.setQualityProfile(102,'quality_leader',0,'test');
 assert.equal((await f.call('/v1/me',{person})).body.entry.canOperateOrders,true);
 assert.equal((await f.call('/v1/me',{person:1})).body.entry.canOperateOrders,undefined);
 assert.equal((await f.call(operations,{person:1})).status,403);
 const snapshot=await f.call(operations,{person});assert.equal(snapshot.status,200);
 const input={orderId:201,status:'IN_PROGRESS',priority:'URGENT',syncPriority:false};
 const meta={person,key:'quality-leader-order-operation',version:snapshot.body.version};
 assert.equal((await f.action('updateOrder',input,meta)).body.status,'SUCCEEDED');
 assert.equal((await f.action('updateOrder',input,meta)).body.replayed,true);
 assert.equal(f.orderWrites.length,1);
 assert.equal(f.store.db.prepare('SELECT actor FROM workspace_order_operations WHERE operation_id=?').get(meta.key).actor,'quality_leader:3602917');
 f.store.setQualityProfile(3602917,'quality',1,'test');
 assert.equal((await f.call(operations,{person})).status,403);
}finally{await f.close();}});

test('原版新工作台：工单写入响应丢失不重发，目标回读确认后解除待核对',async()=>{const f=await fixture();try{
 const snapshot=await f.call('/v1/workspace/orders/201/operations'),input={orderId:201,priority:'URGENT',status:'IN_PROGRESS',syncPriority:false},meta={key:'workspace-order-lost-response',version:snapshot.body.version};f.blacklake.orderMode='response-lost';
 const result=await f.action('updateOrder',input,meta);assert.equal(result.body.status,'UNKNOWN');assert.equal((await f.action('updateOrder',input,meta)).body.status,'UNKNOWN');assert.equal(f.orderWrites.length,1);
 assert.equal((await f.call('/v1/workspace/orders/201/operations')).status,200);assert.equal((await f.action('updateOrder',input,meta)).body.status,'SUCCEEDED');assert.equal(f.orderWrites.length,1);
}finally{await f.close();}});

test('原版新工作台：未完成任务阻止结束工单，未知工序优先级阻止同步',async()=>{const f=await fixture();try{
 await f.dispatch(11);let snapshot=await f.call('/v1/workspace/orders/201/operations');assert.equal((await f.action('updateOrder',{orderId:201,priority:'NONE',status:'FINISHED',syncPriority:false},{version:snapshot.body.version})).status,409);assert.equal(f.orderWrites.length,0);
 f.tasks[0].processPriority=null;snapshot=await f.call('/v1/workspace/orders/201/operations');assert.equal(snapshot.body.canSyncPriority,false);assert.equal((await f.action('updateOrder',{orderId:201,priority:'URGENT',status:'IN_PROGRESS',syncPriority:true},{version:snapshot.body.version})).status,422);assert.equal(f.orderWrites.length,0);
}finally{await f.close();}});

test('原版新工作台：更正生产人员后个人记录跟随实际人员，原派工归属保持',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});await f.action('end',{assignmentId:id},{person:1});await f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'workspace-move-person-report',body:{quantity:12,defectQuantity:0,defectCodes:[]}});
 const assignment=f.store.assignmentById(id);f.store.db.prepare('UPDATE reports SET operator_id=? WHERE id=?').run(f.operators[2].id,assignment.reportId);
 f.store.db.prepare('INSERT INTO report_production_details VALUES(?,?,?)').run(assignment.reportId,JSON.stringify({operatorId:f.operators[2].id,personId:103,operatorName:'测试员工乙',upstreamOperatorId:103,upstreamOperatorName:'测试员工乙',startedAt:assignment.startedAt,endedAt:assignment.endedAt,durationSeconds:assignment.durationSeconds}),assignment.endedAt);
 assert.equal((await f.snapshot(1)).assignments.flatMap(t=>t.reports).length,0);const corrected=await f.snapshot(2);assert.equal(corrected.assignments[0].reports[0].productionWorkerId,'103');assert.equal(corrected.assignments[0].workerId,'103');assert.equal(f.store.assignmentById(id).operatorId,f.operators[1].id);
}finally{await f.close();}});

test('原版新工作台：已删除报工投影保留删除标记，不进入员工有效记录或声称可恢复',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});await f.action('end',{assignmentId:id},{person:1});await f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'workspace-deleted-projection',body:{quantity:12,defectQuantity:0,defectCodes:[]}});
 const reportId=f.store.assignmentById(id).reportId;f.store.db.prepare("UPDATE reports SET status='DELETED' WHERE id=?").run(reportId);f.store.db.prepare('INSERT INTO leader_report_states(report_id,deleted) VALUES(?,1)').run(reportId);
 const leader=(await f.snapshot(0)).assignments.find(t=>t.id===id);assert.equal(leader.reports[0].deleted,true);assert.equal(leader.reports[0].canRestore,false);
 assert.equal((await f.snapshot(1)).assignments.flatMap(t=>t.reports).filter(r=>!r.deleted).length,0);
}finally{await f.close();}});

test('原版新工作台：进行中派工改人保留原历史，撤销后时长冻结且无需原因',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];await f.action('start',{assignmentId:id},{person:1});f.at('2026-11-12T00:10:00Z');const result=await f.action('editAssignment',{assignmentId:id,workerId:'103',processId:11,unitId:'A-03',priority:'NORMAL'});assert.equal(result.status,200,JSON.stringify(result.body));
 const replacement=result.body.assignmentId;assert.notEqual(replacement,id);assert.equal(f.store.assignmentById(id).status,'CANCELLED');assert.equal(f.store.assignmentById(id).durationSeconds,600);assert.equal(f.store.assignmentById(replacement).operatorId,f.operators[2].id);assert.equal(f.store.assignmentById(replacement).status,'READY');
 assert.equal((await f.action('cancelAssignment',{assignmentId:replacement})).status,200);f.at('2026-11-12T01:00:00Z');assert.equal((await f.snapshot(0)).assignments.find(t=>t.id===id).elapsedSeconds,600);assert.equal(f.outputs.length,0);
}finally{await f.close();}});

test('旧正式版开工后，新工作台派工和排序不能清空开工时间，计时可结束',async(t)=>{t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-12T00:00:00Z')});const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0];
 f.store.db.prepare('UPDATE assignments SET queue_position=2 WHERE id=?').run(id);f.store.db.prepare("UPDATE workspace_task_state SET state_json=json_set(state_json,'$.queueRank',2) WHERE assignment_id=?").run(id);
 const started=await f.call('/v1/assignments/'+id+'/start',{person:1,method:'POST',key:'legacy-start-timing-case',body:{}});assert.equal(started.status,200,JSON.stringify(started.body));const start=started.body.assignment.startedAt;assert(start);
 const saved=JSON.parse(f.store.db.prepare('SELECT state_json FROM workspace_task_state WHERE assignment_id=?').get(id).state_json);
 f.at(new Date(Date.parse(start.replace(' ','T')+'+08:00')+60000).toISOString());
 // Also reproduce a record created by the older backend, before the fix.
 f.store.db.prepare('UPDATE workspace_task_state SET state_json=json_set(state_json,\'$.segments\',json(\'[]\')) WHERE assignment_id=?').run(id);
 const next=(await f.dispatch(12)).body.assignmentIds[0];assert(next);
 assert.equal(f.store.assignmentById(id).startedAt,start,'new dispatch persisted legacy task with empty stale segments');
 await f.action('reorderQueue',{assignmentIds:[id,next],workerId:'102'});
 assert.equal(f.store.assignmentById(id).startedAt,start);
 const worker=await f.snapshot(1),task=worker.assignments.find(r=>r.id===id);assert.equal(task.elapsedSeconds,60);assert.equal(task.timing.startedAt,start);
 const end=await f.action('end',{assignmentId:id},{person:1});assert.equal(end.status,200,JSON.stringify(end.body));assert.equal(f.store.assignmentById(id).durationSeconds,60);assert.equal(saved.segments.length,1,'legacy start must update workspace timing');
}finally{await f.close();}});


test('旧正式版轮询十秒后仍保留原开工时间并能直接确认数量结束',async(t)=>{t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-12T00:00:00Z')});const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0],started=await f.call('/v1/assignments/'+id+'/start',{person:1,method:'POST',body:{}}),at=started.body.assignment.startedAt;assert.equal(started.status,200);
 for(const seconds of [10,20,30]){f.at(new Date(Date.parse(at.replace(' ','T')+'+08:00')+seconds*1000).toISOString());const current=await f.call('/v1/assignments/current',{person:1});assert.equal(current.body.assignment.startedAt,at);assert.equal(current.body.assignment.status,'IN_PROGRESS');}
 const result=await f.call('/v1/assignments/'+id+'/finish',{person:1,method:'POST',key:'legacy-quantity-finish-confirmed',body:{quantity:100,defectQuantity:0}});assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(f.store.assignmentById(id).durationSeconds,30);assert.equal(f.outputs.length,1);
}finally{await f.close();}});

test('已恢复开工时间的遗留任务可通过后台真实接口代结束，先保留待核量且不报黑湖',async()=>{const f=await fixture();try{
 const id=(await f.dispatch(11)).body.assignmentIds[0],start='2026-11-12 08:00:00';f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS',started_at=? WHERE id=?").run(start,id);f.at('2026-11-12T00:02:00Z');
 const detail=await f.call('/v1/admin/task-recovery/assignments/'+id,{admin:true});assert.equal(detail.status,200);assert.equal(detail.body.assignment.canFinish,true);
 const result=await f.call('/v1/admin/task-recovery/assignments/'+id+'/finish',{admin:true,method:'POST',key:'legacy-repaired-admin-finish-01',body:{expectedVersion:detail.body.assignment.version,actualEndedAt:'2026-11-12T08:01'}});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.assignment.status,'QUANTITY_PENDING');assert.equal(result.body.assignment.durationSeconds,60);assert.equal(f.outputs.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_recovery_events WHERE assignment_id=?').get(id).n,1);
}finally{await f.close();}});
