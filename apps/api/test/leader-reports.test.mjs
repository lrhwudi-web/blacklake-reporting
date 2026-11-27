import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {LeaderReports} from '../src/leader-reports.mjs';
import {employeeDailySummary} from '../src/employee-daily-summary.mjs';
import {PeopleGroups} from '../src/people-groups.mjs';
import {loadDefectReasons} from '../src/defect-reasons.mjs';
import {nativeFixture} from './native-report-fixture.mjs';

async function fixture({native=false,reasons}={}) {
  const config={sessionSecret:'leader-reports-tests-only',sessionDays:1,agent:{enabled:false}},store=new Store(':memory:',config);
  const leaders=[101,102,103].map(id=>store.upsertBlacklakeOperator({blacklakeOperatorId:id,name:'同名组长'}));
  store.setEntryProfile(101,{appRole:'floor8_leader'});store.setEntryProfile(102,{appRole:'floor8_leader'});store.setEntryProfile(103,{appRole:'floor3_supervisor'});
  const worker=store.upsertBlacklakeOperator({blacklakeOperatorId:201,name:'测试员工'});
  const tokens=[...leaders,worker].map(w=>store.createSession(w.id).token),review=store.createSession(leaders[0].id,{scope:'review'}).token;
  let serial=0,mode='',delay;const outputs=new Map(),writes=[];
  const blacklake={supportsFullReportCorrection:true,listOperators:async()=>store.db.prepare('SELECT * FROM operators WHERE active=1 AND blacklake_operator_id<1000000000000').all().map(p=>({blacklakeOperatorId:p.blacklake_operator_id,name:p.name,groupNames:JSON.parse(p.group_names_json)})),readOutputForCorrection:async id=>{if(delay)await delay;if(mode==='read-fail')throw Error('read outage');if(!outputs.has(String(id)))throw Object.assign(Error('absent'),{definiteAbsence:true});return outputs.get(String(id));},
    updateOutputConfirmed:async(raw,input)=>{writes.push({action:'edit',id:raw.id,input});if(mode==='timeout')throw Error('response lost');Object.assign(raw,{fineAmount:input.goodAmount,defectsAmount:input.defectAmount,defectCodes:input.defectCodes,...(input.defectItems?{defectItems:input.defectItems}:{}),...(input.operatorId?{operatorId:input.operatorId}:{}),...(input.startedAt?{startedAt:input.startedAt,endedAt:input.endedAt}:{})});if(input.durationSeconds!==undefined)Object.assign(raw,{effectiveTime:input.durationSeconds,customFieldValues:[{fieldId:964471,name:'用料工序',value:input.materialProcess},{fieldId:940264,name:'打卡报工时长/分',value:String(input.punchMinutes)}]});if(mode==='after-write')throw Error('response lost');},
    deleteOutputConfirmed:async id=>{writes.push({action:'delete',id});if(mode==='timeout')throw Error('response lost');outputs.delete(String(id));}};
  const seed=({owner=101,date='2026-11-10',unit='A-03',status='COMPLETED',reportStatus='SUCCEEDED',outputId}={})=>{
    const id='report-assignment-'+(++serial),key=outputId||String(1000+serial),reportId='report-'+serial;
    store.dispatchAssignment({id,operatorId:worker.id,taskId:serial,projectId:501,projectCode:'TEST-WO',productName:'测试产品',processName:'车耳朵',quantity:100,stationName:unit,machineId:'',publishedBy:'同名组长',publishedByOperatorId:owner,publishedAt:'2026-11-09 08:00:00',flowCodeHash:'fixture'},{allowQueue:true});
    store.insertPendingReport({id:reportId,idempotencyKey:'report-key-'+serial,requestHash:'hash-'+serial,operatorId:worker.id,taskId:serial,projectId:501,projectCode:'TEST-WO',productName:'测试产品',processName:'车耳朵',amount:100,goodAmount:100,defectAmount:0,defectCode:'',outputTime:date+' 14:20:00'});
    store.db.prepare('UPDATE reports SET status=?,blacklake_output_id=? WHERE id=?').run(reportStatus,key,reportId);
    store.db.prepare('UPDATE assignments SET status=?,started_at=?,ended_at=?,duration_seconds=5700,report_id=? WHERE id=?').run(status,date+' 11:00:00',date+' 14:20:00',reportId,id);
    outputs.set(key,{id:key,projectId:501,projectProcessId:serial,operatorId:201,operatorName:worker.name,fineAmount:100,defectsAmount:0,defectItems:[],customFieldValues:[],startedAt:date+' 11:00:00',endedAt:date+' 14:20:00',planStartTime:date+' 11:00:00',planEndTime:date+' 14:20:00'});
    return {id,reportId,outputId:key};
  };
  const nativeDriver=native?nativeFixture():null,upstream=nativeDriver?.client??blacklake;if(nativeDriver)upstream.listOperators=blacklake.listOperators;
  const server=createServer(createApp({config,store,blacklake:upstream,wechat:{},defectReasons:reasons??[{code:'BL202504030001',name:'图案不符'},{code:'OTHER',name:'其他'}],now:()=>Date.parse('2026-11-10T18:00:00+08:00')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call=async(path,{who=0,method='GET',body,key='leader-'+randomUUID()}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(who===null?{}:{Authorization:'Bearer '+(who==='review'?review:tokens[who])}),'Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
  const list=()=>call('/v1/dispatch/reports?date=2026-11-10');
  return {store,seed,call,list,outputs,writes,blacklake:upstream,nativeDriver,setMode:v=>mode=v,setDelay:v=>delay=v,close:async()=>{await new Promise(r=>server.close(r));store.close();}};
}

test('工序报工管理允许组长跨派工人修改，普通员工仍不能获得全员管理权限',async()=>{
 const f=await fixture();try{const row=f.seed({owner:101}),service=new LeaderReports({store:f.store,blacklake:f.blacklake});
 assert.equal(service.owned(row.id,{ownerId:102,unitIds:['A-03'],scope:'all-process-reports'}).id,row.id);
 assert.throws(()=>service.owned(row.id,{ownerId:201,unitIds:['A-03'],scope:'all-process-reports'}),e=>e.code==='REPORT_MANAGEMENT_FORBIDDEN');
 assert.throws(()=>service.owned(row.id,{ownerId:102,unitIds:['A-03']}),e=>e.code==='REPORT_NOT_FOUND');
 }finally{await f.close();}
});

test('报工记录仅本人派工、对应楼层与日期，完整分页；同名/请求伪造不串记录',async()=>{
  const f=await fixture();try{
    for(let i=0;i<135;i++)f.seed();f.seed({owner:102});f.seed({date:'2026-11-09'});f.seed({unit:'3F-01'});f.seed({owner:null});
    const first=await f.call('/v1/dispatch/reports?date=2026-11-10&limit=30&ownerId=102');assert.equal(first.body.total,135);assert.equal(first.body.reports.length,30);assert.equal(first.body.hasMore,true);
    const next=await f.call('/v1/dispatch/reports?date=2026-11-10&limit=30&offset=120');assert.equal(next.body.reports.length,15);assert.equal(next.body.hasMore,false);assert.equal(next.body.source,'local_dispatch_reports');
    assert.equal((await f.call('/v1/dispatch/reports?date=2026-02-30')).status,422);assert.equal((await f.call('/v1/dispatch/reports?offset=-1')).status,422);
    for(const [who,status]of [[null,401],[3,403],['review',403]])assert.equal((await f.call('/v1/dispatch/reports',{who})).status,status);
  }finally{await f.close();}
});

test('本人修改数量同步黑湖确认后更新本地，原时间和人员不变，幂等与旧版本保护',async()=>{
  const f=await fixture();try{
    const {id,reportId}=f.seed(),record=(await f.list()).body.reports[0],key='leader-'+randomUUID(),body={expectedVersion:record.version,goodQuantity:75,defectQuantity:0,defectCodes:[]};
    const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,key});assert.equal(result.body.status,'SUCCEEDED');assert.equal(result.body.report.goodQuantity,75);
    assert.equal(f.store.reportById(reportId).good_amount,75);const assignment=f.store.assignmentById(id);assert.equal(assignment.durationSeconds,5700);assert.equal(assignment.startedAt,'2026-11-10 11:00:00');assert.equal(assignment.operatorName,'测试员工');
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,key})).body.status,'SUCCEEDED');assert.equal(f.writes.length,1);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body})).status,409);
    const audit=f.store.db.prepare('SELECT before_json,after_json FROM leader_report_operations').get();assert.equal(JSON.parse(audit.before_json).goodQuantity,100);assert.equal(JSON.parse(audit.after_json).goodQuantity,75);
  }finally{await f.close();}
});

test('删除须黑湖成功，保留审计和本地墓碑；其他组长不能改/删',async()=>{
  const f=await fixture();try{
    const {id,reportId}=f.seed(),record=(await f.list()).body.reports[0],body={expectedVersion:record.version};
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/delete',{who:1,method:'POST',body})).status,404);assert.equal(f.writes.length,0);
    const result=await f.call('/v1/dispatch/reports/'+id+'/delete',{method:'POST',body});assert.equal(result.body.status,'SUCCEEDED');assert.equal(result.body.report.deleted,true);assert.equal(result.body.report.canEdit,false);
    assert.equal(f.store.reportById(reportId).status,'DELETED');assert.equal(f.store.assignmentById(id).status,'CANCELLED');assert.equal((await f.list()).body.reports[0].deleted,true);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM assignment_actions WHERE action='LEADER_DELETE_REPORT'").get().n,1);
  }finally{await f.close();}
});

test('响应不明锁住记录、不改数量、不自动重发；读失败为明确未发送',async()=>{
  const f=await fixture();try{
    const {id,reportId}=f.seed();let record=(await f.list()).body.reports[0];const body={expectedVersion:record.version,goodQuantity:50,defectQuantity:0,defectCodes:[]};
    f.setMode('read-fail');const failed=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body});assert.equal(failed.body.status,'FAILED');assert.equal(f.writes.length,0);
    f.setMode('timeout');const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body});assert.equal(result.body.status,'UNKNOWN');assert.equal(f.store.reportById(reportId).good_amount,100);
    record=(await f.list()).body.reports[0];assert.equal(record.canEdit,false);assert.equal(record.mutationStatus,'UNKNOWN');
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/delete',{method:'POST',body:{expectedVersion:record.version}})).status,409);assert.equal(f.writes.length,1);
  }finally{await f.close();}
});

test('提交前重读身份和状态，外部改量/身份错配与并发请求不覆盖或重复写',async()=>{
  const f=await fixture();let release;try{
    const {id,outputId}=f.seed(),record=(await f.list()).body.reports[0],body={expectedVersion:record.version,goodQuantity:40,defectQuantity:0,defectCodes:[]};
    f.outputs.get(outputId).operatorId=999;assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body})).body.status,'FAILED');assert.equal(f.writes.length,0);
    f.outputs.get(outputId).operatorId=201;f.setDelay(new Promise(r=>release=r));const pending=f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body});
    while(!f.store.db.prepare("SELECT 1 FROM leader_report_operations WHERE status='CHECKING'").get())await new Promise(r=>setTimeout(r,1));
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body})).status,409);release();assert.equal((await pending).body.status,'SUCCEEDED');assert.equal(f.writes.length,1);
  }finally{release?.();await f.close();}
});

test('真实BlacklakeClient遵守官方OpenAPI按ID查询、局部修改和单条删除载荷',async()=>{
  const calls=[];let remote={reportingId:'991',projectId:501,projectCode:'WO',taskId:'201',productionStaffId:301,numberofgoodProducts:'100',numberofDefectives:'0',defectItemList:[]};
  const client=new BlacklakeClient({mode:'live',baseUrl:'https://official-contract.invalid',staticToken:'TEST_ONLY',outputQueryPath:'/api/dytin/external/output/queryList3',timeoutMs:1000},async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    if(url.endsWith('/queryList3')){assert.equal(body.id,991);return Response.json({code:'01000000',data:{list:[remote]}});}
    if(url.endsWith('/modify')){remote={...remote,numberofgoodProducts:String(body.fineAmount),numberofDefectives:String(body.defectsAmount),defectItemList:body.defectList};return Response.json({code:'01000000',data:null});}
    return Response.json({code:'01000000',data:1});
  });
  const original=await client.readOutputForCorrection(991);await client.updateOutputConfirmed(original,{goodAmount:80,defectAmount:0,defectCodes:[]});
  const sent=calls.find(c=>c.url.endsWith('/modify')).body;
  assert.deepEqual(sent,{outputId:991,outputAmount:80,fineAmount:80,defectsAmount:0,defectList:[]});
  for(const field of ['operatorId','operatorName','planStartTime','planEndTime','effectiveTime','customFieldValueList','output'])assert.equal(field in sent,false);
  assert.equal(calls.filter(c=>c.url.endsWith('/queryList3')).length,2);
  await client.deleteOutputConfirmed(991);assert.deepEqual(calls.at(-1).body,{outputIds:[991]});
});

test('进程重新初始化后遗留PENDING变UNKNOWN，不能当失败重试',async()=>{
  const f=await fixture();try{const {id,reportId}=f.seed();await f.list();f.store.db.prepare("INSERT INTO leader_report_operations(id,report_id,assignment_id,owner_id,action,request_hash,status,before_json,after_json,created_at,updated_at) VALUES('interrupted',?,?,101,'edit','hash','PENDING','{}','{}','2026-11-10','2026-11-10')").run(reportId,id);f.store.leaderReportsRecovered=false;
    const service=new LeaderReports({store:f.store,blacklake:{}});assert.equal(service.present(service.owned(id,{ownerId:101,unitIds:['A-03']})).mutationStatus,'UNKNOWN');
  }finally{await f.close();}
});

test('黑湖已改量但本地审计失败时整笔投影回滚且操作锁保留，不能再次写黑湖',async()=>{
  const f=await fixture();try{
    const {id,reportId}=f.seed(),record=(await f.list()).body.reports[0],key='leader-'+randomUUID(),body={expectedVersion:record.version,goodQuantity:60,defectQuantity:0,defectCodes:[]};
    f.store.db.exec("CREATE TRIGGER fail_leader_audit BEFORE INSERT ON assignment_actions WHEN NEW.action='LEADER_EDIT_REPORT' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,key});assert.equal(result.status,409);assert.equal(result.body.error.code,'REPORT_CHANGE_LOCAL_REVIEW');
    assert.equal(f.store.reportById(reportId).good_amount,100);assert.equal(f.writes.length,1);assert.equal((await f.list()).body.reports[0].canEdit,false);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,key})).body.status,'UNKNOWN');assert.equal(f.writes.length,1);
    f.store.db.exec('DROP TRIGGER fail_leader_audit');assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');
    assert.equal(f.store.reportById(reportId).good_amount,60);assert.equal(f.writes.length,1);
  }finally{await f.close();}
});

test('OpenAPI删除数量未确认为1时不冒充成功，查询错ID和未知数量拒绝用于修改',async()=>{
  for(const amount of [0,null,2]){
    const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',timeoutMs:1000},async()=>Response.json({code:'01000000',data:amount}));
    await assert.rejects(()=>client.deleteOutputConfirmed(991),e=>e.code==='BLACKLAKE_REPORT_DELETE_UNCONFIRMED');
  }
  for(const row of [{reportingId:'992',numberofgoodProducts:'100',numberofDefectives:'0'},{reportingId:'991',numberofgoodProducts:null,numberofDefectives:'0'}]){
    const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',outputQueryPath:'/query',timeoutMs:1000},async()=>Response.json({code:'01000000',data:{list:[row]}}));
    await assert.rejects(()=>client.readOutputForCorrection(991),e=>e.code==='BLACKLAKE_REPORT_DETAIL_INVALID');
  }
});

test('未知修改只读核对目标数量、原因及身份，确认后只投影一次且不重写黑湖',async()=>{
  const f=await fixture();try{
    const {id,outputId,reportId}=f.seed(),record=(await f.list()).body.reports[0];f.setMode('timeout');
    await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{expectedVersion:record.version,goodQuantity:60,defectQuantity:0,defectCodes:[]}});
    assert.equal((await f.list()).body.reports[0].canReconcile,true);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST',who:1})).status,404);
    const remote=f.outputs.get(outputId);remote.fineAmount=60;
    for(const [field,wrong]of [['projectId',999],['operatorId',999],['projectProcessId',999],['defectCodes',['OTHER']]]){
      const prior=remote[field];remote[field]=wrong;
      assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');remote[field]=prior;
    }
    assert.equal(f.store.reportById(reportId).good_amount,100);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'NO_PENDING');
    assert.equal(f.store.reportById(reportId).good_amount,60);assert.equal(f.writes.length,1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM assignment_actions WHERE action='LEADER_EDIT_REPORT'").get().n,1);
  }finally{await f.close();}
});

test('未知删除仅精确ID确认不存在后落墓碑，读取失败或仍存在时保留锁',async()=>{
  const f=await fixture();try{
    const {id,outputId,reportId}=f.seed(),record=(await f.list()).body.reports[0];f.setMode('timeout');
    await f.call('/v1/dispatch/reports/'+id+'/delete',{method:'POST',body:{expectedVersion:record.version}});
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');
    f.outputs.delete(outputId);f.setMode('read-fail');assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');
    f.setMode('');assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');
    assert.equal(f.store.reportById(reportId).status,'DELETED');assert.equal(f.writes.length,1);
    await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'});
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM assignment_actions WHERE action='LEADER_DELETE_REPORT'").get().n,1);
  }finally{await f.close();}
});

test('核验与发送进行中不能被核对请求提前结算',async()=>{
  const f=await fixture();let release;try{
    const {id,outputId}=f.seed(),record=(await f.list()).body.reports[0];f.setDelay(new Promise(r=>release=r));
    const pending=f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{expectedVersion:record.version,goodQuantity:80,defectQuantity:0,defectCodes:[]}});
    while(!f.store.db.prepare("SELECT 1 FROM leader_report_operations WHERE status='CHECKING'").get())await new Promise(r=>setTimeout(r,1));
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'CHECKING');
    f.store.db.prepare("UPDATE leader_report_operations SET status='PENDING'").run();f.outputs.get(outputId).fineAmount=80;
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'PENDING');
    f.outputs.get(outputId).fineAmount=100;release();assert.equal((await pending).body.status,'SUCCEEDED');assert.equal(f.writes.length,1);
  }finally{release?.();await f.close();}
});

test('质检修改原因与数量一起校验，上游仅改原因也不可覆盖',async()=>{
  const f=await fixture();try{
    const {id,reportId,outputId}=f.seed();f.store.db.prepare('UPDATE assignments SET quality_inspection=1 WHERE id=?').run(id);
    const record=(await f.list()).body.reports[0],body={expectedVersion:record.version,goodQuantity:80,defectQuantity:5,defectCodes:['BL202504030001']};
    assert.equal(record.isQualityInspection,true);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{...body,defectCodes:['INVALID']}})).status,422);
    assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body})).body.status,'SUCCEEDED');
    assert.equal(f.store.reportById(reportId).defect_code,'BL202504030001');assert.equal(f.store.reportById(reportId).defect_amount,5);
    f.outputs.get(outputId).defectCodes=['OTHER'];const latest=(await f.list()).body.reports[0];
    const conflict=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{...body,expectedVersion:latest.version,goodQuantity:70}});
    assert.equal(conflict.body.status,'FAILED');assert.equal(f.writes.length,1);
  }finally{await f.close();}
});

test('本系统成员使用报工时冻结的上游提交身份，仍以实际员工与原组长隔离',async()=>{
  const f=await fixture();try{
    const member=await f.store.members.save({name:'独立成员',groupNames:[],submitAsId:301,operationId:randomUUID()},{actor:'TEST',upstream:{listOperators:async()=>[{blacklakeOperatorId:301,name:'提交人'}]}});
    const {id,reportId,outputId}=f.seed(),operator=f.store.findOperatorByBlacklakeId(member.personId);
    f.store.db.prepare('UPDATE assignments SET operator_id=? WHERE id=?').run(operator.id,id);
    f.store.db.prepare('UPDATE reports SET operator_id=? WHERE id=?').run(operator.id,reportId);
    f.store.db.prepare('INSERT INTO report_submission_identities(report_id,actual_operator_id,actual_name,submit_as_id,submit_as_name,member_revision) VALUES(?,?,?,?,?,?)').run(reportId,operator.id,member.name,301,'提交人',member.revision);
    f.outputs.get(outputId).operatorId=301;const record=(await f.list()).body.reports[0];assert.equal(record.operatorName,'独立成员');
    const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{expectedVersion:record.version,goodQuantity:88,defectQuantity:0,defectCodes:[]}});
    assert.equal(result.body.status,'SUCCEEDED');assert.equal(result.body.report.operatorName,'独立成员');
    assert.equal((await f.call('/v1/dispatch/reports?date=2026-11-10',{who:1})).body.total,0);
    assert.equal(f.store.members.snapshot(reportId).submitAsId,301);
  }finally{await f.close();}
});

test('精确ID查询空结果才可证明删除，不把错ID或异常响应当作不存在',async()=>{
  for(const [list,total,absent]of [[[],0,true],[[],undefined,true],[[{reportingId:'992',numberofgoodProducts:1,numberofDefectives:0}],1,false],[[],1,false]]){
    const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',outputQueryPath:'/query',timeoutMs:1000},async()=>Response.json({code:'01000000',data:{list,total}}));
    await assert.rejects(()=>client.readOutputForCorrection(991),e=>Boolean(e.definiteAbsence)===absent);
  }
});

const fullInput=(report,extra={})=>({expectedVersion:report.version,expectedRemoteVersion:report.remoteVersion,goodQuantity:80,defectQuantity:0,defectCodes:[],defectItems:[],operatorId:report.operatorId,startedAt:'2026-11-10 09:00:00',endedAt:'2026-11-10 10:00:00',durationSeconds:1800,materialProcess:'用料核对',...extra});
test('组长可更正本人派工普通工序的不良，不改变员工原质检身份且不能修改其他组长记录',async()=>{
 const f=await fixture();try{
  const {id,reportId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;
  assert.equal(record.isQualityInspection,false);assert.equal(record.canEditDefects,true);
  const body={expectedVersion:record.version,goodQuantity:95,defectQuantity:5,defectCodes:['BL202504030001'],defectItems:[{code:'BL202504030001',amount:5}]};
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,who:1})).status,404);
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body,who:3})).status,403);
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body});assert.equal(result.body.status,'SUCCEEDED');
  assert.equal(f.store.reportById(reportId).defect_amount,5);assert.equal(f.store.assignmentById(id).isQualityInspection,false);assert.equal(f.writes.length,1);
 }finally{await f.close();}
});
test('完整HTTP编辑贯通真实client、原生请求、SQLite计划持久化及原字段回读',async()=>{
 const f=await fixture({native:true});try{
  const {id,reportId}=f.seed(),editor=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body;
  assert.equal(editor.report.fullSyncReady,true);assert.equal(editor.report.durationSeconds,5700);assert.equal(editor.report.production.punchMinutes,200);
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(editor.report)});
  assert.equal(result.body.status,'SUCCEEDED',JSON.stringify(result.body));assert.equal(result.body.report.durationSeconds,1800);
  const op=f.store.db.prepare('SELECT * FROM leader_report_operations WHERE report_id=?').get(reportId);assert(JSON.parse(op.after_json).nativePlan.expected);assert(JSON.parse(op.before_json).upstreamBefore);
  assert.equal(f.nativeDriver.calls.filter(c=>c.url.endsWith('/update')).length,1);assert.equal(f.store.assignmentById(id).startedAt,'2026-11-10 11:00:00');
 }finally{await f.close();}
});
test('原生完整写入丢回执后保留持久计划，重启及回读全部字段才能一次恢复',async()=>{
 const f=await fixture({native:true});try{
  const {id,reportId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;f.nativeDriver.setMode('after-write');
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record)})).body.status,'UNKNOWN');assert.equal(f.store.reportById(reportId).good_amount,100);
  f.store.leaderReportsRecovered=false;new LeaderReports({store:f.store,blacklake:f.blacklake});f.nativeDriver.setMode('');
  const field=f.nativeDriver.remote.customFieldValues.find(f=>f.fieldId===864387),expected=field.value;field.value='0.88';
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');field.value=expected;
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');assert.equal(f.store.reportById(reportId).good_amount,80);
  assert.equal(f.nativeDriver.calls.filter(c=>c.url.endsWith('/update')).length,1);assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'NO_PENDING');
 }finally{await f.close();}
});
test('带加班的原生修改丢回执后，恢复必须核对加班原值且不能再发写请求',async()=>{
 const f=await fixture({native:true});try{
  f.nativeDriver.remote.overtimeTime=1800;
  const {id,reportId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;f.nativeDriver.setMode('after-write');
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record)})).body.status,'UNKNOWN');
  const op=f.store.db.prepare('SELECT after_json FROM leader_report_operations WHERE report_id=?').get(reportId);
  assert.equal(JSON.parse(op.after_json).nativePlan.expected.overtimeTime,1800);
  assert.equal(f.nativeDriver.remote.overtimeTime,1800);f.nativeDriver.setMode('');f.nativeDriver.remote.overtimeTime=0;
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');assert.equal(f.store.reportById(reportId).good_amount,100);
  f.nativeDriver.remote.overtimeTime=1800;
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');assert.equal(f.store.reportById(reportId).good_amount,80);
  assert.equal(f.nativeDriver.calls.filter(c=>c.url.endsWith('/update')).length,1);
 }finally{await f.close();}
});
test('原生公式计算失败与计算期间并发修改，均不发更新或落本地更正',async()=>{
 for(const mode of ['bad-formula','external-change']){const f=await fixture({native:true});try{
  const {id,reportId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;f.nativeDriver.setMode(mode);
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record)});assert.equal(result.body.status,'FAILED');assert.equal(f.nativeDriver.calls.filter(c=>c.url.endsWith('/update')).length,0);assert.equal(f.store.reportById(reportId).good_amount,100);
 }finally{await f.close();}}
});
test('未验证有效工时同步时完整编辑在持久操作与业务写入前阻止，旧数量编辑保持',async()=>{
 const f=await fixture();try{
  f.blacklake.supportsFullReportCorrection=false;const {id,reportId}=f.seed();
  const editor=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body;
  assert.equal(editor.report.fullSyncReady,false);assert.equal(editor.extraScope,'BLACKLAKE_REQUIRED_PENDING');
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(editor.report)});
  assert.equal(result.status,422);assert.equal(result.body.error.code,'BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED');assert.equal(f.writes.length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM leader_report_operations').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_production_details').get().n,0);assert.equal(f.store.reportById(reportId).good_amount,100);
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{expectedVersion:editor.report.version,goodQuantity:80,defectQuantity:0,defectCodes:[]}})).body.status,'SUCCEEDED');
 }finally{await f.close();}
});
test('完整编辑UNKNOWN恢复必须同时核对工时、用料和公式时长；不因数量时间一致提前成功',async()=>{
 const f=await fixture();try{
  const {id,reportId,outputId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;f.setMode('after-write');
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record)})).body.status,'UNKNOWN');
  const remote=f.outputs.get(outputId);
  for(const bad of ['effectiveTime','material','punch']){
   const prior=structuredClone(remote);
   if(bad==='effectiveTime')remote.effectiveTime=1801;
   else remote.customFieldValues.find(f=>f.fieldId===(bad==='material'?964471:940264)).value=bad==='material'?'错误':'30';
   assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');
   assert.equal(f.store.reportById(reportId).good_amount,100);Object.assign(remote,prior);
  }
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');assert.equal(f.writes.length,1);
 }finally{await f.close();}
});
test('完整编辑更正实际生产人员、时间与工时，原派工人员/计时保持，个人记录与今日统计归新人员',async()=>{
 const f=await fixture();try{
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:202,name:'新生产人员'});const {id,reportId}=f.seed();
  const before=f.store.assignmentById(id),editor=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(editor.status,200);assert(editor.body.people.some(p=>p.operatorId===202));assert(!editor.body.people.some(p=>p.operatorId===101));
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(editor.body.report,{operatorId:202})});assert.equal(result.body.status,'SUCCEEDED',JSON.stringify(result.body));
  assert.equal(result.body.report.operatorName,'新生产人员');assert.equal(result.body.report.originalOperatorName,'测试员工');assert.equal(result.body.report.durationSeconds,1800);
  assert.equal(f.store.assignmentById(id).operatorId,before.operatorId);assert.equal(f.store.assignmentById(id).startedAt,before.startedAt);
  const target=f.store.findOperatorByBlacklakeId(202);assert.equal(f.store.reportById(reportId).operator_id,target.id);assert.equal(f.store.recentReports(target.id)[0].goodAmount,80);assert.equal(f.store.recentReports(before.operatorId).length,0);
  const now=()=>Date.parse('2026-11-10T18:00:00+08:00');assert.equal(employeeDailySummary(f.store,201,{now}).completedCount,0);assert.equal(employeeDailySummary(f.store,202,{now}).workSeconds,1800);
  const saved=JSON.parse(f.store.db.prepare('SELECT data_json FROM report_production_details WHERE report_id=?').get(reportId).data_json);assert.equal(saved.materialProcess,'用料核对');assert.equal(saved.punchMinutes,60);assert.equal(saved.durationMode,'MANUAL');
  assert.equal(f.writes[0].input.operatorId,202);assert.equal(f.writes[0].input.durationSeconds,1800);assert.equal(f.writes[0].input.materialProcess,'用料核对');
 }finally{await f.close();}
});

test('完整编辑的楼层/归属、上游版本、时间与有效工时校验在写入前拒绝',async()=>{
 const f=await fixture();try{
  const {id,outputId}=f.seed();assert.equal((await f.call('/v1/dispatch/reports/'+id+'/editor',{who:1})).status,404);
  const record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;
  for(const extra of [{operatorId:101},{startedAt:'2026-02-30 09:00:00'},{endedAt:'2026-11-11 10:00:00'},{durationSeconds:4000},{punchMinutes:31},{expectedRemoteVersion:''}]){
   assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record,extra)})).status,422);
  }
  f.outputs.get(outputId).endedAt='2026-11-10 14:30:00';const changed=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record)});assert.equal(changed.body.status,'FAILED');assert.equal(f.writes.length,0);
 }finally{await f.close();}
});

test('完整编辑回执丢失后核对新身份和时间一次恢复，不改原派工也不重复发写请求',async()=>{
 const f=await fixture();try{
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:202,name:'新生产人员'});const {id,reportId,outputId}=f.seed(),record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;f.setMode('after-write');
  const body=fullInput(record,{operatorId:202}),result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body});assert.equal(result.body.status,'UNKNOWN');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_production_details').get().n,0);
  f.outputs.get(outputId).startedAt='2026-11-10 09:30:00';assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'UNKNOWN');
  f.outputs.get(outputId).startedAt=body.startedAt;assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');
  assert.equal(f.writes.length,1);assert.equal(f.store.reportById(reportId).operator_id,f.store.findOperatorByBlacklakeId(202).id);
  assert.equal(f.store.assignmentById(id).operatorName,'测试员工');assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'NO_PENDING');
 }finally{await f.close();}
});

test('质检逐项不良分配必须合计一致，更正到本系统成员只发送其真实黑湖代报身份',async()=>{
 const f=await fixture();try{
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:301,name:'真实提交人'});const member=await f.store.members.save({name:'实际本系统成员',groupNames:[],submitAsId:301,operationId:randomUUID()},{actor:'TEST',upstream:{listOperators:async()=>[{blacklakeOperatorId:301,name:'真实提交人'}]}});
  const {id,reportId,outputId}=f.seed();f.store.db.prepare('UPDATE assignments SET quality_inspection=1 WHERE id=?').run(id);
  const record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report,body=fullInput(record,{operatorId:member.personId,goodQuantity:70,defectQuantity:10,defectCodes:['BL202504030001','OTHER'],defectItems:[{code:'BL202504030001',amount:3},{code:'OTHER',amount:7}]});
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:{...body,defectItems:[{code:'BL202504030001',amount:3},{code:'OTHER',amount:6}]}})).status,422);
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body})).body.status,'SUCCEEDED');assert.equal(f.writes[0].input.operatorId,301);assert.notEqual(f.writes[0].input.operatorId,member.personId);
  assert.equal(f.store.reportById(reportId).operator_id,f.store.findOperatorByBlacklakeId(member.personId).id);assert.equal((await f.list()).body.reports[0].operatorName,'实际本系统成员');
  const next=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;assert.equal(next.production.upstreamOperatorId,301);assert.equal(next.submissionIdentity.actualName,'实际本系统成员');assert.equal(next.submissionIdentity.submitAsName,'真实提交人');assert.equal(next.defectItems[1].amount,7);
  const mapped=f.store.members.assignmentsForOutputs([{id:outputId}])[0];assert.equal(mapped.operatorId,f.store.findOperatorByBlacklakeId(member.personId).id);assert.equal(mapped.operatorName,'实际本系统成员');assert.equal(mapped.durationSeconds,1800);assert.equal(mapped.submissionIdentity.submitAsId,301);assert.notEqual(mapped.originalAssignedOperatorId,mapped.operatorId);
 }finally{await f.close();}
});

test('官方局部更新完整字段与不良明细，省略未定义的工时及附加字段并回读身份时间',async()=>{
 let remote={reportingId:991,projectId:501,taskId:201,productionStaffId:301,numberofgoodProducts:100,numberofDefectives:0,starttimeofReport:'2026-11-10 08:00:00',endtimeofReport:'2026-11-10 09:00:00',defectItemList:[]};const calls=[];
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',outputQueryPath:'/query',timeoutMs:1000},async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(url.endsWith('/modify')){remote={...remote,productionStaffId:body.operatorId,numberofgoodProducts:body.fineAmount,numberofDefectives:body.defectsAmount,starttimeofReport:body.planStartTime,endtimeofReport:body.planEndTime,defectItemList:body.defectList};return Response.json({code:'01000000',data:null});}return Response.json({code:'01000000',data:{list:[remote]}});});
 const original=await client.readOutputForCorrection(991);await client.updateOutputConfirmed(original,{goodAmount:70,defectAmount:10,defectCodes:['A','B'],defectItems:[{code:'A',amount:3},{code:'B',amount:7}],operatorId:302,operatorName:'更正人员',startedAt:'2026-11-10 09:00:00',endedAt:'2026-11-10 10:00:00'});
 const body=calls.find(c=>c.url.endsWith('/modify')).body;assert.equal(body.operatorId,302);assert.equal(body.planStartTime,'2026-11-10 09:00:00');assert.deepEqual(body.defectList,[{code:'A',amount:3},{code:'B',amount:7}]);
 assert.equal(body.effectiveTime,undefined);assert.equal(body.customFieldValueList,undefined);assert.equal(body.durationSeconds,undefined);
});

test('手工有效工时遇到并行或跨日不能确定分配时，今日统计保留未知，不猜算时长',async()=>{
 for(const crossDay of [false,true]){const f=await fixture();try{
  const {id}=f.seed();if(!crossDay){const other=f.seed();f.store.db.prepare("UPDATE assignments SET started_at='2026-11-10 09:30:00',ended_at='2026-11-10 10:30:00' WHERE id=?").run(other.id);}
  const record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report,extra=crossDay?{startedAt:'2026-11-09 23:00:00',endedAt:'2026-11-10 01:00:00',durationSeconds:3600}:{};
  assert.equal((await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record,extra)})).body.status,'SUCCEEDED');
  const summary=employeeDailySummary(f.store,201,{now:()=>Date.parse('2026-11-10T18:00:00+08:00')});assert.equal(summary.workSeconds,null);assert.equal(summary.completeWithinScope,false);if(!crossDay)assert.equal(summary.manualOverlapCount,1);
 }finally{await f.close();}}
});

test('完整编辑上游成功后本地更正表故障回滚人员、数量及详情，只读核对可恢复',async()=>{
 const f=await fixture();try{
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:202,name:'新生产人员'});const {id,reportId}=f.seed(),original=f.store.reportById(reportId).operator_id,record=(await f.call('/v1/dispatch/reports/'+id+'/editor')).body.report;
  f.store.db.exec("CREATE TRIGGER fail_production_projection BEFORE INSERT ON report_production_details BEGIN SELECT RAISE(ABORT,'fixture'); END");
  const result=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:fullInput(record,{operatorId:202})});assert.equal(result.status,409);assert.equal(f.store.reportById(reportId).operator_id,original);assert.equal(f.store.reportById(reportId).good_amount,100);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_production_details').get().n,0);
  f.store.db.exec('DROP TRIGGER fail_production_projection');assert.equal((await f.call('/v1/dispatch/reports/'+id+'/reconcile',{method:'POST'})).body.status,'SUCCEEDED');assert.equal(f.writes.length,1);assert.equal(f.store.reportById(reportId).operator_id,f.store.findOperatorByBlacklakeId(202).id);
 }finally{await f.close();}
});


test('报工编辑人员遵循后台分类的名称成员顺序空组及全部位置，返回完整7项正式不良原因',async()=>{
 const reasons=await loadDefectReasons(new URL('../../../data/analysis/defect-reasons.json',import.meta.url));const f=await fixture({reasons});try{
  f.store.upsertBlacklakeOperator({blacklakeOperatorId:202,name:'乙员工',groupNames:['上游旧部门']});const {id}=f.seed(),groups=new PeopleGroups(f.store.db);
  groups.save([{id:'empty',name:'空分类',blacklakeOperatorIds:[]},{id:'b',name:'后台后道',blacklakeOperatorIds:[202,101]},{id:'a',name:'后台缝制',blacklakeOperatorIds:[201]}],0,'admin',[],{allPosition:2});
  const r=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(r.status,200);assert.equal(r.body.peopleGroupConfig.allPosition,2);assert.deepEqual(r.body.peopleGroupConfig.groups,[{id:'empty',name:'空分类',operatorIds:[]},{id:'b',name:'后台后道',operatorIds:[202]},{id:'a',name:'后台缝制',operatorIds:[201]}]);
  assert.deepEqual(r.body.people.find(p=>p.operatorId===202).departments,['后台后道']);assert(!r.body.people.some(p=>p.operatorId===101));assert.deepEqual(r.body.report.defectReasons,reasons);assert.equal(reasons.length,7);
  const input=fullInput(r.body.report,{goodQuantity:93,defectQuantity:7,defectCodes:reasons.map(r=>r.code),defectItems:reasons.map(r=>({code:r.code,amount:1}))});const saved=await f.call('/v1/dispatch/reports/'+id+'/edit',{method:'POST',body:input});assert.equal(saved.body.status,'SUCCEEDED');assert.equal(f.writes[0].input.defectItems.length,7);
  groups.save([{id:'a',name:'改名缝制',blacklakeOperatorIds:[201]},{id:'empty',name:'空分类',blacklakeOperatorIds:[]}],1,'admin',[],{allPosition:1});const fresh=await f.call('/v1/dispatch/reports/'+id+'/editor');assert.equal(fresh.body.peopleGroupConfig.revision,2);assert.equal(fresh.body.peopleGroupConfig.allPosition,1);assert.equal(fresh.body.peopleGroupConfig.groups[0].name,'改名缝制');
 }finally{await f.close();}
});
