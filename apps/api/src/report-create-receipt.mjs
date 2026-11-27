import {AppError} from './errors.mjs';
import {timestampMs} from './work-time.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const stamp=ms=>new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' ');
export function outputId(value){
 if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
 return typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))?value:null;
}
const idKeys=['id','outputId','reportingId'];
const knownKeys=['code','errorCode','statusCode','success','data','result','error','subCode','message','msg','errorMsg',...idKeys];
const otherKeys=value=>object(value)?Object.keys(value).filter(k=>!knownKeys.includes(k)).length:0;
const safeCode=value=>typeof value!=='number'&&typeof value!=='string'?null:/^-?\d{1,8}$|^0100x1111$/.test(String(value))?String(value):null;
const rejectedFlag=data=>data.success===false||data.error!=null&&data.error!==false||
 Number(safeCode(data.statusCode))>=400||data.errorCode!=null&&!['','0','01000000'].includes(safeCode(data.errorCode));

export function inspectCreateReceipt(response,raw,data,{bodyReadFailed=false}={}){
 const envelope=object(data)?data:{},idFields={},found=[],rootKeys=knownKeys.filter(key=>Object.hasOwn(envelope,key));
 for(const [prefix,container] of [['',envelope],['data.',envelope.data],['result.',envelope.result]]){
  if(!object(container))continue;
  for(const key of idKeys)if(Object.hasOwn(container,key)){
   const id=outputId(container[key]);idFields[prefix+key]={type:type(container[key]),valid:!!id};
   if(container[key]!=null&&container[key]!=='')found.push(id);
  }
 }
 const code=safeCode(envelope.code),failure=[envelope,envelope.data,envelope.result].some(item=>object(item)&&(rejectedFlag(item)||item.subCode==='USER_VERIFICATION_ERROR'));
 const success=response.ok&&!bodyReadFailed&&code==='01000000'&&!failure;
 const id=success&&found.length&&found.every(value=>value&&value===found[0])?found[0]:null;
 const rejected=code!=='01000000'&&envelope.success!==true&&!found.some(Boolean)&&([401,403,429].includes(response.status)||
  response.ok&&(code==='-1'||/^4\d\d$/.test(code||'')));
 const format=bodyReadFailed?'unreadable':data!==undefined?type(data):raw.trim()?'non-json':'empty';
 return {id,success,rejected,evidence:{
  stage:'response',httpStatus:response.status,format,characters:raw.length,code,statusCode:safeCode(envelope.statusCode),errorCode:safeCode(envelope.errorCode),
  successFlag:typeof envelope.success==='boolean'?envelope.success:null,hasAuthRejection:envelope.subCode==='USER_VERIFICATION_ERROR',
  rootKeys,otherRootKeys:otherKeys(envelope),dataType:type(envelope.data),resultType:type(envelope.result),
  otherDataKeys:otherKeys(envelope.data),otherResultKeys:otherKeys(envelope.result),idFields,
  outcome:id?'accepted-with-id':success?found.length?'unusable-id':'accepted-without-id':rejected?'rejected':'unconfirmed-response'
 }};
}

export function unknownCreateOutcome(code='BLACKLAKE_CREATE_RESPONSE_UNCONFIRMED'){
 return Object.assign(new AppError(409,code,'报工已保留，系统正在核对黑湖结果，请勿重复提交。'),{writeOutcomeUnknown:true});
}

export function assertNewOutputLink(db,reportId,id){
 // Mock/isolated adapters have their own ID namespace; the live client only
 // returns validated positive numeric IDs.
 if(!(typeof id==='string'&&id.trim()||typeof id==='number'&&outputId(id)))throw unknownCreateOutcome('BLACKLAKE_OUTPUT_ID_MISSING');
 if(db.prepare('SELECT id FROM reports WHERE blacklake_output_id=? AND id<>? LIMIT 1').get(String(id),reportId))
  throw unknownCreateOutcome('SYNC_OUTPUT_ALREADY_LINKED');
}

const number=value=>typeof value==='number'||typeof value==='string'&&value.trim()?Number(value):NaN;
const keyOf=row=>{
 const ids=idKeys.filter(k=>row[k]!=null).map(k=>outputId(row[k]));
 return ids.length&&ids.every(id=>id&&id===ids[0])?ids[0]:null;
};
const allocations=items=>Array.isArray(items)?JSON.stringify(items.map(i=>[String(i?.code??i?.defectCode??''),number(i?.amount??i?.defectAmount??i?.quantity)]).sort((a,b)=>a[0].localeCompare(b[0]))):null;

// Spend at most two reads on the original attempt. If the result is incomplete
// or eventual consistency delays it, the existing recovery queue takes over.
export async function readCreatedOutput(client,payload,sentAt){
 const now=Date.now(),first=Math.floor(sentAt/1000)*1000,last=now+5000;
 if(!client.config.outputQueryPath||typeof payload.projectCode!=='string'||!payload.projectCode||
    !Number.isFinite(timestampMs(payload.planStartTime))||!Number.isFinite(timestampMs(payload.planEndTime)))return {outcome:'lookup-unavailable'};
 const matches=row=>{
  const created=timestampMs(row.createdAt);
  return created>=first&&created<=last&&number(row.projectId)===number(payload.projectId)&&
   number(row.taskId??row.projectProcessId)===number(payload.projectProcessId)&&number(row.productionStaffId??row.operatorId)===number(payload.operatorId)&&
   number(row.numberofgoodProducts??row.fineAmount)===payload.fineAmount&&number(row.numberofDefectives??row.defectsAmount)===payload.defectsAmount&&
   timestampMs(row.starttimeofReport??row.planStartTime)===timestampMs(payload.planStartTime)&&
   timestampMs(row.endtimeofReport??row.planEndTime)===timestampMs(payload.planEndTime)&&
   allocations(row.defectItemList??row.defectList??[])===allocations(payload.defectList);
 };
 const search=await client.queryOutputPage({projectCode:payload.projectCode,createdAtGte:stamp(first),createdAtLte:stamp(last)},{pageSize:100,requireSuccess:true});
 if(search.total==null?search.records.length===100:search.total!==search.records.length)return {outcome:'lookup-incomplete'};
 const candidates=search.records.filter(matches);
 if(candidates.length!==1)return {outcome:candidates.length?'lookup-ambiguous':'lookup-no-match',matches:candidates.length};
 const id=keyOf(candidates[0]);if(!id)return {outcome:'lookup-unusable-id'};
 const exact=await client.queryOutputPage({id:Number(id),projectCode:payload.projectCode},{pageSize:2,requireSuccess:true});
 if(exact.records.length!==1||exact.total!=null&&exact.total!==1||keyOf(exact.records[0])!==id||!matches(exact.records[0]))return {outcome:'lookup-not-confirmed'};
 return {outcome:'lookup-confirmed',id};
}
