import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {createApp} from '../src/app.mjs';
import {WorkspaceReports} from '../src/workspace-reports.mjs';
import {PeopleGroups} from '../src/people-groups.mjs';
import {createServer} from 'node:http';
import {LeaderReports} from '../src/leader-reports.mjs';

function fixture(){
 const now=()=>Date.parse('2026-11-16T18:00:00+08:00'),config={sessionSecret:'report-dashboard-tests',sessionDays:1,adminApiKey:'synthetic-admin',agent:{enabled:false},review:{enabled:false},dataSync:{allowNext:true}},store=new Store(':memory:',config),calls=[];
 const people=[101,102,103].map((id,i)=>({blacklakeOperatorId:id,name:['组长','员工甲','质检组长'][i],departments:['车缝组'],groupNames:['车缝组']}));
 const operators=people.map(p=>store.upsertBlacklakeOperator(p));store.setEntryProfile(101,{appRole:'floor8_leader'});store.setQualityProfile(103,'quality_leader',0,'test');
 const blacklake=new Proxy({supportsFullReportCorrection:true,requestBudget:{state:{}}},{get(target,k){return k in target?target[k]:async()=>{calls.push(k);throw Error('No upstream calls allowed');};}}),sync=new BlacklakeSync({store,blacklake,now});
 const app=createApp({store,blacklake,config,defectReasons:[{code:'D0',name:'车缝不良'},{code:'D1',name:'染色不良'}],now,dataSync:sync});
 // Initialize the same existing workspace services as the HTTP route.
 const workspace={authorize(s){assert.equal(s.scope,'employee');return store.entryProfile(s.blacklakeOperatorId).appRole;}};
 const groups=new PeopleGroups(store.db),service=new WorkspaceReports({store,workspace,sync,getPeopleGroups:p=>groups.read(p),defectReasons:[{code:'D0',name:'车缝不良'},{code:'D1',name:'染色不良'}],now});
 new LeaderReports({store,blacklake,now});
 const info={projectId:201,projectCode:'2026-REP-201',productCode:'SKU-ABC',productName:'合成球包',projectStatus:10,productImageUrls:['https://example.invalid/product.png']};sync.indexOrder(info);sync.save('order',201,{info,tasks:[{taskId:11,processName:'车缝'}]});sync.save('history-day','2026-11-16',{});
 const index=(id,extra={})=>{const row={reportingId:id,projectId:201,taskId:11,productionStaffId:102,productionStaff:'员工甲',numberofgoodProducts:90,numberofDefectives:10,effectiveTime:3600,createdAt:'2026-11-16 14:00:00',defectItemList:[{code:'D0',amount:10}],...extra};store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,created_at,raw_json,updated_at) VALUES(?,?,?,?,?,?)').run(String(id),row.projectId,row.taskId,row.createdAt,JSON.stringify(row),now());};
 index(1);index(2,{numberofgoodProducts:99,numberofDefectives:1,defectItemList:[{code:'D1',amount:1}],productionStaffId:103,productionStaff:'质检组长'});
 return {store,sync,service,index,calls,app,blacklake,session:i=>({...operators[i],scope:'employee'}),close:()=>store.close()};
}
test('报表全员可见、组长和质检组长可管理、普通员工只读，读取不触发黑湖',()=>{const f=fixture();try{for(let i=0;i<3;i++){const value=f.service.read({},f.session(i));assert.equal(value.total,2);assert.equal(value.canManage,i!==1);assert(value.records.every(r=>r.canEdit===(i!==1)));}assert.deepEqual(f.calls,[]);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n,0);}finally{f.close();}});
test('不良率使用同一筛选下良品与不良之和，按后台分类、产品、工序和人员筛选',()=>{const f=fixture();try{let r=f.service.read({},f.session(0));assert.equal(r.summary.bad,11);assert.equal(r.summary.quantity,200);assert.equal(r.summary.defectRate,.055);assert.equal(r.summary.people,2);assert.equal(r.records[0].processName,'车缝');assert.equal(r.records[0].images.length,1);r=f.service.read({group:'车缝组',process:'车缝',query:'sku abc',personId:'103'},f.session(0));assert.equal(r.total,1);assert.equal(r.summary.count,2);assert.equal(f.service.read({query:'不存在'},f.session(0)).summary.defectRate,null);}finally{f.close();}});
test('未知工时/数量不会变成0，不良分项不全显示缺失；新数据使本地共享缓存失效',()=>{const f=fixture();try{f.service.read({},f.session(0));f.index(3,{numberofgoodProducts:null,numberofDefectives:5,effectiveTime:null,defectItemList:[]});const r=f.service.read({},f.session(0));assert.equal(r.total,3);assert.equal(r.summary.defectRate,null);assert.equal(r.summary.unknownDurationCount,1);assert.equal(r.summary.missingDefectCount,1);}finally{f.close();}});
test('日期完整性不冒充全历史，日期/分页校验、跨页及删除标记保持',()=>{const f=fixture();try{f.store.db.prepare('UPDATE blacklake_output_index SET deleted=1 WHERE output_id=?').run('2');let r=f.service.read({pageSize:'1'},f.session(1));assert.equal(r.total,1);assert.equal(r.sync.complete,true);assert.equal(f.service.read({from:'2026-11-15'},f.session(1)).sync.complete,false);assert.throws(()=>f.service.read({from:'2026-02-30'},f.session(1)),e=>e.status===422);assert.throws(()=>f.service.read({pageSize:'101'},f.session(1)),e=>e.status===422);}finally{f.close();}});
test('日期报表只读取有报工的工单资料和关联报工，保留快照里的工序与图片',()=>{
 const f=fixture();
 try{
  f.sync.indexOrder({projectId:300,projectCode:'2026-REP-300',productName:'无关工单',projectStatus:10});
  f.sync.save('order',300,{tasks:[{taskId:90,processName:'无关工序'}]});
  f.store.db.prepare("UPDATE blacklake_order_index SET details_json=json_remove(details_json,'$.productImageUrls') WHERE project_id=201").run();
  const prepare=f.store.db.prepare.bind(f.store.db),scoped=[];
  f.store.db.prepare=sql=>{
   assert.doesNotMatch(sql,/^SELECT (?:\* FROM blacklake_output_index|project_id,details_json FROM blacklake_order_index|target,data_json FROM blacklake_sync_snapshots WHERE kind='order')$/i);
   const stmt=prepare(sql);
   if(!/FROM (?:blacklake_order_index WHERE project_id|blacklake_sync_snapshots WHERE kind='order' AND target)/.test(sql))return stmt;
   return {get(id){scoped.push(String(id));return stmt.get(id);}};
  };
  const result=f.service.read({},f.session(0));
  assert.equal(result.total,2);
  assert.equal(result.records[0].processName,'车缝');
  assert.equal(result.records[0].images[0],'https://example.invalid/product.png');
  assert.deepEqual(scoped,['201','201']);
  assert.deepEqual(f.calls,[]);
  const queryPlan=prepare('EXPLAIN QUERY PLAN SELECT raw_json FROM blacklake_output_index WHERE deleted=0 AND created_at>=? AND created_at<? ORDER BY created_at DESC').all('2026-11-16','2026-11-17');
  assert(queryPlan.some(row=>row.detail.includes('blacklake_output_live_created')));
 }finally{f.close();}
});
test('多选员工先过滤同一日期范围内全部汇总，员工选项不随筛选和分页缩小',()=>{const f=fixture();try{
 f.index(3,{productionStaffId:109,productionStaff:'离职员工',approveStatus:10});
 f.index(4,{createdAt:'2026-11-15 14:00:00',numberofgoodProducts:1200});
 const report=f.service.read({personIds:'102,109',pageSize:'1',approval:'approved'},f.session(0));
 assert.equal(report.total,1);assert.equal(report.summary.count,2);assert.equal(report.summary.approvedCount,1);assert.equal(report.summary.pieceQuantity,180);
 assert.equal(report.people.length,2);assert.equal(report.employeeOptions.find(row=>row.id==='103').name,'质检组长');
 assert(report.employeeOptions.find(row=>row.id==='102').groups.includes('车缝组'));
 assert.equal(report.employeeOptions.find(row=>row.id==='109').name,'离职员工');
 assert.equal(f.service.read({personIds:'102',from:'2026-11-15',to:'2026-11-15'},f.session(0)).summary.pieceQuantity,1200);
 assert.throws(()=>f.service.read({personIds:'102,x'},f.session(0)),error=>error.status===422);assert.equal(f.calls.length,0);
}finally{f.close();}});
test('60次相同报表读取共享本地投影，所有报工合并后再分页，零上游请求',()=>{const f=fixture();try{for(let i=3;i<=103;i++)f.index(i);const page=f.service.read({page:'4',pageSize:'30'},f.session(0));assert.equal(page.total,103);assert.equal(page.records.length,13);assert.equal(page.hasMore,false);for(let i=0;i<60;i++)assert.equal(f.service.read({},f.session(i%3)).total,103);assert.equal(f.calls.length,0);}finally{f.close();}});

test('汇总的审批笔数跨页，排序先于分页，数量缺失放在末尾',()=>{
 const f=fixture();
 try{
  f.index(3,{approveStatus:0,createdAt:'2026-11-16 10:00:00',numberofgoodProducts:21});
  f.index(4,{approveStatus:0,createdAt:'2026-11-16 11:00:00',numberofgoodProducts:300});
  f.index(5,{approveStatus:0,createdAt:'2026-11-16 12:00:00',numberofgoodProducts:null});
  f.index(6,{approveStatus:10});
  const read=(sort,page=1)=>f.service.read({approval:'pending',sort,page,pageSize:1},f.session(0));
  const latest=read('latest');
  assert.equal(latest.summary.pendingApprovalCount,3);
  assert.equal(latest.summary.approvedCount,1);
  assert.equal(latest.records[0].id,'blacklake:5');
  assert.equal(read('oldest').records[0].id,'blacklake:3');
  assert.equal(read('quantity').records[0].id,'blacklake:4');
  assert.equal(read('quantity',2).records[0].id,'blacklake:3');
  assert.equal(read('quantity',3).records[0].id,'blacklake:5');
  assert.throws(()=>read('unsupported'),error=>error.status===422);
  assert.equal(f.calls.length,0);
 }finally{f.close();}
});

test('报表明细跨页总用时按筛选全部记录合计，分项与良不良率同范围',()=>{const f=fixture();try{for(let i=3;i<=33;i++)f.index(i);const result=f.service.read({page:'2',pageSize:'30',personId:'102'},f.session(0));assert.equal(result.records.length,2);assert.equal(result.selectionSummary.seconds,32*3600);assert.equal(result.selectionSummary.unknownDurationCount,0);}finally{f.close();}});

test('计件只累加同范围良品，人员汇总与跨页明细一致且不改不良率分母',()=>{const f=fixture();try{
 f.index(3,{numberofgoodProducts:1200,numberofDefectives:7,taskId:12,processName:'查片'});
 f.index(4,{createdAt:'2026-11-15 14:00:00',numberofgoodProducts:9999});
 let r=f.service.read({pageSize:'1',personId:'102'},f.session(0));
 assert.equal(r.pieceBasis,'good');assert.equal(r.summary.pieceQuantity,1389);assert.equal(r.summary.quantity,1407);assert.equal(r.selectionSummary.pieceQuantity,1290);assert.equal(r.people.find(p=>p.id==='102').pieceQuantity,1290);assert.equal(r.records.length,1);
 r=f.service.read({query:'查片'},f.session(0));assert.equal(r.summary.pieceQuantity,1200);
 r=f.service.read({group:'车缝组'},f.session(0));assert.equal(r.summary.pieceQuantity,1389);assert.equal(f.calls.length,0);
 }finally{f.close();}});

test('良品缺失不冒充0，修改良品或删除后计件总数和个人数同步变化',()=>{const f=fixture();try{
 f.index(3,{numberofgoodProducts:null});let r=f.service.read({},f.session(0));assert.equal(r.summary.pieceQuantity,null);assert.equal(r.summary.unknownPieceCount,1);assert.equal(r.people.find(p=>p.id==='102').pieceQuantity,null);assert.equal(r.people.find(p=>p.id==='103').pieceQuantity,99);
 f.store.db.prepare('UPDATE blacklake_output_index SET correction_json=? WHERE output_id=?').run(JSON.stringify({fineAmount:50,defectsAmount:10}),'3');
 r=f.service.read({},f.session(0));assert.equal(r.summary.pieceQuantity,239);assert.equal(r.people.find(p=>p.id==='102').pieceQuantity,140);
 f.store.db.prepare('UPDATE blacklake_output_index SET deleted=1 WHERE output_id=?').run('1');r=f.service.read({},f.session(0));assert.equal(r.summary.pieceQuantity,149);assert.equal(r.people.find(p=>p.id==='102').pieceQuantity,50);
 assert.equal(f.service.read({query:'无结果'},f.session(0)).summary.pieceQuantity,0);
 }finally{f.close();}});

test('真实HTTP报表须登录；普通员工只读且不能绕过界面编辑删除他人记录',async()=>{const f=fixture(),server=createServer(f.app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;try{
 assert.equal((await fetch(base+'/v1/workspace/reports')).status,401);
 for(let i=0;i<3;i++){const session=f.session(i),token=f.store.createSession(session.id).token,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};const response=await fetch(base+'/v1/workspace/reports',{headers}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.canManage,i!==1);if(i===1)for(const action of ['editor','edit','delete']){const res=await fetch(base+'/v1/workspace/process-reports/201/11/blacklake%3A1/'+action,{headers,method:action==='editor'?'GET':'POST',...(action==='editor'?{}:{body:JSON.stringify({expectedVersion:0})})});assert.equal(res.status,403);}}
 assert.equal(f.calls.length,0);
 }finally{await new Promise(resolve=>server.close(resolve));f.close();}});

test('明细直接携带工单产品规格和真实报工起止，无逐条上游读取',()=>{const f=fixture();try{
 const info={...JSON.parse(f.store.db.prepare('SELECT details_json FROM blacklake_order_index WHERE project_id=201').get().details_json),productSpecification:'深玫红 PU 手贴片'};f.sync.indexOrder(info);
 f.index(3,{starttimeofReport:'2026-11-16 13:30:00',endtimeofReport:'2026-11-16 14:00:00'});
 const row=f.service.read({},f.session(0)).records.find(r=>r.id==='blacklake:3');assert.equal(row.productCode,'SKU-ABC');assert.equal(row.productSpecification,'深玫红 PU 手贴片');assert.equal(row.startedAt,'2026-11-16T05:30:00.000Z');assert.equal(row.endedAt,'2026-11-16T06:00:00.000Z');assert.equal(f.calls.length,0);
}finally{f.close();}});

test('报工审批与撤回分别走真实队列和黑湖回读，单条未确认不拦其他记录',async()=>{
 const f=fixture(),server=createServer(f.app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  f.index(3,{approveStatus:0});f.index(4,{approveStatus:0});
  const upstream=new Map([[3,0],[4,0]]),writes=[];
  let lost=false,delayProjection=false;
  f.blacklake.withPriority=fn=>fn();
  f.blacklake.withDeferredRepeatedReads=fn=>fn();
  f.blacklake.nativeRequest=async(path,body,opts)=>{
   if(path.endsWith('/detail'))return {code:'01000000',data:{outputId:body.outputId,projectId:201,projectProcessId:11,approveStatus:upstream.get(body.outputId),blInApprove:false,updatedAt:'2026-11-16 18:00:00'}};
   assert.equal(path,'/api/dytin/output/approve');assert.equal(opts.write,true);assert.equal(opts.retryAuth,false);
   assert.equal(body.outputApproveList.length,1);const {outputId,approveStatus}=body.outputApproveList[0];writes.push([outputId,approveStatus]);
   if(!delayProjection)upstream.set(outputId,approveStatus);
   if(lost)throw Object.assign(Error('synthetic connection failure'),{code:'BLACKLAKE_TIMEOUT'});
   return {code:'01000000'};
  };
  const tokens=[0,1].map(i=>f.store.createSession(f.session(i).id).token),base='http://127.0.0.1:'+server.address().port;
  const submit=async(id,expected,key,actor=0,task=11)=>{
   const response=await fetch(base+'/v1/workspace/process-reports/201/'+task+'/blacklake%3A'+id+'/approval',{method:'POST',headers:{Authorization:'Bearer '+tokens[actor],'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({expectedStatus:expected,approved:expected===0})});
   return {status:response.status,body:await response.json()};
  };
  const record=(id)=>f.service.read({},f.session(0)).records.find(r=>r.id==='blacklake:'+id);
  assert.equal((await submit(3,0,'approval-employee-01',1)).status,403);
  assert.equal((await submit(3,0,'approval-wrong-task-01',0,12)).status,404);
  const first=await submit(3,0,'approval-first-test-01');assert.equal(first.status,202);
  assert.equal((await submit(3,0,'approval-first-test-01')).body.sync.id,first.body.sync.id);assert.equal(record(3).approvalStatus,0);
  assert.equal(record(3).canApprove,false);assert.equal(record(4).canApprove,true);
  lost=true;await f.sync.tick();assert.equal(record(3).approvalStatus,10);assert.equal(record(3).approvalSync,'SUCCEEDED');
  const approvedView=f.service.read({approval:'approved',pageSize:1},f.session(0));
  assert.equal(approvedView.total,1);
  assert.equal(approvedView.summary.approvedCount,1);
  assert.equal(approvedView.summary.pendingApprovalCount,1);
  lost=false;delayProjection=true;
  const revoke=await submit(3,10,'approval-revoke-test-01');assert.equal(revoke.status,202);
  await f.sync.tick();assert.equal(record(3).approvalSync,'UNKNOWN');assert.equal(record(3).approvalStatus,10);
  assert.equal(record(4).canApprove,true);assert.equal(f.sync.jobs.get(revoke.body.sync.id).safe_retry,0);
  upstream.set(3,0);f.sync.recovery.schedule();
  for(let i=0;i<6&&f.sync.jobs.get(revoke.body.sync.id).state==='UNKNOWN';i++)await f.sync.tick();
  assert.equal(record(3).approvalStatus,0);assert.equal(f.sync.jobs.get(revoke.body.sync.id).state,'SUCCEEDED');
  assert.deepEqual(writes,[[3,10],[3,0]]);
 }finally{await new Promise(resolve=>server.close(resolve));f.close();}
});
