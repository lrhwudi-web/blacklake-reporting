import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function load(name,dependencies){
 const module={exports:{}};
 runInNewContext(readFileSync(new URL('../workspace/utils/'+name+'.js',import.meta.url),'utf8'),{module,require:id=>dependencies[id]});
 return module.exports;
}
const dates=load('task-overview',{'./detail-model':{}});
const {recordView}=load('worker-model',{'./detail-model':{amount:String},'./task-overview':dates,'./task-product':{}});

test('员工报工昨天按北京时间跨月筛选，工时和件数使用同一范围',()=>{
 const records=[
  {id:'yesterday',createdAt:'2026-10-31T15:58:00Z',reportedSeconds:600,goodQuantity:12,defectiveQuantity:3},
  {id:'today',createdAt:'2026-10-31T16:05:00Z',reportedSeconds:1200,goodQuantity:20,defectiveQuantity:1}
 ];
 const result=recordView(records,{mode:'yesterday',today:'2026-11-01'});
 assert.deepEqual(result.visibleRecords.map(row=>row.id),['yesterday']);
 assert.equal(result.recordDateLabel,'昨天');
 assert.equal(result.recordRangeText,'2026-10-31');
 assert.equal(result.recordTotalText,'10分');
 assert.equal(result.recordQuantityText,'15件');
 assert.deepEqual(recordView(records,{mode:'month',today:'2026-11-01'}).visibleRecords.map(row=>row.id),['today']);
});

test('我的报工只有四个日期选项，自选范围应用前保留当前日期',()=>{
 let page;
 const pass=page=>page;
 runInNewContext(readFileSync(new URL('../workspace/pages/worker/worker.js',import.meta.url),'utf8'),{
  Page:value=>{page=value;},
  require:id=>id.endsWith('/layer-back')?{page:pass}:id.endsWith('/live-workspace')?{wrap:pass}:
   id.endsWith('/task-overview')?dates:{data:{},methods:{}}
 });
 page.setData=(values,ready)=>{Object.assign(page.data,values);ready?.();};
 page.updateWorkerRecords=()=>{};
 page.measureWorkerRecordFilter=()=>{};
 assert.equal(JSON.stringify(page.data.recordDateOptions.map(row=>row.label)),JSON.stringify(['今天','昨天','本月','自选日期']));
 Object.assign(page.data,{workerPanel:{kind:'records'},recordToday:'2026-11-20'});
 page.toggleWorkerRecordFilter();
 assert.equal(page.data.recordDateCustom,false);
 const select=mode=>page.chooseWorkerRecordDate({currentTarget:{dataset:{mode}}});
 select('custom');
 assert.equal(page.data.recordDateCustom,true);
 assert.equal(page.data.recordDateMode,'today');
 const date=(field,value)=>page.onWorkerRecordDate({currentTarget:{dataset:{field}},detail:{value}});
 date('end','2026-11-21');
 page.applyWorkerRecordDates();
 assert.match(page.data.recordDateError,/晚于今天/);
 assert.equal(page.data.recordDateMode,'today');
 date('start','2026-11-17');
 date('end','2026-11-19');
 page.applyWorkerRecordDates();
 assert.equal(page.data.recordDateMode,'custom');
 assert.equal(page.data.recordDateStart,'2026-11-17');
 assert.equal(page.data.recordDateEnd,'2026-11-19');
 assert.equal(page.data.recordFilterOpen,false);
});
