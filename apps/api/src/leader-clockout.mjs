import {createHash} from 'node:crypto';
import {assert} from './errors.mjs';
import {PeopleGroups} from './people-groups.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=ms=>new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' ');
const millis=value=>Date.parse(value.replace(' ','T')+'+08:00');
const keyPattern=/^[A-Za-z0-9_-]{16,128}$/;
export function nextClockout({time,days},now){
  const [hour,minute]=time.split(':').map(Number),date=new Date(now+8*3600000);
  for(let offset=0;offset<=7;offset++){
    const local=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+offset,hour,minute);
    if(days.includes(new Date(local).getUTCDay()||7)&&local-8*3600000>now)return stamp(local-8*3600000);
  }
  throw new Error('CLOCKOUT_NO_NEXT_TIME');
}
function settings(input){
  assert(typeof input.enabled==='boolean'&&typeof input.time==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time),422,'CLOCKOUT_TIME_INVALID','请选择有效的下班时间。');
  assert(Array.isArray(input.days)&&input.days.length>0&&input.days.length<=7&&input.days.every(day=>Number.isInteger(day)&&day>=1&&day<=7),422,'CLOCKOUT_DAYS_INVALID','请至少选择一天。');
  return {enabled:input.enabled,time:input.time,days:[...new Set(input.days)].sort((a,b)=>a-b)};
}
export class LeaderClockout {
  constructor({store,now=Date.now}){
    this.store=store;this.db=store.db;this.now=now;this.groups=new PeopleGroups(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS leader_clockout_schedules(
      owner_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,time_hhmm TEXT NOT NULL,
      days_json TEXT NOT NULL,next_run_at TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leader_clockout_operations(
        owner_id INTEGER NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,PRIMARY KEY(owner_id,operation_id));
      CREATE TABLE IF NOT EXISTS leader_clockout_runs(
        run_id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
        scheduled_at TEXT,executed_at TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leader_clockout_pauses(
        pause_id INTEGER PRIMARY KEY REFERENCES assignment_pauses(id),owner_id INTEGER NOT NULL,run_id TEXT NOT NULL REFERENCES leader_clockout_runs(run_id));`);
  }
  assertLeader(owner){
    const person=this.store.findOperatorByBlacklakeId(owner);
    assert(person&&person.active!==0&&this.store.entryProfile(owner).appRole==='floor8_leader',403,'CLOCKOUT_NOT_ALLOWED','当前身份不能操作组员下班。');
  }
  team(owner){
    const config=this.groups.read(),groups=config.groups.filter(group=>(group.leaderIds||[]).includes(owner));
    const employeeIds=[...new Set(groups.flatMap(group=>group.blacklakeOperatorIds))].filter(id=>{
      const person=this.db.prepare('SELECT active FROM operators WHERE blacklake_operator_id=?').get(id);
      return person?.active!==0&&this.store.entryProfile(id).appRole==='employee';
    });
    return {groups:groups.map(({id,name})=>({id,name})),employeeIds,revision:config.revision};
  }
  scope(owner){
    const team=this.team(owner),ids=new Set(team.employeeIds);
    const tasks=this.db.prepare(`SELECT a.id,a.operator_id,a.status,a.started_at,a.ended_at,a.report_id,o.blacklake_operator_id,
      (SELECT id FROM assignment_pauses p WHERE p.assignment_id=a.id AND p.ended_at IS NULL) AS open_pause
      FROM assignments a JOIN operators o ON o.id=a.operator_id
      WHERE a.status IN ('IN_PROGRESS','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING') ORDER BY a.id`).all().filter(row=>ids.has(row.blacklake_operator_id));
    const eligible=tasks.filter(row=>row.status==='IN_PROGRESS'&&row.started_at&&!row.ended_at&&!row.report_id&&!row.open_pause);
    return {team,tasks,eligible,version:digest([team.revision,team.employeeIds,tasks])};
  }
  schedule(owner){
    const row=this.db.prepare('SELECT * FROM leader_clockout_schedules WHERE owner_id=?').get(owner);
    return row?{revision:row.revision,enabled:!!row.enabled,time:row.time_hhmm,days:JSON.parse(row.days_json),nextRunAt:row.next_run_at,timezone:'Asia/Shanghai'}:{revision:0,enabled:false,time:'18:00',days:[1,2,3,4,5,6,7],nextRunAt:null,timezone:'Asia/Shanghai'};
  }
  preview(owner){
    this.assertLeader(owner);const scope=this.scope(owner);
    const last=this.db.prepare('SELECT * FROM leader_clockout_runs WHERE owner_id=? ORDER BY executed_at DESC,rowid DESC LIMIT 1').get(owner);
    const origins=scope.tasks.filter(row=>row.open_pause&&this.db.prepare('SELECT 1 FROM leader_clockout_pauses WHERE pause_id=?').get(row.open_pause));
    const pausedTasks=origins.slice(0,100).map(row=>{const task=this.store.assignmentById(row.id);return {id:task.id,workerId:row.blacklake_operator_id,workerName:task.operatorName,projectId:task.projectId,projectCode:task.projectCode,taskId:task.taskId,processName:task.processName,timingRevision:task.timingRevision,status:task.status,paused:true,timerPaused:true,pauseSource:'clockout'};});
    return {version:scope.version,groups:scope.team.groups,employeeCount:scope.team.employeeIds.length,
      taskCount:scope.eligible.length,workingEmployeeCount:new Set(scope.eligible.map(row=>row.operator_id)).size,
      alreadyPausedCount:scope.tasks.filter(row=>row.open_pause).length,protectedCount:scope.tasks.filter(row=>row.status!=='IN_PROGRESS'||row.ended_at||row.report_id).length,
      pausedTasks,pausedTaskCount:origins.length,pausedTasksTruncated:origins.length>pausedTasks.length,
      schedule:this.schedule(owner),lastRun:last?{kind:last.kind,status:last.status,executedAt:last.executed_at,...JSON.parse(last.result_json)}:null,
      source:'local-team-assignments',fetchedAt:stamp(this.now())};
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  mutation(owner,operationId,input,fn){
    assert(keyPattern.test(operationId||''),422,'CLOCKOUT_OPERATION_INVALID','请重新打开下班面板。');
    const hash=digest(input);return this.transaction(()=>{
      this.assertLeader(owner);
      const previous=this.db.prepare('SELECT * FROM leader_clockout_operations WHERE owner_id=? AND operation_id=?').get(owner,operationId);
      if(previous){assert(previous.request_hash===hash,409,'CLOCKOUT_OPERATION_CONFLICT','操作标识已使用，请刷新。');return JSON.parse(previous.result_json);}
      const result=fn();this.db.prepare('INSERT INTO leader_clockout_operations VALUES(?,?,?,?,?)').run(owner,operationId,hash,JSON.stringify(result),stamp(this.now()));return result;
    });
  }
  apply(owner,{runId,kind,scheduledAt=null,scope=this.scope(owner)}){
    const at=stamp(this.now());let count=0;
    const result={pausedCount:scope.eligible.length,employeeCount:new Set(scope.eligible.map(row=>row.operator_id)).size,alreadyPausedCount:scope.tasks.filter(row=>row.open_pause).length,executedAt:at};
    this.db.prepare('INSERT INTO leader_clockout_runs VALUES(?,?,?,?,?,?,?)').run(runId,owner,kind,'SUCCEEDED',scheduledAt,at,JSON.stringify(result));
    for(const task of scope.eligible){
      const current=this.store.assignmentById(task.id),latest=current.pauses.at(-1);
      assert(at>=(latest?.endedAt||latest?.startedAt||current.startedAt),409,'CLOCKOUT_CLOCK_CHANGED','部分任务时间晚于系统时间，请核对后重试。');
      const pause=this.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at) VALUES(?,?)').run(task.id,at);
      this.db.prepare('INSERT INTO leader_clockout_pauses VALUES(?,?,?)').run(Number(pause.lastInsertRowid),owner,runId);
      this.db.prepare('INSERT INTO assignment_timer_operations VALUES(?,?,?,?,?,?)').run('clockout-'+digest([runId,task.id]).slice(0,50),task.id,task.operator_id,'pause',current.timingRevision,at);
      this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(task.id,'PAUSE_TIMER_FOR_CLOCKOUT',kind==='scheduled'?'定时下班代暂停报工计时':'组长代暂停报工计时','dispatcher:'+owner);
      count++;
    }
    assert(count===result.pausedCount,500,'CLOCKOUT_INCOMPLETE','下班暂停未能完整执行。');return result;
  }
  pause(owner,input,operationId){
    assert(input&&Object.keys(input).every(key=>key==='expectedVersion')&&typeof input.expectedVersion==='string',422,'CLOCKOUT_VERSION_INVALID','请先读取下班人数。');
    return this.mutation(owner,operationId,{action:'pause',...input},()=>{
      const scope=this.scope(owner);assert(scope.team.groups.length,409,'CLOCKOUT_TEAM_MISSING','请在后台人员分类中分配负责组长。');
      assert(scope.version===input.expectedVersion,409,'CLOCKOUT_SCOPE_CHANGED','人员或任务已变化，请刷新后再下班。');
      return this.apply(owner,{runId:'manual-'+digest([owner,operationId]),kind:'manual',scope});
    });
  }
  saveSchedule(owner,input,operationId){
    assert(input&&Object.keys(input).every(key=>['expectedRevision','enabled','time','days'].includes(key)),422,'CLOCKOUT_SETTINGS_INVALID','下班设置不正确。');
    const value=settings(input);
    return this.mutation(owner,operationId,{action:'schedule',...input},()=>{
      assert(input.expectedRevision===this.schedule(owner).revision,409,'CLOCKOUT_SCHEDULE_CHANGED','定时设置已变化，请刷新。');
      assert(!value.enabled||this.team(owner).groups.length,409,'CLOCKOUT_TEAM_MISSING','请先在后台分类中分配负责组长。');
      const next=value.enabled?nextClockout(value,this.now()):null;
      this.db.prepare(`INSERT INTO leader_clockout_schedules VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,time_hhmm=excluded.time_hhmm,days_json=excluded.days_json,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`).run(owner,input.expectedRevision+1,value.enabled?1:0,value.time,JSON.stringify(value.days),next,stamp(this.now()));
      return this.schedule(owner);
    });
  }
  runDue(){
    const now=this.now(),rows=this.db.prepare('SELECT * FROM leader_clockout_schedules WHERE enabled=1 AND next_run_at<=?').all(stamp(now)),results=[];
    for(const row of rows){try{results.push(this.transaction(()=>{
      const fresh=this.db.prepare('SELECT * FROM leader_clockout_schedules WHERE owner_id=?').get(row.owner_id);
      if(!fresh.enabled||fresh.next_run_at!==row.next_run_at)return null;
      const runId='scheduled-'+digest([row.owner_id,row.next_run_at]);
      if(!this.db.prepare('SELECT 1 FROM leader_clockout_runs WHERE run_id=?').get(runId)){
        let allowed=true;try{this.assertLeader(row.owner_id);}catch{allowed=false;}
        const scope=this.scope(row.owner_id),status=now-millis(row.next_run_at)>300000?'MISSED':!allowed||!scope.team.groups.length?'DISABLED_SCOPE':null;
        if(status)this.db.prepare('INSERT INTO leader_clockout_runs VALUES(?,?,?,?,?,?,?)').run(runId,row.owner_id,'scheduled',status,row.next_run_at,stamp(now),JSON.stringify({pausedCount:0,employeeCount:0}));
        else this.apply(row.owner_id,{runId,kind:'scheduled',scheduledAt:row.next_run_at,scope});
      }
      const next=nextClockout({time:row.time_hhmm,days:JSON.parse(row.days_json)},now);
      this.db.prepare('UPDATE leader_clockout_schedules SET next_run_at=? WHERE owner_id=?').run(next,row.owner_id);
      return {ownerId:row.owner_id,runId};
    }));}catch(error){
      const runId='scheduled-'+digest([row.owner_id,row.next_run_at]);
      this.transaction(()=>{
        this.db.prepare('INSERT OR IGNORE INTO leader_clockout_runs VALUES(?,?,?,?,?,?,?)').run(runId,row.owner_id,'scheduled','FAILED',row.next_run_at,stamp(now),JSON.stringify({pausedCount:0,employeeCount:0,errorCode:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'CLOCKOUT_FAILED'}));
        this.db.prepare('UPDATE leader_clockout_schedules SET next_run_at=? WHERE owner_id=? AND next_run_at=?').run(nextClockout({time:row.time_hhmm,days:JSON.parse(row.days_json)},now),row.owner_id,row.next_run_at);
      });results.push({ownerId:row.owner_id,runId,status:'FAILED'});
    }}return results;
  }
}

export function startClockoutScheduler(service,{intervalMs=15000,onError=()=>{}}={}){
  let stopped=false;const tick=()=>{if(stopped)return;try{service.runDue();}catch(error){onError(error);}};
  const timer=setInterval(tick,intervalMs);timer.unref?.();tick();return ()=>{stopped=true;clearInterval(timer);};
}
