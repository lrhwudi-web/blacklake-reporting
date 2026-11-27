// Approved 3F geometry; data and interaction are provided by the live dashboard.
export function buildFloor3({THREE,scene,box,cylinder,material,details,$,selectMachine}) {
function floorText(text, width, height, x, z, color = '#99aab9') {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 128;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.font = '600 60px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2; plane.position.set(x, .037, z); scene.add(plane);
}
const building = new THREE.Group(); scene.add(building);
details.floor(building, 63, 9, '3F');
box(building, [63, .3, 9], [0, -.2, 0], 0xdde5eb);
box(building, [62.6, .05, 8.6], [0, -.025, 0], 0xeaf0f3);
// Low perimeter walls leave every machine visible.
box(building, [63, 1.15, .17], [0, .4, -4.3], 0xf9fbfd);
box(building, [.17, 1.15, 8.6], [-31.35, .4, 0], 0xf9fbfd);
for (let x = -28; x < 30; x += 5.2) { box(building, [3.6, .55, .07], [x, .56, -4.19], 0xc5d9e9); box(building, [.05, .55, .08], [x, .56, -4.13], 0xf4f8fc); }
for (const z of [-3.8, 3.8]) box(building, [61, .01, .035], [0, .012, z], 0xb7c5d1);
box(building, [61, .01, .025], [0, .012, 2.5], 0xcbd7df);
for (let x = -29; x <= 29; x += 1.4) box(building, [.65, .012, .06], [x, .014, 2.55], 0xffffff);
floorText('3F  /  EMBROIDERY', 6.5, .6, 0, 3.65, '#94a8b9');
// Thread shelves and supply carts at the rear edge.
for (const x of [-26, -15.6, -5.2, 5.2, 15.6, 26]) {
  for (const xx of [-1.6, 1.6]) box(building, [.07, 1.9, .07], [x + xx, .95, -3.4], 0x9faeb9);
  for (const y of [.2, .8, 1.4, 1.9]) box(building, [3.3, .08, .6], [x, y, -3.4], 0xc0cbd3);
  for (const y of [.48, 1.1, 1.66]) for (let i = 0; i < 6; i++) cylinder(building, .15, .28, [x - 1.25 + i * .5, y, -3.4], [0xd3b499, 0x8aafd3, 0xe9d4a2][i % 3]);
}
const machineObjects = [], labelButtons = [];
for (let i = 0; i < 12; i++) {
  const x = (i - 5.5) * 5.2, z = 0;
  const group = new THREE.Group(); group.position.set(x, 0, z); group.userData.machineId = i + 1; scene.add(group);
  group.rotation.y = Math.PI / 2;
  const pad = box(group, [4.5, .045, 2.65], [0, .022, 0], 0xe0e9f3);
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(4.5, .048, 2.65)), new THREE.LineBasicMaterial({ color: 0xc3d2e5 })); line.position.y = .023; group.add(line);
  const status = box(group, [3.9, .022, .12], [0, .063, 1.18], 0x376be6);
  // Steel legs, worktable, needle heads, thread stand and controller.
  for (const xx of [-1.45, 1.45]) { box(group, [.12, .75, .85], [xx, .42, 0], 0x899ba9); box(group, [.5, .08, 1.12], [xx, .085, 0], 0x788b9a); }
  box(group, [3.75, .14, 1.35], [0, .82, 0], 0xf9fbfc);
  box(group, [3.5, .17, .32], [0, .77, -.5], 0x7893aa);
  box(group, [3.65, .65, .28], [0, 1.35, -.45], 0xd2e0eb);
  box(group, [3.65, .1, .32], [0, 1.73, -.45], 0x547c9e);
  const needles = new THREE.Group(), carriage = new THREE.Group(); group.add(needles, carriage);
  const shafts = [], cloth = [];
  for (let j = 0; j < 6; j++) {
    const xx = -1.48 + j * .59;
    box(group, [.45, .53, .39], [xx, 1.25, -.19], 0xf5f8fb);
    box(group, [.4, .14, .43], [xx, 1.57, -.18], 0x8aaecb);
    box(needles, [.18, .1, .15], [xx, 1.04, .035], 0x38566b);
    box(needles, [.022, .2, .022], [xx, .94, .055], 0x5a7184);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(.23, .025, 6, 24), material(0x647b8e)); hoop.rotation.x = Math.PI / 2; hoop.position.set(xx, .915, .22); carriage.add(hoop);
    const fabric = box(carriage, [.43, .012, .4], [xx, .908, .22], [0xe9b397, 0xd1bd9b, 0xc8d8ec][i % 3]); cloth.push(fabric);
    for (let stitch = 0; stitch < 5; stitch++) box(carriage, [.16 + stitch * .02, .006, .009], [xx, .921, .08 + stitch * .055], 0x6387aa);
    box(group, [.018, .23, .018], [xx, 1.96, -.46], 0x8f9da7);
    const spool = new THREE.Group(); spool.position.set(xx, 1.86, -.46); group.add(spool);
    cylinder(spool, .074, .15, [0, 0, 0], [0x477bad, 0xbb7547, 0xd1b45b][j % 3]);
    box(spool, [.035, .17, .025], [.065, 0, .02], 0xeceef0); shafts.push(spool);
  }
  const wheel = new THREE.Group(); wheel.position.set(1.82, 1.3, -.14); group.add(wheel);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(.21, .042, 8, 24), material(0x587d9b)); wheel.add(rim);
  box(wheel, [.38, .035, .035], [0, 0, 0], 0xb1c4d3); box(wheel, [.035, .38, .035], [0, 0, 0], 0xb1c4d3);
  const controller = box(group, [.43, .38, .16], [2, 1.2, -.05], 0xf0f5f7); controller.rotation.x = -.15;
  box(group, [.3, .2, .025], [2, 1.23, .045], 0x416080);
  cylinder(group, .075, .055, [1.97, 1, .04], 0xd57767);
  const lamp = box(group, [.11, .11, .11], [1.8, 1.81, -.45], 0x376be6, { emissive: 0x376be6, emissiveIntensity: .3 });
  // Unique lamp material: pulses must never leak to idle machines through material reuse.
  lamp.material = lamp.material.clone();
  details.embroidery(group, i);
  const pickMeshes = []; group.traverse(child => { if (child.isMesh) { child.userData.machineId = i + 1; pickMeshes.push(child); } });
  machineObjects.push({ group, pad, status, line, lamp, pickMeshes, needles, carriage, wheel, shafts, cloth, position: new THREE.Vector3(0, .9, 0) });
  const button = document.createElement('button'); button.className = 'machine-label'; button.dataset.machine = i + 1; button.addEventListener('click', e => selectMachine(i + 1, e.detail === 0)); $('labels').appendChild(button); labelButtons.push(button);
}
const floor3Objects = scene.children.filter(object => !object.isLight);

return {objects:floor3Objects,models:machineObjects,labels:labelButtons};
}
