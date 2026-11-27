import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BlacklakeSync} from '../src/blacklake-sync.mjs';

function fixture(){
 const store=new Store(':memory:',{sessionSecret:'local-read-isolation',sessionDays:1});
 const now=()=>Date.parse('2026-11-17T09:00:00Z'),blacklake={};
 const sync=new BlacklakeSync({store,blacklake,now});
 sync.indexOrder({projectId:201,projectCode:'WO-201',productName:'合成产品'});
 sync.save('order',201,{info:{projectId:201,projectCode:'WO-201'},tasks:[]});
 return {store,sync,blacklake,now};
}

test('读取目录和工单列表不在HTTP路径执行后台调度或低频历史核对',()=>{
 const f=fixture();try{
  let scheduled=0;f.sync.ensureScheduled=()=>scheduled++;
  assert.equal(f.sync.list().orders.length,1);
  assert.equal(f.sync.catalog().length,1);
  assert.equal(scheduled,0);
 }finally{f.store.close();}
});

test('已有完整报工编辑资料过期后仍只读本地，提交前核对由写队列负责',()=>{
 const f=fixture();try{
  const value={id:'301',projectId:201};
  f.store.db.prepare('INSERT INTO blacklake_output_index(output_id,project_id,raw_json,correction_json,correction_at,updated_at) VALUES(?,?,?,?,?,?)').run('301',201,'{}',JSON.stringify(value),f.now()-3600000,f.now());
  assert.deepEqual(f.sync.outputEditor('301'),value);
  assert.equal(f.sync.jobs.byKey('read:output:301'),null);
  assert.throws(()=>f.sync.outputEditor('302'),e=>e.code==='BLACKLAKE_DATA_SYNCING');
  assert.equal(f.sync.jobs.byKey('read:output:302').state,'QUEUED');
 }finally{f.store.close();}
});

for(const section of ['materials','history'])test('后台同步'+section+'沿用完整读取器时钟并成功持久化，避免五次失败停车',async()=>{
 const f=fixture();try{
  f.blacklake.nativeRequest=async()=>section==='materials'?{data:{project:{id:201},productionMaterialsList:[]}}:{data:{list:[],total:0}};
  f.sync.request(section,'201:1',{projectId:201,pageNum:1});
  await f.sync.tick();
  const job=f.sync.jobs.byKey('read:'+section+':201:1');
  assert.equal(job.state,'SUCCEEDED',JSON.stringify({state:job.state,error:job.error_code}));
  assert.equal(f.sync.snapshot(section,'201:1').sync.complete,true);
  assert.equal(f.sync.snapshot(section,'201:1').data.fetchedAt,new Date(f.now()).toISOString());
 }finally{f.store.close();}
});
