import {createHash} from 'node:crypto';
import {assert} from './errors.mjs';
import {timestampMs,workingIntervalsBetween} from './work-time.mjs';
import {TaskRecovery,shanghaiTime} from './task-recovery.mjs';

const HOUR=3600000,DAY=24*HOUR,OFFSET=8*HOUR;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDate=value=>Number.isFinite(timestampMs(value));
const referenceLabels={
 'team-leader':'所属组长下班记录',
 'other-leader':'其他组长下班记录',
 majority:'多数员工最后结束时间中位数',
 'employee-end':'晚于本任务活动的最近员工结束记录',
 'employee-pause':'晚于本任务活动的最近员工暂停记录',
 'task-activity':'本任务最后活动',
};
export function overnightWindow(now){
 const midnight=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET,cutoff=midnight+2*HOUR;
 if(now<cutoff)return null;
 return {businessDate:shanghaiTime(midnight-DAY).slice(0,10),from:shanghaiTime(cutoff-DAY),cutoff:shanghaiTime(cutoff)};
}

// Pauses the local production clock only. Never finishes a task or writes Blacklake.
export class OvernightClockout {
 constructor({store,leaderClockout,now=Date.now,referencePolicy='team-first'}){
  assert(['team-first','global-last','team-only'].includes(referencePolicy),500,'OVERNIGHT_POLICY_INVALID','自动补暂停参考规则不正确。');
  Object.assign(this,{store,leaderClockout,now,referencePolicy});this.db=store.db;this.recovery=new TaskRecovery(store,{now});
  if(!this.db.prepare('PRAGMA table_info(assignment_pauses)').all().some(row=>row.name==='source'))this.db.exec("ALTER TABLE assignment_pauses ADD COLUMN source TEXT NOT NULL DEFAULT 'employee'");
  this.db.exec(`CREATE TABLE IF NOT EXISTS overnight_clockout_runs(
   business_date TEXT PRIMARY KEY,cutoff_at TEXT NOT NULL,executed_at TEXT NOT NULL,reference_policy TEXT NOT NULL,
   status TEXT NOT NULL,result_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS overnight_clockout_items(
   id INTEGER PRIMARY KEY,business_date TEXT NOT NULL REFERENCES overnight_clockout_runs(business_date),
   assignment_id TEXT NOT NULL REFERENCES assignments(id),operator_id INTEGER NOT NULL,owner_id INTEGER,
   reference_run_id TEXT,reference_kind TEXT NOT NULL,reference_at TEXT,pause_at TEXT,pause_id INTEGER REFERENCES assignment_pauses(id),
   status TEXT NOT NULL,detail_json TEXT NOT NULL,UNIQUE(business_date,assignment_id));
   CREATE INDEX IF NOT EXISTS overnight_clockout_assignment ON overnight_clockout_items(assignment_id,business_date);`);
 }
 people(){return this.db.prepare("SELECT o.id,o.blacklake_operator_id FROM operators o LEFT JOIN operator_entry_profiles e ON e.blacklake_operator_id=o.blacklake_operator_id WHERE o.active=1 AND COALESCE(e.app_role,'employee')='employee'").all();}
 majority(window,people){
  const allowed=new Set(people.map(row=>row.id)),population=new Set(),lastEnds=new Map(),lastWork=new Map(),stillWorking=new Set(),lastPauses=new Map();
  const cutoff=timestampMs(window.cutoff),from=timestampMs(window.from);
  const rows=this.db.prepare("SELECT id,operator_id,started_at,ended_at FROM assignments WHERE started_at IS NOT NULL AND started_at<? AND status<>'CANCELLED' AND (ended_at IS NULL OR ended_at>=?)").all(window.cutoff,window.from);
  const pauseAtCutoff=this.db.prepare('SELECT started_at,ended_at,source FROM assignment_pauses WHERE assignment_id=?');
  for(const row of rows){if(!allowed.has(row.operator_id)||!isDate(row.started_at))continue;
   const pauses=pauseAtCutoff.all(row.id),end=timestampMs(row.ended_at);
   const intervals=workingIntervalsBetween(Math.max(from,timestampMs(row.started_at)),Number.isFinite(end)?Math.min(end,cutoff):cutoff,pauses.map(p=>({startedAt:p.started_at,endedAt:p.ended_at})));
   if(!intervals?.length)continue; // Old tasks paused throughout this shift are not its working population.
   population.add(row.operator_id);
   lastWork.set(row.operator_id,Math.max(lastWork.get(row.operator_id)||0,...intervals.map(([,end])=>end)));
   if(Number.isFinite(end)&&end>=from&&end<=cutoff)lastEnds.set(row.operator_id,Math.max(lastEnds.get(row.operator_id)||0,end));
   // Reconstruct each task at 02:00, including tasks finished or resumed after it.
   // A pause on another task must never hide this task's running clock.
   if(!Number.isFinite(end)||end>cutoff){
    const open=pauses.find(p=>timestampMs(p.started_at)<=cutoff&&(!p.ended_at||timestampMs(p.ended_at)>cutoff));
    if(!open)stillWorking.add(row.operator_id);
    else if(open.source==='employee')lastPauses.set(row.operator_id,Math.max(lastPauses.get(row.operator_id)||0,timestampMs(open.started_at)));
   }
  }
  const values=[...lastEnds].filter(([person,at])=>!stillWorking.has(person)&&at>=lastWork.get(person)).map(([,at])=>at).sort((a,b)=>a-b),count=values.length,total=population.size;
  const pauseTimes=[...lastPauses].filter(([person,at])=>!stillWorking.has(person)&&at>=lastWork.get(person)).map(([,at])=>at).sort((a,b)=>a-b);
  if(count<2||count*2<=total)return {at:null,count,population:total,endTimes:values,pauseTimes};
  const middle=Math.floor(count/2),at=count%2?values[middle]:Math.floor((values[middle-1]+values[middle])/2);
  return {at:shanghaiTime(at),count,population:total,endTimes:values,pauseTimes};
 }
 references(window){
  const runs=this.db.prepare("SELECT run_id,owner_id,kind,executed_at FROM leader_clockout_runs WHERE status='SUCCEEDED' AND kind IN ('manual','scheduled') AND executed_at>=? AND executed_at<=? ORDER BY executed_at DESC,rowid DESC").all(window.from,window.cutoff).filter(row=>isDate(row.executed_at));
  const groups=this.leaderClockout.groups.read();return {runs,groups:groups.groups};
 }
 reference(task,references,majority,activity,window){
  const owners=new Set(references.groups.filter(group=>group.blacklakeOperatorIds.includes(task.blacklake_operator_id)).flatMap(group=>group.leaderIds||[]));
  const eligibleRuns=references.runs.filter(run=>timestampMs(run.executed_at)>=activity);
  const team=eligibleRuns.find(run=>owners.has(run.owner_id)),any=eligibleRuns[0];
  const chosen=this.referencePolicy==='global-last'?any:this.referencePolicy==='team-only'?team:team||any;
  if(chosen)return {kind:owners.has(chosen.owner_id)?'team-leader':'other-leader',at:chosen.executed_at,owner:chosen.owner_id,runId:chosen.run_id};
  if(majority.at&&timestampMs(majority.at)>=activity)return {kind:'majority',at:majority.at};
  const nearby=majority.endTimes.find(at=>at>=activity);
  if(nearby!==undefined)return {kind:'employee-end',at:shanghaiTime(nearby),review:true};
  const nearbyPause=majority.pauseTimes.find(at=>at>=activity);
  if(nearbyPause!==undefined)return {kind:'employee-pause',at:shanghaiTime(nearbyPause),review:true};
  // A start alone does not prove the employee stopped at that instant.
  if(activity>=timestampMs(window.from)&&activity>timestampMs(task.started_at))return {kind:'task-activity',at:shanghaiTime(activity),review:true};
  return {kind:'unavailable',at:null};
 }
 lastActivity(task){
  const stamps=[task.started_at,...this.db.prepare('SELECT started_at,ended_at FROM assignment_pauses WHERE assignment_id=?').all(task.id).flatMap(row=>[row.started_at,row.ended_at]),...this.db.prepare("SELECT created_at FROM assignment_timer_operations WHERE assignment_id=? AND operation_id NOT LIKE 'overnight-%'").all(task.id).map(row=>row.created_at)];
  if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_task_state'").get()){
   const row=this.db.prepare('SELECT state_json FROM workspace_task_state WHERE assignment_id=?').get(task.id);
   if(row){let state;try{state=JSON.parse(row.state_json);}catch{return NaN;}for(const segment of state.segments||[])stamps.push(segment.start,segment.end);}
  }
  return Math.max(...stamps.filter(Boolean).map(timestampMs));
 }
 runDue(){
  const window=overnightWindow(this.now());if(!window)return null;
  this.db.exec('BEGIN IMMEDIATE');try{
   const prior=this.db.prepare('SELECT result_json FROM overnight_clockout_runs WHERE business_date=?').get(window.businessDate);if(prior){this.db.exec('COMMIT');return {...JSON.parse(prior.result_json),replayed:true};}
   const people=this.people(),allowed=new Set(people.map(row=>row.id)),references=this.references(window),majority=this.majority(window,people),executedAt=shanghaiTime(this.now());
   const tasks=this.db.prepare("SELECT a.*,o.blacklake_operator_id FROM assignments a JOIN operators o ON o.id=a.operator_id WHERE a.status='IN_PROGRESS' AND a.started_at IS NOT NULL AND a.started_at<? AND a.ended_at IS NULL AND a.report_id IS NULL ORDER BY a.id").all(window.cutoff).filter(row=>allowed.has(row.operator_id));
   const result={businessDate:window.businessDate,cutoffAt:window.cutoff,executedAt,referencePolicy:this.referencePolicy,candidateCount:tasks.length,pausedCount:0,alreadyPausedCount:0,skippedCount:0,needsReviewCount:0,majoritySampleCount:majority.count,workingEmployeeCount:majority.population};
   this.db.prepare('INSERT INTO overnight_clockout_runs VALUES(?,?,?,?,?,?)').run(window.businessDate,window.cutoff,executedAt,this.referencePolicy,'RUNNING','{}');
   for(const task of tasks){
    const activity=this.lastActivity(task);let reference={kind:'unavailable',at:null},status,pauseAt=null,pauseId=null,reason='';
    if(this.db.prepare('SELECT 1 FROM assignment_pauses WHERE assignment_id=? AND ended_at IS NULL').get(task.id)){status='ALREADY_PAUSED';result.alreadyPausedCount++;}
    else if(!Number.isFinite(activity)){status='SKIPPED_INVALID_CLOCK';result.skippedCount++;result.needsReviewCount++;reason='任务计时资料无效，未自动改动。';}
    else if(activity>timestampMs(window.cutoff)){status='SKIPPED_NEW_ACTIVITY';result.skippedCount++;reason='凌晨2点后已有员工开工或继续记录，未改动新班次。';}
    else{
     reference=this.reference(task,references,majority,activity,window);
     if(!reference.at){
      status='SKIPPED_NO_REFERENCE';result.skippedCount++;result.needsReviewCount++;
      reason='未找到可用于推断暂停的记录，实际下班时间待核对。';
     }else{
      pauseAt=reference.at;status=reference.review?'PAUSED_NEEDS_REVIEW':'PAUSED';
      if(reference.review){result.needsReviewCount++;reason='按'+referenceLabels[reference.kind]+'补暂停，实际下班时间待核对。';}
      const before={...this.recovery.present(this.recovery.raw(task.id)),timerPaused:false,pauses:this.store.assignmentPauses(task.id)},version=this.store.assignmentById(task.id).timingRevision;
      const pause=this.db.prepare("INSERT INTO assignment_pauses(assignment_id,started_at,source) VALUES(?,?,'overnight')").run(task.id,pauseAt);pauseId=Number(pause.lastInsertRowid);
      this.db.prepare('INSERT INTO assignment_timer_operations VALUES(?,?,?,?,?,?)').run('overnight-'+digest([window.businessDate,task.id]).slice(0,50),task.id,task.operator_id,'pause',version,executedAt);
      this.recovery.event({row:task,action:'AUTO_OVERNIGHT_PAUSE',actor:'SYSTEM:overnight-clockout',reason:reason||'自动补暂停计时，依据'+referenceLabels[reference.kind]+' '+pauseAt+'。',actualAt:pauseAt,before,after:{...this.recovery.present(this.recovery.raw(task.id)),timerPaused:true,pauses:this.store.assignmentPauses(task.id)}});result.pausedCount++;
     }
    }
    this.db.prepare('INSERT INTO overnight_clockout_items(business_date,assignment_id,operator_id,owner_id,reference_run_id,reference_kind,reference_at,pause_at,pause_id,status,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(window.businessDate,task.id,task.operator_id,reference.owner??null,reference.runId??null,reference.kind,reference.at,pauseAt,pauseId,status,JSON.stringify({reason,lastActivityAt:Number.isFinite(activity)?shanghaiTime(activity):null,sampleCount:majority.count,population:majority.population}));
   }
   this.db.prepare("UPDATE overnight_clockout_runs SET status='SUCCEEDED',result_json=? WHERE business_date=?").run(JSON.stringify(result),window.businessDate);this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 status(){return {enabled:true,timezone:'Asia/Shanghai',cutoffTime:'02:00',referencePolicy:this.referencePolicy,runs:this.db.prepare('SELECT * FROM overnight_clockout_runs ORDER BY cutoff_at DESC LIMIT 14').all().map(row=>({...JSON.parse(row.result_json),status:row.status}))};}
}

export function startOvernightClockoutScheduler(service,{intervalMs=15000,onError=()=>{}}={}){
 if(!service)return ()=>{};let stopped=false;const tick=()=>{if(stopped)return;try{service.runDue();}catch(error){onError(error);}};
 const timer=setInterval(tick,intervalMs);timer.unref?.();tick();return ()=>{stopped=true;clearInterval(timer);};
}
