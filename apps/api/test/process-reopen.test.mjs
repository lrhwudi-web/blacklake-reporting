import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {ReportOutbox} from '../src/report-outbox.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';

function fixture(){
 const store=new Store(':memory:',{sessionSecret:'reopen-isolated'}),calls=[];let now=1000;
 const task={taskId:11,projectId:201,processStatus:20,plannedAmount:100,reportedGoodAmount:90};
 const blacklake={findTaskById:async()=>({...task}),reopenProcessConfirmed:async(id,project)=>{calls.push([id,project]);task.processStatus=10;}};
 const sync=new BlacklakeSync({store,blacklake,now:()=>now}),outbox=new ReportOutbox({store,sync,blacklake,leaderReports:()=>{},now:()=>now});
 const change={operationId:'verified-edit',assignmentId:'actual-assignment',reportId:'actual-report',projectId:201,taskId:11,ownerId:101};
 return {store,calls,task,blacklake,sync,outbox,change,advance:()=>now+=3600000,close:()=>store.close()};
}
test('更正后的实际工序累计不足计划才重开，已开启或仍满计划均不写',async()=>{
 for(const mode of ['short','still-full','already-open','unknown','wrong-order']){const f=fixture();try{
  if(mode==='still-full')f.task.reportedGoodAmount=100;
  if(mode==='already-open')f.task.processStatus=10;
  if(mode==='unknown')f.task.reportedGoodAmount=null;
  if(mode==='wrong-order')f.task.projectId=202;
  const job=f.outbox.enqueueReopen(f.change);assert.equal(f.outbox.enqueueReopen(f.change).id,job.id);await f.sync.tick();
  const result=f.sync.jobs.get(job.id);assert.equal(f.calls.length,mode==='short'?1:0);assert.equal(result.state,['unknown','wrong-order'].includes(mode)?'FAILED':'SUCCEEDED');
  if(mode==='short')assert.equal(result.result.reopened,true);
 }finally{f.close();}}
});
test('重开回执丢失保留待核对，重启和重试不再写，后台只读确认可收敛',async()=>{const f=fixture();try{
 const apply=f.blacklake.reopenProcessConfirmed;f.blacklake.reopenProcessConfirmed=async(...args)=>{await apply(...args);throw Object.assign(Error('lost'),{code:'BLACKLAKE_TIMEOUT'});};
 const job=f.outbox.enqueueReopen(f.change);await f.sync.tick();let current=f.sync.jobs.get(job.id);assert.equal(current.state,'UNKNOWN');f.advance();f.outbox.recover();await f.sync.tick();assert.equal(f.calls.length,1);
 const receipt=await f.outbox.adminAction(job.id,'reconcile',{expectedVersion:f.sync.jobVersion(current)},'admin-test');assert.equal(receipt.status,'SUCCEEDED');assert.equal(f.calls.length,1);
}finally{f.close();}});
test('工序开启使用官方网页相同的嵌套载荷，必须回读实际执行中状态',async()=>{
 const c=new BlacklakeClient({mode:'live'}),writes=[];c.nativeRequest=async(...args)=>{writes.push(args);return {code:'01000000'};};c.findTaskById=async()=>({taskId:11,projectId:201,processStatus:10});
 await c.reopenProcessConfirmed(11,201);assert.deepEqual(writes[0],['/api/dytin/project/process/update',{projectProcess:{projectProcessId:11,processStatus:10}},{write:true,retryAuth:false}]);
 c.findTaskById=async()=>({taskId:11,projectId:201,processStatus:20});await assert.rejects(()=>c.reopenProcessConfirmed(11,201),e=>e.code==='PROCESS_REOPEN_UNCONFIRMED');
});
test('精确报工查询的1011必填限制使用原生详情定位工单，不能接受错单和错号',async()=>{
 const c=new BlacklakeClient({mode:'live'}),queries=[];c.queryOutputPage=async input=>{queries.push(input);if(!input.projectCode)throw Object.assign(Error('requires project'),{upstreamCode:'1011'});return {total:1,records:[{id:991,projectId:201,projectCode:'WO-201',taskId:11,productionStaffId:101,numberofgoodProducts:90,numberofDefectives:0}]};};
 c.nativeRequest=async()=>({code:'01000000',data:{outputId:991,projectCode:'WO-201'}});assert.equal((await c.readOutputForCorrection(991)).fineAmount,90);assert.deepEqual(queries,[{id:991},{id:991,projectCode:'WO-201'}]);
 c.nativeRequest=async()=>({code:'01000000',data:{outputId:992,projectCode:'WO-201'}});await assert.rejects(()=>c.readOutputForCorrection(991),e=>e.code==='BLACKLAKE_REPORT_DETAIL_INVALID');
});
