import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function setup(workOrders){let page;const previews=[],toasts=[];
  vm.runInNewContext(readFileSync(new URL('../pages/report/report.js',import.meta.url),'utf8'),{
    Page:p=>page=p,getApp:()=>({globalData:{}}),require:p=>p.endsWith('work-time')?{}:{request:async()=>({workOrders})},
    wx:{previewImage:v=>previews.push(v),showToast:v=>toasts.push(v)},Date
  });
  page.setData=v=>Object.assign(page.data,v);page.data.cuttingSelfService=true;
  return {page,previews,toasts};
}
const event=(projectId,imageUrl)=>({currentTarget:{dataset:{projectId,imageUrl}}});

test('员工SKU结果图片可单独预览，同SKU多工单不串图，缺图兼容旧接口',async()=>{
  const {page,previews}=setup([{projectId:1,productImageUrls:['https://example.test/a.png']},{projectId:2,productImageUrls:['https://example.test/b.png']},{projectId:3}]);
  page.data.skuQuery='SKU';await page.searchSkuWorkOrders();
  page.previewSkuImage(event(2,'https://example.test/b.png'));
  assert.equal(previews.length,1);assert.equal(previews[0].current,'https://example.test/b.png');assert.equal(previews[0].urls.length,1);
  assert.equal(page.data.stage,'waiting');assert.equal(page.data.flowCode,'');
  assert.equal(page.data.skuResults[2].productImageUrls.length,0);
  page.previewSkuImage(event(1,'https://example.test/b.png'));assert.equal(previews.length,1);
});

test('图片失败只改变对应结果，迟到的旧图片事件不污染新查询，重查可恢复',async()=>{
  const rows=[{projectId:1,productImageUrls:['https://example.test/a.png']},{projectId:2,productImageUrls:['https://example.test/b.png']}];
  const {page,previews,toasts}=setup(rows);page.data.skuQuery='SKU';await page.searchSkuWorkOrders();
  page.onSkuImageError(event(1,'https://example.test/old.png'));assert.equal(page.data.skuResults[0].imageFailed,false);
  page.onSkuImageError(event(1,'https://example.test/a.png'));assert.equal(page.data.skuResults[0].imageFailed,true);assert.equal(page.data.skuResults[1].imageFailed,false);
  page.previewSkuImage(event(1,'https://example.test/a.png'));assert.equal(previews.length,0);
  await page.searchSkuWorkOrders();assert.equal(page.data.skuResults[0].imageFailed,false);
  page.previewSkuImage(event(1,'https://example.test/a.png'));previews[0].fail();assert.equal(toasts.length,1);
  page.onSkuInput({detail:{value:'NEW'}});page.onSkuImageError(event(1,'https://example.test/a.png'));assert.equal(page.data.skuResults.length,0);
});
