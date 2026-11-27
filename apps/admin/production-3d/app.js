import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { buildFloor3 } from './scene-models.js';
import { buildOtherFloors } from './floor-models.js';
import { createSceneDetails } from './scene-details.js';
import { escape, orderKey, sameOrder, sceneOrders, currentUnit, progress, hasUnconfirmedQuantity, assignmentStatusName } from './data.js';

function returnToReporting(event) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const params = new URLSearchParams(window.location.search);
  if (!event.target.closest?.('a[data-return-workspace]') || window.parent === window || params.get('embedded') !== '1' || params.get('workspace') !== '1') return;
  event.preventDefault();
  window.parent.postMessage({ type: 'return-to-reporting' }, window.location.origin);
}
document.addEventListener('click', returnToReporting);

const $=id=>document.getElementById(id), container=$('scene'), scene=new THREE.Scene();
const palette={running:0x315ef5,scheduled:0xd69a28,attention:0xd35849,available:0x98a2b3,unknown:0xb7bfcb};
const statusNames={running:'生产中',scheduled:'待开始',attention:'待处理',available:'无活动任务',unknown:'尚未读取'};
const tones={running:'running',scheduled:'ready',attention:'attention',available:'idle',unknown:'idle'};
const names={'3':'3楼绣花车间','8':'8楼生产车间','4':'4楼仓库'};
const floorMemory={}; let floor=['3','8','4'].includes(new URLSearchParams(location.search).get('floor'))?new URLSearchParams(location.search).get('floor'):'8';
let payload={},snapshot={},loaded=false,selectedUnit=null,selectedOrder=null,search='',filter='all',failed=false;
let paused=false,touring=false,speed=1,time=0,lastFrame=0,tourTime=0,cameraMove=null,request=0;
let activePanel='detail',trayCollapsed=false,overlayRects=[],floorInitialized=false;
const initialUnit=new URLSearchParams(location.search).get('unit');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
document.body.classList.toggle('embedded',new URLSearchParams(location.search).get('embedded')==='1');
scene.background=new THREE.Color(0xf0f2f5);
const camera=new THREE.PerspectiveCamera(38,1,.1,400);
let renderer; try { renderer=new THREE.WebGLRenderer({antialias:true}); renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=.94; renderer.outputColorSpace=THREE.SRGBColorSpace; container.prepend(renderer.domElement); renderer.domElement.setAttribute('aria-label','3D现场模型，左键拖动旋转，右键拖动平移，滚轮缩放'); } catch { $('scene-error').hidden=false; }
const controls=renderer?new OrbitControls(camera,renderer.domElement):null;
if(controls){controls.enableDamping=true;controls.dampingFactor=.08;controls.enablePan=true;controls.screenSpacePanning=true;controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};controls.minDistance=4;controls.maxDistance=180;controls.maxPolarAngle=Math.PI/2.1;controls.addEventListener('start',()=>{cameraMove=null;touring=false;motionUI();});}
const navigation=setupSceneNavigation(controls,renderer?.domElement);

function setupSceneNavigation(orbit,canvas){
  const rotateButton=$('mode-rotate'),panButton=$('mode-pan');
  let mode='rotate',spaceHeld=false,dragging=false;
  const isPanning=()=>mode==='pan'||spaceHeld;
  function sync(){
    const pan=isPanning();
    rotateButton.setAttribute('aria-pressed',String(!pan));
    panButton.setAttribute('aria-pressed',String(pan));
    if(!orbit||!canvas)return;
    orbit.mouseButtons.LEFT=pan?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;
    canvas.dataset.navigationMode=pan?'pan':'rotate';
    canvas.style.cursor=pan?(dragging?'grabbing':'grab'):'default';
    canvas.setAttribute('aria-label',`3D现场模型，当前左键${pan?'平移':'旋转'}，按住空格临时平移，滚轮缩放`);
  }
  rotateButton.disabled=panButton.disabled=!orbit;
  rotateButton.addEventListener('click',()=>{mode='rotate';sync();});
  panButton.addEventListener('click',()=>{mode='pan';sync();});
  if(canvas){
    canvas.tabIndex=0;
    canvas.setAttribute('aria-keyshortcuts','Space');
    canvas.addEventListener('pointerdown',e=>{canvas.focus({preventScroll:true});if(e.button===0){dragging=true;sync();}});
    const endDrag=()=>{dragging=false;sync();};
    window.addEventListener('pointerup',endDrag);
    canvas.addEventListener('pointercancel',endDrag);
    canvas.addEventListener('lostpointercapture',endDrag);
  }
  document.addEventListener('keydown',e=>{
    if(e.code!=='Space'||!orbit||e.ctrlKey||e.altKey||e.metaKey)return;
    if(e.target?.closest?.('input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"]'))return;
    e.preventDefault();spaceHeld=true;sync();
  });
  document.addEventListener('keyup',e=>{if(e.code==='Space'&&spaceHeld){spaceHeld=false;sync();}});
  const resetTemporary=()=>{spaceHeld=false;dragging=false;sync();};
  window.addEventListener('blur',resetTemporary);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)resetTemporary();});
  sync();
  return {isPanning};
}
scene.add(new THREE.HemisphereLight(0xf6f5ed,0x8496ad,1.1));
const fill=new THREE.DirectionalLight(0xaacaff,.7);fill.position.set(25,16,-25);scene.add(fill);
const sun=new THREE.DirectionalLight(0xfff0da,2.6);sun.position.set(-18,32,18);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-42,right:42,top:38,bottom:-38,far:130});sun.shadow.normalBias=.02;sun.shadow.bias=-.00015;scene.add(sun);
const materials=new Map(),geometries=new Map();
function material(color,options={}){const key=String(color)+JSON.stringify(options);if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.72,...options}));return materials.get(key);}
function box(parent,size,pos,color,options={}){const key=size.join(',');if(!geometries.has(key))geometries.set(key,Math.min(...size)>=.12&&Math.max(...size)<10?new RoundedBoxGeometry(...size,2,Math.min(.045,Math.min(...size)/5)):new THREE.BoxGeometry(...size));const mesh=new THREE.Mesh(geometries.get(key),material(color,options));mesh.position.set(...pos);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
function cylinder(parent,r,h,pos,color){const key=`c${r}:${h}`;if(!geometries.has(key))geometries.set(key,new THREE.CylinderGeometry(r,r,h,20));const mesh=new THREE.Mesh(geometries.get(key),material(color,{metalness:.15,roughness:.5}));mesh.position.set(...pos);mesh.castShadow=true;parent.add(mesh);return mesh;}
const details=createSceneDetails({THREE,box,cylinder,material});
const third=buildFloor3({THREE,scene,box,cylinder,material,details,$,selectMachine:id=>selectUnit(`3F-${String(id).padStart(2,'0')}`)});
const others=buildOtherFloors({THREE,scene,box,cylinder,material,details,selectUnit});
function models(){return floor==='3'?third.models:others.models[floor] || [];}
function modelId(m,i){return floor==='3'?`3F-${String(i+1).padStart(2,'0')}`:m.id;}
function units(){return floor==='4'?others.config['4'].units.map(u=>({...u,state:'unknown',assignments:[]})):(snapshot.floors?.[floor] || (floor==='3'?third.models.map((_,i)=>({id:`3F-${String(i+1).padStart(2,'0')}`})):others.config['8'].units).map(u=>({...u,state:'unknown',assignments:[]}))).map(currentUnit);}
function orders(){return floor==='4'?[]:sceneOrders(payload,snapshot,floor);}
function fmt(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString():'—';}
function icon(name){return `<svg class="ti" aria-hidden="true"><use href="#ti-${name}"/></svg>`;}
function updateOcclusion(){
  const origin=container.getBoundingClientRect();
  overlayRects=[...document.querySelectorAll('.scene-identity,.metrics,.sync-controls,.floor-switcher,.view-tools,.inspector,.live-message')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {l:r.left-origin.left-6,r:r.right-origin.left+6,t:r.top-origin.top-6,b:r.bottom-origin.top+6};});
}
function setCollapsed(value){
  trayCollapsed=value;$('tray-content').hidden=value;
  if(value){$('position-drawer').hidden=true;$('positions').setAttribute('aria-expanded','false');$('positions').setAttribute('aria-label','打开位置导航');}
  $('collapse-tray').setAttribute('aria-expanded',String(!value));
  $('collapse-tray').setAttribute('aria-label',value?'展开详情':'收起详情');
  $('collapse-tray').innerHTML=icon(value?'chevron-up':'chevron-down');
  updateOcclusion();
}
function setPanel(name,focus=false){
  activePanel=name;setCollapsed(false);
  document.querySelectorAll('[data-panel]').forEach(button=>{const selected=button.dataset.panel===name;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;if(selected&&focus)button.focus();});
  document.querySelectorAll('.tray-panel').forEach(panel=>panel.hidden=panel.id!==`panel-${name}`);
  updateOcclusion();
}
function renderDetail(u,chosen,warehouse,modelConfig){
  if(!u)return '<div class="empty">点击模型或打开位置导航，查看位置详情。</div>';
  const state=warehouse?'布局示意':statusNames[u.state];
  const identity=`<div class="unit-identity"><div class="unit-mini">${details.mini(modelConfig?.kind || 'sewing')}</div><div class="unit-title"><div><h2>${escape(u.id)}</h2><span class="status-pill ${tones[u.state]}"><i class="dot ${tones[u.state]}"></i>${state}</span></div><small>${names[floor]}${u.assignments.length>1?' · '+u.assignments.length+'笔任务':''}</small></div></div>`;
  if(warehouse)return identity+'<p class="warehouse-unknown">仓库布局示意。货架库存、入出库数量和搬运轨迹尚未接入正式数据。</p>';
  if(!u.assignments.length)return identity+`<div class="empty">${loaded?'该位置当前没有活动任务。':'尚未取得位置状态。'}<br>点击其他位置，查看人员、任务和工序进度。</div>`;
  const fact=(label,value,sub='')=>`<div class="task-fact"><span>${label}</span><strong title="${escape(value)}">${escape(value)}</strong>${sub?`<small>${escape(sub)}</small>`:''}</div>`;
  const assignments=`<div class="assignment-deck ${u.assignments.length>1?'multiple':''}">${u.assignments.map(a=>`<div class="task-facts">${fact('工单号',a.projectCode || '未提供')}${fact('产品名称',a.productName || chosen?.name || '未提供')}${fact('作业人员',a.operatorName || '未提供',assignmentStatusName(a))}${fact('当前工序',a.processName || '未提供')}${hasUnconfirmedQuantity(a)?fact('报工数量','待核量','结束只记工时，暂不计产量'):fact('任务计划量',fmt(a.targetQuantity??a.quantity)+' 件')}</div>`).join('')}</div>`;
  const processes=chosen?.processes || [],currentIndex=processes.findIndex(p=>(p.taskId!=null&&p.taskId===u.assignments[0].taskId) || p.processName===u.assignments[0].processName),start=Math.max(0,Math.min(currentIndex-1,processes.length-4));
  const preview=`<div class="detail-route"><div class="route-preview-title"><span>工序进度</span><button data-open-route>查看工序 ${icon('arrow-right')}</button></div>${processes.length?`<div class="route-preview">${processes.slice(start,start+4).map((p,i)=>`<div class="preview-step ${start+i===currentIndex?'current':progress(p)===100?'done':''}" title="${escape(p.processName)} · ${fmt(p.reportedAmount)} / ${fmt(p.plannedAmount)}"><span class="step-node"></span><span>${escape(p.processName)}</span></div>`).join('')}</div>`:'<div class="empty">尚未取得黑湖工序</div>'}</div>`;
  return identity+assignments+preview;
}
function metric(name,value,note,unit='处'){return `<div class="metric"><div><div class="metric-name">${name}</div><div class="metric-value">${value}<small>${unit}</small></div><div class="metric-note">${note}</div></div></div>`;}
function render(){
  const us=units(),os=orders(),warehouse=floor==='4';
  document.querySelector('.page-heading .eyebrow').textContent=`${warehouse?'仓储布局':'生产现场'} / ${names[floor]}`;
  document.querySelector('.page-heading p').textContent=warehouse?'货架、入库与拣货打包区的布局示意，尚未接入库存。':'状态来自现场派单，工序进度来自黑湖；本页只读。';
  $('scene-title').textContent=names[floor];
  $('scene-fact').textContent=warehouse?'仓库布局示意 · 尚未接入实时库存':'动作示意 · 非实时设备信号';
  $('metrics').innerHTML=warehouse?['货架库存','今日入库','今日出库','待核对'].map(name=>metric(name,'—','尚未接入仓储数据',name==='待核对'?'处':'件')).join(''):[metric('生产中',loaded?us.filter(u=>u.state==='running').length:'—','来自现场任务状态'),metric('待开始',loaded?us.reduce((n,u)=>n+u.assignments.filter(a=>a.status==='READY').length,0):'—','已派单，等待员工开始','笔'),metric('待处理',loaded?us.filter(u=>u.state==='attention').length:'—','提交中或结果待核对'),metric('关联工单',loaded?os.length:'—','本楼层可确认位置的工单','张')].join('');
  const visible=os.filter(o=>(`${o.projectCode}${o.name}`).toLowerCase().includes(search.toLowerCase())&&(filter==='all'||us.some(u=>u.state===(filter==='running'?'running':'attention')&&u.assignments.some(a=>sameOrder(a,o)))));
  $('order-count').textContent=String(visible.length);
  $('orders').innerHTML=visible.map(o=>{const p=o.processes.at(-1),pct=progress(p);return `<button class="order-card ${selectedOrder===o.id?'active':''}" data-order="${escape(o.id)}"><div class="code">${escape(o.projectCode)}</div><h3>${escape(o.name)}</h3><div class="order-meta"><span>${p?'末道工序 '+fmt(p.reportedAmount)+' / '+fmt(p.plannedAmount):'工序资料暂不可用'}</span><b>${pct===null?'—':pct+'%'}</b></div><div class="bar"><span style="width:${pct??0}%"></span></div><div class="order-bottom"><span>已确认工序累计</span><span>${o.due?'交期 '+escape(o.due):'交期未提供'}</span></div></button>`;}).join('')||`<div class="empty">${warehouse?'4楼尚未接入仓储数据。':!loaded?'正在读取现场任务…':search||filter!=='all'?'没有符合条件的关联工单。':'当前未取得关联本楼层位置的工单。'}</div>`;
  const chosen=os.find(o=>o.id===selectedOrder);
  $('route-title').textContent=chosen?.name || (warehouse?'仓储数据尚未接入':'选择关联工单查看工序');$('route-summary').textContent=chosen?.projectCode || '';
  $('route').innerHTML=chosen?.processes.length?chosen.processes.map((p,i)=>{const pct=progress(p);return `<div class="step"><span class="step-circle">${i+1}</span><strong>${escape(p.processName)}</strong><small>${fmt(p.reportedAmount)} / ${fmt(p.plannedAmount)} ${escape(p.unit || '')} · ${pct===null?'—':pct+'%'}</small><div class="bar"><span style="width:${pct??0}%"></span></div></div>`;}).join(''):`<div class="empty">${warehouse?'入库、上架、拣货、打包和出库尚无实时数据。':chosen?'暂未取得黑湖工序，不能推断完成率。':'点击位置或关联工单查看详情。'}</div>`;
  const u=us.find(u=>u.id===selectedUnit),a=u?.assignments[0],modelConfig=floor==='3'?{kind:'sewing'}:others.config[floor].units.find(v=>v.id===u?.id);
  $('detail').innerHTML=renderDetail(u,chosen,warehouse,modelConfig);
  $('machine-strip').innerHTML=us.map(u=>`<button class="strip-machine floor-unit-nav" data-unit="${escape(u.id)}" aria-label="定位${escape(u.id)}，${warehouse?'布局示意':statusNames[u.state]}" aria-pressed="${u.id===selectedUnit}"><i class="dot ${tones[u.state]}"></i>${escape(u.id)}</button>`).join('');
  models().forEach((m,i)=>{const id=modelId(m,i),u=us.find(u=>u.id===id),relevant=!selectedOrder||u?.assignments.some(a=>orderKey(a)===selectedOrder);m.pad.material=material(id===selectedUnit?0xd1e2e5:0xe3eaec);m.status.material=material(warehouse?0x91a7b1:palette[u?.state]??palette.unknown);const label=floor==='3'?third.labels[i]:m.label;label.className=`machine-label ${id===selectedUnit?'selected':''} ${relevant?'':'dimmed'}`;label.innerHTML=`<i class="dot ${tones[u?.state] || 'idle'}"></i>${escape(id)}`;label.setAttribute('aria-label',`${id}，${warehouse?'布局示意':statusNames[u?.state] || '尚未读取'}`);label.setAttribute('aria-pressed',String(id===selectedUnit));});
  motionUI();
}
function switchFloor(value){
  if(floorInitialized)floorMemory[floor]={selectedUnit,selectedOrder,search,filter};floor=value;floorInitialized=true;
  if(floor!=='3'&&!others.roots[floor])others.buildFloor(floor);
  third.objects.forEach(o=>o.visible=floor==='3');Object.entries(others.roots).forEach(([id,o])=>o.visible=id===floor);
  $('labels').replaceChildren(...(floor==='3'?third.labels:others.labelSets[floor]));
  const memory=floorMemory[floor];selectedUnit=memory?memory.selectedUnit:(units().some(u=>u.id===initialUnit)?initialUnit:null) || (floor==='3'?'3F-01':floor==='8'?'A-01':'入库区');selectedOrder=memory?.selectedOrder || null;search=memory?.search || '';filter=memory?.filter || 'all';$('search').value=search;if(!memory){const assignment=units().find(u=>u.id===selectedUnit)?.assignments?.[0];selectedOrder=assignment?orderKey(assignment):null;}
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));document.querySelectorAll('[data-floor]').forEach(b=>{b.classList.toggle('active',b.dataset.floor===floor);b.setAttribute('aria-pressed',String(b.dataset.floor===floor));});
  touring=false;render();if(floor==='8')sceneView(true);else overview(true);const url=new URL(location.href);url.searchParams.set('floor',floor);history.replaceState(null,'',url);
}
function sceneView(instant=false){
  // A working view of both rows, with the floor continuing underneath the tray.
  if(camera.aspect<.9){const u=others.config['8'].units.find(u=>u.id===selectedUnit)||others.config['8'].units[2],target=new THREE.Vector3(u.x,.7,u.z);moveCamera(target.clone().add(new THREE.Vector3(7,11,13)),target,instant);}
  else{const target=new THREE.Vector3(-6,.7,6.5);moveCamera(target.clone().add(new THREE.Vector3(12,10.4,12.8)),target,instant);}
}
function moveCamera(position,target,instant=false){if(!controls)return;if(instant||reduced.matches){camera.position.copy(position);controls.target.copy(target);cameraMove=null;controls.update();}else cameraMove={from:camera.position.clone(),to:position,targetFrom:controls.target.clone(),targetTo:target,start:performance.now()};}
function selectUnit(id){selectedUnit=id;const u=units().find(u=>u.id===id);selectedOrder=u?.assignments[0]?orderKey(u.assignments[0]):null;touring=false;setPanel('detail');render();focusUnit(id);}
function focusUnit(id){if(floor==='3'){const i=Number(id.slice(-2))-1,x=third.models[i]?.group.position.x || 0;moveCamera(new THREE.Vector3(x+7.8,5.6,-2.4),new THREE.Vector3(x,.8,0));}else{const u=others.config[floor].units.find(u=>u.id===id);if(!u)return;const large=['rack','cutting'].includes(u.kind);moveCamera(new THREE.Vector3(u.x+(large?12:10),large?13:12,u.z+(large?16:14)),new THREE.Vector3(u.x,u.kind==='rack'?1.3:.65,u.z));}$('scene-sub').textContent=`正在查看 ${id}`;}
function overview(instant=false){touring=false;motionUI();if(floor==='3'){const fit=Math.max(62,100/Math.max(.65,camera.aspect));moveCamera(new THREE.Vector3(8,fit*.36,fit),new THREE.Vector3(0,.6,0),instant);}else{const c=others.config[floor],target=new THREE.Vector3(0,.4,c.size[1]*.22),direction=new THREE.Vector3(...c.overview),fitCamera=camera.clone();for(let i=0;i<40;i++){fitCamera.position.copy(direction).add(target);fitCamera.lookAt(target);fitCamera.updateMatrixWorld();if([-1,1].every(x=>[-1,1].every(z=>{const p=new THREE.Vector3(x*c.size[0]/2,1.5,z*c.size[1]/2).project(fitCamera);return Math.abs(p.x)<.92&&Math.abs(p.y)<.78;})))break;direction.multiplyScalar(1.035);}moveCamera(direction.add(target),target,instant);}$('scene-sub').textContent=floor==='3'?'12台一字排列 / 相对布局':floor==='8'?'23处作业位置 / 相对布局':'12组货架＋3处作业区 / 布局示意';}
function motionUI(){
  const off=paused||reduced.matches;
  $('pause').innerHTML=icon(off?'player-play':'player-pause');
  $('pause').disabled=reduced.matches;$('pause').setAttribute('aria-label',off?'播放动画':'暂停动画');$('pause').title=off?'播放动画':'暂停动画';$('pause').setAttribute('aria-pressed',String(off));
  $('tour').innerHTML=icon('map')+`<span>${touring?'停止':'巡览'}</span>`;
  $('tour').disabled=reduced.matches;$('tour').setAttribute('aria-label',touring?'停止巡览':'自动巡览');$('tour').setAttribute('aria-pressed',String(touring));
  $('motion-status').textContent=reduced.matches?'减少动态模式':off?'动画已暂停':touring?'自动巡览中':'运行示意中';
}
let narrowViewport=false;
function resize(){if(!renderer)return;const w=container.clientWidth,h=container.clientHeight,r=Math.min(2,Math.max(1.5,devicePixelRatio||1));if(renderer.getPixelRatio()!==r)renderer.setPixelRatio(r);renderer.setSize(w,h);camera.aspect=w/h;camera.setViewOffset(w,h,0,h*(w<560?.02:.07),w,h);camera.updateProjectionMatrix();const narrow=w/h<.9;if(narrow!==narrowViewport&&floor==='8')sceneView(true);narrowViewport=narrow;updateOcclusion();}
new ResizeObserver(resize).observe(container);window.addEventListener('resize',resize);let density;function watchDensity(){density?.removeEventListener('change',densityChanged);density=matchMedia(`(resolution: ${devicePixelRatio}dppx)`);density.addEventListener('change',densityChanged);}function densityChanged(){resize();watchDensity();}watchDensity();resize();
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();let down;
renderer?.domElement.addEventListener('pointerdown',e=>down=e.button===0&&!navigation.isPanning()&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey?[e.clientX,e.clientY]:null);renderer?.domElement.addEventListener('pointerup',e=>{if(e.button!==0||!down||navigation.isPanning()||Math.hypot(e.clientX-down[0],e.clientY-down[1])>6)return;const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(models().flatMap(m=>{const meshes=[];m.group.traverse(c=>{if(c.isMesh)meshes.push(c);});return meshes;}),false)[0];if(hit){const id=floor==='3'?`3F-${String(hit.object.userData.machineId).padStart(2,'0')}`:hit.object.userData.floorUnitId;if(id)selectUnit(id);}});
renderer?.setAnimationLoop(now=>{
  const delta=lastFrame?Math.min(.05,(now-lastFrame)/1000):0;lastFrame=now;const playing=!paused&&!reduced.matches&&!document.hidden;if(playing)time+=delta*speed;
  if(touring&&playing&&!cameraMove){tourTime+=delta*speed;const ms=models(),n=(tourTime/3)%ms.length,i=Math.floor(n),a=ms[i].group.position,b=ms[(i+1)%ms.length].group.position,target=new THREE.Vector3().lerpVectors(a,b,n-i);moveCamera(target.clone().add(new THREE.Vector3(8,8,11)),target.clone().add(new THREE.Vector3(0,.7,0)),true);}
  if(cameraMove){const t=Math.min(1,(now-cameraMove.start)/250),e=1-(1-t)**3;camera.position.lerpVectors(cameraMove.from,cameraMove.to,e);controls.target.lerpVectors(cameraMove.targetFrom,cameraMove.targetTo,e);if(t===1)cameraMove=null;}
  const us=units();models().forEach((m,i)=>{const u=us.find(u=>u.id===modelId(m,i)),running=u?.state==='running',t=time+i*.21;if(floor==='3'){m.needles.position.y=running?Math.sin(t*Math.PI*8)*.085:0;m.carriage.position.x=running?Math.sin(t*2.3)*.15:0;m.carriage.position.z=running?Math.cos(t*1.7)*.13:0;m.wheel.rotation.z=running?-t*5:0;m.shafts.forEach((s,j)=>s.rotation.y=running?t*3+j:0);}else{if(m.needle)m.needle.position.y=running?.95+Math.sin(t*Math.PI*8)*.08:.95;if(m.carriage)m.carriage.position.z=running?Math.sin(t*2)*.13:0;m.spinning.forEach(w=>w.rotation.x=running?t*5:0);m.moving.forEach(v=>v.object.position[v.axis]=(v.baseline||0)+((running||floor==='4')?Math.sin(t*1.5)*v.amount:0));}});
  if(floor==='4'){const root=others.roots['4'],p=(time%28)/28,point=root.userData.cartRoute.getPointAt(p),tangent=root.userData.cartRoute.getTangentAt(p);root.userData.cart.position.copy(point);root.userData.cart.rotation.y=Math.atan2(tangent.x,tangent.z);container.dataset.cartPosition=`${point.x.toFixed(3)},${point.z.toFixed(3)}`;}
  controls?.update();renderer.render(scene,camera);
  const occupied=[];
  models().map((m,i)=>{
    const id=modelId(m,i),p=(floor==='3'?m.position:m.anchor).clone();
    m.group.localToWorld(p);p.project(camera);
    return {model:m,label:floor==='3'?third.labels[i]:m.label,id,p};
  }).sort((a,b)=>(b.id===selectedUnit)-(a.id===selectedUnit)).forEach(({model,label,id,p})=>{
    const x=(p.x*.5+.5)*container.clientWidth,y=(-p.y*.5+.5)*container.clientHeight;
    const w=label.offsetWidth||model.labelWidth||id.length*9+30,h=label.offsetHeight||model.labelHeight||28;
    model.labelWidth=w;model.labelHeight=h;
    // A short screen-space stem ends exactly at the projected model anchor.
    const bottom=y-12,r={l:x-w/2,r:x+w/2,t:bottom-h,b:y+3};
    label.dataset.unit=id;
    label.style.transform=`translate(${x}px,${bottom}px) translate(-50%,-100%)`;
    label.hidden=p.z>1||p.z< -1||Math.abs(p.x)>1.05||Math.abs(p.y)>1.05||r.t<58||r.b>container.clientHeight-50||overlayRects.some(a=>r.l<a.r&&r.r>a.l&&r.t<a.b&&r.b>a.t)||occupied.some(a=>r.l<a.r+3&&r.r>a.l-3&&r.t<a.b+3&&r.b>a.t-3);
    if(!label.hidden)occupied.push(r);
  });
  container.dataset.motion=playing?'playing':'paused';container.dataset.floor=floor;container.dataset.viewZ=controls.target.z.toFixed(3);container.dataset.activeOffset=(floor==='3'?third.models[0].needles.position.y:models()[0].needle?.position.y||0).toFixed(4);
});
async function load(){const id=++request;$('refresh').disabled=true;try{const get=async path=>{const response=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'});if(response.status===401)throw new Error('登录已失效，请返回报工管理重新登录。');if(!response.ok)throw new Error('现场数据暂时无法读取，请稍后重试。');return response.json();};const [nextScene,nextPayload]=await Promise.all([get('/v1/admin/production-scene'),get('/v1/admin/assignments')]);if(id!==request)return;snapshot=nextScene;payload=nextPayload;loaded=true;failed=false;if(selectedUnit){const u=units().find(u=>u.id===selectedUnit);selectedOrder=u?.assignments[0]?orderKey(u.assignments[0]):selectedOrder;}render();const stamp=new Date(nextScene.updatedAt).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});$('sync-status').textContent=`已同步 ${stamp}`;$('updated').textContent=`更新于 ${stamp} · 每60秒刷新`;$('data-message').textContent=nextPayload.syncWarning || '3楼、8楼状态来自现场派单；累计进度来自黑湖。机械动作是示意，不表示实时设备检测。';$('data-message').classList.toggle('error',Boolean(nextPayload.syncWarning));}catch(error){if(id!==request)return;failed=true;$('sync-status').textContent=loaded?'同步失败 · 保留上次数据':'暂未取得现场数据';$('data-message').innerHTML=`${escape(error.message)} ${loaded?'当前保留上次成功的数据，请勿据此判断实时状态。':''} <a href="/admin" target="_top" data-return-workspace>返回报工管理</a>`;$('data-message').classList.add('error');}finally{if(id===request)$('refresh').disabled=false;}}
document.querySelectorAll('[data-floor]').forEach(b=>b.addEventListener('click',()=>switchFloor(b.dataset.floor)));
$('refresh').addEventListener('click',load);window.addEventListener('message',e=>{if(e.origin===location.origin&&e.source===parent&&e.data?.type==='refresh-production-scene')load();});$('search').addEventListener('input',e=>{search=e.target.value;render();});document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render();}));
$('machine-strip').addEventListener('click',e=>{const b=e.target.closest('[data-unit]');if(b)selectUnit(b.dataset.unit);});$('orders').addEventListener('click',e=>{const b=e.target.closest('[data-order]');if(!b)return;selectedOrder=b.dataset.order;selectedUnit=units().find(u=>u.assignments.some(a=>orderKey(a)===selectedOrder))?.id || null;touring=false;render();setPanel('route');if(selectedUnit)focusUnit(selectedUnit);});
$('overview').addEventListener('click',()=>overview());$('clear').addEventListener('click',()=>{selectedOrder=null;selectedUnit=null;render();overview();});$('top-view').addEventListener('click',()=>{touring=false;motionUI();const m=models().find((m,i)=>modelId(m,i)===selectedUnit),p=m?.group.position || new THREE.Vector3();moveCamera(new THREE.Vector3(p.x+.01,m?17:floor==='3'?Math.max(68,94/camera.aspect):70,p.z+.02),p.clone());});
$('pause').addEventListener('click',()=>{paused=!paused;motionUI();});$('tour').addEventListener('click',()=>{touring=!touring;tourTime=0;cameraMove=null;if(touring)paused=false;motionUI();});$('speed').addEventListener('change',e=>speed=Number(e.target.value));reduced.addEventListener('change',()=>{touring=false;cameraMove=null;motionUI();});
document.querySelector('.tray-tabs').addEventListener('click',e=>{const tab=e.target.closest('[data-panel]');if(tab)setPanel(tab.dataset.panel);});
document.querySelector('.tray-tabs').addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('[data-panel]')],index=tabs.indexOf(document.activeElement);if(index<0)return;let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();setPanel(tabs[next].dataset.panel,true);});
$('collapse-tray').addEventListener('click',()=>setCollapsed(!trayCollapsed));
$('positions').addEventListener('click',()=>{const open=$('position-drawer').hidden;$('position-drawer').hidden=!open;$('positions').setAttribute('aria-expanded',String(open));$('positions').setAttribute('aria-label',open?'关闭位置导航':'打开位置导航');updateOcclusion();});
$('detail').addEventListener('click',e=>{if(e.target.closest('[data-open-route]'))setPanel('route');});
$('data-info').addEventListener('click',()=>{const open=document.body.classList.toggle('info-open');$('data-info').setAttribute('aria-expanded',String(open));updateOcclusion();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('info-open');$('data-info').setAttribute('aria-expanded','false');$('position-drawer').hidden=true;$('positions').setAttribute('aria-expanded','false');updateOcclusion();}});
new ResizeObserver(updateOcclusion).observe($('inspector'));
new ResizeObserver(updateOcclusion).observe($('data-message'));
switchFloor(floor);load();setInterval(()=>{if(!document.hidden)load();},60_000);
