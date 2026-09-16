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
    contactFaces: [],             // resolved faces, from SDEAnalyze
    contactLabels: false,         // names on the faces; off unless asked
    selectedContact: null,
    colorMode: 'material',        // material | doping | combined
    doping: null,                 // region name -> doping description
    ready: false,
    clip: { axis: null, t: 1, flip: false },
    measure: { on: false, a: null, b: null },
    flagged: [],
  };

  let renderer, scene, camera, perspCam, orthoCam, controls;
  let modelGroup, regionGroup, edgeGroup, axesGroup, highlight;
  let contactGroup, contactLabelGroup, flagGroup, measureGroup;

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
    contactLabelGroup = new THREE.Group();
    flagGroup = new THREE.Group();
    measureGroup = new THREE.Group();
    modelGroup.add(regionGroup, edgeGroup, contactGroup, contactLabelGroup,
                   flagGroup, measureGroup);
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

  /**
   * The colour a region is drawn in, for the current view mode.
   *
   *   material  the material palette, as always
   *   doping    the doping class colour; anything with no profile placed
   *             is drawn grey rather than being given a plausible colour
   *   combined  doping where a region is doped, material where it is not,
   *             so the doped silicon reads against the dielectric and metal
   */
  function colorFor(region) {
    if (S.colorMode === 'material' || !S.doping) return region.color;
    const d = S.doping.get ? S.doping.get(region.name) : S.doping[region.name];
    if (d && d.color) return d.color;
    return S.colorMode === 'doping' ? '#5a636e' : region.color;
  }

  /** Swap every region to the colour its current mode calls for. */
  function applyColors() {
    for (const m of meshes) {
      m.material.color.set(colorFor(m.userData.region));
      m.material.needsUpdate = true;
    }
    renderLegend(S.regions);
  }

  function setColorMode(mode) {
    S.colorMode = mode || 'material';
    if (!S.ready) return;
    applyColors();
  }

  function setDoping(map) {
    S.doping = map || null;
    if (!S.ready) return;
    applyColors();
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
        color: new THREE.Color(colorFor(r)),
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

    /* Contacts are tested first and independently: a contact quad sits just
       outside the face it covers, so a click on an electrode should select
       the electrode rather than the silicon a fraction behind it. */
    if (!S.measure.on && S.showContacts && contactGroup) {
      const ch = raycaster.intersectObjects(contactGroup.children, false);
      const hit = ch.find((h) => h.object.userData && h.object.userData.contact);
      if (hit) { selectContact(hit.object.userData.contact); return; }
    }

    const hits = raycaster.intersectObjects(regionGroup.children, false);
    const region = hits.length ? hits[0].object.userData.region : null;
    if (S.measure.on) { pickForMeasure(region); return; }
    select(region ? region.name : null);
  }

  /** Select a contact: outline its face and fill the inspector from it. */
  function selectContact(c) {
    S.selectedContact = c;
    S.selected = null;
    highlight.visible = false;
    rebuildContactHighlight();
    fillContactInfo(c);
  }

  /* The selected contact always shows its name, whatever the label setting:
     that is the "when useful" case - you asked which one this is. */
  function rebuildContactHighlight() {
    if (!contactGroup) return;
    for (const o of contactGroup.children) {
      const c = o.userData && o.userData.contact;
      if (!c || !o.material) continue;
      const on = S.selectedContact && c.name === S.selectedContact.name;
      if (o.material.opacity !== undefined && o.type === 'Mesh') {
        o.material.opacity = on ? 0.9 : 0.55;
      }
    }
    disposeChildren(contactLabelGroup);
    const show = S.contactLabels
      ? S.contactFaces.filter((c) => c.kind === 'face')
      : (S.selectedContact ? [S.selectedContact] : []);
    for (const c of show) {
      if (!c.rect) continue;
      const ax = c.rect.axis;
      const other = ['x', 'y', 'z'].filter((k) => k !== ax);
      const q = {};
      q[ax] = c.rect.at;
      for (const k of other) q[k] = (c.rect[k + '0'] + c.rect[k + '1']) / 2;
      contactLabelGroup.add(makeLabel(c.name, toWorld([q.x, q.y, q.z]),
        contactColor(c.name)));
    }
  }

  function select(name) {
    S.selected = name;
    // picking a region drops any contact selection, and vice versa
    if (S.selectedContact) { S.selectedContact = null; rebuildContactHighlight(); }
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
                    'lx', 'ly', 'lz', 'volume',
                    'dop-type', 'dop-conc', 'dop-profile'];
    if (!r) { fields.forEach((f) => set(f, '-')); return; }
    set('name', r.name);
    set('material', r.material);

    const d = S.doping && (S.doping.get ? S.doping.get(r.name) : S.doping[r.name]);
    if (d) {
      set('dop-type', `${d.label} (${d.netType === 'n' ? 'n-type' : 'p-type'})` +
                      (d.counterDoped ? ' counter-doped' : ''));
      set('dop-conc', d.netConc.toExponential(2) + ' cm-3');
      set('dop-profile', d.placements.map((x) =>
        `${x.profile}: ${x.species} ${Number(x.conc).toExponential(1)}`).join('; '));
    } else {
      set('dop-type', 'undoped');
      set('dop-conc', '-');
      set('dop-profile', 'no profile placed on this region');
    }
    ['x0', 'x1', 'y0', 'y1', 'z0', 'z1', 'lx', 'ly', 'lz'].forEach((f) => set(f, fmt(r[f])));
    set('volume', fmt(r.volume));
  }

  /**
   * The inspector, filled from a contact instead of a region.
   *
   * Reuses the same panel: a contact has a name, a material it sits on, a
   * position and an extent, which is what the fields already are. The three
   * doping rows carry the electrode facts that have no region equivalent -
   * type, which face, and how big it is.
   */
  function fillContactInfo(c) {
    const set = (f, v) => {
      const el = document.querySelector(`#region-info [data-f="${f}"]`);
      if (el) el.textContent = v;
    };
    const all = ['name', 'material', 'x0', 'x1', 'y0', 'y1', 'z0', 'z1',
                 'lx', 'ly', 'lz', 'volume', 'dop-type', 'dop-conc', 'dop-profile'];
    all.forEach((f) => set(f, '-'));
    if (!c) return;

    set('name', c.name + '  [contact]');
    set('material', c.material || '-');

    if (c.kind !== 'face') {
      set('dop-type', c.kind === 'unplaced' ? 'declared, never placed'
        : c.kind === 'unattached' ? 'pick point is not on any region'
        : 'pick point is on an edge or corner - ambiguous');
      if (c.at) {
        set('x0', fmt(c.at.x)); set('y0', fmt(c.at.y)); set('z0', fmt(c.at.z));
      }
      return;
    }

    const ax = c.rect.axis;
    const other = ['x', 'y', 'z'].filter((k) => k !== ax);
    set('dop-type', `face contact, ${c.side === 'max' ? '+' : '-'}${ax} face`);
    set('dop-conc', (c.area * 1e6).toFixed(1) + ' nm2' +
      (c.exposed ? '' : ' (buried face)'));
    set('dop-profile', `on region "${c.region}"`);

    for (const k of ['x', 'y', 'z']) {
      if (k === ax) { set(k + '0', fmt(c.rect.at)); set(k + '1', fmt(c.rect.at)); }
      else { set(k + '0', fmt(c.rect[k + '0'])); set(k + '1', fmt(c.rect[k + '1'])); }
    }
    set('lx', ax === 'x' ? '0' : fmt(c.rect.x1 - c.rect.x0));
    set('ly', ax === 'y' ? '0' : fmt(c.rect.y1 - c.rect.y0));
    set('lz', ax === 'z' ? '0' : fmt(c.rect.z1 - c.rect.z0));
    set('volume', '-');
  }

  /** Show every contact name on its face, or only the selected one. */
  function setContactLabels(on) {
    S.contactLabels = !!on;
    rebuildContactHighlight();
  }

  /**
   * The legend follows the view mode: in a doping view, a list of materials
   * explains nothing about what the colours now mean.
   */
  function renderLegend(regs) {
    const ul = $('#legend');
    const title = $('#legend-title');
    if (!ul) return;
    ul.innerHTML = '';

    const doping = S.colorMode !== 'material' && S.doping;
    if (title) title.textContent = doping ? 'Doping' : 'Materials';

    if (doping) {
      const get = (n) => (S.doping.get ? S.doping.get(n) : S.doping[n]);
      const classes = new Map();
      let undoped = 0;
      for (const r of regs) {
        const d = get(r.name);
        if (!d) { undoped++; continue; }
        if (!classes.has(d.label)) {
          classes.set(d.label, { color: d.color, range: d.range, n: 0,
                                 type: d.netType === 'n' ? 'donors' : 'acceptors' });
        }
        classes.get(d.label).n++;
      }
      const order = ['N+', 'N', 'N-', 'P+', 'P', 'P-'];
      for (const label of order) {
        const c = classes.get(label);
        if (!c) continue;
        const li = document.createElement('li');
        li.className = 'legend-doping';
        li.innerHTML =
          `<span class="swatch" style="background:${c.color}"></span>` +
          `<span class="lname">${label}<small>${c.range}</small></span>` +
          `<span class="lcount">${c.n}</span>`;
        li.title = `${label}: ${c.type}, ${c.range}`;
        ul.appendChild(li);
      }
      if (undoped) {
        const li = document.createElement('li');
        li.className = 'legend-doping';
        li.innerHTML =
          `<span class="swatch" style="background:${S.colorMode === 'doping' ? '#5a636e' : 'transparent'};` +
          `border-style:dashed"></span>` +
          `<span class="lname">undoped<small>no profile placed</small></span>` +
          `<span class="lcount">${undoped}</span>`;
        li.title = S.colorMode === 'combined'
          ? 'drawn in its material colour' : 'no doping profile placed on this region';
        ul.appendChild(li);
      }
      return;
    }

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
   * Draw every contact as the FACE it actually is.
   *
   * SDE's `set-contact-faces` turns a whole region face into the electrode;
   * the position in the script only picks which face. An earlier version
   * drew a dot at that pick point with the name on a pin above it, which
   * showed where the contact was declared but not what it covers - the
   * electrode's area and orientation, the two things that decide current
   * and where it is injected, were not on screen at all.
   *
   * So each contact is now a coloured quad laid on its real face, lifted off
   * the surface by a hair so it does not z-fight with the region beneath.
   * The quad carries the contact in userData, which makes it pickable like
   * any region. The pick point is still marked, small, because a contact on
   * the wrong face is only obvious if you can see where it was asked for.
   *
   * Anything that did not resolve to a single face - an unplaced set, a pick
   * that missed every region, a point on an edge - keeps the old marker, so
   * a broken contact still shows up rather than silently vanishing.
   */
  function setContacts(list, resolved) {
    if (!S.ready) return;
    disposeChildren(contactGroup);
    disposeChildren(contactLabelGroup);
    S.selectedContact = null;
    S.contacts = list || [];
    S.contactFaces = resolved || [];
    if (!S.contacts.length) return;

    const faces = S.contactFaces.filter((c) => c.kind === 'face');
    for (const c of faces) contactGroup.add(...contactFaceMeshes(c));

    // whatever could not be resolved to a face still gets a marker
    const broken = S.contactFaces.filter((c) => c.kind !== 'face' && c.at);
    let idx = 0;
    for (const c of broken) {
      const colour = contactColor(c.name);
      const at = toWorld([c.at.x, c.at.y, c.at.z]);
      const lift = 0.42 * (4 + (idx % 4) * 2.6);
      idx++;
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 16, 12),
        new THREE.MeshBasicMaterial({ color: colour, depthTest: false }));
      dot.position.copy(at);
      dot.renderOrder = 10;
      dot.userData.contact = c;
      contactGroup.add(dot);
      contactGroup.add(makeLabel(c.name + ' (' + c.kind + ')',
        at.clone().add(new THREE.Vector3(0, lift, 0)), colour));
    }
    contactGroup.visible = S.showContacts;
    rebuildContactHighlight();
    contactLabelGroup.visible = S.showContacts;
  }

  /** The quad, its outline, its pick-point tick and its label. */
  function contactFaceMeshes(c) {
    const colour = contactColor(c.name);
    const ax = c.rect.axis;
    const other = ['x', 'y', 'z'].filter((k) => k !== ax);
    const lo = {}, hi = {};
    for (const k of other) { lo[k] = c.rect[k + '0']; hi[k] = c.rect[k + '1']; }
    lo[ax] = hi[ax] = c.rect.at;

    /* Lift the quad off the surface along the face normal, outward, by a
       fraction of the device size - enough to beat depth precision at any
       zoom without visibly floating. */
    const nrm = c.side === 'max' ? 1 : -1;
    const eps = XF.scale ? (0.35 / XF.scale) : 0.0002;
    const corner = (u, v) => {
      const q = {};
      q[other[0]] = u ? hi[other[0]] : lo[other[0]];
      q[other[1]] = v ? hi[other[1]] : lo[other[1]];
      q[ax] = c.rect.at + nrm * eps;
      return toWorld([q.x, q.y, q.z]);
    };
    const p00 = corner(0, 0), p10 = corner(1, 0), p11 = corner(1, 1), p01 = corner(0, 1);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
      p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z,
    ], 3));
    g.computeVertexNormals();
    const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      depthWrite: false,
    }));
    quad.renderOrder = 8;
    quad.userData.contact = c;

    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([p00, p10, p11, p01]),
      new THREE.LineBasicMaterial({ color: colour }));
    outline.renderOrder = 9;

    const mid = p00.clone().add(p11).multiplyScalar(0.5);
    const out = [quad, outline];

    // the pick point, so a contact declared on the wrong face is visible
    if (c.at) {
      const tick = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffffff }));
      tick.position.copy(toWorld([c.at.x, c.at.y, c.at.z]));
      tick.renderOrder = 11;
      tick.userData.contact = c;
      out.push(tick);
    }
    return out;
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
    if (contactLabelGroup) contactLabelGroup.visible = S.showContacts;
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
    setContactLabels,
    selectContact,
    setShowContacts,
    setColorMode,
    setDoping,
    get colorMode() { return S.colorMode; },
    setFlagged,
    setClip,
    setMeasure,
    get selected() { return S.selected; },
    get bounds() { return S.bounds; },
  };

})();