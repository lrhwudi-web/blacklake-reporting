const {effectiveWorkSecondsBetween}=require('./work-time');
const pad=n=>String(n).padStart(2,'0');
const check=(ok,message)=>{if(!ok)throw Error(message);};
function stamp(date,time){const value=date+' '+time+':00',at=Date.parse(value.replace(' ','T')+'+08:00');check(Number.isFinite(at)&&new Date(at+8*3600000).toISOString().slice(0,16)===date+'T'+time,'请选择有效日期和时间。');return value;}
function parts(value){return [String(value||'').slice(0,10),String(value||'').slice(11,16)];}
function durationFields(seconds){
 if(!Number.isSafeInteger(seconds)||seconds<0)return {hours:'',minutes:'',unroundedWorkSeconds:null};
 return {hours:String(Math.floor(seconds/3600)),minutes:String(Math.floor(seconds/60)%60),unroundedWorkSeconds:seconds};
}
function form(record){const [startDate,startTime]=parts(record.startedAt),[endDate,endTime]=parts(record.endedAt);const seconds=record.durationSeconds;
 return {operatorId:record.operatorId,operatorName:record.operatorName,startDate,startTime,endDate,endTime,...durationFields(seconds),materialProcess:record.production?.materialProcess||'',punchMinutes:record.production?.punchMinutes==null?intervalMinutes(record.startedAt,record.endedAt):String(record.production.punchMinutes),startOriginal:record.startedAt,endOriginal:record.endedAt,startChanged:false,endChanged:false};}
function intervalMinutes(start,end){const value=(Date.parse(end.replace(' ','T')+'+08:00')-Date.parse(start.replace(' ','T')+'+08:00'))/60000;return Number.isFinite(value)&&value>=0?String(Number(value.toFixed(6))):'';}
function times(draft){return {startedAt:draft.startChanged?stamp(draft.startDate,draft.startTime):draft.startOriginal||stamp(draft.startDate,draft.startTime),endedAt:draft.endChanged?stamp(draft.endDate,draft.endTime):draft.endOriginal||stamp(draft.endDate,draft.endTime)};}
function seconds(draft){
 check(/^\d+$/.test(draft.hours)&&/^\d+$/.test(draft.minutes)&&Number(draft.minutes)<60,'工时请填写整数小时和0至59分钟。');
 const value=Number(draft.hours)*3600+Number(draft.minutes)*60;check(Number.isSafeInteger(value),'工时数值无效。');
 const original=draft.unroundedWorkSeconds;
 return Number.isSafeInteger(original)&&Math.floor(original/60)*60===value?original:value;
}
function recalculate(draft,pauses){const t=times(draft);check(t.endedAt>=t.startedAt,'结束时间不能早于开始时间。');const value=effectiveWorkSecondsBetween(t.startedAt,t.endedAt,pauses||[]);return {...draft,...durationFields(value),punchMinutes:intervalMinutes(t.startedAt,t.endedAt)};}
function payload(data){const f=data.reportEditForm,t=times(f);check(t.endedAt>=t.startedAt,'结束时间不能早于开始时间。');check(/^\d+$/.test(data.reportGoodInput)&&/^\d+$/.test(data.reportDefectInput),'数量须为非负整数。');const goodQuantity=Number(data.reportGoodInput),defectQuantity=Number(data.reportDefectInput);check(goodQuantity+defectQuantity>0,'合格数和不良数合计须大于0。');
 const defectItems=defectQuantity?data.reportReasonOptions.filter(r=>r.selected).map(r=>({code:r.code,amount:Number(r.quantity)})):[];
 check(defectItems.every(r=>Number.isSafeInteger(r.amount)&&r.amount>0)&&defectItems.reduce((n,r)=>n+r.amount,0)===defectQuantity,'各不良项数量合计须等于不良数。');
 const durationSeconds=seconds(f);check(durationSeconds<=(Date.parse(t.endedAt.replace(' ','T')+'+08:00')-Date.parse(t.startedAt.replace(' ','T')+'+08:00'))/1000,'工时不能超过起止时间的实际跨度。');
 return {...t,operatorId:f.operatorId,durationSeconds,materialProcess:f.materialProcess,expectedRemoteVersion:data.reportEditor.remoteVersion,goodQuantity,defectQuantity,defectCodes:defectItems.map(r=>r.code),defectItems};}
function changeTime(draft,part,field,value){
 check(['start','end'].includes(part)&&['date','time'].includes(field),'时间选项无效。');
 check(typeof value==='string'&&(field==='date'?/^\d{4}-\d{2}-\d{2}$/:/^\d{2}:\d{2}$/).test(value),'请选择有效日期和时间。');
 const next={...draft,[part+(field==='date'?'Date':'Time')]:value};
 stamp(next[part+'Date'],next[part+'Time']);
 if(next[part+'Date']===draft[part+'Date']&&next[part+'Time']===draft[part+'Time'])return draft;
 return {...next,[part+'Changed']:true};
}
function peopleView(people,config,selectedId,query=''){
 const configured=config&&Array.isArray(config.groups)&&Number.isSafeInteger(config.allPosition)&&config.allPosition>=0&&config.allPosition<=config.groups.length
   &&config.groups.every(g=>g&&typeof g.id==='string'&&g.id!=='@all'&&typeof g.name==='string'&&Array.isArray(g.operatorIds));
 const groups=configured?config.groups.map(g=>({...g})): [...new Set(people.flatMap(p=>p.departments||[]))].map(name=>({id:'legacy:'+name,name,operatorIds:people.filter(p=>(p.departments||[]).includes(name)).map(p=>p.operatorId)}));
 groups.splice(configured?config.allPosition:0,0,{id:'@all',name:'全部'});
 const selected=groups.find(g=>g.id===selectedId)||groups[0],inGroup=(p,g)=>g.id==='@all'||g.operatorIds.includes(p.operatorId);
 const normalize=v=>String(v||'').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'),needle=normalize(query);
 return {groups:groups.map(g=>({...g,count:people.filter(p=>inGroup(p,g)).length})),selectedId:selected.id,
   results:people.filter(p=>inGroup(p,selected)&&(!needle||normalize([p.name,...(p.departments||[])].join(' ')).includes(needle)))};
}
module.exports={form,times,seconds,recalculate,payload,changeTime,peopleView};
