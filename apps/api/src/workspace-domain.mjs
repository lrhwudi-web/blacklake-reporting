// Pure local workflow model. No identities, storage, network calls or production writes.
const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>String(a)===String(b);
import reportModel from './workspace-report-model.mjs';
function ensure(condition,message){if(!condition)throw new Error(message);}
function createExecution(initial,options={}){
  let state=copy({version:0,nextId:0,orders:[],employees:[],units:[],assignments:[],reports:[],audit:[],operations:{},...initial});
  // Repair only the unpublished demo's old clock-out state; urgent pauses stay untouched.
  for(const task of state.assignments){
    if(task.pauseKind!=='CLOCK_OUT')continue;
    if(task.status==='PAUSED'&&task.pauseReason==='组长一键下班'){
      const last=task.segments?.at(-1),start=task.pausedAt;
      if(start&&last?.end===start){last.end=null;task.status='IN_PROGRESS';task.timerPauses||=[];if(!task.timerPauses.some(row=>row.start===start&&!row.end))task.timerPauses.push({start,end:null,source:'clockout'});task.pauseReason='';task.pausedAt=null;}
    }
    delete task.pauseKind;
  }
  const now=options.now||(()=>new Date().toISOString());
  const exclusive=['IN_PROGRESS','AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'];
  function member(actor,workerId){return actor.role==='floor8_leader'&&Array.isArray(actor.employeeIds)&&actor.employeeIds.some(id=>same(id,workerId));}
  function manages(actor,task){return member(actor,task.workerId)&&same(actor.id,task.leaderId);}
  function clockoutTeam(s,actor){ensure(actor?.role==='floor8_leader','只有组长可以操作下班。');const groups=(s.peopleGroups||[]).filter(group=>(group.leaderIds||[]).some(id=>same(id,actor.id)));return {groups,ids:[...new Set(groups.flatMap(group=>group.employeeIds).map(String))]};}
  function timerPaused(task){return (task.timerPauses||[]).some(row=>!row.end);}
  function clockoutSnapshot(actor){const team=clockoutTeam(state,actor),tasks=state.assignments.filter(row=>team.ids.includes(String(row.workerId))),running=tasks.filter(row=>row.status==='IN_PROGRESS'),working=running.filter(row=>!timerPaused(row));return {source:'local-simulation',version:state.version,groups:team.groups.map(({id,name})=>({id,name})),employeeCount:team.ids.length,workingEmployeeCount:new Set(working.map(row=>row.workerId)).size,taskCount:working.length,alreadyPausedCount:running.filter(timerPaused).length,protectedCount:tasks.filter(row=>['PAUSED','REPORTING','NEEDS_REVIEW','AWAITING_QUANTITY'].includes(row.status)).length,schedule:copy(state.clockoutSchedules?.[actor.id]||{revision:0,enabled:false,time:'18:00',days:[1,2,3,4,5,6,7],nextRunAt:null,timezone:'Asia/Shanghai'}),lastRun:copy(state.clockoutLastRun?.[actor.id]||null)};}
  function employee(actor,task){return actor.role==='employee'&&same(actor.employeeId,task.workerId);}
  function selfQuality(s,task){
    if(task.isSelfService!==true)return false;
    if(task.isQualityInspection===true)return true;
    if(['COMPLETED','CANCELLED','REPORTING','NEEDS_REVIEW'].includes(task.status))return false;
    return s.employees.some(person=>same(person.id,task.workerId)&&['quality','quality_leader'].includes(person.qualityRole))||s.orders.find(order=>same(order.id,task.orderId))?.processes.some(process=>same(process.id,task.processId)&&process.qualityInspection===true)===true;
  }
  function canChange(s,task,actor){return manages(actor,task)&&['READY','IN_PROGRESS','PAUSED'].includes(task.status)&&!s.reports.some(row=>same(row.assignmentId,task.id)&&['REPORTING','NEEDS_REVIEW'].includes(row.upstreamState));}
  function canManageTimer(s,task,actor){
    return canChange(s,task,actor)&&!task.isSelfService&&clockoutTeam(s,actor).ids.includes(String(task.workerId));
  }
  function taskOrder(s,task){
    const order=s.orders.find(row=>same(row.id,task.orderId));
    const process=order?.processes.find(row=>same(row.id,task.processId));
    return {order,process};
  }
  function closedTask(s,task){
    const {order,process}=taskOrder(s,task);
    return order?.status==='FINISHED'||process?.closed===true;
  }
  function canLeaveClosedTask(s,task,actor){
    return employee(actor,task)&&closedTask(s,task)&&!s.reports.some(row=>same(row.assignmentId,task.id));
  }
  function closedSelfTask(s,task,actor){
    return task.isSelfService&&['IN_PROGRESS','PAUSED','AWAITING_QUANTITY','READY'].includes(task.status)&&canLeaveClosedTask(s,task,actor);
  }
  function closedQueuedAssignment(s,task,actor){
    return !task.isSelfService&&task.status==='READY'&&!task.segments?.length
      &&same(employeeHead(s,task.workerId)?.id,task.id)&&canLeaveClosedTask(s,task,actor);
  }
  function availableTask(s,task){
    const {order,process}=taskOrder(s,task);
    ensure(order&&['NOT_STARTED','IN_PROGRESS'].includes(order.status)&&process?.selectable===true&&process.closed===false,'工单或工序已关闭、状态未知，不能启动或派工。');
    return {order,process};
  }
  function seconds(task,at){
    return (task.segments||[]).reduce((sum,segment)=>{
      const start=Date.parse(segment.start),end=Date.parse(segment.end||at);
      const pauses=(task.timerPauses||[]).map(row=>[Math.max(start,Date.parse(row.start)),Math.min(end,Date.parse(row.end||at))]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
      let removed=0,left=null,right=null;for(const [a,b]of pauses){if(left===null){left=a;right=b;}else if(a<=right)right=Math.max(right,b);else{removed+=right-left;left=a;right=b;}}if(left!==null)removed+=right-left;
      return sum+Math.max(0,end-start-removed)/1000;
    },0);
  }
  function workQueue(s,workerId){
    const rows=s.assignments.filter(row=>same(row.workerId,workerId)&&['IN_PROGRESS','READY','PAUSED'].includes(row.status)).sort((a,b)=>(Number.isSafeInteger(a.queueRank)?a.queueRank:1e9)-(Number.isSafeInteger(b.queueRank)?b.queueRank:1e9)||(a.priority==='URGENT'?0:1)-(b.priority==='URGENT'?0:1)||Date.parse(a.assignedAt)-Date.parse(b.assignedAt)||String(a.id).localeCompare(String(b.id)));
    const selected=s.employeeCurrent?.[String(workerId)];
    // Old local drafts retain the task the worker already saw until a leader rearranges them.
    const head=selected!=null?rows.find(row=>same(row.id,selected)):rows.find(row=>row.status==='IN_PROGRESS')||rows.find(row=>row.status==='READY')||rows[0];
    return head?[head,...rows.filter(row=>row!==head)]:rows;
  }
  function employeeHead(s,workerId){return s.assignments.find(row=>same(row.workerId,workerId)&&['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status))||workQueue(s,workerId)[0];}
  function pending(s,workerId){return workQueue(s,workerId).filter(row=>row.status==='READY');}
  function placeWorkQueue(s,workerId,frontIds=[],leaderId){
    const rows=workQueue(s,workerId),front=frontIds.map(id=>rows.find(row=>same(row.id,id))).filter(Boolean),ordered=[...front,...rows.filter(row=>!front.includes(row))];
    ordered.forEach((row,index)=>{if(same(row.leaderId,leaderId))row.queueRank=index;});
    s.employeeCurrent||={};s.employeeCurrent[String(workerId)]=ordered[0]?.id||null;
  }
  function snapshot(orderId,actor){
    const at=now();
    ensure(actor&&['floor8_leader','employee'].includes(actor.role),'当前身份不能查看任务。');
    const visible=state.assignments.filter(row=>(orderId==null||same(row.orderId,orderId))&&(actor.role==='floor8_leader'?manages(actor,row):employee(actor,row)));
    const person=actor.role==='employee'?state.employees.find(row=>same(row.id,actor.employeeId)):null;
    return {orderId,version:state.version,source:'local-simulation',fetchedAt:at,canManage:actor.role==='floor8_leader',employee:person?{id:person.id,name:person.name}:null,selfServiceEnabled:person?.selfServiceEnabled===true,selfServiceDefectReasons:person?.selfServiceEnabled===true?copy(state.defectReasons):[],
      reportOptions:actor.role==='floor8_leader'?{employees:state.employees.filter(row=>member(actor,row.id)).map(row=>({id:String(row.id),name:row.name,departments:Array.isArray(row.departments)?row.departments.filter(value=>typeof value==='string'&&value.trim()):[]})),defectReasons:copy(state.defectReasons||[])}:null,
      assignmentOptions:actor.role==='floor8_leader'?{units:copy(state.units),orders:state.orders.filter(row=>['NOT_STARTED','IN_PROGRESS'].includes(row.status)||visible.some(task=>same(task.orderId,row.id))).map(row=>({id:row.id,code:row.code,product:row.product,status:row.status,processes:copy(row.processes)}))}:null,
      assignments:visible.map(task=>{
        const worker=state.employees.find(row=>same(row.id,task.workerId));
        const order=state.orders.find(row=>same(row.id,task.orderId));
        const reports=state.reports.filter(row=>same(row.assignmentId,task.id)).map(row=>({...reportModel.baseReport(row,task),productionWorkerName:state.employees.find(person=>same(person.id,row.productionWorkerId||task.workerId))?.name||'人员待核对',canEdit:manages(actor,task)&&row.upstreamState==='LOCAL_DEMO'&&!row.deleted,canDelete:manages(actor,task)&&row.upstreamState==='LOCAL_DEMO'&&!row.deleted,canRestore:manages(actor,task)&&row.upstreamState==='LOCAL_DEMO'&&row.deleted}));
        const blocking=state.assignments.find(row=>same(row.workerId,task.workerId)&&row.id!==task.id&&exclusive.includes(row.status));
        const urgent=pending(state,task.workerId).find(row=>row.priority==='URGENT'&&row.id!==task.id);
        let unavailable='';try{availableTask(state,task);}catch(error){unavailable=error.message;}
        const uncertain=reports.some(row=>['REPORTING','NEEDS_REVIEW'].includes(row.upstreamState));
        const returnBlockedReason=unavailable||(uncertain?'报工结果待核对，暂不能返回计时。':blocking?'该员工正在处理其他任务':'');
        const startable=employee(actor,task)&&!uncertain&&!unavailable&&!worker?.blocked&&['READY','PAUSED'].includes(task.status);
        return {...task,isQualityInspection:task.isSelfService?selfQuality(state,task):task.isQualityInspection,processPlanQuantity:order?.processes.find(row=>same(row.id,task.processId))?.planQuantity??null,orderInfo:order?copy({...order,processes:undefined}):null,product:order?.product,productCode:order?.productCode,productName:order?.productName,productSpecification:order?.productSpecification,workerName:worker?.name||'人员待核对',elapsedSeconds:seconds(task,at),reports,
          canEditAssignment:canChange(state,task,actor),canCancelAssignment:canChange(state,task,actor),canManageQueue:canChange(state,task,actor)&&!state.assignments.some(row=>same(row.workerId,task.workerId)&&['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)),
          queuePosition:['IN_PROGRESS','READY','PAUSED'].includes(task.status)?workQueue(state,task.workerId).findIndex(row=>same(row.id,task.id)):null,
          isEmployeeCurrent:same(employeeHead(state,task.workerId)?.id,task.id),
          queueBlockedReason:actor.role==='floor8_leader'&&workQueue(state,task.workerId).some(row=>!manages(actor,row))?'该员工还有其他组长的任务，不能改动共同顺序。':'',
          timerPaused:task.status==='IN_PROGRESS'&&timerPaused(task),timerPauseSource:task.timerPauses?.find(row=>!row.end)?.source||null,timingRevision:task.timerRevision||0,
          canPauseTimer:employee(actor,task)&&task.status==='IN_PROGRESS'&&!timerPaused(task),
          canResumeTimer:employee(actor,task)&&task.status==='IN_PROGRESS'&&timerPaused(task),
          leaderTimerAction:canManageTimer(state,task,actor)?task.status==='IN_PROGRESS'&&!timerPaused(task)?'leaderPauseTimer':'leaderStartTimer':null,
          leaderTimerDisabled:task.status!=='IN_PROGRESS'&&(Boolean(unavailable)||Boolean(blocking)||worker?.blocked===true||((task.status==='READY'||Boolean(urgent))&&!same(employeeHead(state,task.workerId)?.id,task.id))),
          canResume:manages(actor,task)&&task.status==='PAUSED'&&!unavailable&&!blocking&&(!urgent||same(employeeHead(state,task.workerId)?.id,task.id)),
          resumeBlockedReason:unavailable||(blocking?'该员工正在处理其他任务':urgent&&!same(employeeHead(state,task.workerId)?.id,task.id)?'该员工还有待开始的加急任务':''),
          canStart:startable&&!blocking&&same(employeeHead(state,task.workerId)?.id,task.id),
          canStartAfterReport:startable&&blocking?.status==='AWAITING_QUANTITY'&&same(workQueue(state,task.workerId)[0]?.id,task.id),
          canFinish:employee(actor,task)&&task.status==='IN_PROGRESS',canConfirmQuantity:employee(actor,task)&&task.status==='AWAITING_QUANTITY',
          canCancelSelfReport:employee(actor,task)&&task.isSelfService===true&&task.status==='AWAITING_QUANTITY'&&!reports.length,
          canExitClosedSelfTask:closedSelfTask(state,task,actor),
          canSkipClosedAssignment:closedQueuedAssignment(state,task,actor),
          canReturnToWork:employee(actor,task)&&task.status==='AWAITING_QUANTITY'&&!returnBlockedReason,returnToWorkBlockedReason:returnBlockedReason};
      }),audit:state.audit.filter(row=>visible.some(task=>same(task.id,row.assignmentId))).map(copy)};
  }
  function selfServiceContext(orderId,actor){
    const person=state.employees.find(row=>same(row.id,actor?.employeeId));ensure(actor?.role==='employee'&&person?.selfServiceEnabled===true,'当前人员未开通自主报工。');
    const order=state.orders.find(row=>same(row.id,orderId));ensure(order&&['NOT_STARTED','IN_PROGRESS'].includes(order.status),'工单已结束或状态未确认。');
    const history=state.reports.filter(row=>!row.deleted&&same(row.productionWorkerId||state.assignments.find(task=>same(task.id,row.assignmentId))?.workerId,actor.employeeId)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
    const recommended=history.map(row=>state.assignments.find(task=>same(task.id,row.assignmentId)&&same(task.orderId,orderId))).find(task=>task&&order.processes.some(process=>same(process.id,task.processId)&&process.selectable===true&&!process.closed));
    return {orderId:order.id,order:copy({...order,processes:undefined}),processes:copy(order.processes),units:state.units.filter(unit=>(person.boundUnitIds||[]).some(id=>same(id,unit.id))).map(copy),recommendedProcessId:recommended?.processId||null,source:'local-simulation',fetchedAt:now()};
  }
  function planDispatch(s,input,actor,excludeId,allowPartial=false){
    ensure(actor.role==='floor8_leader','只有组长可以派工。');
    ensure(Array.isArray(input.workerIds)&&input.workerIds.length>0,'请选择派工人员。');
    availableTask(s,{orderId:input.orderId,processId:input.processId});
    const workers=[...new Set(input.workerIds.map(String))];
    const affected=[],blocked=[],eligible=[];
    const reject=(workerId,worker,reason,task)=>{
      ensure(allowPartial,reason);
      blocked.push({workerId,workerName:worker?.name||'所选人员',reason,...(task?{orderCode:task.orderCode,processName:task.processName}:{})});
    };
    for(const workerId of workers){
      const worker=s.employees.find(row=>same(row.id,workerId));
      if(!worker||!member(actor,workerId)){reject(workerId,null,'所选人员不在当前组长范围内。');continue;}
      if(worker.blocked){reject(workerId,worker,'该员工状态待核对，暂不能派工。');continue;}
      const other=s.assignments.filter(row=>same(row.workerId,workerId)&&!same(row.id,excludeId));
      const unsettled=other.find(row=>['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status));
      if(unsettled){reject(workerId,worker,({AWAITING_QUANTITY:'已有任务待确认数量。',REPORTING:'已有报工正在提交。',NEEDS_REVIEW:'已有报工结果待核对。'})[unsettled.status],unsettled);continue;}
      const duplicate=other.find(row=>same(row.orderId,input.orderId)&&same(row.processId,input.processId)&&['READY','IN_PROGRESS','PAUSED'].includes(row.status));
      if(duplicate){reject(workerId,worker,'该员工已有本工单工序的未完成任务。',duplicate);continue;}
      const current=other.find(row=>row.status==='IN_PROGRESS');
      if(input.priority==='URGENT'&&current){
        if(!manages(actor,current)){reject(workerId,worker,'当前任务由其他组长派出，不能自动暂停。',current);continue;}
        affected.push({assignmentId:current.id,workerId,workerName:worker.name,orderCode:current.orderCode,processName:current.processName});
      }
      eligible.push(workerId);
    }
    return {version:s.version,affected,workerIds:eligible,blocked};
  }
  function previewDispatch(input,actor,allowPartial=false){return planDispatch(state,input,actor,undefined,allowPartial);}
  function processReports(orderId,processId,actor){
    ensure(actor?.role==='floor8_leader'||actor?.role==='employee'&&state.employees.some(person=>same(person.id,actor.employeeId)),'当前身份不能查看工序报工。');
    const order=state.orders.find(row=>same(row.id,orderId));ensure(order?.processes.some(row=>same(row.id,processId)),'工单或工序归属未能确认。');
    const tasks=state.assignments.filter(row=>same(row.orderId,orderId)&&same(row.processId,processId));
    const reports=state.reports.filter(row=>!row.deleted&&tasks.some(task=>same(task.id,row.assignmentId))).map(row=>{
      const task=tasks.find(task=>same(task.id,row.assignmentId)),base=reportModel.baseReport(row,task),workerId=row.productionWorkerId||task.workerId;
      return {id:row.id,orderId:order.id,processId,productionWorkerName:state.employees.find(person=>same(person.id,workerId))?.name||'人员未提供',
        goodQuantity:row.goodQuantity,defectiveQuantity:row.defectiveQuantity,reportedSeconds:base.reportedSeconds,createdAt:row.createdAt,...(actor.role==='floor8_leader'?{canEdit:manages(actor,task)&&row.upstreamState==='LOCAL_DEMO',canDelete:manages(actor,task)&&row.upstreamState==='LOCAL_DEMO'}:{})};
    }).sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
    return {orderId:order.id,processId,reports,complete:true,...(actor.role==='floor8_leader'?{canEditReports:true,permission:'own-dispatch-reports'}:{}),source:'local-simulation',fetchedAt:now()};
  }
  function orderOperationsSnapshot(orderId,actor){
    ensure(actor?.role==='floor8_leader','只有组长可以操作工单。');
    const order=state.orders.find(row=>same(row.id,orderId));ensure(order,'没有找到该工单。');
    return {order:copy(order),version:state.version,source:'local-simulation',canManage:true,fetchedAt:now()};
  }
  function execute(action,input,actor,meta={}){
    ensure(actor&&['floor8_leader','employee'].includes(actor.role),'当前身份不能执行操作。');
    ensure(typeof meta.operationId==='string'&&meta.operationId.length>0&&meta.operationId.length<=120,'缺少操作编号。');
    const fingerprint=JSON.stringify({action,input,actor});
    const operationKey=JSON.stringify([actor.role,actor.id||String(actor.employeeId),meta.operationId]);
    const legacy=state.operations[meta.operationId],previous=state.operations[operationKey]||(legacy?.fingerprint===fingerprint?legacy:null);
    if(previous){ensure(previous.fingerprint===fingerprint,'操作编号已用于其他操作。');return {...copy(previous.result),version:state.version,replayed:true};}
    ensure(meta.expectedVersion===state.version,'任务状态已变化，请刷新后重新核对。');
    const at=now();ensure(Number.isFinite(Date.parse(at))&&(!state.updatedAt||Date.parse(at)>=Date.parse(state.updatedAt)),'时间异常，请刷新后重试。');
    const next=copy(state);const result={};
    const id=prefix=>options.id?options.id(prefix):prefix+'-'+(++next.nextId);
    const event=(task,type,before,after,reason='')=>next.audit.push({id:id('event'),assignmentId:task.id,type,at,actorId:actor.id||String(actor.employeeId),before:copy(before),after:copy(after),reason});
    const getTask=()=>{const task=next.assignments.find(row=>same(row.id,input.assignmentId));ensure(task,'没有找到派遣任务。');return task;};
    const closeSegment=task=>{const open=task.segments.find(row=>!row.end);ensure(open&&Date.parse(at)>=Date.parse(open.start),'当前计时状态不一致，请刷新。');open.end=at;};
    const requeuePaused=task=>{
      if(task?.status!=='PAUSED')return;
      ensure(!next.employees.find(row=>same(row.id,task.workerId))?.blocked,'该员工状态待核对，暂不能重新安排。');
      ensure(!next.reports.some(row=>same(row.assignmentId,task.id)&&['REPORTING','NEEDS_REVIEW'].includes(row.upstreamState)),'报工结果待核对，暂不能重新安排。');
      ensure(!task.segments.some(row=>!row.end),'暂停任务的计时状态不一致，请刷新。');
      const before=copy(task),stoppedAt=task.segments.at(-1)?.end||task.pausedAt||at;
      for(const pause of task.timerPauses||[])if(!pause.end)pause.end=stoppedAt;
      task.status='READY';task.pauseReason='';task.pausedAt=null;delete task.interruptedByOrderId;
      event(task,'REQUEUE_PAUSED',before,task);
    };
    if(action==='selfStart'){
      const person=next.employees.find(row=>same(row.id,actor.employeeId));ensure(actor.role==='employee'&&person?.selfServiceEnabled===true,'当前人员未开通自主报工。');
      ensure(!person.blocked,'当前人员状态待核对，不能自主开工。');
      ensure(!next.assignments.some(row=>same(row.workerId,actor.employeeId)&&['READY','IN_PROGRESS','PAUSED','AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)),'请先处理已有任务，不能绕过派工或暂停任务自主开工。');
      const {order,process}=availableTask(next,{orderId:input.orderId,processId:input.processId});
      ensure((person.boundUnitIds||[]).some(unit=>same(unit,input.unitId))&&next.units.some(unit=>same(unit.id,input.unitId)),'请选择本人可用工位。');
      const task={id:id('assignment'),workerId:String(actor.employeeId),orderId:order.id,orderCode:order.code,processId:process.id,processName:process.name,leaderId:null,isSelfService:true,isQualityInspection:['quality','quality_leader'].includes(person.qualityRole)||process.qualityInspection===true,unitId:input.unitId,priority:'NORMAL',status:'IN_PROGRESS',assignedAt:at,segments:[{start:at,end:null}],pauseReason:'',pausedAt:null};
      next.assignments.push(task);event(task,'EMPLOYEE_SELF_START',{},task);result.assignmentId=task.id;
    }else if(action==='clockOut'){
      const team=clockoutTeam(next,actor);ensure(team.groups.length,'请在后台人员分类中分配负责组长。');
      const tasks=next.assignments.filter(task=>team.ids.includes(String(task.workerId))&&task.status==='IN_PROGRESS'&&!timerPaused(task));
      for(const task of tasks){const before=copy(task);task.timerPauses||=[];task.timerPauses.push({start:at,end:null,source:'clockout',actorId:actor.id});task.timerRevision=(task.timerRevision||0)+1;event(task,'PAUSE_TIMER_FOR_CLOCKOUT',before,task);}
      Object.assign(result,{pausedCount:tasks.length,employeeCount:new Set(tasks.map(task=>task.workerId)).size,executedAt:at});
      next.clockoutLastRun||={};next.clockoutLastRun[actor.id]={...result,status:'SUCCEEDED',kind:'manual'};
    }else if(action==='pauseTimer'||action==='resumeTimer'||action==='leaderPauseTimer'||action==='leaderStartTimer'&&getTask().status==='IN_PROGRESS'){
      const task=getTask(),delegated=action.startsWith('leader'),pause=action==='pauseTimer'||action==='leaderPauseTimer';
      if(delegated)ensure(canManageTimer(next,task,actor),'组长只能调整本人派给当前组员的计时。');
      else ensure(employee(actor,task),'员工只能调整本人报工计时。');
      ensure(task.status==='IN_PROGRESS','仅进行中任务可调整报工计时，插单暂停仍由组长启动。');
      const paused=timerPaused(task);ensure(pause?!paused:paused,'计时状态已变化，请刷新。');const before=copy(task);
      if(pause){
        ensure(Date.parse(at)>=Date.parse(task.segments.at(-1)?.start),'计时时间异常，请刷新。');
        task.timerPauses||=[];task.timerPauses.push({start:at,end:null,source:delegated?'leader':'employee',actorId:actor.id});
      }
      else{const open=task.timerPauses.find(row=>!row.end);ensure(Date.parse(at)>=Date.parse(open.start),'计时时间异常，请刷新。');open.end=at;}
      task.timerRevision=(task.timerRevision||0)+1;
      event(task,(delegated?'LEADER':'EMPLOYEE')+(pause?'_PAUSE_TIMER':'_RESUME_TIMER'),before,task);result.assignmentId=task.id;
    }else if(action==='saveClockoutSchedule'){
      ensure(actor.role==='floor8_leader','只有组长可以设置下班。');
      ensure(typeof input.enabled==='boolean'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)&&Array.isArray(input.days)&&input.days.length>0&&input.days.length<=7&&input.days.every(day=>Number.isInteger(day)&&day>=1&&day<=7),'请选择有效的下班时间和重复日期。');
      ensure(!input.enabled||clockoutTeam(next,actor).groups.length,'请先在后台人员分类中分配负责组长。');
      const current=next.clockoutSchedules?.[actor.id]||{revision:0};ensure(current.revision===input.expectedRevision,'定时设置已变化，请刷新。');
      const days=[...new Set(input.days)].sort((a,b)=>a-b),date=new Date(Date.parse(at)+8*3600000),[hours,minutes]=input.time.split(':').map(Number);let nextRunAt=null;
      if(input.enabled)for(let d=0;d<=7;d++){const candidate=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+d,hours,minutes);if(days.includes(new Date(candidate).getUTCDay()||7)&&candidate-8*3600000>Date.parse(at)){nextRunAt=new Date(candidate-8*3600000).toISOString();break;}}
      next.clockoutSchedules||={};next.clockoutSchedules[actor.id]={revision:current.revision+1,enabled:input.enabled,time:input.time,days,nextRunAt,timezone:'Asia/Shanghai'};result.schedule=copy(next.clockoutSchedules[actor.id]);
    }else if(action==='updateOrder'){
      ensure(actor.role==='floor8_leader','只有组长可以操作工单。');
      const order=next.orders.find(row=>same(row.id,input.orderId));ensure(order,'没有找到该工单。');
      ensure(['EXTREME','URGENT','EXPEDITED','PAUSED','NONE'].includes(input.priority),'请选择有效优先级。');
      ensure(['NOT_STARTED','IN_PROGRESS','FINISHED'].includes(input.status),'请选择有效执行状态。');
      ensure(typeof input.syncPriority==='boolean','请确认是否同步任务优先级。');
      const active=next.assignments.filter(row=>same(row.orderId,order.id)&&!['COMPLETED','CANCELLED'].includes(row.status));
      if(input.status==='FINISHED')ensure(!active.length,'该工单还有未完成任务，请先完成或撤销后再结束工单。');
      if(input.status==='NOT_STARTED'&&order.status!=='NOT_STARTED')ensure(!active.some(row=>exclusive.includes(row.status)),'该工单还有进行中或待核对任务，不能改为未开始。');
      if(input.syncPriority)ensure(active.every(task=>manages(actor,task)),'关联任务包含其他组长的派工，不能同步更改优先级。');
      const before=copy(order);order.priority=input.priority;order.status=input.status;order.operationsUpdatedAt=at;
      if(input.syncPriority){for(const process of order.processes||[])if(!process.closed)process.priority=input.priority;for(const task of active)task.orderPriority=input.priority;order.prioritySyncedAt=at;}
      next.audit.push({id:id('event'),orderId:order.id,type:'UPDATE_ORDER',at,actorId:actor.id,before,after:copy(order),syncPriority:input.syncPriority});result.order=copy(order);
    }else if(action==='reorderQueue'){
      ensure(member(actor,input.workerId),'只有所属组长可以调整任务顺序。');
      const rows=workQueue(next,input.workerId);ensure(rows.every(row=>manages(actor,row)),'该员工还有其他组长的任务，不能调整顺序。');
      const ids=input.assignmentIds;ensure(Array.isArray(ids)&&ids.length===rows.length&&new Set(ids.map(String)).size===ids.length&&ids.every(id=>rows.some(row=>same(row.id,id))),'待办已变化，请刷新后重新排序。');
      ensure(!next.assignments.some(row=>same(row.workerId,input.workerId)&&['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)),'该员工报工待处理，暂不能调整顺序。');
      for(const task of rows)availableTask(next,task);
      const running=rows.find(row=>row.status==='IN_PROGRESS'),paused=[];
      if(running&&!same(running.id,ids[0])){const before=copy(running);closeSegment(running);running.status='PAUSED';running.pausedAt=at;running.pauseReason='组长调整当前工单';event(running,'PAUSE_FOR_QUEUE_SWITCH',before,running);paused.push(running.id);}
      for(const [rank,id]of ids.entries()){const task=rows.find(row=>same(row.id,id)),before=copy(task);task.queueRank=rank;event(task,'REORDER_QUEUE',before,task);}
      next.employeeCurrent||={};next.employeeCurrent[String(input.workerId)]=ids[0]||null;
      requeuePaused(rows.find(row=>same(row.id,ids[0])));
      result.assignmentIds=ids.map(String);result.currentAssignmentId=ids[0]||null;result.pausedAssignmentIds=paused;
    }else if(action==='insertAssignment'){
      const task=getTask();ensure(manages(actor,task)&&canChange(next,task,actor),'只能插入本人派给所属员工的待办或暂停任务。');ensure(['READY','PAUSED'].includes(task.status),'请选择待开始或已暂停的任务插单。');availableTask(next,task);ensure(!next.employees.find(row=>same(row.id,task.workerId))?.blocked,'该员工状态待核对，暂不能插单。');
      const others=next.assignments.filter(row=>same(row.workerId,task.workerId)&&!same(row.id,task.id));
      ensure(!others.some(row=>['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)),'该员工有数量或报工待处理，暂不能插单。');
      const current=others.find(row=>row.status==='IN_PROGRESS');ensure(!current||manages(actor,current),'当前任务由其他组长派出，不能暂停。');
      const before=copy(task),paused=[];
      if(current){const old=copy(current);closeSegment(current);current.status='PAUSED';current.pausedAt=at;current.pauseReason='加急插单：'+task.orderCode;current.interruptedByOrderId=task.orderId;event(current,'AUTO_PAUSE_FOR_URGENT',old,current,current.pauseReason);paused.push(current.id);}
      task.priority='URGENT';
      requeuePaused(task);
      placeWorkQueue(next,task.workerId,[task.id],actor.id);
      event(task,'INSERT_ASSIGNMENT',before,task);result.assignmentId=task.id;result.pausedAssignmentIds=paused;
    }else if(action==='dispatch'){
      const plan=previewDispatch(input,actor);
      const {order,process}=availableTask(next,{orderId:input.orderId,processId:input.processId});
      ensure(['NORMAL','URGENT'].includes(input.priority),'请选择普通或加急派工。');
      ensure(Array.isArray(input.placements)&&plan.workerIds.every(workerId=>input.placements.some(row=>same(row.workerId,workerId)&&next.units.some(unit=>unit.id===row.unitId))),'请确认每位员工的工位。');
      const paused=[];
      for(const affected of plan.affected){
        const task=next.assignments.find(row=>row.id===affected.assignmentId);const before=copy(task);closeSegment(task);
        task.status='PAUSED';task.pausedAt=at;task.pauseReason='加急插单：'+order.code;task.interruptedByOrderId=order.id;
        event(task,'AUTO_PAUSE_FOR_URGENT',before,task,task.pauseReason);paused.push(task.id);
      }
      const assignments=[];
      for(const workerId of plan.workerIds){
        const task={id:id('assignment'),orderId:order.id,orderCode:order.code,processId:process.id,processName:process.name,workerId,
          leaderId:actor.id,unitId:input.placements.find(row=>same(row.workerId,workerId)).unitId,priority:input.priority,orderPriority:order.priority,status:'READY',assignedAt:at,segments:[],pauseReason:'',pausedAt:null};
        next.assignments.push(task);placeWorkQueue(next,workerId,input.priority==='URGENT'?[task.id]:[],actor.id);event(task,'DISPATCH',{},task);assignments.push(task.id);
      }
      result.assignmentIds=assignments;result.pausedAssignmentIds=paused;
    }else if(['editAssignment','cancelAssignment'].includes(action)){
      const task=getTask();ensure(manages(actor,task),'只有派工组长可以编辑或撤销该任务。');
      ensure(canChange(next,task,actor),'该任务已完成、已撤销或数量/报工待处理，不能编辑或撤销。');
      const before=copy(task),wasCurrent=same(employeeHead(next,task.workerId)?.id,task.id);
      const cancel=()=>{if(task.status==='IN_PROGRESS')closeSegment(task);task.status='CANCELLED';task.cancelledAt=at;task.cancelledBy=actor.id;};
      if(action==='cancelAssignment'){
        cancel();event(task,'CANCEL_ASSIGNMENT',before,task);result.assignmentId=task.id;
      }else{
        ensure(['NORMAL','URGENT'].includes(input.priority),'请选择普通或加急派工。');
        ensure(next.units.some(unit=>same(unit.id,input.unitId)),'请选择有效工位。');
        const plan=planDispatch(next,{orderId:task.orderId,processId:input.processId,workerIds:[input.workerId],priority:input.priority},actor,task.id);
        const {process}=availableTask(next,{orderId:task.orderId,processId:input.processId});
        const identityChanged=!same(task.workerId,input.workerId)||!same(task.processId,input.processId);
        const hasHistory=task.segments.length>0||next.reports.some(row=>same(row.assignmentId,task.id));
        const patch={workerId:String(input.workerId),processId:process.id,processName:process.name,unitId:input.unitId,priority:input.priority};
        for(const affected of plan.affected){
          const other=next.assignments.find(row=>same(row.id,affected.assignmentId)),old=copy(other);closeSegment(other);
          other.status='PAUSED';other.pausedAt=at;other.pauseReason='加急插单：'+task.orderCode;other.interruptedByOrderId=task.orderId;
          event(other,'AUTO_PAUSE_FOR_URGENT',old,other,other.pauseReason);
        }
        if(identityChanged&&hasHistory){
          cancel();const replacement={id:id('assignment'),orderId:task.orderId,orderCode:task.orderCode,leaderId:task.leaderId,...patch,status:'READY',assignedAt:at,segments:[],pauseReason:'',pausedAt:null,replacesAssignmentId:task.id};
          task.replacementAssignmentId=replacement.id;next.assignments.push(replacement);
          event(task,'REPLACE_ASSIGNMENT',before,task);event(replacement,'DISPATCH_REPLACEMENT',{},replacement);result.assignmentId=replacement.id;result.replacedAssignmentId=task.id;
        }else{
          Object.assign(task,patch);task.updatedAt=at;if(identityChanged){task.status='READY';delete task.queueRank;}
          event(task,'EDIT_ASSIGNMENT',before,task);result.assignmentId=task.id;
        }
        const changed=next.assignments.find(row=>same(row.id,result.assignmentId));
        if(changed?.status==='READY')placeWorkQueue(next,changed.workerId,input.priority==='URGENT'||wasCurrent&&same(changed.workerId,before.workerId)?[changed.id]:[],actor.id);
      }
    }else if(action==='resume'||action==='leaderStartTimer'&&getTask().status==='PAUSED'){
      const task=getTask(),delegated=action==='leaderStartTimer';
      if(delegated){
        ensure(canManageTimer(next,task,actor),'组长只能启动本人派给当前组员的任务。');
        ensure(!next.employees.find(row=>same(row.id,task.workerId))?.blocked,'人员状态待核对，暂不能开工。');
      }else ensure(manages(actor,task),'只有派工组长可以继续启动该任务。');
      ensure(task.status==='PAUSED','只有已暂停的任务可以继续启动。');availableTask(next,task);
      ensure(!next.assignments.some(row=>same(row.workerId,task.workerId)&&row.id!==task.id&&exclusive.includes(row.status)),'请先完成该员工当前任务和数量确认，再继续启动原任务。');
      ensure(same(employeeHead(next,task.workerId)?.id,task.id)||!pending(next,task.workerId).some(row=>row.priority==='URGENT'),'该员工还有待开始的加急任务，请先处理加急单。');
      const before=copy(task);
      if(delegated&&timerPaused(task)){
        const open=task.timerPauses.find(row=>!row.end);
        ensure(Date.parse(at)>=Date.parse(open.start),'计时时间异常，请刷新。');
        open.end=at;task.timerRevision=(task.timerRevision||0)+1;
      }
      task.status='IN_PROGRESS';task.segments.push({start:at,end:null});task.pauseReason='';task.pausedAt=null;
      placeWorkQueue(next,task.workerId,[task.id],actor.id);event(task,'LEADER_RESUME',before,task);result.assignmentId=task.id;
    }else if(action==='start'||action==='leaderStartTimer'){
      const task=getTask(),delegated=action==='leaderStartTimer';
      if(delegated)ensure(canManageTimer(next,task,actor),'组长只能启动本人派给当前组员的任务。');
      else ensure(employee(actor,task),'员工只能开始本人任务。');
      ensure(['READY','PAUSED'].includes(task.status),'当前任务不能开始，请刷新。');availableTask(next,task);
      ensure(!next.employees.find(row=>same(row.id,task.workerId))?.blocked,'人员状态待核对，暂不能开工。');
      ensure(!next.assignments.some(row=>same(row.workerId,task.workerId)&&row.id!==task.id&&['AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)),'请先确认当前数量或处理待核对报工。');
      const before=copy(task);
      ensure(!next.assignments.some(row=>same(row.workerId,task.workerId)&&row.id!==task.id&&row.status==='IN_PROGRESS'),'请先结束当前任务并确认数量。');
      ensure(same(employeeHead(next,task.workerId)?.id,task.id),'请先开始排在第一位的工单。');
      if(task.status==='PAUSED')requeuePaused(task);
      task.status='IN_PROGRESS';task.pauseReason='';task.pausedAt=null;task.segments.push({start:at,end:null});
      const queue=workQueue(next,task.workerId);[task,...queue.filter(row=>row.id!==task.id)].forEach((row,index)=>{row.queueRank=index;});next.employeeCurrent||={};next.employeeCurrent[String(task.workerId)]=task.id;
      event(task,(delegated?'LEADER':'EMPLOYEE')+(before.status==='PAUSED'?'_RESUME_ASSIGNMENT':'_START'),before,task);result.assignmentId=task.id;
    }else if(action==='end'){
      const task=getTask();ensure(employee(actor,task),'员工只能结束本人任务。');ensure(task.status==='IN_PROGRESS','当前任务不在进行中，请刷新。');availableTask(next,task);
      const before=copy(task);closeSegment(task);task.status='AWAITING_QUANTITY';task.endedAt=at;event(task,'EMPLOYEE_END',before,task);result.assignmentId=task.id;
    }else if(action==='skipClosedAssignment'){
      const task=getTask();
      ensure(closedQueuedAssignment(next,task,actor),'仅可跳过黑湖已关闭、尚未开工的本人队首派工。');
      const before=copy(task);
      task.cancelledAt=at;task.status='CANCELLED';task.queueRank=null;
      event(task,'EMPLOYEE_SKIPPED_CLOSED_ASSIGNMENT',before,task,'员工跳过黑湖已关闭的待开工派工');
      result.assignmentId=task.id;
    }else if(action==='exitClosedSelfTask'){
      const task=getTask();
      ensure(closedSelfTask(next,task,actor),'只有黑湖已关闭且未关联报工的本人自主任务可以退出，请刷新核对。');
      const before=copy(task);
      if(task.status==='IN_PROGRESS')closeSegment(task);
      task.endedAt=task.endedAt||task.segments.at(-1)?.end||null;
      task.cancelledAt=at;task.status='CANCELLED';task.queueRank=null;
      for(const pause of task.timerPauses||[])if(!pause.end)pause.end=at;
      event(task,'SELF_TASK_EXITED_CLOSED',before,task,'黑湖关闭后员工退出自主任务');
      result.assignmentId=task.id;
    }else if(action==='cancelSelfReport'){
      const task=getTask();ensure(employee(actor,task)&&task.isSelfService===true,'只能撤销本人的自主报工。');ensure(task.status==='AWAITING_QUANTITY','只能撤销尚未确认数量的自主报工。');
      ensure(!next.reports.some(row=>same(row.assignmentId,task.id)),'报工已提交或结果待核对，不能撤销此次报工。');ensure(!task.segments.some(row=>!row.end),'计时状态未能确认，请刷新。');
      const before=copy(task);task.status='CANCELLED';task.cancelledAt=at;for(const pause of task.timerPauses||[])if(!pause.end)pause.end=task.endedAt||at;
      event(task,'SELF_REPORT_REVOKED',before,task);result.assignmentId=task.id;
    }else if(action==='cancelEnd'){
      const task=getTask();ensure(employee(actor,task),'员工只能返回本人任务的计时。');ensure(task.status==='AWAITING_QUANTITY','只有尚未确认数量的任务可返回计时。');availableTask(next,task);
      ensure(!next.assignments.some(row=>same(row.workerId,task.workerId)&&row.id!==task.id&&exclusive.includes(row.status)),'该员工正在处理其他任务，不能返回计时。');
      ensure(!next.reports.some(row=>same(row.assignmentId,task.id)&&['REPORTING','NEEDS_REVIEW'].includes(row.upstreamState)),'报工结果待核对，暂不能返回计时。');
      ensure(Number.isFinite(Date.parse(task.endedAt))&&Date.parse(task.endedAt)<=Date.parse(at)&&!task.segments.some(row=>!row.end),'当前计时状态不一致，请刷新。');
      const before=copy(task);task.status='IN_PROGRESS';task.endedAt=null;task.segments.push({start:at,end:null});task.timerRevision=(task.timerRevision||0)+1;
      event(task,'EMPLOYEE_CANCEL_END',before,task);result.assignmentId=task.id;
    }else if(action==='finish'){
      const task=getTask();ensure(employee(actor,task),'员工只能确认本人任务的数量。');ensure(task.status==='AWAITING_QUANTITY','请先结束当前任务，再确认数量。');availableTask(next,task);
      for(const value of [input.goodQuantity,input.defectiveQuantity])ensure(Number.isSafeInteger(value)&&value>=0,'请确认有效的合格数和不良数，不能留空。');
      const quality=selfQuality(next,task);
      let defectItems,defectCodes=input.defectCodes||[];
      if(quality){
        ensure(Number.isSafeInteger(input.goodQuantity+input.defectiveQuantity)&&input.goodQuantity+input.defectiveQuantity>0,'请确认本次生产数量。');
        if(input.defectItems!==undefined){
          ensure(Array.isArray(input.defectItems)&&input.defectItems.length<=30,'请核对不良品项。');const seen=new Set();
          defectItems=input.defectItems.map(item=>{ensure(item&&next.defectReasons.some(row=>row.code===item.code)&&!seen.has(item.code)&&Number.isSafeInteger(item.quantity)&&item.quantity>0,'请选择有效的不良品项并填写正整数数量。');seen.add(item.code);return {code:item.code,quantity:item.quantity};});
          ensure(defectItems.reduce((sum,item)=>sum+item.quantity,0)===input.defectiveQuantity,'不良品项数量合计必须等于不良数。');defectCodes=defectItems.map(item=>item.code);
        }
        if(input.defectiveQuantity>0)ensure(Array.isArray(defectCodes)&&defectCodes.length>0&&defectCodes.every(code=>next.defectReasons.some(row=>row.code===code)),'请选择有效的不良原因。');
      }
      else if(task.isSelfService)ensure(input.defectiveQuantity===0,'当前自主任务不是质检，不能填写不良数。');
      const before=copy(task);if(task.isSelfService)task.isQualityInspection=quality;task.status='COMPLETED';
      const report={id:id('report'),assignmentId:task.id,productionWorkerId:String(task.workerId),goodQuantity:input.goodQuantity,defectiveQuantity:input.defectiveQuantity,...(quality?{defectCodes:copy(defectCodes),...(defectItems?{defectItems}:{} )}:{}),createdAt:at,updatedAt:at,actualStartedAt:task.segments[0]?.start,actualEndedAt:task.endedAt,note:'',deleted:false,upstreamState:'LOCAL_DEMO',elapsedSeconds:seconds(task,task.endedAt)};
      next.reports.push(report);event(task,'EMPLOYEE_FINISH',before,{task,report});result.reportId=report.id;
      // Interrupted work stays paused until the leader resumes it or requeues it for employee start.
    }else if(['editReport','deleteReport','restoreReport'].includes(action)){
      const report=next.reports.find(row=>same(row.id,input.reportId));ensure(report,'没有找到报工记录。');
      const task=next.assignments.find(row=>same(row.id,report.assignmentId));ensure(task&&manages(actor,task),'只有派工组长可以管理该员工的报工。');
      ensure(report.upstreamState==='LOCAL_DEMO','已提交或结果待核对的真实报工需使用正式更正接口，目前仅可查看。');
      const reason=typeof input.reason==='string'?input.reason.trim():'';ensure(reason.length<=200,'操作备注最多200字。');
      const before=copy(report);
      if(action==='editReport'){
        ensure(!report.deleted,'该报工已删除，请先恢复。');
        for(const value of [input.goodQuantity,input.defectiveQuantity])ensure(Number.isSafeInteger(value)&&value>=0,'请填写有效的合格数和不良数。');
        Object.assign(report,reportModel.correction(input,report,task,next,actor,at));
        report.goodQuantity=input.goodQuantity;report.defectiveQuantity=input.defectiveQuantity;
      }else {ensure(action==='deleteReport'?!report.deleted:report.deleted,action==='deleteReport'?'该记录已删除。':'该记录未删除。');report.deleted=action==='deleteReport';}
      report.updatedAt=at;event(task,action==='editReport'?'EDIT_REPORT':action==='deleteReport'?'DELETE_REPORT':'RESTORE_REPORT',before,report,reason);result.reportId=report.id;
    }else throw new Error('不支持此任务操作。');
    ensure(!next.employees.some(worker=>next.assignments.filter(row=>same(row.workerId,worker.id)&&row.status==='IN_PROGRESS').length>1),'同一员工不能同时进行两项任务。');
    next.version++;next.updatedAt=at;result.version=next.version;
    next.operations[operationKey]={fingerprint,result:copy(result)};state=next;return copy(result);
  }
  return {snapshot,previewDispatch,processReports,selfServiceContext,execute,orderOperationsSnapshot,clockoutSnapshot,exportState:()=>copy(state)};
}
export {createExecution};
