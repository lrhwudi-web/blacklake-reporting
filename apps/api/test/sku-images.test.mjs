import test from 'node:test';
import assert from 'node:assert/strict';
import {BlacklakeClient} from '../src/blacklake-client.mjs';

test('SKU 图片来自该工单的图片字段，保持多工单对应关系和缓存',async()=>{
  const client=new BlacklakeClient({mode:'live'});let calls=0;
  const picture=value=>({name:'图片',customFieldMetadata:{type:11},value});
  client.request=async(_path,input)=>{calls++;return {data:input.projectCode===String(new Date().getFullYear())?[
    {id:1,projectCode:'WO-1',productCode:'SKU-1',customFieldValues:[picture('https://images.example.test/a.png'),picture('https://images.example.test/a.png'),{name:'内部附件',value:'https://images.example.test/private.pdf'}]},
    {id:2,projectCode:'WO-2',productCode:'SKU-1',customFieldValues:[picture('https://images.example.test/b.png')]},
    {id:3,projectCode:'WO-3',productCode:'SKU-1',customFieldValues:null}
  ]:[]};};
  const rows=await client.searchWorkOrdersBySku(' sku-1 ');
  assert.deepEqual(rows.find(r=>r.projectId===1).productImageUrls,['https://images.example.test/a.png']);
  assert.deepEqual(rows.find(r=>r.projectId===2).productImageUrls,['https://images.example.test/b.png']);
  assert.deepEqual(rows.find(r=>r.projectId===3).productImageUrls,[]);
  await client.searchWorkOrdersBySku('SKU-1');assert.equal(calls,2);
});

test('图片空值、错误字段类型、非HTTPS和带凭据地址不影响SKU数据查询',async()=>{
  const client=new BlacklakeClient({mode:'live'});
  client.request=async(_path,input)=>({data:input.projectCode===String(new Date().getFullYear())?[
    {id:1,projectCode:'WO-1',productCode:'SKU',qrCode:'https://images.example.test/qr.png',customFieldValues:[
      ...['','bad url','http://images.example.test/a.png','javascript:alert(1)','https://u:p@images.example.test/a.png',null,{}].map(value=>({name:'图片',customFieldMetadata:{type:11},value})),
      {name:'图片',customFieldMetadata:{type:1},value:'https://images.example.test/not-image'},
      {customFieldMetadata:{name:'图片',type:11},value:' https://images.example.test/valid.png '}
    ]}
  ]:[]});
  const [row]=await client.searchWorkOrdersBySku('SKU');
  assert.deepEqual(row.productImageUrls,['https://images.example.test/valid.png']);
});
