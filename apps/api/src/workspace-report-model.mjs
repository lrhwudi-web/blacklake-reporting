// Report corrections are separate from live assignments and their timing segments.
const valid=value=>Number.isFinite(Date.parse(value));
const equal=(a,b)=>String(a)===String(b);
const check=(condition,message)=>{if(!condition)throw new Error(message);};
function duration(seconds){return Number.isFinite(seconds)?Math.floor(seconds/3600)+'小时'+Math.floor(seconds%3600/60)+'分'+(seconds%60?' '+Math.round(seconds%60)+'秒':''):'—';}
function localParts(iso){return valid(iso)?new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,16).split('T'):['',''];}
function isoFromParts(date,time){
  check(/^\d{4}-\d{2}-\d{2}$/.test(date)&&/^\d{2}:\d{2}$/.test(time),'请填写完整的开始和结束时间。');
  const iso=new Date(date+'T'+time+':00+08:00');
  check(valid(iso)&&localParts(iso.toISOString()).join('T')===date+'T'+time,'日期或时间无效。');return iso.toISOString();
}
function baseReport(report,task){
  return {...report,productionWorkerId:String(report.productionWorkerId||task.workerId),
    actualStartedAt:report.actualStartedAt||task.segments?.[0]?.start||null,
    actualEndedAt:report.actualEndedAt||(task.status==='COMPLETED'?(task.endedAt||task.segments?.[task.segments.length-1]?.end):null)||report.createdAt||null,
    reportedSeconds:report.reportedSeconds??report.elapsedSeconds??null,materialProcess:report.materialProcess||'',punchMinutes:report.punchMinutes??null,defectItems:report.defectItems||[]};
}
function effectiveSeconds(task,start,end){
  check(valid(start)&&valid(end),'请填写完整的开始和结束时间。');
  const from=Date.parse(start),to=Date.parse(end);check(to>=from,'结束时间不能早于开始时间。');
  // Only subtract known gaps between timing segments; never infer an unknown pause.
  const segments=(task.segments||[]).filter(row=>valid(row.start)).slice().sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  let paused=0;
  for(let i=1;i<segments.length;i++)if(valid(segments[i-1].end))paused+=Math.max(0,Math.min(to,Date.parse(segments[i].start))-Math.max(from,Date.parse(segments[i-1].end)));
  return Math.max(0,Math.round((to-from-paused)/1000));
}
function punchMinutesBetween(start,end){
  if(!valid(start)||!valid(end)||Date.parse(end)<Date.parse(start))return null;
  return (Date.parse(end)-Date.parse(start))/60000;
}
function editorDurationFields(seconds){
  if(!Number.isSafeInteger(seconds)||seconds<0)return {hours:'',minutes:'',unroundedWorkSeconds:null};
  return {hours:String(Math.floor(seconds/3600)),minutes:String(Math.floor(seconds/60)%60),unroundedWorkSeconds:seconds};
}
function editor(report,task,options={}){
  const row=baseReport(report,task),[startDate,startTime]=localParts(row.actualStartedAt),[endDate,endTime]=localParts(row.actualEndedAt);
  const employees=options.employees||[],workerIndex=employees.findIndex(person=>equal(person.id,row.productionWorkerId));
  return {workerIndex,workerId:String(row.productionWorkerId),workerName:employees[workerIndex]?.name||'人员待核对',startDate,startTime,endDate,endTime,startOriginal:row.actualStartedAt,endOriginal:row.actualEndedAt,startChanged:false,endChanged:false,
    ...editorDurationFields(row.reportedSeconds),materialProcess:row.materialProcess,punchMinutes:punchMinutesBetween(row.actualStartedAt,row.actualEndedAt)?.toFixed(2)??'',
    effectiveText:valid(row.actualStartedAt)&&valid(row.actualEndedAt)?duration(effectiveSeconds(task,row.actualStartedAt,row.actualEndedAt)):'—',
    defects:(options.defectReasons||[]).map(reason=>({...reason,selected:row.defectItems.some(item=>item.code===reason.code),quantity:String(row.defectItems.find(item=>item.code===reason.code)?.quantity||'')}))};
}
function editorTimes(form){return {actualStartedAt:form.startChanged?isoFromParts(form.startDate,form.startTime):form.startOriginal,actualEndedAt:form.endChanged?isoFromParts(form.endDate,form.endTime):form.endOriginal};}
function editorSeconds(form){
  check(/^\d+$/.test(form.hours)&&/^\d+$/.test(form.minutes)&&Number(form.minutes)<60,'工时请填写整数小时和0至59分钟。');
  const seconds=Number(form.hours)*3600+Number(form.minutes)*60;
  check(Number.isSafeInteger(seconds)&&seconds>=0,'工时数值无效。');
  const original=form.unroundedWorkSeconds;
  return Number.isSafeInteger(original)&&Math.floor(original/60)*60===seconds?original:seconds;
}
function editorPayload(form,employees){
  const worker=form.workerId!=null?employees.find(person=>equal(person.id,form.workerId)):employees[form.workerIndex];check(worker,'请选择生产人员。');
  const reportedSeconds=editorSeconds(form);
  const times=editorTimes(form),punchMinutes=punchMinutesBetween(times.actualStartedAt,times.actualEndedAt);
  check(punchMinutes!==null,'请填写有效的起止时间，结束不能早于开始。');
  check(reportedSeconds<=Math.round(punchMinutes*60),'工时不能超过起止时间的实际跨度。');
  return {...times,productionWorkerId:String(worker.id),reportedSeconds,
    materialProcess:form.materialProcess,punchMinutes,
    defectItems:form.defects.filter(row=>row.selected).map(row=>({code:row.code,quantity:/^\d+$/.test(row.quantity)?Number(row.quantity):null}))};
}
function correction(input,report,task,state,actor,now){
  const row={...baseReport(report,task),...input};
  check(state.employees.some(person=>equal(person.id,row.productionWorkerId))&&actor.employeeIds.some(id=>equal(id,row.productionWorkerId)),'生产人员不在当前组长管理范围内。');
  check(valid(row.actualStartedAt)&&valid(row.actualEndedAt),'请填写完整的开始和结束时间。');
  check(Date.parse(row.actualEndedAt)<=Date.parse(now),'结束时间不能晚于当前时间。');
  const effective=effectiveSeconds(task,row.actualStartedAt,row.actualEndedAt);
  check(Number.isSafeInteger(row.reportedSeconds)&&row.reportedSeconds>=0,'报工时长无效。');
  check(row.punchMinutes===null||Number.isFinite(row.punchMinutes)&&row.punchMinutes>=0&&row.punchMinutes<=Number.MAX_SAFE_INTEGER/60,'打卡报工时长无效。');
  check(typeof row.materialProcess==='string'&&row.materialProcess.trim().length<=100,'用料工序最多100字。');
  check(Array.isArray(row.defectItems)&&row.defectItems.length<=30,'请核对不良品项。');
  const seen=new Set(),items=row.defectItems.map(item=>{
    const reason=(state.defectReasons||[]).find(reason=>reason.code===item.code);
    check(reason&&!seen.has(item.code)&&Number.isSafeInteger(item.quantity)&&item.quantity>0,'请选择有效的不良项，并填写正整数数量。');seen.add(item.code);
    return {code:reason.code,name:reason.name,quantity:item.quantity};
  });
  check(items.reduce((sum,item)=>sum+item.quantity,0)===input.defectiveQuantity,'不良项数量合计必须等于不良数。');
  return {productionWorkerId:String(row.productionWorkerId),actualStartedAt:new Date(row.actualStartedAt).toISOString(),actualEndedAt:new Date(row.actualEndedAt).toISOString(),
    reportedSeconds:row.reportedSeconds,effectiveSeconds:effective,materialProcess:row.materialProcess.trim(),punchMinutes:row.punchMinutes,defectItems:items};
}
function peopleGroups(employees,query='',expandedKeys=[],selectedId='',collapsedKeys=[]){
  const needle=query.trim().toLowerCase(),groups=new Map(),matches=new Set();
  employees.forEach((person,index)=>{
    const departments=Array.isArray(person.departments)?[...new Set(person.departments.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))]:[];
    for(const department of departments.length?departments:['未分部门']){
      if(needle&&![person.name,person.id,department].some(value=>String(value||'').toLowerCase().includes(needle)))continue;
      if(!groups.has(department))groups.set(department,{key:department,name:department,members:[]});
      groups.get(department).members.push({id:String(person.id),name:person.name||'人员待核对',initial:(person.name||'员').slice(-1),sourceIndex:index,selected:equal(person.id,selectedId)});matches.add(String(person.id));
    }
  });
  return {total:matches.size,groups:[...groups.values()].map(group=>{const expanded=needle?!collapsedKeys.includes(group.key):expandedKeys.includes(group.key);return {...group,expanded,count:group.members.length,height:expanded?group.members.length*48:0};})};
}
function createDateWheel(form,part,now=new Date().toISOString()){
  check(['start','end'].includes(part),'请选择开始或结束时间。');
  const fallback=localParts(now),date=form[part+'Date']||fallback[0],time=form[part+'Time']||fallback[1];isoFromParts(date,time);
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),first=Math.max(1,year-20),last=Math.min(9999,year+20);
  const wheel={part,years:Array.from({length:last-first+1},(_,index)=>first+index),months:Array.from({length:12},(_,index)=>index+1),hours:Array.from({length:24},(_,index)=>String(index).padStart(2,'0')),minutes:Array.from({length:60},(_,index)=>String(index).padStart(2,'0'))};
  return updateDateWheel(wheel,[year-first,month-1,day-1,hour,minute]);
}
function updateDateWheel(wheel,value){
  check(Array.isArray(value)&&value.length===5&&value.every(index=>Number.isSafeInteger(index)&&index>=0),'时间选项无效。');
  const [yearIndex,monthIndex,dayIndex,hour,minute]=value;check(yearIndex<wheel.years.length&&monthIndex<12&&dayIndex<31&&hour<24&&minute<60,'时间选项超出范围。');
  const year=wheel.years[yearIndex],leap=year%4===0&&(year%100!==0||year%400===0),count=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][monthIndex];
  return {...wheel,days:Array.from({length:count},(_,index)=>index+1),value:[yearIndex,monthIndex,Math.min(dayIndex,count-1),hour,minute]};
}
function dateWheelStrings(wheel){const row=updateDateWheel(wheel,wheel.value),[year,month,day,hour,minute]=row.value;return {date:String(row.years[year]).padStart(4,'0')+'-'+String(month+1).padStart(2,'0')+'-'+String(day+1).padStart(2,'0'),time:String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')};}
export default {duration,localParts,baseReport,effectiveSeconds,editor,editorTimes,editorSeconds,editorPayload,editorDurationFields,punchMinutesBetween,correction,peopleGroups,createDateWheel,updateDateWheel,dateWheelStrings};
