import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';
import {nativeFixture} from './native-report-fixture.mjs';

function fixture(){let at=Date.parse('2026-11-16T12:00:00+08:00');const store=new Store(':memory:',{sessionSecret:'fair-sync-isolated',sessionDays:1}),calls=[],blacklake={},sync=new BlacklakeSync({store,blacklake,now:()=>at,refreshPolicy:{order:300000,'order-reports':300000}});return {store,sync,blacklake,calls,advance:ms=>at+=ms,close:()=>store.close()};}
const output={reportingId:461742918,projectId:201,taskId:11,numberofgoodProducts:42,numberofDefectives:0,createdAt:'2026-11-14 14:43:39'};
function index(f,row=output,deleted=0){f.store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,task_id,raw_json,deleted,updated_at) VALUES(?,?,?,?,?,?)').run(String(row.reportingId),row.projectId,row.taskId,JSON.stringify(row),deleted,Date.now());}

test('6018464模式：旧空快照不挡住后来增量索引的42件；删除标记及其他工单仍隔离',()=>{const f=fixture();try{
 f.sync.save('order-reports',201,{ids:[],pageNum:1});f.advance(400000);index(f);index(f,{...output,reportingId:2},1);index(f,{...output,reportingId:3,projectId:202});
 const result=f.sync.orderReports(201,'2026/11/12-客订大货01');assert.deepEqual(result.records.map(r=>r.reportingId),[461742918]);assert.equal(result.records[0].numberofgoodProducts,42);assert.equal(result.sync.pending,false,'完整旧快照不因访问而重查，后台统一增量');
}finally{f.close();}});

test('100个后台任务排队时当前工序读取有机会，60人共用一任务且不重置进度',async()=>{const f=fixture();try{
 for(let id=1000;id<1100;id++)f.sync.request('order',id,{projectId:id});
 for(let n=0;n<60;n++)f.sync.orderReports(201,'VIEW');f.blacklake.queryOutputPage=async()=>{f.calls.push('visible');return {records:[output],total:1};};
 f.blacklake.listWorkOrderProcesses=async()=>{f.calls.push('background');return [];};
 for(let n=0;n<5&&!f.calls.includes('visible');n++)await f.sync.tick();assert(f.calls.includes('visible'),JSON.stringify(f.calls));assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE job_key='read:order-reports:201'").get().n,1);assert.equal(f.sync.orderReports(201,'VIEW').records[0].numberofgoodProducts,42);
}finally{f.close();}});

test('持续报工和当前页读取不会饿死后台；前台离开后需求租期过期',async()=>{const f=fixture();try{
 f.sync.request('custom','background',{});f.sync.handlers.set('custom',async job=>{f.calls.push(job.target);return {};});f.sync.writeHandler=async()=>{f.calls.push('write');return {};};
 for(let n=0;n<20;n++){f.sync.jobs.enqueue({key:'w'+n,mode:'write',kind:'test-write',target:String(n)});f.sync.read('custom','view'+n,{});}
 for(let n=0;n<10;n++)await f.sync.tick();assert(f.calls.includes('write'));assert(f.calls.some(x=>x.startsWith('view')));assert(f.calls.includes('background'),JSON.stringify(f.calls));
 f.advance(60000);assert.equal(f.sync.jobs.demandState(f.sync.jobs.byKey('read:custom:view19').id).active,false);
}finally{f.close();}});

test('工序一步成功先可读；后续详情受限/重启租约恢复从下一步续传，不重查工序',async()=>{const f=fixture();try{
 f.sync.indexOrder({projectId:201,projectCode:'VIEW',productName:'合成产品',projectStatus:10});
 f.blacklake.listWorkOrderProcesses=async()=>{f.calls.push('tasks');return [{taskId:11,projectId:201,projectCode:'VIEW',processStatus:10}];};let limited=true;f.blacklake.readWorkOrderDetails=async()=>{f.calls.push('info');if(limited)throw Object.assign(Error('budget'),{code:'BLACKLAKE_REQUEST_DEFERRED',retryAfterMs:1000});return {projectId:201,projectCode:'VIEW',projectStatus:10};};
 f.sync.order(201);await f.sync.tick();assert.equal(f.sync.order(201).processes.length,1);assert.equal(f.sync.snapshot('order',201).sync.complete,false);
 await f.sync.tick();assert.equal(f.sync.jobs.byKey('read:order:201').state,'QUEUED');f.advance(2000);limited=false;
 // Rebuild the service against the same durable store, as after restart.
 const resumed=new BlacklakeSync({store:f.store,blacklake:f.blacklake,now:()=>Date.parse('2026-11-16T12:01:00+08:00')});await resumed.tick();assert.equal(resumed.snapshot('order',201).sync.complete,true);assert.equal(f.calls.filter(c=>c==='tasks').length,1);assert.equal(f.calls.filter(c=>c==='info').length,2);
}finally{f.close();}});

test('访问过期资料不增加刷新；旧闲置刷新可退场，关联报工强制刷新和FAILED保留',()=>{const f=fixture();try{
 for(const id of [201,202,203]){f.sync.indexOrder({projectId:id,projectCode:'WO'+id,projectStatus:10});f.sync.save('order',id,{info:{projectId:id,projectCode:'WO'+id,projectStatus:10},tasks:[]});f.sync.request('order',id,{projectId:id});}
 const failed=f.sync.jobs.byKey('read:order:203');f.store.db.prepare("UPDATE integration_jobs SET state='FAILED',error_code='BROKEN' WHERE id=?").run(failed.id);f.advance(1000000);f.sync.invalidateOrder(202);assert.equal(f.sync.pruneObsoleteReads(),1);assert.equal(f.sync.jobs.byKey('read:order:201').state,'CANCELLED');assert.equal(f.sync.jobs.byKey('read:order:202').state,'QUEUED');assert.equal(f.sync.jobs.get(failed.id).state,'FAILED');
 for(let n=0;n<60;n++)f.sync.order(201);assert.equal(f.sync.jobs.byKey('read:order:201').state,'CANCELLED');
}finally{f.close();}});

test('没有增量合同的旧资料核对最多每分钟安排一张，不由访问人数驱动',()=>{const f=fixture();try{
 f.sync.save('catalog','all',{});f.sync.save('catalog','all-head',{});f.sync.save('catalog','all-delta',{});f.sync.save('people','all',[]);f.sync.historyDays=0;f.sync.save('history-day','2026-11-16',{watermark:'2026-11-16 23:59:59'});
 for(let id=1;id<=100;id++){f.sync.indexOrder({projectId:id,projectCode:'W'+id});f.sync.save('order',id,{info:{projectId:id,projectCode:'W'+id},tasks:[]});}
 f.advance(7*3600000);for(let n=0;n<60;n++)f.sync.ensureScheduled();assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE json_extract(payload_json,'$.reason')='audit'").get().n,1);
}finally{f.close();}});

test('完整报工资料的原生步骤限速后，续传不重复已完成的OpenAPI读取',async()=>{const f=fixture();try{
 const driver=nativeFixture(),native=driver.client.nativeRequest.bind(driver.client);let limited=true;driver.client.nativeRequest=async(path,...args)=>{if(limited&&path.endsWith('/web/detail'))throw Object.assign(Error('budget'),{code:'BLACKLAKE_REQUEST_DEFERRED',retryAfterMs:1000});return native(path,...args);};f.sync.blacklake=driver.client;
 f.sync.request('output','1001',{outputId:'1001'});await f.sync.tick();assert.equal(f.sync.jobs.byKey('read:output:1001').state,'QUEUED');assert.equal(driver.calls.filter(c=>c.url.endsWith('/query')).length,1);f.advance(2000);limited=false;await f.sync.tick();assert.equal(f.sync.jobs.byKey('read:output:1001').state,'SUCCEEDED');assert.equal(driver.calls.filter(c=>c.url.endsWith('/query')).length,1);
}finally{f.close();}});

test('全单搜索漏掉记录不直接删；精确编号确认不存在才保留墓碑，较新增量仍获胜',async()=>{const f=fixture();try{
 index(f);f.store.db.prepare('UPDATE blacklake_output_index SET updated_at=0').run();f.sync.save('order-reports',201,{ids:['461742918']});f.blacklake.queryOutputPage=async()=>({records:[],total:0});f.sync.request('order-reports',201,{projectId:201,projectCode:'VIEW',pageNum:1});await f.sync.tick();assert.equal(f.sync.orderReports(201,'VIEW').records.length,1);
 f.blacklake.readOutputForCorrection=async()=>{throw Object.assign(Error('absence'),{definiteAbsence:true});};await f.sync.tick();assert.equal(f.store.db.prepare('SELECT deleted FROM blacklake_output_index').get().deleted,1);assert.equal(f.sync.orderReports(201,'VIEW').records.length,0);
}finally{f.close();}});

test('分页成功后回到同一读取通道队尾，不能用一张大工单占满所有前台机会',async()=>{const f=fixture();try{
 const seen=[];f.blacklake.queryOutputPage=async({projectCode},{pageNum})=>{seen.push([projectCode,pageNum]);return projectCode==='BIG'?{records:Array.from({length:100},(_,n)=>({...output,reportingId:10000+n,projectId:201})),total:300}:{records:[],total:0};};
 f.sync.orderReports(201,'BIG');f.sync.orderReports(202,'SMALL');await f.sync.tick();await f.sync.tick();assert.deepEqual(seen,[['BIG',1],['SMALL',1]]);assert.equal(f.sync.jobs.byKey('read:order-reports:201').payload.pageNum,2);
}finally{f.close();}});
