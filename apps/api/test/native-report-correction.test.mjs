import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFixture} from './native-report-fixture.mjs';
import {nativePlanMatches,nativeFingerprint} from '../src/native-report-correction.mjs';

const input={goodAmount:80,defectAmount:0,defectCodes:[],defectItems:[],operatorId:201,operatorName:'测试员工',startedAt:'2026-11-10 11:00:00',endedAt:'2026-11-10 14:00:00',durationSeconds:4800,planRestTime:5400,unplanShutdownTime:600,materialProcess:'用料联调'};

test('手动少计90分钟时补足停工字段，黑湖按起止休息停工重算后仍为3小时06分09秒',async()=>{
 const f=nativeFixture();f.setMode('recompute-effective');const original=await f.client.readOutputForCorrection(1001,{production:true});
 const target={...input,goodAmount:200,startedAt:'2026-11-10 08:00:00',endedAt:'2026-11-10 14:06:09',durationSeconds:11169,planRestTime:5400,unplanShutdownTime:0};
 const plan=await f.client.prepareOutputCorrection(original,target),actual=await f.client.updateOutputConfirmed(original,{...target,nativePlan:plan});
 assert.equal(actual.effectiveTime,11169);assert.equal(plan.payload.planRestTime,5400);assert.equal(plan.payload.unplanShutdownTime,5400);assert.equal(plan.payload.fineAmount,200);assert(nativePlanMatches(actual,plan));
});

test('组长可把起止改到原报工日期之后，报工时间自动保持不早于新结束',async()=>{
 const f=nativeFixture();f.setMode('validate-report-time');const original=await f.client.readOutputForCorrection(1001,{production:true});
 const target={...input,startedAt:'2026-11-10 15:00:00',endedAt:'2026-11-10 17:00:00',durationSeconds:7200,planRestTime:0,unplanShutdownTime:0};
 const plan=await f.client.prepareOutputCorrection(original,target),actual=await f.client.updateOutputConfirmed(original,{...target,nativePlan:plan});
 assert.equal(plan.payload.outputTime,target.endedAt);assert.equal(actual.startedAt,target.startedAt);assert(nativePlanMatches(actual,plan));
});
test('已有加班时长从原值贯穿工资、公式、保存及回读，不接受隐式清零或输入覆盖',async()=>{
 for(const overtime of [0,1800]){
  const f=nativeFixture();f.remote.overtimeTime=overtime;
  const original=await f.client.readOutputForCorrection(1001,{production:true}),plan=await f.client.prepareOutputCorrection(original,{...input,overtimeTime:0});
  assert.equal(plan.payload.overtimeTime,overtime);assert.equal(plan.expected.overtimeTime,overtime);
  await f.client.updateOutputConfirmed(original,{...input,nativePlan:plan});
  for(const endpoint of ['/salary/byFormula','/formula/calc','/update']){
   const call=f.calls.find(c=>c.url.endsWith(endpoint));assert(call);assert.equal(endpoint==='/update'?call.body.output.overtimeTime:call.body.overtimeTime,overtime);
  }
  assert.equal(f.remote.overtimeTime,overtime);assert(nativePlanMatches({native:f.remote},plan));
 }
});
test('完整编辑使用原生网页接口并以秒提交有效工时，公式由黑湖计算且保留所有字段',async()=>{
 const f=nativeFixture(),original=await f.client.readOutputForCorrection(1001,{production:true}),before=nativeFingerprint(original.native),plan=await f.client.prepareOutputCorrection(original,input);
 assert.equal(nativeFingerprint(original.native),before);assert.equal(plan.punchMinutes,180);
 const verified=await f.client.updateOutputConfirmed(original,{...input,nativePlan:plan});assert(nativePlanMatches(verified,plan));
 const writes=f.calls.filter(c=>c.url.endsWith('/update'));assert.equal(writes.length,1);assert(!f.calls.some(c=>c.url.endsWith('/modify')));
 assert.equal(writes[0].body.output.effectiveTime,4800);assert.equal(writes[0].body.output.planRestTime,5400);assert.equal(writes[0].body.output.unplanShutdownTime,600);
 assert.equal(writes[0].body.output.auxiliaryParam01,'保留');assert.equal(writes[0].body.output.auxiliaryParam02,0);assert.equal(writes[0].body.output.outputTime,'2026-11-10 14:20:00');
 assert.deepEqual(writes[0].body.output.customFieldValueList,[{fieldId:964471,value:'用料联调',blHidden:false},{fieldId:940264,value:'180',blHidden:false},{fieldId:864387,value:'0.99',blHidden:true}]);
 for(const c of f.calls.filter(c=>!c.url.endsWith('/query')))assert.equal(c.headers['User-Agent'],'BlacklakeReporting/1.0');
});
test('公式不全、隐藏表达式变化和审批中都在写入前拒绝，不默认清空字段',async()=>{
 for(const kind of ['formula','hidden','approval','unknown-type','clock']){
  const f=nativeFixture();if(kind==='formula')f.setMode('bad-formula');if(kind==='hidden')f.remote.customFieldValues[2].customFieldMetadata.hidden=[{functionText:'unknown()'}];if(kind==='approval')f.remote.blInApprove=true;if(kind==='unknown-type')f.remote.customFieldValues[2].customFieldMetadata.type=8;if(kind==='clock')f.remote.clockOnRecordId=123;
  const original=await f.client.readOutputForCorrection(1001,{production:true});
  await assert.rejects(()=>f.client.prepareOutputCorrection(original,input));assert.equal(f.calls.filter(c=>c.url.endsWith('/update')).length,0);
 }
});
test('公式计算期间上游版本变化拒绝写，明确失败可重试，不确定回执不重发',async()=>{
 for(const mode of ['external-change','reject','after-write']){
  const f=nativeFixture(),original=await f.client.readOutputForCorrection(1001,{production:true});f.setMode(mode);const plan=await f.client.prepareOutputCorrection(original,input);
  await assert.rejects(()=>f.client.updateOutputConfirmed(original,{...input,nativePlan:plan}),e=>mode==='after-write'?e.definiteFailure!==true:e.definiteFailure===true);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/update')).length,mode==='external-change'?0:1);
  if(mode==='after-write'){f.setMode('');const actual=await f.client.readOutputForCorrection(1001,{production:true});assert(nativePlanMatches(actual,plan));}
 }
});
test('回读必须覆盖休息、停工、全部自定义字段、身份、数量与工资结果',async()=>{
 const f=nativeFixture(),original=await f.client.readOutputForCorrection(1001,{production:true}),plan=await f.client.prepareOutputCorrection(original,input);
 await f.client.updateOutputConfirmed(original,{...input,nativePlan:plan});
 for(const key of ['effectiveTime','planRestTime','unplanShutdownTime','overtimeTime','expectedSalary','operatorId','fineAmount']){
  const snapshot=structuredClone(f.remote);f.remote[key]++;
  // The raw native projection can be checked even if dual-interface integrity
  // would already reject this changed row before returning the read model.
  assert.equal(nativePlanMatches({native:f.remote},plan),false);Object.assign(f.remote,snapshot);
 }
 const old=f.remote.customFieldValues[2].value;f.remote.customFieldValues[2].value='0.88';assert.equal(nativePlanMatches({native:f.remote},plan),false);f.remote.customFieldValues[2].value=old;
 assert(nativePlanMatches({native:f.remote},plan));
});
