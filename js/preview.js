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
    showContacts: true,
    ready: false,
    clip: { axis: null, t: 1, flip: false },
    measure: { on: false, a: null, b: null },
    flagged: [],
  };

  let renderer, scene, camera, perspCam, orthoCam, controls;
  let modelGroup, regionGroup, edgeGroup, axesGroup, highlight;
  let contactGroup, flagGroup, measureGroup;

  /* The model is drawn at a uniform scale about its own centre, because a
     device 0.08 um across gives WebGL a useless depth buffer. Every mapping
     between screen space and real micrometres goes through this, so it is
     kept rather than recomputed - the inspector, the contact markers and
     the measuring tool must all agree with each other. */
  const XF = { s: 1, cx: 0, cy: 0, cz: 0 };
  const toWorld = (p) => new THREE.Vector3(
    (p[0] - XF.cx) * XF.s, (p[1] - XF.cy) * XF.s, (p[2] - XF.cz) * XF.s);
  let raycaster, pointer, hostEl;
  let unitBox, unitEdges;
  const meshes = [];
  const edges = [];

  let pressPos = null;          // for distinguishing a click from a drag
  let lastW = 0, lastH = 0;     // last host size handed to the renderer
  let hostObserver = null;      // ResizeObserver on the viewport element

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
    renderer.setSize(Math.max(hostEl.clientWidth, 1), Math.max(hostEl.clientHeight, 1));
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
    contactGroup = new THREE.Group();
    flagGroup = new THREE.Group();
    measureGroup = new THREE.Group();
    modelGroup.add(regionGroup, edgeGroup, contactGroup, flagGroup, measureGroup);
    scene.add(modelGroup, axesGroup);

    // cross-section: one global plane, enabled only while a section is on
    renderer.localClippingEnabled = true;

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
    // Android reports the new size slightly after the event fires
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

    /* Watching the host element covers every cause of a size change at once:
       a window resize, a sidebar drag, a collapsed panel, a drawer opening.
       The observer is held in a variable on purpose - an unreferenced
       ResizeObserver can be collected in some engines, which silently stops
       the preview tracking its container. */
    if (window.ResizeObserver) {
      hostObserver = new ResizeObserver(onResize);
      hostObserver.observe(hostEl);
    }

    wireToolbar();
    buildAxes();
    onResize();                 // pick up the real host size once laid out

    S.ready = true;
    (function loop() {
      requestAnimationFrame(loop);
      if (controls && controls.update) controls.update();
      renderer.render(scene, camera);
    })();
  }

  /* Called whenever the host box changes size: window resize, an orientation
     change, a sidebar drag, a panel collapse, or a drawer opening.

     setSize() is deliberately called WITHOUT the third argument, so it also
     writes the canvas CSS width and height. An earlier version passed
     `false`, which updates only the drawing buffer; because the very first
     setSize() ran while the host was still 0px wide, the canvas kept an
     inline `width: 0px` forever and the preview rendered into a box nobody
     could see. Pixel ratio is applied before the size so the buffer is
     allocated once, at the right resolution. */
  function onResize() {
    if (!renderer || !hostEl) return;
    const w = hostEl.clientWidth;
    const h = hostEl.clientHeight;
    // a hidden or zero-sized host would make the aspect ratio NaN
    if (w < 2 || h < 2) return;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    disposeChildren(contactGroup);
    disposeChildren(flagGroup);
    disposeChildren(measureGroup);
    S.flagged = [];
    S.measure.a = S.measure.b = null;
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
    XF.s = s; XF.cx = cx; XF.cy = cy; XF.cz = cz;
    S.bounds = b;

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
    applyClip();
    setFlagged(S.flagged);          // keep problem highlights across a rebuild
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
    const region = hits.length ? hits[0].object.userData.region : null;
    if (S.measure.on) { pickForMeasure(region); return; }
    select(region ? region.name : null);
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
     CONTACTS, PROBLEM HIGHLIGHTS, CROSS-SECTION, MEASUREMENT
     ==================================================================
     Four viewer features that all need the same thing: the transform in
     XF, so that a micrometre coordinate from the SCM and a point on the
     screen refer to the same place. They are grouped here for that reason.
     ================================================================== */

  /* ---------------------------------------------------------- contacts */

  const CONTACT_COLORS = {
    source_n: 0xff8c1a, drain_n: 0x1a73f2, gate_n: 0xe61a1a,
    source_p: 0xf2cc26, drain_p: 0x8c33bf, gate_p: 0xd95a8c,
    substrate: 0x8c8c99,
  };

  function contactColor(name) {
    if (CONTACT_COLORS[name] !== undefined) return CONTACT_COLORS[name];
    if (/source/i.test(name)) return 0xff8c1a;
    if (/drain/i.test(name)) return 0x1a73f2;
    if (/gate/i.test(name)) return 0xe61a1a;
    if (/sub|body|bulk/i.test(name)) return 0x8c8c99;
    return 0xffffff;
  }

  /**
   * Draw a marker at every contact pick point.
   *
   * A contact in SDE is a face, picked by a point that must land on it. The
   * marker is therefore drawn AT that point rather than over the whole
   * region: if a contact is misplaced, the marker is visibly floating in
   * space or buried inside the structure, which is the failure you want to
   * be able to see.
   */
  function setContacts(list) {
    if (!S.ready) return;
    disposeChildren(contactGroup);
    S.contacts = list || [];
    if (!S.contacts.length) return;

    const r = 0.42;
    /* Contacts cluster on the top face, so labels drawn at a fixed height
       land on top of each other - on a phone the seven names were a single
       unreadable pile. Each successive pin is drawn taller, which stacks
       the labels instead of overlapping them. */
    let idx = 0;
    for (const c of S.contacts) {
      const colour = contactColor(c.name);
      for (const p of (c.faces || [])) {
        if (!p) continue;
        const at = toWorld([p.x, p.y, p.z]);
        const lift = r * (4 + (idx % 4) * 2.6);
        idx++;

        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(r, 16, 12),
          new THREE.MeshBasicMaterial({ color: colour, depthTest: false }));
        dot.position.copy(at);
        dot.renderOrder = 10;
        dot.userData.contact = c.name;
        contactGroup.add(dot);

        // a short pin, so the marker reads as attached to a surface
        const pin = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            at.clone(), at.clone().add(new THREE.Vector3(0, lift, 0))]),
          new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
        pin.renderOrder = 10;
        contactGroup.add(pin);

        contactGroup.add(makeLabel(c.name, at.clone().add(
          new THREE.Vector3(0, lift + r * 1.8, 0)), colour));
      }
    }
    contactGroup.visible = S.showContacts;
  }

  /** A camera-facing text sprite. */
  function makeLabel(text, pos, colour) {
    const pad = 8;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = '600 28px system-ui, sans-serif';
    const w = g.measureText(text).width;
    c.width = Math.ceil(w + pad * 2);
    c.height = 44;
    const g2 = c.getContext('2d');
    g2.font = '600 28px system-ui, sans-serif';
    g2.fillStyle = 'rgba(10,14,20,.82)';
    g2.fillRect(0, 0, c.width, c.height);
    g2.strokeStyle = '#' + colour.toString(16).padStart(6, '0');
    g2.lineWidth = 2;
    g2.strokeRect(1, 1, c.width - 2, c.height - 2);
    g2.fillStyle = '#e8eef5';
    g2.textBaseline = 'middle';
    g2.fillText(text, pad, c.height / 2 + 1);

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false }));
    sp.position.copy(pos);
    sp.scale.set(c.width / c.height * 1.2, 1.2, 1);
    sp.renderOrder = 11;
    return sp;
  }

  function setShowContacts(on) {
    S.showContacts = !!on;
    if (contactGroup) contactGroup.visible = S.showContacts;
  }

  /* ------------------------------------------------- problem highlights */

  /**
   * Outline the regions a validation finding refers to.
   *
   * Drawn as a slightly enlarged wireframe box in amber or red, ignoring
   * depth, so a flagged region buried inside the structure is still
   * visible. This is what connects the issue list to the geometry: reading
   * "n_Sheet2_extS and n_Sheet2_chan overlap" is not the same as seeing
   * where they are.
   */
  function setFlagged(names, severity) {
    if (!S.ready) return;
    disposeChildren(flagGroup);
    S.flagged = names || [];
    if (!S.flagged.length) return;

    const colour = severity === 'warn' ? 0xe8a33d : 0xef4d4d;
    for (const name of S.flagged) {
      const mesh = meshes.find((m) => m.userData.region.name === name);
      if (!mesh) continue;
      const box = new THREE.LineSegments(unitEdges,
        new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
      box.scale.copy(mesh.scale).multiplyScalar(1.05);
      box.position.copy(mesh.position);
      box.renderOrder = 9;
      flagGroup.add(box);

      const glow = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.22, depthTest: false }));
      glow.scale.copy(mesh.scale).multiplyScalar(1.04);
      glow.position.copy(mesh.position);
      glow.renderOrder = 8;
      flagGroup.add(glow);
    }
  }

  /* ----------------------------------------------------- cross-section */

  const clipPlane = { plane: null };

  /**
   * Cut the model with a single plane so the inside can be inspected.
   *
   * `t` runs 0..1 across the model's own bounding box on that axis, so the
   * slider means the same thing whatever the device size.
   */
  function setClip(axis, t, flip) {
    S.clip.axis = axis || null;
    if (t !== undefined) S.clip.t = t;
    if (flip !== undefined) S.clip.flip = !!flip;
    applyClip();
  }

  function applyClip() {
    if (!renderer) return;
    const { axis, t, flip } = S.clip;

    if (!axis || !S.bounds) {
      renderer.clippingPlanes = [];
      clipPlane.plane = null;
      return;
    }

    const idx = { x: 0, y: 1, z: 2 }[axis];
    const lo = S.bounds[idx * 2], hi = S.bounds[idx * 2 + 1];
    const cut = lo + (hi - lo) * Math.max(0, Math.min(1, t));

    // the same transform the geometry went through
    const centre = [XF.cx, XF.cy, XF.cz][idx];
    const world = (cut - centre) * XF.s;

    const normal = new THREE.Vector3(
      axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    if (!flip) normal.negate();

    const plane = new THREE.Plane(normal, flip ? -world : world);
    clipPlane.plane = plane;
    renderer.clippingPlanes = [plane];
  }

  /* ------------------------------------------------------- measurement */

  function setMeasure(on) {
    S.measure.on = !!on;
    if (!S.measure.on) {
      S.measure.a = S.measure.b = null;
      disposeChildren(measureGroup);
      reportMeasure(null);
    }
  }

  /**
   * Record a measurement pick and, once there are two, draw the span.
   * Both the centre-to-centre distance and the face-to-face gap are
   * reported: for adjacent regions the gap is the number that matters, and
   * it is the one that tells you whether they actually touch.
   */
  function pickForMeasure(region) {
    if (!region) return;
    if (!S.measure.a || S.measure.b) {
      S.measure.a = region;
      S.measure.b = null;
    } else {
      S.measure.b = region;
    }
    drawMeasure();
  }

  function drawMeasure() {
    disposeChildren(measureGroup);
    const { a, b } = S.measure;
    if (!a) { reportMeasure(null); return; }

    const mark = (r, colour) => {
      const mesh = meshes.find((m) => m.userData.region.name === r.name);
      if (!mesh) return;
      const box = new THREE.LineSegments(unitEdges,
        new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
      box.scale.copy(mesh.scale).multiplyScalar(1.03);
      box.position.copy(mesh.position);
      box.renderOrder = 12;
      measureGroup.add(box);
    };
    mark(a, 0x35c46a);
    if (!b) { reportMeasure({ a, b: null }); return; }
    mark(b, 0x4c8dff);

    const pa = toWorld(a.center);
    const pb = toWorld(b.center);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([pa, pb]),
      new THREE.LineDashedMaterial({
        color: 0xffe14d, dashSize: 0.6, gapSize: 0.35, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 12;
    measureGroup.add(line);

    const d = Math.hypot(a.center[0] - b.center[0],
                         a.center[1] - b.center[1],
                         a.center[2] - b.center[2]);
    measureGroup.add(makeLabel((d * 1000).toFixed(2) + ' nm',
      pa.clone().add(pb).multiplyScalar(0.5), 0xffe14d));

    reportMeasure({ a, b, distance: d });
  }

  /** Face-to-face gap per axis; 0 means they touch or overlap. */
  function axisGap(a, b) {
    const g = (lo1, hi1, lo2, hi2) => Math.max(lo1 - hi2, lo2 - hi1, 0);
    return {
      x: g(a.x0, a.x1, b.x0, b.x1),
      y: g(a.y0, a.y1, b.y0, b.y1),
      z: g(a.z0, a.z1, b.z0, b.z1),
    };
  }

  function reportMeasure(m) {
    const el = $('#measure-readout');
    if (!el) return;
    if (!m) { el.textContent = 'Measure off.'; return; }
    if (!m.b) { el.textContent = `From ${m.a.name} - now click a second region.`; return; }
    const gap = axisGap(m.a, m.b);
    const worst = Math.max(gap.x, gap.y, gap.z);
    const nm = (v) => (v * 1000).toFixed(2) + ' nm';
    el.innerHTML =
      `<strong>${m.a.name}</strong> &rarr; <strong>${m.b.name}</strong><br>` +
      `centre-to-centre ${nm(m.distance)}<br>` +
      `gap X ${nm(gap.x)} &middot; Y ${nm(gap.y)} &middot; Z ${nm(gap.z)}<br>` +
      (worst <= 1e-9 ? 'the two regions touch or overlap' : `closest separation ${nm(worst)}`);
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
    /* Called by the layout code after the sidebar is dragged, after the
       Controls panel is collapsed, and after an Android orientation change.
       A CSS size change alone does not update the WebGL drawing buffer or
       the camera aspect ratio, so this has to be explicit. */
    resize: onResize,
    setContacts,
    setShowContacts,
    setFlagged,
    setClip,
    setMeasure,
    get selected() { return S.selected; },
    get bounds() { return S.bounds; },
  };

})();