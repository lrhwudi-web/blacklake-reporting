import {BlacklakeClient} from '../src/blacklake-client.mjs';

export function nativeFixture(){
 const definitions=[{id:964471,name:'用料工序',fieldName:'output1783322839376142',type:1,targetType:'OUTPUT',hidden:[],blReadonly:false},
  {id:940264,name:'打卡报工时长/分',fieldName:'output1763516131304129',type:7,targetType:'OUTPUT',hidden:[]},
  {id:864387,name:'达标率（小数）',fieldName:'rate',type:7,targetType:'OUTPUT',hidden:[{functionText:'${用户信息.账号}!="hhghvhh"',userIds:null,hiddenType:null}]}];
 let remote={id:1001,outputId:1001,projectId:501,projectCode:'TEST-WO',projectProcessId:1,operatorId:201,operatorName:'测试员工',outputAmount:100,fineAmount:100,defectsAmount:0,defects:[],pricingType:1,stockUnit:'件',unitPrice:0.5,standardOutput:10,standardTaskTime:60,expectedSalary:50,approveStatus:0,approver:'',createdAt:'2026-11-10 14:20:00',updatedAt:'2026-11-10 14:20:00',planStartTime:'2026-11-10 11:00:00',planEndTime:'2026-11-10 14:20:00',planRestTime:5400,unplanShutdownTime:900,overtimeTime:0,effectiveTime:5700,timePeriodRuleId:null,clockOnRecordId:null,blInApprove:false,auxiliaryParam01:'保留',auxiliaryParam02:0,customFieldValues:definitions.map(m=>({fieldId:m.id,name:m.name,customFieldMetadata:m,value:m.id===964471?null:m.id===940264?'200':'1.05'}))};
 const calls=[];let mode='';
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://native-contract.invalid',staticToken:'TEST_ONLY',account:'fixture-account',outputQueryPath:'/query',timeoutMs:1000},async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body,headers:options.headers});
  if(url.endsWith('/query'))return Response.json({code:'01000000',data:[{reportingId:remote.outputId,projectId:remote.projectId,taskId:remote.projectProcessId,productionStaffId:remote.operatorId,numberofgoodProducts:remote.fineAmount,numberofDefectives:remote.defectsAmount,starttimeofReport:remote.planStartTime,endtimeofReport:remote.planEndTime,defectItemList:remote.defects,effectiveTime:remote.effectiveTime,customFieldValues:remote.customFieldValues}]});
  if(options.headers['User-Agent']!=='BlacklakeReporting/1.0')return new Response('Method Not Allowed',{status:405});
  if(url.endsWith('/web/detail'))return Response.json({code:'01000000',data:remote});
  if(url.endsWith('/salary/byFormula'))return Response.json({code:'01000000',data:{salary:50}});
  if(url.endsWith('/formula/calc')){
   if(mode==='external-change')remote.updatedAt='2026-11-10 18:00:00';
   const minutes=(Date.parse(body.planEndTime.replace(' ','T')+'+08:00')-Date.parse(body.planStartTime.replace(' ','T')+'+08:00'))/60000;
   const values=definitions.filter(f=>f.type===7).map(f=>({fieldId:f.id,name:f.name,fieldName:f.fieldName,value:f.id===940264?String(Number(minutes.toFixed(6))):'0.99'}));
   return Response.json({code:'01000000',data:mode==='bad-formula'?values.slice(0,1):values});
  }
  if(url.endsWith('/update')){
   if(mode==='reject')return Response.json({code:'1001',msg:'明确验证失败'});
   const p=body.output;
   if(mode==='validate-report-time'&&Date.parse(p.outputTime.replace(' ','T')+'+08:00')<Date.parse(p.planEndTime.replace(' ','T')+'+08:00'))return Response.json({code:'1001',msg:'报工时间不能早于实际结束时间'});
   Object.assign(remote,p,{createdAt:p.outputTime,updatedAt:'2026-11-10 18:00:01',defects:p.defectList,customFieldValues:p.customFieldValueList.map(f=>({fieldId:f.fieldId,name:definitions.find(d=>d.id===f.fieldId).name,customFieldMetadata:definitions.find(d=>d.id===f.fieldId),value:f.value}))});
   if(mode==='recompute-effective')remote.effectiveTime=(Date.parse(p.planEndTime.replace(' ','T')+'+08:00')-Date.parse(p.planStartTime.replace(' ','T')+'+08:00'))/1000-p.planRestTime-p.unplanShutdownTime;
   if(mode==='after-write')throw Error('response lost');
   return Response.json({code:'01000000',data:null});
  }
  throw Error('Unexpected native endpoint '+url);
 });
 client.supportsFullReportCorrection=true;
 return {client,calls,get remote(){return remote;},setMode:value=>mode=value};
}
