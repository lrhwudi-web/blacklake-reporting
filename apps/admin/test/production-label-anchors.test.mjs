import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../production-3d/vendor/three.module.js';
import { buildFloor3 } from '../production-3d/scene-models.js';
import { buildOtherFloors } from '../production-3d/floor-models.js';

function fixture(t){
  const previousDocument=globalThis.document;
  globalThis.document={createElement:()=>({
    dataset:{},
    addEventListener(name,listener){this[name]=listener;},
    getContext:()=>({fillText(){}})
  })};
  t.after(()=>{globalThis.document=previousDocument;});
  const material=()=>new THREE.MeshBasicMaterial();
  const box=(parent,size,position)=>{
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),material());
    mesh.position.set(...position);parent.add(mesh);return mesh;
  };
  const cylinder=(parent,r,h,position)=>{
    const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,8),material());
    mesh.position.set(...position);parent.add(mesh);return mesh;
  };
  const details=Object.fromEntries(['floor','decal','sewing','cutting','rack','carton','worker','embroidery'].map(name=>[name,()=>{}]));
  return {THREE,scene:new THREE.Scene(),material,box,cylinder,details};
}

function checkTopViewAnchors(models,anchorFor,idFor){
  const meshes=[];
  for(const model of models)model.group.traverse(object=>{if(object.isMesh)meshes.push(object);});
  const ray=new THREE.Raycaster();
  for(const [i,model]of models.entries()){
    const anchor=model.group.localToWorld(anchorFor(model).clone());
    ray.set(anchor.clone().add(new THREE.Vector3(0,20,0)),new THREE.Vector3(0,-1,0));
    const hit=ray.intersectObjects(meshes,false)[0];
    const picked=hit&&(hit.object.userData.floorUnitId??`3F-${String(hit.object.userData.machineId).padStart(2,'0')}`);
    assert.equal(picked,idFor(model,i),`${idFor(model,i)} label must point to its own model in top view`);
  }
}

test('8楼的每个标签锚点都落在同编号模型上，标签点击编号一致',t=>{
  let selected;
  const env=fixture(t),floors=buildOtherFloors({...env,selectUnit:id=>selected=id});
  floors.buildFloor('8');env.scene.updateMatrixWorld(true);
  checkTopViewAnchors(floors.models['8'],m=>m.anchor,m=>m.id);
  for(const model of floors.models['8']){model.label.click({detail:1});assert.equal(selected,model.id);}
});

test('4楼货架及作业区标签锚点都落在对应模型上',t=>{
  const env=fixture(t),floors=buildOtherFloors({...env,selectUnit(){}});
  floors.buildFloor('4');env.scene.updateMatrixWorld(true);
  checkTopViewAnchors(floors.models['4'],m=>m.anchor,m=>m.id);
});

test('3楼横过来的12台机器标签跟随各自模型的局部坐标',t=>{
  const env=fixture(t),floor=buildFloor3({...env,$:()=>({appendChild(){}}),selectMachine(){}});
  env.scene.updateMatrixWorld(true);
  checkTopViewAnchors(floor.models,m=>m.position,(_,i)=>`3F-${String(i+1).padStart(2,'0')}`);
});
