// Hand-built miniature details. Visual decoration never changes demo quantities.
export function createSceneDetails({ THREE, box, cylinder, material }) {
  const textures = new Map();
  function decal(parent, text, width, height, position, rotation = [0, 0, 0], dark = false) {
    const key = `${text}:${dark}`;
    if (!textures.has(key)) {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = dark ? '#243b50' : '#f8faf9'; ctx.fillRect(0, 0, 512, 160);
      ctx.fillStyle = dark ? '#e5f0ef' : '#354e62'; ctx.font = '600 54px Microsoft YaHei, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, 256, 83);
      ctx.fillStyle = dark ? '#72c7bd' : '#adc2cd'; ctx.fillRect(46, 113, 420, 3);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.set(key, texture);
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: textures.get(key), side: THREE.DoubleSide }));
    mesh.position.set(...position); mesh.rotation.set(...rotation); parent.add(mesh); return mesh;
  }
  function tube(parent, points, radius = .015, tint = 0x566b7a) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, radius, 6, false), material(tint, { metalness: .45, roughness: .4 })); parent.add(mesh); return mesh;
  }
  function sphere(parent, radius, position, tint) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material(tint)); mesh.position.set(...position); mesh.castShadow = true; parent.add(mesh); return mesh;
  }
  function worker(parent, position, seated = false, tint = 0x416d77) {
    const person = new THREE.Group(); person.position.set(...position); parent.add(person);
    const base = seated ? .45 : .1;
    box(person, [.3, .4, .22], [0, base + .4, 0], tint);
    sphere(person, .14, [0, base + .77, 0], 0xd3ad8f);
    const hair = sphere(person, .145, [0, base + .83, .025], 0x39444c); hair.scale.y = .55;
    for (const x of [-.1, .1]) {
      box(person, [.12, seated ? .26 : .48, .13], [x, base + .05, seated ? -.12 : 0], 0x33485b);
      box(person, [.13, .08, .22], [x, seated ? .35 : .035, -.06], 0x283641);
      tube(person, [[x * 1.8, base + .55, 0], [x * 2, base + .32, -.18], [x * 1.4, base + .36, -.4]], .065, tint);
      sphere(person, .065, [x * 1.4, base + .36, -.42], 0xd3ad8f);
    }
    return person;
  }
  function floor(parent, width, depth, label) {
    box(parent, [width + .15, .13, depth + .15], [0, -.33, 0], 0x536b7b, { metalness: .22, roughness: .5 });
    for (let x = -width / 2 + 2; x < width / 2; x += 2) box(parent, [.012, .005, depth - .6], [x, .002, 0], 0xbac8cc);
    for (let z = -depth / 2 + 2; z < depth / 2; z += 2) box(parent, [width - .6, .005, .012], [0, .002, z], 0xbac8cc);
    decal(parent, `${label}  ·  ${label === '4F' ? '仓储中心' : '生产车间'}`, Math.min(width * .45, 8), .8, [0, -.22, depth / 2 + .081], [0, 0, 0], true);
    // Perimeter trim and regularly spaced wall posts make the cutaway readable.
    box(parent, [width, .07, .22], [0, 1.03, -depth / 2], 0x688491);
    box(parent, [.22, .07, depth], [-width / 2, 1.03, 0], 0x688491);
    for (let x = -width / 2 + .5; x < width / 2; x += 4) box(parent, [.13, 1.06, .22], [x, .5, -depth / 2 + .05], 0x9cb1bc);
  }
  function sewing(group, index) {
    box(group, [1.14, .09, .38], [0, 1.45, -.1], 0x345c6f, { roughness: .35, metalness: .25 });
    box(group, [.14, .22, .03], [-.46, 1.28, .145], 0x526d78);
    for (let i = 0; i < 4; i++) box(group, [.24, .014, .012], [.2, 1.16 + i * .04, .078], 0x728c99);
    cylinder(group, .045, .02, [-.3, 1.45, .03], 0xd7a64c);
    tube(group, [[.35, 1.7, -.25], [.15, 1.8, -.08], [-.46, 1.65, .06], [-.46, 1.05, .06]], .006, 0xd3ac71);
    box(group, [.38, .055, .27], [.64, .18, .05], 0x4e6473);
    tube(group, [[.61, 1.2, -.09], [.75, .55, -.18], [.64, .2, .05]], .012, 0x334d5c);
    for (let layer = 0; layer < 3; layer++) box(group, [.38, .025, .35], [.78, .99 + layer * .027, .3], [0x89a9b5, 0xc49b74, 0xdbc6a8][index % 3]);
    for (const x of [-.84, .84]) box(group, [.07, .035, .07], [x, .97, -.55], 0x7894a5, { metalness: .7, roughness: .3 });
    decal(group, 'SEW', .35, .12, [.16, 1.34, .076]);
    if (index % 3 !== 1) worker(group, [0, 0, .96], true, [0x47787d, 0x637b95, 0x9b836e][index % 3]);
  }
  function cutting(group, horizontal) {
    const width = horizontal ? 7 : 2.7, depth = horizontal ? 2.5 : 5.3;
    for (const z of [-depth / 2 + .04, depth / 2 - .04]) box(group, [width, .06, .055], [0, .96, z], 0x426a7e, { metalness: .6, roughness: .35 });
    for (let i = 0; i < 7; i++) box(group, [horizontal ? .012 : 2.1, .008, horizontal ? 2.1 : .012], [horizontal ? -2.5 + i * .8 : 0, 1, horizontal ? 0 : -1.8 + i * .6], 0xb09f85);
    box(group, [.42, .28, .2], [width / 2 + .16, 1.1, .1], 0x294b63);
    box(group, [.32, .16, .012], [width / 2 + .16, 1.14, .211], 0x72b8bc, { emissive: 0x72b8bc, emissiveIntensity: .15 });
    cylinder(group, .18, horizontal ? 2.1 : 2.2, [0, 1.16, -depth / 2 + .4], 0xd5c6ad).rotation.z = Math.PI / 2;
  }
  function rack(group, index) {
    for (const y of [.26, 1.36, 2.46]) {
      box(group, [4.3, .14, .06], [0, y, 1.12], 0xc69756, { metalness: .15, roughness: .48 });
      for (const x of [-2.03, 2.03]) box(group, [.18, .22, .18], [x, y + .07, 1], 0x3d607c);
    }
    for (const z of [-1, 1]) {
      const brace = box(group, [.035, 3.2, .035], [0, 1.8, z], 0x738da1, { metalness: .6 }); brace.rotation.z = .85;
      const opposite = box(group, [.035, 3.2, .035], [0, 1.8, z], 0x738da1, { metalness: .6 }); opposite.rotation.z = -.85;
    }
    decal(group, `${'ABC'[Math.floor(index / 4)]} · ${String(index % 4 + 1).padStart(2, '0')}`, .7, .26, [-1.55, 2.42, 1.16], [0, 0, 0], true);
  }
  function carton(parent, position, size) {
    const [x, y, z] = position, [w, h, d] = size;
    for (let i = 0; i < 7; i++) box(parent, [.012 + (i % 3) * .01, h * .13, .007], [x - w * .15 + i * w * .038, y - h * .005, z + d / 2 + .02], 0x4a5963);
    box(parent, [w * .18, h * .025, .008], [x, y - h * .07, z + d / 2 + .02], 0xaeb8bc);
  }
  function embroidery(group, index) {
    for (let j = 0; j < 6; j++) {
      const x = -1.48 + j * .59;
      tube(group, [[x, 1.96, -.46], [x, 2.04, -.15], [x, 1.54, .015], [x, 1.1, .055]], .005, [0xbd915e, 0x709daa, 0xbda177][j % 3]);
      for (let k = 0; k < 3; k++) box(group, [.22, .014, .018], [x, 1.35 + k * .05, .018], 0x8c9da8);
    }
    decal(group, `EMB · ${String(index + 1).padStart(2, '0')}`, .75, .16, [0, 1.48, -.3], [0, 0, 0], true);
    for (const x of [-1.45, 1.45]) box(group, [.11, .04, .06], [x, .91, .63], 0x648498, { metalness: .7 });
  }
  function mini(kind) {
    const rack = kind === 'rack', cut = kind === 'cutting';
    const drawing = rack ? '<path d="M39 22v65M137 22v65M39 26h98M39 47h98M39 68h98M39 86h98"/><path d="M50 29h24v15H50zm31 0h23v15H81zm29 0h18v15h-18zM50 50h30v15H50zm38 0h37v15H88zm-38 21h24v12H50zm33 0h42v12H83z" fill="#d3b48b" stroke="#ae9575"/>' : cut ? '<path d="M25 52l84-22 46 19-84 24z" fill="#e1d3bd"/><path d="M25 52v7l46 23 84-27v-6M36 65v20m101-26v21M72 78v18"/><path d="M55 44l44 22 12-4-44-22z" fill="#5b8391"/><path d="M85 42v-9l15 5v9"/>' : '<path d="M28 67h121v7H28zM40 74v22m97-22v22" fill="#becbd0"/><path d="M57 62V36h67v19h-15V46H75v16z" fill="#6e939e"/><path d="M69 55v10m-7 0h19m31-16h17"/><circle cx="128" cy="45" r="10"/><path d="M115 36v-8m-5-3h10v8h-10zM34 81h35M63 65h32"/>';
    const workbench = '<path d="M25 62l86-19 42 21-87 19z" fill="#dce6e7"/><path d="M25 62v8l41 22 87-20v-8M36 76v20m107-23v20M66 90v12"/><path d="M51 52V34l22-7 23 10v19l-23 7z" fill="#d3b48b" stroke="#ae9575"/><path d="M51 34l22 10 23-7M73 44v19" stroke="#ae9575"/><path d="M117 53V33h20v23" fill="#72939e"/><path d="M120 37h14v11h-14z" stroke="#dce6e7"/>';
    return `<svg class="unit-illustration" viewBox="0 0 176 112" fill="none" stroke="#426779" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${rack || cut || kind === 'sewing' ? drawing : workbench}</svg>`;
  }
  return { floor, sewing, cutting, rack, carton, embroidery, worker, decal, mini };
}
