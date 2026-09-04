/* ==========================================================================
   js/preview.js
   --------------------------------------------------------------------------
   Live 3D preview for the Forksheet CMOS generator.

   Loaded as a classic script, so it depends on the global THREE from the CDN
   and exposes window.Preview. That combination is what allows index.html to
   be opened directly from disk: browsers refuse to load ES modules over a
   file:// URL, but ordinary scripts are fine.

   Responsibilities
     - build a Three.js scene of cuboids from the generator's region list
     - colour by material, using the same table as the SCM Device Viewer
     - orbit / zoom / pan, camera presets, perspective and orthographic
     - click a region to select, highlight it, and report its details
     - XYZ axes, and correct behaviour when the window is resized

   A note on scale: SCM coordinates are micrometres, so a device spans about
   0.08 units. Numbers that small give poor depth-buffer behaviour in WebGL,
   so the model is placed in a group with ONE UNIFORM scale factor. A uniform
   scale changes no proportion and no relative position; the inspector always
   shows the original micrometre values.
   ========================================================================== */

'use strict';

(function () {

  /* ---------------------------------------------------------------- state */
  const S = {
    regions: [],
    selected: null,
    opacity: 1,
    style: 'surface',
    showEdges: true,
    showAxes: true,
    ready: false,
  };

  let renderer, scene, camera, perspCam, orthoCam, controls;
  let modelGroup, regionGroup, edgeGroup, axesGroup, highlight;
  let raycaster, pointer, hostEl;
  let unitBox, unitEdges;
  const meshes = [];
  const edges = [];

  let pressPos = null;          // for distinguishing a click from a drag

  const $ = (s) => document.querySelector(s);

  /* ==================================================================
     Fallback orbit controller

     Used only if THREE.OrbitControls did not load. Implements the same
     three gestures so the preview never ends up frozen because a CDN
     addon was blocked.
     ================================================================== */
  function SimpleOrbitControls(cam, dom) {
    this.object = cam;
    this.domElement = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.enableDamping = false;

    const sph = new THREE.Spherical();
    const off = new THREE.Vector3();
    let mode = 0;                       // 0 none, 1 rotate, 2 pan
    let lx = 0, ly = 0;

    const onDown = (e) => {
      mode = (e.button === 0) ? 1 : 2;
      lx = e.clientX; ly = e.clientY;
      dom.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!mode) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;

      if (mode === 1) {
        off.copy(this.object.position).sub(this.target);
        sph.setFromVector3(off);
        sph.theta -= dx * 0.005;
        sph.phi = Math.max(1e-4, Math.min(Math.PI - 1e-4, sph.phi - dy * 0.005));
        off.setFromSpherical(sph);
        this.object.position.copy(this.target).add(off);
      } else {
        const dist = this.object.position.distanceTo(this.target);
        const k = dist * 0.0015;
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        this.object.matrix.extractBasis(right, up, new THREE.Vector3());
        const shift = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
        this.object.position.add(shift);
        this.target.add(shift);
      }
      this.object.lookAt(this.target);
    };
    const onUp = (e) => {
      mode = 0;
      try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    const onWheel = (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      if (this.object.isOrthographicCamera) {
        this.object.zoom = Math.max(0.05, this.object.zoom / f);
        this.object.updateProjectionMatrix();
      } else {
        off.copy(this.object.position).sub(this.target).multiplyScalar(f);
        this.object.position.copy(this.target).add(off);
      }
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this.update = function () { this.object.lookAt(this.target); };
  }

  /* ==================================================================
     Setup
     ================================================================== */
  function init(hostId) {
    hostEl = document.getElementById(hostId);
    if (!hostEl) return;

    if (typeof THREE === 'undefined') {
      hostEl.innerHTML =
        '<div class="hint err">Three.js failed to load.<br>' +
        '<span class="dim">Check your internet connection, or vendor three.min.js locally.</span></div>';
      return;
    }

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(hostEl.clientWidth, Math.max(hostEl.clientHeight, 1));
    hostEl.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1319);

    const aspect = hostEl.clientWidth / Math.max(hostEl.clientHeight, 1);
    perspCam = new THREE.PerspectiveCamera(45, aspect, 0.01, 5000);
    perspCam.position.set(22, 18, 26);

    const d = 17;
    orthoCam = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, -2000, 5000);
    orthoCam.position.set(22, 18, 26);

    camera = perspCam;

    const Ctl = (typeof THREE.OrbitControls === 'function')
      ? THREE.OrbitControls : SimpleOrbitControls;
    controls = new Ctl(camera, renderer.domElement);
    if ('enableDamping' in controls) {
      controls.enableDamping = true;
      controls.dampingFactor = 0.09;
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 1.4, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9db4d0, 0.35);
    fill.position.set(-1, -0.6, -0.8);
    scene.add(fill);

    modelGroup = new THREE.Group();
    regionGroup = new THREE.Group();
    edgeGroup = new THREE.Group();
    axesGroup = new THREE.Group();
    modelGroup.add(regionGroup, edgeGroup);
    scene.add(modelGroup, axesGroup);

    unitBox = new THREE.BoxGeometry(1, 1, 1);
    unitEdges = new THREE.EdgesGeometry(unitBox);

    highlight = new THREE.LineSegments(
      unitEdges, new THREE.LineBasicMaterial({ color: 0xffe14d }));
    highlight.visible = false;
    modelGroup.add(highlight);

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0) pressPos = [e.clientX, e.clientY];
    });
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(hostEl);

    wireToolbar();
    buildAxes();

    S.ready = true;
    (function loop() {
      requestAnimationFrame(loop);
      if (controls && controls.update) controls.update();
      renderer.render(scene, camera);
    })();
  }

  function onResize() {
    if (!renderer || !hostEl) return;
    const w = hostEl.clientWidth, h = Math.max(hostEl.clientHeight, 1);
    renderer.setSize(w, h);
    const aspect = w / h;
    perspCam.aspect = aspect;
    perspCam.updateProjectionMatrix();
    const d = orthoCam.top;
    orthoCam.left = -d * aspect;
    orthoCam.right = d * aspect;
    orthoCam.updateProjectionMatrix();
  }

  /* ==================================================================
     Building geometry
     ================================================================== */
  function disposeChildren(group) {
    while (group.children.length) {
      const c = group.children.pop();
      if (c.geometry && c.geometry !== unitBox && c.geometry !== unitEdges) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
    }
  }

  function clear() {
    if (!S.ready) return;
    disposeChildren(regionGroup);
    disposeChildren(edgeGroup);
    meshes.length = 0;
    edges.length = 0;
    highlight.visible = false;
    S.regions = [];
    S.selected = null;
    fillInfo(null);
    renderLegend([]);
    const hint = $('#viewer-hint');
    if (hint) hint.style.display = '';
  }

  /** Replace the scene contents with a new region list. */
  function setRegions(regions) {
    if (!S.ready) return;
    const keepCamera = S.regions.length > 0;
    const prevSelected = S.selected;

    disposeChildren(regionGroup);
    disposeChildren(edgeGroup);
    meshes.length = 0;
    edges.length = 0;
    highlight.visible = false;

    S.regions = regions || [];
    if (!S.regions.length) { clear(); return; }

    const b = bounds(S.regions);
    const spans = [b[1] - b[0], b[3] - b[2], b[5] - b[4]];
    const s = 20 / (Math.max(...spans) || 1);
    const cx = (b[0] + b[1]) / 2, cy = (b[2] + b[3]) / 2, cz = (b[4] + b[5]) / 2;

    for (const r of S.regions) {
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(r.color),
        transparent: true,
        opacity: S.opacity,
        wireframe: S.style === 'wireframe',
        side: THREE.DoubleSide,
        depthWrite: S.opacity >= 0.99,
      });
      const mesh = new THREE.Mesh(unitBox, mat);
      mesh.scale.set(r.lx * s, r.ly * s, r.lz * s);
      mesh.position.set((r.center[0] - cx) * s, (r.center[1] - cy) * s, (r.center[2] - cz) * s);
      mesh.userData.region = r;
      regionGroup.add(mesh);
      meshes.push(mesh);

      const e = new THREE.LineSegments(unitEdges,
        new THREE.LineBasicMaterial({ color: 0x0b0e12, transparent: true, opacity: 0.85 }));
      e.scale.copy(mesh.scale);
      e.position.copy(mesh.position);
      e.visible = S.showEdges && S.style === 'surface';
      edgeGroup.add(e);
      edges.push(e);
    }

    renderLegend(S.regions);
    const hint = $('#viewer-hint');
    if (hint) hint.style.display = 'none';

    // Re-select the same region after a parameter change, so the inspector
    // does not blank out every time a slider moves.
    if (prevSelected && S.regions.some((r) => r.name === prevSelected)) {
      select(prevSelected);
    } else {
      fillInfo(null);
    }

    if (!keepCamera) resetCamera();
  }

  function bounds(regs) {
    return [
      Math.min(...regs.map((r) => r.x0)), Math.max(...regs.map((r) => r.x1)),
      Math.min(...regs.map((r) => r.y0)), Math.max(...regs.map((r) => r.y1)),
      Math.min(...regs.map((r) => r.z0)), Math.max(...regs.map((r) => r.z1)),
    ];
  }

  function buildAxes() {
    disposeChildren(axesGroup);
    const L = 12, o = -12;
    const helper = new THREE.AxesHelper(L);       // X red, Y green, Z blue
    helper.position.set(o, o, o);
    axesGroup.add(helper);

    const tag = (txt, pos, colour) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.font = '700 44px monospace';
      g.fillStyle = colour;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(txt, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
      sp.position.copy(pos);
      sp.scale.set(1.7, 1.7, 1);
      axesGroup.add(sp);
    };
    tag('X', new THREE.Vector3(o + L + 1, o, o), '#ff6b6b');
    tag('Y', new THREE.Vector3(o, o + L + 1, o), '#63d471');
    tag('Z', new THREE.Vector3(o, o, o + L + 1), '#6b9bff');
    axesGroup.visible = S.showAxes;
  }

  /* ==================================================================
     Picking
     ================================================================== */
  function onPointerUp(ev) {
    if (ev.button !== 0 || !pressPos) { pressPos = null; return; }
    const [px, py] = pressPos;
    pressPos = null;
    // a drag is a camera move, not a selection
    if (Math.abs(ev.clientX - px) > 4 || Math.abs(ev.clientY - py) > 4) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(regionGroup.children, false);
    select(hits.length ? hits[0].object.userData.region.name : null);
  }

  function select(name) {
    S.selected = name;
    if (!name) {
      highlight.visible = false;
      fillInfo(null);
      return;
    }
    const mesh = meshes.find((m) => m.userData.region.name === name);
    if (mesh) {
      highlight.scale.copy(mesh.scale).multiplyScalar(1.012);
      highlight.position.copy(mesh.position);
      highlight.visible = true;
    }
    fillInfo(S.regions.find((r) => r.name === name) || null);
  }

  /* ==================================================================
     Inspector and legend
     ================================================================== */
  function fmt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '-';
    return String(Number(Number(v).toPrecision(6)));
  }

  function fillInfo(r) {
    const set = (f, v) => {
      const el = document.querySelector(`#region-info [data-f="${f}"]`);
      if (el) el.textContent = v;
    };
    const fields = ['name', 'material', 'x0', 'x1', 'y0', 'y1', 'z0', 'z1',
                    'lx', 'ly', 'lz', 'volume'];
    if (!r) { fields.forEach((f) => set(f, '-')); return; }
    set('name', r.name);
    set('material', r.material);
    ['x0', 'x1', 'y0', 'y1', 'z0', 'z1', 'lx', 'ly', 'lz'].forEach((f) => set(f, fmt(r[f])));
    set('volume', fmt(r.volume));
  }

  function renderLegend(regs) {
    const ul = $('#legend');
    if (!ul) return;
    ul.innerHTML = '';
    const mats = [...new Set(regs.map((r) => r.material))].sort();
    for (const m of mats) {
      const count = regs.filter((r) => r.material === m).length;
      const colour = (regs.find((r) => r.material === m) || {}).color || '#888';
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="swatch" style="background:${colour}"></span>` +
        `<span class="lname">${m}</span><span class="lcount">${count}</span>`;
      ul.appendChild(li);
    }
  }

  /* ==================================================================
     Camera and display controls
     ================================================================== */
  function setProjection(kind) {
    const wasPersp = camera === perspCam;
    if (kind === 'orthographic' && wasPersp) {
      orthoCam.position.copy(perspCam.position);
      orthoCam.quaternion.copy(perspCam.quaternion);
      camera = orthoCam;
    } else if (kind === 'perspective' && !wasPersp) {
      perspCam.position.copy(orthoCam.position);
      perspCam.quaternion.copy(orthoCam.quaternion);
      camera = perspCam;
    } else return;
    controls.object = camera;
    if (controls.update) controls.update();
    onResize();
  }

  function setView(which) {
    const R = 38;
    const table = {
      front: [0, 0, R], back: [0, 0, -R],
      right: [R, 0, 0], left: [-R, 0, 0],
      top: [0, R, 0], bottom: [0, -R, 0],
      iso: [R * 0.62, R * 0.5, R * 0.62],
    };
    const p = table[which] || table.iso;
    camera.up.set(0, 1, 0);
    if (which === 'top' || which === 'bottom') camera.up.set(0, 0, -1);
    camera.position.set(p[0], p[1], p[2]);
    if (controls.target) controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    if (controls.update) controls.update();
  }

  function resetCamera() { setView('iso'); }

  function applyStyle() {
    for (const m of meshes) {
      m.material.opacity = S.opacity;
      m.material.wireframe = S.style === 'wireframe';
      m.material.depthWrite = S.opacity >= 0.99;
      m.material.needsUpdate = true;
    }
    for (const e of edges) e.visible = S.showEdges && S.style === 'surface';
  }

  function wireToolbar() {
    document.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => setView(b.dataset.view)));

    const on = (sel, ev, fn) => {
      const el = $(sel);
      if (el) el.addEventListener(ev, fn);
    };
    on('#btn-reset-cam', 'click', resetCamera);
    on('#sel-projection', 'change', (e) => setProjection(e.target.value));
    on('#sel-style', 'change', (e) => { S.style = e.target.value; applyStyle(); });
    on('#opacity', 'input', (e) => { S.opacity = e.target.value / 100; applyStyle(); });
    on('#chk-edges', 'change', (e) => { S.showEdges = e.target.checked; applyStyle(); });
    on('#chk-axes', 'change', (e) => {
      S.showAxes = e.target.checked;
      axesGroup.visible = S.showAxes;
    });
  }

  /* ==================================================================
     Public API used by generator.js
     ================================================================== */
  window.Preview = {
    init,
    setRegions,
    clear,
    select,
    resetCamera,
    get selected() { return S.selected; },
  };

})();