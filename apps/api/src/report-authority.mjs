import {isLocalMemberKey} from './local-members.mjs';
const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const number=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
// Read-only display projection. Never rewrite assignment ownership, timers,
// local-member attribution or a pending/uncertain business operation.
export function reportAuthority(store,readOutput){
 const db=store.db,people=new Map(db.prepare('SELECT id,blacklake_operator_id,name FROM operators').all().map(r=>[r.id,r]));
 const locked=new Set(db.prepare("SELECT report_id FROM integration_jobs WHERE mode='write' AND state IN ('QUEUED','RUNNING','RETRY','UNKNOWN','FAILED') UNION SELECT report_id FROM leader_report_operations WHERE status IN ('CHECKING','PENDING','UNKNOWN')").all().map(r=>r.report_id));
 if(!readOutput){
  const output=db.prepare('SELECT project_id,task_id,raw_json,correction_json,deleted,updated_at FROM blacklake_output_index WHERE output_id=?');
  readOutput=id=>output.get(id);
 }
 return (row,production={})=>{
  const id=row.local_report_id??row.id,person=people.get(production.operatorId??row.operator_id);
  if((row.report_status??row.status)!=='SUCCEEDED'||locked.has(id)||!person||isLocalMemberKey(person.blacklake_operator_id)||!row.blacklake_output_id)return null;
  const index=readOutput(String(row.blacklake_output_id));if(!index||Number(index.project_id)!==Number(row.project_id)||Number(index.task_id)!==Number(row.task_id))return null;
  if(index.deleted)return {deleted:true};
  const raw=parse(index.raw_json),corrected=parse(index.correction_json),native=corrected.native||{},items=corrected.defectItems||raw.defectItemList||raw.defectList||native.defects||[];
  return {deleted:false,goodQuantity:number(corrected.fineAmount??raw.numberofgoodProducts??raw.fineAmount),defectiveQuantity:number(corrected.defectsAmount??raw.numberofDefectives??raw.defectsAmount),reportedSeconds:number(corrected.effectiveTime??raw.effectiveTime),
   personId:String(corrected.operatorId??raw.productionStaffId??raw.productionStaff?.id??raw.operatorId??person.blacklake_operator_id),personName:native.operatorName||raw.productionStaffName||raw.productionStaff?.name||(typeof raw.productionStaff==='string'?raw.productionStaff:'')||raw.operatorName||person.name,
   startedAt:corrected.startedAt??raw.starttimeofReport??raw.startedAt??null,endedAt:corrected.endedAt??raw.endtimeofReport??raw.endedAt??null,
   defectItems:items.map(d=>({code:String(d.code||d.defectCode||''),quantity:number(d.amount??d.defectAmount??d.quantity)})),source:'blacklake-snapshot',sourceUpdatedAt:new Date(index.updated_at).toISOString()};
 };
}
