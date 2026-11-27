import {AppError,assert} from './errors.mjs';

const SECOND=1000,MINUTE=60000,HOUR=60*MINUTE,REPEAT=10000;
export const blacklakeQuota=Object.freeze({totalPerHour:10000,totalQps:20,writePerHour:5000,writeQps:10,loginPerHour:75});
const bounded=(value,max)=>Number.isSafeInteger(value)&&value>=1&&value<=max;

// Account budget. Retain exact recent starts for QPS/dedup and minute buckets
// for the hour (include the partially elapsed oldest minute conservatively).
export class BlacklakeRequestBudget {
 constructor({totalPerHour=10000,totalQps=20,writePerHour=5000,writeQps=10,loginPerHour=75,backgroundPerHour=Math.max(1,Math.floor(totalPerHour*.8)),backgroundQps=Math.max(1,Math.floor(totalQps*.8)),maxInFlight=20,cooldownMs=120000,maxWaitMs=15000,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,load=()=>null,save=()=>{}}={}){
  assert(bounded(totalPerHour,10000)&&bounded(totalQps,20)&&bounded(writePerHour,Math.min(5000,totalPerHour))&&bounded(writeQps,Math.min(10,totalQps))&&bounded(loginPerHour,75)&&bounded(backgroundPerHour,totalPerHour)&&bounded(backgroundQps,totalQps)&&bounded(maxInFlight,20)&&cooldownMs>=1000&&maxWaitMs>=0,500,'INVALID_REQUEST_BUDGET','黑湖统一限速参数无效。');
  Object.assign(this,{totalPerHour,totalQps,writePerHour,writeQps,loginPerHour,backgroundPerHour,backgroundQps,maxInFlight,cooldownMs,maxWaitMs,now,setTimer,clearTimer,save});
  this.queue=[];this.active=0;this.timer=null;
  const prior=load()||{},sends=Array.isArray(prior.sends)?prior.sends:[];
  this.state={sends,buckets:Array.isArray(prior.buckets)?prior.buckets:[],hour:Array.isArray(prior.hour)?prior.hour:[],
   cooldownUntil:Number(prior.cooldownUntil)||0,penalty:Math.min(4,Math.max(0,Number(prior.penalty)||0)),last429:Number(prior.last429)||0,lastRecovery:Number(prior.lastRecovery)||0};
  if(!Array.isArray(prior.hour)){
   // The old snapshot lacked classifications. Count all legacy starts toward
   // total and writes conservatively during the transition.
   for(const row of this.state.buckets){if(Number.isFinite(row.at)&&row.sent>0)this.state.hour.push({at:row.at,total:row.sent,write:row.sent,login:0,background:row.background||0});}
   this.state.sends=sends.map(r=>({...r,kind:'write'}));
  }
 }
 prune(){const at=this.now();this.state.sends=this.state.sends.filter(r=>Number.isFinite(r.at)&&r.at>at-REPEAT);this.state.hour=this.state.hour.filter(r=>r.at+MINUTE>at-HOUR);this.state.buckets=this.state.buckets.filter(r=>r.at>at-30*MINUTE);}
 mark(key){const at=Math.floor(this.now()/MINUTE)*MINUTE;let b=this.state.buckets.find(r=>r.at===at);if(!b){b={at,sent:0,priority:0,background:0,rateLimited:0,deferred:0};this.state.buckets.push(b);}b[key]++;}
 countStart(item,at){
  this.state.sends.push({at,kind:item.kind,priority:item.priority,...(item.repeatKey?{repeatKey:item.repeatKey}:{})});
  const minute=Math.floor(at/MINUTE)*MINUTE;
  let b=this.state.hour.at(-1);if(b?.at!==minute){b={at:minute,total:0,write:0,login:0,background:0};this.state.hour.push(b);}
  b.total++;if(item.kind!=='read')b[item.kind]++;if(!item.priority)b.background++;
  this.mark('sent');this.mark(item.priority?'priority':'background');
 }
 persist(){this.prune();this.save(structuredClone(this.state));}
 deferred(delay,code='BLACKLAKE_REQUEST_DEFERRED'){const e=new AppError(503,code,code==='BLACKLAKE_RATE_COOLDOWN'?'黑湖正在冷却，后台会稍后同步；已保存的数据仍可查看。':'黑湖请求达到当前额度，稍后再同步。');e.retryAfterMs=Math.max(1000,Math.ceil(delay));return e;}
 reject(item,error){this.clearTimer(item.deadlineTimer);const i=this.queue.indexOf(item);if(i>=0)this.queue.splice(i,1);this.mark('deferred');this.persist();item.reject(error);}
 run(fn,{kind='read',priority=false,repeatKey,deferRepeated=false}={}){return new Promise((resolve,reject)=>{
  if(this.state.cooldownUntil>this.now()){this.mark('deferred');this.persist();return reject(this.deferred(this.state.cooldownUntil-this.now(),'BLACKLAKE_RATE_COOLDOWN'));}
  if(this.queue.length>=100&&kind==='write'){
   const replace=this.queue.findLast(item=>!item.priority);
   if(replace)this.reject(replace,this.deferred(1000));
  }
  if(this.queue.length>=100){this.mark('deferred');this.persist();return reject(this.deferred(1000));}
  const item={fn,priority:kind==='write'||priority,kind,repeatKey,deferRepeated,resolve,reject,deadline:this.now()+this.maxWaitMs};
  item.deadlineTimer=this.setTimer(()=>{if(this.queue.includes(item)){this.reject(item,this.deferred(1000));this.pump();}},this.maxWaitMs);
  this.queue.push(item);this.pump();
 });}
 hourDelay(key,limit,at){
  const bins=this.state.hour;let used=bins.reduce((sum,r)=>sum+r[key],0);
  if(used<limit)return 0;
  for(const r of bins){used-=r[key];if(used<limit)return r.at+MINUTE+HOUR-at;}
  return HOUR;
 }
 secondDelay(rows,limit,at){return rows.length>=limit?rows[rows.length-limit].at+SECOND-at:0;}
 delay(item,at){
  const recent=this.state.sends.filter(r=>r.at>at-SECOND),scale=2**this.state.penalty,reduce=value=>Math.max(1,Math.floor(value/scale));
  const repeat=item.repeatKey?this.state.sends.findLast(row=>row.repeatKey===item.repeatKey):null;
  const repeatDelay=repeat?Math.max(0,repeat.at+REPEAT-at):0;
  const delay=Math.max(this.hourDelay('total',this.totalPerHour,at),this.secondDelay(recent,reduce(this.totalQps),at),repeatDelay,
   item.kind==='write'?Math.max(this.hourDelay('write',this.writePerHour,at),this.secondDelay(recent.filter(r=>r.kind==='write'),reduce(this.writeQps),at)):0,
   item.kind==='login'?this.hourDelay('login',this.loginPerHour,at):0,
   !item.priority?Math.max(this.hourDelay('background',this.backgroundPerHour,at),this.secondDelay(recent.filter(r=>!r.priority),reduce(this.backgroundQps),at)):0);
  return {delay,repeatDelay};
 }
 pump(){
  this.clearTimer(this.timer);this.timer=null;this.prune();const at=this.now();
  if(this.state.cooldownUntil>at){for(const item of [...this.queue])this.reject(item,this.deferred(this.state.cooldownUntil-at,'BLACKLAKE_RATE_COOLDOWN'));return;}
  if(this.state.penalty&&at-Math.max(this.state.last429,this.state.lastRecovery)>15*MINUTE){this.state.penalty--;this.state.lastRecovery=at;this.persist();}
  if(this.active>=this.maxInFlight)return;
  const rank=item=>item.kind==='write'?2:Number(item.priority);
  this.queue.sort((a,b)=>rank(b)-rank(a));
  let earliest=Infinity;
  for(const item of [...this.queue]){
   if(this.active>=this.maxInFlight)break;
   const {delay,repeatDelay}=this.delay(item,at);
   if(delay>item.deadline-at||item.deferRepeated&&repeatDelay>0){this.reject(item,this.deferred(delay));continue;}
   if(delay){earliest=Math.min(earliest,delay);continue;}
   this.queue.splice(this.queue.indexOf(item),1);this.clearTimer(item.deadlineTimer);
   try{this.countStart(item,at);this.persist();}catch(error){item.reject(error);continue;}
   this.active++;
   Promise.resolve().then(item.fn).then(item.resolve,item.reject).finally(()=>{this.active--;this.pump();});
  }
  if(Number.isFinite(earliest))this.timer=this.setTimer(()=>this.pump(),earliest);
 }
 response(status,retryAfter){if(status!==429)return;const at=this.now(),seconds=Number(retryAfter),date=typeof retryAfter==='string'?Date.parse(retryAfter):NaN,requested=retryAfter!=null&&String(retryAfter).trim()!==''&&Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-at:0;
  this.state.penalty=Math.min(4,this.state.penalty+1);this.state.last429=at;this.state.cooldownUntil=Math.max(this.state.cooldownUntil,at+Math.max(requested,Math.min(15*MINUTE,this.cooldownMs*2**(this.state.penalty-1))));this.mark('rateLimited');this.persist();this.pump();
 }
 status(){this.prune();const totals=Object.fromEntries(['sent','priority','background','rateLimited','deferred'].map(key=>[key,this.state.buckets.reduce((sum,b)=>sum+(b[key]||0),0)])),usage=Object.fromEntries(['total','write','login'].map(key=>[key,this.state.hour.reduce((sum,b)=>sum+b[key],0)]));return {quotas:{totalPerHour:this.totalPerHour,totalQps:this.totalQps,writePerHour:this.writePerHour,writeQps:this.writeQps,loginPerHour:this.loginPerHour},usage,backgroundPerHour:this.backgroundPerHour,backgroundQps:this.backgroundQps,cooldownUntil:this.state.cooldownUntil>this.now()?new Date(this.state.cooldownUntil).toISOString():null,penalty:this.state.penalty,queued:this.queue.length,inFlight:this.active,last30Minutes:totals,scope:'single-server-account-all-HTTP-requests'};}
}
