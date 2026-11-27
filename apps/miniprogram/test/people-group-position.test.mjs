import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function setup(request=async()=>({})) {
  let page;
  const source=process.env.DISPATCH_PAGE_PATH || new URL('../pages/dispatch/dispatch.js',import.meta.url);
  vm.runInNewContext(readFileSync(source,'utf8'),{Page:p=>page=p,getApp:()=>({globalData:{}}),require:()=>({request}),wx:{vibrateShort(){},showModal(value){throw Error(value.content);}},clearInterval,clearTimeout});
  page.setData=values=>Object.assign(page.data,values);
  page.data.overviewLoaded=true;
  page.data.employees=[
    {blacklakeOperatorId:1,name:'甲',available:true,departments:['乙组']},
    {blacklakeOperatorId:2,name:'乙',available:false,canQueue:true,departments:['甲组']},
    {blacklakeOperatorId:3,name:'丙',available:false,departments:['甲组']}
  ];
  return page;
}
const config=(allPosition=1)=>({revision:1,allPosition,groups:[{id:'a',name:'甲组'},{id:'empty',name:'空组'},{id:'b',name:'乙组'}]});
const labels=p=>Array.from(p.data.peopleGroups,g=>g.label);
const ids=p=>Array.from(p.data.groupEmployees,e=>e.blacklakeOperatorId);
const choose=(p,index)=>p.choosePeopleGroup({currentTarget:{dataset:{groupIndex:index}}});

test('读取服务端顺序和全部首中末位置；空分类保留，成员分组不受数组首位影响',()=>{
  for(const position of [0,1,3]) {
    const page=setup();page.data.peopleGroupConfig=config(position);page.updateEmployeeView();
    const expected=['甲组','空组','乙组'];expected.splice(position,0,'全部');assert.deepEqual(labels(page),expected);
    assert.equal(page.data.departmentIndex,0);assert.deepEqual(ids(page),position===0?[1,2,3]:[2,3]);
    assert.equal(page.data.selectedEmployeeIds.length,0);
    choose(page,labels(page).indexOf('甲组'));assert.deepEqual(ids(page),[2,3]);
    page.selectGroupAvailable();assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[2]);
    choose(page,labels(page).indexOf('空组'));assert.equal(page.data.peopleGroupTotal,0);
    choose(page,position);assert.deepEqual(ids(page),[1,2,3]);
  }
});
test('轮询重排与改名保持当前分类身份、已选人员和搜索，不误切到相同索引的另一组',()=>{
  const page=setup();page.data.peopleGroupConfig=config();page.updateEmployeeView();choose(page,0);
  page.setEmployeeSelection([2]);page.data.employeeQuery='乙';
  page.data.peopleGroupConfig={revision:2,allPosition:2,groups:[{id:'b',name:'乙组'},{id:'empty',name:'空组'},{id:'a',name:'新甲组'}]};
  page.data.employees=page.data.employees.map(e=>({...e,departments:e.departments.map(name=>name==='甲组'?'新甲组':name)}));
  page.updateEmployeeView();assert.equal(page.data.departmentIndex,3);assert.equal(page.data.peopleGroupName,'新甲组');
  assert.deepEqual(ids(page),[2]);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[2]);assert.equal(page.data.employeeQuery,'乙');
});
test('删除当前分类回到全部的新位置，不恢复上游已删分类；配置全空也能查看全部',()=>{
  const page=setup();page.data.peopleGroupConfig=config();page.updateEmployeeView();choose(page,0);
  page.data.peopleGroupConfig={revision:3,allPosition:1,groups:[{id:'b',name:'乙组'}]};page.updateEmployeeView();
  assert.deepEqual(labels(page),['乙组','全部']);assert.equal(page.data.selectedPeopleGroupId,'@all');assert.deepEqual(ids(page),[1,2,3]);
  page.data.peopleGroupConfig={revision:4,allPosition:0,groups:[]};page.updateEmployeeView();assert.deepEqual(labels(page),['全部']);assert.deepEqual(ids(page),[1,2,3]);
});
test('旧接口无配置时兼容人员分类，保留空departments而不从描述复活已删分类',()=>{
  const page=setup();page.data.employees.push({blacklakeOperatorId:4,name:'丁',available:true,departments:[],description:'已删旧组'});page.updateEmployeeView();
  assert.deepEqual(labels(page),['全部','乙组','甲组']);choose(page,2);assert.deepEqual(ids(page),[2,3]);
});
test('overview刷新取得新位置，失败保留上次配置、所选人员和筛选',async()=>{
  let fail=false;
  const page=setup(async path=>{assert.equal(path,'/v1/dispatch/overview');if(fail)throw Error('临时网络错误');return{units:[],employees:page.data.employees,peopleGroupConfig:config(3)};});
  await page.fetchOverview();assert.deepEqual(labels(page),['甲组','空组','乙组','全部']);assert.equal(page.data.departmentIndex,0);
  choose(page,0);page.setEmployeeSelection([2]);fail=true;await page.fetchOverview();
  assert.equal(page.data.departmentIndex,0);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[2]);assert.equal(page.data.peopleGroupConfig.allPosition,3);assert.match(page.data.overviewError,/网络/);
});

test('新工单进入选人重置到第一个分类，刷新保留手动选择，默认空组不擅自跳走或勾人',async()=>{
 const page=setup(async path=>path==='/v1/dispatch/overview'?{employees:page.data.employees,units:[],peopleGroupConfig:page.data.peopleGroupConfig}:{workOrder:{projectId:201,projectCode:'TEST'},processes:[]});page.data.peopleGroupConfig=config(1);page.updateEmployeeView();choose(page,3);
 assert.equal(page.data.selectedPeopleGroupId,'b');await page.loadWorkOrder('projectId=201');assert.equal(page.data.departmentIndex,0);assert.equal(page.data.selectedPeopleGroupId,'a');assert.equal(page.data.selectedEmployeeIds.length,0);
 choose(page,2);page.updateEmployeeView();assert.equal(page.data.selectedPeopleGroupId,'empty');assert.equal(page.data.peopleGroupTotal,0);
 page.data.peopleGroupConfig={allPosition:1,groups:[{id:'empty',name:'空组'},{id:'b',name:'乙组'}]};await page.loadWorkOrder('projectId=202');assert.equal(page.data.departmentIndex,0);assert.equal(page.data.selectedPeopleGroupId,'empty');assert.equal(page.data.peopleGroupTotal,0);
});

test('名单尚未返回时的全部占位不锁定默认分类，首个真实结果仍选第一项',()=>{
 const page=setup();page.data.overviewLoaded=false;page.data.employees=[];page.updateEmployeeView();assert.equal(page.data.selectedPeopleGroupId,'');
 page.data.peopleGroupConfig=config(1);page.data.overviewLoaded=true;page.updateEmployeeView();assert.equal(page.data.departmentIndex,0);assert.equal(page.data.selectedPeopleGroupId,'a');
});
