// Approved 8F geometry and explicitly schematic 4F warehouse.
export function buildOtherFloors({THREE,scene,box,cylinder,material,details,selectUnit}) {
  const stationMap = [
    ...Array.from({ length: 10 }, (_, i) => [`A-${String(i + 1).padStart(2, '0')}`, 28.3, 81.6 - i * 4.6, 'sewing', 1]),
    ...Array.from({ length: 7 }, (_, i) => [`B-${String(i + 1).padStart(2, '0')}`, 52.1, 68.4 - i * 4.7, 'sewing', 1]),
    ['手工剪线', 33.4, 24.4, 'trim', 2], ['包装/质检', 33.4, 29.5, 'packing', 4], ['刺绣片检验', 33.4, 34.5, 'inspection', 3],
    ['裁床一区', 39, 14.8, 'cutting', 0], ['裁床二区-1', 69.1, 26.5, 'cutting', 0], ['裁床二区-2', 79.9, 26.5, 'cutting', 0]
  ];
  const config = {
    '8': { name: '8楼生产车间', sceneName: '8楼 · 生产车间', intro: '缝制、裁剪、剪线、质检与包装，查看每个工位的进度。', steps: ['裁剪', '缝制', '剪线', '质检', '包装'], fact: '工位编号与相对位置沿用现有派单图 · 数量为演示', size: [29, 38], overview: [20, 28, 31], units: stationMap.map(([id, x, y, kind, step]) => ({ id, x: (x - 51) * .4, z: (y - 48) * .4, kind, step })) },
    '4': { name: '4楼仓库', sceneName: '4楼 · 仓库', intro: '货架、入库、拣货与打包出库，查看货物的流转进度。', steps: ['入库', '上架', '拣货', '打包', '出库'], fact: '仓库布局与库存均为演示 · 搬运车不代表实时定位', size: [27, 35], overview: [27, 32, 35], units: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `R-${'ABC'[Math.floor(i / 4)]}${String(i % 4 + 1).padStart(2, '0')}`, x: (Math.floor(i / 4) - 1) * 8, z: i % 4 * 5 - 10, kind: 'rack', step: 1 })),
      { id: '入库区', x: -8, z: 12, kind: 'inbound', step: 0 }, { id: '拣货区', x: 0, z: 12, kind: 'picking', step: 2 }, { id: '打包出库区', x: 8, z: 12, kind: 'shipping', step: 4 }
    ] }
  };

const roots={},models={},labelSets={};
  function textPlane(parent, text, width, height, position, rotation = [-Math.PI / 2, 0, 0], ink = '#839ab0') {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 128;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = ink; ctx.font = '600 58px Microsoft YaHei, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })); plane.position.set(...position); plane.rotation.set(...rotation); parent.add(plane);
  }
  function table(group, width = 2.2, depth = 1.5) {
    box(group, [width, .12, depth], [0, .9, 0], 0xf8fafb);
    for (const x of [-width * .38, width * .38]) for (const z of [-depth * .35, depth * .35]) box(group, [.09, .9, .09], [x, .43, z], 0x98acbd);
    for (const x of [-width * .38, width * .38]) { box(group, [.065, .065, depth * .74], [x, .22, 0], 0x7a919f, { metalness: .55, roughness: .4 }); for (const z of [-depth * .35, depth * .35]) box(group, [.16, .04, .16], [x, .03, z], 0x506879); }
  }
  function carton(group, position, size = [.75, .65, .65], tint = 0xd1ae83) {
    box(group, size, position, tint); box(group, [.06, .01, size[2] + .01], [position[0], position[1] + size[1] / 2 + .01, position[2]], 0xeee0c9);
    box(group, [size[0] * .4, size[1] * .25, .012], [position[0], position[1], position[2] + size[2] / 2 + .01], 0xf7f5ef);
    details.carton(group, position, size);
  }
  function buildFloor(floor) {
    const c = config[floor], root = new THREE.Group(); root.visible = false; scene.add(root); roots[floor] = root;
    const [width, depth] = c.size;
    details.floor(root, width, depth, `${floor}F`);
    box(root, [width, .25, depth], [0, -.2, 0], 0xdce5ed); box(root, [width - .4, .035, depth - .4], [0, -.05, 0], floor === '8' ? 0xe5efeb : 0xebeff3);
    box(root, [width, 1.2, .15], [0, .45, -depth / 2], 0xf7fafc); box(root, [.15, 1.2, depth], [-width / 2, .45, 0], 0xf7fafc);
    for (let x = -width / 2 + 2.5; x < width / 2; x += 4) box(root, [2.7, .5, .08], [x, .7, -depth / 2 + .09], 0xc9ddec);
    for (const x of [-3.6, 3.6]) { box(root, [.04, .01, depth - 2], [x, -.025, 0], 0xb9c9d5); for (let z = -depth / 2 + 2; z < depth / 2 - 1; z += 2) box(root, [.07, .01, .8], [x, -.019, z], 0xffffff); }
    if (floor === '8') {
      box(root, [15, .8, .15], [-4, .25, -12.5], 0xf7fafc); box(root, [.15, .8, 10], [2.6, .25, -10], 0xf7fafc);
      textPlane(root, '8F  /  PRODUCTION', 6, .6, [-4, .008, 17.5]);
      details.decal(root, 'A · 缝制区', 3.2, .65, [-8.5, .92, -18.9], [0, 0, 0], true);
      details.decal(root, '裁剪 · 备料', 3.2, .65, [7.8, .92, -18.9], [0, 0, 0], true);
    } else {
      textPlane(root, '4F  /  WAREHOUSE', 6, .6, [0, .008, 16]);
      for (const [i, x] of [-8, 0, 8].entries()) details.decal(root, `${'ABC'[i]} · 存储区`, 3, .65, [x, .82, -17.35], [0, 0, 0], true);
      for (const [x, tint] of [[-8, 0xc5dfd9], [0, 0xd9e3cc], [8, 0xe4d8c5]]) box(root, [6.5, .025, 6], [x, -.005, 12], tint);
      // Direction markers in the material-handling aisle.
      for (const z of [-9, -3, 3, 9]) for (const x of [-4, 4]) {
        const arrow = new THREE.Shape(); arrow.moveTo(-.25, -.35); arrow.lineTo(.25, -.35); arrow.lineTo(.25, .1); arrow.lineTo(.5, .1); arrow.lineTo(0, .6); arrow.lineTo(-.5, .1); arrow.lineTo(-.25, .1);
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(arrow), material(0x93aaa8)); mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = x < 0 ? 0 : Math.PI; mesh.position.set(x, .015, z); root.add(mesh);
      }
    }
    models[floor] = c.units.map((u, index) => {
      const group = new THREE.Group(); group.position.set(u.x, 0, u.z); root.add(group);
      const large = u.kind === 'cutting', rack = u.kind === 'rack';
      const pad = box(group, large ? [u.id === '裁床一区' ? 7.5 : 3.3, .04, u.id === '裁床一区' ? 3 : 5.8] : rack ? [4.8, .04, 2.9] : [3, .04, 2.4], [0, .005, 0], 0xdce7f1);
      const status = box(group, [rack ? 4.5 : 2.6, .04, .09], [0, .04, rack ? 1.4 : 1.13], 0x376be6);
      const moving = [], spinning = []; let needle = null, carriage = null, lifting = null;
      if (u.kind === 'sewing') {
        table(group); box(group, [1.08, .46, .34], [0, 1.18, -.1], 0xd1e1e9); box(group, [.15, .35, .25], [-.46, 1.03, -.04], 0xa4bfd0);
        box(group, [.45, .1, .5], [0, .99, .06], 0x7598b3); needle = box(group, [.025, .2, .025], [-.46, .95, .05], 0x415f78);
        carriage = new THREE.Group(); group.add(carriage); box(carriage, [.62, .02, .55], [-.35, .975, .28], 0xd4b49c);
        for (let i = 0; i < 5; i++) box(carriage, [.007, .006, .35], [-.55 + i * .095, .99, .28], 0xbfa282);
        const wheel = new THREE.Group(); wheel.position.set(.61, 1.19, -.09); group.add(wheel); const ring = new THREE.Mesh(new THREE.TorusGeometry(.18, .035, 8, 24), material(0x4b769b)); ring.rotation.y = Math.PI / 2; wheel.add(ring); box(wheel, [.035, .31, .035], [0, 0, 0], 0xe0e9ef); spinning.push(wheel);
        cylinder(group, .08, .22, [.35, 1.62, -.25], 0xb28a54); box(group, [.02, .3, .02], [.35, 1.46, -.25], 0x657a8e);
        box(group, [.5, .1, .5], [0, .47, .95], 0x94a9bb); box(group, [.06, .5, .06], [0, .22, .95], 0x8da3b4);
        details.sewing(group, index);
      } else if (u.kind === 'cutting') {
        const horizontal = u.id === '裁床一区'; table(group, horizontal ? 7 : 2.7, horizontal ? 2.5 : 5.3);
        box(group, [horizontal ? 6.7 : 2.4, .02, horizontal ? 2.1 : 4.9], [0, .98, 0], 0xd2c3ae);
        const cutter = new THREE.Group(); group.add(cutter); box(cutter, horizontal ? [.2, .35, 2.6] : [2.8, .35, .2], [0, 1.18, 0], 0x6889a8); box(cutter, [.32, .35, .32], [0, 1.4, 0], 0xd5e3ec); moving.push({ object: cutter, axis: horizontal ? 'x' : 'z', amount: horizontal ? 2.6 : 1.8 });
        details.cutting(group, horizontal);
      } else if (u.kind === 'rack') {
        for (const x of [-2.05, 2.05]) for (const z of [-1, 1]) box(group, [.1, 3.6, .1], [x, 1.8, z], 0x668db3);
        for (const y of [.3, 1.4, 2.5, 3.5]) { box(group, [4.3, .09, 2.2], [0, y, 0], 0xc6d2dc); if (y < 3.5) for (let k = 0; k < 4; k++) carton(group, [-1.5 + k, y + .36, .15], [.8, .6, .85], [0xc6a47b, 0xd4b895, 0xcbbfa9][index % 3]); }
        textPlane(group, u.id, 1.2, .18, [0, 3.48, 1.13], [0, 0, 0], '#456787');
        details.rack(group, index);
      } else if (['inbound', 'picking', 'shipping'].includes(u.kind)) {
        table(group, 2.5, 1.5); carton(group, [-.5, 1.29, .1], [.9, .65, .8]);
        const conveyor = box(group, [.45, .22, .5], [.55, 1.07, .1], 0x85a8c7); moving.push({ object: conveyor, axis: 'x', amount: .18, baseline: .55 });
        for (const x of [-.8, .8]) carton(group, [x, .36, 1.8], [.7, .6, .7]);
        textPlane(root, u.id, 3.2, .45, [u.x, .035, u.z + 2.2], [-Math.PI / 2, 0, 0], '#5b84ad');
        details.worker(group, [-.85, 0, .85], false, 0x4e7983);
        box(group, [.28, .32, .035], [.7, 1.22, -.38], 0x2d506a);
        box(group, [.2, .19, .01], [.7, 1.24, -.355], 0x8fb9b9);
      } else {
        table(group, 2.6, 1.55); box(group, [1.2, .025, .8], [0, .985, 0], u.kind === 'inspection' ? 0xc4e3d4 : 0xdabfa0);
        if (u.kind === 'packing') { carton(group, [.6, 1.22, -.05], [.75, .48, .65]); const slide = box(group, [.7, .02, .5], [-.55, .99, .1], 0xcfb394); moving.push({ object: slide, axis: 'x', amount: .12, baseline: -.55 }); }
        else { const arm = box(group, [.45, .05, .12], [0, 1.1, .1], 0x698dad); moving.push({ object: arm, axis: 'z', amount: .18, baseline: .1 }); }
        details.worker(group, [0, 0, 1.02], false, 0x628786);
      }
      group.traverse(child => { if (child.isMesh) child.userData.floorUnitId = u.id; });
      const label = document.createElement('button'); label.className = 'machine-label'; label.addEventListener('click', e => selectUnit(u.id, e.detail === 0));
      // Anchor to this model's centre, rather than the aisle in front of it.
      return { id: u.id, group, pad, status, label, needle, carriage, moving, spinning, anchor: new THREE.Vector3(0, rack ? 3.55 : 1, 0) };
    });
    labelSets[floor] = models[floor].map(m => m.label);
    if (floor === '4') {
      const cart = new THREE.Group(); root.add(cart); box(cart, [1.05, .4, 1.45], [0, .35, 0], 0x6e95bb); box(cart, [.9, .04, 1.25], [0, .59, 0], 0xe1e8ed); carton(cart, [0, .92, 0], [.8, .62, .9]);
      for (const x of [-.48, .48]) for (const z of [-.48, .48]) { const wheel = cylinder(cart, .14, .1, [x, .12, z], 0x6c7e8d); wheel.rotation.z = Math.PI / 2; }
      box(cart, [1, .09, .09], [0, .22, .75], 0x253f55);
      for (const x of [-.35, .35]) box(cart, [.12, .06, .02], [x, .37, .738], 0x83d9cb, { emissive: 0x83d9cb, emissiveIntensity: .8 });
      for (const x of [-.43, .43]) box(cart, [.04, .65, .05], [x, .91, -.56], 0x354e64);
      box(cart, [.9, .055, .055], [0, 1.25, -.56], 0x354e64);
      details.decal(cart, '搬运 · 演示', .65, .15, [0, .4, .759], [0, 0, 0], true);
      roots[floor].userData.cart = cart;
      const route = new THREE.CurvePath(), v = (x, z) => new THREE.Vector3(x, 0, z);
      route.add(new THREE.LineCurve3(v(-4, 9.8), v(-4, -5.8)));
      route.add(new THREE.QuadraticBezierCurve3(v(-4, -5.8), v(-4, -7), v(-2.8, -7)));
      route.add(new THREE.LineCurve3(v(-2.8, -7), v(2.8, -7)));
      route.add(new THREE.QuadraticBezierCurve3(v(2.8, -7), v(4, -7), v(4, -5.8)));
      route.add(new THREE.LineCurve3(v(4, -5.8), v(4, 9.8)));
      route.add(new THREE.QuadraticBezierCurve3(v(4, 9.8), v(4, 11), v(2.8, 11)));
      route.add(new THREE.LineCurve3(v(2.8, 11), v(-2.8, 11)));
      route.add(new THREE.QuadraticBezierCurve3(v(-2.8, 11), v(-4, 11), v(-4, 9.8)));
      root.userData.cartRoute = route;
    }
  }

return {config,roots,models,labelSets,buildFloor};
}
