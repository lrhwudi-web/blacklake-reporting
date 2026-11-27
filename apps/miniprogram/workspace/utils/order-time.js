function milliseconds(value){
  if(value==null||value==='')return NaN;
  if(typeof value==='number')return value;
  const text=String(value).trim(),stamp=/[zZ]|[+-]\d\d:\d\d$/.test(text)?text:text.replace(' ','T')+'+08:00';
  return Date.parse(stamp);
}
function remaining(order,now=Date.now()){
  const end=milliseconds(order.endAt);if(!Number.isFinite(end))return {dueText:'',dueLabel:'',overdue:false};
  if(order.status==='FINISHED')return {dueText:'',dueLabel:'',overdue:false};
  const delta=end-now,absolute=Math.abs(delta),days=Math.floor(absolute/86400000),hours=Math.ceil(absolute/3600000);
  const text=days>=1?days+'天':hours>=1?hours+'小时':'不足1小时';
  return {dueText:text,dueLabel:delta<0?'逾期':'剩',overdue:delta<0};
}
function compareCreated(a,b,direction='desc'){
  const first=milliseconds(a.createdAt),second=milliseconds(b.createdAt);
  if(Number.isFinite(first)!==Number.isFinite(second))return Number.isFinite(first)?-1:1;
  return (Number.isFinite(first)?(direction==='asc'?first-second:second-first):0)||String(b.id).localeCompare(String(a.id),'en',{numeric:true});
}
module.exports={milliseconds,remaining,compareCreated};
