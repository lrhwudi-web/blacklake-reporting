const SIZE = 52;
const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function bounds(width, height, searchBottom = 204, dockTop = height - 140) {
  return { minX:8, maxX:Math.max(8,width-SIZE-8), minY:Math.min(Math.max(8,searchBottom+8),height-SIZE-8),
    maxY:Math.max(8,Math.min(height-SIZE-8,dockTop-SIZE-12)), width, height, dockTop };
}
function point(value, box) {
  return {x:clamp(value.x,box.minX,box.maxX),y:clamp(value.y,Math.min(box.minY,box.maxY),box.maxY)};
}
function restore(saved, box) {
  if (!saved || saved.version !== 1 || !finite(saved.x) || !finite(saved.y) || saved.x<0 || saved.x>1 || saved.y<0 || saved.y>1) return point({x:12,y:box.maxY},box);
  return point({x:box.minX+saved.x*(box.maxX-box.minX),y:Math.min(box.minY,box.maxY)+saved.y*(box.maxY-Math.min(box.minY,box.maxY))},box);
}
function remember(position, box) {
  const p=point(position,box),minY=Math.min(box.minY,box.maxY);
  return {version:1,x:(p.x-box.minX)/Math.max(1,box.maxX-box.minX),y:(p.y-minY)/Math.max(1,box.maxY-minY)};
}
function storageKey(scope, ownerKey) {
  return scope && typeof ownerKey==='string' && /^operator:[A-Za-z0-9_-]{1,80}$/.test(ownerKey)
    ? 'dispatch_order_orb_v1:'+encodeURIComponent(scope)+':'+encodeURIComponent(ownerKey) : '';
}
function panel(position, box) {
  const width=Math.min(344,box.width-24),spaceAbove=Math.max(0,position.y-24),spaceBelow=Math.max(0,Math.min(box.dockTop,box.height)-position.y-SIZE-24);
  const height=Math.max(100,Math.min(516,Math.max(spaceAbove,spaceBelow),box.height-24));
  const x=clamp(position.x-12,12,box.width-width-12);
  const y=clamp(spaceBelow>spaceAbove?position.y+SIZE+12:position.y-height-12,12,box.height-height-12);
  return {x,y,width,height,closedTransform:`translate3d(${position.x}px,${position.y}px,0) scale(${SIZE/width},${SIZE/height})`,
    openTransform:`translate3d(${x}px,${y}px,0) scale(1,1)`};
}
const quantity = value => finite(value) && value>=0 ? String(Math.round(value*1000)/1000) : '未确认';
function time(value) {
  if(typeof value!=='string')return '未确认';
  if(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const n=Date.parse(value);if(!Number.isFinite(n))return '未确认';
    return new Date(n+8*3600_000).toISOString().slice(0,16).replace('T',' ');
  }
  const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  return match?match[1]+' '+match[2]:'未确认';
}
function model(result={}, fallback={}, now=Date.now()) {
  const order={...fallback,...result.workOrder},unit=typeof order.unit==='string'?order.unit:'';
  const closed=['20','已结束'].includes(String(order.projectStatus));
  const statusLabel=closed?'已结束':['0','未开始'].includes(String(order.projectStatus))?'未开始':['10','执行中'].includes(String(order.projectStatus))?'执行中':'状态未确认';
  let dueLabel='';
  if(!closed && typeof order.planEndTime==='string') {
    const day=/^(\d{4}-\d{2}-\d{2})/.exec(order.planEndTime)?.[1],today=new Date(now+8*3600_000).toISOString().slice(0,10);
    const dayValue=day?Date.parse(day+'T00:00:00Z'):NaN;
    const valid=Number.isFinite(dayValue)&&new Date(dayValue).toISOString().slice(0,10)===day;
    const raw=order.planEndTime.trim().replace(' ','T');
    const end=valid&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)?Date.parse(raw+(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)?'':'+08:00')):NaN;
    const delta=end-now,days=Math.floor(Math.abs(delta)/86400_000);
    if(Number.isFinite(delta))dueLabel=delta<0?(days?'逾期 '+days+' 天':'已逾期'):(days?'剩 '+days+' 天':'不足 1 天');
  }
  const images=(Array.isArray(order.productImageUrls)?order.productImageUrls:[]).filter(url=>typeof url==='string'&&/^https:\/\//i.test(url)).slice(0,8);
  return {...order,productImageUrls:images,imageUrl:images[0]||'',statusLabel,dueLabel,planLabel:quantity(order.plannedAmount),unit,
    progressLabel:quantity(order.actualAmount)+' / '+quantity(order.plannedAmount)+unit,
    startLabel:time(order.planStartTime),endLabel:time(order.planEndTime),
    updatedLabel:time(result.source?.asOf).replace(/^\d{4}-\d{2}-\d{2} /,''),
    partial:result.metadataStatus==='unavailable',
    processes:(result.processOverview||[]).map(p=>({...p,percentLabel:p.percentLabel||'—',statusLabel:p.statusLabel||'状态未确认'}))};
}
module.exports={SIZE,bounds,point,restore,remember,storageKey,panel,model};
