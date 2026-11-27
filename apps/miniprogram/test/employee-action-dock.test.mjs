import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';
function fixture(){let page;vm.runInNewContext(readFileSync(process.env.REPORT_PAGE_PATH||new URL('../pages/report/report.js',import.meta.url),'utf8'),{Page:p=>page=p,getApp:()=>({globalData:{}}),require:()=>({}),wx:{},clearInterval,Date});page.setData=v=>Object.assign(page.data,v);page.saveReportDraft=()=>{};return page;}
test('数量键盘抬起操作条，失焦后的迟到键盘高度不重新遮挡页面，编辑值与不良选择保留',()=>{
 const page=fixture();Object.assign(page.data,{stage:'finish',reportQuantity:'18',reportDefectQuantity:'2',reportDefectCodes:['BL202504030001']});
 page.onReportInputFocus({detail:{height:280}});assert.equal(page.data.reportKeyboardHeight,280);
 page.onReportKeyboardHeightChange({detail:{height:320}});assert.equal(page.data.reportKeyboardHeight,320);
 page.onReportInputBlur();page.onReportKeyboardHeightChange({detail:{height:320}});assert.equal(page.data.reportKeyboardHeight,0);
 page.onReportInputFocus({detail:{}});for(const height of [-1,'invalid',undefined])page.onReportKeyboardHeightChange({detail:{height}});assert.equal(page.data.reportKeyboardHeight,0);
 assert.equal(page.data.reportQuantity,'18');assert.deepEqual(Array.from(page.data.reportDefectCodes),['BL202504030001']);
});
test('隐藏或返回计时清除键盘避让，不改变工单、填报数量和未提交数据',()=>{
 const page=fixture();Object.assign(page.data,{assignment:{id:'test',status:'IN_PROGRESS'},reportQuantity:'18',reportDefectQuantity:'2',reportKeyboardHeight:320,reportInputFocused:true});
 page.backToWork();assert.equal(page.data.stage,'working');assert.equal(page.data.reportKeyboardHeight,0);assert.equal(page.data.reportQuantity,'18');
 page.onReportInputFocus({detail:{height:300}});page.onHide();page.onReportKeyboardHeightChange({detail:{height:300}});
 assert.equal(page.data.reportKeyboardHeight,0);assert.equal(page.data.reportInputFocused,false);assert.equal(page.data.assignment.id,'test');assert.equal(page.data.reportDefectQuantity,'2');
});
