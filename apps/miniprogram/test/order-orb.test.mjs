import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const modelModule={exports:{}};new Function('module',readFileSync(new URL('../components/order-orb/model.js',import.meta.url),'utf8'))(modelModule);
const g=modelModule.exports,source=readFileSync(new URL('../components/order-orb/index.js',import.meta.url),'utf8'),dragSource=readFileSync(new URL('../components/order-orb/drag.wxs',import.meta.url),'utf8');
const orbWxml=readFileSync(new URL('../components/order-orb/index.wxml',import.meta.url),'utf8');
function gestureFixture(){
 const f=fixture(),c=f.component,mod={exports:{}},state={};c.measure();vm.runInNewContext(dragSource,{module:mod});
 const instance={getDataset:()=>({...c.data.position,minX:c.data.box.minX,maxX:c.data.box.maxX,minY:c.data.box.minY,maxY:c.data.box.maxY,locked:c.data.modalActive}),setStyle(){}},owner={getState:()=>state,selectComponent:()=>instance,callMethod:(name,args)=>c[name](args)};
 const button=orbWxml.match(/<view class="order-orb-button[\s\S]*?>/)[0];
 function fire(type,event={}){const match=button.match(new RegExp('(?:bind|catch)'+type+'="([^"]+)"'));if(!match)return;const wxs=match[1].match(/^\{\{drag\.(\w+)\}\}$/);return wxs?mod.exports[wxs[1]](event,owner):c[match[1]](event);}
 return{...f,fire,state};
}
function fixture(request=async()=>({workOrder:{projectId:201,projectCode:'TEST-201'},processOverview:[]})){
 let definition;const storage=new Map(),events=[],timers=new Map();let tick=0;
 const wx={getWindowInfo:()=>({windowWidth:390,windowHeight:844}),getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),vibrateShort(){},previewImage(){},showToast(){}};
 vm.runInNewContext(source,{Component:d=>definition=d,require:path=>path==='./model'?g:{request},wx,setTimeout:fn=>{timers.set(++tick,fn);return tick;},clearTimeout:id=>timers.delete(id)});
 const component={...definition.methods,properties:{visible:true,ownerKey:'operator:101',scope:'https://factory.test',flowCode:'projectId=201',workOrder:{projectId:201,projectCode:'TEST-201'},processes:[]},data:structuredClone(definition.data),triggerEvent:(name,value)=>events.push({name,value}),setData(update){Object.assign(this.data,update);},orbAttached:true};
 return{component,definition,storage,events,wx,flush(){for(const[id,fn]of [...timers]){timers.delete(id);fn();}}};
}
test('位置按来源与稳定组长身份隔离，缺失/坏数据安全回默认；换窗口按比例恢复且不越界',()=>{
 const a=g.bounds(390,844,203,710),b=g.bounds(320,504,203,374),stored=g.remember({x:200,y:400},a);
 const p=g.restore(stored,b);assert(p.x>=8&&p.x<=b.maxX&&p.y>=Math.min(b.minY,b.maxY)&&p.y<=b.maxY);
 assert.notEqual(g.storageKey('factory','operator:1'),g.storageKey('factory','operator:2'));assert.notEqual(g.storageKey('factory','operator:1'),g.storageKey('other','operator:1'));assert.equal(g.storageKey('factory',0),'');
 for(const value of [null,{version:1,x:NaN,y:0},{version:2,x:0,y:0},{version:1,x:-1,y:2},{version:1,x:'1',y:0}])assert.deepEqual(g.restore(value,a),{x:12,y:a.maxY});
 for(const [w,h]of[[320,420],[320,640],[390,844],[430,932]])for(const point of[{x:8,y:212},{x:w-60,y:h-204}]){const box=g.bounds(w,h),p=g.panel(g.point(point,box),box);assert(p.x>=0&&p.y>=0&&p.x+p.width<=w&&p.y+p.height<=h);}
});
test('浮窗只映射同单字段，工单零与未确认不同，闭单不倒计时；各工序不相加',()=>{
 const m=g.model({workOrder:{projectStatus:'10',planEndTime:'2026-11-12 23:59:59',plannedAmount:150,actualAmount:0,unit:'个'},processOverview:[{reportedGoodAmount:200,percentLabel:'133.3%'}],source:{asOf:'2026-11-05T07:19:00.000Z'}},{},Date.parse('2026-11-05T07:19:00Z'));
 assert.equal(m.progressLabel,'0 / 150个');assert.equal(m.dueLabel,'剩 7 天');assert.equal(m.updatedLabel,'15:19');assert.equal(g.model().progressLabel,'未确认 / 未确认');assert.equal(g.model({workOrder:{projectStatus:'20',planEndTime:'2020-01-01'}}).dueLabel,'');assert.equal(g.model({workOrder:{planEndTime:'2026-02-31'}}).dueLabel,'');
 assert.equal(g.model({workOrder:{projectStatus:'10',planEndTime:'2026-12-11 00:00:00'}},{},Date.parse('2026-11-05T07:19:00Z')).dueLabel,'剩 35 天');
});
test('打开关闭可连续反向，过期关闭回调不消失；进入工序隐藏后不恢复打开态',()=>{
 const f=fixture(),c=f.component;c.measure();c.toggle();assert.equal(c.data.expanded,true);c.close();c.toggle();f.flush();assert.equal(c.data.expanded,true);assert.equal(c.data.modalActive,true);
 c.properties.visible=false;f.definition.observers['visible,ownerKey,scope,flowCode'].call(c,false);assert.equal(c.data.modalActive,false);assert.equal(c.data.expanded,false);
});
test('长按落点保存仅属于该组长，松手不误打开；重进/切换身份恢复各自位置',()=>{
 const f=fixture(),c=f.component;c.measure();c.onOrbDragStart();c.onOrbDragEnd({x:220,y:400});c.toggle();assert.equal(c.data.expanded,false);const saved={...c.data.position};f.flush();
 c.properties.ownerKey='operator:102';c.measure();assert.equal(c.data.position.x,12);c.onOrbDragStart();c.onOrbDragEnd({x:50,y:300});f.flush();c.properties.ownerKey='operator:101';c.measure();assert.equal(c.data.position.x,saved.x);assert.equal(c.data.position.y,saved.y);assert.equal(f.storage.size,2);
});
test('切工单/切身份/隐藏/卸载后迟到资料不污染新单，不把404当作派工失败',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r)),c=f.component;const pending=c.loadDetails();c.properties.workOrder={projectId:202,projectCode:'TEST-202'};c.properties.flowCode='projectId=202';c.resetInteraction();resolve({workOrder:{projectId:201,projectCode:'TEST-201',productName:'旧单'}});await pending;assert.notEqual(c.data.detail.productName,'旧单');
 const unavailable=fixture(async()=>{throw Object.assign(Error('missing'),{status:404});});await unavailable.component.loadDetails();assert.match(unavailable.component.data.error,/可继续选人/);assert.equal(unavailable.component.data.loading,false);
});
test('工单ID不一致被拒绝，不把错误资料和旧图片混入当前详情',async()=>{
 const f=fixture(async()=>({workOrder:{projectId:202,projectCode:'TEST-201',productImageUrls:['https://wrong.test/image.png']}}));await f.component.loadDetails();assert.match(f.component.data.error,/不一致/);assert.equal(f.component.data.detail.imageUrl,'');
});
test('WXS长按后在视图层直接跟手，拖动边界和取消恢复；短按移动不误开',()=>{
 const mod={exports:{}};vm.runInNewContext(dragSource,{module:mod});const drag=mod.exports,state={},calls=[],styles=[];
 const instance={getDataset:()=>({x:12,y:400,minX:8,maxX:330,minY:210,maxY:650}),setStyle:s=>styles.push(s)},owner={getState:()=>state,selectComponent:()=>instance,callMethod:(name,args)=>calls.push({name,args})};
 drag.start({touches:[{pageX:20,pageY:410}]},owner);drag.hold({},owner);drag.move({touches:[{pageX:900,pageY:-30}]},owner);assert.match(styles.at(-1).transform,/330px,210px/);drag.end({},owner);assert.equal(calls.at(-1).name,'onOrbDragEnd');
 drag.start({touches:[{pageX:20,pageY:410}]},owner);drag.move({touches:[{pageX:40,pageY:410}]},owner);drag.hold({},owner);assert.equal(state.dragging,false);drag.cancel({},owner);assert.match(styles.at(-1).transform,/12px,400px/);
});
test('存储失败不虚报已记住，缺失身份不写全局键；旧图片错误不污染新图片',()=>{
 const f=fixture(),c=f.component;c.measure();f.wx.setStorageSync=()=>{throw Error('quota');};c.onOrbDragStart();c.onOrbDragEnd({x:100,y:300});assert.equal(c.data.savedNotice,'位置暂未保存');
 c.setData({detail:{imageUrl:'https://new.test/photo.png'}});c.imageError({currentTarget:{dataset:{imageUrl:'https://old.test/photo.png'}}});assert.equal(c.data.imageFailed,false);c.imageError({currentTarget:{dataset:{imageUrl:'https://new.test/photo.png'}}});assert.equal(c.data.imageFailed,true);
 c.properties.ownerKey='';c.onOrbDragStart();c.onOrbDragEnd({x:150,y:330});assert.equal(f.storage.size,0);
});
test('拖动中窗口改变恢复合法落点并退出拖动；减弱动效关闭后解除遮罩',()=>{
 const f=fixture(),c=f.component;c.measure();c.onOrbDragStart();c.measure(true);assert.equal(c.data.dragging,false);c.properties.reduceMotion=true;c.toggle();assert.equal(c.data.expanded,false);c.onOrbPress();c.toggle();assert.equal(c.data.expanded,true);c.close();f.flush();assert.equal(c.data.modalActive,false);
});

test('真实WXML触摸开始到结束能展开一次，不依赖另发tap；原生重复tap不把详情立即收回',()=>{
 const f=gestureFixture(),c=f.component;
 f.fire('touchstart',{touches:[{pageX:30,pageY:410}],timeStamp:1000});
 f.fire('touchend',{changedTouches:[{pageX:30,pageY:410}],timeStamp:1080});
 assert.equal(c.data.expanded,true,'短按松手应直接通过WXS桥展开');
 f.fire('tap',{timeStamp:1081});f.fire('touchend',{timeStamp:1082});
 assert.equal(c.data.expanded,true);assert.equal(f.events.filter(e=>e.value.open).length,1);
 c.close();f.flush();f.fire('touchstart',{touches:[{pageX:30,pageY:410}],timeStamp:1100});
 f.fire('touchmove',{touches:[{pageX:35,pageY:414}],timeStamp:1120});f.fire('touchend',{timeStamp:1150});
 assert.equal(c.data.expanded,true,'轻微手抖仍展开');
 f.fire('touchstart',{touches:[{pageX:30,pageY:410}],timeStamp:1200});f.fire('touchend',{timeStamp:1250});
 assert.equal(c.data.expanded,false,'展开时再次点球收起');
});

test('实际绑定的长按拖动/滑走/取消/多指/空触点均不误开，保存位置后下次短按可开',()=>{
 for(const kind of ['drag','slide','cancel','multitouch','empty']){
  const f=gestureFixture(),c=f.component,start={touches:[{pageX:30,pageY:410}],timeStamp:2000};
  f.fire('touchstart',kind==='empty'?{touches:[],timeStamp:2000}:start);
  if(kind==='drag'){f.fire('longpress',{timeStamp:2350});f.fire('touchmove',{touches:[{pageX:130,pageY:340}],timeStamp:2400});}
  if(kind==='slide')f.fire('touchmove',{touches:[{pageX:55,pageY:410}],timeStamp:2050});
  if(kind==='cancel')f.fire('touchcancel',{timeStamp:2050});
  if(kind==='multitouch')f.fire('touchmove',{touches:[{pageX:30,pageY:410},{pageX:40,pageY:420}],timeStamp:2050});
  f.fire('touchend',{timeStamp:2500});f.fire('tap',{timeStamp:2501});assert.equal(c.data.expanded,false,kind);
  if(kind==='drag'){assert.equal(f.storage.size,1);assert.equal(c.data.savedNotice,'已记住位置');}
  f.flush();f.fire('touchstart',{...start,timeStamp:3000});f.fire('touchend',{timeStamp:3050});assert.equal(c.data.expanded,true,kind+'之后可短按');
 }
});

test('无触摸来源的tap仍走WXS入口；关闭后可重开，弹窗锁定时长按不拖动',()=>{
 const f=gestureFixture(),c=f.component;f.fire('tap',{timeStamp:5000});assert.equal(c.data.expanded,true);
 f.fire('touchstart',{touches:[{pageX:30,pageY:410}],timeStamp:5100});f.fire('longpress',{timeStamp:5500});f.fire('touchend',{timeStamp:5550});assert.equal(c.data.dragging,false);assert.equal(c.data.expanded,true);assert.equal(f.storage.size,0);
 c.close();f.flush();f.fire('tap',{timeStamp:7000});assert.equal(c.data.expanded,true);
});
