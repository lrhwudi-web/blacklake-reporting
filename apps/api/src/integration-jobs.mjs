import {createHash,randomUUID} from 'node:crypto';
import {assert} from './errors.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active=['QUEUED','RETRY','RUNNING','UNKNOWN'];
export function assertSyncCanDisable(db){
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_jobs'").get();
 if(exists)assert(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE mode='write' AND state NOT IN ('SUCCEEDED','CANCELLED')").get().n===0,409,'SYNC_OUTBOX_NOT_DRAINED','仍有已接收的报工同步未处理，不能关闭共享同步；请先在数据同步后台处理或排空队列。');
}
export class IntegrationJobs {
 constructor(db,{now=Date.now}={}){
  this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS integration_jobs(
   id TEXT PRIMARY KEY,job_key TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,
   report_id TEXT,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'CHECKING',
   attempts INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 1,claimed_generation INTEGER NOT NULL DEFAULT 0,
   due_at INTEGER NOT NULL,lease_until INTEGER,result_json TEXT NOT NULL DEFAULT '{}',error_code TEXT NOT NULL DEFAULT '',
   safe_retry INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS integration_jobs_due ON integration_jobs(state,due_at);
   CREATE UNIQUE INDEX IF NOT EXISTS integration_one_report_write ON integration_jobs(report_id)
    WHERE mode='write' AND state IN ('QUEUED','RETRY','RUNNING','UNKNOWN');
   CREATE TABLE IF NOT EXISTS integration_job_events(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES integration_jobs(id),
    event TEXT NOT NULL,actor TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS integration_read_state(job_id TEXT PRIMARY KEY REFERENCES integration_jobs(id) ON DELETE CASCADE,queued_at INTEGER NOT NULL,
    demanded_at INTEGER NOT NULL DEFAULT 0,demand_until INTEGER NOT NULL DEFAULT 0,served_at INTEGER NOT NULL DEFAULT 0,progress_json TEXT NOT NULL DEFAULT '{}');
   INSERT OR IGNORE INTO integration_read_state(job_id,queued_at) SELECT id,created_at FROM integration_jobs WHERE mode='read';`);
 }
 get(id){const row=this.db.prepare('SELECT * FROM integration_jobs WHERE id=?').get(id);return row?{...row,payload:JSON.parse(row.payload_json),result:JSON.parse(row.result_json)}:null;}
 byKey(key){const row=this.db.prepare('SELECT id FROM integration_jobs WHERE job_key=?').get(key);return row?this.get(row.id):null;}
 event(id,event,actor='SYSTEM',data={}){this.db.prepare('INSERT INTO integration_job_events(job_id,event,actor,data_json,created_at) VALUES(?,?,?,?,?)').run(id,event,actor,JSON.stringify(data),this.now());}
 enqueue({key,mode,kind,target,payload={},reportId=null,actor='SYSTEM',force=false}){
  const prior=this.byKey(key),digest=hash(payload),at=this.now();
  if(prior){
   if(mode==='write'){assert(prior.request_hash===digest,409,'SYNC_IDEMPOTENCY_CONFLICT','提交内容已变化，请重新核对。');return prior;}
   // Parked read failures require the authenticated retry action. Merely
   // reopening a page or scheduling a refresh must not restart the loop.
   if(prior.state==='FAILED')return prior;
   if(prior.state==='RUNNING'){if(force)this.db.prepare('UPDATE integration_jobs SET generation=generation+1,payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify(payload),at,prior.id);return this.get(prior.id);}
   if(['QUEUED','RETRY'].includes(prior.state)){if(force)this.db.prepare('UPDATE integration_jobs SET generation=generation+1,payload_json=?,request_hash=?,updated_at=? WHERE id=?').run(JSON.stringify(payload),digest,at,prior.id);return this.get(prior.id);}
   this.db.prepare("UPDATE integration_jobs SET state='QUEUED',phase='CHECKING',generation=generation+1,due_at=?,payload_json=?,request_hash=?,error_code='',updated_at=? WHERE id=?").run(at,JSON.stringify(payload),digest,at,prior.id);
   this.db.prepare("UPDATE integration_read_state SET queued_at=?,served_at=0,progress_json='{}' WHERE job_id=?").run(at,prior.id);
   return this.get(prior.id);
  }
  const id=randomUUID();
  try{this.db.prepare("INSERT INTO integration_jobs(id,job_key,mode,kind,target,report_id,request_hash,payload_json,state,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?)").run(id,key,mode,kind,String(target),reportId,digest,JSON.stringify(payload),at,at,at);}
  catch(error){if(mode==='write'&&reportId&&this.pendingReport(reportId))assert(false,409,'REPORT_SYNC_PENDING','这条报工仍在同步或待核对，暂不能重复操作。');throw error;}
  if(mode==='read')this.db.prepare('INSERT INTO integration_read_state(job_id,queued_at) VALUES(?,?)').run(id,at);
  this.event(id,'QUEUED',actor,{kind,target:String(target)});return this.get(id);
 }
 demand(id,ttl=30000){this.db.prepare('UPDATE integration_read_state SET demanded_at=?,demand_until=? WHERE job_id=?').run(this.now(),this.now()+ttl,id);}
 demandState(id){const row=this.db.prepare('SELECT * FROM integration_read_state WHERE job_id=?').get(id);return {active:!!row&&row.demand_until>this.now(),queuedAt:row?.queued_at??null,requestedAt:row?.demanded_at??null};}
 progress(job){const row=this.db.prepare('SELECT progress_json FROM integration_read_state WHERE job_id=?').get(job.id),value=row?JSON.parse(row.progress_json):{};return value.generation===job.claimed_generation?value.steps||{}:{};}
 checkpoint(job,steps){const row=this.get(job.id);assert(row?.state==='RUNNING'&&row.attempts===job.attempts&&row.lease_until>this.now(),409,'SYNC_LEASE_LOST','同步任务已被接管，未保存旧步骤。');this.db.prepare('UPDATE integration_read_state SET progress_json=? WHERE job_id=?').run(JSON.stringify({generation:job.claimed_generation,steps}),job.id);}
 pendingReport(id){const row=this.db.prepare("SELECT id FROM integration_jobs WHERE mode='write' AND report_id=? AND state IN ('QUEUED','RETRY','RUNNING','UNKNOWN')").get(id);return row?this.get(row.id):null;}
 claim({mode,lane,leaseMs=120000}={}){
  this.db.exec('BEGIN IMMEDIATE');try{
  const maintenanceLast=lane==='background'?"CASE json_extract(j.payload_json,'$.reason') WHEN 'nightly' THEN 2 WHEN 'catalog-delta' THEN 1 WHEN 'report-progress' THEN 1 ELSE 0 END, ":"";
  const row=lane?this.db.prepare("SELECT j.id FROM integration_jobs j LEFT JOIN integration_read_state s ON s.job_id=j.id WHERE j.state IN ('QUEUED','RETRY') AND j.due_at<=? AND "+(lane==='write'?"j.mode='write'":lane==='interactive'?"j.mode='read' AND s.demand_until>?":"j.mode='read' AND s.demand_until<=?")+" ORDER BY "+maintenanceLast+"COALESCE(NULLIF(s.served_at,0),s.queued_at,j.created_at),j.due_at,j.rowid LIMIT 1").get(this.now(),...(lane==='write'?[]:[this.now()])):this.db.prepare("SELECT id FROM integration_jobs WHERE state IN ('QUEUED','RETRY') AND due_at<=?"+(mode?' AND mode=?':'')+" ORDER BY CASE WHEN mode='write' THEN 0 WHEN kind IN ('order','output') THEN 1 WHEN kind='history-day' THEN 3 ELSE 2 END,due_at,created_at LIMIT 1").get(this.now(),...(mode?[mode]:[]));
   if(!row){this.db.exec('COMMIT');return null;}
   this.db.prepare("UPDATE integration_jobs SET state='RUNNING',phase='CHECKING',attempts=attempts+1,claimed_generation=generation,lease_until=?,updated_at=? WHERE id=?").run(this.now()+leaseMs,this.now(),row.id);
   this.db.prepare('UPDATE integration_read_state SET served_at=MAX(?+1,COALESCE((SELECT MAX(served_at)+1 FROM integration_read_state),0)) WHERE job_id=?').run(this.now(),row.id);
   this.event(row.id,'RUNNING');this.db.exec('COMMIT');return this.get(row.id);
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 sending(id,attempt){const changed=this.db.prepare("UPDATE integration_jobs SET phase='SENDING',updated_at=? WHERE id=? AND state='RUNNING' AND attempts=? AND lease_until>?").run(this.now(),id,attempt,this.now());assert(changed.changes===1,409,'SYNC_LEASE_LOST','同步任务状态已变化。');this.event(id,'WRITE_BOUNDARY');}
 heartbeat(id,attempt){return this.db.prepare("UPDATE integration_jobs SET lease_until=? WHERE id=? AND state='RUNNING' AND attempts=? AND lease_until>?").run(this.now()+120000,id,attempt,this.now()).changes===1;}
 finish(id,{state='SUCCEEDED',result={},code='',safeRetry=false,delayMs,attempt}={}){
  const row=this.get(id);assert(row?.state==='RUNNING'&&row.attempts===attempt,409,'SYNC_LEASE_LOST','同步任务已被接管，请核对结果。');
  if(row.mode==='read'&&state==='SUCCEEDED'&&row.generation!==row.claimed_generation)state='QUEUED';
  const delay=delayMs??Math.min(15*60000,10000*2**Math.min(row.attempts-1,6));
  const changed=this.db.prepare("UPDATE integration_jobs SET state=CASE WHEN mode='read' AND ?='SUCCEEDED' AND generation<>claimed_generation THEN 'QUEUED' ELSE ? END,result_json=?,error_code=?,safe_retry=?,due_at=?,lease_until=NULL,updated_at=? WHERE id=? AND state='RUNNING' AND attempts=?").run(state,state,JSON.stringify(result),code,safeRetry?1:0,this.now()+(state==='RETRY'||state==='QUEUED'&&delayMs!==undefined?delay:0),this.now(),id,attempt);
  assert(changed.changes===1,409,'SYNC_LEASE_LOST','同步任务已被接管，请核对结果。');this.event(id,this.get(id).state,'SYSTEM',{code});return this.get(id);
 }
 recover(){
  const rows=this.db.prepare("SELECT id,mode,phase FROM integration_jobs WHERE state='RUNNING' AND lease_until<=?").all(this.now());
  const recovered=[];for(const row of rows){const state=row.mode==='write'&&row.phase==='SENDING'?'UNKNOWN':'RETRY',changed=this.db.prepare("UPDATE integration_jobs SET state=?,error_code=?,safe_retry=?,lease_until=NULL,due_at=?,updated_at=? WHERE id=? AND state='RUNNING' AND lease_until<=?").run(state,'WORKER_RESTART',state==='RETRY'?1:0,this.now(),this.now(),row.id,this.now());if(changed.changes){this.event(row.id,state,'SYSTEM',{code:'WORKER_RESTART'});recovered.push(this.get(row.id));}}
  return recovered;
 }
 retry(id,actor,expected){this.db.exec('BEGIN IMMEDIATE');try{const row=this.get(id);assert(row&&['FAILED','RETRY'].includes(row.state)&&row.safe_retry,409,'SYNC_RETRY_UNSAFE','结果未确认或不允许重试，请先核对。');if(expected)assert(row.state===expected.state&&row.attempts===expected.attempts&&row.updated_at===expected.updated_at,409,'SYNC_JOB_CHANGED','同步状态已变化，请刷新。');this.db.prepare("UPDATE integration_jobs SET state='QUEUED',phase='CHECKING',due_at=?,updated_at=?,result_json=? WHERE id=?").run(this.now(),this.now(),JSON.stringify(row.mode==='read'?{...row.result,consecutiveFailures:0}:row.result),id);this.event(id,'MANUAL_RETRY',actor);this.db.exec('COMMIT');return this.get(id);}catch(e){this.db.exec('ROLLBACK');throw e;}}
 list({state,limit=50,offset=0}={}){assert(Number.isInteger(limit)&&limit>0&&limit<=100&&Number.isInteger(offset)&&offset>=0,422,'SYNC_PAGE_INVALID','分页参数无效。');assert(!state||['ATTENTION','QUEUED','RUNNING','RETRY','UNKNOWN','FAILED','SUCCEEDED','CANCELLED'].includes(state),422,'SYNC_STATE_INVALID','同步状态筛选无效。');const where=state==='ATTENTION'?" WHERE state IN ('UNKNOWN','FAILED','RETRY')":state?' WHERE state=?':'';const args=state&&state!=='ATTENTION'?[state]:[];return {total:this.db.prepare('SELECT COUNT(*) n FROM integration_jobs'+where).get(...args).n,jobs:this.db.prepare('SELECT id FROM integration_jobs'+where+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...args,limit,offset).map(r=>this.get(r.id))};}
}
export const pendingSyncStates=active;
