import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function cjs(path,require=()=>({})){const module={exports:{}};vm.runInNewContext(readFileSync(new URL(path,import.meta.url),'utf8'),{module,require,Date,Set,Error});return module.exports;}
const clock=cjs('../utils/work-time.js'),editorModel=cjs('../utils/report-editor-model.js',()=>clock);
function fixture(handler=async()=>({})) {
  let page;const calls=[],modals=[];
  vm.runInNewContext(readFileSync(new URL('../pages/dispatch/dispatch.js',import.meta.url),'utf8'),{Page:p=>page=p,getApp:()=>({globalData:{sessionToken:'fixture'}}),
    require:name=>name.endsWith('report-editor-model')?editorModel:({request:async(path,options)=>{calls.push({path,options});return path.endsWith('/editor')?{report:row,people:[{operatorId:201,name:'测试员工'},{operatorId:202,name:'另一个员工',departments:['后道']}] }:handler(path,options);}}),wx:{showModal:v=>modals.push(v),showToast(){}},Date,setInterval:()=>1,clearInterval(){}});
  page.setData=v=>Object.assign(page.data,v);Object.assign(page.data,{ready:true,historyOpen:true,historyTab:'reports',reportDate:'2026-11-10'});return{page,calls,modals};
}
const row={fullSyncReady:true,canEditDefects:true,id:'a',version:'v1',remoteVersion:'f'.repeat(64),operatorId:201,operatorName:'测试员工',processName:'车耳朵',quantity:100,goodQuantity:100,defectQuantity:0,canEdit:true,canDelete:true,defectCodes:[],defectReasons:[],durationSeconds:5700,startedAt:'2026-11-10 11:00:00',endedAt:'2026-11-10 14:20:00',reportedAt:'2026-11-10 14:20:00'};
const response=(rows=[row],more=false)=>({date:'2026-11-10',reports:rows,total:more?31:rows.length,hasMore:more,serverTime:'2026-11-10 18:00:00'});

test('报工分页真实追加；日期切换时旧响应不能覆盖新日期',async()=>{
  let release;const f=fixture(path=>path.includes('offset=0')?Promise.resolve(response([row],true)):new Promise(r=>release=r));
  await f.page.loadReportRecords();assert.equal(f.page.data.reportRecords[0].durationText,'01:35');const pending=f.page.loadMoreReports();
  f.page.reportRequestRevision++;f.page.setData({reportDate:'2026-11-09',reportRecords:[]});release(response([{...row,id:'b'}]));await pending;assert.equal(f.page.data.reportRecords.length,0);
  assert.match(f.calls[1].path,/offset=1/);
});
test('报工菜单与编辑打开不发写请求，连续保存只有一次，服务端确认后刷新',async()=>{
  let release;const f=fixture((path,options)=>options?.method==='POST'?new Promise(r=>release=r):response());f.page.data.reportRecords=[row];
  f.page.toggleReportMenu({currentTarget:{dataset:{id:'a'}}});await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});assert.equal(f.calls.length,1);assert.equal(f.calls[0].options,undefined);
  f.page.onReportGoodInput({detail:{value:'80'}});const pending=f.page.saveReportEdit();await f.page.saveReportEdit();assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.data.expectedVersion,'v1');assert.equal(f.calls[1].options.data.goodQuantity,80);
  release({status:'SUCCEEDED',report:{...row,goodQuantity:80}});await pending;assert.equal(f.page.data.reportEditor,null);assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);
});
test('删除必须确认；取消不写；响应丢失锁定编辑且不自动重报',async()=>{
  const f=fixture(async()=>{throw Error('network');});f.page.data.reportRecords=[row];f.page.deleteReport({currentTarget:{dataset:{id:'a'}}});assert.equal(f.calls.length,0);f.modals[0].success({confirm:false});assert.equal(f.calls.length,0);
  await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});await f.page.saveReportEdit();assert.equal(f.page.data.reportActionLocked,true);await f.page.saveReportEdit();assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);assert.match(f.page.data.reportActionError,/network/);
});

test('完整编辑选人搜索与原生时间选择只改草稿，重算扣午休，保存携带完整资料与上游版本',async()=>{
 const f=fixture((path,options)=>options?.method==='POST'?{status:'SUCCEEDED'}:response());f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 f.page.openReportPeople();f.page.searchReportPeople({detail:{value:'后道'}});assert.equal(f.page.data.reportPeopleResults.length,1);f.page.selectReportPerson({currentTarget:{dataset:{id:202}}});assert.equal(f.page.data.reportEditForm.operatorName,'另一个员工');
 f.page.changeReportDateTime({currentTarget:{dataset:{part:'end',field:'time'}},detail:{value:'14:00'}});
 assert.equal(f.page.data.reportEditForm.endTime,'14:00');assert.equal(f.page.data.reportEditForm.hours,'1');assert.equal(f.page.data.reportEditForm.minutes,'30');assert.equal(f.calls.length,1);
 await f.page.saveReportEdit();const write=f.calls.find(c=>c.options?.method==='POST');assert.equal(write.options.data.operatorId,202);assert.equal(write.options.data.durationSeconds,5400);assert.equal(write.options.data.endedAt,'2026-11-10 14:00:00');assert.equal(write.options.data.expectedRemoteVersion,'f'.repeat(64));
});

test('原生时间选择保留秒数、校验日期，时间先后暂时无效可修正，不良分配错误不提交',async()=>{
 const f=fixture();f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 const change=(part,field,value)=>f.page.changeReportDateTime({currentTarget:{dataset:{part,field}},detail:{value}});
 const before=f.page.data.reportEditForm;change('start','date','2026-02-30');assert.equal(f.page.data.reportEditForm,before);assert.match(f.page.data.reportActionError,/有效日期/);
 change('start','time','15:00');assert.equal(f.page.data.reportEditForm.startTime,'15:00');assert.equal(f.page.data.reportTimeInvalid,true);await f.page.saveReportEdit();assert.match(f.page.data.reportActionError,/不能早于/);
 change('end','time','16:00');assert.equal(f.page.data.reportTimeInvalid,false);assert.equal(f.page.data.reportEditForm.hours,'1');assert.equal(f.page.data.reportEditForm.minutes,'0');assert.equal(f.page.data.reportEditForm.punchMinutes,'60');
 const secondsForm=editorModel.form({...row,startedAt:'2026-11-10 11:00:34',endedAt:'2026-11-10 14:20:38'});
 assert.equal(editorModel.times(editorModel.changeTime(secondsForm,'start','time','11:00')).startedAt,'2026-11-10 11:00:34');
 assert.equal(editorModel.times(editorModel.changeTime(secondsForm,'end','time','14:21')).endedAt,'2026-11-10 14:21:00');
 assert.doesNotThrow(()=>editorModel.changeTime(secondsForm,'start','date','2024-02-29'));assert.throws(()=>editorModel.changeTime(secondsForm,'start','date','2025-02-29'));
 change('start','time','25:00');assert.equal(f.page.data.reportEditForm.startTime,'15:00');
 f.page.onReportDefectInput({detail:{value:'2'}});assert.equal(f.page.data.reportDefectText,'选择并分配数量');await f.page.saveReportEdit();assert.match(f.page.data.reportActionError,/合计/);assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('服务端明确输入校验失败允许原地修正；本地投影待核对仍锁住',async()=>{
 for(const [status,locked]of [[422,false],[409,true]]){const f=fixture(async()=>{throw Object.assign(Error('请核对时间'),{status,code:status===409?'REPORT_CHANGE_LOCAL_REVIEW':'INVALID_REPORT_TIME'});});f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});await f.page.saveReportEdit();assert.equal(f.page.data.reportActionLocked,locked);}
});

test('核对结果只调用reconcile且拦住连点，成功刷新后清除旧错误',async()=>{
  let release;const f=fixture((path,options)=>options?.method==='POST'?new Promise(r=>release=r):response());
  f.page.data.reportRecords=[{...row,canEdit:false,canDelete:false,canReconcile:true,mutationStatus:'UNKNOWN'}];f.page.data.reportActionError='旧网络错误';
  const event={currentTarget:{dataset:{id:'a'}}},pending=f.page.reconcileReport(event);await f.page.reconcileReport(event);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/v1/dispatch/reports/a/reconcile');assert.deepEqual(Object.keys(f.calls[0].options.data),[]);
  release({status:'SUCCEEDED'});await pending;assert.equal(f.page.data.reportSaving,false);assert.equal(f.page.data.reportActionError,'');
  assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);assert.equal(f.page.data.reportRecords[0].canEdit,true);
});

test('核对仍未知或失败时保持受限，只读刷新不会重发修改',async()=>{
  const pendingRow={...row,canEdit:false,canDelete:false,canReconcile:true,mutationStatus:'UNKNOWN'};
  const f=fixture((path,options)=>options?.method==='POST'?{status:'UNKNOWN',error:{message:'结果待核对'}}:response([pendingRow]));f.page.data.reportRecords=[pendingRow];
  await f.page.reconcileReport({currentTarget:{dataset:{id:'a'}}});assert.equal(f.page.data.reportActionError,'结果待核对');assert.equal(f.page.data.reportRecords[0].canEdit,false);
  await f.page.refreshReports();assert.equal(f.page.data.reportActionError,'');assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);
  assert.equal(f.page.data.reportRecords[0].mutationStatus,'UNKNOWN');
});

test('未接通黑湖的完整编辑不会从客户端提交，公式时长不能手工改成有效分钟',async()=>{
 const f=fixture();f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 f.page.data.reportEditor.fullSyncReady=false;await f.page.saveReportEdit();assert.match(f.page.data.reportActionError,/尚未验证/);assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,0);
 const before=f.page.data.reportEditForm.punchMinutes;f.page.onReportEditField({currentTarget:{dataset:{field:'punchMinutes'}},detail:{value:'90'}});assert.equal(f.page.data.reportEditForm.punchMinutes,before);
 const draft=editorModel.recalculate({...f.page.data.reportEditForm,endTime:'14:00',endChanged:true},[]);assert.equal(draft.hours,'1');assert.equal(draft.minutes,'30');assert.equal(draft.punchMinutes,'180');
 const body=editorModel.payload({...f.page.data,reportEditForm:draft});assert.equal(body.durationSeconds,5400);assert.equal('punchMinutes' in body,false);
});

test('组长普通工序按明确的不良更正权限打开品项，质检身份不作为编辑禁用条件',async()=>{
 const f=fixture();f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 f.page.data.reportEditor={...f.page.data.reportEditor,isQualityInspection:false,canEditDefects:true};
 f.page.toggleReportDefects();assert.equal(f.page.data.reportDefectsOpen,true);
});

test('保存锁定与未授权不良权限阻止直接事件修改，原生时间事件不能绕过保存锁',async()=>{
 const f=fixture();f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 for(const locked of [true,false]){f.page.data.reportActionLocked=locked;f.page.data.reportEditor.canEditDefects=locked;
 const prior=f.page.data.reportDefectInput;f.page.onReportDefectInput({detail:{value:'5'}});f.page.toggleReportDefects();assert.equal(f.page.data.reportDefectInput,prior);assert.equal(f.page.data.reportDefectsOpen,false);}
 f.page.data.reportSaving=true;const prior=f.page.data.reportEditForm;f.page.changeReportDateTime({currentTarget:{dataset:{part:'start',field:'time'}},detail:{value:'10:00'}});assert.equal(f.page.data.reportEditForm,prior);
});


test('报工选人按后台分类顺序及全部位置，默认首项含空组，搜索在当前分类并保留所选生产人员',async()=>{
 const f=fixture();f.page.data.reportRecords=[row];await f.page.openReportEditor({currentTarget:{dataset:{id:'a'}}});
 f.page.data.reportPeopleAll=[{operatorId:201,name:'甲员工',departments:['缝制']},{operatorId:202,name:'乙员工',departments:['后道']}];
 f.page.data.reportPeopleGroupConfig={revision:1,allPosition:1,groups:[{id:'empty',name:'空组',operatorIds:[]},{id:'b',name:'后道',operatorIds:[202]},{id:'a',name:'缝制',operatorIds:[201]}]};
 f.page.openReportPeople();assert.equal(f.page.data.reportPeopleGroupId,'empty');assert.equal(f.page.data.reportPeopleResults.length,0);assert.deepEqual(Array.from(f.page.data.reportPeopleGroups,g=>g.id),['empty','@all','b','a']);
 const choose=id=>f.page.chooseReportPeopleGroup({currentTarget:{dataset:{id}}});choose('b');assert.equal(f.page.data.reportPeopleResults[0].operatorId,202);assert.equal(f.page.data.reportEditForm.operatorId,201);
 f.page.searchReportPeople({detail:{value:'甲'}});assert.equal(f.page.data.reportPeopleResults.length,0);choose('@all');assert.equal(f.page.data.reportPeopleResults[0].operatorId,201);f.page.searchReportPeople({detail:{value:''}});assert.equal(f.page.data.reportPeopleResults.length,2);
 choose('b');f.page.selectReportPerson({currentTarget:{dataset:{id:202}}});assert.equal(f.page.data.reportEditForm.operatorId,202);assert.equal(f.page.data.reportPeopleOpen,false);assert.equal(f.calls.length,1);
});

test('后台删除当前分类时回落首项，未分类人员仅归全部且多分类成员不重复',()=>{
 const people=[{operatorId:1,name:'一',departments:[]},{operatorId:2,name:'二',departments:['甲','乙']}],config={allPosition:2,groups:[{id:'a',name:'甲',operatorIds:[2]},{id:'b',name:'乙',operatorIds:[2]}]};
 const view=editorModel.peopleView(people,config,'removed','');assert.equal(view.selectedId,'a');assert.equal(view.results.length,1);assert.equal(view.groups[2].count,2);assert.equal(editorModel.peopleView(people,config,'@all','').results.length,2);
});
