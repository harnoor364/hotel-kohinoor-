// Hotel Kohinoor Palace — stylised 3D walkthrough built only from Three.js primitives.
// Exports createWorld(THREE, canvas, { tier, onProgress }) -> { render(p), resize(), degrade(), dispose() }
//
// Performance notes
// - One shadow-casting directional light, re-aimed per scene; shadow maps only re-render when that changes.
// - A small fixed pool of point lights is re-assigned each frame to the nearest "light anchors",
//   so the number of lights never changes and shaders compile once.
// - Repeated objects (windows, chairs, bottles, bulbs, trees) are InstancedMesh / Points.
// - Scene groups that the camera can't see are hidden.

import { locate, doorOpen, smooth } from './timeline.js';

export async function createWorld(THREE, canvas, { tier = 'high', onProgress = () => {}, strict = true } = {}) {
  const LOW = tier === 'low';
  const HIGH = tier === 'high';
  const PI = Math.PI;

  /* ---------------- Renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: HIGH, powerPreference: 'high-performance', stencil: false, alpha: false,
    failIfMajorPerformanceCaveat: strict && !LOW,
  });
  const maxPR = HIGH ? 2 : tier === 'mid' ? 1.5 : 1.25;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPR));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LOW ? 1.25 : 1.1;
  renderer.shadowMap.enabled = !LOW;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor('#0d0605');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0605');
  scene.fog = new THREE.Fog('#5a2a1e', 95, 330);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);

  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const rand = mulberry32(11);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Wait (briefly) for the serif font so painted signs use it
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('500 120px "Poppins"'),
        document.fonts.load('300 120px "Poppins"'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* fonts optional */ }
  onProgress(0.05);

  /* ---------------- Materials & helpers ---------------- */
  const matCache = new Map();
  function M(color, o = {}) {
    const key = (o.map || o.emissiveMap) ? null : color + '|' + JSON.stringify(o);
    if (key && matCache.has(key)) return matCache.get(key);
    const p = { color: new THREE.Color(color) };
    for (const k in o) if (!['basic', 'rough', 'metal', 'emissive'].includes(k)) p[k] = o[k];
    if (o.emissive && !o.basic) p.emissive = new THREE.Color(o.emissive);
    let m;
    if (o.basic) m = new THREE.MeshBasicMaterial(p);
    else if (LOW) { delete p.envMapIntensity; m = new THREE.MeshLambertMaterial(p); }
    else m = new THREE.MeshStandardMaterial({ roughness: o.rough ?? 0.75, metalness: o.metal ?? 0, ...p });
    if (key) matCache.set(key, m);
    return m;
  }

  const geoCache = new Map();
  const G = (key, fn) => { if (!geoCache.has(key)) geoCache.set(key, fn()); return geoCache.get(key); };
  const UB = new THREE.BoxGeometry(1, 1, 1);
  const seg = (n) => (LOW ? Math.max(6, Math.round(n * 0.6)) : n);

  function box(parent, mat, w, h, d, x, y, z, o = {}) {
    const m = new THREE.Mesh(UB, mat);
    m.scale.set(w, h, d); m.position.set(x, y, z);
    if (o.ry) m.rotation.y = o.ry;
    m.castShadow = !!o.cast; m.receiveShadow = o.receive !== false;
    parent.add(m); return m;
  }
  function cylGeo(rt, rb, n, open = false) { const s = seg(n); return G(`c${rt}_${rb}_${s}_${open}`, () => new THREE.CylinderGeometry(rt, rb, 1, s, 1, open)); }
  function cyl(parent, mat, rt, rb, h, x, y, z, n = 16, o = {}) {
    const m = new THREE.Mesh(cylGeo(rt, rb, n, o.open), mat);
    m.scale.y = h; m.position.set(x, y, z);
    if (o.rz) m.rotation.z = o.rz;
    if (o.rx) m.rotation.x = o.rx;
    m.castShadow = !!o.cast; m.receiveShadow = o.receive !== false;
    parent.add(m); return m;
  }
  function plane(parent, mat, w, h, x, y, z, rx = 0, ry = 0, o = {}) {
    const m = new THREE.Mesh(G(`p${w}_${h}`, () => new THREE.PlaneGeometry(w, h)), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
    m.receiveShadow = o.receive !== false;
    if (o.order) m.renderOrder = o.order;
    parent.add(m); return m;
  }
  const floor = (parent, mat, w, d, x, y, z) => plane(parent, mat, w, d, x, y, z, -PI / 2);
  const ceiling = (parent, mat, w, d, x, y, z) => plane(parent, mat, w, d, x, y, z, PI / 2, 0, { receive: false });

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  function inst(parent, geo, mat, list, o = {}) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      dummy.position.set(it.p[0], it.p[1], it.p[2]);
      dummy.rotation.set(it.r ? it.r[0] : 0, it.r ? it.r[1] : 0, it.r ? it.r[2] : 0);
      if (it.s) dummy.scale.set(it.s[0], it.s[1], it.s[2]); else dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      if (it.c) im.setColorAt(i, tmpColor.set(it.c));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = !!o.cast; im.receiveShadow = o.receive !== false;
    parent.add(im); return im;
  }

  /* ---------------- Canvas textures ---------------- */
  function canvasTex(w, h, draw, o = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.repeat[0], o.repeat[1]); }
    return t;
  }
  function rep(tex, rx, ry) { const t = tex.clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.needsUpdate = true; return t; }

  const glowTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, 'rgba(255,240,215,.85)');
    gr.addColorStop(0.45, 'rgba(255,205,150,.28)');
    gr.addColorStop(1, 'rgba(255,190,130,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });

  const marbleTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#efe5d3'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = rand() * w, y = rand() * h, r = 60 + rand() * 140;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(205,186,158,.28)'); gr.addColorStop(1, 'rgba(205,186,158,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
    const vein = (col, lw, n) => {
      g.strokeStyle = col; g.lineWidth = lw;
      for (let i = 0; i < n; i++) {
        g.beginPath();
        let x = rand() * w, y = 0; g.moveTo(x, y);
        while (y < h) { const nx = x + (rand() - 0.5) * 90, ny = y + 30 + rand() * 50; g.quadraticCurveTo(x + (rand() - 0.5) * 60, (y + ny) / 2, nx, ny); x = nx; y = ny; }
        g.stroke();
      }
    };
    vein('rgba(140,112,86,.32)', 1.3, 7);
    vein('rgba(186,146,78,.42)', 1, 4);
    g.strokeStyle = 'rgba(120,92,66,.55)'; g.lineWidth = 3; g.strokeRect(0, 0, w, h);
  });

  const medallionTex = canvasTex(512, 512, (g) => {
    g.translate(256, 256);
    const ring = (r, col) => { g.beginPath(); g.arc(0, 0, r, 0, PI * 2); g.fillStyle = col; g.fill(); };
    ring(256, '#b08a43'); ring(244, '#5a2520'); ring(226, '#e9dcc4'); ring(214, '#7a3b2e');
    g.fillStyle = '#c9a45c';
    g.beginPath();
    for (let i = 0; i < 32; i++) { const a = (i / 32) * PI * 2, r = i % 2 ? 90 : 205; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
    ring(90, '#efe5d3'); ring(72, '#5a2520'); ring(40, '#c9a45c');
  });

  const rugTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5a2520'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e6d6bb'; g.fillRect(14, 14, w - 28, h - 28);
    g.strokeStyle = '#b08a43'; g.lineWidth = 3; g.strokeRect(26, 26, w - 52, h - 52);
    g.strokeStyle = 'rgba(176,138,67,.5)'; g.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.ellipse(w / 2, h / 2, 20 + i * 14, 14 + i * 10, 0, 0, PI * 2); g.stroke(); }
  });

  const runnerTex = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#5a1f1c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c9a45c'; g.fillRect(8, 0, 4, h); g.fillRect(w - 12, 0, 4, h);
    g.fillStyle = '#3d1514'; g.fillRect(0, 0, 8, h); g.fillRect(w - 8, 0, 8, h);
    g.strokeStyle = 'rgba(201,164,92,.55)'; g.lineWidth = 2;
    for (let y = 0; y < h; y += 64) {
      g.beginPath(); g.moveTo(w / 2, y + 8); g.lineTo(w - 30, y + 32); g.lineTo(w / 2, y + 56); g.lineTo(30, y + 32); g.closePath(); g.stroke();
      g.fillStyle = 'rgba(201,164,92,.6)'; g.fillRect(w / 2 - 3, y + 29, 6, 6);
    }
  });

  const banqCarpetTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#4a1715'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(201,164,92,.5)'; g.lineWidth = 2;
    g.beginPath(); g.arc(w / 2, h / 2, 70, 0, PI * 2); g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * PI * 2;
      g.beginPath(); g.ellipse(w / 2 + Math.cos(a) * 42, h / 2 + Math.sin(a) * 42, 24, 9, a, 0, PI * 2); g.stroke();
    }
    g.fillStyle = 'rgba(201,164,92,.35)';
    [[0, 0], [w, 0], [0, h], [w, h]].forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 26, 0, PI * 2); g.fill(); });
  });

  const parquetTex = canvasTex(256, 256, (g, w, h) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 2 ? '#d9c4a0' : '#b8945e';
      g.fillRect(x * 64, y * 64, 64, 64);
    }
    g.strokeStyle = 'rgba(60,30,20,.35)'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
  });

  const plankTex = canvasTex(256, 256, (g, w, h) => {
    for (let i = 0; i < 8; i++) {
      const l = 22 + rand() * 10;
      g.fillStyle = `hsl(18, 38%, ${l}%)`; g.fillRect(0, i * 32, w, 32);
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, i * 32, w, 2);
      const off = rand() * w; g.fillRect(off, i * 32, 2, 32);
      g.strokeStyle = 'rgba(255,220,180,.05)';
      for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(0, i * 32 + 6 + k * 5); g.lineTo(w, i * 32 + 6 + k * 5 + (rand() - 0.5) * 6); g.stroke(); }
    }
  });

  const flutedTex = canvasTex(64, 16, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#1e0f0b'); gr.addColorStop(0.5, '#5a3222'); gr.addColorStop(1, '#1e0f0b');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  const drapeTex = canvasTex(256, 32, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 8; i++) gr.addColorStop(i / 8, i % 2 ? '#7a2a26' : '#3e1210');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  const lobbyWinTex = canvasTex(512, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#ffdca0'); gr.addColorStop(0.6, '#f4b768'); gr.addColorStop(1, '#c9853f');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      const x = 40 + rand() * (w - 80), y = 30 + rand() * 60;
      const rg = g.createRadialGradient(x, y, 0, x, y, 70);
      rg.addColorStop(0, 'rgba(255,250,230,.9)'); rg.addColorStop(1, 'rgba(255,250,230,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }
    g.fillStyle = 'rgba(90,40,25,.35)';
    for (let i = 0; i < 6; i++) g.fillRect(20 + rand() * (w - 60), h * 0.55 + rand() * 30, 30 + rand() * 40, h);
    g.fillStyle = '#2a140f';
    for (let x = 0; x <= w; x += 64) g.fillRect(x - 3, 0, 6, h);
    g.fillRect(0, h * 0.28, w, 5); g.fillRect(0, 0, w, 6); g.fillRect(0, h - 6, w, 6);
  });

  const roomWinTex = canvasTex(512, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3a1d1a'); gr.addColorStop(0.45, '#a8502c'); gr.addColorStop(0.75, '#f0a868'); gr.addColorStop(1, '#ffd29a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1e0f0d';
    let x = 0; while (x < w) { const bw = 20 + rand() * 50, bh = 30 + rand() * 90; g.fillRect(x, h - bh, bw, bh); x += bw + 2; }
    g.fillStyle = 'rgba(255,200,120,.85)';
    for (let i = 0; i < 70; i++) g.fillRect(rand() * w, h - rand() * 100, 3, 3);
    g.fillStyle = '#c9a45c'; g.fillRect(w / 2 - 3, 0, 6, h); g.fillRect(0, h * 0.35, w, 4);
  });

  const tvTex = canvasTex(256, 144, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#20100d'); gr.addColorStop(1, '#3a1c14');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(201,164,92,.7)'; g.font = '300 20px "Poppins", sans-serif'; g.textAlign = 'center';
    g.fillText('Welcome, Guest', w / 2, h / 2 + 7);
  });

  const barGlowTex = canvasTex(512, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3a1608'); gr.addColorStop(0.5, '#e08a3a'); gr.addColorStop(1, '#5a240c');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const rg = g.createLinearGradient(0, 0, w, 0);
    rg.addColorStop(0, 'rgba(0,0,0,.6)'); rg.addColorStop(0.5, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,.6)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  });

  function textTex(w, h, draw) {
    const t = canvasTex(w, h, (g) => { g.clearRect(0, 0, w, h); g.textAlign = 'center'; g.textBaseline = 'middle'; draw(g); });
    return t;
  }
  const signTex = textTex(1024, 192, (g) => {
    g.font = '500 104px "Poppins", sans-serif';
    g.shadowColor = 'rgba(255,190,110,.9)'; g.shadowBlur = 26;
    g.fillStyle = '#ffe2b0'; g.fillText('KOHINOOR PALACE', 512, 100);
    g.shadowBlur = 6; g.fillStyle = '#fff6e6'; g.fillText('KOHINOOR PALACE', 512, 100);
  });
  const fasciaTex = textTex(1024, 96, (g) => {
    g.font = '600 50px "Poppins", sans-serif';
    g.shadowColor = 'rgba(255,190,90,.9)'; g.shadowBlur = 12;
    g.fillStyle = '#f2d398'; g.fillText('H O T E L   K O H I N O O R   P A L A C E', 512, 50);
  });
  const logoTex = textTex(1024, 300, (g) => {
    g.strokeStyle = '#d9b876'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(512, 18); g.lineTo(552, 58); g.lineTo(512, 110); g.lineTo(472, 58); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(472, 58); g.lineTo(552, 58); g.stroke();
    g.font = '400 92px "Poppins", sans-serif';
    g.fillStyle = '#e8cf95'; g.shadowColor = 'rgba(255,200,120,.5)'; g.shadowBlur = 10;
    g.fillText('KOHINOOR', 512, 182);
    g.font = '600 30px "Poppins", sans-serif'; g.shadowBlur = 0; g.fillStyle = '#d9b876';
    g.fillText('R E C E P T I O N   ·   2 4   H O U R S', 512, 262);
  });
  const grooveTex = textTex(1024, 256, (g) => {
    g.font = '300 150px "Poppins", sans-serif';
    g.shadowColor = 'rgba(255,150,50,1)'; g.shadowBlur = 30;
    g.fillStyle = '#ffc36e'; g.fillText('GROOVE', 512, 110);
    g.shadowBlur = 6; g.fillStyle = '#fff0cc'; g.fillText('GROOVE', 512, 110);
    g.font = '600 38px "Poppins", sans-serif'; g.shadowBlur = 10; g.fillStyle = '#f2c27a';
    g.fillText('R E S T O B A R', 512, 212);
  });
  const plateTex = textTex(128, 64, (g) => {
    g.fillStyle = '#c9a45c'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#2a140f'; g.font = '600 38px "Poppins", sans-serif'; g.fillText('108', 64, 34);
  });
  onProgress(0.2);

  /* ---------------- Glows ---------------- */
  const spriteMats = new Map();
  function glow(parent, x, y, z, sx, color = '#ffcf8a', opacity = 1, sy = sx) {
    const key = color + opacity;
    if (!spriteMats.has(key)) spriteMats.set(key, new THREE.SpriteMaterial({ map: glowTex, color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    const s = new THREE.Sprite(spriteMats.get(key));
    s.position.set(x, y, z); s.scale.set(sx, sy, 1); s.renderOrder = 3;
    parent.add(s); return s;
  }
  function glowPoints(parent, pts, size, color = '#ffd08a', opacity = 1) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.PointsMaterial({ map: glowTex, color, size, sizeAttenuation: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const p = new THREE.Points(g, m); p.renderOrder = 3;
    parent.add(p); return p;
  }

  /* ---------------- Light anchors + pool ---------------- */
  const anchors = [];
  function anchor(group, x, y, z, color, intensity, distance, reach) {
    anchors.push({ group, local: new THREE.Vector3(x, y, z), world: new THREE.Vector3(), color: new THREE.Color(color), intensity, distance, reach });
  }
  const POOL = LOW ? 2 : 4;
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const l = new THREE.PointLight('#ffffff', 0, 10, 2);
    scene.add(l); pool.push(l);
  }
  const hemi = new THREE.HemisphereLight('#ffffff', '#000000', 0.5);
  scene.add(hemi);
  const key = new THREE.DirectionalLight('#ffffff', 1);
  key.castShadow = !LOW;
  key.shadow.mapSize.set(HIGH ? 1024 : 512, HIGH ? 1024 : 512);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.03;
  scene.add(key); scene.add(key.target);

  /* ---------------- Groups ---------------- */
  const groups = {};
  ['ext', 'lobby', 'corr', 'room', 'banq', 'bar'].forEach((k) => { const g = new THREE.Group(); g.name = k; groups[k] = g; scene.add(g); });
  const BX = 140, GX = 280; // banquet and restobar sets sit away from the hotel
  groups.banq.position.x = BX;
  groups.bar.position.x = GX;

  /* ---------------- Shared materials ---------------- */
  const goldMetal = M('#c9a45c', { rough: 0.32, metal: 0.75 });
  const goldGlow = M('#ffd58a', { basic: true });
  const warmLight = M('#ffe2ad', { basic: true });
  const cream = M('#efe3cf', { rough: 0.85 });
  const maroon = M('#5b4436', { rough: 0.75 });
  const velvet = M('#8a7b70', { rough: 0.95 });
  const darkWood = M('#3a1d15', { rough: 0.55 });
  const blackGloss = M('#141010', { rough: 0.25 });

  /* ================= EXTERIOR ================= */
  function buildExterior(g) {
    // Sky dome with a dusk gradient (vertex colours)
    const skyGeo = new THREE.SphereGeometry(520, 32, 16);
    const stops = [[-1, '#2a120e'], [-0.02, '#7a3420'], [0.02, '#d27a45'], [0.08, '#c4643a'], [0.18, '#6e2a1e'], [0.38, '#2c1312'], [0.7, '#140a0b'], [1, '#0b0607']];
    const sc = [], ca = new THREE.Color(), cb = new THREE.Color();
    const sp = skyGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const y = sp.getY(i) / 520;
      let k = 0; while (k < stops.length - 2 && y > stops[k + 1][0]) k++;
      const [y0, c0] = stops[k], [y1, c1] = stops[k + 1];
      const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
      ca.set(c0).lerp(cb.set(c1), t);
      sc.push(ca.r, ca.g, ca.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10; g.add(sky);

    // Stars
    const stars = [];
    for (let i = 0; i < 260; i++) {
      const th = rand() * PI * 2, ph = 0.28 + rand() * 1.1;
      stars.push(Math.cos(th) * Math.cos(ph) * 480, Math.sin(ph) * 480, Math.sin(th) * Math.cos(ph) * 480);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    g.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#f3e3c3', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.75, fog: false, depthWrite: false })));

    // Ground, forecourt, road
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), M('#24180f', { rough: 1 }));
    ground.rotation.x = -PI / 2; ground.receiveShadow = true; g.add(ground);
    floor(g, M('#6b5848', { rough: 0.9 }), 42, 22, 0, 0.02, 11);
    floor(g, M('#1a1514', { rough: 0.95 }), 900, 12, 0, 0.03, 28.5);
    floor(g, M('#3a2e27', { rough: 0.95 }), 900, 8, 0, 0.02, 38.6);
    floor(g, M('#5a1f1c', { rough: 0.9 }), 2.4, 8, 0, 0.04, 3.6); // red carpet to the door
    const kerb = M('#8a7a68', { rough: 0.9 });
    box(g, kerb, 900, 0.18, 0.35, 0, 0.09, 22.4);
    box(g, kerb, 900, 0.18, 0.35, 0, 0.09, 34.6);
    const dashes = [];
    for (let i = 0; i < 60; i++) dashes.push({ p: [-240 + i * 8, 0.045, 28.5], s: [3, 0.02, 0.16] });
    inst(g, UB, M('#8e8574', { basic: true }), dashes);

    // Building shell
    const stone = M('#d8c4a3', { rough: 0.85 });
    const trim = M('#4a2219', { rough: 0.7 });
    box(g, stone, 32, 18.5, 0.6, 0, 15.25, -0.3, { cast: true });
    box(g, stone, 13.4, 6, 0.6, -9.3, 3, -0.3, { cast: true });
    box(g, stone, 13.4, 6, 0.6, 9.3, 3, -0.3, { cast: true });
    box(g, stone, 5.2, 1.8, 0.6, 0, 5.1, -0.3);
    box(g, stone, 0.6, 24.5, 56, -15.7, 12.25, -28, { cast: true });
    box(g, stone, 0.6, 24.5, 56, 15.7, 12.25, -28, { cast: true });
    box(g, stone, 32, 24.5, 0.6, 0, 12.25, -55.7);
    box(g, trim, 32.6, 0.6, 56.6, 0, 24.8, -28);
    box(g, trim, 33, 1.4, 1.2, 0, 25.6, 0.1, { cast: true });
    box(g, goldGlow, 33.05, 0.07, 0.07, 0, 24.95, 0.72);
    box(g, goldGlow, 33.05, 0.07, 0.07, 0, 26.28, 0.72);
    for (let k = 0; k <= 5; k++) {
      const y = 6 + k * 3.5;
      box(g, trim, 32.3, 0.32, 0.5, 0, y, 0.1);
      box(g, trim, 0.5, 0.32, 56.3, 16.1, y, -28);
      box(g, trim, 0.5, 0.32, 56.3, -16.1, y, -28);
    }
    const fins = [];
    for (let i = 0; i <= 8; i++) fins.push({ p: [-14 + i * 3.5, 14.75, 0.15], s: [0.3, 17.5, 0.6] });
    inst(g, UB, trim, fins, { cast: true });

    // Lit windows (one instanced mesh for all upper floors)
    const wins = [];
    const palette = ['#e8b46a', '#e0a250', '#d4923e', '#f0c482', '#e6ad5c'];
    const pick = () => (rand() < 0.2 ? '#2a1a16' : palette[Math.floor(rand() * palette.length)]);
    for (let k = 0; k < 5; k++) {
      const y = 6 + k * 3.5 + 1.85;
      for (let i = 0; i < 8; i++) wins.push({ p: [-12.25 + i * 3.5, y, 0.02], s: [2.9, 2.3, 1], c: pick() });
      for (let j = 0; j < 12; j++) {
        const z = -4.5 - j * 4.2;
        wins.push({ p: [16.02, y, z], r: [0, PI / 2, 0], s: [3, 2.3, 1], c: pick() });
        wins.push({ p: [-16.02, y, z], r: [0, -PI / 2, 0], s: [3, 2.3, 1], c: pick() });
      }
    }
    inst(g, G('p1', () => new THREE.PlaneGeometry(1, 1)), M('#ffffff', { basic: true }), wins, { receive: false });

    // Ground-floor glazing either side of the entrance
    const gwin = M('#ffffff', { basic: true, map: rep(lobbyWinTex, 1.5, 1) });
    plane(g, gwin, 11.2, 3.9, -9.1, 2.55, 0.02, 0, 0, { receive: false });
    plane(g, gwin, 11.2, 3.9, 9.1, 2.55, 0.02, 0, 0, { receive: false });
    const sideWin = M('#ffffff', { basic: true, map: rep(lobbyWinTex, 4, 1) });
    plane(g, sideWin, 40, 3.4, 16.02, 2.4, -26, 0, PI / 2, { receive: false });
    plane(g, sideWin, 40, 3.4, -16.02, 2.4, -26, 0, -PI / 2, { receive: false });

    // Entrance frame
    box(g, goldMetal, 0.22, 4.25, 0.7, -2.7, 2.12, 0);
    box(g, goldMetal, 0.22, 4.25, 0.7, 2.7, 2.12, 0);
    box(g, goldMetal, 5.6, 0.22, 0.7, 0, 4.25, 0);
    box(g, M('#8a7a68', { rough: 0.6 }), 7, 0.12, 1.4, 0, 0.06, 0.7);

    // Canopy
    box(g, M('#2e1714', { rough: 0.6 }), 12, 0.35, 7.2, 0, 4.82, 3.6, { cast: true });
    box(g, trim, 12.2, 0.8, 0.25, 0, 4.75, 7.2);
    plane(g, M('#ffffff', { basic: true, map: fasciaTex, transparent: true, toneMapped: false }), 9, 0.84, 0, 4.75, 7.34, 0, 0, { receive: false, order: 2 });
    box(g, goldGlow, 12.25, 0.05, 0.05, 0, 5.16, 7.34);
    box(g, goldGlow, 12.25, 0.05, 0.05, 0, 4.34, 7.34);
    const downs = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) downs.push({ p: [-4.2 + i * 2.8, 4.63, 2 + j * 3.4], r: [PI / 2, 0, 0], s: [1, 1, 1] });
    inst(g, G('circ', () => new THREE.CircleGeometry(0.22, 16)), warmLight, downs, { receive: false });
    cyl(g, goldMetal, 0.2, 0.2, 4.6, -5.6, 2.3, 6.7, 14, { cast: true });
    cyl(g, goldMetal, 0.2, 0.2, 4.6, 5.6, 2.3, 6.7, 14, { cast: true });
    // planters by the door
    [-3.8, 3.8].forEach((x) => {
      cyl(g, M('#3a2a22', { rough: 0.6 }), 0.45, 0.35, 0.8, x, 0.4, 1.2, 14, { cast: true });
      const bush = new THREE.Mesh(G('ico', () => new THREE.IcosahedronGeometry(1, 1)), M('#2f4226', { rough: 0.9 }));
      bush.position.set(x, 1.25, 1.2); bush.scale.set(0.6, 0.7, 0.6); bush.castShadow = true; g.add(bush);
    });

    // Rooftop sign
    plane(g, M('#ffffff', { basic: true, map: signTex, transparent: true, toneMapped: false, fog: false }), 16, 3, 0, 27.9, 0.4, 0, 0, { receive: false, order: 2 });
    glow(g, 0, 27.8, 0.1, 26, '#ff9a40', 0.32, 7);

    // Trees
    const trunks = [], crowns = [];
    const treeAt = (x, z, s) => {
      trunks.push({ p: [x, 1.1 * s, z], s: [s, 2.2 * s, s] });
      crowns.push({ p: [x, 3.2 * s, z], s: [1.5 * s, 1.9 * s, 1.5 * s], r: [0, rand() * PI, 0] });
    };
    [3, 9, 15].forEach((z) => { treeAt(-19.5, z, 1); treeAt(19.5, z, 1); });
    for (let x = -75; x <= 75; x += 15) treeAt(x + (rand() - 0.5) * 3, 41, 0.9 + rand() * 0.3);
    [-24, -32, -40].forEach((z) => { treeAt(-22, z, 1.1); treeAt(22, z, 1.1); });
    inst(g, cylGeo(0.12, 0.16, 7), M('#3a2618', { rough: 1 }), trunks);
    inst(g, G('ico0', () => new THREE.IcosahedronGeometry(1, 0)), M('#2c3a22', { rough: 0.95 }), crowns, { cast: true });

    // Street lamps + bollards (glow only, no real lights)
    const lampGlows = [];
    [-54, -36, -18, 18, 36, 54].forEach((x) => {
      cyl(g, trim, 0.07, 0.09, 6, x, 3, 22.9, 8);
      box(g, trim, 0.08, 0.08, 1.5, x, 6, 23.6);
      box(g, warmLight, 0.45, 0.1, 0.3, x, 5.95, 24.3);
      lampGlows.push(x, 5.8, 24.3);
    });
    glowPoints(g, lampGlows, 3.2, '#ffc070', 0.9);
    const bollards = [];
    const bglow = [];
    for (let z = 9; z <= 21; z += 4) [-6.5, 6.5].forEach((x) => { bollards.push({ p: [x, 0.4, z], s: [1, 0.8, 1] }); bglow.push(x, 0.85, z); });
    inst(g, cylGeo(0.12, 0.12, 8), trim, bollards);
    glowPoints(g, bglow, 0.9, '#ffcf8a', 1);
    glowPoints(g, [-4.2, 4.3, 2, -1.4, 4.3, 2, 1.4, 4.3, 2, 4.2, 4.3, 2, -4.2, 4.3, 5.4, -1.4, 4.3, 5.4, 1.4, 4.3, 5.4, 4.2, 4.3, 5.4], 1.1, '#ffe0a8', 0.9);

    // Distant skyline silhouettes
    const sky1 = [];
    const skyDots = [];
    for (let i = 0; i < 34; i++) {
      const x = -340 + i * 20 + rand() * 8, h = 10 + rand() * 46, w = 12 + rand() * 16, z = -170 - rand() * 50;
      sky1.push({ p: [x, h / 2, z], s: [w, h, 10] });
      for (let k = 0; k < 4; k++) skyDots.push(x + (rand() - 0.5) * w * 0.8, 3 + rand() * (h - 4), z + 5.2);
    }
    inst(g, UB, M('#1e110e', { basic: true }), sky1, { receive: false });
    const sd = glowPoints(g, skyDots, 2.2, '#ffb868', 0.55);
    sd.material.fog = true;

    anchor('ext', 0, 4.0, 4.2, '#ffc078', 40, 26, 160);
    anchor('ext', 0, 26.5, 5, '#ffb45a', 70, 30, 200);
    anchor('ext', 0, 7, 16, '#ffcf98', 18, 26, 120);
  }

  /* ================= LOBBY ================= */
  function buildLobby(g) {
    const zc = -9.35, D = 17.5;
    const marble = M('#ffffff', { map: rep(marbleTex, 5, 4.4), rough: 0.2 });
    floor(g, marble, 20, D, 0, 0.03, zc);
    const med = new THREE.Mesh(G('med', () => new THREE.CircleGeometry(3, seg(48))), M('#ffffff', { map: medallionTex, rough: 0.25 }));
    med.rotation.x = -PI / 2; med.position.set(0, 0.04, -8); med.receiveShadow = true; g.add(med);
    ceiling(g, cream, 20, D, 0, 6, zc);
    box(g, M('#e3d2b6', { rough: 0.9 }), 12, 0.3, 8, 0, 5.85, -8, { receive: false });
    [[12.1, 0.05, 0.05, 0, 5.68, -4], [12.1, 0.05, 0.05, 0, 5.68, -12], [0.05, 0.05, 8.1, -6.05, 5.68, -8], [0.05, 0.05, 8.1, 6.05, 5.68, -8]]
      .forEach((b) => box(g, warmLight, ...b, { receive: false }));

    const wall = M('#ecdfc9', { rough: 0.9 });
    box(g, wall, 0.3, 6, D, -10.15, 3, zc);
    box(g, wall, 0.3, 6, D, 10.15, 3, zc);
    box(g, wall, 1.3, 6, 0.3, -9.65, 3, -18.25);
    box(g, wall, 16.3, 6, 0.3, 2.15, 3, -18.25);
    box(g, wall, 3, 2.8, 0.3, -7.5, 4.6, -18.25);
    // wainscot and gold rail
    [-9.97, 9.97].forEach((x) => {
      box(g, maroon, 0.06, 1.2, D, x, 0.6, zc);
      box(g, goldMetal, 0.08, 0.06, D, x, 1.23, zc);
    });
    // arch trim around corridor opening
    box(g, goldMetal, 0.14, 3.3, 0.36, -9.05, 1.65, -18.08);
    box(g, goldMetal, 0.14, 3.3, 0.36, -5.95, 1.65, -18.08);
    box(g, goldMetal, 3.24, 0.14, 0.36, -7.5, 3.25, -18.08);

    // Reception feature wall
    box(g, maroon, 11, 4.4, 0.1, 0, 2.9, -18.05);
    [[11.2, 0.08, 0.08, 0, 5.12, -17.98], [11.2, 0.08, 0.08, 0, 0.68, -17.98], [0.08, 4.5, 0.08, -5.56, 2.9, -17.98], [0.08, 4.5, 0.08, 5.56, 2.9, -17.98]]
      .forEach((b) => box(g, goldMetal, ...b));
    plane(g, M('#ffffff', { basic: true, map: logoTex, transparent: true }), 6.4, 1.9, 0, 3.4, -17.97, 0, 0, { receive: false });
    // Desk
    const deskWood = M('#4a1f17', { rough: 0.45 });
    box(g, deskWood, 8, 1.1, 1, 0, 0.55, -14, { cast: true });
    box(g, goldMetal, 7.9, 0.04, 0.02, 0, 0.32, -13.49);
    box(g, goldMetal, 7.9, 0.04, 0.02, 0, 0.88, -13.49);
    for (let i = -3; i <= 3; i++) box(g, goldMetal, 0.03, 0.5, 0.02, i * 1.1, 0.6, -13.49);
    const deskTop = M('#efe6d6', { rough: 0.18 });
    box(g, deskTop, 8.4, 0.08, 1.25, 0, 1.14, -14, { cast: true });
    box(g, deskWood, 8, 0.25, 0.35, 0, 1.3, -13.62, { cast: true });
    box(g, deskTop, 8.1, 0.05, 0.42, 0, 1.45, -13.62);
    box(g, deskWood, 9, 0.9, 0.5, 0, 0.45, -17.75);
    [-3, 3].forEach((x) => {
      cyl(g, goldMetal, 0.05, 0.08, 0.4, x, 1.68, -14.1, 10);
      cyl(g, warmLight, 0.14, 0.18, 0.2, x, 1.95, -14.1, 12);
      glow(g, x, 1.95, -14.1, 1.2, '#ffd59a', 0.8);
    });
    // flowers on desk
    cyl(g, goldMetal, 0.12, 0.09, 0.3, 2, 1.62, -13.7, 12);
    const fl = new THREE.Mesh(G('ico', () => new THREE.IcosahedronGeometry(1, 1)), M('#8a2430', { rough: 0.8 }));
    fl.position.set(2, 1.95, -13.7); fl.scale.setScalar(0.24); g.add(fl);

    // Chandelier
    const cx = 0, cz = -8;
    cyl(g, goldMetal, 0.03, 0.03, 0.8, cx, 5.55, cz, 6);
    cyl(g, goldMetal, 0.25, 0.08, 0.35, cx, 5.05, cz, 14);
    const beads = [];
    [[1.15, 4.85, 26], [0.85, 4.55, 20], [0.55, 4.28, 14], [0.25, 4.05, 8]].forEach(([r, y, n]) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        beads.push({ p: [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r], s: [0.07, 0.11, 0.07] });
        beads.push({ p: [cx + Math.cos(a) * r, y - 0.18, cz + Math.sin(a) * r], s: [0.04, 0.07, 0.04] });
      }
    });
    inst(g, G('oct', () => new THREE.OctahedronGeometry(1, 0)), M('#fff1d0', { basic: true }), beads, { receive: false });
    [[1.15, 4.85], [0.85, 4.55], [0.55, 4.28]].forEach(([r, y]) => {
      const ring = new THREE.Mesh(G(`tor${r}`, () => new THREE.TorusGeometry(r, 0.025, 6, seg(40))), goldMetal);
      ring.rotation.x = PI / 2; ring.position.set(cx, y + 0.06, cz); g.add(ring);
    });
    glow(g, cx, 4.5, cz, 4.2, '#ffd9a0', 0.75);
    glow(g, cx, 4.5, cz, 1.6, '#fff4dd', 0.9);

    // Columns
    [[-6.5, -4], [6.5, -4], [-6.5, -12.5], [6.5, -12.5]].forEach(([x, z]) => {
      box(g, goldMetal, 0.95, 0.35, 0.95, x, 0.175, z, { cast: true });
      cyl(g, M('#efe5d3', { rough: 0.35 }), 0.36, 0.38, 5.3, x, 3.0, z, 16, { cast: true });
      box(g, goldMetal, 0.95, 0.3, 0.95, x, 5.8, z);
    });

    // Lounge (left)
    floor(g, M('#ffffff', { map: rugTex, rough: 0.95 }), 3.8, 4.6, -7.4, 0.045, -8.2);
    box(g, velvet, 0.9, 0.45, 2.6, -8.9, 0.25, -8.2, { cast: true });
    box(g, velvet, 0.22, 0.6, 2.6, -9.3, 0.75, -8.2, { cast: true });
    box(g, velvet, 0.9, 0.62, 0.2, -8.9, 0.36, -9.4, { cast: true });
    box(g, velvet, 0.9, 0.62, 0.2, -8.9, 0.36, -7.0, { cast: true });
    box(g, M('#e6d6bb', { rough: 0.95 }), 0.5, 0.35, 0.5, -9.05, 0.68, -8.85);
    box(g, M('#e6d6bb', { rough: 0.95 }), 0.5, 0.35, 0.5, -9.05, 0.68, -7.55);
    cyl(g, goldMetal, 0.08, 0.12, 0.36, -7.3, 0.18, -8.2, 10);
    cyl(g, deskTop, 0.6, 0.6, 0.05, -7.3, 0.4, -8.2, 24, { cast: true });
    armchair(g, -5.6, -7.2, -PI / 2 - 0.3, velvet);
    armchair(g, -5.6, -9.2, -PI / 2 + 0.3, velvet);
    // Lounge (right)
    armchair(g, 8.2, -6.8, PI / 2, M('#e6d6bb', { rough: 0.95 }));
    armchair(g, 8.2, -9.6, PI / 2, M('#e6d6bb', { rough: 0.95 }));
    cyl(g, goldMetal, 0.35, 0.35, 0.5, 8.3, 0.25, -8.2, 16);
    // Plants
    [[9.2, -16.8], [3.7, -1.4], [-3.7, -1.4], [9.3, -1.4]].forEach(([x, z]) => plant(g, x, z, 1));
    // Sconces
    const sc = [];
    [-4, -8, -12, -16].forEach((z) => [-9.93, 9.93].forEach((x) => {
      box(g, goldMetal, 0.08, 0.36, 0.18, x, 3.4, z);
      sc.push(x + Math.sign(-x) * 0.12, 3.55, z);
    }));
    glowPoints(g, sc, 1.1, '#ffcf8a', 0.85);
    floor(g, M('#2a1612', { rough: 1 }), 4, 1.8, 0, 0.04, -1.6);

    anchor('lobby', 0, 4.2, -8, '#ffd8a0', 45, 22, 30);
    anchor('lobby', 0, 3.6, -15.8, '#ffc98a', 16, 10, 26);
    anchor('lobby', -7.2, 3.2, -8.2, '#ffcf98', 10, 9, 20);
    anchor('lobby', 7.2, 3.2, -8.2, '#ffcf98', 10, 9, 20);
  }

  function armchair(g, x, z, ry, mat) {
    const a = new THREE.Group(); a.position.set(x, 0, z); a.rotation.y = ry;
    box(a, mat, 0.8, 0.42, 0.78, 0, 0.25, 0, { cast: true });
    box(a, mat, 0.8, 0.6, 0.16, 0, 0.72, -0.33, { cast: true });
    box(a, mat, 0.14, 0.58, 0.78, -0.37, 0.35, 0, { cast: true });
    box(a, mat, 0.14, 0.58, 0.78, 0.37, 0.35, 0, { cast: true });
    box(a, goldMetal, 0.7, 0.04, 0.6, 0, 0.03, 0);
    g.add(a); return a;
  }
  function plant(g, x, z, s) {
    cyl(g, M('#3a1d15', { rough: 0.5 }), 0.32 * s, 0.24 * s, 0.6 * s, x, 0.3 * s, z, 12, { cast: true });
    box(g, goldMetal, 0.66 * s, 0.04, 0.66 * s, x, 0.6 * s, z);
    const leaf = new THREE.Mesh(G('ico0', () => new THREE.IcosahedronGeometry(1, 0)), M('#2f4426', { rough: 0.9 }));
    leaf.position.set(x, 1.3 * s, z); leaf.scale.set(0.55 * s, 0.85 * s, 0.55 * s); leaf.rotation.y = rand() * PI; leaf.castShadow = true;
    g.add(leaf);
  }

  /* ================= CORRIDOR ================= */
  let doorPivot;
  function buildCorridor(g) {
    const len = 22.6, zc = -29.7;
    floor(g, M('#ffffff', { map: rep(runnerTex, 1, 7.5), rough: 1 }), 3, len, -7.5, 0.03, zc);
    ceiling(g, M('#efe5d6', { rough: 0.9 }), 3, len, -7.5, 3.2, zc);
    const wall = M('#eadcc4', { rough: 0.9 });
    box(g, wall, 0.3, 3.2, len, -9.15, 1.6, zc);
    box(g, wall, 0.3, 3.2, len, -5.85, 1.6, zc);
    [-8.98, -6.02].forEach((x) => {
      box(g, maroon, 0.05, 1, len, x, 0.5, zc);
      box(g, goldMetal, 0.07, 0.05, len, x, 1.02, zc);
      box(g, goldMetal, 0.05, 0.05, len, x, 2.95, zc);
    });
    const frameMat = M('#e3d2b6', { rough: 0.7 });
    [-23, -29, -35].forEach((z, i) => {
      [[-8.99, 1], [-6.01, -1]].forEach(([x, s]) => {
        box(g, frameMat, 0.06, 2.4, 1.3, x, 1.2, z);
        box(g, darkWood, 0.06, 2.2, 1.06, x + s * 0.03, 1.1, z);
        box(g, goldMetal, 0.05, 0.05, 0.16, x + s * 0.08, 1.05, z + 0.36);
        box(g, goldMetal, 0.03, 0.12, 0.22, x + s * 0.07, 1.65, z);
      });
    });
    const sconce = [];
    [-20.2, -26, -32, -38].forEach((z) => [-8.95, -6.05].forEach((x) => {
      box(g, goldMetal, 0.08, 0.32, 0.16, x, 2.05, z);
      sconce.push(x + (x < -7.5 ? 0.14 : -0.14), 2.2, z);
    }));
    glowPoints(g, sconce, 0.9, '#ffcf8a', 0.9);
    const downs = [];
    for (let z = -20; z >= -39; z -= 3) downs.push({ p: [-7.5, 3.19, z], r: [PI / 2, 0, 0] });
    inst(g, G('circ', () => new THREE.CircleGeometry(0.22, 16)), warmLight, downs, { receive: false });

    // Door at the end of the corridor (opens into the room)
    box(g, frameMat, 0.12, 2.42, 0.36, -8.18, 1.21, -40.95);
    box(g, frameMat, 0.12, 2.42, 0.36, -6.82, 1.21, -40.95);
    box(g, frameMat, 1.48, 0.12, 0.36, -7.5, 2.36, -40.95);
    doorPivot = new THREE.Group();
    doorPivot.position.set(-8.1, 0, -41.0);
    box(doorPivot, darkWood, 1.2, 2.3, 0.07, 0.6, 1.15, 0);
    box(doorPivot, M('#4a2a1c', { rough: 0.5 }), 0.9, 0.9, 0.02, 0.6, 1.65, 0.045);
    box(doorPivot, M('#4a2a1c', { rough: 0.5 }), 0.9, 0.8, 0.02, 0.6, 0.6, 0.045);
    box(doorPivot, goldMetal, 0.16, 0.05, 0.06, 1.02, 1.05, 0.07);
    plane(doorPivot, M('#ffffff', { basic: true, map: plateTex }), 0.26, 0.13, 0.6, 1.95, 0.06, 0, 0, { receive: false });
    g.add(doorPivot);

    anchor('corr', -7.5, 2.9, -23.5, '#ffd09a', 10, 10, 22);
    anchor('corr', -7.5, 2.9, -32, '#ffd09a', 10, 10, 22);
    anchor('corr', -7.5, 2.6, -39.3, '#ffc98a', 6, 7, 16);
  }

  /* ================= GUEST ROOM ================= */
  function buildRoom(g) {
    const zc = -47.15, D = 11.7;
    floor(g, M('#9a918a', { rough: 1 }), 11, D, -7.5, 0.03, zc);
    ceiling(g, M('#f1e7d8', { rough: 0.9 }), 11, D, -7.5, 3.2, zc);
    const wall = M('#d2b693', { rough: 0.75 });
    box(g, wall, 4.9, 3.2, 0.3, -10.55, 1.6, -41.15);
    box(g, wall, 4.9, 3.2, 0.3, -4.45, 1.6, -41.15);
    box(g, wall, 1.2, 0.9, 0.3, -7.5, 2.75, -41.15);
    box(g, wall, 11.3, 3.2, 0.3, -7.5, 1.6, -53.15);
    box(g, wall, 0.3, 3.2, D, -13.15, 1.6, zc);
    box(g, wall, 0.3, 3.2, D, -1.85, 1.6, zc);
    // Headboard wall
    box(g, maroon, 3.8, 2.7, 0.08, -8.5, 1.55, -52.96);
    [[3.9, 0.05, 0.05, -8.5, 2.92, -52.9], [0.05, 2.75, 0.05, -10.42, 1.55, -52.9], [0.05, 2.75, 0.05, -6.58, 1.55, -52.9]].forEach((b) => box(g, goldMetal, ...b));
    box(g, M('#9a8c80', { rough: 0.95 }), 2.5, 1.1, 0.14, -8.5, 1.05, -52.86, { cast: true });
    // Bed
    box(g, darkWood, 2.0, 0.35, 2.1, -8.5, 0.175, -51.9, { cast: true });
    box(g, M('#f6f0e6', { rough: 0.95 }), 1.95, 0.25, 2.05, -8.5, 0.47, -51.9, { cast: true });
    box(g, M('#fbf7f0', { rough: 0.95 }), 2.04, 0.1, 1.55, -8.5, 0.63, -51.55, { cast: true });
    box(g, M('#3e3936', { rough: 0.9 }), 2.08, 0.11, 0.45, -8.5, 0.645, -51.1, { cast: true });
    box(g, goldMetal, 2.09, 0.02, 0.03, -8.5, 0.7, -50.88);
    [[-9.0, 0.78, -52.6], [-8.0, 0.78, -52.6]].forEach(([x, y, z]) => box(g, M('#fbf7f0', { rough: 1 }), 0.72, 0.2, 0.4, x, y, z, { cast: true }));
    [[-9.0, 0.82, -52.3], [-8.0, 0.82, -52.3]].forEach(([x, y, z]) => box(g, M('#c9a45c', { rough: 0.9 }), 0.5, 0.16, 0.12, x, y, z));
    // Nightstands + lamps
    [-10.15, -6.85].forEach((x) => {
      box(g, darkWood, 0.55, 0.55, 0.45, x, 0.275, -52.65, { cast: true });
      box(g, goldMetal, 0.5, 0.02, 0.02, x, 0.42, -52.42);
      cyl(g, goldMetal, 0.05, 0.08, 0.36, x, 0.73, -52.65, 10);
      cyl(g, warmLight, 0.15, 0.2, 0.28, x, 1.05, -52.65, 14);
      glow(g, x, 1.05, -52.6, 1.3, '#ffd59a', 0.85);
    });
    // Window with dusk view
    plane(g, M('#ffffff', { basic: true, map: roomWinTex }), 4.4, 2.0, -2.02, 1.8, -47.5, 0, -PI / 2, { receive: false });
    [[0.06, 2.1, 0.06, -2.04, 1.8, -45.27], [0.06, 2.1, 0.06, -2.04, 1.8, -49.73], [0.06, 0.06, 4.5, -2.04, 2.82, -47.5], [0.12, 0.08, 4.6, -2.08, 0.78, -47.5]]
      .forEach((b) => box(g, goldMetal, ...b));
    const curtain = M('#e9dcc5', { rough: 1 });
    box(g, curtain, 0.12, 3.0, 1.1, -2.16, 1.55, -44.75, { cast: true });
    box(g, curtain, 0.12, 3.0, 1.1, -2.16, 1.55, -50.25, { cast: true });
    box(g, maroon, 0.22, 0.28, 6.6, -2.12, 3.02, -47.5);
    glow(g, -2.4, 1.8, -47.5, 5.5, '#ffb070', 0.25, 3);
    // Seating by the window
    armchair(g, -3.3, -45.5, PI, M('#cfc6bc', { rough: 0.95 }));
    armchair(g, -3.3, -49.5, 0, M('#cfc6bc', { rough: 0.95 }));
    cyl(g, goldMetal, 0.05, 0.08, 0.5, -3.3, 0.25, -47.5, 10);
    cyl(g, M('#efe6d6', { rough: 0.2 }), 0.34, 0.34, 0.04, -3.3, 0.52, -47.5, 20, { cast: true });
    // TV
    box(g, darkWood, 0.45, 0.5, 1.9, -12.75, 0.25, -47.0, { cast: true });
    box(g, blackGloss, 0.06, 0.8, 1.4, -12.96, 1.6, -47.0);
    plane(g, M('#ffffff', { basic: true, map: tvTex }), 1.32, 0.72, -12.92, 1.6, -47.0, 0, PI / 2, { receive: false });
    // Rug + downlights
    floor(g, M('#ffffff', { map: rugTex, rough: 1 }), 3.2, 2.6, -8.5, 0.04, -49.2);
    const downs = [];
    [[-8.5, -48.5], [-4, -44], [-11, -44], [-4, -51], [-11.5, -50.5]].forEach(([x, z]) => downs.push({ p: [x, 3.19, z], r: [PI / 2, 0, 0] }));
    inst(g, G('circ', () => new THREE.CircleGeometry(0.22, 16)), warmLight, downs, { receive: false });
    box(g, M('#d9c6a8', { rough: 0.9 }), 1.2, 0.04, 0.5, -11.8, 0.9, -43.0); // luggage rack
    plant(g, -12.4, -52.4, 0.8);

    anchor('room', -10.15, 1.4, -52.3, '#ffcf98', 6, 6, 16);
    anchor('room', -6.85, 1.4, -52.3, '#ffcf98', 6, 6, 16);
    anchor('room', -2.7, 2.1, -47.5, '#ffbf8a', 14, 10, 18);
    anchor('room', -7.5, 2.9, -46, '#ffe0b8', 10, 10, 16);
  }

  /* ================= BANQUET HALL ================= */
  function buildBanquet(g) {
    floor(g, M('#ffffff', { map: rep(banqCarpetTex, 8, 6.5), rough: 1 }), 32, 26, 0, 0.02, 0);
    floor(g, M('#ffffff', { map: rep(parquetTex, 2, 2.2), rough: 0.35 }), 8, 8.4, 0, 0.035, -4.2);
    ceiling(g, M('#2a1513', { rough: 1 }), 32, 26, 0, 7.5, 0);
    const wall = M('#e9dbc3', { rough: 0.9 });
    box(g, wall, 32, 7.5, 0.3, 0, 3.75, -13.15);
    box(g, wall, 32, 7.5, 0.3, 0, 3.75, 13.15);
    box(g, wall, 0.3, 7.5, 26, -16.15, 3.75, 0);
    box(g, wall, 0.3, 7.5, 26, 16.15, 3.75, 0);
    const pil = [];
    const drapeMat = M('#ffffff', { map: rep(drapeTex, 1.5, 1), rough: 1 });
    for (let z = -10; z <= 12; z += 4) {
      pil.push({ p: [-15.9, 3.75, z], s: [0.3, 7.5, 0.5] }, { p: [15.9, 3.75, z], s: [0.3, 7.5, 0.5] });
      if (z < 12) {
        plane(g, drapeMat, 3.2, 6.2, -15.97, 3.4, z + 2, 0, PI / 2);
        plane(g, drapeMat, 3.2, 6.2, 15.97, 3.4, z + 2, 0, -PI / 2);
      }
    }
    inst(g, UB, M('#d8c09a', { rough: 0.6 }), pil);
    // Stage and backdrop
    box(g, cream, 16, 0.8, 4, 0, 0.4, -11, { cast: true });
    box(g, goldGlow, 16.05, 0.05, 0.05, 0, 0.79, -9.0);
    box(g, cream, 3, 0.4, 0.6, 0, 0.2, -8.7);
    plane(g, M('#ffffff', { map: rep(drapeTex, 5, 1), rough: 1 }), 16, 6.4, 0, 4.0, -12.98);
    const arch = new THREE.Mesh(G('arch', () => new THREE.TorusGeometry(3.6, 0.1, 8, seg(48), PI)), goldGlow);
    arch.position.set(0, 3.6, -12.75); g.add(arch);
    cyl(g, goldMetal, 0.1, 0.1, 2.8, -3.6, 2.2, -12.75, 10);
    cyl(g, goldMetal, 0.1, 0.1, 2.8, 3.6, 2.2, -12.75, 10);
    const garland = [];
    for (let i = 0; i <= 40; i++) { const a = (i / 40) * PI; garland.push(Math.cos(a) * 3.6, 3.6 + Math.sin(a) * 3.6, -12.6); }
    glowPoints(g, garland, 0.55, '#ffe2b0', 1);
    box(g, M('#efe3cf', { rough: 0.9 }), 2.6, 0.5, 0.8, 0, 1.05, -11.9, { cast: true });
    box(g, M('#c9a45c', { rough: 0.5, metal: 0.4 }), 2.6, 0.9, 0.2, 0, 1.5, -12.25, { cast: true });
    // Round tables with chairs
    const cloths = [], centres = [], flowers = [], seats = [], backs = [], sashes = [], candles = [];
    [-12, -7.5, 7.5, 12].forEach((x) => [-4.5, 1, 6.5].forEach((z) => {
      cloths.push({ p: [x, 0.38, z], s: [1, 0.76, 1] });
      centres.push({ p: [x, 0.92, z], s: [1, 0.3, 1] });
      flowers.push({ p: [x, 1.14, z], s: [0.22, 0.2, 0.22] });
      candles.push(x + 0.35, 0.86, z + 0.2, x - 0.3, 0.86, z - 0.25);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * PI * 2 + 0.2;
        const dx = Math.cos(a), dz = Math.sin(a), ry = Math.atan2(dx, dz);
        seats.push({ p: [x + dx * 1.35, 0.235, z + dz * 1.35], s: [0.46, 0.47, 0.46], r: [0, ry, 0] });
        backs.push({ p: [x + dx * 1.56, 0.8, z + dz * 1.56], s: [0.46, 0.66, 0.08], r: [0, ry, 0] });
        sashes.push({ p: [x + dx * 1.6, 0.68, z + dz * 1.6], s: [0.48, 0.1, 0.06], r: [0, ry, 0] });
      }
    }));
    inst(g, cylGeo(0.95, 0.98, 24), M('#f3ebdd', { rough: 0.95 }), cloths, { cast: true });
    inst(g, cylGeo(0.06, 0.09, 10), goldMetal, centres);
    inst(g, G('ico', () => new THREE.IcosahedronGeometry(1, 1)), M('#8a2430', { rough: 0.8 }), flowers);
    const chairMat = M('#f1e8d8', { rough: 0.95 });
    inst(g, UB, chairMat, seats, { cast: true });
    inst(g, UB, chairMat, backs, { cast: true });
    inst(g, UB, M('#c9a45c', { rough: 0.5, metal: 0.3 }), sashes);
    glowPoints(g, candles, 0.45, '#ffcf80', 1);
    // String lights
    const bulbs = [];
    const wire = [];
    [-9, -5, -1, 3, 7, 11].forEach((z, si) => {
      const pts = [];
      for (let x = -16; x <= 16.01; x += 0.9) {
        const y = 7.2 - 1.3 * (1 - (x / 16) ** 2) - (si % 2) * 0.25;
        bulbs.push(x, y - 0.06, z);
        pts.push(new THREE.Vector3(x, y, z));
      }
      wire.push(...pts.slice(0, -1).flatMap((p, i) => [p, pts[i + 1]]));
    });
    for (let z = -12; z <= 12; z += 6) {
      for (let x = -14; x <= 14; x += 1.2) {
        const zz = z + (x / 14) * 2;
        bulbs.push(x, 6.9 - 0.9 * (1 - (x / 14) ** 2), zz);
      }
    }
    const wg = new THREE.BufferGeometry().setFromPoints(wire);
    g.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: '#2a1c14' })));
    glowPoints(g, bulbs, 0.55, '#ffd28a', 1);
    glowPoints(g, bulbs.filter((_, i) => (Math.floor(i / 3) % 3) === 0), 1.8, '#ffb860', 0.25);

    anchor('banq', -7.5, 5.2, 1, '#ffcc8a', 40, 24, 50);
    anchor('banq', 7.5, 5.2, 1, '#ffcc8a', 40, 24, 50);
    anchor('banq', 0, 4.6, -8.2, '#ffd8a8', 34, 14, 50);
    anchor('banq', 0, 5, 9, '#ffc88a', 18, 16, 50);
  }

  /* ================= GROOVE RESTOBAR ================= */
  function buildBar(g) {
    floor(g, M('#ffffff', { map: rep(plankTex, 5, 4.5), rough: 0.5 }), 20, 18, 0, 0.02, 0);
    ceiling(g, M('#140a09', { rough: 1 }), 20, 18, 0, 4.2, 0);
    const wallM = M('#4a1c18', { rough: 0.9 });
    box(g, M('#1c0d0b', { rough: 0.9 }), 20, 4.2, 0.3, 0, 2.1, -9.15);
    box(g, wallM, 20, 4.2, 0.3, 0, 2.1, 9.15);
    box(g, wallM, 0.3, 4.2, 18, -10.15, 2.1, 0);
    box(g, wallM, 0.3, 4.2, 18, 10.15, 2.1, 0);
    const slats = [];
    for (let z = -8.6; z <= 8.6; z += 0.55) slats.push({ p: [9.96, 2.1, z], s: [0.06, 4.2, 0.12] }, { p: [-9.96, 2.1, z], s: [0.06, 4.2, 0.12] });
    inst(g, UB, M('#5a3420', { rough: 0.6 }), slats);
    box(g, M('#ffb35a', { basic: true }), 0.04, 0.04, 18, 9.9, 3.9, 0);
    box(g, M('#ffb35a', { basic: true }), 0.04, 0.04, 18, -9.9, 3.9, 0);

    // Back bar
    box(g, darkWood, 13, 1.0, 0.6, 0, 0.5, -8.65, { cast: true });
    plane(g, M('#ffffff', { basic: true, map: barGlowTex }), 13, 2.3, 0, 2.25, -8.98, 0, 0, { receive: false });
    const bottles = [];
    const bcol = ['#5a2e10', '#20301a', '#6a5a48', '#3a0e0e', '#8a5a20', '#2a1a10'];
    [1.55, 2.2, 2.85].forEach((y) => {
      box(g, M('#2a1810', { rough: 0.6 }), 13, 0.05, 0.35, 0, y, -8.75);
      box(g, M('#ffbe6a', { basic: true }), 13, 0.02, 0.02, 0, y - 0.035, -8.58);
      for (let i = 0; i < 26; i++) {
        const h = 0.22 + rand() * 0.12;
        bottles.push({ p: [-6.2 + i * 0.49 + (rand() - 0.5) * 0.1, y + 0.025 + h / 2, -8.78], s: [1, h, 1], c: bcol[Math.floor(rand() * bcol.length)] });
      }
    });
    inst(g, cylGeo(0.045, 0.05, 8), M('#ffffff', { basic: true }), bottles, { receive: false });
    plane(g, M('#ffffff', { basic: true, map: grooveTex, transparent: true, toneMapped: false }), 5, 1.25, 0, 3.6, -8.95, 0, 0, { receive: false, order: 2 });
    glow(g, 0, 3.55, -8.8, 7, '#ff9a40', 0.35, 2.2);

    // Counter
    box(g, M('#1e0f0b', { rough: 0.6 }), 12, 1.0, 0.8, 0, 0.5, -5, { cast: true });
    plane(g, M('#ffffff', { map: rep(flutedTex, 60, 1), rough: 0.5 }), 12, 0.92, 0, 0.5, -4.59);
    box(g, M('#161011', { rough: 0.12 }), 12.4, 0.07, 1.1, 0, 1.04, -4.95, { cast: true });
    box(g, goldGlow, 12.45, 0.04, 0.04, 0, 1.0, -4.4);
    box(g, M('#ffae55', { basic: true }), 12, 0.02, 0.02, 0, 0.95, -4.47);
    cyl(g, goldMetal, 0.025, 0.025, 12, 0, 0.25, -4.35, 8, { rz: PI / 2 });
    const led = [];
    for (let x = -5.7; x <= 5.8; x += 0.6) led.push(x, 0.93, -4.42);
    glowPoints(g, led, 0.5, '#ffae55', 0.7);
    // Pendants
    const pglow = [];
    const shadeMat = M('#c9a45c', { rough: 0.35, metal: 0.7, side: THREE.DoubleSide });
    [-4.8, -2.4, 0, 2.4, 4.8].forEach((x) => {
      cyl(g, M('#111', { basic: true }), 0.01, 0.01, 1.45, x, 3.48, -5, 4);
      cyl(g, shadeMat, 0.06, 0.24, 0.32, x, 2.62, -5, 14, { open: true });
      pglow.push(x, 2.46, -5);
    });
    glowPoints(g, pglow, 1.3, '#ffcf80', 1);
    // Stools
    const sseat = [], spole = [], sbase = [];
    for (let i = 0; i < 8; i++) {
      const x = -5.25 + i * 1.5;
      sseat.push({ p: [x, 0.8, -3.85], s: [1, 0.08, 1] });
      spole.push({ p: [x, 0.4, -3.85], s: [1, 0.78, 1] });
      sbase.push({ p: [x, 0.015, -3.85], s: [1, 0.03, 1] });
    }
    inst(g, cylGeo(0.22, 0.2, 16), M('#6a2620', { rough: 0.6 }), sseat, { cast: true });
    inst(g, cylGeo(0.03, 0.03, 6), goldMetal, spole);
    inst(g, cylGeo(0.2, 0.2, 14), goldMetal, sbase);
    // Lounge booth (left)
    box(g, velvet, 0.8, 0.45, 7, -9.4, 0.225, 2, { cast: true });
    box(g, velvet, 0.25, 0.75, 7, -9.86, 0.8, 2, { cast: true });
    const candles = [];
    [0, 3.6].forEach((z) => {
      cyl(g, M('#1a0f0c', { rough: 0.3 }), 0.42, 0.42, 0.05, -8.2, 0.7, z, 20, { cast: true });
      cyl(g, goldMetal, 0.05, 0.1, 0.68, -8.2, 0.34, z, 8);
      candles.push(-8.2, 0.8, z);
      box(g, velvet, 0.5, 0.45, 0.5, -7.2, 0.225, z - 0.5, { cast: true });
      box(g, velvet, 0.5, 0.45, 0.5, -7.2, 0.225, z + 0.5, { cast: true });
    });
    // High tables (right)
    [[6.8, 0.8], [6.8, 4.4]].forEach(([x, z]) => {
      cyl(g, M('#1a0f0c', { rough: 0.3 }), 0.4, 0.4, 0.05, x, 1.05, z, 20, { cast: true });
      cyl(g, goldMetal, 0.04, 0.04, 1.0, x, 0.52, z, 8);
      candles.push(x, 1.15, z);
    });
    glowPoints(g, candles, 0.6, '#ffc070', 1);
    plant(g, 9.2, -7.6, 1); plant(g, -9.2, -7.6, 1);

    anchor('bar', 0, 3.1, -3.8, '#ffb060', 40, 14, 30);
    anchor('bar', 0, 2.3, -7.6, '#ff9a40', 16, 7, 30);
    anchor('bar', -7.6, 2.6, 1.8, '#ffb870', 18, 10, 24);
    anchor('bar', 6.5, 2.6, 2.6, '#ffb870', 14, 9, 24);
  }

  buildExterior(groups.ext); onProgress(0.35); await tick();
  buildLobby(groups.lobby);
  buildCorridor(groups.corr); onProgress(0.45); await tick();
  buildRoom(groups.room);
  buildBanquet(groups.banq); onProgress(0.55); await tick();
  buildBar(groups.bar); onProgress(0.62);

  scene.updateMatrixWorld(true);
  anchors.forEach((a) => groups[a.group].localToWorld(a.world.copy(a.local)));

  /* ---------------- Soft environment reflections (standard materials only) ---------------- */
  if (!LOW) {
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color('#1c0e0b');
    const pm = (c, w, h, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0); envScene.add(m);
    };
    pm('#ffd9a0', 10, 10, 0, 8, 0, PI / 2, 0);
    pm('#7a3a22', 30, 8, 0, 0, -12, 0, 0);
    pm('#a8582e', 30, 8, 0, 0, 12, 0, 0);
    pm('#ffe6c0', 4, 6, 12, 2, 0, 0, PI / 2);
    pm('#5a2a1c', 30, 30, 0, -6, 0, PI / 2, 0);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    scene.traverse((o) => { if (o.material && o.material.isMeshStandardMaterial) o.material.envMapIntensity = 0.55; });
  }

  /* ---------------- Camera path ---------------- */
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const SC = [
    { vis: ['ext', 'lobby'], env: 'ext', a: { p: V(27, 7.5, 58), t: V(0, 10.5, 0) }, b: { p: V(5, 3.1, 22), t: V(0, 3.0, -2) } },
    { vis: ['lobby', 'corr'], env: 'lobby', a: { p: V(0, 2.2, -2.2), t: V(0, 2.4, -14) }, b: { p: V(-2.4, 1.9, -9), t: V(1, 1.5, -15.5) } },
    { vis: ['corr', 'room'], env: 'corr', a: { p: V(-7.5, 1.65, -19.5), t: V(-7.5, 1.55, -34) }, b: { p: V(-7.5, 1.6, -37.4), t: V(-7.5, 1.4, -44) } },
    { vis: ['room'], env: 'room', a: { p: V(-7.5, 1.6, -43.4), t: V(-7.9, 0.9, -51) }, b: { p: V(-11.6, 1.7, -43.8), t: V(-3.5, 1.1, -48.5) } },
    { vis: ['banq'], env: 'banq', a: { p: V(BX, 3.4, 12.2), t: V(BX, 1.4, -6) }, b: { p: V(BX + 10.5, 2.5, 8.8), t: V(BX - 3, 1.6, -9) } },
    { vis: ['bar'], env: 'bar', a: { p: V(GX, 1.75, 8), t: V(GX, 1.5, -6) }, b: { p: V(GX - 5.6, 1.5, 3.2), t: V(GX + 3, 1.7, -7) } },
    { vis: ['ext', 'lobby'], env: 'ext', a: { p: V(-7, 3.4, 30), t: V(-3, 8, 0) }, b: { p: V(-34, 19, 86), t: V(-13, 10.5, -6) } },
  ];
  const ENV = {
    ext: { sky: '#8a5040', gnd: '#160c08', hemi: 0.75, key: '#ffab70', keyI: 1.6, kp: V(-55, 32, 45), kt: V(0, 0, -15), ks: 44, far: 220 },
    lobby: { sky: '#ffe2bd', gnd: '#4a2a1e', hemi: 0.55, key: '#ffe6c4', keyI: 0.9, kp: V(3, 20, 1), kt: V(0, 0, -9), ks: 13, far: 50 },
    corr: { sky: '#ffe2bd', gnd: '#4a2a1e', hemi: 0.5, key: '#ffe0b8', keyI: 0.5, kp: V(-6, 16, -27), kt: V(-7.5, 0, -30), ks: 13, far: 40 },
    room: { sky: '#ffe2c4', gnd: '#5a3424', hemi: 0.6, key: '#ffd2a0', keyI: 0.9, kp: V(9, 9, -46), kt: V(-8, 0, -48), ks: 9, far: 40 },
    banq: { sky: '#ffd9a8', gnd: '#3a1610', hemi: 0.5, key: '#ffe0b0', keyI: 0.75, kp: V(BX + 6, 24, 8), kt: V(BX, 0, 0), ks: 20, far: 60 },
    bar: { sky: '#d08a50', gnd: '#2a1208', hemi: 0.75, key: '#ffc890', keyI: 0.7, kp: V(GX + 3, 14, 6), kt: V(GX, 0, -2), ks: 12, far: 40 },
  };
  Object.values(ENV).forEach((e) => { e.skyC = new THREE.Color(e.sky); e.gndC = new THREE.Color(e.gnd); e.keyC = new THREE.Color(e.key); });

  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), dir = new THREE.Vector3();
  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeIn = (t) => t * t;
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  function lerpPose(A, B, t) { camPos.lerpVectors(A.p, B.p, t); camTgt.lerpVectors(A.t, B.t, t); }
  function pushPose(P, d, out) { dir.subVectors(P.t, P.p).normalize(); out.p = tmpA.copy(P.p).addScaledVector(dir, d); out.t = tmpB.copy(P.t).addScaledVector(dir, d); return out; }

  let curVisKey = '';
  let curKeyEnv = null;
  function setVis(list) {
    const k = list.join(',');
    if (k === curVisKey) return;
    curVisKey = k;
    for (const n in groups) groups[n].visible = list.includes(n);
    renderer.shadowMap.needsUpdate = true;
  }
  function applyEnv(ea, eb, t, keyEnv) {
    hemi.color.copy(ea.skyC).lerp(eb.skyC, t);
    hemi.groundColor.copy(ea.gndC).lerp(eb.gndC, t);
    hemi.intensity = ea.hemi + (eb.hemi - ea.hemi) * t;
    key.color.copy(ea.keyC).lerp(eb.keyC, t);
    key.intensity = ea.keyI + (eb.keyI - ea.keyI) * t;
    if (keyEnv !== curKeyEnv) {
      curKeyEnv = keyEnv;
      key.position.copy(keyEnv.kp); key.target.position.copy(keyEnv.kt); key.target.updateMatrixWorld();
      const c = key.shadow.camera;
      c.left = -keyEnv.ks; c.right = keyEnv.ks; c.top = keyEnv.ks; c.bottom = -keyEnv.ks; c.near = 0.5; c.far = keyEnv.far;
      c.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    }
  }
  const cand = [];
  function updatePool() {
    cand.length = 0;
    for (const a of anchors) {
      if (!groups[a.group].visible) continue;
      const d = a.world.distanceTo(camPos);
      const f = 1 - smooth(a.reach * 0.55, a.reach, d);
      if (f <= 0) continue;
      a.w = a.intensity * f; a.f = f;
      cand.push(a);
    }
    cand.sort((x, y) => y.w - x.w);
    for (let i = 0; i < POOL; i++) {
      const l = pool[i], a = cand[i];
      if (!a) { l.intensity = 0; continue; }
      l.position.copy(a.world); l.color.copy(a.color);
      l.intensity = a.intensity * a.f * (LOW ? 1.3 : 1);
      l.distance = a.distance;
    }
  }

  const keyOf = (i) => ENV[SC[i].env];
  const cutOut = {}, cutIn = {};
  function update(p) {
    const { seg: s, t } = locate(p);
    if (s.kind === 'hold') {
      const S = SC[s.i];
      lerpPose(S.a, S.b, smooth(0, 1, t));
      setVis(S.vis);
      applyEnv(keyOf(s.i), keyOf(s.i), 0, keyOf(s.i));
    } else {
      const A = SC[s.i], B = SC[s.i + 1];
      if (!s.cut) {
        lerpPose(A.b, B.a, easeIO(t));
        setVis([...new Set([...A.vis, ...B.vis])]);
        applyEnv(keyOf(s.i), keyOf(s.i + 1), smooth(0.2, 0.8, t), t < 0.5 ? keyOf(s.i) : keyOf(s.i + 1));
      } else if (t < 0.5) {
        const P = pushPose(A.b, 1.4, cutOut);
        const tt = easeIn(t * 2);
        camPos.lerpVectors(A.b.p, P.p, tt); camTgt.lerpVectors(A.b.t, P.t, tt);
        setVis(A.vis);
        applyEnv(keyOf(s.i), keyOf(s.i), 0, keyOf(s.i));
      } else {
        const P = pushPose(B.a, -1.6, cutIn);
        const tt = easeOut((t - 0.5) * 2);
        camPos.lerpVectors(P.p, B.a.p, tt); camTgt.lerpVectors(P.t, B.a.t, tt);
        setVis(B.vis);
        applyEnv(keyOf(s.i + 1), keyOf(s.i + 1), 0, keyOf(s.i + 1));
      }
    }
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    doorPivot.rotation.y = doorOpen(p) * 1.75;
    updatePool();
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? Math.min(72, 50 + (1 - camera.aspect) * 34) : 50;
    camera.updateProjectionMatrix();
  }
  resize();

  /* ---------------- Pre-compile shaders (one light setup -> one program per material) ---------------- */
  update(0);
  for (const n in groups) groups[n].visible = true;
  curVisKey = '';
  try {
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
  } catch (e) { renderer.compile(scene, camera); }
  onProgress(0.9); await tick();
  update(0);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  if (renderer.getContext().isContextLost()) throw new Error('context lost');
  onProgress(1);

  let degradeStep = 0;
  return {
    tier,
    render(p) { update(p); renderer.render(scene, camera); },
    resize,
    degrade() {
      if (degradeStep === 0 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); degradeStep = 1; return true; }
      if (degradeStep <= 1 && renderer.shadowMap.enabled) {
        renderer.shadowMap.enabled = false; key.castShadow = false;
        scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
        degradeStep = 2; return true;
      }
      return false;
    },
    dispose() { renderer.dispose(); },
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
