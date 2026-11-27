import test from 'node:test';
import assert from 'node:assert/strict';
import {BlacklakeClient} from '../src/blacklake-client.mjs';
const client=response=>new BlacklakeClient({mode:'live',baseUrl:'https://fixture.invalid',staticToken:'synthetic',timeoutMs:1000},async()=>new Response(JSON.stringify(response)));
test('真实报工增量空区间以null及明确零总数表示，没有新增时正常完成',async()=>{
 assert.deepEqual(await client({code:'01000000',data:null,page:{pageNum:1,pageSize:100,total:0,data:null}}).queryOutputPage(),{records:[],total:0,pageNum:1,pageSize:100});
});
test('读取顶层page.total，未知或矛盾的null回执仍拒绝而不伪造空记录',async()=>{
 const page=await client({code:'01000000',data:[{id:1}],page:{total:101}}).queryOutputPage();assert.equal(page.total,101);assert.equal(page.records.length,1);
 for(const response of [{code:'01000000',data:null},{code:'01000000',data:null,page:{total:1}},{code:'01000000',data:[{id:1}],page:{total:0}}])await assert.rejects(client(response).queryOutputPage(),{code:'BLACKLAKE_OUTPUT_PAGE_FORMAT'});
});
