import {createHash} from 'node:crypto';
import {assert,AppError} from './errors.mjs';

export const processEditKind='order-process-edit';
const failureText={
 PROCESS_EDIT_CHANGED:'黑湖工单或工序已变化，请重新读取。',
 PROCESS_EDIT_USED:'这道工序已有派工、计时或报工记录，请保留原工序。',
 PROCESS_EDIT_DEFINITION:'该工序含质检、委外或复杂参数，请在黑湖添加。',
 PROCESS_EDIT_NO_CHANGE:'工序资料没有变化。'
};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const empty=value=>value==null||Array.isArray(value)&&value.length===0;
const activeStatus=value=>value!=null&&[0,10].includes(Number(value));
const skuOf=project=>typeof project.productCode==='string'?project.productCode.trim():'';
const fields=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row[key]??null]));
const canonical=value=>value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(canonical):
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const custom=value=>(value||[]).map(row=>fields(row,['fieldId','value'])).sort((a,b)=>a.fieldId-b.fieldId);
const projectFields=project=>({...fields(project,['productId','planStartTime','planEndTime','projectCode','remark','planAmount','priority']),
  projectId:project.id,customFieldValueList:custom(project.customFieldValues)});
const rowFields=row=>({
  ...fields(row,['projectProcessId','outputRate','processStartTime','processEndTime','planAmount','processId','inspectionMethod','processingType']),
  inspectionSpecificationId:row.inspectionSpecificationId??null,customFieldValueList:custom(row.customFieldValues),
  ...(row.projectProcessFields?.length?{processFields:row.projectProcessFields.map(field=>fields(field,['field','fieldType','fieldValue']))}:{}),
  distributeUserIds:row.distributeUserIds??row.distributeUsers?.map(person=>person.id)??[]
});

function routeRows(data){
 const project=data.project;
 if(!activeStatus(project.status)||project.sourceType!=null||project.blMerge!=null||
   ![data.saleOrderInfos,project.saleOrderInfos,project.relatedFormList,data.productionMaterialsList,data.projectMaterialRequirementsVOList,
     data.collaborativeTaskList,data.dispatchSources].every(empty))return null;
 if(!Array.isArray(data.processList)||data.processList.length>200||data.processList.some(group=>group.type!==1||group.remark||
   !Array.isArray(group.projectProcessList)||group.projectProcessList.length!==1))return null;
 const rows=data.processList.map(group=>group.projectProcessList[0]);
 if(rows.some(row=>!positive(row.projectProcessId)||!positive(row.processId)||!positive(Number(row.planAmount))||
   row.projectId!==project.id||row.processRoutingId!=null||!empty(row.userDistributeQtyList))||
   new Set(rows.map(row=>row.projectProcessId)).size!==rows.length)return null;
 return rows;
}

const viewRows=rows=>rows.map(row=>({id:row.projectProcessId,definitionId:row.processId,name:row.processName||'工序名称未提供',
 code:row.processCode||'',planQuantity:Number(row.planAmount)}));
const projectFingerprint=project=>hash([projectFields(project),project.status]);
const versionOf=(project,rows)=>hash([projectFingerprint(project),rows.map(rowFields)]);
const productionFingerprint=row=>hash(fields(row,['processStatus','realAmount','defectsAmount','processRealStartTime','processRealEndTime',
 'distributeAmount','clockOn','userClockOnRecords','selfMadeFineAmount','outsourceFineAmount','outsourceOrderIds','inspectionOrders']));
const orderProductionFingerprint=project=>hash(fields(project,['realAmount','defectsAmount','realStartTime','realEndTime']));

export class OrderProcessEdits {
 constructor({store,sync,blacklake,now=Date.now}){
  Object.assign(this,{store,sync,blacklake,now,db:store.db,jobs:sync.jobs});
  this.db.exec(`CREATE TABLE IF NOT EXISTS sku_process_changes(
    job_id TEXT PRIMARY KEY REFERENCES integration_jobs(id),product_id INTEGER NOT NULL,sku TEXT NOT NULL,
    order_id INTEGER NOT NULL,order_code TEXT NOT NULL,operator_id INTEGER NOT NULL,action TEXT NOT NULL,
    before_json TEXT NOT NULL,after_json TEXT NOT NULL,confirmed_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sku_process_changes_product ON sku_process_changes(product_id,confirmed_at DESC);
    CREATE INDEX IF NOT EXISTS sku_process_changes_sku ON sku_process_changes(sku,confirmed_at DESC);
    CREATE INDEX IF NOT EXISTS integration_order_process_edit_target ON integration_jobs(target) WHERE kind='order-process-edit';`);
  sync.handlers.set(processEditKind,job=>this.write(job));
  sync.routeEdits=this;
 }
 authorize(id){
  const person=this.store.findOperatorByBlacklakeId(id);
  assert(person&&this.store.entryProfile(id).appRole==='floor8_leader',403,'PROCESS_EDIT_ROLE','只有组长可以管理工单工序。');
 }
 async detail(orderId){
  assert(positive(orderId),422,'PROCESS_EDIT_ORDER','工单编号无效。');
  const response=await this.blacklake.nativeRequest('/api/dytin/project/web/detail',{projectId:orderId});
  const data=response?.data;
  assert(response?.code==='01000000'&&data?.project?.id===orderId&&typeof data.project.projectCode==='string'&&data.project.projectCode,
    502,'PROCESS_EDIT_ORDER','无法核对这张工单的黑湖工序。');
  return data;
 }
 rowBlock(orderId,row){
  if(this.db.prepare('SELECT 1 FROM assignments WHERE project_id=? AND task_id=? LIMIT 1').get(orderId,row.projectProcessId))return '已有派工或计时记录';
  if(this.db.prepare('SELECT 1 FROM blacklake_output_index WHERE project_id=? AND task_id=? LIMIT 1').get(orderId,row.projectProcessId))return '已有报工记录';
  if(!activeStatus(row.processStatus)||![row.realAmount,row.defectsAmount].every(value=>value!=null&&String(value).trim()!==''&&Number(value)===0)||
    row.lastReportTime||row.processRealStartTime||row.processRealEndTime||Number(row.distributeAmount)>0||
    ![row.userClockOnRecords,row.outsourceOrderIds,row.inspectionOrders].every(empty)||row.clockOn===true)return '已有生产数据或工序状态需核对';
  return '';
 }
 receipt(job){
  return job?{id:job.id,state:job.state,message:job.result?.message||(job.state==='FAILED'?failureText[job.error_code]:'')||''}:null;
 }
 active(orderId){return this.jobs.pendingReport('order-process:'+orderId);}
 async context(orderId,operatorId){
  this.authorize(operatorId);
  const data=await this.detail(orderId),project=data.project,rows=routeRows(data),sku=skuOf(project);
  const supported=rows!==null&&positive(project.productId)&&sku&&positive(Number(project.planAmount));
  return {orderId,sku,planQuantity:Number(project.planAmount)||null,version:supported?versionOf(project,rows):null,
    blockedReason:supported?'':'这张工单的工艺路线、关联单据或 SKU 资料尚未通过编辑校验，请在黑湖处理。',
    rows:rows?viewRows(rows).map((row,index)=>({...row,blockedReason:this.rowBlock(orderId,rows[index])})):[],
    job:this.receipt(this.active(orderId))};
 }
 getJob(orderId,id,operatorId){
  this.authorize(operatorId);
  const job=this.jobs.get(id);
  assert(job?.kind===processEditKind&&job.target===String(orderId),404,'PROCESS_EDIT_JOB','没有找到此工单的工序修改记录。');
  return this.receipt(job);
 }
 async catalog(query,operatorId){
  this.authorize(operatorId);
  assert(typeof query==='string'&&query.length<=100,422,'PROCESS_EDIT_QUERY','请缩短工序搜索词。');
  if(!this.catalogCache||this.now()>=this.catalogCache.until){
   this.catalogLoad||=this.loadCatalog().finally(()=>{this.catalogLoad=null;});
   await this.catalogLoad;
  }
  const normalize=value=>value.normalize('NFKC').toLowerCase().trim(),term=normalize(query);
  const all=this.catalogCache.rows.filter(row=>normalize(row.name+' '+row.code).includes(term));
  return {rows:all.slice(0,80),hasMore:all.length>80,source:'blacklake-process-catalog'};
 }
 async loadCatalog(){
  const found=new Map(),pageSize=100;
  for(let pageNum=1;pageNum<=20;pageNum++){
   const response=await this.blacklake.nativeRequest('/api/dytin/process/dropDown',{page:{pageNum,pageSize}});
   const list=Array.isArray(response?.data)?response.data:response?.data?.data;
   assert(response?.code==='01000000'&&Array.isArray(list),502,'PROCESS_EDIT_CATALOG','无法读取黑湖工序目录。');
   const before=found.size;
   for(const row of list){
    assert(positive(row.id)&&typeof row.name==='string'&&row.name.trim(),502,'PROCESS_EDIT_CATALOG','黑湖工序目录格式未能确认。');
    if(!row.deletedAt)found.set(row.id,{id:row.id,name:row.name,code:String(row.code||'')});
   }
   const total=response.page?.total??response.data?.total;
   if(list.length<pageSize||Number.isSafeInteger(total)&&pageNum*pageSize>=total){
    this.catalogCache={rows:[...found.values()],until:this.now()+5*60000};return;
   }
   assert(found.size>before,502,'PROCESS_EDIT_CATALOG','黑湖未返回下一页工序，无法确认完整目录。');
  }
  throw new AppError(502,'PROCESS_EDIT_CATALOG','工序目录尚未完整读取，请稍后重试。');
 }
 enqueue(orderId,input,operationId,operatorId){
  this.authorize(operatorId);
  const {action,version,id,definitionId,planQuantity,ids}=input||{};
  assert(/^[A-Za-z0-9_-]{16,120}$/.test(operationId)&&/^[a-f0-9]{64}$/.test(version)&&
    ['add','edit','delete','reorder'].includes(action),422,'PROCESS_EDIT_INPUT','请刷新后提交有效的工序修改。');
  assert(action!=='add'||positive(definitionId),422,'PROCESS_EDIT_INPUT','请从黑湖目录选择工序。');
  assert(!['edit','delete'].includes(action)||positive(id),422,'PROCESS_EDIT_INPUT','请选择当前工单的工序。');
  assert(action!=='edit'||positive(planQuantity)&&(definitionId==null||positive(definitionId)),422,'PROCESS_EDIT_INPUT','请输入有效计划数并选择目录中的工序。');
  assert(action!=='reorder'||Array.isArray(ids)&&ids.length<=200&&ids.every(positive)&&new Set(ids).size===ids.length,
    422,'PROCESS_EDIT_INPUT','请提交完整工序顺序。');
  const key='order-process-edit:'+operatorId+':'+operationId;
  const payload={operatorId,orderId,action,version,...(action==='add'?{definitionId}:action==='edit'?{id,planQuantity,definitionId:definitionId??null}:action==='delete'?{id}:{ids})};
  if(!this.jobs.byKey(key))assert(!this.active(orderId),409,'PROCESS_EDIT_PENDING','这张工单的工序修改正在核对，其他工序仍可使用。');
  return this.receipt(this.jobs.enqueue({key,kind:processEditKind,mode:'write',target:orderId,reportId:'order-process:'+orderId,payload,actor:'leader:'+operatorId}));
 }
 async definition(id,project,planQuantity){
  const response=await this.blacklake.nativeRequest('/api/dytin/process/queryById',{id}),row=response?.data;
  assert(response?.code==='01000000'&&row?.id===id&&!row.deletedAt&&Number(row.processingType)===0&&Number(row.outputRate)===1&&
    empty(row.fields)&&empty(row.inspectionMethod)&&!row.inspectionSpecificationId,409,'PROCESS_EDIT_DEFINITION',
    '这道工序含质检、委外或复杂参数，请在黑湖添加。');
  return {processId:id,planAmount:planQuantity,outputRate:1,processStartTime:project.planStartTime??null,processEndTime:project.planEndTime??null,
    processingType:0,inspectionMethod:[],inspectionSpecificationId:null,customFieldValueList:custom(row.customFieldValues),distributeUserIds:[]};
 }
 async plan(data,rows,input){
  const {action,id,definitionId,planQuantity,ids}=input,project=data.project,desired=rows.map(rowFields);
  if(action==='reorder'){
   const byId=new Map(desired.map(row=>[row.projectProcessId,row]));
   assert(ids.length===rows.length&&ids.every(value=>byId.has(value)),409,'PROCESS_EDIT_CHANGED','工序集合已变化，请重新读取。');
   return ids.map(value=>byId.get(value));
  }
  if(action==='add'){
   const addition=await this.definition(definitionId,project,Number(project.planAmount));
   return [...desired,addition];
  }
  const index=rows.findIndex(row=>row.projectProcessId===id);
  assert(index>=0,409,'PROCESS_EDIT_CHANGED','这道工序已变化，请重新读取。');
  if(action==='delete')return desired.filter((_row,i)=>i!==index);
  desired[index]=definitionId&&definitionId!==rows[index].processId?await this.definition(definitionId,project,planQuantity):{...desired[index],planAmount:planQuantity};
  return desired;
 }
 intent(job){
  const row=this.db.prepare("SELECT data_json FROM integration_job_events WHERE job_id=? AND event='PROCESS_EDIT_INTENT' ORDER BY id DESC LIMIT 1").get(job.id);
  return row?JSON.parse(row.data_json):null;
 }
 async write(job){
  const input=job.payload,{orderId,operatorId,action,id}=input;
  this.authorize(operatorId);
  const data=await this.detail(orderId),project=data.project,rows=routeRows(data),sku=skuOf(project);
  assert(rows&&sku&&positive(project.productId)&&positive(Number(project.planAmount))&&versionOf(project,rows)===input.version,
    409,'PROCESS_EDIT_CHANGED','黑湖工单或工序已变化，请重新读取。');
  const desired=await this.plan(data,rows,input);
  assert(desired.length<=200,409,'PROCESS_EDIT_LIMIT','工序数量超出本次可核对范围。');
  assert(hash(desired)!==hash(rows.map(rowFields)),409,'PROCESS_EDIT_NO_CHANGE','工序资料没有变化。');
  const before=viewRows(rows);
  const production=new Map(rows.map(row=>[row.projectProcessId,productionFingerprint(row)]));
  const intent={orderId,sku,productId:project.productId,orderCode:project.projectCode,projectHash:projectFingerprint(project),projectProductionHash:orderProductionFingerprint(project),
    before,expected:desired.map(row=>({id:row.projectProcessId??null,definitionId:row.processId,planQuantity:Number(row.planAmount),unchangedHash:row.projectProcessId?hash(row):null,
      productionHash:production.get(row.projectProcessId)??null}))};
  const techAndProcessList=desired.map((row,index)=>({type:1,primaryId:row.processId,processRoutingSeq:index+1,projectProcessList:[{...row,seq:index+1}]}));
  const payload={project:{...projectFields(project),techAndProcessList,productionMaterialsList:[],saleOrderDetailList:[]}};
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.sync.assertClaim(job);
   if(action==='delete'||action==='edit'){
    const row=rows.find(row=>row.projectProcessId===id),blocked=this.rowBlock(orderId,row);
    assert(!blocked,409,'PROCESS_EDIT_USED',blocked+'，请保留原工序。');
   }
   this.jobs.event(job.id,'PROCESS_EDIT_INTENT','SYSTEM',intent);
   this.jobs.sending(job.id,job.attempts);
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  let response;
  try{response=await this.blacklake.nativeRequest('/api/dytin/project/update',payload,{write:true,retryAuth:false});}
  catch(error){
   if(error.writeNotSent===true)error.definiteFailure=true;
   if(error.definiteFailure===true)throw error;
  }
  if(response?.code&&response.code!=='01000000')this.jobs.event(job.id,'PROCESS_EDIT_RESPONSE','SYSTEM',{code:String(response.code).slice(0,32)});
  const after=await this.detail(orderId);
  if(!this.matches(after,intent))throw new AppError(409,'PROCESS_EDIT_UNCONFIRMED','黑湖工序修改结果核对中。');
  this.sync.assertClaim(job);
  this.confirm(job,intent,after);
  return {message:'黑湖工序已更新，改动已记入 SKU 履历。'};
 }
 matches(data,intent){
  const rows=routeRows(data);
  if(!rows||projectFingerprint(data.project)!==intent.projectHash||orderProductionFingerprint(data.project)!==intent.projectProductionHash||
    data.project.productId!==intent.productId||skuOf(data.project)!==intent.sku||rows.length!==intent.expected.length)return false;
  const priorIds=new Set(intent.before.map(row=>row.id));
  return rows.every((row,index)=>{
   const expected=intent.expected[index];
   return row.processId===expected.definitionId&&Number(row.planAmount)===expected.planQuantity&&
    (expected.id===null?!priorIds.has(row.projectProcessId):row.projectProcessId===expected.id&&hash(rowFields(row))===expected.unchangedHash&&
      productionFingerprint(row)===expected.productionHash);
  });
 }
 confirm(job,intent,data){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare(`INSERT OR IGNORE INTO sku_process_changes VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(job.id,intent.productId,intent.sku,intent.orderId,intent.orderCode,job.payload.operatorId,job.payload.action,
      JSON.stringify(intent.before),JSON.stringify(viewRows(routeRows(data))),this.now());
   this.sync.invalidateOrder(intent.orderId,{});
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async reconcile(job){
  const intent=this.intent(job);
  if(!intent)return this.receipt(job);
  const saved=this.db.prepare('SELECT 1 FROM sku_process_changes WHERE job_id=?').get(job.id);
  if(!saved){
   const after=await this.detail(intent.orderId);
   if(!this.matches(after,intent))return this.receipt(job);
   this.confirm(job,intent,after);
  }
  const changed=this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',result_json=?,updated_at=? WHERE id=? AND state='UNKNOWN'")
    .run(JSON.stringify({message:'黑湖工序已确认，改动已记入 SKU 履历。'}),this.now(),job.id);
  if(changed.changes)this.jobs.event(job.id,'SUCCEEDED','SYSTEM',{readOnly:true});
  return this.receipt(this.jobs.get(job.id));
 }
}

// Only target the changed row. Other steps can keep receiving work while a route write is queued.
export function processEditLocksTask(db,orderId,processId){
 return Boolean(db.prepare(`SELECT 1 FROM integration_jobs j WHERE j.kind='order-process-edit' AND j.target=?
   AND CAST(json_extract(j.payload_json,'$.id') AS INTEGER)=? AND (
    j.state IN ('QUEUED','RETRY','RUNNING','UNKNOWN') OR
    j.state='SUCCEEDED' AND EXISTS (SELECT 1 FROM sku_process_changes c WHERE c.job_id=j.id AND NOT EXISTS (
      SELECT 1 FROM json_each(c.after_json) r WHERE json_extract(r.value,'$.id')=?))
   ) LIMIT 1`).get(String(orderId),Number(processId),Number(processId)));
}
