import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';

const row=(id,projectId=201,extra={})=>({reportingId:id,projectId,projectCode:projectId===201?'test':'审核test',taskId:11,createdAt:'2026-11-05 23:27:14',productionStaff:'合成员工',numberofgoodProducts:99,numberofDefectives:0,...extra});
function fixture(){const store=new Store(':memory:',{sessionSecret:'order-report-filter-isolated',sessionDays:1}),calls=[],blacklake={},sync=new BlacklakeSync({store,blacklake});return {store,sync,calls,blacklake,close:()=>store.close()};}

for(const totalKnown of [true,false])test('模糊工单报工混页按真实ID同步，过滤后空页仍继续上游分页 totalKnown='+totalKnown,async()=>{const f=fixture();try{
 const pages=[[row(8001),...Array.from({length:99},(_,n)=>row(9000+n,202))],Array.from({length:100},(_,n)=>row(10000+n,202)),[row(459231886)]];
 f.blacklake.queryOutputPage=async(filters,{pageNum,pageSize})=>{f.calls.push({filters,pageNum,pageSize});return {records:pages[pageNum-1],total:totalKnown?201:null};};
 f.sync.orderReports(201,'test');await f.sync.tick();assert.equal(f.sync.jobs.byKey('read:order-reports:201').state,'QUEUED');assert.deepEqual(f.sync.orderReports(201,'test').records.map(r=>r.reportingId),[8001]);
 await f.sync.tick();assert.equal(f.sync.snapshot('order-reports',201).sync.complete,false);assert.equal(f.sync.jobs.byKey('read:order-reports:201').payload.pageNum,3);
 await f.sync.tick();const result=f.sync.orderReports(201,'test');assert.equal(result.sync.complete,true);assert.equal(result.sync.status,'fresh');assert.deepEqual(result.records.map(r=>r.reportingId).sort((a,b)=>a-b),[8001,459231886]);assert.equal(f.sync.jobs.byKey('read:order-reports:201').state,'SUCCEEDED');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM blacklake_output_index WHERE project_id<>201').get().n,0);assert.deepEqual(f.calls.map(c=>c.pageNum),[1,2,3]);assert(f.calls.every(c=>c.filters.projectCode==='test'&&c.pageSize===100));
}finally{f.close();}});

test('同名不同ID不混入，目标ID的工单改名不阻止同步',async()=>{const f=fixture();try{
 f.blacklake.queryOutputPage=async()=>({total:2,records:[row(8001,202,{projectCode:'test'}),row(8002,201,{projectCode:'test-已改名'})]});f.sync.orderReports(201,'test');await f.sync.tick();const result=f.sync.orderReports(201,'test');assert.equal(result.sync.complete,true);assert.deepEqual(result.records.map(r=>r.reportingId),[8002]);
}finally{f.close();}});

test('缺失真实工单ID或目标记录身份不完整仍拒收并保留已有快照',async()=>{for(const invalid of [row(8002,undefined,{projectId:undefined}),row(8002,201,{taskId:null}),row(8002,201,{reportingId:null})]){const f=fixture();try{
 f.blacklake.queryOutputPage=async()=>({total:1,records:[row(8001)]});f.sync.orderReports(201,'test');await f.sync.tick();const old=f.store.db.prepare("SELECT raw_json FROM blacklake_output_index WHERE output_id='8001'").get().raw_json;
 f.blacklake.queryOutputPage=async()=>({total:2,records:[row(8001,201,{numberofgoodProducts:1}),invalid]});f.sync.request('order-reports',201,{projectId:201,projectCode:'test',pageNum:1},true);await f.sync.tick();assert.equal(f.sync.jobs.byKey('read:order-reports:201').error_code,'SYNC_OUTPUT_IDENTITY');assert.equal(f.store.db.prepare("SELECT raw_json FROM blacklake_output_index WHERE output_id='8001'").get().raw_json,old);assert.equal(f.sync.snapshot('order-reports',201).sync.status,'stale');
}finally{f.close();}}});
