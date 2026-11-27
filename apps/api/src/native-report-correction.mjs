import {createHash} from 'node:crypto';
import {AppError} from './errors.mjs';
import {timestampMs} from './work-time.mjs';
import {balanceReportDuration} from './report-production.mjs';
import {MATERIAL_FIELD,PUNCH_FIELD} from './report-custom-fields.mjs';

const fail=(code,message)=>{throw new AppError(409,code,message);};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const scalar=value=>value===null||typeof value==='string'||finite(value);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
export const nativeFingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const asId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):NaN;
const fieldId=field=>Number(field.fieldId??field.customFieldMetadata?.id);
const fieldName=field=>field.name??field.customFieldMetadata?.name;
const fieldValues=fields=>fields.map(f=>({fieldId:fieldId(f),name:fieldName(f),value:f.value})).sort((a,b)=>a.fieldId-b.fieldId);
function hiddenValue(metadata,account){
  if(!Array.isArray(metadata.hidden))fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','无法确认黑湖字段的隐藏规则。');
  if(!metadata.hidden.length)return false;
  if(typeof account!=='string'||!account)fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','无法核验黑湖字段的登录账号规则。');
  return metadata.hidden.some(rule=>{
    if(rule.userIds!=null||rule.hiddenType!=null)fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','黑湖隐藏条件尚不支持，本次未提交。');
    const match=/^\$\{用户信息\.账号\}(!=|==)"([^"\\]*)"$/.exec(rule.functionText??'');
    if(!match)fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','黑湖字段含未支持的隐藏条件，本次未提交。');
    return match[1]==='!='?account!==match[2]:account===match[2];
  });
}

export function nativeFields(snapshot,account){
  if(!Array.isArray(snapshot.customFieldValues))fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','黑湖自定义字段读取不完整。');
  const seen=new Set(),names=new Set();
  const result=snapshot.customFieldValues.map(field=>{
    const metadata=field.customFieldMetadata,id=fieldId(field),name=fieldName(field);
    if(!metadata||!Number.isSafeInteger(id)||id<=0||Number(metadata.id)!==id||seen.has(id)||typeof name!=='string'||!name||name!==metadata.name||names.has(name)
      ||!['OUTPUT',4].includes(metadata.targetType)||![1,2,3,5,6,7].includes(Number(metadata.type))||!Object.hasOwn(field,'value')||!scalar(field.value))fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','黑湖字段定义或值不完整，不能覆盖更新。');
    seen.add(id);names.add(name);
    return {fieldId:id,value:field.value,blHidden:hiddenValue(metadata,account)};
  });
  for(const expected of [MATERIAL_FIELD,PUNCH_FIELD]){
    const field=snapshot.customFieldValues.find(f=>fieldId(f)===expected.id),metadata=field?.customFieldMetadata;
    if(!field||fieldName(field)!==expected.name||metadata.fieldName!==expected.fieldName||Number(metadata.type)!==expected.type||(expected===MATERIAL_FIELD&&metadata.blReadonly!==false))fail('BLACKLAKE_NATIVE_FIELDS_UNSAFE','黑湖用料或打卡字段定义已变化。');
  }
  return result;
}

export function nativeOutputProjection(output){
  const keys=['outputId','projectId','projectProcessId','operatorId','operatorName','outputAmount','fineAmount','defectsAmount','stockUnit','pricingType','approveStatus','planStartTime','planEndTime','planRestTime','unplanShutdownTime','overtimeTime','effectiveTime','timePeriodRuleId','clockOnRecordId','standardOutput','standardTaskTime','auxiliaryParam01','auxiliaryParam02','auxiliaryParam03','auxiliaryParam04','auxiliaryParam05'];
  return {...Object.fromEntries(keys.map(k=>[k,output[k]??null])),outputTime:output.outputTime??output.createdAt,
    defects:(output.defectList??output.defects??[]).map(f=>({code:f.code,amount:Number(f.amount)})).sort((a,b)=>String(a.code).localeCompare(String(b.code))),
    fields:fieldValues(output.customFieldValues??[])};
}

export async function readNativeReport(client,id){
  const response=await client.nativeRequest('/api/dytin/output/web/detail',{outputId:Number(id)});
  const value=response?.data;
  if(String(response?.code)!=='01000000'||!value||asId(value.outputId)!==asId(id)||asId(value.id)!==asId(id)
    ||!Number.isSafeInteger(asId(value.projectId))||!Number.isSafeInteger(asId(value.projectProcessId))||!Number.isSafeInteger(asId(value.operatorId))
    ||typeof value.operatorName!=='string'||!['outputAmount','fineAmount','defectsAmount','effectiveTime','planRestTime','unplanShutdownTime','overtimeTime'].every(k=>finite(value[k])&&value[k]>=0)
    ||value.outputAmount!==value.fineAmount+value.defectsAmount||!Array.isArray(value.defects)||value.defects.some(f=>!f||typeof f.code!=='string'||!f.code||!finite(f.amount)||f.amount<=0)
    ||value.defects.reduce((n,f)=>n+f.amount,0)!==value.defectsAmount||new Set(value.defects.map(f=>f.code)).size!==value.defects.length||!Array.isArray(value.customFieldValues)
    ||typeof value.updatedAt!=='string'||typeof value.createdAt!=='string'||typeof value.blInApprove!=='boolean'
    ||typeof value.stockUnit!=='string'||![1,2].includes(value.pricingType)||![0,10].includes(value.approveStatus)
    ||!Number.isFinite(timestampMs(value.planStartTime))||!Number.isFinite(timestampMs(value.planEndTime)))fail('BLACKLAKE_NATIVE_DETAIL_INVALID','黑湖网页报工明细不完整，请勿修改。');
  return value;
}

export function nativePayload(snapshot,customFields){
  const keys=['projectProcessId','projectId','outputAmount','fineAmount','operatorId','operatorName','pricingType','stockUnit','planStartTime','planEndTime','approveStatus','standardOutput','standardTaskTime','defectsAmount','auxiliaryParam01','auxiliaryParam02','auxiliaryParam03','auxiliaryParam04','auxiliaryParam05','planRestTime','unplanShutdownTime','overtimeTime','effectiveTime','timePeriodRuleId','clockOnRecordId'];
  return {...Object.fromEntries(keys.filter(k=>Object.hasOwn(snapshot,k)).map(k=>[k,snapshot[k]])),outputId:Number(snapshot.outputId),outputTime:snapshot.createdAt,
    defectList:snapshot.defects.map(f=>({...(f.id!=null?{id:f.id}:{}),...(f.defectName!=null?{defectName:f.defectName}:{}),code:f.code,amount:Number(f.amount)})),
    customFieldValueList:customFields,batchOutputFineAmount:snapshot.fineAmount,batchOutputDefectsAmount:snapshot.defectsAmount};
}

export async function prepareNativeCorrection(client,original,input){
  const snapshot=original.native;
  if(!snapshot)fail('BLACKLAKE_NATIVE_DETAIL_REQUIRED','请重新打开编辑，读取黑湖完整报工。');
  if(snapshot.blInApprove)fail('BLACKLAKE_REPORT_IN_APPROVAL','此报工正在黑湖审批，暂不能修改。');
  const fields=nativeFields(snapshot,client.config.account),payload=nativePayload(snapshot,fields);
  Object.assign(payload,{operatorId:input.operatorId??snapshot.operatorId,operatorName:input.operatorName??snapshot.operatorName,
    outputAmount:input.goodAmount+input.defectAmount,fineAmount:input.goodAmount,defectsAmount:input.defectAmount,
    defectList:input.defectItems??snapshot.defects,planStartTime:input.startedAt??snapshot.planStartTime,planEndTime:input.endedAt??snapshot.planEndTime,
    // Overtime is not editable here; retain nativePayload's original value.
    effectiveTime:input.durationSeconds,planRestTime:input.planRestTime,unplanShutdownTime:input.unplanShutdownTime,
    batchOutputFineAmount:input.goodAmount,batchOutputDefectsAmount:input.defectAmount});
  if(!['effectiveTime','planRestTime','unplanShutdownTime'].every(k=>Number.isSafeInteger(payload[k])&&payload[k]>=0)
    ||!Number.isSafeInteger(asId(payload.operatorId))||typeof payload.operatorName!=='string'||!payload.operatorName
    ||!Number.isSafeInteger(payload.fineAmount)||payload.fineAmount<0||!Number.isSafeInteger(payload.defectsAmount)||payload.defectsAmount<0||!Number.isSafeInteger(payload.outputAmount)||payload.outputAmount<=0
    ||!Array.isArray(payload.defectList)||payload.defectList.some(f=>!f||typeof f.code!=='string'||!f.code||!Number.isSafeInteger(f.amount)||f.amount<=0)
    ||payload.defectList.reduce((n,f)=>n+f.amount,0)!==payload.defectsAmount||new Set(payload.defectList.map(f=>f.code)).size!==payload.defectList.length
    ||typeof input.materialProcess!=='string'||input.materialProcess.length>100||/[\u0000-\u001f]/.test(input.materialProcess))fail('BLACKLAKE_NATIVE_PAYLOAD_INVALID','报工完整同步参数不正确。');
  const elapsed=(timestampMs(payload.planEndTime)-timestampMs(payload.planStartTime))/1000;
  if(!Number.isSafeInteger(elapsed)||elapsed<0||payload.effectiveTime>elapsed)fail('BLACKLAKE_NATIVE_PAYLOAD_INVALID','有效工时超过当前起止时间跨度。');
  const balanced=balanceReportDuration(elapsed,payload.effectiveTime,payload.planRestTime,payload.unplanShutdownTime);
  payload.planRestTime=balanced.planRestTime;payload.unplanShutdownTime=balanced.unplanShutdownTime;
  if(!Number.isFinite(timestampMs(payload.outputTime)))fail('BLACKLAKE_NATIVE_DETAIL_INVALID','原报工时间未能确认。');
  if(timestampMs(payload.outputTime)<timestampMs(payload.planEndTime))payload.outputTime=payload.planEndTime;
  if(snapshot.clockOnRecordId!=null&&(payload.operatorId!==snapshot.operatorId||payload.planStartTime!==snapshot.planStartTime||payload.planEndTime!==snapshot.planEndTime))fail('BLACKLAKE_CLOCK_LINKED','黑湖报工已关联打卡记录，请先在黑湖核对，不能改写关联身份或时间。');
  fields.find(f=>f.fieldId===MATERIAL_FIELD.id).value=input.materialProcess;
  const salaryFields=fields.map(f=>{const meta=snapshot.customFieldValues.find(v=>fieldId(v)===f.fieldId).customFieldMetadata;return {fieldId:f.fieldId,name:meta.name,type:meta.type,fieldName:meta.fieldName,value:f.value};});
  const salaryResponse=await client.nativeRequest('/api/dytin/output/salary/byFormula',{pricingType:payload.pricingType,stockUnit:payload.stockUnit,clientType:10,outputAmount:payload.outputAmount,defectsAmount:payload.defectsAmount,defectList:payload.defectList,approveStatus:payload.approveStatus,approver:snapshot.approver,fineAmount:payload.fineAmount,planStartTime:payload.planStartTime,planEndTime:payload.planEndTime,projectProcessId:payload.projectProcessId,customFieldValueList:salaryFields,operatorId:payload.operatorId,operatorName:payload.operatorName,outputTime:payload.outputTime,outputTaskTime:elapsed,standardTaskTime:payload.standardTaskTime,standardOutput:payload.standardOutput,planRestTime:payload.planRestTime,unplanShutdownTime:payload.unplanShutdownTime,overtimeTime:payload.overtimeTime,effectiveTime:payload.effectiveTime});
  if(String(salaryResponse?.code)!=='01000000'||!finite(salaryResponse.data?.salary))fail('BLACKLAKE_NATIVE_FORMULA_INVALID','黑湖报工工资预计算未确认，本次未提交。');
  const formulaResponse=await client.nativeRequest('/api/dytin/output/formula/calc',{projectProcessId:payload.projectProcessId,pricingType:payload.pricingType,approveStatus:payload.approveStatus,operatorName:payload.operatorName,operatorId:payload.operatorId,outputId:payload.outputId,outputAmount:payload.outputAmount,fineAmount:payload.fineAmount,defectsAmount:payload.defectsAmount,defectList:payload.defectList,unitPrice:snapshot.unitPrice,customFieldValues:fields,standardTaskTime:payload.standardTaskTime,standardOutput:payload.standardOutput,approver:snapshot.approver,expectedSalary:salaryResponse.data.salary,outputTaskTime:elapsed,planStartTime:payload.planStartTime,planEndTime:payload.planEndTime,planRestTime:payload.planRestTime,unplanShutdownTime:payload.unplanShutdownTime,overtimeTime:payload.overtimeTime,effectiveTime:payload.effectiveTime,...Object.fromEntries([1,2,3,4,5].map(n=>['auxiliaryParam0'+n,payload['auxiliaryParam0'+n]]))});
  const formulas=snapshot.customFieldValues.filter(f=>Number(f.customFieldMetadata.type)===7),calculated=formulaResponse?.data;
  if(String(formulaResponse?.code)!=='01000000'||!Array.isArray(calculated)||calculated.length!==formulas.length||new Set(calculated.map(f=>Number(f.fieldId))).size!==formulas.length)fail('BLACKLAKE_NATIVE_FORMULA_INVALID','黑湖报工公式读取不完整，本次未提交。');
  for(const formula of formulas){const result=calculated.find(f=>Number(f.fieldId)===fieldId(formula));
    if(!result||result.name!==fieldName(formula)||result.fieldName!==formula.customFieldMetadata.fieldName||!scalar(result.value)||result.value===null||String(result.value).trim()===''||!Number.isFinite(Number(result.value)))fail('BLACKLAKE_NATIVE_FORMULA_INVALID','黑湖公式结果无效，本次未提交。');
    fields.find(f=>f.fieldId===fieldId(formula)).value=result.value;
  }
  const punchMinutes=Number(fields.find(f=>f.fieldId===PUNCH_FIELD.id).value);
  if(Math.abs(punchMinutes-elapsed/60)>0.000001)fail('BLACKLAKE_NATIVE_FORMULA_INVALID','黑湖打卡公式与起止时间不符，本次未提交。');
  const expected=nativeOutputProjection({...payload,customFieldValues:fields.map(f=>({fieldId:f.fieldId,name:fieldName(snapshot.customFieldValues.find(v=>fieldId(v)===f.fieldId)),value:f.value}))});
  return {beforeFingerprint:nativeFingerprint(snapshot),payload,expected,punchMinutes,expectedSalary:salaryResponse.data.salary};
}

export function nativePlanMatches(remote,plan){
  if(!remote?.native||!plan?.expected)return false;
  const actual=nativeOutputProjection(remote.native);
  if(nativeFingerprint(actual)!==nativeFingerprint(plan.expected))return false;
  return finite(remote.native.expectedSalary)&&Math.abs(remote.native.expectedSalary-plan.expectedSalary)<0.000001;
}

export async function writeNativeCorrection(client,original,plan){
  try{
    if(!plan||plan.beforeFingerprint!==nativeFingerprint(original.native))fail('REPORT_REMOTE_CHANGED','黑湖完整报工版本已变化，本次未提交。');
    const fresh=await readNativeReport(client,original.id);
    if(nativeFingerprint(fresh)!==plan.beforeFingerprint)fail('REPORT_REMOTE_CHANGED','黑湖报工在核算期间发生变化，本次未提交。');
  }catch(error){error.definiteFailure=true;throw error;}
  let response;
  try{response=await client.nativeRequest('/api/dytin/output/update',{output:plan.payload},{write:true,retryAuth:false});}
  catch(error){if(error.upstreamStatus>=400&&error.upstreamStatus<500||['1001','01000002'].includes(error.upstreamCode))error.definiteFailure=true;throw error;}
  if(String(response?.code)!=='01000000')fail('BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖完整修改回执待核对，不能重复提交。');
  client.taskCache.clear();
  const verified=await client.readOutputForCorrection(original.id,{production:true});
  if(!nativePlanMatches(verified,plan))fail('BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖完整修改结果待核对，不能重复提交。');
  return verified;
}
