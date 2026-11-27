import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {createApp} from '../src/app.mjs';
import {AppError} from '../src/errors.mjs';
import {processEditLocksTask} from '../src/order-process-edits.mjs';

function processRow(id,definitionId,planAmount=100){
 return {projectId:201,projectProcessId:id,processId:definitionId,processName:'工序 '+definitionId,planAmount,outputRate:1,
  processStartTime:'2026-11-01 08:00:00',processEndTime:'2026-11-30 18:00:00',inspectionMethod:[],inspectionSpecificationId:null,
  processingType:0,processStatus:0,realAmount:0,defectsAmount:0,customFieldValues:[],distributeUserIds:[]};
}
async function fixture(){
 const config={sessionSecret:'test-process-edits',sessionDays:1,adminApiKey:'synthetic-admin',floor8EmployeeIds:[],agent:{enabled:false},review:{enabled:false}};
 const store=new Store(':memory:',config);
 const roster=[{blacklakeOperatorId:101,name:'组长',groupNames:['生产组']},{blacklakeOperatorId:102,name:'员工',groupNames:['生产组']}];
 const tokens=roster.map(person=>store.createSession(store.upsertBlacklakeOperator(person).id).token);
 store.setEntryProfile(101,{appRole:'floor8_leader'});
 const project={id:201,projectCode:'QA-201',productId:901,productCode:'SKU-901',status:10,planAmount:100,priority:0,remark:'保留备注',
  planStartTime:'2026-11-01 08:00:00',planEndTime:'2026-11-30 18:00:00',customFieldValues:[{fieldId:99,value:'保留'}]};
 const remote={project,rows:[processRow(301,11),{...processRow(302,12),realAmount:3,processStatus:10}],materials:[],writes:[],failure:'',readBlocked:false};
 const definitions=[{id:11,name:'包装',code:'P11'},{id:12,name:'质检',code:'P12'},{id:13,name:'封箱',code:'P13'}];
 const native=async(path,input)=>{
  if(path.endsWith('/project/web/detail')){
   if(remote.readBlocked)throw new AppError(502,'BLACKLAKE_TIMEOUT','合成回读失败');
   return {code:'01000000',data:{project,productionMaterialsList:remote.materials,
    processList:remote.rows.map(row=>({type:1,projectProcessList:[row]}))}};
  }
  if(path.endsWith('/process/dropDown'))return {code:'01000000',data:{data:definitions,total:3}};
  if(path.endsWith('/process/queryById')){
   const item=definitions.find(row=>row.id===input.id);
   return {code:'01000000',data:item&&{...item,processingType:0,outputRate:1}};
  }
  assert.equal(path,'/api/dytin/project/update');
  remote.writes.push(structuredClone(input));
  const payload=input.project;
  assert.equal(payload.remark,project.remark);
  assert.deepEqual(payload.customFieldValueList,project.customFieldValues);
  remote.rows=payload.techAndProcessList.map((group,index)=>{
   assert.equal(group.processRoutingSeq,index+1);
   const row=group.projectProcessList[0];
   const prior=remote.rows.find(current=>current.projectProcessId===row.projectProcessId);
   return {...(prior||processRow(302+remote.writes.length,row.processId)),...row,customFieldValues:row.customFieldValueList};
  });
  if(remote.failure==='lost'){
   remote.readBlocked=true;
   throw new AppError(502,'BLACKLAKE_TIMEOUT','合成回执丢失');
  }
  return {code:'01000000'};
 };
 const blacklake={nativeRequest:native,listOperators:async()=>roster,readWorkOrderDetails:async()=>({projectId:201,projectCode:'QA-201',productCode:'SKU-901',projectStatus:10,plannedAmount:100}),
  listWorkOrderProcesses:async()=>remote.rows.map(row=>({taskId:row.projectProcessId,projectId:201,projectCode:'QA-201',processName:row.processName,plannedAmount:row.planAmount,processStatus:row.processStatus}))};
 const sync=new BlacklakeSync({store,blacklake});
 sync.indexOrder(await blacklake.readWorkOrderDetails());
 sync.save('order',201,{info:await blacklake.readWorkOrderDetails(),tasks:await blacklake.listWorkOrderProcesses()});
 sync.save('people','all',roster);
 const server=createServer(createApp({config,store,blacklake,dataSync:sync,wechat:{}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint='/v1/workspace/orders/201/process-management';
 const call=async(path=endpoint,{person=0,body,key='route-test-operation'}={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body?'POST':'GET',
   headers:{Authorization:'Bearer '+tokens[person],'Content-Type':'application/json','Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 };
 const finish=async id=>{for(let i=0;i<12&&['QUEUED','RETRY','RUNNING'].includes(sync.jobs.get(id).state);i++)await sync.tick();return sync.jobs.get(id);};
 return {store,sync,remote,call,finish,endpoint,close:async()=>{await new Promise(resolve=>server.close(resolve));store.close();}};
}

test('组长使用黑湖目录增删改及排序，确认后按 SKU 保存前后路线',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.call(f.endpoint,{person:1})).status,403);
  const catalog=await f.call('/v1/workspace/process-catalog?query=P13');
  assert.deepEqual(catalog.body.rows,[{id:13,name:'封箱',code:'P13'}]);
  const save=async(change,key)=>{
   const context=await f.call();
   assert.equal(context.body.sku,'SKU-901');
   const args={key,body:{...change,version:context.body.version}},response=await f.call(f.endpoint,args);
   assert.equal(response.status,202,JSON.stringify(response.body));
   assert.equal((await f.call(f.endpoint,args)).body.id,response.body.id);
   assert.equal((await f.finish(response.body.id)).state,'SUCCEEDED',JSON.stringify(f.sync.jobs.get(response.body.id)));
   return f.remote.rows.at(-1).projectProcessId;
  };
  const added=await save({action:'add',definitionId:13},'route-test-add-0001');
  await save({action:'edit',id:added,planQuantity:103},'route-test-edit-0001');
  await save({action:'reorder',ids:[302,added,301]},'route-test-reorder-01');
  await save({action:'delete',id:added},'route-test-delete-01');
  assert.deepEqual(f.remote.rows.map(row=>row.projectProcessId),[302,301]);
  assert.equal(f.remote.rows[0].realAmount,3);
  const log=f.store.db.prepare('SELECT * FROM sku_process_changes ORDER BY rowid').all();
  assert.deepEqual(log.map(row=>row.action),['add','edit','reorder','delete']);
  assert(log.every(row=>row.sku==='SKU-901'&&row.product_id===901&&row.order_id===201&&row.operator_id===101));
  assert.equal(JSON.parse(log[0].after_json).at(-1).planQuantity,100);
  assert.equal(JSON.parse(log[1].after_json).at(-1).planQuantity,103);
  assert.equal(f.remote.writes.length,4);
  assert.equal(processEditLocksTask(f.store.db,201,added),true);
  assert.equal(processEditLocksTask(f.store.db,201,302),false);
 }finally{await f.close();}
});

test('已报工的工序不能删除，未知写入只读核对一次并保留其他工序通行',async()=>{
 const f=await fixture();
 try{
  f.remote.materials=[{id:1}];
  assert.equal((await f.call()).body.version,null);
  f.remote.materials=[];
  const ctx=(await f.call()).body;
  assert.match(ctx.rows.find(row=>row.id===302).blockedReason,/已有生产/);
  const write=async id=>(await f.call(f.endpoint,{key:'route-delete-used-'+id,body:{version:ctx.version,action:'delete',id}})).body.id;
  assert.equal((await f.finish(await write(302))).error_code,'PROCESS_EDIT_USED');
  assert.equal(f.remote.writes.length,0);
  const id=await write(301);
  assert.equal(processEditLocksTask(f.store.db,201,301),true);
  assert.equal(processEditLocksTask(f.store.db,201,302),false);
  f.remote.failure='lost';
  assert.equal((await f.finish(id)).state,'UNKNOWN');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sku_process_changes').get().n,0);
  f.remote.readBlocked=false;
  f.sync.recovery.schedule();
  for(let i=0;i<12&&f.sync.jobs.get(id).state==='UNKNOWN';i++)await f.sync.tick();
  assert.equal(f.sync.jobs.get(id).state,'SUCCEEDED');
  assert.equal(f.remote.writes.length,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sku_process_changes').get().n,1);
 }finally{await f.close();}
});
