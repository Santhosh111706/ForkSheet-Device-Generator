/* ==========================================================================
   js/generator.js
   --------------------------------------------------------------------------
   Browser port of gen_forksheet.py, the parametric generator for the V8
   3D Forksheet CMOS Sentaurus SDE structure.

   Everything runs client side. There is no Python, no Flask, no Node and no
   build step: the page can be opened from disk or served by GitHub Pages.

   The Python file is the source of truth. Every formula in compute(), every
   region in regionList(), every check in validate() and the whole SCM
   template in buildScm() were carried across unchanged, so the same inputs
   produce a byte-identical .scm file.

   Layout of this file
     1  constants and defaults
     2  compute()      every dependent coordinate
     3  regionList()   the 88 regions, in SCM build order
     4  validate()     input sanity plus 11 geometric checks
     5  buildScm()     the SCM text
     6  file naming and download
     7  UI wiring, live preview updates, single case and sweep modes
   ========================================================================== */

'use strict';

/* ==========================================================================
   1. CONSTANTS AND DEFAULTS
   ========================================================================== */

/* The three study parameters. Same defaults as the Python script. */
const DEFAULT_PARAMS = {
  T_NS:   0.006,      // nanosheet THICKNESS  -> vertical (Y) extent of a sheet
  W_NS:   0.030,      // nanosheet WIDTH      -> transverse (Z) extent
  T_FORK: 0.008,      // fork wall THICKNESS  -> nMOS-to-pMOS separation in Z
};

/* Fixed design constants. In gen_forksheet.py these sit at the top of the
   file and are meant to be edited there, so they are exposed here as
   editable fields under "Advanced" rather than being hard-coded away. */
const DEFAULT_CONSTANTS = {
  L_PAD:    0.025,    // source / drain pad length in X
  T_SPACER: 0.005,    // spacer thickness each side of the gate, in X
  L_G:      0.020,    // gate length in X
  T_HFO2:   0.002,    // HfO2 collar thickness, all four sides
  T_METAL:  0.006,    // gate metal thickness in each vertical gap
  T_LINER:  0.002,    // SiO2 gate liner thickness
  T_BRIDGE: 0.010,    // gate metal thickness on each Z side (the bridges)
  T_SUB:    0.150,    // total substrate depth
  T_WELL:   0.100,    // well depth measured from y = 0
  // mesh minimum element sizes, used by the warning checks
  MESH_MIN_X: 0.003,
  MESH_MIN_Y: 0.001,
  MESH_MIN_Z: 0.003,
};

/* Default sweep lists, matching T_NS_VALUES / W_NS_VALUES / T_FORK_VALUES. */
const DEFAULT_SWEEP = {
  T_NS:   '0.004, 0.005, 0.006',
  W_NS:   '0.015, 0.020, 0.025',
  T_FORK: '0.006, 0.008, 0.010',
};

const EPS = 1e-12;

/* Material colours, identical to MATERIAL_COLORS in models/region.py so the
   preview and the SCM Device Viewer colour the same structure the same way. */
const MATERIAL_COLORS = {
  'Silicon':     [0.25, 0.45, 0.85],
  'HfO2':        [0.95, 0.65, 0.15],
  'SiO2':        [0.60, 0.90, 0.95],
  'Si3N4':       [0.30, 0.75, 0.35],
  'TiN':         [0.55, 0.57, 0.60],
  'PolySilicon': [0.80, 0.40, 0.70],
  'Aluminum':    [0.75, 0.75, 0.78],
  'Copper':      [0.85, 0.55, 0.35],
  'Germanium':   [0.40, 0.35, 0.70],
  'Air':         [0.90, 0.90, 0.90],
  'Gas':         [0.90, 0.90, 0.90],
};
const DEFAULT_COLOR = [0.70, 0.70, 0.70];
const DARK_PREFIXES = ['substrate', 'sub_', 'bulk', 'handle'];
const DARK_FACTOR = 0.55;

function toHex(rgb) {
  return '#' + rgb.map((v) => {
    const n = Math.max(0, Math.min(255, Math.round(v * 255)));
    return n.toString(16).padStart(2, '0');
  }).join('');
}

/** Colour for a region, with a darker variant for substrate-like names. */
function materialColor(material, regionName) {
  const base = MATERIAL_COLORS[material] || DEFAULT_COLOR;
  const low = String(regionName || '').toLowerCase();
  const dark = DARK_PREFIXES.some((p) => low.startsWith(p) || low.includes('_' + p));
  return toHex(dark ? base.map((v) => v * DARK_FACTOR) : base);
}


/* ==========================================================================
   2. DEPENDENT COORDINATE CALCULATION
   Port of compute() in gen_forksheet.py. Every coordinate in the structure
   is derived here; nothing is hard-coded downstream.
   ========================================================================== */
function compute(t_ns, w_ns, t_fork, C) {
  const g = {};
  g.T_NS = t_ns; g.W_NS = w_ns; g.T_FORK = t_fork;

  // ---- X : source pad | spacer | gate | spacer | drain pad --------------
  g.x0  = 0.0;
  g.x1  = g.x0 + C.L_PAD;          // source pad ends
  g.xg0 = g.x1 + C.T_SPACER;       // gate starts
  g.xg1 = g.xg0 + C.L_G;           // gate ends
  g.x2  = g.xg1 + C.T_SPACER;      // drain pad starts
  g.x3  = g.x2 + C.L_PAD;          // device ends

  // ---- Y : vertical stack, driven by T_NS -------------------------------
  g.yl0  = 0.0;
  g.yl1  = g.yl0 + C.T_LINER;      // liner top
  g.ygb0 = g.yl1;                  // gate_bottom
  g.ygb1 = g.ygb0 + C.T_METAL;

  //   sheet-to-sheet pitch = sheet + HfO2 above + HfO2 below + metal gap
  g.y_pitch = t_ns + 2 * C.T_HFO2 + C.T_METAL;

  g.ya1 = g.ygb1 + C.T_HFO2;       // sheet 1 bottom
  g.yb1 = g.ya1 + t_ns;            // sheet 1 top
  g.ya2 = g.ya1 + g.y_pitch;       // sheet 2 bottom
  g.yb2 = g.ya2 + t_ns;
  g.ya3 = g.ya2 + g.y_pitch;       // sheet 3 bottom
  g.yb3 = g.ya3 + t_ns;

  g.ygt0 = g.yb3 + C.T_HFO2;       // gate_top bottom
  g.ygt1 = g.ygt0 + C.T_METAL;     // device top

  g.yi01_0 = g.yb1 + C.T_HFO2;     // gate_inter01 band
  g.yi01_1 = g.ya2 - C.T_HFO2;
  g.yi12_0 = g.yb2 + C.T_HFO2;     // gate_inter12 band
  g.yi12_1 = g.ya3 - C.T_HFO2;

  g.ybr0 = g.ygb1;                 // gate bridges span the whole stack
  g.ybr1 = g.ygt0;

  g.y_sd0 = 0.0;                   // S/D pad bottom
  g.y_sd1 = g.yb3;                 // S/D pad top follows sheet 3

  g.ysub0 = -C.T_SUB;
  g.ywell = -C.T_WELL;
  g.ysub1 = 0.0;

  // ---- Z : nMOS | fork wall | pMOS, driven by W_NS and T_FORK -----------
  g.zng0 = -(C.T_BRIDGE + C.T_HFO2);   // nMOS gate outer, -Z
  g.znh0 = g.zng0 + C.T_BRIDGE;        // HfO2 outer
  g.znc0 = g.znh0 + C.T_HFO2;          // channel, always 0.0
  g.znc1 = g.znc0 + w_ns;
  g.znh1 = g.znc1 + C.T_HFO2;
  g.zng1 = g.znh1 + C.T_BRIDGE;        // nMOS gate outer, +Z

  g.zw0 = g.zng1;                      // fork wall
  g.zw1 = g.zw0 + t_fork;

  g.zpg0 = g.zw1;                      // pMOS gate outer, -Z
  g.zph0 = g.zpg0 + C.T_BRIDGE;
  g.zpc0 = g.zph0 + C.T_HFO2;
  g.zpc1 = g.zpc0 + w_ns;
  g.zph1 = g.zpc1 + C.T_HFO2;
  g.zpg1 = g.zph1 + C.T_BRIDGE;        // pMOS gate outer, +Z

  g.z_well = g.zw0 + t_fork / 2.0;     // well split, wall midplane

  // ---- contact pick points ---------------------------------------------
  g.znc_mid = (g.znc0 + g.znc1) / 2.0;
  g.zpc_mid = (g.zpc0 + g.zpc1) / 2.0;

  return g;
}


/* ==========================================================================
   3. REGION LIST
   Port of region_list(). Mirrors the emitted SCM exactly and is used both
   for validation and for the 3D preview.
   ========================================================================== */
function regionList(g, C) {
  const R = [];
  const add = (n, m, ax, bx, ay, by, az, bz) => {
    R.push({
      name: n, material: m,
      x0: ax, x1: bx, y0: ay, y1: by, z0: az, z1: bz,
      lx: bx - ax, ly: by - ay, lz: bz - az,
      volume: (bx - ax) * (by - ay) * (bz - az),
      center: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
      color: materialColor(m, n),
    });
  };

  add('Substrate_Bulk', 'Silicon', g.x0, g.x3, g.ysub0, g.ywell, g.zng0, g.zpg1);
  add('Substrate_PW',   'Silicon', g.x0, g.x3, g.ywell, g.ysub1, g.zng0, g.z_well);
  add('Substrate_NW',   'Silicon', g.x0, g.x3, g.ywell, g.ysub1, g.z_well, g.zpg1);
  add('ForkWall',       'Si3N4',   g.x0, g.x3, g.ysub1, g.ygt1,  g.zw0,  g.zw1);

  const sheets = [['1', g.ya1, g.yb1], ['2', g.ya2, g.yb2], ['3', g.ya3, g.yb3]];

  const device = (tag, zga, zha, zca, zcb, zhb, zgb) => {
    add(tag + '_GateLiner', 'SiO2',    g.xg0, g.xg1, g.yl0,   g.yl1,   zga, zgb);
    add(tag + '_Source',    'Silicon', g.x0,  g.x1,  g.y_sd0, g.y_sd1, zga, zgb);
    add(tag + '_Drain',     'Silicon', g.x2,  g.x3,  g.y_sd0, g.y_sd1, zga, zgb);
    for (const [st, a, b] of sheets) {
      add(`${tag}_Sheet${st}_extS`, 'Silicon', g.x1,  g.xg0, a, b, zca, zcb);
      add(`${tag}_Sheet${st}_chan`, 'Silicon', g.xg0, g.xg1, a, b, zca, zcb);
      add(`${tag}_Sheet${st}_extD`, 'Silicon', g.xg1, g.x2,  a, b, zca, zcb);
    }
    for (const [st, a, b] of sheets) {
      add(`${tag}_HfO2_s${st}_bot`, 'HfO2', g.xg0, g.xg1, a - C.T_HFO2, a, zha, zhb);
      add(`${tag}_HfO2_s${st}_top`, 'HfO2', g.xg0, g.xg1, b, b + C.T_HFO2, zha, zhb);
      add(`${tag}_HfO2_s${st}_zlo`, 'HfO2', g.xg0, g.xg1, a, b, zha, zca);
      add(`${tag}_HfO2_s${st}_zhi`, 'HfO2', g.xg0, g.xg1, a, b, zcb, zhb);
    }
    add(tag + '_gate_bottom',   'TiN', g.xg0, g.xg1, g.ygb0,   g.ygb1,   zga, zgb);
    add(tag + '_gate_bridge_L', 'TiN', g.xg0, g.xg1, g.ybr0,   g.ybr1,   zga, zha);
    add(tag + '_gate_bridge_R', 'TiN', g.xg0, g.xg1, g.ybr0,   g.ybr1,   zhb, zgb);
    add(tag + '_gate_inter01',  'TiN', g.xg0, g.xg1, g.yi01_0, g.yi01_1, zha, zhb);
    add(tag + '_gate_inter12',  'TiN', g.xg0, g.xg1, g.yi12_0, g.yi12_1, zha, zhb);
    add(tag + '_gate_top',      'TiN', g.xg0, g.xg1, g.ygt0,   g.ygt1,   zga, zgb);
    for (const [sp, xa, xb] of [['S', g.x1, g.xg0], ['D', g.xg1, g.x2]]) {
      add(`${tag}_Sp${sp}_zlo`, 'Si3N4', xa, xb, g.yl0, g.ygt1, zga, zca);
      add(`${tag}_Sp${sp}_zhi`, 'Si3N4', xa, xb, g.yl0, g.ygt1, zcb, zgb);
      add(`${tag}_Sp${sp}_b`,   'Si3N4', xa, xb, g.yl0, g.ya1,  zca, zcb);
      add(`${tag}_Sp${sp}_m1`,  'Si3N4', xa, xb, g.yb1, g.ya2,  zca, zcb);
      add(`${tag}_Sp${sp}_m2`,  'Si3N4', xa, xb, g.yb2, g.ya3,  zca, zcb);
      add(`${tag}_Sp${sp}_t`,   'Si3N4', xa, xb, g.yb3, g.ygt1, zca, zcb);
    }
  };

  device('n', g.zng0, g.znh0, g.znc0, g.znc1, g.znh1, g.zng1);
  device('p', g.zpg0, g.zph0, g.zpc0, g.zpc1, g.zph1, g.zpg1);
  return R;
}


/* ==========================================================================
   4. VALIDATION
   Port of validate(). Errors block generation; warnings allow it.
   ========================================================================== */
function overlaps(a, b) {
  return (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS &&
          Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS &&
          Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > EPS);
}

function faceTouch(a, b) {
  const gaps = [Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
                Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
                Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0)];
  return gaps.every((v) => v > -EPS) &&
         gaps.filter((v) => Math.abs(v) < EPS).length === 1 &&
         gaps.filter((v) => v > EPS).length === 2;
}

function contactOrTouch(a, b) {
  const gaps = [Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
                Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
                Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0)];
  return gaps.every((v) => v > -EPS) && gaps.filter((v) => v > EPS).length >= 2;
}

function validate(t_ns, w_ns, t_fork, C) {
  const errs = [], warns = [];

  // -- input sanity, before any geometry is built ------------------------
  for (const [nm, v] of [['T_NS', t_ns], ['W_NS', w_ns], ['T_FORK', t_fork]]) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      errs.push(`${nm} must be a number`);
    } else if (v <= 0) {
      errs.push(`${nm} must be positive (got ${v}); zero or negative thickness is not a valid region`);
    }
  }
  if (errs.length) return { errs, warns, g: null, R: null };

  if (t_ns < 0.002) {
    errs.push(`T_NS = ${t_ns} um is thinner than the ${C.T_HFO2} um HfO2 collar; the sheet would be a sliver`);
  }
  if (w_ns < 0.005) errs.push(`W_NS = ${w_ns} um is unphysically narrow (< 5 nm)`);
  if (t_fork < 0.002) {
    errs.push(`T_FORK = ${t_fork} um gives less than 2 nm of nitride between nMOS and pMOS; isolation would be lost`);
  }
  if (C.L_G <= 2 * C.T_SPACER) {
    errs.push(`L_G = ${C.L_G} must exceed 2 x T_SPACER = ${2 * C.T_SPACER}`);
  }
  if (errs.length) return { errs, warns, g: null, R: null };

  const g = compute(t_ns, w_ns, t_fork, C);
  const R = regionList(g, C);

  // -- mesh resolution warnings ------------------------------------------
  if (t_ns < 3 * C.MESH_MIN_Y) {
    warns.push(`T_NS = ${t_ns} um gives only ${(t_ns / C.MESH_MIN_Y).toFixed(1)} elements across a sheet at the current Y minimum ${C.MESH_MIN_Y}; consider reducing MESH_MIN_Y`);
  }
  if (w_ns < 3 * C.MESH_MIN_Z) {
    warns.push(`W_NS = ${w_ns} um gives only ${(w_ns / C.MESH_MIN_Z).toFixed(1)} elements across a sheet in Z at minimum ${C.MESH_MIN_Z}`);
  }
  if (t_fork < 2 * C.MESH_MIN_Z) {
    warns.push(`T_FORK = ${t_fork} um is thin relative to the Z mesh minimum ${C.MESH_MIN_Z}`);
  }

  // -- 1. positive dimensions, no reversed coordinates -------------------
  for (const r of R) {
    if (!(r.x0 < r.x1 - EPS && r.y0 < r.y1 - EPS && r.z0 < r.z1 - EPS)) {
      errs.push(`region ${r.name} has a reversed or zero-thickness extent: (${r.x0},${r.y0},${r.z0}) -> (${r.x1},${r.y1},${r.z1})`);
    }
  }

  // -- 2. valid nanosheet spacing ----------------------------------------
  const need = 2 * C.T_HFO2 + C.T_METAL;
  for (const [nm, gp] of [['sheet1-sheet2', g.ya2 - g.yb1], ['sheet2-sheet3', g.ya3 - g.yb2]]) {
    if (gp < need - EPS) {
      errs.push(`${nm} spacing ${gp.toFixed(6)} um is below the ${need.toFixed(6)} um needed for HfO2 + metal + HfO2`);
    }
  }

  // -- 3. no overlaps anywhere -------------------------------------------
  const ov = [];
  for (let i = 0; i < R.length; i++) {
    for (let j = i + 1; j < R.length; j++) {
      if (overlaps(R[i], R[j])) ov.push([R[i].name, R[j].name]);
    }
  }
  ov.slice(0, 12).forEach(([a, b]) => errs.push(`regions overlap in volume: ${a} <-> ${b}`));
  if (ov.length > 12) errs.push(`...and ${ov.length - 12} further overlapping pairs`);

  // -- 4. gate metal must never touch silicon ----------------------------
  for (const tag of ['n', 'p']) {
    const G = R.filter((r) => r.material === 'TiN' && r.name.startsWith(tag + '_'));
    const S = R.filter((r) => r.material === 'Silicon' && r.name.startsWith(tag + '_'));
    for (const gm of G) for (const si of S) {
      if (contactOrTouch(gm, si)) errs.push(`gate metal touches silicon: ${gm.name} <-> ${si.name}`);
    }
  }

  // -- 5. continuous source -> channel -> drain, every sheet -------------
  for (const tag of ['n', 'p']) {
    const src = R.find((r) => r.name === `${tag}_Source`);
    const drn = R.find((r) => r.name === `${tag}_Drain`);
    for (const st of ['1', '2', '3']) {
      const a = R.find((r) => r.name === `${tag}_Sheet${st}_extS`);
      const b = R.find((r) => r.name === `${tag}_Sheet${st}_chan`);
      const c = R.find((r) => r.name === `${tag}_Sheet${st}_extD`);
      const chainOk = Math.abs(src.x1 - a.x0) < EPS && Math.abs(a.x1 - b.x0) < EPS &&
                      Math.abs(b.x1 - c.x0) < EPS && Math.abs(c.x1 - drn.x0) < EPS;
      const inside = a.y0 >= src.y0 - EPS && a.y1 <= src.y1 + EPS &&
                     a.z0 >= src.z0 - EPS && a.z1 <= src.z1 + EPS;
      if (!chainOk) errs.push(`${tag}MOS sheet${st}: Source|extS|chan|extD|Drain not contiguous in X`);
      if (!inside)  errs.push(`${tag}MOS sheet${st}: sheet cross-section is not contained in the S/D pad face`);
    }
  }

  // -- 6. every gate is one connected body -------------------------------
  for (const tag of ['n', 'p']) {
    const G = R.filter((r) => r.material === 'TiN' && r.name.startsWith(tag + '_'));
    const adj = new Map(G.map((x) => [x.name, new Set()]));
    for (let i = 0; i < G.length; i++) {
      for (let j = i + 1; j < G.length; j++) {
        if (faceTouch(G[i], G[j])) {
          adj.get(G[i].name).add(G[j].name);
          adj.get(G[j].name).add(G[i].name);
        }
      }
    }
    const seen = new Set([G[0].name]);
    const stack = [G[0].name];
    while (stack.length) {
      for (const nb of adj.get(stack.pop())) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    if (seen.size !== G.length) {
      const floating = G.map((x) => x.name).filter((x) => !seen.has(x));
      errs.push(`${tag}MOS gate is not one connected body: ${floating.join(', ')} float`);
    }
  }

  // -- 7. nMOS and pMOS isolation ----------------------------------------
  for (const mat of ['TiN', 'Silicon']) {
    const Ns = R.filter((r) => r.material === mat && r.name.startsWith('n_'));
    const Ps = R.filter((r) => r.material === mat && r.name.startsWith('p_'));
    for (const a of Ns) for (const b of Ps) {
      if (contactOrTouch(a, b)) {
        errs.push(`nMOS/pMOS ${mat} contact across the fork wall: ${a.name} <-> ${b.name}`);
      }
    }
  }
  if (g.zw1 - g.zw0 < EPS) errs.push('fork wall has zero thickness');

  // -- 8. HfO2 collar closure --------------------------------------------
  for (const [tag, zca, zcb] of [['n', g.znc0, g.znc1], ['p', g.zpc0, g.zpc1]]) {
    for (const [st, a, b] of [['s1', g.ya1, g.yb1], ['s2', g.ya2, g.yb2], ['s3', g.ya3, g.yb3]]) {
      const c = R.filter((r) => r.name.startsWith(`${tag}_HfO2_${st}`));
      if (c.length !== 4) { errs.push(`${tag}MOS ${st}: expected 4 HfO2 slabs, found ${c.length}`); continue; }
      const below = c.some((r) => Math.abs(r.y1 - a) < EPS);
      const above = c.some((r) => Math.abs(r.y0 - b) < EPS);
      const zlo   = c.some((r) => Math.abs(r.z1 - zca) < EPS);
      const zhi   = c.some((r) => Math.abs(r.z0 - zcb) < EPS);
      if (!(below && above && zlo && zhi)) {
        errs.push(`${tag}MOS ${st}: HfO2 collar is not closed (below=${below} above=${above} -Z=${zlo} +Z=${zhi})`);
      }
    }
  }

  // -- 9. spacers must not occupy channel volume -------------------------
  for (const tag of ['n', 'p']) {
    const SP = R.filter((r) => r.material === 'Si3N4' && r.name.startsWith(`${tag}_Sp`));
    const SH = R.filter((r) => r.name.startsWith(`${tag}_Sheet`));
    for (const s of SP) for (const h of SH) {
      if (overlaps(s, h)) errs.push(`spacer blocks the channel: ${s.name} <-> ${h.name}`);
    }
  }

  // -- 10. contact pick points land on external faces --------------------
  const probes = [
    ['source_n',  (g.x0 + g.x1) / 2,  g.y_sd1, g.znc_mid, 'n_Source',       'top'],
    ['drain_n',   (g.x2 + g.x3) / 2,  g.y_sd1, g.znc_mid, 'n_Drain',        'top'],
    ['gate_n',    (g.xg0 + g.xg1) / 2, g.ygt1, g.znc_mid, 'n_gate_top',     'top'],
    ['source_p',  (g.x0 + g.x1) / 2,  g.y_sd1, g.zpc_mid, 'p_Source',       'top'],
    ['drain_p',   (g.x2 + g.x3) / 2,  g.y_sd1, g.zpc_mid, 'p_Drain',        'top'],
    ['gate_p',    (g.xg0 + g.xg1) / 2, g.ygt1, g.zpc_mid, 'p_gate_top',     'top'],
    ['substrate', (g.x0 + g.x3) / 2,  g.ysub0, g.znc_mid, 'Substrate_Bulk', 'bottom'],
  ];
  for (const [cname, px, py, pz, want, facing] of probes) {
    const owner = R.filter((r) => r.x0 - EPS <= px && px <= r.x1 + EPS &&
                                  r.y0 - EPS <= py && py <= r.y1 + EPS &&
                                  r.z0 - EPS <= pz && pz <= r.z1 + EPS).map((r) => r.name);
    if (!owner.includes(want)) {
      errs.push(`contact ${cname}: pick point is not on ${want} (lands on ${owner.join(', ') || 'nothing'})`);
    }
    const blockers = R.filter((r) => r.x0 < px && px < r.x1 && r.z0 < pz && pz < r.z1 &&
      (facing === 'top' ? r.y0 >= py - EPS : r.y1 <= py + EPS) && !owner.includes(r.name)).map((r) => r.name);
    if (blockers.length) {
      errs.push(`contact ${cname}: face is not external, buried under ${blockers.join(', ')}`);
    }
  }

  // -- 11. gate pick must not land in the fork wall ----------------------
  if (g.zw0 - EPS <= g.znc_mid && g.znc_mid <= g.zw1 + EPS) {
    errs.push('gate_n pick point falls inside the fork wall');
  }
  if (g.zw0 - EPS <= g.zpc_mid && g.zpc_mid <= g.zw1 + EPS) {
    errs.push('gate_p pick point falls inside the fork wall');
  }

  return { errs, warns, g, R };
}


/* ==========================================================================
   5. SCM EMITTER
   ========================================================================== */

/**
 * Format a length for Scheme.
 *
 * Mirrors n() in gen_forksheet.py exactly:
 *     f"{v:.6f}".rstrip("0"), append "0" if it ends in ".",
 *     and normalise "-0.0" to "0.0".
 * Matching this character for character is what keeps the generated file
 * byte-identical to the Python output.
 */
function n(v) {
  let s = Number(v).toFixed(6);
  if (Object.is(v, -0)) s = (0).toFixed(6);
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (s === '-0.0' || s === '-0.') s = '0.0';
  return s;
}

function buildScm(G, meshPrefix, C) {
  return `;; =====================================================================
;;  3D FORKSHEET CMOS  --  generated from the V8 baseline
;;  NMOS  |  Si3N4 fork wall  |  PMOS
;;  Sentaurus Structure Editor W-2024.09-SP1.  Units: micrometers.
;;
;;  AUTO-GENERATED by gen_forksheet.py -- do not hand-edit.
;;  Change the parameters in the Python script and regenerate.
;;
;;  THIS CASE:
;;      T_NS   = ${n(G.T_NS)}   nanosheet thickness   (Y extent of a sheet)
;;      W_NS   = ${n(G.W_NS)}   nanosheet width       (Z extent of a sheet)
;;      T_FORK = ${n(G.T_FORK)}   fork wall thickness   (nMOS-pMOS separation)
;;
;;  All other coordinates below were recomputed from those three values.
;;  The geometry concept, materials, doping, contacts, build order and
;;  mesh strategy are identical to the V7 baseline.
;;
;;  ---------------------------------------------------------------
;;  COORDINATE CONVENTION
;;  ---------------------------------------------------------------
;;    X = source -> drain transport direction
;;    Y = vertical, nanosheet STACKING direction (substrate at -Y)
;;    Z = nanosheet WIDTH direction, and the direction separating
;;        nMOS from pMOS across the fork wall
;;
;;    Z:  ${n(G.zng0)} .. ${n(G.zng1)}   nMOS gate envelope
;;        ${n(G.zw0)} .. ${n(G.zw1)}   Si3N4 fork wall  (T_FORK)
;;        ${n(G.zpg0)} .. ${n(G.zpg1)}   pMOS gate envelope
;;
;;  set-process-up-direction governs process emulation, which is not
;;  used here -- the structure is built entirely from explicit
;;  create-cuboid calls -- so it is inert and left at the SDE default.
;; =====================================================================

(sde:clear)
(sde:set-process-up-direction "+z")

;; Safety net only.  This file contains NO overlapping volumes, so the
;; rule is never invoked; it is set so that a future edit introducing
;; an overlap behaves deterministically rather than version-dependently.
(sdegeo:set-default-boolean "ABA")


;; =====================================================================
;; 1. PARAMETERS  (numeric values computed by gen_forksheet.py)
;; =====================================================================

;; ---- the three study parameters -------------------------------------
(define T_NS      ${n(G.T_NS)})       ; nanosheet thickness
(define W_NS      ${n(G.W_NS)})       ; nanosheet width
(define t_wall    ${n(G.T_FORK)})       ; T_FORK, fork wall thickness

;; ---- fixed design constants -----------------------------------------
(define L_pad     ${n(C.L_PAD)})       ; source / drain pad length
(define t_spacer  ${n(C.T_SPACER)})       ; spacer thickness each side of the gate
(define L_G       ${n(C.L_G)})       ; gate length
(define t_hfo2    ${n(C.T_HFO2)})       ; HfO2 thickness, all four sides
(define t_metal   ${n(C.T_METAL)})       ; gate metal thickness in each vertical gap
(define t_liner   ${n(C.T_LINER)})       ; SiO2 liner under each gate
(define t_bridge  ${n(C.T_BRIDGE)})       ; gate metal thickness on each Z side
(define t_sub     ${n(C.T_SUB)})       ; total substrate depth
(define t_well    ${n(C.T_WELL)})       ; well depth measured from y = 0

;; ---- X : source pad | spacer | gate | spacer | drain pad -------------
(define x0   ${n(G.x0)})
(define x1   ${n(G.x1)})            ; source pad ends
(define xg0  ${n(G.xg0)})            ; gate starts
(define xg1  ${n(G.xg1)})            ; gate ends
(define x2   ${n(G.x2)})            ; drain pad starts
(define x3   ${n(G.x3)})            ; device ends

;; ---- Y : vertical stacking, driven by T_NS ---------------------------
(define yl0     ${n(G.yl0)})
(define yl1     ${n(G.yl1)})         ; liner top
(define ygb0    ${n(G.ygb0)})         ; gate_bottom
(define ygb1    ${n(G.ygb1)})
(define y_pitch ${n(G.y_pitch)})         ; T_NS + 2*t_hfo2 + t_metal
(define ya1     ${n(G.ya1)})         ; sheet 1 bottom
(define yb1     ${n(G.yb1)})         ; sheet 1 top
(define ya2     ${n(G.ya2)})         ; sheet 2 bottom
(define yb2     ${n(G.yb2)})
(define ya3     ${n(G.ya3)})         ; sheet 3 bottom
(define yb3     ${n(G.yb3)})
(define ygt0    ${n(G.ygt0)})         ; gate_top bottom
(define ygt1    ${n(G.ygt1)})         ; device top
(define yi01_0  ${n(G.yi01_0)})         ; gate_inter01 band
(define yi01_1  ${n(G.yi01_1)})
(define yi12_0  ${n(G.yi12_0)})         ; gate_inter12 band
(define yi12_1  ${n(G.yi12_1)})
(define ybr0    ${n(G.ybr0)})         ; gate bridges span the whole stack
(define ybr1    ${n(G.ybr1)})
(define y_sd0   ${n(G.y_sd0)})         ; S/D pad bottom
(define y_sd1   ${n(G.y_sd1)})         ; S/D pad top = sheet 3 top
(define ysub0   ${n(G.ysub0)})        ; substrate bottom
(define ywell   ${n(G.ywell)})        ; well / bulk boundary
(define ysub1   ${n(G.ysub1)})         ; substrate top

;; ---- Z : nMOS | fork wall | pMOS, driven by W_NS and T_FORK ----------
(define zng0    ${n(G.zng0)})        ; nMOS gate outer, -Z
(define znh0    ${n(G.znh0)})        ; HfO2 outer
(define znc0    ${n(G.znc0)})         ; channel
(define znc1    ${n(G.znc1)})
(define znh1    ${n(G.znh1)})
(define zng1    ${n(G.zng1)})         ; nMOS gate outer, +Z
(define zw0     ${n(G.zw0)})         ; fork wall
(define zw1     ${n(G.zw1)})
(define zpg0    ${n(G.zpg0)})         ; pMOS gate outer, -Z
(define zph0    ${n(G.zph0)})
(define zpc0    ${n(G.zpc0)})         ; channel
(define zpc1    ${n(G.zpc1)})
(define zph1    ${n(G.zph1)})
(define zpg1    ${n(G.zpg1)})         ; pMOS gate outer, +Z
(define z_well  ${n(G.z_well)})         ; well split, fork wall mid-plane


;; =====================================================================
;; 2. BUILD ORDER AND BOOLEAN POLICY
;;
;;   This file contains NO intentional overlap.  Gate metal, gate
;;   dielectric, spacers, sheets and substrate are each decomposed into
;;   disjoint cuboids meeting on shared faces, rather than being carved
;;   out of solid blocks by Boolean subtraction.  Therefore:
;;     - no later region can replace a channel, spacer, dielectric or
;;       gate piece, since none claims a volume another already holds;
;;     - the result does not depend on whether the default Boolean rule
;;       means "new wins" or "existing wins";
;;     - creation order is chosen for readability only.
;;   Order: substrate -> fork wall -> nMOS -> pMOS.
;; =====================================================================


;; =====================================================================
;; 3. SUBSTRATE  --  three abutting regions
;;
;;   Substrate_Bulk carries the bottom face and therefore the substrate
;;   contact.  Substrate_PW and Substrate_NW sit on top of it side by
;;   side, split at the fork wall mid-plane z = z_well.  This makes the
;;   n-well a REGION rather than a compensating implant.
;; =====================================================================

(sdegeo:create-cuboid (position x0 ysub0 zng0) (position x3 ywell zpg1)
  "Silicon" "Substrate_Bulk")

(sdegeo:create-cuboid (position x0 ywell zng0) (position x3 ysub1 z_well)
  "Silicon" "Substrate_PW")

(sdegeo:create-cuboid (position x0 ywell z_well) (position x3 ysub1 zpg1)
  "Silicon" "Substrate_NW")


;; =====================================================================
;; 4. Si3N4 FORKSHEET WALL
;;    Full device length, full device height.  The only thing between
;;    the two transistors.  Every nMOS body ends at zng1 and every pMOS
;;    body begins at zpg0, so neither silicon nor metal crosses it.
;; =====================================================================

(sdegeo:create-cuboid (position x0 ysub1 zw0) (position x3 ygt1 zw1)
  "Si3N4" "ForkWall")


;; =====================================================================
;; 5. BUILD HELPERS
;;    Both transistors use the same three procedures, so the pMOS is a
;;    geometric mirror of the nMOS and cannot drift from it.  Only the
;;    Z boundaries differ.
;; =====================================================================

;; ---- HfO2 collar: four disjoint slabs enclosing one nanosheet -------
;;   below : Y [ya-t, ya]  Z [zha, zhb]   (full width)
;;   above : Y [yb, yb+t]  Z [zha, zhb]   (full width)
;;   -Z    : Y [ya, yb]    Z [zha, zca]
;;   +Z    : Y [ya, yb]    Z [zcb, zhb]
;;   below/above are disjoint from the sides in Y, the sides disjoint
;;   from the silicon in Z.  Together they close a collar, so no line
;;   leaves the silicon and reaches metal without crossing HfO2.
(define (hfo2-collar tag st ya yb zha zca zcb zhb)
  (sdegeo:create-cuboid (position xg0 (- ya t_hfo2) zha) (position xg1 ya zhb)
    "HfO2" (string-append tag "_HfO2_" st "_bot"))
  (sdegeo:create-cuboid (position xg0 yb zha) (position xg1 (+ yb t_hfo2) zhb)
    "HfO2" (string-append tag "_HfO2_" st "_top"))
  (sdegeo:create-cuboid (position xg0 ya zha) (position xg1 yb zca)
    "HfO2" (string-append tag "_HfO2_" st "_zlo"))
  (sdegeo:create-cuboid (position xg0 ya zcb) (position xg1 yb zhb)
    "HfO2" (string-append tag "_HfO2_" st "_zhi"))
)

;; ---- Si3N4 spacer: six disjoint pieces tiling one spacer window -----
;;   Fills the gate envelope in that X window EXCEPT the volume held by
;;   the three nanosheets, which pass straight through.  The spacer can
;;   therefore never cut, replace or block a channel.
(define (spacer-set tag sp xa xb zga zca zcb zgb)
  (sdegeo:create-cuboid (position xa yl0 zga) (position xb ygt1 zca)
    "Si3N4" (string-append tag "_Sp" sp "_zlo"))
  (sdegeo:create-cuboid (position xa yl0 zcb) (position xb ygt1 zgb)
    "Si3N4" (string-append tag "_Sp" sp "_zhi"))
  (sdegeo:create-cuboid (position xa yl0 zca) (position xb ya1 zcb)
    "Si3N4" (string-append tag "_Sp" sp "_b"))
  (sdegeo:create-cuboid (position xa yb1 zca) (position xb ya2 zcb)
    "Si3N4" (string-append tag "_Sp" sp "_m1"))
  (sdegeo:create-cuboid (position xa yb2 zca) (position xb ya3 zcb)
    "Si3N4" (string-append tag "_Sp" sp "_m2"))
  (sdegeo:create-cuboid (position xa yb3 zca) (position xb ygt1 zcb)
    "Si3N4" (string-append tag "_Sp" sp "_t"))
)

;; ---- one nanosheet, split into three abutting regions in X ----------
;;   extS  x1 ..xg0   under the source-side spacer  -> extension doping
;;   chan  xg0..xg1   under the gate                -> channel doping
;;   extD  xg1..x2    under the drain-side spacer   -> extension doping
;;   The three share coincident faces and are the same material, so the
;;   sheet is one continuous conductor.  The metallurgical junctions
;;   land exactly on the two gate edges.
(define (sheet-triplet tag st ya yb zca zcb)
  (sdegeo:create-cuboid (position x1 ya zca) (position xg0 yb zcb)
    "Silicon" (string-append tag "_Sheet" st "_extS"))
  (sdegeo:create-cuboid (position xg0 ya zca) (position xg1 yb zcb)
    "Silicon" (string-append tag "_Sheet" st "_chan"))
  (sdegeo:create-cuboid (position xg1 ya zca) (position x2 yb zcb)
    "Silicon" (string-append tag "_Sheet" st "_extD"))
)

;; ---- one complete transistor ----------------------------------------
;;   TiN gate, six disjoint pieces, all joined on shared faces:
;;     gate_bottom   Y ygb0..ygb1    Z zga..zgb   full width
;;     gate_bridge_L Y ybr0..ybr1    Z zga..zha   full height
;;     gate_bridge_R Y ybr0..ybr1    Z zhb..zgb   full height
;;     gate_inter01  Y yi01_0..yi01_1  Z zha..zhb between the bridges
;;     gate_inter12  Y yi12_0..yi12_1  Z zha..zhb between the bridges
;;     gate_top      Y ygt0..ygt1    Z zga..zgb   full width
;;   bottom meets both bridges at ygb1; the bridges meet both inter
;;   slabs on their Z faces and gate_top at ygt0.  Every piece reaches
;;   every other through metal, so one contact on gate_top drives all
;;   three channels and no fragment can float.
(define (build-mosfet tag zga zha zca zcb zhb zgb)

  ;; SiO2 liner under the gate footprint: keeps TiN off the substrate
  (sdegeo:create-cuboid (position xg0 yl0 zga) (position xg1 yl1 zgb)
    "SiO2" (string-append tag "_GateLiner"))

  ;; source and drain pads.  They span the full gate envelope in Z and
  ;; from y_sd0 to the top of sheet 3, so every sheet meets a pad face
  ;; completely at x1 and x2.
  (sdegeo:create-cuboid (position x0 y_sd0 zga) (position x1 y_sd1 zgb)
    "Silicon" (string-append tag "_Source"))
  (sdegeo:create-cuboid (position x2 y_sd0 zga) (position x3 y_sd1 zgb)
    "Silicon" (string-append tag "_Drain"))

  ;; three stacked nanosheets, each as extS | chan | extD
  (sheet-triplet tag "1" ya1 yb1 zca zcb)
  (sheet-triplet tag "2" ya2 yb2 zca zcb)
  (sheet-triplet tag "3" ya3 yb3 zca zcb)

  ;; gate dielectric collars
  (hfo2-collar tag "s1" ya1 yb1 zha zca zcb zhb)
  (hfo2-collar tag "s2" ya2 yb2 zha zca zcb zhb)
  (hfo2-collar tag "s3" ya3 yb3 zha zca zcb zhb)

  ;; TiN gate, six connected pieces
  (sdegeo:create-cuboid (position xg0 ygb0 zga) (position xg1 ygb1 zgb)
    "TiN" (string-append tag "_gate_bottom"))
  (sdegeo:create-cuboid (position xg0 ybr0 zga) (position xg1 ybr1 zha)
    "TiN" (string-append tag "_gate_bridge_L"))
  (sdegeo:create-cuboid (position xg0 ybr0 zhb) (position xg1 ybr1 zgb)
    "TiN" (string-append tag "_gate_bridge_R"))
  (sdegeo:create-cuboid (position xg0 yi01_0 zha) (position xg1 yi01_1 zhb)
    "TiN" (string-append tag "_gate_inter01"))
  (sdegeo:create-cuboid (position xg0 yi12_0 zha) (position xg1 yi12_1 zhb)
    "TiN" (string-append tag "_gate_inter12"))
  (sdegeo:create-cuboid (position xg0 ygt0 zga) (position xg1 ygt1 zgb)
    "TiN" (string-append tag "_gate_top"))

  ;; spacers, source side and drain side
  (spacer-set tag "S" x1  xg0 zga zca zcb zgb)
  (spacer-set tag "D" xg1 x2  zga zca zcb zgb)
)


;; =====================================================================
;; 6. THE TWO TRANSISTORS
;; =====================================================================

(build-mosfet "n" zng0 znh0 znc0 znc1 znh1 zng1)
(build-mosfet "p" zpg0 zph0 zpc0 zpc1 zph1 zpg1)


;; =====================================================================
;; 7. DOPING  --  REGION-BASED THROUGHOUT
;;
;;   Every profile below is bound to a NAMED REGION with
;;   sdedr:define-constant-profile-region.  There is not one doping
;;   refinement-window in this file, so:
;;     - no profile can be applied to the Silicon material as a whole;
;;     - no profile can spill into a neighbouring region;
;;     - no mesh node on a shared plane is ambiguous.
;;   Because doping follows region NAMES, not coordinates, it stays
;;   correctly aligned automatically when T_NS, W_NS or T_FORK change.
;;
;;   Resulting profile along each nMOS sheet in X:
;;      n+ 1e20 | n+ 5e19 | p 3e17 | n+ 5e19 | n+ 1e20
;;      pad       extS      chan     extD      pad
;;   and the complementary p+ / n / p+ for the pMOS.
;; =====================================================================

;; ---- profile definitions --------------------------------------------
(sdedr:define-constant-profile "Prof_Bulk"    "BoronActiveConcentration"      1e17)
(sdedr:define-constant-profile "Prof_PWell"   "BoronActiveConcentration"      1e17)
(sdedr:define-constant-profile "Prof_NWell"   "PhosphorusActiveConcentration" 1e17)

(sdedr:define-constant-profile "Prof_nChan"   "BoronActiveConcentration"      3e17)
(sdedr:define-constant-profile "Prof_nExt"    "ArsenicActiveConcentration"    5e19)
(sdedr:define-constant-profile "Prof_nSD"     "ArsenicActiveConcentration"    1e20)

(sdedr:define-constant-profile "Prof_pChan"   "PhosphorusActiveConcentration" 3e17)
(sdedr:define-constant-profile "Prof_pExt"    "BoronActiveConcentration"      5e19)
(sdedr:define-constant-profile "Prof_pSD"     "BoronActiveConcentration"      1e20)

;; ---- substrate -------------------------------------------------------
(sdedr:define-constant-profile-region "Pl_Bulk"  "Prof_Bulk"  "Substrate_Bulk")
(sdedr:define-constant-profile-region "Pl_PWell" "Prof_PWell" "Substrate_PW")
(sdedr:define-constant-profile-region "Pl_NWell" "Prof_NWell" "Substrate_NW")

;; ---- nMOS source and drain pads : n+ ---------------------------------
(sdedr:define-constant-profile-region "Pl_nSrc" "Prof_nSD" "n_Source")
(sdedr:define-constant-profile-region "Pl_nDrn" "Prof_nSD" "n_Drain")

;; ---- nMOS extensions under the spacers : n+ --------------------------
(sdedr:define-constant-profile-region "Pl_nS1_eS" "Prof_nExt" "n_Sheet1_extS")
(sdedr:define-constant-profile-region "Pl_nS1_eD" "Prof_nExt" "n_Sheet1_extD")
(sdedr:define-constant-profile-region "Pl_nS2_eS" "Prof_nExt" "n_Sheet2_extS")
(sdedr:define-constant-profile-region "Pl_nS2_eD" "Prof_nExt" "n_Sheet2_extD")
(sdedr:define-constant-profile-region "Pl_nS3_eS" "Prof_nExt" "n_Sheet3_extS")
(sdedr:define-constant-profile-region "Pl_nS3_eD" "Prof_nExt" "n_Sheet3_extD")

;; ---- nMOS channels under the gate : lightly doped p ------------------
(sdedr:define-constant-profile-region "Pl_nS1_ch" "Prof_nChan" "n_Sheet1_chan")
(sdedr:define-constant-profile-region "Pl_nS2_ch" "Prof_nChan" "n_Sheet2_chan")
(sdedr:define-constant-profile-region "Pl_nS3_ch" "Prof_nChan" "n_Sheet3_chan")

;; ---- pMOS source and drain pads : p+ ---------------------------------
(sdedr:define-constant-profile-region "Pl_pSrc" "Prof_pSD" "p_Source")
(sdedr:define-constant-profile-region "Pl_pDrn" "Prof_pSD" "p_Drain")

;; ---- pMOS extensions under the spacers : p+ --------------------------
(sdedr:define-constant-profile-region "Pl_pS1_eS" "Prof_pExt" "p_Sheet1_extS")
(sdedr:define-constant-profile-region "Pl_pS1_eD" "Prof_pExt" "p_Sheet1_extD")
(sdedr:define-constant-profile-region "Pl_pS2_eS" "Prof_pExt" "p_Sheet2_extS")
(sdedr:define-constant-profile-region "Pl_pS2_eD" "Prof_pExt" "p_Sheet2_extD")
(sdedr:define-constant-profile-region "Pl_pS3_eS" "Prof_pExt" "p_Sheet3_extS")
(sdedr:define-constant-profile-region "Pl_pS3_eD" "Prof_pExt" "p_Sheet3_extD")

;; ---- pMOS channels under the gate : lightly doped n ------------------
(sdedr:define-constant-profile-region "Pl_pS1_ch" "Prof_pChan" "p_Sheet1_chan")
(sdedr:define-constant-profile-region "Pl_pS2_ch" "Prof_pChan" "p_Sheet2_chan")
(sdedr:define-constant-profile-region "Pl_pS3_ch" "Prof_pChan" "p_Sheet3_chan")


;; =====================================================================
;; 8. CONTACTS  (seven)
;;
;;   Pick points for this case:
;;     source_n   (${n((G.x0+G.x1)/2)}, ${n(G.y_sd1)}, ${n(G.znc_mid)})
;;     drain_n    (${n((G.x2+G.x3)/2)}, ${n(G.y_sd1)}, ${n(G.znc_mid)})
;;     gate_n     (${n((G.xg0+G.xg1)/2)}, ${n(G.ygt1)}, ${n(G.znc_mid)})
;;     source_p   (${n((G.x0+G.x1)/2)}, ${n(G.y_sd1)}, ${n(G.zpc_mid)})
;;     drain_p    (${n((G.x2+G.x3)/2)}, ${n(G.y_sd1)}, ${n(G.zpc_mid)})
;;     gate_p     (${n((G.xg0+G.xg1)/2)}, ${n(G.ygt1)}, ${n(G.zpc_mid)})
;;     substrate  (${n((G.x0+G.x3)/2)}, ${n(G.ysub0)}, ${n(G.znc_mid)})
;;
;;   The pick points are written as expressions in the defines above, so
;;   they track the geometry automatically.  znc_mid and zpc_mid are the
;;   channel mid-planes; neither lies inside the fork wall, so each gate
;;   pick returns metal rather than nitride.
;; =====================================================================

(define znc_mid (/ (+ znc0 znc1) 2))
(define zpc_mid (/ (+ zpc0 zpc1) 2))

(sdegeo:define-contact-set "source_n"  4.0 (color:rgb 1.00 0.55 0.10) "##")
(sdegeo:define-contact-set "drain_n"   4.0 (color:rgb 0.10 0.45 0.95) "##")
(sdegeo:define-contact-set "gate_n"    4.0 (color:rgb 0.90 0.10 0.10) "##")
(sdegeo:define-contact-set "source_p"  4.0 (color:rgb 0.95 0.80 0.15) "##")
(sdegeo:define-contact-set "drain_p"   4.0 (color:rgb 0.55 0.20 0.75) "##")
(sdegeo:define-contact-set "gate_p"    4.0 (color:rgb 0.85 0.35 0.55) "##")
(sdegeo:define-contact-set "substrate" 4.0 (color:rgb 0.55 0.55 0.60) "##")

(sdegeo:set-current-contact-set "source_n")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ x0 x1) 2) y_sd1 znc_mid)) "source_n")

(sdegeo:set-current-contact-set "drain_n")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ x2 x3) 2) y_sd1 znc_mid)) "drain_n")

(sdegeo:set-current-contact-set "gate_n")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ xg0 xg1) 2) ygt1 znc_mid)) "gate_n")

(sdegeo:set-current-contact-set "source_p")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ x0 x1) 2) y_sd1 zpc_mid)) "source_p")

(sdegeo:set-current-contact-set "drain_p")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ x2 x3) 2) y_sd1 zpc_mid)) "drain_p")

(sdegeo:set-current-contact-set "gate_p")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ xg0 xg1) 2) ygt1 zpc_mid)) "gate_p")

(sdegeo:set-current-contact-set "substrate")
(sdegeo:set-contact-faces
  (find-face-id (position (/ (+ x0 x3) 2) ysub0 znc_mid)) "substrate")


;; =====================================================================
;; 9. MESH
;;
;;   Every refinement WINDOW below is expressed in terms of the defines
;;   above, so the windows follow the geometry automatically when T_NS,
;;   W_NS or T_FORK change.  Minimum element sizes are matched to the
;;   thinnest material, the ${n(C.T_HFO2)} um HfO2 collar.
;; =====================================================================

;; ---- device-wide baseline ----
(sdedr:define-refinement-size "RS_global" 0.020 0.020 0.020 0.006 0.006 0.006)
(sdedr:define-refinement-window "RW_global" "Cuboid"
  (position x0 ysub0 zng0) (position x3 ygt1 zpg1))
(sdedr:define-refinement-placement "RP_global" "RS_global" "RW_global")

;; ---- active stacks, one window per transistor ----
(sdedr:define-refinement-size "RS_active" 0.005 0.002 0.005 ${n(C.MESH_MIN_X)} ${n(C.MESH_MIN_Y)} ${n(C.MESH_MIN_Z)})

(sdedr:define-refinement-window "RW_actN" "Cuboid"
  (position (- x1 0.003) yl0 (- zng0 0.002))
  (position (+ x2 0.003) (+ ygt1 0.002) (+ zng1 0.002)))
(sdedr:define-refinement-placement "RP_actN" "RS_active" "RW_actN")

(sdedr:define-refinement-window "RW_actP" "Cuboid"
  (position (- x1 0.003) yl0 (- zpg0 0.002))
  (position (+ x2 0.003) (+ ygt1 0.002) (+ zpg1 0.002)))
(sdedr:define-refinement-placement "RP_actP" "RS_active" "RW_actP")

;; ---- junctions at the four gate edges ----
(sdedr:define-refinement-size "RS_junc" 0.002 0.002 0.005 0.0015 0.001 ${n(C.MESH_MIN_Z)})

(sdedr:define-refinement-window "RW_jNs" "Cuboid"
  (position (- xg0 0.005) ya1 znh0) (position (+ xg0 0.005) yb3 znh1))
(sdedr:define-refinement-placement "RP_jNs" "RS_junc" "RW_jNs")

(sdedr:define-refinement-window "RW_jNd" "Cuboid"
  (position (- xg1 0.005) ya1 znh0) (position (+ xg1 0.006) yb3 znh1))
(sdedr:define-refinement-placement "RP_jNd" "RS_junc" "RW_jNd")

(sdedr:define-refinement-window "RW_jPs" "Cuboid"
  (position (- xg0 0.005) ya1 zph0) (position (+ xg0 0.005) yb3 zph1))
(sdedr:define-refinement-placement "RP_jPs" "RS_junc" "RW_jPs")

(sdedr:define-refinement-window "RW_jPd" "Cuboid"
  (position (- xg1 0.005) ya1 zph0) (position (+ xg1 0.006) yb3 zph1))
(sdedr:define-refinement-placement "RP_jPd" "RS_junc" "RW_jPd")

;; ---- well boundary : moderate refinement across the junction ----
(sdedr:define-refinement-size "RS_well" 0.020 0.010 0.008 0.008 0.004 0.004)
(sdedr:define-refinement-window "RW_well" "Cuboid"
  (position x0 ywell zng0) (position x3 ysub1 zpg1))
(sdedr:define-refinement-placement "RP_well" "RS_well" "RW_well")

;; ---- deep substrate : coarse ----
(sdedr:define-refinement-size "RS_sub" 0.025 0.025 0.025 0.008 0.008 0.008)
(sdedr:define-refinement-window "RW_sub" "Cuboid"
  (position x0 ysub0 zng0) (position x3 ywell zpg1))
(sdedr:define-refinement-placement "RP_sub" "RS_sub" "RW_sub")


;; =====================================================================
;; 10. BUILD
;;     Writes ${meshPrefix}_msh.tdr
;; =====================================================================

(sde:build-mesh "snmesh" "" "${meshPrefix}")
`;
}


/* ==========================================================================
   5a. STEP-BY-STEP EMITTER
   --------------------------------------------------------------------------
   buildScm() writes the V8 baseline the way the Python generator does: three
   helper procedures, each called twice, once per transistor. That is compact
   and it is how the file is maintained, but it does not read like something
   you would type into a Sentaurus script window - you cannot point at a line
   and say "this creates the nMOS gate bridge", because the line that does it
   runs twice with different arguments.

   This emitter writes the same structure out flat: every cuboid as its own
   create-cuboid call, in build order, named. No procedures, no comments,
   grouped only by blank lines, in the order a device is actually built -
   parameters, geometry, doping, contacts, mesh, build.

   The geometry is NOT recomputed here. The coordinates are the same symbols
   buildScm() uses, so the two emitters cannot drift apart silently: the test
   harness parses the output of this function and asserts the resulting
   region list matches regionList() exactly, name, material and all six
   bounds. A change here that moved anything would fail that comparison.
   ========================================================================== */

/** `(sdegeo:create-cuboid (position ...) (position ...) "Mat" "Name")` */
function cuboid(name, material, ax, bx, ay, by, az, bz) {
  return `(sdegeo:create-cuboid (position ${ax} ${ay} ${az}) ` +
         `(position ${bx} ${by} ${bz}) "${material}" "${name}")`;
}

/** Every create-cuboid for one transistor, expanded, in build order. */
function flatDevice(tag, zga, zha, zca, zcb, zhb, zgb) {
  const L = [];
  const sheets = [['1', 'ya1', 'yb1'], ['2', 'ya2', 'yb2'], ['3', 'ya3', 'yb3']];

  L.push(cuboid(`${tag}_GateLiner`, 'SiO2',    'xg0', 'xg1', 'yl0', 'yl1', zga, zgb));
  L.push(cuboid(`${tag}_Source`,    'Silicon', 'x0',  'x1',  'y_sd0', 'y_sd1', zga, zgb));
  L.push(cuboid(`${tag}_Drain`,     'Silicon', 'x2',  'x3',  'y_sd0', 'y_sd1', zga, zgb));
  L.push('');

  for (const [st, a, b] of sheets) {
    L.push(cuboid(`${tag}_Sheet${st}_extS`, 'Silicon', 'x1',  'xg0', a, b, zca, zcb));
    L.push(cuboid(`${tag}_Sheet${st}_chan`, 'Silicon', 'xg0', 'xg1', a, b, zca, zcb));
    L.push(cuboid(`${tag}_Sheet${st}_extD`, 'Silicon', 'xg1', 'x2',  a, b, zca, zcb));
  }
  L.push('');

  for (const [st, a, b] of sheets) {
    L.push(cuboid(`${tag}_HfO2_s${st}_bot`, 'HfO2', 'xg0', 'xg1', `(- ${a} t_hfo2)`, a, zha, zhb));
    L.push(cuboid(`${tag}_HfO2_s${st}_top`, 'HfO2', 'xg0', 'xg1', b, `(+ ${b} t_hfo2)`, zha, zhb));
    L.push(cuboid(`${tag}_HfO2_s${st}_zlo`, 'HfO2', 'xg0', 'xg1', a, b, zha, zca));
    L.push(cuboid(`${tag}_HfO2_s${st}_zhi`, 'HfO2', 'xg0', 'xg1', a, b, zcb, zhb));
  }
  L.push('');

  L.push(cuboid(`${tag}_gate_bottom`,   'TiN', 'xg0', 'xg1', 'ygb0',   'ygb1',   zga, zgb));
  L.push(cuboid(`${tag}_gate_bridge_L`, 'TiN', 'xg0', 'xg1', 'ybr0',   'ybr1',   zga, zha));
  L.push(cuboid(`${tag}_gate_bridge_R`, 'TiN', 'xg0', 'xg1', 'ybr0',   'ybr1',   zhb, zgb));
  L.push(cuboid(`${tag}_gate_inter01`,  'TiN', 'xg0', 'xg1', 'yi01_0', 'yi01_1', zha, zhb));
  L.push(cuboid(`${tag}_gate_inter12`,  'TiN', 'xg0', 'xg1', 'yi12_0', 'yi12_1', zha, zhb));
  L.push(cuboid(`${tag}_gate_top`,      'TiN', 'xg0', 'xg1', 'ygt0',   'ygt1',   zga, zgb));
  L.push('');

  for (const [sp, xa, xb] of [['S', 'x1', 'xg0'], ['D', 'xg1', 'x2']]) {
    L.push(cuboid(`${tag}_Sp${sp}_zlo`, 'Si3N4', xa, xb, 'yl0', 'ygt1', zga, zca));
    L.push(cuboid(`${tag}_Sp${sp}_zhi`, 'Si3N4', xa, xb, 'yl0', 'ygt1', zcb, zgb));
    L.push(cuboid(`${tag}_Sp${sp}_b`,   'Si3N4', xa, xb, 'yl0', 'ya1',  zca, zcb));
    L.push(cuboid(`${tag}_Sp${sp}_m1`,  'Si3N4', xa, xb, 'yb1', 'ya2',  zca, zcb));
    L.push(cuboid(`${tag}_Sp${sp}_m2`,  'Si3N4', xa, xb, 'yb2', 'ya3',  zca, zcb));
    L.push(cuboid(`${tag}_Sp${sp}_t`,   'Si3N4', xa, xb, 'yb3', 'ygt1', zca, zcb));
  }
  return L;
}

/** Doping profile placements for one transistor. n gets As/B, p gets B/P. */
function flatDoping(tag) {
  const T = tag.toUpperCase() === 'N' ? 'n' : 'p';
  const L = [];
  L.push(`(sdedr:define-constant-profile-region "Pl_${T}Src" "Prof_${T}SD" "${tag}_Source")`);
  L.push(`(sdedr:define-constant-profile-region "Pl_${T}Drn" "Prof_${T}SD" "${tag}_Drain")`);
  for (const st of ['1', '2', '3']) {
    L.push(`(sdedr:define-constant-profile-region "Pl_${T}S${st}_eS" "Prof_${T}Ext" "${tag}_Sheet${st}_extS")`);
    L.push(`(sdedr:define-constant-profile-region "Pl_${T}S${st}_eD" "Prof_${T}Ext" "${tag}_Sheet${st}_extD")`);
  }
  for (const st of ['1', '2', '3']) {
    L.push(`(sdedr:define-constant-profile-region "Pl_${T}S${st}_ch" "Prof_${T}Chan" "${tag}_Sheet${st}_chan")`);
  }
  return L;
}

/**
 * The whole device as a flat, comment-free, step-by-step SDE script.
 * Same geometry, materials, doping, contacts and mesh as buildScm().
 */
function buildFlatScm(G, meshPrefix, C) {
  const L = [];
  const push = (...xs) => L.push(...xs);

  // ---- setup ----
  push('(sde:clear)');
  push('(sde:set-process-up-direction "+z")');
  push('(sdegeo:set-default-boolean "ABA")');
  push('');

  // ---- parameters ----
  push(`(define T_NS      ${n(G.T_NS)})`);
  push(`(define W_NS      ${n(G.W_NS)})`);
  push(`(define t_wall    ${n(G.T_FORK)})`);
  push('');
  push(`(define L_pad     ${n(C.L_PAD)})`);
  push(`(define t_spacer  ${n(C.T_SPACER)})`);
  push(`(define L_G       ${n(C.L_G)})`);
  push(`(define t_hfo2    ${n(C.T_HFO2)})`);
  push(`(define t_metal   ${n(C.T_METAL)})`);
  push(`(define t_liner   ${n(C.T_LINER)})`);
  push(`(define t_bridge  ${n(C.T_BRIDGE)})`);
  push(`(define t_sub     ${n(C.T_SUB)})`);
  push(`(define t_well    ${n(C.T_WELL)})`);
  push('');
  for (const [k, v] of [['x0', G.x0], ['x1', G.x1], ['xg0', G.xg0],
                        ['xg1', G.xg1], ['x2', G.x2], ['x3', G.x3]]) {
    push(`(define ${k.padEnd(7)} ${n(v)})`);
  }
  push('');
  for (const [k, v] of [['yl0', G.yl0], ['yl1', G.yl1], ['ygb0', G.ygb0], ['ygb1', G.ygb1],
                        ['y_pitch', G.y_pitch], ['ya1', G.ya1], ['yb1', G.yb1],
                        ['ya2', G.ya2], ['yb2', G.yb2], ['ya3', G.ya3], ['yb3', G.yb3],
                        ['ygt0', G.ygt0], ['ygt1', G.ygt1],
                        ['yi01_0', G.yi01_0], ['yi01_1', G.yi01_1],
                        ['yi12_0', G.yi12_0], ['yi12_1', G.yi12_1],
                        ['ybr0', G.ybr0], ['ybr1', G.ybr1],
                        ['y_sd0', G.y_sd0], ['y_sd1', G.y_sd1],
                        ['ysub0', G.ysub0], ['ywell', G.ywell], ['ysub1', G.ysub1]]) {
    push(`(define ${k.padEnd(7)} ${n(v)})`);
  }
  push('');
  for (const [k, v] of [['zng0', G.zng0], ['znh0', G.znh0], ['znc0', G.znc0], ['znc1', G.znc1],
                        ['znh1', G.znh1], ['zng1', G.zng1], ['zw0', G.zw0], ['zw1', G.zw1],
                        ['zpg0', G.zpg0], ['zph0', G.zph0], ['zpc0', G.zpc0], ['zpc1', G.zpc1],
                        ['zph1', G.zph1], ['zpg1', G.zpg1], ['z_well', G.z_well],
                        ['znc_mid', G.znc_mid], ['zpc_mid', G.zpc_mid]]) {
    push(`(define ${k.padEnd(7)} ${n(v)})`);
  }
  push('');

  // ---- geometry: substrate, fork wall, then each transistor ----
  push(cuboid('Substrate_Bulk', 'Silicon', 'x0', 'x3', 'ysub0', 'ywell',  'zng0',   'zpg1'));
  push(cuboid('Substrate_PW',   'Silicon', 'x0', 'x3', 'ywell', 'ysub1',  'zng0',   'z_well'));
  push(cuboid('Substrate_NW',   'Silicon', 'x0', 'x3', 'ywell', 'ysub1',  'z_well', 'zpg1'));
  push('');
  push(cuboid('ForkWall', 'Si3N4', 'x0', 'x3', 'ysub1', 'ygt1', 'zw0', 'zw1'));
  push('');
  push(...flatDevice('n', 'zng0', 'znh0', 'znc0', 'znc1', 'znh1', 'zng1'));
  push('');
  push(...flatDevice('p', 'zpg0', 'zph0', 'zpc0', 'zpc1', 'zph1', 'zpg1'));
  push('');

  // ---- doping ----
  push('(sdedr:define-constant-profile "Prof_Bulk"    "BoronActiveConcentration"      1e17)');
  push('(sdedr:define-constant-profile "Prof_PWell"   "BoronActiveConcentration"      1e17)');
  push('(sdedr:define-constant-profile "Prof_NWell"   "PhosphorusActiveConcentration" 1e17)');
  push('(sdedr:define-constant-profile "Prof_nChan"   "BoronActiveConcentration"      3e17)');
  push('(sdedr:define-constant-profile "Prof_nExt"    "ArsenicActiveConcentration"    5e19)');
  push('(sdedr:define-constant-profile "Prof_nSD"     "ArsenicActiveConcentration"    1e20)');
  push('(sdedr:define-constant-profile "Prof_pChan"   "PhosphorusActiveConcentration" 3e17)');
  push('(sdedr:define-constant-profile "Prof_pExt"    "BoronActiveConcentration"      5e19)');
  push('(sdedr:define-constant-profile "Prof_pSD"     "BoronActiveConcentration"      1e20)');
  push('');
  push('(sdedr:define-constant-profile-region "Pl_Bulk"  "Prof_Bulk"  "Substrate_Bulk")');
  push('(sdedr:define-constant-profile-region "Pl_PWell" "Prof_PWell" "Substrate_PW")');
  push('(sdedr:define-constant-profile-region "Pl_NWell" "Prof_NWell" "Substrate_NW")');
  push('');
  push(...flatDoping('n'));
  push('');
  push(...flatDoping('p'));
  push('');

  // ---- contacts ----
  push('(sdegeo:define-contact-set "source_n"  4.0 (color:rgb 1.00 0.55 0.10) "##")');
  push('(sdegeo:define-contact-set "drain_n"   4.0 (color:rgb 0.10 0.45 0.95) "##")');
  push('(sdegeo:define-contact-set "gate_n"    4.0 (color:rgb 0.90 0.10 0.10) "##")');
  push('(sdegeo:define-contact-set "source_p"  4.0 (color:rgb 0.95 0.80 0.15) "##")');
  push('(sdegeo:define-contact-set "drain_p"   4.0 (color:rgb 0.55 0.20 0.75) "##")');
  push('(sdegeo:define-contact-set "gate_p"    4.0 (color:rgb 0.85 0.35 0.55) "##")');
  push('(sdegeo:define-contact-set "substrate" 4.0 (color:rgb 0.55 0.55 0.60) "##")');
  push('');
  for (const [set, px, py, pz] of [
    ['source_n', `${n((G.x0 + G.x1) / 2)}`, 'y_sd1', 'znc_mid'],
    ['drain_n',  `${n((G.x2 + G.x3) / 2)}`, 'y_sd1', 'znc_mid'],
    ['gate_n',   `${n((G.xg0 + G.xg1) / 2)}`, 'ygt1', 'znc_mid'],
    ['source_p', `${n((G.x0 + G.x1) / 2)}`, 'y_sd1', 'zpc_mid'],
    ['drain_p',  `${n((G.x2 + G.x3) / 2)}`, 'y_sd1', 'zpc_mid'],
    ['gate_p',   `${n((G.xg0 + G.xg1) / 2)}`, 'ygt1', 'zpc_mid'],
    ['substrate', `${n((G.x0 + G.x3) / 2)}`, 'ysub0', 'znc_mid'],
  ]) {
    push(`(sdegeo:set-current-contact-set "${set}")`);
    push(`(sdegeo:set-contact-faces (find-face-id (position ${px} ${py} ${pz})) "${set}")`);
  }
  push('');

  // ---- mesh ----
  push('(sdedr:define-refinement-size "RS_global" 0.020 0.020 0.020 0.006 0.006 0.006)');
  push('(sdedr:define-refinement-window "RW_global" "Cuboid" (position x0 ysub0 zng0) (position x3 ygt1 zpg1))');
  push('(sdedr:define-refinement-placement "RP_global" "RS_global" "RW_global")');
  push('');
  push('(sdedr:define-refinement-size "RS_active" 0.005 0.002 0.005 0.003 0.001 0.003)');
  push('(sdedr:define-refinement-window "RW_actN" "Cuboid" (position (- x1 0.003) yl0 (- zng0 0.002)) (position (+ x2 0.003) (+ ygt1 0.002) (+ zng1 0.002)))');
  push('(sdedr:define-refinement-placement "RP_actN" "RS_active" "RW_actN")');
  push('(sdedr:define-refinement-window "RW_actP" "Cuboid" (position (- x1 0.003) yl0 (- zpg0 0.002)) (position (+ x2 0.003) (+ ygt1 0.002) (+ zpg1 0.002)))');
  push('(sdedr:define-refinement-placement "RP_actP" "RS_active" "RW_actP")');
  push('');
  push('(sdedr:define-refinement-size "RS_junc" 0.002 0.002 0.005 0.0015 0.001 0.003)');
  push('(sdedr:define-refinement-window "RW_jNs" "Cuboid" (position (- xg0 0.005) ya1 znh0) (position (+ xg0 0.005) yb3 znh1))');
  push('(sdedr:define-refinement-placement "RP_jNs" "RS_junc" "RW_jNs")');
  push('(sdedr:define-refinement-window "RW_jNd" "Cuboid" (position (- xg1 0.005) ya1 znh0) (position (+ xg1 0.006) yb3 znh1))');
  push('(sdedr:define-refinement-placement "RP_jNd" "RS_junc" "RW_jNd")');
  push('(sdedr:define-refinement-window "RW_jPs" "Cuboid" (position (- xg0 0.005) ya1 zph0) (position (+ xg0 0.005) yb3 zph1))');
  push('(sdedr:define-refinement-placement "RP_jPs" "RS_junc" "RW_jPs")');
  push('(sdedr:define-refinement-window "RW_jPd" "Cuboid" (position (- xg1 0.005) ya1 zph0) (position (+ xg1 0.006) yb3 zph1))');
  push('(sdedr:define-refinement-placement "RP_jPd" "RS_junc" "RW_jPd")');
  push('');
  push('(sdedr:define-refinement-size "RS_well" 0.020 0.010 0.008 0.008 0.004 0.004)');
  push('(sdedr:define-refinement-window "RW_well" "Cuboid" (position x0 ywell zng0) (position x3 ysub1 zpg1))');
  push('(sdedr:define-refinement-placement "RP_well" "RS_well" "RW_well")');
  push('');
  push('(sdedr:define-refinement-size "RS_sub" 0.025 0.025 0.025 0.008 0.008 0.008)');
  push('(sdedr:define-refinement-window "RW_sub" "Cuboid" (position x0 ysub0 zng0) (position x3 ywell zpg1))');
  push('(sdedr:define-refinement-placement "RP_sub" "RS_sub" "RW_sub")');
  push('');

  // ---- build ----
  push(`(sde:build-mesh "snmesh" "" "${meshPrefix}")`);

  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}


/* ==========================================================================
   5b. COMMENT STRIPPING
   --------------------------------------------------------------------------
   buildScm() above is left exactly as the Python generator writes it, banner
   comments and all. Stripping happens here instead, as a separate pass, so
   the fully annotated V8 text stays available and the emitter itself never
   has to know about the option.
   ========================================================================== */

/**
 * Remove Scheme comments from SCM text.
 *
 * This walks each line character by character rather than using a regex,
 * because a `;` inside a string literal is data, not a comment. The custom
 * mesh prefix is user-supplied and lands inside a quoted string, so a naive
 * /;.*$/ would happily truncate `(sde:build-mesh "snmesh" "" "a;b")` into
 * broken Scheme.
 *
 * Whole-line comments disappear entirely; trailing comments are cut off and
 * the remaining code keeps its indentation. Runs of blank lines left behind
 * by the removed banner blocks collapse to a single blank line, so the
 * result reads as grouped sections rather than scattered code.
 */
function stripScmComments(text) {
  const lines = [];

  for (const raw of String(text).split('\n')) {
    let inString = false;
    let cut = -1;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }   // escaped char, skip it
        if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === ';') {
        cut = i;
        break;
      }
    }

    const code = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/[ \t]+$/, '');
    lines.push(code);
  }

  // collapse blank runs, drop leading blanks, end with exactly one newline
  const out = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/** Which of the three output styles the user picked. */
function scmFormat() {
  const el = document.getElementById('scm-format');
  return el ? el.value : 'flat';
}

/**
 * The single place the rest of the UI asks for SCM text.
 *
 *   flat        every command written out one by one, no comments. The
 *               default, and what you would type into a script window.
 *   structured  the V8 baseline with its helper procedures, comments removed
 *   annotated   the V8 baseline exactly as the Python generator writes it
 *
 * All three describe the same device; buildScm() and buildFlatScm() are kept
 * in step by a test that parses both and compares the region lists.
 */
function emitScm(g, meshPrefix, C, format) {
  const mode = format || scmFormat();
  if (mode === 'annotated') return buildScm(g, meshPrefix, C);
  if (mode === 'structured') return stripScmComments(buildScm(g, meshPrefix, C));
  return buildFlatScm(g, meshPrefix, C);
}


/* ==========================================================================
   6. FILE NAMING AND DOWNLOAD
   ========================================================================== */

/** Port of case_name(): fork_TNS_0.006_WNS_0.030_TFORK_0.008 */
function caseName(t_ns, w_ns, t_fork) {
  return `fork_TNS_${t_ns.toFixed(3)}_WNS_${w_ns.toFixed(3)}_TFORK_${t_fork.toFixed(3)}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}


/* ==========================================================================
   7. USER INTERFACE
   ========================================================================== */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const app = {
  lastScm: null,        // text of the most recent single-case generation
  lastName: null,
  lastResult: null,     // { errs, warns, g, R }
};

/* ---------------------------------------------------------------- inputs */
function readNumber(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isNaN(v) ? NaN : v;
}

function readParams() {
  return {
    T_NS:   readNumber('T_NS',   DEFAULT_PARAMS.T_NS),
    W_NS:   readNumber('W_NS',   DEFAULT_PARAMS.W_NS),
    T_FORK: readNumber('T_FORK', DEFAULT_PARAMS.T_FORK),
  };
}

function readConstants() {
  const C = {};
  for (const key of Object.keys(DEFAULT_CONSTANTS)) {
    C[key] = readNumber(key, DEFAULT_CONSTANTS[key]);
  }
  return C;
}

function meshPrefixFor(stem) {
  const mode = $('#mesh-prefix-mode').value;
  if (mode === 'auto') return stem;
  const custom = $('#mesh-prefix-custom').value.trim();
  return custom || stem;
}

/* ---------------------------------------------------------------- status */
function setStatus(kind, title, lines) {
  const box = $('#status');
  box.className = 'status ' + kind;
  let html = `<div class="status-title">${escapeHtml(title)}</div>`;
  if (lines && lines.length) {
    html += '<ul class="status-list">' +
      lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('') + '</ul>';
  }
  box.innerHTML = html;
}

/**
 * Every way to save the script is enabled or disabled together: the sidebar
 * button, its header mirror and the one in the Script panel toolbar. They
 * drifted apart once - a failed validation left the Script panel's Download
 * active, offering a file that no longer matched the inputs on screen.
 */
function setDownloadEnabled(on) {
  $$('#btn-download, #btn-download-top, #btn-script-download')
    .forEach((b) => { b.disabled = !on; });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- summary */
function updateSummary(res, C) {
  const el = $('#summary-body');
  if (!res || !res.R) { el.innerHTML = '<tr><td colspan="2" class="dim">-</td></tr>'; return; }
  const R = res.R, g = res.g;
  const bx = [Math.min(...R.map((r) => r.x0)), Math.max(...R.map((r) => r.x1))];
  const by = [Math.min(...R.map((r) => r.y0)), Math.max(...R.map((r) => r.y1))];
  const bz = [Math.min(...R.map((r) => r.z0)), Math.max(...R.map((r) => r.z1))];
  const sx = bx[1] - bx[0], sy = by[1] - by[0], sz = bz[1] - bz[0];
  const mats = [...new Set(R.map((r) => r.material))];

  const rows = [
    ['Regions', R.length],
    ['Materials', mats.length],
    ['Contacts', 7],
    ['Bounding X', `${n(bx[0])} .. ${n(bx[1])}  (${(sx * 1000).toFixed(1)} nm)`],
    ['Bounding Y', `${n(by[0])} .. ${n(by[1])}  (${(sy * 1000).toFixed(1)} nm)`],
    ['Bounding Z', `${n(bz[0])} .. ${n(bz[1])}  (${(sz * 1000).toFixed(1)} nm)`],
    ['Aspect ratio', `${(Math.max(sx, sy, sz) / Math.min(sx, sy, sz)).toFixed(1)} : 1`],
    ['Gate length', `${(C.L_G * 1000).toFixed(1)} nm`],
    ['Sheet pitch', `${(g.y_pitch * 1000).toFixed(1)} nm`],
    ['nMOS channel Z', `${n(g.znc0)} .. ${n(g.znc1)}`],
    ['Fork wall Z', `${n(g.zw0)} .. ${n(g.zw1)}`],
    ['pMOS channel Z', `${n(g.zpc0)} .. ${n(g.zpc1)}`],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('');
}

/* ---------------------------------------------------------------- preview */
let previewTimer = null;

/** Recompute and refresh the 3D preview. Debounced so dragging a number
    input does not rebuild the scene on every keystroke. */
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 120);
}

function refreshPreview() {
  if (imported.active) return;          // the preview belongs to the import

  const p = readParams();
  const C = readConstants();

  const badConst = Object.entries(C).filter(([, v]) => Number.isNaN(v)).map(([k]) => k);
  if (badConst.length) {
    setStatus('error', 'Invalid constant value', badConst.map((k) => `${k} is not a number`));
    return;
  }

  const res = validate(p.T_NS, p.W_NS, p.T_FORK, C);
  app.lastResult = res;

  if (res.errs.length) {
    setStatus('error', `${res.errs.length} problem(s) - nothing generated`, res.errs);
    updateSummary(null, C);
    if (window.Preview) window.Preview.clear();
    setDownloadEnabled(false);
    return;
  }

  const stem = caseName(p.T_NS, p.W_NS, p.T_FORK);
  app.lastScm = emitScm(res.g, meshPrefixFor(stem), C);
  app.lastName = stem + '.scm';

  const msg = [
    `${res.R.length} regions, no overlaps, both gates connected`,
    `file: ${app.lastName}`,
    `mesh: ${meshPrefixFor(stem)}_msh.tdr`,
  ];
  setStatus(res.warns.length ? 'warn' : 'ok',
            res.warns.length ? `Valid, with ${res.warns.length} warning(s)` : 'Valid geometry',
            msg.concat(res.warns));

  updateSummary(res, C);
  setDownloadEnabled(true);

  if (window.Preview) window.Preview.setRegions(res.R);
}

/* ---------------------------------------------------------------- actions */
function doGenerate() {
  // imported geometry already carries its own script; regenerating would
  // throw it away, so Generate just re-renders what the import produced
  if (imported.active) { renderScript(app.lastScm || ''); return; }

  refreshPreview();
  renderScript(app.lastResult && app.lastResult.errs.length === 0 ? app.lastScm : '');
}

function doDownload() {
  if (imported.active) {
    if (!app.lastScm) return;
    downloadText(app.lastName, app.lastScm);
    setStatus('ok', `Downloaded ${app.lastName}`, []);
    return;
  }
  const mode = $('#gen-mode').value;
  if (mode === 'single') {
    if (!app.lastScm) doGenerate();
    if (!app.lastScm) return;
    downloadText(app.lastName, app.lastScm);
    setStatus('ok', `Downloaded ${app.lastName}`, []);
    return;
  }
  doSweep();
}

/** Port of run_sweep(): one_at_a_time and full_grid. */
function doSweep() {
  const C = readConstants();
  const p = readParams();
  const parseList = (id) => $(id).value.split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((v) => !Number.isNaN(v));

  const tv = parseList('#sweep-T_NS');
  const wv = parseList('#sweep-W_NS');
  const fv = parseList('#sweep-T_FORK');
  const mode = $('#gen-mode').value;

  let cases = [];
  if (mode === 'full_grid') {
    for (const t of tv) for (const w of wv) for (const f of fv) cases.push([t, w, f]);
  } else {
    for (const v of tv) cases.push([v, p.W_NS, p.T_FORK]);
    for (const v of wv) cases.push([p.T_NS, v, p.T_FORK]);
    for (const v of fv) cases.push([p.T_NS, p.W_NS, v]);
    const seen = new Set();
    cases = cases.filter((c) => {
      const k = c.join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  if (!cases.length) {
    setStatus('error', 'Sweep has no cases', ['enter at least one value in a sweep list']);
    return;
  }

  const written = [], rejected = [];
  const files = [];
  for (const [t, w, f] of cases) {
    const res = validate(t, w, f, C);
    const stem = caseName(t, w, f);
    if (res.errs.length) {
      rejected.push(`${stem}: ${res.errs[0]}`);
      continue;
    }
    files.push([stem + '.scm', emitScm(res.g, meshPrefixFor(stem), C)]);
    written.push(stem);
  }

  if (!files.length) {
    setStatus('error', `All ${cases.length} case(s) rejected`, rejected);
    return;
  }

  // Browsers throttle rapid successive downloads, so space them out.
  files.forEach(([name, text], i) => {
    setTimeout(() => downloadText(name, text), i * 220);
  });

  setStatus(rejected.length ? 'warn' : 'ok',
    `Sweep: ${files.length} file(s) downloading, ${rejected.length} rejected`,
    written.map((s) => 'OK  ' + s).concat(rejected.map((s) => 'REJECTED  ' + s)));
}

function doReset() {
  for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  for (const [k, v] of Object.entries(DEFAULT_CONSTANTS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  $('#sweep-T_NS').value   = DEFAULT_SWEEP.T_NS;
  $('#sweep-W_NS').value   = DEFAULT_SWEEP.W_NS;
  $('#sweep-T_FORK').value = DEFAULT_SWEEP.T_FORK;
  $('#gen-mode').value = 'single';
  $('#mesh-prefix-mode').value = 'auto';
  $('#mesh-prefix-custom').value = 'fork1108';
  $('#scm-format').value = 'flat';
  clearImport(true);
  renderScript('');
  onModeChange();
  refreshPreview();
  setStatus('ok', 'Reset to default parameters', []);
}

function onModeChange() {
  const single = $('#gen-mode').value === 'single';
  $('#sweep-fields').style.display = single ? 'none' : '';
  $('#btn-download').textContent = single ? 'Download .scm' : 'Download all cases';
  const top = $('#btn-download-top');
  if (top) {
    top.textContent = single ? 'Download' : 'Download all';
    top.title = single ? 'Download the generated .scm' : 'Download every sweep case';
  }
}

/* ---------------------------------------------------------------- boot */
function initGenerator() {
  // fill every input with its default
  for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  for (const [k, v] of Object.entries(DEFAULT_CONSTANTS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  $('#sweep-T_NS').value   = DEFAULT_SWEEP.T_NS;
  $('#sweep-W_NS').value   = DEFAULT_SWEEP.W_NS;
  $('#sweep-T_FORK').value = DEFAULT_SWEEP.T_FORK;

  // live preview on any parameter change
  $$('#controls input[type="number"]').forEach((el) => {
    const onEdit = () => {
      // editing a control means the user wants the generator back
      if (imported.active) clearImport(false);
      schedulePreview();
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  });
  $('#mesh-prefix-mode').addEventListener('change', () => {
    $('#mesh-prefix-custom').disabled = $('#mesh-prefix-mode').value === 'auto';
    schedulePreview();
  });
  $('#mesh-prefix-custom').addEventListener('input', schedulePreview);
  $('#scm-format').addEventListener('change', () => {
    // the script panel is already on screen; keep it in step with the choice
    refreshPreview();
    if (app.lastScm) doGenerate();
  });
  $('#gen-mode').addEventListener('change', onModeChange);

  // The two header buttons mirror the sidebar ones, so the primary actions
  // stay reachable when the parameters panel is closed or off-canvas.
  $$('#btn-generate, #btn-generate-top').forEach((b) =>
    b.addEventListener('click', doGenerate));
  $$('#btn-download, #btn-download-top').forEach((b) =>
    b.addEventListener('click', doDownload));
  $('#btn-reset').addEventListener('click', doReset);
  $('#btn-copy').addEventListener('click', () => {
    if (!app.lastScm) return;
    navigator.clipboard.writeText(app.lastScm)
      .then(() => setStatus('ok', 'SCM copied to the clipboard', []))
      .catch(() => setStatus('warn', 'Clipboard blocked by the browser', ['use Download instead']));
  });

  $$('.section-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  $('#mesh-prefix-custom').disabled = true;
  onModeChange();

  // import (file + paste) and the script view
  initImport();
  initScriptView();

  // layout: sidebar resizing, drawer mode, viewport watchers
  initLayout();

  refreshPreview();
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.Preview) window.Preview.init('viewport');
  initGenerator();
});

/* expose for preview.js and for console debugging */
window.Generator = {
  compute, regionList, validate, buildScm, buildFlatScm, emitScm, stripScmComments,
  caseName, materialColor, n,
  DEFAULT_PARAMS, DEFAULT_CONSTANTS,
};


/* ==========================================================================
   8. LAYOUT
   --------------------------------------------------------------------------
   One layout controller for both sidebars, both drag handles and the two
   header toggles. There is no second implementation anywhere: the CSS owns
   the geometry, this file owns the two width variables and the open/closed
   state.

   Desktop (> 1000px)
     Three columns. --sidebar-l and --sidebar-r are clamped so the centre
     workspace can never be squeezed below MIN_CENTER, and both widths are
     remembered between visits. The header toggles collapse a whole column.

   Drawer mode (<= 1000px)
     The same two panels become off-canvas drawers over a scrim. The header
     toggles open and close them; so do the drawer close buttons, the scrim
     and Escape. The centre column keeps the full width underneath, so the
     3D preview is never permanently covered.

   Either way, every CSS size change is followed by an explicit call into the
   Three.js renderer, because a CSS-driven resize on its own updates neither
   the WebGL drawing buffer nor the camera aspect ratio.
   ========================================================================== */

const MOBILE_QUERY = '(max-width: 1000px)';
const MIN_CENTER   = 380;      // px the centre workspace must always keep

const PANELS = {
  left: {
    id: 'controls',  resizer: 'resizer-left',  btn: 'btn-toggle-controls',
    cssVar: '--sidebar-l', storeKey: 'fsg.sidebarL', bodyClass: 'hide-left',
    min: 260, max: 560, def: 380, maxFraction: 0.45,
    sign: 1,                   // dragging right widens the left panel
  },
  right: {
    id: 'inspector', resizer: 'resizer-right', btn: 'btn-toggle-inspector',
    cssVar: '--sidebar-r', storeKey: 'fsg.sidebarR', bodyClass: 'hide-right',
    min: 200, max: 460, def: 260, maxFraction: 0.35,
    sign: -1,                  // dragging right narrows the right panel
  },
};

/* The width the user asked for, which is NOT the width currently applied.
   Clamping is recomputed from this on every layout pass and never written
   back, so narrowing the window temporarily squeezes a sidebar without
   destroying the preference: widen the window again and it returns to the
   width that was actually dragged. */
const wanted = { left: PANELS.left.def, right: PANELS.right.def };

/* The width in effect right now, after clamping. */
const applied = { left: PANELS.left.def, right: PANELS.right.def };

let mobileQuery = null;
const isDrawerMode = () => !!(mobileQuery && mobileQuery.matches);

const el = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function readStored(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? v : fallback;
  } catch (_) { return fallback; }        // private mode, or storage disabled
}

function writeStored(key, value) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch (_) { /* ignore */ }
}

/* -------------------------------------------------- renderer resize hook */
/* Batched onto an animation frame so a drag stays smooth with a large model
   on screen, instead of reallocating the drawing buffer on every pointermove. */
let resizeRaf = null;
function requestPreviewResize() {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    if (window.Preview && window.Preview.resize) window.Preview.resize();
  });
}

/* ------------------------------------------------------------- widths */

/** Width available to the three columns, measured rather than assumed. */
function availableWidth() {
  const page = el('page');
  if (!page) return window.innerWidth;
  const cs = getComputedStyle(page);
  let avail = page.clientWidth
            - parseFloat(cs.paddingLeft || 0)
            - parseFloat(cs.paddingRight || 0);
  for (const side of ['left', 'right']) {
    const handle = el(PANELS[side].resizer);
    // offsetParent is null when the handle is display:none
    if (handle && handle.offsetParent !== null) {
      avail -= handle.getBoundingClientRect().width;
    }
  }
  return Math.max(0, avail);
}

/**
 * Clamp both sidebars against the current window and write the CSS
 * variables. The centre column is protected first: if the two sidebars
 * together would leave it below MIN_CENTER, the right one gives ground
 * first, then the left, each down to its own minimum.
 */
function applyWidths(persist) {
  const avail = availableWidth();
  const hiddenL = document.body.classList.contains('hide-left')  && !isDrawerMode();
  const hiddenR = document.body.classList.contains('hide-right') && !isDrawerMode();

  const ceiling = (cfg) =>
    Math.max(cfg.min, Math.min(cfg.max, avail * cfg.maxFraction));

  let l = clamp(wanted.left,  PANELS.left.min,  ceiling(PANELS.left));
  let r = clamp(wanted.right, PANELS.right.min, ceiling(PANELS.right));

  if (!isDrawerMode()) {
    // protect the centre workspace: the right panel gives ground first
    let over = (hiddenL ? 0 : l) + (hiddenR ? 0 : r) + MIN_CENTER - avail;
    if (over > 0 && !hiddenR) {
      const give = Math.min(over, r - PANELS.right.min);
      r -= give; over -= give;
    }
    if (over > 0 && !hiddenL) {
      l -= Math.min(over, l - PANELS.left.min);
    }
  }

  applied.left = l;
  applied.right = r;

  const root = document.documentElement.style;
  root.setProperty('--sidebar-l', Math.round(l) + 'px');
  root.setProperty('--sidebar-r', Math.round(r) + 'px');

  if (persist) {
    writeStored(PANELS.left.storeKey, wanted.left);
    writeStored(PANELS.right.storeKey, wanted.right);
  }
  requestPreviewResize();
}

function setPanelWidth(side, px, persist) {
  const cfg = PANELS[side];
  wanted[side] = clamp(px, cfg.min, cfg.max);
  applyWidths(persist);
}

/* ------------------------------------------------------------- resizers */
function initResizer(side) {
  const cfg = PANELS[side];
  const handle = el(cfg.resizer);
  const panel = el(cfg.id);
  if (!handle || !panel) return;

  let startX = 0, startW = 0, dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    setPanelWidth(side, startW + cfg.sign * (e.clientX - startX), false);
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    applyWidths(true);          // persist once, at the end of the drag
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isDrawerMode()) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // keyboard accessible: arrows nudge, Home resets
  handle.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 40 : 12) * cfg.sign;
    if (e.key === 'ArrowLeft')       setPanelWidth(side, applied[side] - step, true);
    else if (e.key === 'ArrowRight') setPanelWidth(side, applied[side] + step, true);
    else if (e.key === 'Home')       setPanelWidth(side, cfg.def, true);
    else return;
    e.preventDefault();
  });

  handle.addEventListener('dblclick', () => setPanelWidth(side, cfg.def, true));
}

/* --------------------------------------------------- open / close panels */
function syncScrim() {
  const scrim = el('drawer-scrim');
  if (!scrim) return;
  const anyOpen = isDrawerMode() &&
    ['left', 'right'].some((s) => {
      const p = el(PANELS[s].id);
      return p && p.classList.contains('open');
    });
  scrim.hidden = !anyOpen;
}

function isPanelVisible(side) {
  const cfg = PANELS[side];
  const panel = el(cfg.id);
  if (!panel) return false;
  return isDrawerMode()
    ? panel.classList.contains('open')
    : !document.body.classList.contains(cfg.bodyClass);
}

function setPanelVisible(side, visible) {
  const cfg = PANELS[side];
  const panel = el(cfg.id);
  const btn = el(cfg.btn);
  if (!panel) return;

  if (isDrawerMode()) {
    panel.classList.toggle('open', visible);
    // only one drawer at a time: they would otherwise fight over the scrim
    if (visible) {
      const other = side === 'left' ? 'right' : 'left';
      const op = el(PANELS[other].id);
      if (op) op.classList.remove('open');
      const ob = el(PANELS[other].btn);
      if (ob) ob.setAttribute('aria-expanded', 'false');
    }
    syncScrim();
  } else {
    panel.classList.remove('open');
    document.body.classList.toggle(cfg.bodyClass, !visible);
    syncScrim();
    applyWidths(false);
  }

  if (btn) btn.setAttribute('aria-expanded', String(visible));
  requestPreviewResize();
}

function closeDrawers() {
  if (!isDrawerMode()) return;
  for (const side of ['left', 'right']) setPanelVisible(side, false);
}

function initPanelToggles() {
  for (const side of ['left', 'right']) {
    const btn = el(PANELS[side].btn);
    if (btn) {
      btn.addEventListener('click', () => setPanelVisible(side, !isPanelVisible(side)));
    }
  }

  document.querySelectorAll('.drawer-close').forEach((b) => {
    b.addEventListener('click', () => {
      const side = b.dataset.close === 'inspector' ? 'right' : 'left';
      setPanelVisible(side, false);
    });
  });

  const scrim = el('drawer-scrim');
  if (scrim) scrim.addEventListener('click', closeDrawers);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
  });
}

/* ------------------------------------------------ mode / viewport watchers */

/** Reset panel state whenever the layout crosses the drawer breakpoint. */
function onModeSwitch() {
  const drawer = isDrawerMode();
  for (const side of ['left', 'right']) {
    const cfg = PANELS[side];
    const panel = el(cfg.id);
    const btn = el(cfg.btn);
    if (panel) panel.classList.remove('open');
    if (drawer) {
      // drawers start closed so the preview owns the screen on arrival
      if (btn) btn.setAttribute('aria-expanded', 'false');
    } else if (btn) {
      btn.setAttribute('aria-expanded',
        String(!document.body.classList.contains(cfg.bodyClass)));
    }
  }
  syncScrim();
  applyWidths(false);
}

/** Publish the real header height so the drawers can sit exactly below it. */
function trackHeaderHeight() {
  const bar = el('titlebar');
  if (!bar) return;
  const push = () => document.documentElement.style
    .setProperty('--header-h', Math.round(bar.getBoundingClientRect().height) + 'px');
  push();
  if (window.ResizeObserver) new ResizeObserver(push).observe(bar);
  else window.addEventListener('resize', push);
}

function initViewportWatchers() {
  window.addEventListener('resize', () => applyWidths(false));
  window.addEventListener('orientationchange', () => setTimeout(() => {
    applyWidths(false);
    requestPreviewResize();
  }, 250));
  // the Android URL bar sliding away changes the usable height without
  // always firing a window resize event
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', requestPreviewResize);
  }

  /* A hidden page runs no animation frames, so resize work queued while the
     tab was in the background has to be re-driven when it comes back. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { applyWidths(false); requestPreviewResize(); }
  });
}

/* ------------------------------------------------------------- boot */
function initLayout() {
  mobileQuery = window.matchMedia(MOBILE_QUERY);
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onModeSwitch);
  else mobileQuery.addListener(onModeSwitch);           // older Safari

  wanted.left  = clamp(readStored(PANELS.left.storeKey,  PANELS.left.def),
                       PANELS.left.min,  PANELS.left.max);
  wanted.right = clamp(readStored(PANELS.right.storeKey, PANELS.right.def),
                       PANELS.right.min, PANELS.right.max);

  trackHeaderHeight();
  initResizer('left');
  initResizer('right');
  initPanelToggles();
  initViewportWatchers();
  onModeSwitch();
}


/* ==========================================================================
   9. IMPORT AND SCRIPT VIEW
   --------------------------------------------------------------------------
   Two entry points, one code path. A chosen file and a paste both end up in
   loadSdeText(), which asks window.SDE what the text is and then routes it:

     - text that binds T_NS, W_NS and the fork wall is this generator's own
       parameter set. The values go into the controls and the parametric
       model takes over, so validation, sweeps and the summary all keep
       working exactly as they did.

     - text that only yields geometry is shown as geometry: the regions go
       straight to the 3D preview and the script panel gets the same
       commands written back out cleanly. A banner says so, because the
       parametric controls are not what is on screen.

   Detection is by content. A .scm file and a pasted fragment take the same
   route, and a file with the wrong extension is still read correctly.
   ========================================================================== */

const imported = { active: false, name: null, parsed: null };

/* ---------------------------------------------------------- script view */

/**
 * Put text in the script panel, one line per element so the CSS counter can
 * number it. The number lives in a ::before pseudo-element, so selecting the
 * text with the mouse copies commands and not line numbers.
 */
function renderScript(text) {
  const pre = $('#scm-preview');
  const label = $('#scm-lines');
  const dl = $('#btn-script-download');
  if (!pre) return;

  pre.textContent = '';
  const body = String(text || '');

  if (!body.trim()) {
    if (label) label.textContent = '';
    if (dl) dl.disabled = true;
    return;
  }


  const lines = body.replace(/\n$/, '').split('\n');
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = line === '' ? 'code-line blank' : 'code-line';
    div.textContent = line;
    frag.appendChild(div);
  }
  pre.appendChild(frag);

  if (label) {
    label.textContent = lines.length + ' lines, ' + (body.length / 1024).toFixed(1) + ' kB';
  }
  if (dl) dl.disabled = false;
}

function initScriptView() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  // these live inside the collapse header, so stop a click toggling the card
  $$('.script-tools .btn').forEach((b) =>
    b.addEventListener('click', (e) => e.stopPropagation()));

  on('#btn-script-copy', 'click', () => {
    if (!app.lastScm) {
      setStatus('warn', 'Nothing to copy yet', ['press Generate first']);
      return;
    }
    navigator.clipboard.writeText(app.lastScm)
      .then(() => setStatus('ok',
        'Script copied - ' + app.lastScm.split('\n').length + ' lines', []))
      .catch(() => setStatus('warn', 'Clipboard blocked by the browser',
        ['use Download instead']));
  });

  on('#btn-script-download', 'click', doDownload);

  on('#btn-script-expand', 'click', () => {
    const open = document.body.classList.toggle('script-expanded');
    const btn = $('#btn-script-expand');
    btn.setAttribute('aria-pressed', String(open));
    btn.textContent = open ? 'Collapse' : 'Expand';
    // the preview is hidden while expanded; resize it when it comes back
    if (!open && window.Preview && window.Preview.resize) {
      requestAnimationFrame(() => window.Preview.resize());
    }
  });
}

/* ------------------------------------------------------------ importing */

function setImportStatus(kind, html) {
  const box = $('#import-status');
  if (!box) return;
  box.className = 'import-status ' + (kind || '');
  box.innerHTML = html;
}

/** Give parsed regions the extra fields the 3D preview expects. */
function enrichRegions(regions) {
  return regions.map((r) => ({
    name: r.name, material: r.material,
    x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, z0: r.z0, z1: r.z1,
    lx: r.x1 - r.x0, ly: r.y1 - r.y0, lz: r.z1 - r.z0,
    volume: (r.x1 - r.x0) * (r.y1 - r.y0) * (r.z1 - r.z0),
    center: [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.z0 + r.z1) / 2],
    color: materialColor(r.material, r.name),
  }));
}

/** Summary table for imported geometry, which has no parametric model. */
function summariseImport(regions, parsed) {
  const el = $('#summary-body');
  if (!el) return;
  if (!regions.length) {
    el.innerHTML = '<tr><td colspan="2" class="dim">-</td></tr>';
    return;
  }
  const bx = [Math.min(...regions.map((r) => r.x0)), Math.max(...regions.map((r) => r.x1))];
  const by = [Math.min(...regions.map((r) => r.y0)), Math.max(...regions.map((r) => r.y1))];
  const bz = [Math.min(...regions.map((r) => r.z0)), Math.max(...regions.map((r) => r.z1))];
  const mats = [...new Set(regions.map((r) => r.material))];
  const rows = [
    ['Source', imported.name || 'pasted text'],
    ['Regions', regions.length],
    ['Materials', mats.length],
    ['Contacts', parsed.contacts.length],
    ['Doping placements', parsed.doping.length],
    ['Refinements', parsed.refinements.length],
    ['Bounding X', n(bx[0]) + ' .. ' + n(bx[1])],
    ['Bounding Y', n(by[0]) + ' .. ' + n(by[1])],
    ['Bounding Z', n(bz[0]) + ' .. ' + n(bz[1])],
    ['Mesh prefix', parsed.meshPrefix || '-'],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(String(v)) + '</td></tr>').join('');
}

function showImportBanner(what) {
  const b = $('#import-banner');
  if (!b) return;
  b.hidden = false;
  const w = $('#import-banner-what');
  if (w) w.textContent = what;
  if (window.Preview && window.Preview.resize) {
    requestAnimationFrame(() => window.Preview.resize());
  }
}

/** Leave import mode and hand the preview back to the parametric model. */
function clearImport(quiet) {
  const wasActive = imported.active;
  imported.active = false;
  imported.name = null;
  imported.parsed = null;

  const b = $('#import-banner');
  if (b) b.hidden = true;
  const btn = $('#btn-clear-import');
  if (btn) btn.disabled = true;

  if (wasActive && window.Preview && window.Preview.resize) {
    requestAnimationFrame(() => window.Preview.resize());
  }
  if (wasActive && !quiet) {
    setImportStatus('', 'Import cleared. The parametric model is back on screen.');
    refreshPreview();
    renderScript(app.lastScm || '');
  }
  if (quiet) setImportStatus('', 'Nothing imported.');
}

/**
 * The single entry point for both input methods.
 * `label` is a filename, or null for a paste; it only affects wording.
 */
function loadSdeText(text, label) {
  if (!window.SDE) {
    setImportStatus('error', 'The SDE parser did not load.');
    return;
  }

  const what = window.SDE.detect(text, label);
  if (what.kind === 'empty' || what.kind === 'unknown') {
    setImportStatus('error',
      '<strong>Not recognised.</strong> ' + escapeHtml(what.reason) + '.');
    return;
  }

  const parsed = window.SDE.parse(text);
  const src = label
    ? '<strong>' + escapeHtml(label) + '</strong>'
    : '<strong>pasted text</strong>';

  /* ---- is this one of our own parameter sets? then drive the generator ---- */
  const b = parsed.bindings;
  const fork = b.t_wall !== undefined ? b.t_wall : b.T_FORK;
  const hasParams = typeof b.T_NS === 'number' &&
                    typeof b.W_NS === 'number' &&
                    typeof fork === 'number';

  if (hasParams) {
    clearImport(true);

    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el && typeof v === 'number' && Number.isFinite(v)) { el.value = v; return true; }
      return false;
    };
    set('T_NS', b.T_NS);
    set('W_NS', b.W_NS);
    set('T_FORK', fork);

    // the constants carry SDE's names, not the study's; map them across
    const constMap = {
      L_pad: 'L_PAD', t_spacer: 'T_SPACER', L_G: 'L_G', t_hfo2: 'T_HFO2',
      t_metal: 'T_METAL', t_liner: 'T_LINER', t_bridge: 'T_BRIDGE',
      t_sub: 'T_SUB', t_well: 'T_WELL',
    };
    const picked = [];
    for (const key of Object.keys(constMap)) {
      if (set(constMap[key], b[key])) picked.push(constMap[key]);
    }

    if (parsed.meshPrefix) {
      $('#mesh-prefix-mode').value = 'custom';
      $('#mesh-prefix-custom').disabled = false;
      $('#mesh-prefix-custom').value = parsed.meshPrefix;
    }

    refreshPreview();
    doGenerate();

    setImportStatus('ok',
      '<strong>Loaded as parameters.</strong> ' + src + ' defines T_NS, W_NS and ' +
      'the fork wall, so the generator is driving the preview again. ' +
      picked.length + ' design constant(s) came from the input, and ' +
      parsed.regions.length + ' region(s) were read back to confirm it parses. ' +
      'Edit any control to regenerate.');
    const cb = $('#btn-clear-import');
    if (cb) cb.disabled = true;
    return;
  }

  /* ---- otherwise: show whatever geometry it contains ---- */
  if (!parsed.regions.length) {
    const why = parsed.errors.length
      ? escapeHtml(parsed.errors[0])
      : 'no create-cuboid command produced a resolvable region';
    setImportStatus('error',
      '<strong>Parsed, but no geometry.</strong> ' + src + ' yielded ' +
      parsed.commands.length + ' command(s) but no regions: ' + why + '.');
    return;
  }

  imported.active = true;
  imported.name = label || 'pasted text';
  imported.parsed = parsed;

  if (window.Preview) window.Preview.setRegions(enrichRegions(parsed.regions));

  const cleaned = window.SDE.format(parsed);
  app.lastScm = cleaned;
  app.lastName = (label ? label.replace(/\.[^.]*$/, '') : 'imported') + '_clean.scm';
  renderScript(cleaned);
  setDownloadEnabled(true);

  summariseImport(parsed.regions, parsed);
  showImportBanner(imported.name);
  const cb = $('#btn-clear-import');
  if (cb) cb.disabled = false;

  const warn = parsed.errors.length
    ? ' ' + parsed.errors.length + ' command(s) could not be fully resolved.'
    : '';
  setImportStatus(parsed.errors.length ? 'warn' : 'ok',
    '<strong>Loaded as geometry.</strong> ' + parsed.regions.length + ' region(s), ' +
    parsed.contacts.length + ' contact(s) and ' + parsed.doping.length +
    ' doping placement(s) from ' + src + '.' + warn +
    ' The cleaned script is in the Script panel.' +
    ' Sweeps and validation need the parametric model, so they stay with the controls above.');

  setStatus('warn', 'Imported ' + parsed.regions.length + ' regions from ' + imported.name,
    ['the parametric controls are not driving this view',
     'press Return to generator, or Clear import, to go back']);
}

function readFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadSdeText(String(reader.result || ''), file.name);
  reader.onerror = () => setImportStatus('error',
    'Could not read <strong>' + escapeHtml(file.name) + '</strong>.');
  reader.readAsText(file);
}

function initImport() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  const fileInput = $('#file-input');

  const pick = () => { if (fileInput) { fileInput.value = ''; fileInput.click(); } };
  const openCard = () => {
    const card = $('#import-card');
    if (card) card.classList.remove('collapsed');
  };

  on('#btn-choose-file', 'click', pick);
  on('#btn-open-top', 'click', () => { openCard(); pick(); });

  if (fileInput) {
    fileInput.addEventListener('change',
      () => readFile(fileInput.files && fileInput.files[0]));
  }

  on('#btn-load-paste', 'click', () => {
    const ta = $('#paste-input');
    loadSdeText(ta ? ta.value : '', null);
  });

  on('#btn-clear-import', 'click', () => clearImport(false));
  on('#btn-exit-import', 'click', () => clearImport(false));

  // drag a file anywhere onto the page
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.types &&
        Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
      e.preventDefault();
    }
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    openCard();
    readFile(f);
  });
}
