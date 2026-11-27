import {randomUUID} from 'node:crypto';
import {assert,AppError} from './errors.mjs';
import {fingerprintText,stableHash} from './crypto.mjs';
import {reportProduction} from './report-production.mjs';

// Legacy APIs call their directory key blacklakeOperatorId. Local members have
// a reserved SYSTEM key, never an upstream identity. Only submitAsId is sent
// to Blacklake; operators.id remains the owner of all business records.
export const LOCAL_MEMBER_KEY_BASE=1_000_000_000_000;
export const isLocalMemberKey=id=>Number.isSafeInteger(Number(id))&&Number(id)>=LOCAL_MEMBER_KEY_BASE;
const clean=(v,max,label)=>{const s=String(v??'').normalize('NFKC').trim();assert(s&&s.length<=max&&!/[\u0000-\u001f\u007f]/.test(s),422,'INVALID_LOCAL_MEMBER',label);return s;};

export class LocalMembers {
 constructor(store){this.store=store;this.db=store.db;this.db.exec(`
  CREATE TABLE IF NOT EXISTS local_members(person_key INTEGER PRIMARY KEY,operator_id INTEGER NOT NULL UNIQUE REFERENCES operators(id),member_code TEXT NOT NULL UNIQUE,
   submit_as_id INTEGER NOT NULL,submit_as_name TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS local_member_events(id TEXT PRIMARY KEY,person_key INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,previous_json TEXT,next_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS local_member_operations(operation_id TEXT PRIMARY KEY,actor TEXT NOT NULL,request_hash TEXT NOT NULL,person_key INTEGER NOT NULL REFERENCES local_members(person_key));
  CREATE TABLE IF NOT EXISTS report_submission_identities(report_id TEXT PRIMARY KEY REFERENCES reports(id),actual_operator_id INTEGER NOT NULL REFERENCES operators(id),actual_name TEXT NOT NULL,
   submit_as_id INTEGER NOT NULL,submit_as_name TEXT NOT NULL,member_revision INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 `);}
 byKey(key,{includeInactive=false}={}){return this.db.prepare(`SELECT m.person_key AS personId,m.person_key AS blacklakeOperatorId,m.operator_id AS id,o.name,o.group_names_json AS groups,
  m.member_code AS memberCode,m.submit_as_id AS submitAsId,m.submit_as_name AS submitAsName,m.revision,o.active,m.updated_at AS updatedAt
  FROM local_members m JOIN operators o ON o.id=m.operator_id WHERE m.person_key=? ${includeInactive?'':'AND o.active=1'}`).get(Number(key));}
 present(row){if(!row)return undefined;const {groups,...value}=row;return{...value,identitySource:'LOCAL',blacklakeSourceId:null,groupNames:JSON.parse(groups),active:Boolean(value.active)};}
 list({includeInactive=false}={}){return this.db.prepare(`SELECT person_key FROM local_members ${includeInactive?'':'WHERE operator_id IN (SELECT id FROM operators WHERE active=1)'} ORDER BY person_key`).all().map(r=>this.present(this.byKey(r.person_key,{includeInactive})));}
 decorate(person){const local=isLocalMemberKey(person?.blacklakeOperatorId)?this.byKey(person.blacklakeOperatorId,{includeInactive:true}):null;return local?{...person,...this.present(local)}:person;}
 validate(input){
  const allowed=['name','groupNames','submitAsId','expectedRevision','active','operationId','workerType','qualityRole','selfServiceEnabled'];
  assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>allowed.includes(k)),422,'INVALID_LOCAL_MEMBER','成员参数不正确。');
  const name=clean(input.name,50,'姓名需为1至50字。'),groupNames=input.groupNames??[];
  assert(Array.isArray(groupNames)&&groupNames.length<=20,422,'INVALID_LOCAL_MEMBER','最多填写20个所属组。');
  const groups=[...new Set(groupNames.map(v=>clean(v,40,'组名称需为1至40字。')))];
  const submitAsId=Number(input.submitAsId);assert(Number.isSafeInteger(submitAsId)&&submitAsId>0&&!isLocalMemberKey(submitAsId),422,'INVALID_SUBMIT_PERSON','请选择真实黑湖提交人员。');
  assert(input.active===undefined||typeof input.active==='boolean',422,'INVALID_LOCAL_MEMBER','启停状态不正确。');
  assert(input.workerType===undefined||['floor8','embroidery'].includes(input.workerType),422,'INVALID_WORKER_TYPE','请选择8楼或绣花员工。');
  assert(input.qualityRole===undefined||['standard','quality'].includes(input.qualityRole),422,'INVALID_QUALITY_ROLE','请选择普通或质检人员。');
  assert(input.selfServiceEnabled===undefined||typeof input.selfServiceEnabled==='boolean',422,'INVALID_SELF_SERVICE_PERMISSION','自主报工设置不正确。');
  return{name,groupNames:groups,submitAsId,active:input.active??true,workerType:input.workerType||'floor8',qualityRole:input.qualityRole||'standard',selfServiceEnabled:input.selfServiceEnabled??false};
 }
 busy(key){return this.store.hasActiveAssignmentForBlacklakeOperator(key)||Boolean(this.db.prepare("SELECT 1 FROM assignments a JOIN operators o ON o.id=a.operator_id WHERE o.blacklake_operator_id=? AND a.status='QUANTITY_PENDING' LIMIT 1").get(key))||Boolean(this.db.prepare("SELECT 1 FROM reports r JOIN operators o ON o.id=r.operator_id WHERE o.blacklake_operator_id=? AND r.status IN ('PENDING','UNKNOWN') LIMIT 1").get(key));}
 async save(input,{key,actor,upstream}){
  const next=this.validate(input),people=await upstream.listOperators(),sender=people.find(p=>p.blacklakeOperatorId===next.submitAsId&&!isLocalMemberKey(p.blacklakeOperatorId));
  assert(sender,422,'SUBMIT_PERSON_NOT_FOUND','黑湖提交人已不在当前名单，请刷新后重新选择。');
  const operationId=String(input.operationId||'');if(!key)assert(/^[a-zA-Z0-9_-]{16,128}$/.test(operationId),422,'LOCAL_MEMBER_OPERATION_REQUIRED','请刷新页面后重试新增。');
  const requestHash=stableHash(next);
  this.db.exec('BEGIN IMMEDIATE');try{
   if(!key){const receipt=this.db.prepare('SELECT * FROM local_member_operations WHERE operation_id=?').get(operationId);if(receipt){assert(receipt.actor===actor&&receipt.request_hash===requestHash,409,'LOCAL_MEMBER_OPERATION_REUSED','新增请求已被使用，请刷新核对。');this.db.exec('COMMIT');return this.present(this.byKey(receipt.person_key,{includeInactive:true}));}}
   let before=null,personKey=Number(key);
   if(key){before=this.byKey(personKey,{includeInactive:true});assert(before,404,'LOCAL_MEMBER_NOT_FOUND','没有找到本系统成员。');assert(input.expectedRevision===before.revision,409,'LOCAL_MEMBER_CHANGED','成员资料已改变，请刷新后重试。');
    if(before.submitAsId!==next.submitAsId||Boolean(before.active)!==next.active)assert(!this.busy(personKey),409,'LOCAL_MEMBER_HAS_WORK','此人还有待开始、进行中、待核量或结果待核对记录，请先处理再切换提交人或停用。');
    assert(!['workerType','qualityRole','selfServiceEnabled'].some(k=>input[k]!==undefined),422,'LOCAL_MEMBER_PROFILE_SEPARATE','请在原人员权限入口调整归属、质检和自主报工设置。');
    this.db.prepare('UPDATE operators SET name=?,name_key=?,group_names_json=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next.name,next.name.toLocaleLowerCase('zh-CN'),JSON.stringify(next.groupNames),next.active?1:0,before.id);
    this.db.prepare('UPDATE local_members SET submit_as_id=?,submit_as_name=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE person_key=?').run(sender.blacklakeOperatorId,sender.name,personKey);
   }else{
    personKey=Math.max(LOCAL_MEMBER_KEY_BASE,Number(this.db.prepare('SELECT MAX(person_key) AS n FROM local_members').get().n)||0)+1;assert(Number.isSafeInteger(personKey),500,'LOCAL_MEMBER_ID_LIMIT','成员编号已达上限。');
    assert(!this.db.prepare('SELECT 1 FROM operators WHERE blacklake_operator_id=?').get(personKey),409,'LOCAL_MEMBER_ID_COLLISION','系统成员编号冲突，请联系管理员。');
    const inserted=this.db.prepare("INSERT INTO operators(name,name_key,phone_hash,phone_last4,blacklake_operator_id,group_names_json,active) VALUES (?,?,?,'',?,?,?)").run(next.name,next.name.toLocaleLowerCase('zh-CN'),fingerprintText('local-member:'+personKey,this.store.sessionSecret),personKey,JSON.stringify(next.groupNames),next.active?1:0);
    this.db.prepare('INSERT INTO local_members(person_key,operator_id,member_code,submit_as_id,submit_as_name,revision) VALUES (?,?,?,?,?,1)').run(personKey,Number(inserted.lastInsertRowid),'LM-'+String(personKey-LOCAL_MEMBER_KEY_BASE).padStart(5,'0'),sender.blacklakeOperatorId,sender.name);
    this.db.prepare("INSERT INTO operator_entry_profiles(blacklake_operator_id,app_role,work_unit_id) VALUES (?,'employee','')").run(personKey);
    this.db.prepare('INSERT INTO operator_worker_types(blacklake_operator_id,worker_type,revision) VALUES (?,?,1)').run(personKey,next.workerType);
    this.db.prepare('INSERT INTO operator_quality_profiles(blacklake_operator_id,quality_role,revision) VALUES (?,?,1)').run(personKey,next.qualityRole);
    this.db.prepare('INSERT INTO operator_self_service_permissions(blacklake_operator_id,enabled,revision) VALUES (?,?,1)').run(personKey,next.selfServiceEnabled?1:0);
    this.db.prepare('INSERT INTO local_member_operations(operation_id,actor,request_hash,person_key) VALUES (?,?,?,?)').run(operationId,actor,requestHash,personKey);
   }
   if(!next.active){const id=this.byKey(personKey,{includeInactive:true}).id;this.db.prepare('DELETE FROM sessions WHERE operator_id=?').run(id);this.db.prepare('UPDATE operator_binding_codes SET used_at=CURRENT_TIMESTAMP WHERE operator_id=? AND used_at IS NULL').run(id);}
   const after=this.present(this.byKey(personKey,{includeInactive:true}));this.db.prepare('INSERT INTO local_member_events(id,person_key,actor,action,previous_json,next_json) VALUES (?,?,?,?,?,?)').run(randomUUID(),personKey,actor,before?'UPDATE':'CREATE',before?JSON.stringify(this.present(before)):null,JSON.stringify(after));
   this.db.exec('COMMIT');return after;
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 snapshot(reportId){return this.db.prepare('SELECT actual_operator_id AS actualOperatorId,actual_name AS actualName,submit_as_id AS submitAsId,submit_as_name AS submitAsName,member_revision AS memberRevision,created_at AS createdAt FROM report_submission_identities WHERE report_id=?').get(reportId);}
 assignmentsForOutputs(outputs){
  const ids=[...new Set(outputs.map(r=>String(r.id??'')).filter(Boolean))].slice(0,2000),result=[];
  for(let i=0;i<ids.length;i+=400){const batch=ids.slice(i,i+400);result.push(...this.db.prepare(`SELECT a.*,r.operator_id AS current_report_operator_id,o.name AS operator_name,o.phone_last4 AS operator_phone_last4,r.blacklake_output_id
   FROM assignments a JOIN reports r ON r.id=a.report_id JOIN local_members m ON m.operator_id=r.operator_id JOIN operators o ON o.id=r.operator_id
   WHERE r.blacklake_output_id IN (${batch.map(()=>'?').join(',')})`).all(...batch).map(row=>{
    const details=reportProduction(this.store,row.report_id),record=this.store.assignmentRecord({...row,operator_id:row.current_report_operator_id,started_at:details?.startedAt??row.started_at,ended_at:details?.endedAt??row.ended_at,duration_seconds:details?.durationSeconds??row.duration_seconds});
    return {...record,originalAssignedOperatorId:row.operator_id,...(details?{originalSubmissionIdentity:record.submissionIdentity,submissionIdentity:{actualOperatorId:details.operatorId,actualName:details.operatorName,submitAsId:details.upstreamOperatorId,submitAsName:details.upstreamOperatorName}}:{})};
   }));}return result;
 }
 async submit(upstream,input){
  const key=input.operator?.blacklakeOperatorId;if(!isLocalMemberKey(key))return upstream.createOutput(input);
  try{
   const person=this.byKey(key);assert(person&&person.id===input.operator.id,409,'LOCAL_MEMBER_DISABLED','本系统成员已停用或身份不一致，请联系管理员。');
   const report=this.store.reportById(input.reportId);assert(report&&report.operator_id===person.id&&report.status==='PENDING',409,'LOCAL_REPORT_IDENTITY_REQUIRED','报工身份尚未保存，不能提交黑湖。');
   const target=(await upstream.listOperators()).find(p=>p.blacklakeOperatorId===person.submitAsId&&!isLocalMemberKey(p.blacklakeOperatorId));assert(target,409,'SUBMIT_PERSON_UNAVAILABLE','黑湖提交人已不可用，本次尚未提交，请联系管理员。');
   const current=this.byKey(key);assert(current&&current.revision===person.revision&&current.submitAsId===target.blacklakeOperatorId,409,'LOCAL_MEMBER_CHANGED','提交身份配置已变化，请刷新后重试。');
   const prior=this.snapshot(report.id);if(prior)assert(prior.actualOperatorId===person.id&&prior.submitAsId===target.blacklakeOperatorId,409,'SUBMIT_IDENTITY_CHANGED','本笔报工已固定提交身份，不能换人重报。');
   else this.db.prepare('INSERT INTO report_submission_identities(report_id,actual_operator_id,actual_name,submit_as_id,submit_as_name,member_revision) VALUES (?,?,?,?,?,?)').run(report.id,person.id,person.name,target.blacklakeOperatorId,target.name,person.revision);
   // Mark the boundary explicitly. Errors before this call are definite local
   // failures; the original writer still classifies uncertain remote outcomes.
   input={...input,operator:{...input.operator,blacklakeOperatorId:target.blacklakeOperatorId,name:target.name}};
  }catch(error){if(['BLACKLAKE_TIMEOUT','BLACKLAKE_UNAVAILABLE'].includes(error.code))error=new AppError(503,'LOCAL_SUBMISSION_NOT_SENT','尚未提交黑湖，暂时无法核验提交人，请稍后重试。');error.definiteFailure=true;throw error;}
  return upstream.createOutput(input);
 }
}

export function withLocalMembers(store,upstream){return new Proxy(upstream,{get(target,property){
 if(property==='listOperators')return async(...args)=>{const people=await target.listOperators(...args);assert(people.every(p=>!isLocalMemberKey(p.blacklakeOperatorId)),502,'UPSTREAM_PERSON_ID_COLLISION','黑湖人员编号进入系统保留区间，请联系管理员核对。');return[...people,...store.members.list()];};
 if(property==='createOutput')return input=>store.members.submit(target,input);
 const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
}});}
