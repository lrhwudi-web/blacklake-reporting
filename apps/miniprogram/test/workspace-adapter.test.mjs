import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {workTimeBreakdown} from '../../api/src/work-time.mjs';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
function adapter(handler,app={globalData:{sessionToken:'synthetic-adapter'}}){const calls=[],module={exports:{}};vm.runInNewContext(read('workspace/utils/api.js'),{module,getApp:()=>app,require:()=>({request:async(path,options={})=>{calls.push({path,options});return handler(path,options);}}),Map,Date});return {...module.exports,calls};}
const json=value=>JSON.parse(JSON.stringify(value));

test('工序报工手机缓存按账号隔离，未变化保留记录，换账号不发送旧版本',async()=>{const app={globalData:{sessionToken:'person-a'}},row={id:'known',orderId:1,processId:11,goodQuantity:42},api=adapter(async path=>path.includes('?version=')?{orderId:1,processId:11,version:'v1',notModified:true,sync:{pending:false}}:{orderId:1,processId:11,version:'v1',reports:[row],sync:{pending:false}},app);
 assert.equal(api.peekProcessReports(1,11),null);const first=await api.loadProcessReports(1,11);assert.equal(api.peekProcessReports(1,11).reports[0].goodQuantity,42);const second=await api.loadProcessReports(1,11);assert.equal(second.reports,first.reports);assert.equal(second.notModified,true);app.globalData.sessionToken='person-b';assert.equal(api.peekProcessReports(1,11),null);await api.loadProcessReports(1,11);assert(!api.calls.at(-1).path.includes('version='));
});

test('派工分类轻量刷新沿用后台顺序、全部位置和现有人员分类归属',async()=>{
 const api=adapter(async()=>({employees:[{blacklakeOperatorId:101,name:'甲',departments:['后台甲组']},{blacklakeOperatorId:102,name:'乙',departments:['后台乙组']}],peopleGroupConfig:{revision:8,allPosition:2,groups:[{id:'b',name:'后台乙组'},{id:'empty',name:'空分类'},{id:'a',name:'后台甲组'}]}}));
 const value=await api.loadDispatchPeople();assert.equal(api.calls[0].path,'/v1/dispatch/overview');assert.equal(value.peopleGroups.revision,8);assert.equal(value.peopleGroups.allPosition,2);assert.deepEqual(json(value.peopleGroups.groups.map(g=>[g.id,g.blacklakeOperatorIds])),[['b',[102]],['empty',[]],['a',[101]]]);
});

test('质检组长编辑删除使用独立全工序接口并冻结远端版本，扫码从服务端解析',async()=>{
 const api=adapter(async path=>path.endsWith('/editor')?{orderId:201,processId:11,permission:'all-process-reports',canEdit:true,canDelete:true,assignment:{id:'task-other'},report:{version:'b'.repeat(64),remoteVersion:'a'.repeat(64),operatorId:103,operatorName:'他人员工',goodQuantity:12,defectQuantity:0,startedAt:'2026-11-13 08:00:07',endedAt:'2026-11-13 08:10:08',durationSeconds:601,defectReasons:Array.from({length:7},(_,i)=>({code:'D'+i,name:'不良'+i})),production:{}},people:[{operatorId:103,name:'他人员工'}]}:path.endsWith('/scan')?{order:{id:201}}:{status:'SUCCEEDED'});
 const edit=await api.loadProcessReportEditor(201,11,'r1');assert.equal(edit.report.assignmentId,'task-other');assert.equal(edit.reportOptions.defectReasons.length,7);assert.equal(edit.canDelete,true);
 await api.deleteProcessReport(201,11,{reportId:'r1'},{expectedVersion:'b'.repeat(64),operationId:'delete-quality-once'});assert.equal(api.calls.at(-1).path,'/v1/workspace/process-reports/201/11/r1/delete');assert.equal(api.calls.at(-1).options.data.expectedVersion,'b'.repeat(64));
 await assert.rejects(api.deleteProcessReport(999,11,{reportId:'r1'},{expectedVersion:'b'.repeat(64),operationId:'wrong-scope'}),/刷新/);assert.equal((await api.resolveScannedOrder('projectId=201')).order.id,201);assert.equal(api.calls.at(-1).path,'/v1/workspace/scan');
});

test('原工程工作台沿用原鉴权传输，报量与逐项不良映射正式合同而不调用演示模型',async()=>{
 const api=adapter(async()=>({assignment:{status:'COMPLETED'}}));await api.executeExecutionAction('finish',{assignmentId:'real-task',goodQuantity:95,defectiveQuantity:5,defectCodes:['D1','D2'],defectItems:[{code:'D1',quantity:4},{code:'D2',quantity:1}]},{operationId:'same-native-finish-key'});
 assert.equal(api.calls[0].path,'/v1/assignments/real-task/finish');assert.equal(api.calls[0].options.idempotencyKey,'same-native-finish-key');assert.deepEqual(json(api.calls[0].options.data.defectItems),[{code:'D1',amount:4},{code:'D2',amount:1}]);
 assert.doesNotMatch(read('workspace/utils/api.js'),/createExecution|sessionStorage|fixtureExecution|demo-leader/);
});

test('原工程报工编辑先读取最新原生版本，保存保留秒数及生产人员，不重写派工身份',async()=>{
 const api=adapter(async path=>path.endsWith('/tasks')?{assignments:[{id:'a1',reports:[{id:'r1',version:'local-version'}]}]}:path.endsWith('/editor')?{report:{version:'fresh-version',remoteVersion:'a'.repeat(64),operatorId:102,goodQuantity:90,defectQuantity:0,startedAt:'2026-11-12 08:01:07',endedAt:'2026-11-12 08:11:13',durationSeconds:606,defectReasons:[],production:{}},people:[{operatorId:102,name:'测试员工',departments:['生产']}]}:{status:'SUCCEEDED'});
 await api.loadLeaderTasks();const editor=await api.loadReportEdit('r1');assert.equal(editor.report.actualStartedAt,'2026-11-12T00:01:07.000Z');assert.equal(editor.options.employees[0].id,'102');
 await api.executeExecutionAction('editReport',{reportId:'r1',goodQuantity:89,defectiveQuantity:0,productionWorkerId:'102',actualStartedAt:editor.report.actualStartedAt,actualEndedAt:editor.report.actualEndedAt,reportedSeconds:606,materialProcess:'',punchMinutes:1.25,defectItems:[]},{operationId:'same-native-edit-key'});
 const data=api.calls.at(-1).options.data;assert.equal(data.expectedVersion,'fresh-version');assert.equal(data.expectedRemoteVersion,'a'.repeat(64));assert.equal(data.startedAt,'2026-11-12 08:01:07');assert.equal(data.operatorId,102);assert.equal(Object.hasOwn(data,'assignmentId'),false);assert.equal(Object.hasOwn(data,'punchMinutes'),false);
});

test('原工程适配对未确认结果和恢复保持失败关闭，人员历史推荐结果不丢失',async()=>{
 const api=adapter(async path=>path.includes('/prediction')?{prediction:{id:'prediction-id',taskId:12}}:{assignment:{status:'NEEDS_REVIEW'}});
 assert.equal((await api.recommendDispatchProcess({id:201},[102])).taskId,12);await assert.rejects(api.executeExecutionAction('finish',{assignmentId:'a1',goodQuantity:10,defectiveQuantity:0},{operationId:'unknown-finish-key'}),/待核对/);
 await assert.rejects(api.executeExecutionAction('restoreReport',{reportId:'r1'},{}),/尚未完成/);assert.equal(api.calls.filter(c=>c.path.includes('recover')).length,0);
});

test('原App保留审核与3楼主管入口，绣花和8楼员工使用共用工作台',()=>{
 let app;vm.runInNewContext(read('app.js'),{App:value=>app=value});app.globalData.operator={defaultReportingMode:'standard'};
 assert.equal(app.homeUrl({appRole:'floor8_leader',entryView:'floor8-leader'}),'/workspace/pages/orders/orders');assert.equal(app.homeUrl({appRole:'employee',entryView:'employee-reporting'}),'/workspace/pages/worker/worker');
 assert.equal(app.homeUrl({appRole:'floor3_supervisor',entryView:'floor3-supervisor'}),'/pages/dispatch/dispatch');app.globalData.operator.defaultReportingMode='embroidery';assert.equal(app.homeUrl({appRole:'employee',entryView:'employee-reporting',workUnitId:'3F-01'}),'/workspace/pages/worker/worker?mode=embroidery');
 app.globalData.reviewMode=true;assert.equal(app.homeUrl({appRole:'floor8_leader',entryView:'floor8-leader'}),'/pages/dispatch/dispatch');
 assert.equal(app.homeUrl({appRole:'employee',entryView:'employee-reporting'}),'/pages/report/report');
 const config=JSON.parse(read('app.json'));assert.equal(config.subpackages[0].root,'workspace');assert.equal(config.pages.includes('pages/login/login'),true);
});

test('原工程报工选人保持后台分类顺序和全部位置，搜索展开且单选归属正确',()=>{
 let native={exports:{}};vm.runInNewContext(read('utils/report-editor-model.js'),{module:native,require:()=>({})});
 const module={exports:{}};vm.runInNewContext(read('workspace/utils/formal-report-people.js'),{module,require:()=>native.exports});
 const people=[{id:'102',name:'员工甲',departments:['生产一组']},{id:'103',name:'员工乙',departments:['生产二组']}],config={allPosition:1,groups:[{id:'two',name:'生产二组',operatorIds:[103]},{id:'one',name:'生产一组',operatorIds:[102]}]};
 const result=module.exports(people,'',['two'],'103',[],config);assert.deepEqual(json(result.groups.map(g=>g.name)),['生产二组','全部','生产一组']);assert.equal(result.groups[0].members[0].selected,true);assert.equal(result.groups[0].expanded,true);
 const found=module.exports(people,'员工甲',[],'',[],config);assert.equal(found.total,1);assert.deepEqual(json(found.groups.map(g=>g.name)),['全部','生产一组']);assert(found.groups.every(g=>g.expanded));
 const chooser={exports:{}};vm.runInNewContext(read('workspace/utils/assignment-management.js'),{module:chooser,require:name=>name==='./report-model'?{peopleGroups:module.exports}:{}});
 const page={data:{assignmentSelection:'people',assignmentQuery:'',assignmentExpanded:[],assignmentDraft:{workerId:'103'},assignmentCollapsed:[],reportOptions:{employees:people,peopleGroupConfig:config}},setData(values){Object.assign(this.data,values);}};
 chooser.exports.methods.updateAssignmentChoices.call(page);assert.deepEqual(json(page.data.assignmentGroups.map(g=>g.name)),['生产二组','全部','生产一组']);assert.equal(page.data.assignmentGroups[0].members[0].selected,true);
});

test('原工程员工本地时钟沿用午休和暂停扣除，轮询在弹层及隐藏时停止',()=>{
 let at=Date.parse('2026-11-12T04:30:00Z'),intervalCallback,cleared=0,refreshes=0;const FakeDate=class extends Date{static now(){return at;}};
 const module={exports:{}};vm.runInNewContext(read('workspace/utils/live-workspace.js'),{module,require:name=>name==='./api'?{}:name==='./worker-model'?{clockText:s=>[Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':')}:name==='./work-time'?{workTimeBreakdown}:{request:async()=>({})},Date:FakeDate,Map,setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{intervalCallback=fn;return 3;},clearInterval(){cleared++;}});
 const page=module.exports.wrap({data:{workerTab:'tasks',current:{status:'IN_PROGRESS',timerPaused:false,timing:{startedAt:'2026-11-12 11:30:00',endedAt:null,asOf:'2026-11-12T04:30:00Z',pauses:[]}}},refresh(){refreshes++;},updateWorkerClock(){throw Error('unexpected fallback');}},'worker');page.clockBaseAt=at;page.setData=values=>{for(const [key,value]of Object.entries(values)){if(key==='current.timerStateText')page.data.current.timerStateText=value;else page.data[key]=value;}};
 page.updateWorkerClock();assert.equal(page.data.clockText,'00:30:00');assert.equal(page.data.current.timerStateText,'午休已暂停');at=Date.parse('2026-11-12T06:00:00Z');page.updateWorkerClock();assert.equal(page.data.clockText,'01:00:00');
 page.data.current.timerPaused=true;page.data.current.timerPauseSource='overnight';page.updateWorkerClock();assert.equal(page.data.current.timerStateText,'系统已暂停');
 page.onShow();intervalCallback();assert.equal(refreshes,1);
 for(const field of ['reportMenu','assignmentMenu','listPanel','detailMounted','workerPanel']){page.data[field]={};intervalCallback();assert.equal(refreshes,1,field+' must block polling');page.data[field]=null;}
 page.data.workerPanel={kind:'quantity'};intervalCallback();assert.equal(refreshes,1);page.onHide();assert(cleared>0);intervalCallback();assert.equal(refreshes,1);
});
