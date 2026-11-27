import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
const info=(id,createdAt='2026-11-13 08:00:00')=>({projectId:id,projectCode:'WO-'+id,productCode:'SKU-'+id,productName:'合成产品',projectStatus:'10',projectPriority:0,createdAt,planEndTime:'2026-12-18 18:00:00'});
function fixture(){let now=Date.parse('2026-11-13T01:00:00Z');const store=new Store(':memory:',{sessionSecret:'catalog-isolated',sessionDays:1}),calls=[],blacklake={listOperators:async()=>[],queryOutputPage:async()=>({records:[],total:0})},sync=new BlacklakeSync({store,blacklake,now:()=>now,historyDays:0});sync.save('catalog','all',{pageNum:1});sync.save('catalog','all-head',{pageNum:1});sync.save('catalog','all-delta',{pageNum:1});sync.save('people','all',[]);sync.save('history-day','2026-11-13',{pageNum:1,watermark:'2026-11-13 09:00:00'});return {store,sync,calls,blacklake,advance:ms=>now+=ms,close:()=>store.close()};}

test('工单报工跨全部日期分页共享，按工序筛选，删除与查询失败保留真实边界',async()=>{const f=fixture();try{
 const records=Array.from({length:205},(_,n)=>({id:70000+n,projectId:201,projectCode:'WO-201',taskId:n%2?11:12,createdAt:'2024-01-01 09:00:00',productionStaff:'历史员工',numberofgoodProducts:1,numberofDefectives:0})),requests=[];
 f.blacklake.queryOutputPage=async(filters,page)=>{requests.push({filters,page});return {total:records.length,records:records.slice((page.pageNum-1)*100,page.pageNum*100)};};
 assert.equal(f.sync.orderReports(201,'WO-201').sync.complete,false);f.sync.orderReports(201,'WO-201');assert.equal(f.sync.jobs.list().jobs.length,1);
 await f.sync.tick();assert.equal(f.sync.orderReports(201,'WO-201').records.length,100);assert.equal(f.sync.orderReports(201,'WO-201').sync.complete,false);
 await f.sync.tick();await f.sync.tick();let result=f.sync.orderReports(201,'WO-201');assert.equal(result.sync.complete,true);assert.equal(result.records.length,205);assert(requests.every(c=>c.filters.projectCode==='WO-201'&&!c.filters.createdAtGte));
 f.advance(61000);f.blacklake.queryOutputPage=async()=>{throw Error('read unavailable');};f.sync.orderReports(201,'WO-201');await f.sync.tick();assert.equal(f.sync.orderReports(201,'WO-201').records.length,205);assert.equal(f.sync.orderReports(201,'WO-201').sync.status,'stale');
}finally{f.close();}});

test('全目录按真实创建时间排序，未知时间排后，搜索与状态先筛选再分页',()=>{const f=fixture();try{
 for(let n=1;n<=65;n++)f.sync.indexOrder(info(n,'2026-11-'+String(Math.floor((n-1)/5)+1).padStart(2,'0')+' 08:00:00'));
 f.sync.indexOrder({...info(999,null),projectCode:'2024-历史工单',productName:'中文 模糊产品'});
 f.sync.indexOrder({...info(998,'2026-11-14 08:00:00'),projectCode:'特殊编号',projectStatus:'20',productName:'中文 模糊产品'});
 const first=f.sync.list();assert.equal(first.total,67);assert.equal(first.orders[0].id,998);assert.equal(first.orders.length,20);assert.equal(first.hasMore,true);assert(first.orders[0].createdAt);
 const all=Array.from({length:4},(_,n)=>f.sync.list({pageNum:n+1}).orders).flat();assert.equal(all.length,67);assert.equal(new Set(all.map(r=>r.id)).size,67);assert.equal(all.at(-1).id,999);
 const found=f.sync.list({projectCode:'中文 模糊',status:'FINISHED'});assert.equal(found.total,1);assert.equal(found.orders[0].id,998);assert.equal(found.statusCounts.FINISHED,1);
 assert.equal(f.sync.list({projectCode:'2024历史'}).orders[0].id,999);assert.equal(f.sync.list({projectCode:"' OR 1=1 --"}).total,0);assert.throws(()=>f.sync.list({sort:'created_at;DROP'}),e=>e.code==='WORKSPACE_INVALID_QUERY');
}finally{f.close();}});

test('目录首次分批补齐，之后只检查有限页；变化更新本地索引，不批量重查已缓存路线',async()=>{const f=fixture();try{
 f.store.db.prepare("DELETE FROM blacklake_sync_snapshots WHERE kind='catalog'").run();let changed=false;
 f.blacklake.queryWorkOrderCatalogPage=async input=>{f.calls.push(input);return input.year===2026?{records:input.pageNum===1?[{...info(1),productName:changed?'合成产品更新':'合成产品'}]:[info(2)],hasMore:input.pageNum===1}:{records:[],hasMore:false};};
 f.sync.ensureScheduled();await f.sync.tick();assert.equal(f.sync.snapshot('catalog','all').sync.complete,false);
 for(let n=0;n<60&&!f.sync.snapshot('catalog','all').sync.complete;n++)await f.sync.tick();
 assert.equal(f.sync.snapshot('catalog','all').sync.complete,true);assert.deepEqual(f.calls.slice(0,3).map(c=>[c.year,c.pageNum]),[[2026,1],[2026,2],[2025,1]]);assert.equal(f.calls.at(-1).year,2001);const fullCalls=f.calls.length;
 f.sync.save('order',1,{info:info(1),tasks:[]});changed=true;f.sync.ensureScheduled();await f.sync.tick();assert.equal(f.calls.at(-1).pageNum,1);assert.equal(f.sync.jobs.byKey('read:catalog:all-head').result.changed,1);assert.equal(f.sync.jobs.byKey('read:order:1'),null);assert.equal(f.sync.jobs.byKey('read:order:2'),null);assert.equal(f.calls.length,fullCalls+1);
}finally{f.close();}});

test('历史补齐后使用固定水位与一分钟重叠获取新增，不从当天零点重复全量',async()=>{const f=fixture();try{
 f.advance(120000);const day='2026-11-13';f.sync.ensureScheduled();const job=f.sync.jobs.byKey('read:history-day:'+day);assert.equal(job.payload.from,day+' 08:59:00');assert.equal(job.payload.to,day+' 09:02:00');
 let filters;f.blacklake.queryOutputPage=async input=>{filters=input;return {records:[],total:0};};
 // Claim through the real worker so the stale-executor guard also applies.
 while(f.sync.jobs.get(job.id).state==='QUEUED'){f.blacklake.queryWorkOrderCatalogPage=async()=>({records:[],hasMore:false});await f.sync.tick();}
 assert.equal(filters.createdAtGte,day+' 08:59:00');assert.equal(filters.createdAtLte,day+' 09:02:00');assert.equal(f.sync.snapshot('history-day',day).data.watermark,day+' 09:02:00');
}finally{f.close();}});

test('工单全目录使用查询3的单年创建区间，不再依赖编号年份或空筛选',async()=>{
 let body;const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async(url,options)=>{assert(url.endsWith('/api/dytin/external/project/queryList3'));body=JSON.parse(options.body);return new Response(JSON.stringify({code:'01000000',data:{list:[{id:1,projectCode:'任意历史编号',createTime:'2024-03-01 08:00:00',planEndTime:'2026-12-18 18:00:00'}]}}));});
 const result=await client.queryWorkOrderCatalogPage({year:2024,pageNum:1});assert.equal('projectCode'in body,false);assert.equal(body.createdAtGte,'2024-01-01 00:00:00');assert.equal(body.createdAtLte,'2024-12-31 23:59:59');assert.equal(result.records[0].createdAt,'2024-03-01 08:00:00');assert.equal(result.records[0].planEndTime,'2026-12-18 18:00:00');
});

test('查询3无列表结构时拒绝，不把成功码加null误当空目录',async()=>{
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async()=>new Response(JSON.stringify({code:'01000000',data:null})));
 await assert.rejects(client.queryWorkOrderCatalogPage({year:2026}),{code:'BLACKLAKE_PROJECT_FORMAT'});
});

test('查询3省略图片时保留已有详情图片，完整详情仍可明确清空图片',()=>{const f=fixture();try{
 f.sync.indexOrder({...info(1),productImageUrls:['https://fixture.invalid/product.png']});
 f.sync.indexOrder({...info(1),productImageUrls:[]},{catalog:true});assert.deepEqual(f.sync.list().orders[0].imageUrls,['https://fixture.invalid/product.png']);
 f.sync.indexOrder({...info(1),productImageUrls:[]});assert.deepEqual(f.sync.list().orders[0].imageUrls,[]);
}finally{f.close();}});

test('全目录逐年游标可重建继续，历史单年入口保持独立，增量只轮巡一页',async()=>{const f=fixture();try{
 f.blacklake.queryWorkOrderCatalogPage=async input=>{f.calls.push(input);return {records:[info(input.year)],hasMore:false};};
 f.sync.request('catalog','all',{year:2002,pageNum:1});await f.sync.tick();assert.equal(f.sync.snapshot('catalog','all').sync.complete,false);assert.equal(f.sync.snapshot('catalog','all').sync.scope.nextYear,2001);
 const again=new BlacklakeSync({store:f.store,blacklake:f.blacklake,now:()=>Date.parse('2026-11-13T01:00:00Z')});await again.tick();assert.equal(again.snapshot('catalog','all').sync.complete,true);assert.equal(f.calls.at(-1).year,2001);
 again.request('catalog','all-delta',{year:2024,pageNum:1,incremental:true,rotating:true});await again.tick();assert.equal(again.jobs.byKey('read:catalog:all-delta').state,'SUCCEEDED');assert.equal(again.snapshot('catalog','all-delta').data.nextYear,2023);assert.equal(again.snapshot('catalog','all-delta').data.nextPage,1);
}finally{f.close();}});

test('旧预同步游标越过黑湖日期下界时回到已验证边界，不陷入永久错误重试',async()=>{const f=fixture();try{
 let year;f.blacklake.queryWorkOrderCatalogPage=async input=>{year=input.year;return {records:[],hasMore:false};};f.sync.request('catalog','all',{year:2000,pageNum:1});await f.sync.tick();assert.equal(year,2001);assert.equal(f.sync.snapshot('catalog','all').sync.complete,true);
}finally{f.close();}});

test('更新时间增量跨页冻结窗口，失败不推进水位，旧创建日期工单仍能更新',async()=>{const f=fixture();try{
 const water='2026-11-13 08:55:00',from='2026-11-13 08:50:00',to='2026-11-13 09:00:00';
 f.sync.save('catalog','all-head',{watermark:water});f.sync.indexOrder(info(10,'2025-01-01 08:00:00'));
 let fail=true;f.blacklake.queryWorkOrderCatalogPage=async p=>{f.calls.push(p);if(p.pageNum===2&&fail)throw Error('temporary');return {records:[{...info(p.pageNum===1?11:10,'2025-01-01 08:00:00'),updatedAt:'2026-11-13 08:57:00',productName:'更新'}],hasMore:p.pageNum===1};};
 f.sync.request('catalog','all-head',{year:2026,pageNum:1,updatedFrom:from,updatedTo:to});await f.sync.tick();
 assert.equal(f.sync.snapshot('catalog','all-head').data.watermark,water);await f.sync.tick();
 assert.equal(f.sync.snapshot('catalog','all-head').data.watermark,water);
 f.advance(60000);fail=false;await f.sync.tick();
 assert.deepEqual(f.calls.map(x=>[x.pageNum,x.updatedFrom,x.updatedTo]),[[1,from,to],[2,from,to],[2,from,to]]);
 assert.equal(f.sync.snapshot('catalog','all-head').data.watermark,to);
 assert.equal(f.sync.list({projectCode:'WO-10'}).orders[0].productName,'更新');
}finally{f.close();}});

test('目录遗漏、空工序及读取错误不下架；确切不存在才隐藏原工单并保留快照',async()=>{const f=fixture();try{
 f.sync.indexOrder(info(201));const tasks=[{taskId:11,projectId:201,processStatus:10}];f.sync.save('order',201,{info:info(201),tasks});
 f.blacklake.listWorkOrderProcesses=async()=>[];f.blacklake.readWorkOrderPresence=async()=>{throw Object.assign(Error('timeout'),{code:'BLACKLAKE_TIMEOUT'});};
 f.sync.requestOrderRefresh(201);await f.sync.tick();assert.equal(f.sync.list().total,1);assert.deepEqual(f.sync.snapshot('order',201).data.tasks,tasks);
 const bad=f.sync.jobs.byKey('read:order:201');assert.equal(bad.state,'RETRY');f.advance(60000);
 f.blacklake.readWorkOrderPresence=async()=>({present:false,code:'01002021'});await f.sync.tick();
 assert.equal(f.sync.list().total,0);assert.equal(f.store.orderRemoved(201),true);assert.deepEqual(f.sync.snapshot('order',201).data.tasks,tasks);
 assert.throws(()=>f.sync.order(201),{code:'WORK_ORDER_DELETED'});
 f.sync.indexOrder(info(201),{catalog:true});assert.equal(f.sync.list().total,0);
 f.blacklake.readWorkOrderPresence=async()=>({present:true,projectCode:'WO-201'});f.sync.request('order-presence',201,{projectId:201});await f.sync.tick();
 assert.equal(f.store.orderRemoved(201),false);assert.equal(f.sync.list().total,1);
}finally{f.close();}});

test('实际客户端请求独立更新时间范围，拒绝窗口外记录；只有约定的不存在回执可下架',async()=>{
 let body,outside=false,absent=false;
 const client=new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async(url,request)=>{
  body=JSON.parse(request.body);
  if(url.endsWith('/web/detail'))return absent?
   Response.json({code:'01002021',message:'工单不存在'}):Response.json({code:'01000000',data:null});
  return Response.json({code:'01000000',page:{total:1},data:[{id:1,projectCode:'OLD',createdAt:'2022-01-01 09:00:00',updatedAt:outside?'2025-01-01 09:00:00':'2026-11-13 09:00:00'}]});
 });
 const input={year:2026,pageNum:1,updatedFrom:'2026-11-13 08:00:00',updatedTo:'2026-11-13 10:00:00'};
 assert.equal((await client.queryWorkOrderCatalogPage(input)).records[0].projectCode,'OLD');
 assert.deepEqual(body,{updatedAtGte:input.updatedFrom,updatedAtLte:input.updatedTo,page:{pageNum:1,pageSize:100}});
 outside=true;await assert.rejects(client.queryWorkOrderCatalogPage(input),{code:'BLACKLAKE_PROJECT_WINDOW_UNCONFIRMED'});
 await assert.rejects(client.readWorkOrderPresence(1),{code:'BLACKLAKE_ORDER_PRESENCE_UNCONFIRMED'});
 absent=true;assert.deepEqual(await client.readWorkOrderPresence(1),{present:false,code:'01002021'});
});
