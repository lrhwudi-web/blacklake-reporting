import {AppError} from './errors.mjs';

export const MATERIAL_FIELD={id:964471,name:'用料工序',fieldName:'output1783322839376142',type:1};
export const PUNCH_FIELD={id:940264,name:'打卡报工时长/分',fieldName:'output1763516131304129',type:7};
const fail=()=>{throw new AppError(409,'BLACKLAKE_CUSTOM_FIELDS_UNSAFE','无法完整保留黑湖自定义字段，本次尚未提交，请后台核对。');};
const scalar=value=>value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);

// This is an OpenAPI payload, whose keys differ from the native web payload.
// Never send only the changed field: the provider replaces the whole collection.
export function materialFieldPayload(values,metadata,materialProcess){
  if(!Array.isArray(values)||!Array.isArray(metadata)||typeof materialProcess!=='string'||materialProcess.length>100||/[\u0000-\u001f]/.test(materialProcess))fail();
  const definitions=new Map(),names=new Set(),existing=new Map();
  for(const field of metadata){
    const id=Number(field?.fieldId??field?.id);
    if(!Number.isSafeInteger(id)||id<=0||definitions.has(id)||typeof field.name!=='string'||!field.name||names.has(field.name)||Number(field.targetType)!==4)fail();
    definitions.set(id,field);names.add(field.name);
  }
  for(const field of values){
    const id=Number(field?.fieldId??field?.customFieldMetadata?.id);
    const definition=definitions.get(id);
    if(!definition||existing.has(id)||field.name!==undefined&&field.name!==definition.name||!Object.hasOwn(field,'value')||!scalar(field.value))fail();
    existing.set(id,field);
  }
  const target=definitions.get(MATERIAL_FIELD.id);
  if(!target||target.name!==MATERIAL_FIELD.name||target.fieldName!==MATERIAL_FIELD.fieldName||Number(target.type)!==MATERIAL_FIELD.type||target.blReadonly!==false)fail();
  return [...definitions].sort(([a],[b])=>a-b).map(([id,definition])=>{
    const original=existing.get(id);
    // Hidden conditions require evaluating the provider's form context. Do not
    // assume false or clear a field whose shape cannot be preserved losslessly.
    if(!Array.isArray(definition.hidden)||definition.hidden.length||![1,2,3,5,6,7].includes(Number(definition.type)))fail();
    if(original?.blHidden!==undefined&&typeof original.blHidden!=='boolean')fail();
    if(!original&&id!==MATERIAL_FIELD.id)fail();
    return {name:definition.name,value:id===MATERIAL_FIELD.id?materialProcess:original.value,blHidden:original?.blHidden??false};
  });
}

export function productionFieldsMatch(remote,production){
  if(!production)return true;
  if(remote.startedAt!==production.startedAt||remote.endedAt!==production.endedAt)return false;
  // Older local-only pending operations retain their original recovery contract.
  if(!production.blacklakeFieldsRequired)return true;
  if(remote.effectiveTime!==production.durationSeconds||!Array.isArray(remote.customFieldValues))return false;
  const material=remote.customFieldValues.filter(f=>Number(f.fieldId)===MATERIAL_FIELD.id);
  const punch=remote.customFieldValues.filter(f=>Number(f.fieldId)===PUNCH_FIELD.id);
  return material.length===1&&material[0].value===production.materialProcess&&punch.length===1
    &&punch[0].value!==null&&String(punch[0].value).trim()!==''&&Number.isFinite(Number(punch[0].value))
    &&Math.abs(Number(punch[0].value)-production.punchMinutes)<0.000001;
}

export function customFieldReadbackMatches(values,payload){
  if(!Array.isArray(values)||values.length!==payload.length)return false;
  const byName=new Map();
  for(const field of values){if(!field||typeof field.name!=='string'||byName.has(field.name)||!scalar(field.value))return false;byName.set(field.name,field.value);}
  return payload.every(field=>byName.has(field.name)&&(field.value===null?byName.get(field.name)===null:byName.get(field.name)!==null&&String(byName.get(field.name))===String(field.value)));
}
