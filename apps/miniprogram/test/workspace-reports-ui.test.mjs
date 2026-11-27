import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(){const app={globalData:{}},timers=new Map(),api={},events=[];let definition,serial=0;const backModule={exports:{}};vm.runInNewContext(fs.readFileSync(new URL('../workspace/utils/layer-back.js',import.meta.url),'utf8'),{module:backModule});vm.runInNewContext(fs.readFileSync(new URL('../workspace/components/reports-dashboard/index.js',import.meta.url),'utf8'),{Component:d=>definition=d,require:id=>id.endsWith('/layer-back')?backModule.exports:id.endsWith('/api')?api:id.endsWith('/detail-model')?{presentReportRecord:r=>({recordGoodText:String(r.goodQuantity)})}:{data:{},methods:{}},getApp:()=>app,wx:{getWindowInfo:()=>({windowHeight:740}),showToast(){} },setTimeout:f=>{timers.set(++serial,f);return serial;},clearTimeout:id=>timers.delete(id),Date});const c={...definition.methods,data:JSON.parse(JSON.stringify(definition.data)),properties:{active:true},setData(v){Object.assign(this.data,v);},triggerEvent:(type,detail)=>events.push({type,detail})};return {c,app,api,timers,events,definition};}
test('报表工单响应解包后叠层展示，关闭详情保留记录和拉伸高度',async()=>{const f=fixture(),row={id:'record',orderId:201};Object.assign(f.c.data,{reportRecords:[row],reportRecordsOpen:true,recordHeight:680});f.api.loadOrderDetail=async()=>({order:{id:201,code:'TEST-201'}});await f.c.openReportOrder({currentTarget:{dataset:{id:'record'}}});assert.equal(f.app.globalData.viewOrder.id,201);assert.equal(f.c.data.reportOrderMounted,true);f.c.closeReportOrder();f.c.reportOrderClosed();assert.equal(f.c.data.reportRecordsOpen,true);assert.equal(f.c.data.recordHeight,680);assert.equal(f.c.data.reportRecords[0],row);});
test('普通员工报表只读，没有菜单调用；组长用原菜单组件',()=>{const f=fixture();let menus=0;f.c.showReportActions=()=>menus++;f.c.data.reportRecords=[{id:'r',orderId:201,processId:11}];f.c.reportMenu({currentTarget:{dataset:{id:'r'}}});assert.equal(menus,0);f.c.data.canManageReports=true;f.c.reportMenu({currentTarget:{dataset:{id:'r'}}});assert.equal(menus,1);assert.equal(f.c.data.processDetail.id,11);});
test('汇总从单条记录打开报工编辑时声明模态，关闭后恢复主导航',()=>{const f=fixture(),observe=f.definition.observers['reportPanel, actionBusy'];f.c.attachedReady=true;
 f.c.data.actionBusy=true;observe.call(f.c,null,true);assert.equal(f.events.at(-1).detail.busy,true);
 f.c.data.actionBusy=false;f.c.data.reportPanel={isEditor:true};observe.call(f.c,f.c.data.reportPanel,false);assert.equal(f.events.at(-1).detail.modal,true);
 f.c.data.reportPanel=null;observe.call(f.c,null,false);assert.equal(f.events.at(-1).detail.modal,false);assert.equal(f.events.at(-1).detail.busy,false);
});
test('员工搜索、全选和日期草稿只有应用后才改变正式筛选',()=>{const {c}=fixture();let calls=0;c.loadReportData=()=>calls++;
 c.data.employeeOptions=[{id:'1',name:'员工甲',groups:['车缝组']},{id:'2',name:'员工乙',groups:['包装组']}];
 c.openEmployees();c.searchEmployees({detail:{value:'包装'}});assert.equal(c.data.employeeRows.length,1);assert.equal(c.data.employeeAll,true);
 c.toggleAllEmployees();c.applyEmployees();assert.equal(calls,0);assert.match(c.data.pickerError,/至少/);
 c.toggleEmployee({currentTarget:{dataset:{id:'2'}}});c.applyEmployees();assert.equal(c.filters().personIds,'2');assert.equal(calls,1);
 c.openEmployees();c.toggleAllEmployees();c.closePicker();assert.equal(c.filters().personIds,'2');assert.equal(calls,1);
 Object.assign(c.data,{today:'2026-11-20',yesterday:'2026-11-19',from:'2026-11-20',to:'2026-11-20',dateDraft:{mode:'today',from:'2026-11-20',to:'2026-11-20'}});
 c.datePreset({currentTarget:{dataset:{mode:'week'}}});assert.equal(c.data.from,'2026-11-20');c.applyDate();assert.equal(c.data.from,'2026-11-14');assert.equal(calls,2);
});
test('同步中保留旧数量并轮询自己的后台；更新完成后停止，后台隐藏停止轮询',async()=>{const f=fixture();let calls=0;f.c.data.reportRecordsOpen=true;f.api.loadWorkspaceReports=async()=>({records:[{id:'r',goodQuantity:++calls===1?93:92,syncState:calls===1?'QUEUED':'SUCCEEDED'}],canManage:true,total:1,page:1,hasMore:false,selectionSummary:{seconds:3600,unknownDurationCount:0}});f.c.loadReportData=()=>{};await f.c.loadReportRecords();assert.equal(f.c.data.reportRecords[0].recordGoodText,'93');assert.equal(f.timers.size,1);const fn=[...f.timers.values()][0];f.timers.clear();fn();for(let n=0;n<5;n++)await Promise.resolve();assert.equal(f.c.data.reportRecords[0].recordGoodText,'92');assert.equal(f.timers.size,0);f.c.scheduleRecordRefresh();f.definition.pageLifetimes.hide.call(f.c);assert.equal(f.timers.size,0);});

const report=()=>({version:'v1',canManage:true,summary:{pieceQuantity:3800,people:3,seconds:86400,count:4,bad:20,quantity:3820,defectRate:20/3820},people:[{id:'a',name:'员工甲',pieceQuantity:1280,seconds:7200,count:2,processes:['查片']},{id:'b',name:'员工乙',pieceQuantity:2520,seconds:3600,count:1,processes:['车缝']},{id:'c',name:'待核对员工',pieceQuantity:null,unknownPieceCount:1,seconds:1800,count:1,processes:['质检']}],processes:[],defects:[],bins:[],groups:[],processOptions:[],sync:{complete:true,updatedAt:null}});

test('人员报表显示千分位良品计件，按计件排序未知最后，缺失不借用良不良总量',()=>{const f=fixture();f.c.raw=report();f.c.data.sort='pieces';f.c.present();assert.equal(f.c.data.summary.pieceText,'3,800');assert.equal(f.c.data.people[0].id,'b');assert.equal(f.c.data.people[1].pieceText,'1,280');assert.equal(f.c.data.people[2].pieceText,'—');delete f.c.raw.summary.pieceQuantity;f.c.present();assert.equal(f.c.data.summary.pieceText,'—');});

test('相同报表版本静默刷新不再传整组数据，版本变化才更新计件',async()=>{const f=fixture(),patches=[];f.c.setData=v=>{patches.push(v);Object.assign(f.c.data,v);};const r=report();f.api.loadWorkspaceReports=async()=>structuredClone(r);await f.c.loadReportData({quiet:true});patches.length=0;await f.c.loadReportData({quiet:true});assert.equal(patches.length,0);r.version='v2';r.summary.pieceQuantity=3799;r.people[0].pieceQuantity=1279;await f.c.loadReportData({quiet:true});assert.equal(f.c.data.summary.pieceText,'3,799');assert.equal(f.c.data.people.find(p=>p.id==='a').pieceText,'1,279');assert(patches.some(p=>p.people));});

test('同一筛选读取中不排队重复请求，切换日期只补读最新范围',async()=>{
 const {c,api}=fixture(),calls=[],pending=[];
 api.loadWorkspaceReports=filters=>{calls.push(filters.from);return new Promise(resolve=>pending.push(resolve));};
 c.data.from='2026-11-25';
 const initial=c.loadReportData();
 await c.loadReportData({quiet:true});
 pending.shift()(report());await initial;
 assert.deepEqual(calls,['2026-11-25']);
 assert.equal(c.data.loading,false);
 const refresh=c.loadReportData({quiet:true});
 for(const from of ['2026-11-24','2026-11-23']){c.data.from=from;await c.loadReportData();}
 pending.shift()(report());await refresh;
 assert.deepEqual(calls,['2026-11-25','2026-11-25','2026-11-23']);
 pending.shift()(report());
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(c.data.loading,false);
 assert.equal(JSON.parse(c.reportFilterKey).from,'2026-11-23');
});

test('通用请求区分后台响应超时和连接失败，写操作提示核对回执',async()=>{
 const module={exports:{}};
 let attempts=0,failure='request:fail timeout';
 const wx={request(options){attempts++;options.fail({errMsg:failure});options.complete();}};
 vm.runInNewContext(fs.readFileSync(new URL('../utils/api.js',import.meta.url),'utf8'),{module,wx,getApp:()=>({globalData:{apiBaseUrl:'https://example.invalid'}})});
 const {request}=module.exports;
 await assert.rejects(request('/v1/workspace/reports'),error=>error.code==='REQUEST_TIMEOUT'&&/请求后台超时/.test(error.message));
 await assert.rejects(request('/v1/workspace/actions',{method:'POST'}),error=>error.code==='REQUEST_TIMEOUT'&&/刷新确认结果/.test(error.message));
 failure='request:fail net::ERR_CONNECTION_RESET';
 await assert.rejects(request('/v1/orders'),error=>error.code==='NETWORK_ERROR'&&/连接后台失败/.test(error.message));
 assert.equal(attempts,3);
});

test('批量审批只提交已勾选且可审批的记录，响应不明保留选择及操作编号',async()=>{
 const {c,api}=fixture(),calls=[];
 const row=(id,approvalSync=null)=>({id,personName:'员工',orderCode:'QA',canApprove:true,approvalStatus:0,approvalSync});
 Object.assign(c.data,{canManageReports:true,summaryRows:[row('first'),row('second'),row('other'),row('unknown','UNKNOWN')]});
 c.reportFilterKey=JSON.stringify(c.filters());
 api.approveProcessReport=async (r,key)=>{
  calls.push({id:r.id,key});
  if(r.id==='second')throw Error('连接中断');
  return {accepted:true,status:'QUEUED'};
 };
 c.openBatchApproval();
 await c.submitBatchApproval();
 assert.match(c.data.pickerError,/至少选择/);
 assert.equal(c.data.batchRows.length,3);
 for(const id of ['first','second'])c.toggleBatchRow({currentTarget:{dataset:{id}}});
 await c.submitBatchApproval();
 assert.deepEqual(calls.map(r=>r.id),['first','second']);
 assert.equal(c.data.batchCount,1);
 assert.equal(c.data.batchSelected.second,true);
 assert.equal(c.data.batchRows.some(r=>r.id==='first'),false);
 assert.match(c.data.pickerError,/1笔已受理，1笔尚未确认/);
 await c.submitBatchApproval();
 assert.equal(calls[2].id,'second');
 assert.equal(calls[2].key,calls[1].key);
});
