import test from 'node:test';
import assert from 'node:assert/strict';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
import {materialFieldPayload,customFieldReadbackMatches} from '../src/report-custom-fields.mjs';

const metadata=[
 {fieldId:964471,name:'用料工序',fieldName:'output1783322839376142',type:1,targetType:4,blReadonly:false,hidden:[]},
 {fieldId:940264,name:'打卡报工时长/分',fieldName:'output1763516131304129',type:7,targetType:4,hidden:[]},
 {fieldId:864387,name:'达标率（小数）',fieldName:'rate',type:7,targetType:4,hidden:[]}
];
const fields=[{fieldId:964471,name:'用料工序',value:null},{fieldId:940264,name:'打卡报工时长/分',value:'180'},{fieldId:864387,name:'达标率（小数）',value:'0.875000'}];
test('用料工序映射使用OpenAPI中文名称，并完整保留其他公式原值和空值',()=>{
 const payload=materialFieldPayload(fields,metadata,'车耳朵');
 assert.deepEqual(payload,[{name:'达标率（小数）',value:'0.875000',blHidden:false},{name:'打卡报工时长/分',value:'180',blHidden:false},{name:'用料工序',value:'车耳朵',blHidden:false}]);
 assert.equal(fields[0].value,null);
 assert(customFieldReadbackMatches([{name:'用料工序',value:'车耳朵'},{name:'达标率（小数）',value:'0.875000'},{name:'打卡报工时长/分',value:'180'}],payload));
 assert(!customFieldReadbackMatches([{name:'用料工序',value:'车耳朵'}],payload));
 assert(!customFieldReadbackMatches([{name:'用料工序',value:'车耳朵'},{name:'用料工序',value:'车耳朵'},{name:'打卡报工时长/分',value:'180'}],payload));
});
test('字段缺失、重名重ID、类型不明或隐藏条件拒绝覆盖更新',()=>{
 for(const [values,definitions] of [
  [undefined,metadata],[fields.slice(0,1),metadata],[fields,[...metadata,metadata[0]]],
  [[...fields,fields[0]],metadata],[fields,metadata.map(f=>({...f,name:'重复'}))],
  [fields,metadata.map(f=>({...f,hidden:['条件']}))],[fields,metadata.map(f=>({...f,type:8}))],
  [fields,metadata.map(f=>({...f,blReadonly:true}))],
  [fields.map(f=>({...f,value:{unexpected:'shape'}})),metadata],
  [fields,metadata.map(f=>({...f,targetType:3}))]
 ])assert.throws(()=>materialFieldPayload(values,definitions,'新值'),e=>e.code==='BLACKLAKE_CUSTOM_FIELDS_UNSAFE');
});
test('真实客户端缺少完整准备计划时不发半笔用料更新，停用完整driver也不能绕过',async()=>{
 let calls=0;const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',timeoutMs:1000},async()=>{calls++;throw Error('must not fetch');});
 assert.equal(client.supportsFullReportCorrection,true);
 await assert.rejects(()=>client.updateOutputConfirmed({id:991},{goodAmount:10,defectAmount:0,defectCodes:[],durationSeconds:60,materialProcess:'新值'}),e=>e.code==='BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED'&&e.definiteFailure===true);
 assert.equal(calls,0);
 client.supportsFullReportCorrection=false;
 await assert.rejects(()=>client.updateOutputConfirmed({id:991},{goodAmount:10,defectAmount:0,defectCodes:[],durationSeconds:60,materialProcess:'新值',nativePlan:{}}),e=>e.code==='BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED');assert.equal(calls,0);
});
test('真实客户端用料局部更新先读取完整字段并核对旧版本，写后确认全部字段',async()=>{
 const calls=[];let remote={reportingId:991,projectId:501,taskId:201,productionStaffId:301,numberofgoodProducts:100,numberofDefectives:0,defectItemList:[],customFieldValues:structuredClone(fields),effectiveTime:5400};
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',timeoutMs:1000,outputQueryPath:'/query'},async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  if(url.endsWith('/queryCustomFieldMetadata'))return Response.json({code:'01000000',data:metadata});
  if(url.endsWith('/modify')){remote.customFieldValues=body.customFieldValueList.map(f=>({name:f.name,fieldId:metadata.find(m=>m.name===f.name).fieldId,value:f.value}));return Response.json({code:'01000000',data:null});}
  return Response.json({code:'01000000',data:[remote]});
 });
 const original=await client.readOutputForCorrection(991);
 await client.updateOutputConfirmed(original,{goodAmount:100,defectAmount:0,defectCodes:[],materialProcess:'车耳朵'});
 assert.deepEqual(calls.find(c=>c.url.endsWith('/modify')).body.customFieldValueList,materialFieldPayload(fields,metadata,'车耳朵'));
 assert.equal(calls.filter(c=>c.url.endsWith('/modify')).length,1);
 assert.equal(calls.filter(c=>c.url.endsWith('/query')).length,3);
});
test('元数据异常、字段丢失或其他公式依赖更改时不会发写请求',async()=>{
 for(const bad of ['metadata','missing-field','changed-input','version']){
  const writes=[];let reads=0;
  const remote={reportingId:991,projectId:501,taskId:201,productionStaffId:301,numberofgoodProducts:100,numberofDefectives:0,defectItemList:[],customFieldValues:bad==='missing-field'?fields.slice(0,1):fields};
  const client=new BlacklakeClient({mode:'live',baseUrl:'https://contract.invalid',staticToken:'TEST_ONLY',timeoutMs:1000,outputQueryPath:'/query'},async(url,options)=>{
   if(url.endsWith('/modify')){writes.push(JSON.parse(options.body));throw Error('must not write');}
   if(url.endsWith('/queryCustomFieldMetadata'))return Response.json({code:'01000000',data:bad==='metadata'?{}:metadata});
   reads++;return Response.json({code:'01000000',data:[{...remote,...(bad==='version'&&reads>1?{effectiveTime:99}:{})}]});
  });
  const original=await client.readOutputForCorrection(991);
  await assert.rejects(()=>client.updateOutputConfirmed(original,{goodAmount:bad==='changed-input'?99:100,defectAmount:0,defectCodes:[],materialProcess:'新值'}),e=>e.definiteFailure===true);
  assert.equal(writes.length,0);
 }
});
