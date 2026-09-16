/* ==========================================================================
   js/generator.js
   --------------------------------------------------------------------------
   Browser port of gen_forksheet.py, the parametric generator for the V13
   3D Forksheet CMOS Sentaurus SDE structure.

   Everything runs client side. There is no Python, no Flask, no Node and no
   build step: the page can be opened from disk or served by GitHub Pages.

   Every formula in compute(), every region in regionList() and every check
   in validate() is carried across from the Python generator, so the same
   inputs produce the same structure. The script itself is written out as
   plain commands with literal coordinates - see buildFlatScm().

   Layout of this file
     1  constants and defaults
     2  compute()      every dependent coordinate
     3  regionList()   the regions, in SCM build order (110 at three sheets)
     4  validate()     input sanity plus 11 geometric checks
     5  buildFlatScm() the SCM text
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
  T_IL:     0.0008,   // interfacial SiO2, directly on the silicon
  T_HFO2:   0.002,    // HfO2, outside the IL
  T_METAL:  0.006,    // gate metal thickness in each vertical gap
  T_LINER:  0.002,    // SiO2 gate liner thickness
  T_BRIDGE: 0.010,    // gate metal on the ONE open Z face
  /* Simulation DOMAIN depth, not a wafer thickness. The side walls are
     adiabatic, which is a dense-array assumption, so thermal resistance
     grows linearly with this and never converges: a deeper domain simply
     reports a hotter device. Justify it with a depth sweep. */
  T_DOMAIN: 0.200,
  T_WELL:   0.050,    // retrograde well depth from y = 0
  // mesh minimum element sizes, used by the warning checks
  MESH_MIN_X: 0.003,
  MESH_MIN_Y: 0.001,
  MESH_MIN_Z: 0.003,
  // stack height: the V8 baseline is three sheets, but nothing below
  // assumes it any more
  N_SHEETS: 3,
  /* Target element size in NANOMETRES at the active regions. Every
     refinement size in the emitted SCM is scaled from this, so the slider
     changes the mesh that snmesh actually builds - not a label.
     2 nm is the V8 baseline, and at exactly 2 nm the refinement lines are
     emitted verbatim, so the default output is unchanged. */
  MESH_NM: 2,
};

/* Doping concentrations, cm^-3. These were literals inside the SCM template;
   they are parameters now, because "doping concentrations and profiles" is
   part of the design, not part of the boilerplate. Names match the profile
   names emitted into the script. */
const DEFAULT_DOPING = {
  N_SUB:   3e17,      // p substrate / thermal domain
  N_WELLP: 3e18,      // nFET body
  N_WELLN: 3e18,      // pFET body
  /* Effectively undoped. At 3e17 a 20 x 6 x 30 nm channel holds about ONE
     dopant atom, so the threshold would be a single-atom lottery; with an
     undoped channel Vt comes from the gate workfunction instead. */
  N_CHAN:  1e16,
  N_EXT:   5e19,      // source/drain extensions under the spacers
  N_SD:    1e20,      // source/drain pads
};

/* Default sweep lists, matching T_NS_VALUES / W_NS_VALUES / T_FORK_VALUES. */
/* The six primary self-heating study variables, plus T_FORK, which is not
   one of the six but is architecture-defining for a forksheet and was
   sweepable before - so it stays available, just unticked by default. */
const SWEEP_VARS = ['T_NS', 'W_NS', 'L_G', 'T_SPACER', 'L_PAD', 'N_SHEETS', 'T_FORK'];

const DEFAULT_SWEEP = {
  T_NS:     '0.004, 0.005, 0.006',
  W_NS:     '0.015, 0.020, 0.025',
  L_G:      '0.014, 0.020, 0.026',
  T_SPACER: '0.004, 0.005, 0.007',
  L_PAD:    '0.020, 0.025, 0.030',
  N_SHEETS: '2, 3, 4',
  T_FORK:   '0.006, 0.008, 0.010',
};

/* Which are ticked when the page loads. The six study variables are the
   point of the exercise, but all six on a full grid is 3^6 = 729 cases, so
   the default lands on one-at-a-time and the case count is always shown. */
const DEFAULT_SWEEP_ON = {
  T_NS: true, W_NS: true, L_G: true,
  T_SPACER: true, L_PAD: true, N_SHEETS: true, T_FORK: false,
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

  /* The gated faces now carry a two-layer stack, an interfacial SiO2 with
     HfO2 outside it, so every vertical clearance is the TOTAL dielectric
     and not the HfO2 alone. Getting this wrong closes the metal gap by
     1.6 nm per sheet and the collars stop fitting. */
  g.t_diel = C.T_IL + C.T_HFO2;

  //   sheet-to-sheet pitch = sheet + dielectric above + below + metal gap
  g.y_pitch = t_ns + 2 * g.t_diel + C.T_METAL;

  /* The stack is built as a list rather than as ya1..yb3, so the number of
     sheets is a parameter instead of a fact hard-coded in six places. The
     ya1/yb1..ya3/yb3 names are still published below, because the V8
     template and its `(define ya1 ...)` block are written in terms of them. */
  const N = Math.max(1, Math.round(C.N_SHEETS || 3));
  g.N_SHEETS = N;
  g.sheets = [];
  for (let i = 0; i < N; i++) {
    const a = g.ygb1 + g.t_diel + i * g.y_pitch;
    g.sheets.push({ a, b: a + t_ns });
  }

  /* One gate-metal band between each adjacent pair of sheets, inset by the
     collar thickness top and bottom. With N sheets there are N-1 of them. */
  g.inter = [];
  for (let i = 0; i + 1 < N; i++) {
    g.inter.push({
      lo: g.sheets[i].b + g.t_diel,
      hi: g.sheets[i + 1].a - g.t_diel,
      tag: String(i) + String(i + 1),
    });
  }

  const top = g.sheets[N - 1];
  g.ygt0 = top.b + g.t_diel;       // gate_top bottom
  g.ygt1 = g.ygt0 + C.T_METAL;     // device top

  // the three-sheet names the V8 template is written against
  g.ya1 = g.sheets[0].a; g.yb1 = g.sheets[0].b;
  g.ya2 = (g.sheets[1] || top).a; g.yb2 = (g.sheets[1] || top).b;
  g.ya3 = (g.sheets[2] || top).a; g.yb3 = (g.sheets[2] || top).b;
  g.yi01_0 = g.inter[0] ? g.inter[0].lo : g.yb1;
  g.yi01_1 = g.inter[0] ? g.inter[0].hi : g.yb1;
  g.yi12_0 = g.inter[1] ? g.inter[1].lo : g.yb2;
  g.yi12_1 = g.inter[1] ? g.inter[1].hi : g.yb2;

  g.ybr0 = g.ygb1;                 // gate bridges span the whole stack
  g.ybr1 = g.ygt0;

  g.y_sd0 = 0.0;                   // S/D pad bottom
  g.y_sd1 = top.b;                 // S/D pad top follows the topmost sheet

  g.ysub0 = -C.T_DOMAIN;
  g.ywell = -C.T_WELL;
  g.ysub1 = 0.0;

  /* ---- Z : nMOS | fork wall | pMOS ----------------------------------
     The gate metal wraps only the OUTER Z face of each device. On the
     inner face the fork wall sits directly against the dielectric, which
     is what makes this a forksheet rather than two nanosheet devices side
     by side: each gate is three-sided, and the wall - not metal - sets the
     nMOS-to-pMOS spacing. So the two devices are mirror images, and each
     has exactly one bridge. */
  g.zng0 = -(C.T_BRIDGE + g.t_diel);   // nMOS gate outer, -Z
  g.znh0 = g.zng0 + C.T_BRIDGE;        // dielectric outer
  g.znc0 = g.znh0 + g.t_diel;          // channel, always 0.0
  g.znc1 = g.znc0 + w_ns;
  g.znh1 = g.znc1 + g.t_diel;
  g.zng1 = g.znh1;                     // no bridge here: the wall abuts

  g.zw0 = g.zng1;                      // fork wall
  g.zw1 = g.zw0 + t_fork;

  g.zpg0 = g.zw1;                      // pMOS envelope starts at the wall
  g.zph0 = g.zpg0;                     // no bridge here either
  g.zpc0 = g.zph0 + g.t_diel;
  g.zpc1 = g.zpc0 + w_ns;
  g.zph1 = g.zpc1 + g.t_diel;
  g.zpg1 = g.zph1 + C.T_BRIDGE;        // pMOS gate outer, +Z

  // where each device's single bridge sits
  g.nbr = [g.zng0, g.znh0];
  g.pbr = [g.zph1, g.zpg1];

  g.z_well = g.zw0 + t_fork / 2.0;     // well split, wall midplane

  // ---- contact pick points ---------------------------------------------
  g.znc_mid = (g.znc0 + g.znc1) / 2.0;
  g.zpc_mid = (g.zpc0 + g.zpc1) / 2.0;

  /* Snap out accumulated float noise.
     znc0 is (-(t_bridge + t_diel) + t_bridge) + t_diel, which in binary
     lands on -4e-19 rather than 0, so the region list carried a negative
     zero while the emitted text said 0.0 - the preview and the file
     disagreeing about the same coordinate. A picometre is twelve decimal
     places below a micrometre, far beyond any real dimension here. */
  const snap = (v) => (typeof v === 'number' ? Number(v.toFixed(12)) + 0 : v);
  for (const k of Object.keys(g)) {
    if (typeof g[k] === 'number') g[k] = snap(g[k]);
  }
  g.sheets = g.sheets.map((sh) => ({ a: snap(sh.a), b: snap(sh.b) }));
  g.inter = g.inter.map((b) => ({ lo: snap(b.lo), hi: snap(b.hi), tag: b.tag }));
  g.nbr = g.nbr.map(snap);
  g.pbr = g.pbr.map(snap);

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

  add('Substrate_P', 'Silicon', g.x0, g.x3, g.ysub0, g.ywell, g.zng0, g.zpg1);
  add('Well_P',      'Silicon', g.x0, g.x3, g.ywell, g.ysub1, g.zng0, g.z_well);
  add('Well_N',      'Silicon', g.x0, g.x3, g.ywell, g.ysub1, g.z_well, g.zpg1);
  add('ForkWall',       'Si3N4',   g.x0, g.x3, g.ysub1, g.ygt1,  g.zw0,  g.zw1);

  const sheets = g.sheets.map((s, i) => [String(i + 1), s.a, s.b]);

  const device = (tag, zga, zha, zca, zcb, zhb, zgb, br, zbr0, zbr1) => {
    add(tag + '_GateLiner', 'SiO2',    g.xg0, g.xg1, g.yl0,   g.yl1,   zga, zgb);
    add(tag + '_Source',    'Silicon', g.x0,  g.x1,  g.y_sd0, g.y_sd1, zga, zgb);
    add(tag + '_Drain',     'Silicon', g.x2,  g.x3,  g.y_sd0, g.y_sd1, zga, zgb);
    for (const [st, a, b] of sheets) {
      add(`${tag}_Sheet${st}_extS`, 'Silicon', g.x1,  g.xg0, a, b, zca, zcb);
      add(`${tag}_Sheet${st}_chan`, 'Silicon', g.xg0, g.xg1, a, b, zca, zcb);
      add(`${tag}_Sheet${st}_extD`, 'Silicon', g.xg1, g.x2,  a, b, zca, zcb);
    }
    /* Two nested closed collars. The IL uses the sheet faces, the HfO2 uses
       the IL's outer faces, so no straight line leaves the silicon and
       reaches metal without crossing both. */
    const il = C.T_IL;
    for (const [st, a, b] of sheets) {
      add(`${tag}_IL_s${st}_bot`, 'SiO2', g.xg0, g.xg1, a - il, a, zca - il, zcb + il);
      add(`${tag}_IL_s${st}_top`, 'SiO2', g.xg0, g.xg1, b, b + il, zca - il, zcb + il);
      add(`${tag}_IL_s${st}_zlo`, 'SiO2', g.xg0, g.xg1, a, b, zca - il, zca);
      add(`${tag}_IL_s${st}_zhi`, 'SiO2', g.xg0, g.xg1, a, b, zcb, zcb + il);

      add(`${tag}_HfO2_s${st}_bot`, 'HfO2', g.xg0, g.xg1,
          a - il - C.T_HFO2, a - il, zha, zhb);
      add(`${tag}_HfO2_s${st}_top`, 'HfO2', g.xg0, g.xg1,
          b + il, b + il + C.T_HFO2, zha, zhb);
      add(`${tag}_HfO2_s${st}_zlo`, 'HfO2', g.xg0, g.xg1, a - il, b + il, zha, zca - il);
      add(`${tag}_HfO2_s${st}_zhi`, 'HfO2', g.xg0, g.xg1, a - il, b + il, zcb + il, zhb);
    }
    add(tag + '_gate_bottom',   'TiN', g.xg0, g.xg1, g.ygb0,   g.ygb1,   zga, zgb);
    add(`${tag}_gate_bridge_${br}`, 'TiN', g.xg0, g.xg1, g.ybr0, g.ybr1, zbr0, zbr1);
    for (const band of g.inter) {
      add(`${tag}_gate_inter${band.tag}`, 'TiN', g.xg0, g.xg1, band.lo, band.hi, zha, zhb);
    }
    add(tag + '_gate_top',      'TiN', g.xg0, g.xg1, g.ygt0,   g.ygt1,   zga, zgb);
    for (const [sp, xa, xb] of [['S', g.x1, g.xg0], ['D', g.xg1, g.x2]]) {
      add(`${tag}_Sp${sp}_zlo`, 'Si3N4', xa, xb, g.yl0, g.ygt1, zga, zca);
      add(`${tag}_Sp${sp}_zhi`, 'Si3N4', xa, xb, g.yl0, g.ygt1, zcb, zgb);
      // the spacer fills the gate window except where the sheets pass through
      add(`${tag}_Sp${sp}_b`, 'Si3N4', xa, xb, g.yl0, g.sheets[0].a, zca, zcb);
      for (let i = 0; i + 1 < g.sheets.length; i++) {
        add(`${tag}_Sp${sp}_m${i + 1}`, 'Si3N4', xa, xb,
            g.sheets[i].b, g.sheets[i + 1].a, zca, zcb);
      }
      add(`${tag}_Sp${sp}_t`, 'Si3N4', xa, xb,
          g.sheets[g.sheets.length - 1].b, g.ygt1, zca, zcb);
    }
  };

  device('n', g.zng0, g.znh0, g.znc0, g.znc1, g.znh1, g.zng1, 'L', g.nbr[0], g.nbr[1]);
  device('p', g.zpg0, g.zph0, g.zpc0, g.zpc1, g.zph1, g.zpg1, 'R', g.pbr[0], g.pbr[1]);
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
  const nSheets = Math.round(C.N_SHEETS || 3);
  if (!Number.isFinite(nSheets) || nSheets < 1) {
    errs.push(`N_SHEETS must be at least 1 (got ${C.N_SHEETS})`);
  } else if (nSheets > 12) {
    errs.push(`N_SHEETS = ${nSheets} is beyond what this structure is meant for (max 12)`);
  }
  if (errs.length) return { errs, warns, g: null, R: null };

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
  // one check per adjacent pair, so a 1- or 2-sheet stack has fewer pairs
  // rather than being measured against sheets that do not exist
  const gaps = [];
  for (let i = 0; i + 1 < g.sheets.length; i++) {
    gaps.push([`sheet${i + 1}-sheet${i + 2}`, g.sheets[i + 1].a - g.sheets[i].b]);
  }
  for (const [nm, gp] of gaps) {
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
    for (const st of g.sheets.map((_, i) => String(i + 1))) {
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

  /* -- 8. gate dielectric closure ---------------------------------------
     Two nested collars now: the interfacial layer closes against the
     silicon, and the HfO2 closes against the IL's outer faces. Both are
     checked, because a gap in either one is a path from channel to metal.
     Checking only the HfO2 against the sheet - which is what this did
     while the stack was single-layer - reports a break on a perfectly
     good structure, since the HfO2 no longer touches the silicon at all. */
  const il = C.T_IL;
  for (const [tag, zca, zcb] of [['n', g.znc0, g.znc1], ['p', g.zpc0, g.zpc1]]) {
    for (const [st, a, b] of g.sheets.map((sh, i) => ['s' + (i + 1), sh.a, sh.b])) {

      const ilc = R.filter((r) => r.name.startsWith(`${tag}_IL_${st}`));
      if (ilc.length !== 4) {
        errs.push(`${tag}MOS ${st}: expected 4 interfacial slabs, found ${ilc.length}`);
      } else {
        const below = ilc.some((r) => Math.abs(r.y1 - a) < EPS);
        const above = ilc.some((r) => Math.abs(r.y0 - b) < EPS);
        const zlo   = ilc.some((r) => Math.abs(r.z1 - zca) < EPS);
        const zhi   = ilc.some((r) => Math.abs(r.z0 - zcb) < EPS);
        if (!(below && above && zlo && zhi)) {
          errs.push(`${tag}MOS ${st}: interfacial collar is not closed on the silicon ` +
                    `(below=${below} above=${above} -Z=${zlo} +Z=${zhi})`);
        }
      }

      const hf = R.filter((r) => r.name.startsWith(`${tag}_HfO2_${st}`));
      if (hf.length !== 4) {
        errs.push(`${tag}MOS ${st}: expected 4 HfO2 slabs, found ${hf.length}`);
      } else {
        const below = hf.some((r) => Math.abs(r.y1 - (a - il)) < EPS);
        const above = hf.some((r) => Math.abs(r.y0 - (b + il)) < EPS);
        const zlo   = hf.some((r) => Math.abs(r.z1 - (zca - il)) < EPS);
        const zhi   = hf.some((r) => Math.abs(r.z0 - (zcb + il)) < EPS);
        if (!(below && above && zlo && zhi)) {
          errs.push(`${tag}MOS ${st}: HfO2 collar is not closed on the interfacial layer ` +
                    `(below=${below} above=${above} -Z=${zlo} +Z=${zhi})`);
        }
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
    ['substrate', (g.x0 + g.x3) / 2,  g.ysub0, g.znc_mid, 'Substrate_P', 'bottom'],
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

/* ==========================================================================
   MESH REFINEMENT SIZES
   --------------------------------------------------------------------------
   One table, used by both emitters. The strings are the reference values,
   kept verbatim so that at the default 2 nm the generated SCM is unchanged
   down to the trailing zeros. At any other setting every number is scaled
   by MESH_NM / 2.

   Scaling the whole table rather than setting one size everywhere is the
   point: the RATIOS carry the refinement strategy - fine at the junctions
   and the dielectric, coarse in the deep substrate - and a slider that
   flattened them would produce a uniformly fine mesh nobody can afford, or
   a uniformly coarse one that cannot resolve a 2 nm collar.
   ========================================================================== */
const MESH_ROWS = {
  RS_global: '0.020 0.020 0.020 0.006 0.006 0.006',
  RS_active: '0.005 0.002 0.005 0.003 0.001 0.003',
  RS_diel:   '0.004 0.0008 0.004 0.002 0.0003 0.002',
  RS_junc:   '0.002 0.002 0.005 0.0015 0.001 0.003',
  RS_wall:   '0.006 0.005 0.003 0.003 0.002 0.0015',
  RS_well:   '0.010 0.004 0.008 0.004 0.002 0.004',
  RS_sub:    '0.030 0.030 0.030 0.012 0.012 0.012',
}
const MESH_BASE_NM = 2;

/** Mesh scale factor for the requested element size. */
function meshScale(C) {
  const nm = Number(C && C.MESH_NM);
  if (!Number.isFinite(nm) || nm <= 0) return 1;
  return nm / MESH_BASE_NM;
}

/** One (sdedr:define-refinement-size ...) line, scaled. */
function rsLine(name, C) {
  const lit = MESH_ROWS[name];
  const k = meshScale(C);
  if (k === 1) return `(sdedr:define-refinement-size "${name}" ${lit})`;
  const vals = lit.split(/\s+/).map((v) => {
    const x = parseFloat(v) * k;
    // nothing useful below a tenth of a nanometre
    return String(Number(Math.max(0.0001, x).toPrecision(3)));
  });
  return `(sdedr:define-refinement-size "${name}" ${vals.join(' ')})`;
}

/** A doping concentration in the 1e17 / 5e19 form SDE scripts use. */
function conc(v) {
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const s = v.toExponential().replace('e+', 'e');
  return s.replace(/^(\d)e/, '$1e');
}

/* ==========================================================================
   5. SCM EMITTER
   --------------------------------------------------------------------------
   One output style, and no option to change it: every cuboid as its own
   create-cuboid call, in build order, named, with literal coordinates. No
   helper procedures, no (define ...) block, no comments - grouped only by
   blank lines, in the order a device is actually built: geometry, doping,
   contacts, mesh, build.

   The geometry is NOT rebuilt here. Every region comes straight from
   regionList(), so there is one source of truth for the build order and no
   second copy that could drift. The test harness parses this function's
   output and asserts the resulting region list matches regionList() exactly
   - name, material and all six bounds - so a change that moved anything
   would fail that comparison.
   ========================================================================== */

/**
 * `(sdegeo:create-cuboid (position ...) (position ...) "Mat" "Name")`
 *
 * Coordinates are literal numbers. An earlier version emitted symbol names
 * with a block of (define ...) lines above them - but a define block is a
 * program, not a script you could have typed, so every line here stands on
 * its own instead.
 */
function cuboid(name, material, ax, bx, ay, by, az, bz) {
  return `(sdegeo:create-cuboid (position ${n(ax)} ${n(ay)} ${n(az)}) ` +
         `(position ${n(bx)} ${n(by)} ${n(bz)}) "${material}" "${name}")`;
}

/** Doping placements for one transistor, one per sheet segment. */
function flatDoping(tag, N) {
  const T = tag;
  const L = [];
  const ids = Array.from({ length: N }, (_, i) => String(i + 1));
  const pr = (name, prof, region) =>
    L.push(`(sdedr:define-constant-profile-region "${name}" "${prof}" "${region}")`);
  pr(`Pl_${T}Src`, `Prof_${T}SD`, `${tag}_Source`);
  pr(`Pl_${T}Drn`, `Prof_${T}SD`, `${tag}_Drain`);
  for (const st of ids) {
    pr(`Pl_${T}S${st}_eS`, `Prof_${T}Ext`, `${tag}_Sheet${st}_extS`);
    pr(`Pl_${T}S${st}_eD`, `Prof_${T}Ext`, `${tag}_Sheet${st}_extD`);
  }
  for (const st of ids) {
    pr(`Pl_${T}S${st}_ch`, `Prof_${T}Chan`, `${tag}_Sheet${st}_chan`);
  }
  return L;
}

/**
 * The whole device as a flat, comment-free, step-by-step SDE script.
 *
 * The geometry is emitted straight from regionList(), not rebuilt here.
 * There used to be a second copy of the build order in this function, kept
 * in step with the first only by a test; now there is one source of truth
 * and the two cannot disagree at all.
 */
function buildFlatScm(G, meshPrefix, C) {
  const L = [];
  const push = (...xs) => L.push(...xs);
  const N = G.sheets.length;

  // ---- setup ----
  push('(sde:clear)');
  push('(sde:set-process-up-direction "+z")');
  push('(sdegeo:set-default-boolean "ABA")');
  push('');

  // ---- geometry, in build order, with a break between groups ----
  const groupOf = (name) =>
    /^Substrate|^Well_/.test(name) ? 'sub'
      : /^ForkWall/.test(name) ? 'wall'
        : name.slice(0, 2);
  let prev = null;
  for (const r of regionList(G, C)) {
    const grp = groupOf(r.name);
    if (prev !== null && grp !== prev) push('');
    prev = grp;
    push(cuboid(r.name, r.material, r.x0, r.x1, r.y0, r.y1, r.z0, r.z1));
  }
  push('');

  // ---- doping ----
  const dose = (key) => {
    const v = C[key];
    return Number.isFinite(v) ? v : DEFAULT_DOPING[key];
  };
  const prof = (name, field, key) =>
    push(`(sdedr:define-constant-profile "${name}"${' '.repeat(Math.max(1, 14 - name.length))}` +
         `"${field}"${' '.repeat(Math.max(1, 31 - field.length))}${conc(dose(key))})`);
  prof('Prof_Sub',   'BoronActiveConcentration',      'N_SUB');
  prof('Prof_WellP', 'BoronActiveConcentration',      'N_WELLP');
  prof('Prof_WellN', 'PhosphorusActiveConcentration', 'N_WELLN');
  push('');
  prof('Prof_nChan', 'BoronActiveConcentration',      'N_CHAN');
  prof('Prof_nExt',  'ArsenicActiveConcentration',    'N_EXT');
  prof('Prof_nSD',   'ArsenicActiveConcentration',    'N_SD');
  push('');
  prof('Prof_pChan', 'PhosphorusActiveConcentration', 'N_CHAN');
  prof('Prof_pExt',  'BoronActiveConcentration',      'N_EXT');
  prof('Prof_pSD',   'BoronActiveConcentration',      'N_SD');
  push('');
  push('(sdedr:define-constant-profile-region "Pl_Sub"   "Prof_Sub"   "Substrate_P")');
  push('(sdedr:define-constant-profile-region "Pl_WellP" "Prof_WellP" "Well_P")');
  push('(sdedr:define-constant-profile-region "Pl_WellN" "Prof_WellN" "Well_N")');
  push('');
  push(...flatDoping('n', N));
  push('');
  push(...flatDoping('p', N));
  push('');

  // ---- contacts ----
  const cset = (name, r, g2, b) =>
    push(`(sdegeo:define-contact-set "${name}"${' '.repeat(Math.max(1, 11 - name.length))}` +
         `4.0 (color:rgb ${r} ${g2} ${b}) "##")`);
  cset('source_n', '1.00', '0.55', '0.10');
  cset('drain_n',  '0.10', '0.45', '0.95');
  cset('gate_n',   '0.90', '0.10', '0.10');
  cset('source_p', '0.95', '0.80', '0.15');
  cset('drain_p',  '0.55', '0.20', '0.75');
  cset('gate_p',   '0.85', '0.35', '0.55');
  cset('substrate', '0.55', '0.55', '0.60');
  cset('nwell',    '0.35', '0.65', '0.45');
  push('');

  /* nwell sits on the +Z domain-boundary face of Well_N, standing in for a
     real surface tap: the whole n-well top face is covered by pads, liner
     and spacers, so there is no room for one. Without it the pFET body
     floats and the parasitic PNP swamps the channel current. */
  for (const [set, px, py, pz] of [
    ['source_n',  n((G.x0 + G.x1) / 2),   n(G.y_sd1), n(G.znc_mid)],
    ['drain_n',   n((G.x2 + G.x3) / 2),   n(G.y_sd1), n(G.znc_mid)],
    ['gate_n',    n((G.xg0 + G.xg1) / 2), n(G.ygt1),  n(G.znc_mid)],
    ['source_p',  n((G.x0 + G.x1) / 2),   n(G.y_sd1), n(G.zpc_mid)],
    ['drain_p',   n((G.x2 + G.x3) / 2),   n(G.y_sd1), n(G.zpc_mid)],
    ['gate_p',    n((G.xg0 + G.xg1) / 2), n(G.ygt1),  n(G.zpc_mid)],
    ['substrate', n((G.x0 + G.x3) / 2),   n(G.ysub0), n(G.znc_mid)],
    ['nwell',     n((G.x0 + G.x3) / 2),   n((G.ywell + G.ysub1) / 2), n(G.zpg1)],
  ]) {
    push(`(sdegeo:set-current-contact-set "${set}")`);
    push(`(sdegeo:set-contact-faces (find-face-id (position ${px} ${py} ${pz})) "${set}")`);
  }
  push('');

  // ---- mesh ----
  const top = G.sheets[N - 1].b;
  const win = (name, ax, ay, az, bx, by, bz) =>
    push(`(sdedr:define-refinement-window "${name}" "Cuboid" ` +
         `(position ${n(ax)} ${n(ay)} ${n(az)}) (position ${n(bx)} ${n(by)} ${n(bz)}))`);
  const place = (rp, rs, rw) =>
    push(`(sdedr:define-refinement-placement "${rp}" "${rs}" "${rw}")`);

  push(rsLine('RS_global', C));
  win('RW_global', G.x0, G.ysub0, G.zng0, G.x3, G.ygt1, G.zpg1);
  place('RP_global', 'RS_global', 'RW_global');
  push('');

  push(rsLine('RS_active', C));
  win('RW_actN', G.x1 - 0.003, G.yl0, G.zng0 - 0.002,
                 G.x2 + 0.003, G.ygt1 + 0.002, G.zng1 + 0.002);
  place('RP_actN', 'RS_active', 'RW_actN');
  win('RW_actP', G.x1 - 0.003, G.yl0, G.zpg0 - 0.002,
                 G.x2 + 0.003, G.ygt1 + 0.002, G.zpg1 + 0.002);
  place('RP_actP', 'RS_active', 'RW_actP');
  push('');

  /* The interfacial layer is the thinnest thing in the structure, so the
     dielectric stack gets its own window: fine in Y where the layers
     stack, coarse in X and Z where nothing is thin. */
  push(rsLine('RS_diel', C));
  win('RW_dielN', G.xg0, G.sheets[0].a - G.t_diel, G.znh0, G.xg1, top + G.t_diel, G.znh1);
  place('RP_dielN', 'RS_diel', 'RW_dielN');
  win('RW_dielP', G.xg0, G.sheets[0].a - G.t_diel, G.zph0, G.xg1, top + G.t_diel, G.zph1);
  place('RP_dielP', 'RS_diel', 'RW_dielP');
  push('');

  push(rsLine('RS_junc', C));
  win('RW_jNs', G.xg0 - 0.005, G.sheets[0].a, G.znh0, G.xg0 + 0.005, top, G.znh1);
  place('RP_jNs', 'RS_junc', 'RW_jNs');
  win('RW_jNd', G.xg1 - 0.005, G.sheets[0].a, G.znh0, G.xg1 + 0.006, top, G.znh1);
  place('RP_jNd', 'RS_junc', 'RW_jNd');
  win('RW_jPs', G.xg0 - 0.005, G.sheets[0].a, G.zph0, G.xg0 + 0.005, top, G.zph1);
  place('RP_jPs', 'RS_junc', 'RW_jPs');
  win('RW_jPd', G.xg1 - 0.005, G.sheets[0].a, G.zph0, G.xg1 + 0.006, top, G.zph1);
  place('RP_jPd', 'RS_junc', 'RW_jPd');
  push('');

  push(rsLine('RS_wall', C));
  win('RW_wall', G.x0, G.ysub1 - 0.010, G.zw0 - 0.002, G.x3, G.ygt1, G.zw1 + 0.002);
  place('RP_wall', 'RS_wall', 'RW_wall');
  push('');

  push(rsLine('RS_well', C));
  win('RW_wellTop', G.x0, G.ywell, G.zng0, G.x3, G.ysub1, G.zpg1);
  place('RP_wellTop', 'RS_well', 'RW_wellTop');
  push('');

  push(rsLine('RS_sub', C));
  win('RW_sub', G.x0, G.ysub0, G.zng0, G.x3, G.ywell, G.zpg1);
  place('RP_sub', 'RS_sub', 'RW_sub');
  push('');

  push(`(sde:build-mesh "snmesh" "" "${meshPrefix}")`);

  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}


/**
 * The single place the rest of the UI asks for SCM text.
 *
 * There is one output style and no option to change it: every command
 * written out one by one, literal numbers, no comments and no (define ...)
 * block - a script you could have typed into a Sentaurus script window
 * rather than a program that computes one.
 *
 * An earlier version also offered the Python generator's helper procedures,
 * with and without their banner comments. Those carried a define block whose
 * symbols had to be kept in step with the geometry by hand, and they were
 * written for exactly three sheets. Both are gone.
 */
function emitScm(g, meshPrefix, C) {
  return buildFlatScm(g, meshPrefix, C);
}


/* ==========================================================================
   6. FILE NAMING AND DOWNLOAD
   ========================================================================== */

/** Port of case_name(): fork_TNS_0.006_WNS_0.030_TFORK_0.008 */
function caseName(t_ns, w_ns, t_fork) {
  return `fork_TNS_${t_ns.toFixed(3)}_WNS_${w_ns.toFixed(3)}_TFORK_${t_fork.toFixed(3)}`;
}

/* How each extra variable appears in a filename. */
const NAME_TAG = { L_G: 'LG', T_SPACER: 'TSP', L_PAD: 'LPAD', N_SHEETS: 'NNS' };

/**
 * Name a sweep case so two cases can never collide.
 *
 * The legacy three-parameter name is always the stem, so a sweep over
 * T_NS/W_NS/T_FORK produces exactly the filenames it always did. Any other
 * variable that VARIES in this sweep is appended. Without that, a sweep
 * over gate length would write every case to the same filename and quietly
 * download one file several times.
 */
function caseNameFor(v, extraKeys) {
  let stem = caseName(v.T_NS, v.W_NS, v.T_FORK);
  for (const k of (extraKeys || [])) {
    if (k === 'T_NS' || k === 'W_NS' || k === 'T_FORK') continue;
    const tag = NAME_TAG[k] || k;
    stem += `_${tag}_${k === 'N_SHEETS' ? v[k] : Number(v[k]).toFixed(3)}`;
  }
  return stem;
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
  for (const key of Object.keys(DEFAULT_DOPING)) {
    C[key] = readNumber(key, DEFAULT_DOPING[key]);
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

  /* Consistency gate: measure the emitted script rather than the model, so
     an emitter mistake cannot slip through unnoticed. */
  const an = analyseCurrent(app.lastScm, `the generated ${stem}.scm`);
  if (an && an.issues.length) {
    // 'info' findings are descriptive - an intentional overlap is one -
    // so only genuine errors may block a download
    const hard = an.issues.filter((i) => i.severity === 'error');
    const summary = consistencySummary(an.issues);
    if (hard.length) {
      setStatus('error', `Geometry check failed - ${summary}`,
        hard.slice(0, 8).map((i) => `${i.kind}: ${i.message}`));
      setDownloadEnabled(false);
    } else {
      setStatus('warn', `Valid, with ${an.issues.length} geometry note(s)`,
        msg.concat(res.warns, an.issues.slice(0, 6).map((i) => `${i.kind}: ${i.message}`)));
    }
  }

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

/**
 * Build the case list for the current sweep settings.
 *
 * Generalised from the original three fixed lists to any subset of
 * SWEEP_VARS, because the study has six primary variables and gate length,
 * spacer thickness and source/drain length were previously not sweepable
 * at all. Returns the cases and the keys that actually vary, which is what
 * the file naming needs to stay collision-free.
 */
function sweepCases() {
  const base = Object.assign({}, readParams(), readConstants());
  const parseList = (id) => {
    const el = $(id);
    if (!el) return [];
    return el.value.split(',').map((x) => parseFloat(x.trim()))
      .filter((v) => Number.isFinite(v));
  };

  const active = [];
  for (const k of SWEEP_VARS) {
    const on = $(`#sweep-on-${k}`);
    if (!on || !on.checked) continue;
    const vals = parseList(`#sweep-${k}`);
    if (vals.length) active.push([k, vals]);
  }

  const mode = $('#gen-mode').value;
  let cases = [];

  if (!active.length) return { cases, active: [], varying: [], mode };

  if (mode === 'full_grid') {
    cases = [Object.assign({}, base)];
    for (const [k, vals] of active) {
      const next = [];
      for (const c of cases) {
        for (const v of vals) next.push(Object.assign({}, c, { [k]: v }));
      }
      cases = next;
    }
  } else {
    // one at a time: vary each in turn, holding the rest at their control value
    for (const [k, vals] of active) {
      for (const v of vals) cases.push(Object.assign({}, base, { [k]: v }));
    }
  }

  // drop duplicates, which one-at-a-time produces whenever a list contains
  // the value already in the control
  const seen = new Set();
  cases = cases.filter((c) => {
    const key = SWEEP_VARS.map((k) => c[k]).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // a key only needs to appear in the filename if it actually changes
  const varying = SWEEP_VARS.filter((k) =>
    new Set(cases.map((c) => c[k])).size > 1);

  return { cases, active: active.map(([k]) => k), varying, mode };
}

/** Live case count under the sweep lists, so a grid cannot surprise anyone. */
function updateSweepCount() {
  const box = $('#sweep-count');
  if (!box) return;
  if ($('#gen-mode').value === 'single') { box.textContent = 'Single case.'; box.className = 'import-status'; return; }

  const { cases, active, mode } = sweepCases();
  if (!cases.length) {
    box.className = 'import-status error';
    box.innerHTML = '<strong>No cases.</strong> Tick at least one variable and give it values.';
    return;
  }
  const names = active.join(', ');
  const kind = mode === 'full_grid' ? 'full grid' : 'one at a time';
  if (cases.length > SWEEP_HARD_CAP) {
    box.className = 'import-status error';
    box.innerHTML = `<strong>${cases.length} cases</strong> (${kind} over ${names}). ` +
      `That is beyond the ${SWEEP_HARD_CAP}-file limit &mdash; browsers cannot be asked ` +
      `to save that many. Use fewer values, fewer variables, or one at a time.`;
  } else if (cases.length > SWEEP_WARN_AT) {
    box.className = 'import-status warn';
    box.innerHTML = `<strong>${cases.length} cases</strong> (${kind} over ${names}). ` +
      `That is ${cases.length} separate downloads.`;
  } else {
    box.className = 'import-status ok';
    box.innerHTML = `<strong>${cases.length} case${cases.length > 1 ? 's' : ''}</strong> ` +
      `(${kind} over ${names}).`;
  }
}

const SWEEP_WARN_AT = 40;
const SWEEP_HARD_CAP = 300;

/** Port of run_sweep(): one_at_a_time and full_grid, over any variables. */
function doSweep() {
  const { cases, varying, mode } = sweepCases();

  if (!cases.length) {
    setStatus('error', 'Sweep has no cases',
      ['tick at least one variable and give it a comma-separated list']);
    return;
  }
  if (cases.length > SWEEP_HARD_CAP) {
    setStatus('error', `${cases.length} cases is too many to download`,
      [`the limit is ${SWEEP_HARD_CAP} files`,
       'reduce the value lists, untick a variable, or switch to one at a time']);
    return;
  }

  const written = [], rejected = [];
  const files = [];
  for (const c of cases) {
    // each case overrides only its own variables; everything else holds
    const C = Object.assign({}, readConstants());
    for (const k of SWEEP_VARS) {
      if (k !== 'T_NS' && k !== 'W_NS' && k !== 'T_FORK') C[k] = c[k];
    }
    const res = validate(c.T_NS, c.W_NS, c.T_FORK, C);
    const stem = caseNameFor(c, varying);
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
    `Sweep (${mode === 'full_grid' ? 'full grid' : 'one at a time'}): ` +
    `${files.length} file(s) downloading, ${rejected.length} rejected`,
    [`varying: ${varying.join(', ') || 'nothing'}`]
      .concat(written.slice(0, 12).map((x) => 'OK  ' + x))
      .concat(written.length > 12 ? [`...and ${written.length - 12} more`] : [])
      .concat(rejected.map((x) => 'REJECTED  ' + x)));
}

function doReset() {
  clearFlags();
  for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  for (const [k, v] of Object.entries(DEFAULT_CONSTANTS)) {
    const el = document.getElementById(k);
    if (el) el.value = v;
  }
  for (const [k, v] of Object.entries(DEFAULT_DOPING)) {
    const el = document.getElementById(k);
    // a number input accepts "1e17"; assigning the raw value would render
    // it as 100000000000000000, which nobody can read or edit
    if (el) el.value = conc(v);
  }
  for (const k of SWEEP_VARS) {
    const list = document.getElementById('sweep-' + k);
    if (list) list.value = DEFAULT_SWEEP[k];
    const tick = document.getElementById('sweep-on-' + k);
    if (tick) tick.checked = !!DEFAULT_SWEEP_ON[k];
  }
  $('#gen-mode').value = 'single';
  $('#mesh-prefix-mode').value = 'auto';
  $('#mesh-prefix-custom').value = 'fork1108';
  const ms = $('#mesh-slider');
  if (ms) ms.value = '20';
  const col = $('#sel-colour');
  if (col) { col.value = 'material'; }
  if (window.Preview && window.Preview.setColorMode) window.Preview.setColorMode('material');
  clearImport(true);
  renderScript('');
  onModeChange();
  refreshPreview();
  setStatus('ok', 'Reset to default parameters', []);
}

function onModeChange() {
  const single = $('#gen-mode').value === 'single';
  $('#sweep-fields').style.display = single ? 'none' : '';
  updateSweepCount();
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
  for (const [k, v] of Object.entries(DEFAULT_DOPING)) {
    const el = document.getElementById(k);
    // a number input accepts "1e17"; assigning the raw value would render
    // it as 100000000000000000, which nobody can read or edit
    if (el) el.value = conc(v);
  }
  for (const k of SWEEP_VARS) {
    const list = document.getElementById('sweep-' + k);
    if (list) list.value = DEFAULT_SWEEP[k];
    const tick = document.getElementById('sweep-on-' + k);
    if (tick) tick.checked = !!DEFAULT_SWEEP_ON[k];
  }

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
  /* The slider and the number box are two views of one value: the slider is
     in tenths of a nanometre so it can step finely near 1 nm without a
     hundred-step range at the coarse end. */
  const meshSlider = $('#mesh-slider');
  const meshBox = $('#MESH_NM');
  if (meshSlider && meshBox) {
    const fromSlider = () => {
      meshBox.value = (Number(meshSlider.value) / 10).toFixed(1);
      if (imported.active) clearImport(false);
      schedulePreview();
      updateSweepCount();
    };
    const fromBox = () => {
      const v = parseFloat(meshBox.value);
      if (Number.isFinite(v)) {
        meshSlider.value = String(Math.round(Math.max(0.5, Math.min(20, v)) * 10));
      }
      if (imported.active) clearImport(false);
      schedulePreview();
    };
    meshSlider.addEventListener('input', fromSlider);
    meshBox.addEventListener('input', fromBox);
  }

  $('#gen-mode').addEventListener('change', onModeChange);

  // every sweep control refreshes the case count, so a full grid can never
  // surprise anyone with 729 downloads
  for (const k of SWEEP_VARS) {
    const list = document.getElementById('sweep-' + k);
    const tick = document.getElementById('sweep-on-' + k);
    if (list) list.addEventListener('input', updateSweepCount);
    if (tick) tick.addEventListener('change', updateSweepCount);
  }
  $$('#controls input[type="number"]').forEach((el) =>
    el.addEventListener('input', updateSweepCount));

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

  // .static headers are labels, not toggles - the Generate card has one so
  // its buttons are clearly their own section and not part of the card above
  $$('.section-head:not(.static)').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  $('#mesh-prefix-custom').disabled = true;
  onModeChange();

  // import (file + paste), the script view and the viewer tools
  initImport();
  initScriptView();
  initViewerTools();
  initSdevice();

  // layout: sidebar resizing, drawer mode, viewport watchers
  initLayout();

  refreshPreview();
}

/**
 * Boot.
 *
 * The two steps are separated on purpose. initGenerator() wires several
 * hundred controls, and reaching for one that is not in the page throws -
 * which used to take the whole app down silently: the viewport kept saying
 * "building preview..." forever because the code that draws the geometry
 * and hides that hint never ran, and nothing said why.
 *
 * That is exactly what a stale cached script does after index.html changes,
 * so the scripts are versioned now (see the ?v= note in index.html). This
 * catch is the second line of defence: if wiring does fail, the viewport
 * says so instead of hanging, and the error reaches the console.
 */
document.addEventListener('DOMContentLoaded', () => {
  if (window.Preview) window.Preview.init('viewport');
  try {
    initGenerator();
  } catch (err) {
    console.error('initGenerator() failed:', err);
    const hint = document.getElementById('viewer-hint');
    if (hint) {
      hint.innerHTML =
        '<strong>The page failed to start.</strong>' +
        '<span class="dim">' + String(err && err.message ? err.message : err) +
        '</span><span class="dim">A stale cached script usually causes this - ' +
        'reload with Ctrl+F5 (Cmd+Shift+R on a Mac).</span>';
      hint.style.display = '';
    }
  }
});

/* expose for preview.js and for console debugging */
window.Generator = {
  compute, regionList, validate, buildFlatScm, emitScm,
  caseName, materialColor, n,
  DEFAULT_PARAMS, DEFAULT_CONSTANTS, DEFAULT_DOPING,
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

  /* ---- can the parametric model be driven from this file? ----
     Two routes, in order of authority:

       1. explicit (define T_NS ...) bindings, if the file has them
       2. measurement of the geometry itself

     Route 2 matters now that the step-by-step output carries no define
     block at all - there is nothing to read back from it. It also turns
     out to be the more useful route: it recognises any forksheet file,
     not only ones this generator wrote. */
  const b = parsed.bindings;
  const measured = (window.SDEAnalyze && window.SDEAnalyze.extractParams)
    ? (window.SDEAnalyze.extractParams(parsed) || { params: {}, from: {} })
    : { params: {}, from: {} };

  const pick = (defineName, altName, key) => {
    if (typeof b[defineName] === 'number') return { v: b[defineName], how: 'define' };
    if (altName && typeof b[altName] === 'number') return { v: b[altName], how: 'define' };
    if (typeof measured.params[key] === 'number') {
      return { v: measured.params[key], how: 'measured' };
    }
    return null;
  };

  const tns = pick('T_NS', null, 'T_NS');
  const wns = pick('W_NS', null, 'W_NS');
  const fk = pick('t_wall', 'T_FORK', 'T_FORK');
  const hasParams = !!(tns && wns && fk);

  if (hasParams) {
    clearImport(true);

    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el || typeof v !== 'number' || !Number.isFinite(v)) return false;
      // doping is written in exponent form, everything else as it comes
      el.value = /^N_(SUB|WELL|CHAN|EXT|SD)/.test(id) ? conc(v) : v;
      return true;
    };
    set('T_NS', tns.v);
    set('W_NS', wns.v);
    set('T_FORK', fk.v);

    /* The remaining fields: a define wins where one exists, otherwise the
       measurement. SDE's define names differ from the study's, so they are
       mapped across. */
    const constMap = {
      L_PAD: 'L_pad', T_SPACER: 't_spacer', L_G: 'L_G', T_HFO2: 't_hfo2',
      T_METAL: 't_metal', T_LINER: 't_liner', T_BRIDGE: 't_bridge',
      T_DOMAIN: 't_domain', T_WELL: 't_well', T_IL: 't_il', N_SHEETS: null,
    };
    const picked = [];
    let measuredCount = 0;
    for (const field of Object.keys(constMap)) {
      const got = pick(constMap[field] || field, field, field);
      if (got && set(field, got.v)) {
        picked.push(field);
        if (got.how === 'measured') measuredCount++;
      }
    }
    const sheetsFound = measured.params.N_SHEETS || 0;
    const byMeasurement = measuredCount + [tns, wns, fk]
      .filter((x) => x && x.how === 'measured').length;

    // doping concentrations come from the profile definitions
    /* V13 profile names. The n and p channel/extension/pad profiles share a
       magnitude and differ only in species, so either one recovers the
       field; whichever appears last in the file wins, and they agree. */
    const profMap = {
      Prof_Sub: 'N_SUB', Prof_WellP: 'N_WELLP', Prof_WellN: 'N_WELLN',
      Prof_nChan: 'N_CHAN', Prof_pChan: 'N_CHAN',
      Prof_nExt: 'N_EXT', Prof_pExt: 'N_EXT',
      Prof_nSD: 'N_SD', Prof_pSD: 'N_SD',
    };
    for (const prof of (parsed.profiles || [])) {
      const field = profMap[prof.name];
      if (field && set(field, prof.value)) picked.push(field);
    }

    if (parsed.meshPrefix) {
      $('#mesh-prefix-mode').value = 'custom';
      $('#mesh-prefix-custom').disabled = false;
      $('#mesh-prefix-custom').value = parsed.meshPrefix;
    }

    refreshPreview();
    doGenerate();

    setImportStatus('ok',
      '<strong>Loaded as parameters.</strong> ' + src + ' yielded a nanosheet ' +
      'thickness, width and fork wall, so the generator is driving the preview again. ' +
      picked.length + ' further parameter(s) recovered' +
      (byMeasurement ? ' (' + byMeasurement + ' measured from the geometry, ' +
        'the file carries no define block)' : " from the file's define block") +
      (sheetsFound ? ', including a ' + sheetsFound + '-sheet stack' : '') + ', and ' +
      parsed.regions.length + ' region(s) were read back to confirm it parses. ' +
      'The Structure analysis panel lists everything that was measured. ' +
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
  analyseCurrent(cleaned, imported.name);
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


/* ==========================================================================
   10. STRUCTURE ANALYSIS AND THE PRE-GENERATION CONSISTENCY GATE
   --------------------------------------------------------------------------
   Whatever is on screen - a structure the generator built, or one that was
   imported - is measured by the same code and reported the same way. The
   panel shows what the geometry IS; the gate below it decides whether it is
   fit to be written out.

   The gate runs two checkers, because they are good at different things:

     validate()          knows the Forksheet rules: gate connectivity,
                         collar closure, S/D continuity, contact placement.
                         Sharp, but only for the parametric model.
     SDEAnalyze.check()  knows no architecture at all: overlaps, empty gaps,
                         islands, contacts that land on nothing. Runs on
                         anything, including imported files.

   Neither subsumes the other, so both run and their findings are merged.
   ========================================================================== */

/** Render the measured-parameter report into the sidebar panel. */
function renderAnalysis(report, issues, sourceLabel) {
  const body = $('#analysis-body');
  const sub = $('#analysis-sub');
  if (!body) return;

  if (!report || !report.ok) {
    body.innerHTML = '<p class="note">Generate or import a structure to measure it.</p>';
    if (sub) sub.textContent = '';
    return;
  }

  const esc = escapeHtml;
  const out = [];

  if (sub) {
    sub.textContent = `${report.architecture.name} · ${report.regionCount} regions`;
  }

  for (const g of report.groups) {
    out.push('<div class="an-group">');
    out.push(`<div class="an-head">${esc(g.title)}</div>`);
    for (const p of g.params) {
      out.push('<div class="an-row">' +
        `<span class="an-label">${esc(p.label)}</span>` +
        `<span class="an-value">${esc(String(p.value))}</span>` +
        (p.note ? `<span class="an-note">${esc(p.note)}</span>` : '') +
        '</div>');
    }
    if (g.evidence && g.evidence.length) {
      out.push('<ul class="an-evidence">' +
        g.evidence.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>');
    }
    out.push('</div>');
  }

  /* ---- consistency report ---- */
  out.push('<div class="an-group an-issues">');
  out.push('<div class="an-head">Consistency check</div>');
  if (!issues || !issues.length) {
    out.push('<div class="an-clean">No overlaps, gaps, disconnected regions or ' +
             'invalid contacts found.</div>');
  } else {
    const shown = issues.slice(0, 40);
    for (const i of shown) {
      out.push(`<div class="an-issue ${esc(i.severity)}">` +
        `<span class="kind">${esc(i.kind)}</span>` +
        `<span>${esc(i.message)}</span></div>`);
    }
    if (issues.length > shown.length) {
      out.push(`<div class="an-issue warn"><span class="kind">more</span>` +
        `<span>${issues.length - shown.length} further finding(s) not listed.</span></div>`);
    }
  }
  if (sourceLabel) {
    out.push(`<p class="an-evidence" style="padding-left:0">Measured from ${esc(sourceLabel)}.</p>`);
  }
  out.push('</div>');

  body.innerHTML = out.join('');
}

/**
 * Analyse whatever is currently on screen and run the consistency gate.
 *
 * Takes the SCM text rather than the region list, deliberately: parsing the
 * text back is what proves the emitted file describes the structure the app
 * thinks it does. A mistake in the emitter shows up here as a discrepancy
 * instead of being invisible.
 */
function analyseCurrent(scmText, sourceLabel, extraIssues) {
  if (!window.SDE || !window.SDEAnalyze) return null;
  let report = null, issues = (extraIssues || []).slice();
  try {
    const parsed = window.SDE.parse(scmText);
    report = window.SDEAnalyze.analyze(parsed);

    // doping comes from the file's own profiles, never from a default
    const dop = window.SDEAnalyze.dopingMap(parsed);
    if (window.Preview && window.Preview.setDoping) window.Preview.setDoping(dop);

    const chk = window.SDEAnalyze.check(parsed.regions, parsed.contacts, parsed);
    issues = issues.concat(chk.issues);
    issues = issues.concat(
      window.SDEAnalyze.checkRequired(parsed.regions, report.architecture));
  } catch (e) {
    issues.push({ kind: 'degenerate', severity: 'error',
                  message: 'Analysis failed: ' + e.message });
  }
  renderAnalysis(report, issues, sourceLabel);
  wireIssueClicks(issues);
  setValidationBadge(issues, report ? 'Geometry consistent' : 'No structure');
  showContactsFor(scmText);
  return { report, issues };
}

/** Fold the generic checker's findings into the status panel wording. */
function consistencySummary(issues) {
  const counts = {};
  for (const i of issues) counts[i.kind] = (counts[i.kind] || 0) + 1;
  const parts = [];
  for (const k of ['overlap', 'gap', 'disconnected', 'contact', 'degenerate']) {
    if (counts[k]) parts.push(`${counts[k]} ${k}`);
  }
  return parts.join(', ');
}


/* ==========================================================================
   11. VIEWER TOOLS
   --------------------------------------------------------------------------
   The pieces that connect what the analyser found to what is on screen:
   contact markers, clickable findings that outline the regions they refer
   to, a cutting plane, a measuring tool and a validation badge.
   ========================================================================== */

/** Remember the last findings so a click can look one up. */
const viewerState = { issues: [], activeIssue: -1 };

/** Draw the contacts of whatever structure is loaded. */
function showContactsFor(scmText) {
  if (!window.SDE || !window.Preview || !window.Preview.setContacts) return;
  try {
    const parsed = window.SDE.parse(scmText);
    window.Preview.setContacts(parsed.contacts || []);
  } catch (_) { /* the badge already reports a parse problem */ }
}

/** The always-visible verdict over the canvas. */
function setValidationBadge(issues, label) {
  const el = $('#validation-badge');
  if (!el) return;
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warn').length;

  el.hidden = false;
  if (errs) {
    el.className = 'vbadge error';
    el.textContent = `${errs} geometry error${errs > 1 ? 's' : ''}` +
                     (warns ? `, ${warns} note${warns > 1 ? 's' : ''}` : '');
  } else if (warns) {
    el.className = 'vbadge warn';
    el.textContent = `${warns} geometry note${warns > 1 ? 's' : ''}`;
  } else {
    el.className = 'vbadge ok';
    el.textContent = label || 'Geometry consistent';
  }
}

/** Outline the regions a finding refers to, and frame it in the list. */
function focusIssue(index) {
  const issue = viewerState.issues[index];
  if (!issue || !window.Preview || !window.Preview.setFlagged) return;

  viewerState.activeIssue = index;
  document.querySelectorAll('.an-issue').forEach((el, k) =>
    el.classList.toggle('active', k === index));

  if (!issue.regions || !issue.regions.length) {
    window.Preview.setFlagged([], issue.severity);
    setStatus('warn', issue.kind + ': nothing to outline',
      [issue.message, 'this finding is not about a specific region']);
    return;
  }
  window.Preview.setFlagged(issue.regions, issue.severity);
  setStatus(issue.severity === 'error' ? 'error' : 'warn',
    `${issue.kind}: ${issue.regions.length} region(s) highlighted`,
    [issue.message].concat(issue.regions.slice(0, 8)));
}

function clearFlags() {
  if (window.Preview && window.Preview.setFlagged) window.Preview.setFlagged([]);
  viewerState.activeIssue = -1;
  document.querySelectorAll('.an-issue').forEach((el) => el.classList.remove('active'));
}

/** Make every rendered finding clickable. Called after each render. */
function wireIssueClicks(issues) {
  viewerState.issues = issues || [];
  viewerState.activeIssue = -1;
  document.querySelectorAll('#analysis-body .an-issue').forEach((el, k) => {
    if (k >= viewerState.issues.length) return;
    el.classList.add('clickable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.title = 'Highlight the regions this refers to';
    el.addEventListener('click', () => focusIssue(k));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusIssue(k); }
    });
  });
}

/* ------------------------------------------------------- viewer controls */
function initViewerTools() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  on('#sel-colour', 'change', (e) => {
    if (window.Preview && window.Preview.setColorMode) {
      window.Preview.setColorMode(e.target.value);
    }
  });

  on('#chk-contacts', 'change', (e) => {
    if (window.Preview && window.Preview.setShowContacts) {
      window.Preview.setShowContacts(e.target.checked);
    }
  });

  /* ---- cross-section ---- */
  const applySection = () => {
    const axis = $('#sel-section').value;
    const t = Number($('#section-at').value) / 100;
    const flip = $('#btn-section-flip').getAttribute('aria-pressed') === 'true';
    $('#section-at').disabled = !axis;
    $('#btn-section-flip').disabled = !axis;
    if (window.Preview && window.Preview.setClip) {
      window.Preview.setClip(axis || null, t, flip);
    }
  };
  on('#sel-section', 'change', applySection);
  on('#section-at', 'input', applySection);
  on('#btn-section-flip', 'click', () => {
    const b = $('#btn-section-flip');
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    applySection();
  });

  /* ---- measuring ---- */
  on('#btn-measure', 'click', () => {
    const b = $('#btn-measure');
    const now = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(now));
    b.textContent = now ? 'Measuring' : 'Measure';
    $('#viewport').classList.toggle('measuring', now);
    const read = $('#measure-readout');
    if (read) {
      read.hidden = !now;
      read.textContent = 'Click a region, then a second one.';
    }
    if (window.Preview && window.Preview.setMeasure) window.Preview.setMeasure(now);
  });

  on('#btn-clear-flags', 'click', clearFlags);
}


/* ==========================================================================
   12. THE SDevice WINDOW
   --------------------------------------------------------------------------
   Generate SCM -> Generate SDevice -> load or paste an SCM -> analyze ->
   configure -> generate -> validate -> edit -> export.

   The window keeps its own copy of the parsed structure. It is deliberately
   NOT wired to whatever the 3D preview happens to be showing: the deck must
   describe the SCM that was actually meshed, and silently following the
   preview would make it easy to export a deck for a different structure.
   "Use the generated SCM" copies it across explicitly.
   ========================================================================== */

const sdev = {
  parsed: null,
  analysis: null,
  settings: null,
  cmd: '',
  source: null,
};

function sdevOpen() {
  const w = $('#sdevice-window');
  if (!w) return;
  w.hidden = false;
  if (!sdev.parsed && app.lastScm) sdevLoad(app.lastScm, 'the generated SCM');
  sdevSyncMesh();
}

function sdevClose() {
  const w = $('#sdevice-window');
  if (w) w.hidden = true;
  if (window.Preview && window.Preview.resize) {
    requestAnimationFrame(() => window.Preview.resize());
  }
}

/* ------------------------------------------------------------ analysis */

function sdevSetStatus(kind, html) {
  const el = $('#sdev-struct');
  if (!el) return;
  el.className = 'import-status ' + (kind || '');
  el.innerHTML = html;
}

function sdevLoad(text, label) {
  if (!window.SDE || !window.SDEAnalyze || !window.SDevice) {
    sdevSetStatus('error', 'The SDE modules did not load.');
    return false;
  }
  const what = window.SDE.detect(text, null);
  if (what.kind === 'empty' || what.kind === 'unknown') {
    sdevSetStatus('error',
      `<strong>Not recognised.</strong> ${escapeHtml(what.reason)}.`);
    return false;
  }

  const parsed = window.SDE.parse(text);
  if (!parsed.regions.length) {
    sdevSetStatus('error',
      '<strong>No geometry.</strong> The script parsed but produced no regions, ' +
      'so there is nothing to build a device from.');
    return false;
  }

  sdev.parsed = parsed;
  sdev.analysis = window.SDEAnalyze.analyze(parsed);
  sdev.source = label || 'pasted text';

  // keep the user's settings across a reload where the names still fit
  const fresh = window.SDevice.defaultSettings(parsed, sdev.analysis);
  sdev.settings = sdev.settings ? mergeSettings(fresh, sdev.settings) : fresh;

  sdevFillControls();
  sdevRenderArch();
  sdevSyncMesh();

  const elec = window.SDevice.classifyElectrodes(parsed.contacts);
  sdevSetStatus('ok',
    `<strong>Loaded ${escapeHtml(sdev.source)}.</strong> ` +
    `${parsed.regions.length} regions, ${elec.length} electrodes, ` +
    `mesh ${escapeHtml(sdev.settings.grid)}.`);
  const sub = $('#sdev-subtitle');
  if (sub) {
    sub.textContent = `${sdev.analysis.architecture.name} · ` +
      `${parsed.regions.length} regions · ${elec.length} electrodes`;
  }
  return true;
}

/** Carry user choices forward, but never an electrode that no longer exists. */
function mergeSettings(fresh, old) {
  const out = JSON.parse(JSON.stringify(fresh));
  for (const k of ['physics', 'math', 'plot', 'bias', 'meshControl']) {
    Object.assign(out[k], old[k] || {});
  }
  out.temperature = old.temperature;
  out.thermal.enabled = old.thermal.enabled;
  out.thermal.ambient = old.thermal.ambient;
  out.thermal.surfaceResistance = old.thermal.surfaceResistance;
  // the thermode only survives if that contact is still in the structure
  const names = (fresh.workfunction && Object.keys(fresh.workfunction)) || [];
  if (old.thermal.thermode &&
      sdev.parsed.contacts.some((c) => c.name === old.thermal.thermode)) {
    out.thermal.thermode = old.thermal.thermode;
  }
  for (const g of names) {
    if (old.workfunction && old.workfunction[g] !== undefined) {
      out.workfunction[g] = old.workfunction[g];
    }
  }
  return out;
}

function sdevRenderArch() {
  const el = $('#sdev-arch');
  if (!el || !sdev.parsed) return;
  const p = sdev.parsed;
  const a = sdev.analysis;
  const elec = window.SDevice.classifyElectrodes(p.contacts);
  const mats = [...new Set(p.regions.map((r) => r.material))].sort();
  const rows = [];

  const row = (k, v, note) => rows.push(
    '<div class="an-row"><span class="an-label">' + escapeHtml(k) + '</span>' +
    '<span class="an-value">' + escapeHtml(String(v)) + '</span>' +
    (note ? '<span class="an-note">' + escapeHtml(note) + '</span>' : '') + '</div>');

  row('Architecture', a.architecture.name, a.architecture.confidence + ' confidence');
  row('Regions', p.regions.length);
  row('Materials', mats.length, mats.join(', '));
  row('Doping profiles', p.profiles.length, p.doping.length + ' placements');
  row('Mesh file', sdev.settings.grid,
      p.meshPrefix ? 'from the script\'s own sde:build-mesh' : 'guessed - no build-mesh found');

  for (const e of elec) {
    row(e.name, e.role + (e.device ? ' · ' + e.device.toUpperCase() + 'MOS' : ''),
        e.role === 'other' ? 'no recognised role; declared and held at 0 V' : '');
  }

  // a few geometry figures, where the analyser found them
  const want = ['Gate length L_G', 'Column 1: sheets', 'Column 1: sheet thickness T_NS',
                'Column 1: sheet width W_NS', 'EOT'];
  for (const g of a.groups) {
    for (const prm of g.params) {
      if (want.includes(prm.label)) row(prm.label, prm.value, prm.note);
    }
  }

  el.innerHTML = rows.join('');
}

/* ------------------------------------------------------------- controls */

function sdevFillControls() {
  const st = sdev.settings;
  if (!st) return;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const chk = (id, v) => { const e = document.getElementById(id); if (e) e.checked = !!v; };

  chk('ph-fermi', st.physics.fermi); chk('ph-eid', st.physics.eid);
  chk('ph-mobdop', st.physics.mobDoping); chk('ph-mobenorm', st.physics.mobEnormal);
  chk('ph-mobhf', st.physics.mobHighField);
  chk('ph-srh', st.physics.srh); chk('ph-auger', st.physics.auger);
  chk('ph-b2b', st.physics.band2band); chk('ph-aval', st.physics.avalanche);
  chk('ph-quantum', st.physics.quantum);

  chk('th-on', st.thermal.enabled);
  set('th-ambient', st.thermal.ambient);
  set('th-rsurf', st.thermal.surfaceResistance);

  // the thermal contact list is the structure's own contacts, nothing else
  const sel = $('#th-contact');
  if (sel && sdev.parsed) {
    sel.innerHTML = '<option value="">(none)</option>' +
      sdev.parsed.contacts.map((c) =>
        `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    sel.value = st.thermal.thermode || '';
  }

  set('bi-vdd', st.bias.vdd); set('bi-vdlin', st.bias.vdlin);
  set('bi-vgstart', st.bias.vgStart);
  chk('bi-idvglin', st.bias.idvgLin); chk('bi-idvgsat', st.bias.idvgSat);
  chk('bi-idvd', st.bias.idvd);

  set('ma-digits', st.math.digits); set('ma-iter', st.math.iterations);
  set('ma-notdamped', st.math.notdamped); set('ma-submethod', st.math.subMethod);

  chk('pl-field', st.plot.field); chk('pl-carriers', st.plot.carriers);
  chk('pl-mobility', st.plot.mobility); chk('pl-bands', st.plot.bands);
  chk('pl-temp', st.plot.temperature);

  set('sdev-mesh', Math.round(st.meshControl.size * 10));

  // one workfunction field per gate actually present
  const wf = $('#sdev-wf');
  if (wf) {
    const gates = Object.keys(st.workfunction);
    wf.innerHTML = gates.length
      ? '<div class="an-head" style="margin-top:10px">Gate workfunction</div>' +
        gates.map((g) =>
          '<div class="field compact"><label for="wf-' + escapeHtml(g) + '">' +
          escapeHtml(g) + '</label><div class="ctl"><input id="wf-' + escapeHtml(g) +
          '" type="number" step="0.01" value="' + st.workfunction[g] +
          '"><span class="unit">eV</span></div></div>').join('')
      : '';
    for (const g of gates) {
      const inp = document.getElementById('wf-' + g);
      if (inp) inp.addEventListener('input', sdevReadControls);
    }
  }
}

function sdevReadControls() {
  const st = sdev.settings;
  if (!st) return;
  const num = (id, d) => {
    const e = document.getElementById(id);
    const v = e ? parseFloat(e.value) : NaN;
    return Number.isFinite(v) ? v : d;
  };
  const on = (id) => { const e = document.getElementById(id); return !!(e && e.checked); };

  st.physics.fermi = on('ph-fermi'); st.physics.eid = on('ph-eid');
  st.physics.mobDoping = on('ph-mobdop'); st.physics.mobEnormal = on('ph-mobenorm');
  st.physics.mobHighField = on('ph-mobhf');
  st.physics.srh = on('ph-srh'); st.physics.auger = on('ph-auger');
  st.physics.band2band = on('ph-b2b'); st.physics.avalanche = on('ph-aval');
  st.physics.quantum = on('ph-quantum');

  st.thermal.enabled = on('th-on');
  const sel = $('#th-contact');
  st.thermal.thermode = sel && sel.value ? sel.value : null;
  st.thermal.ambient = num('th-ambient', 300);
  st.thermal.surfaceResistance = num('th-rsurf', 0);
  st.temperature = st.thermal.ambient;

  st.bias.vdd = num('bi-vdd', 0.75);
  st.bias.vdlin = num('bi-vdlin', 0.05);
  st.bias.vgStart = num('bi-vgstart', -0.3);
  st.bias.idvgLin = on('bi-idvglin'); st.bias.idvgSat = on('bi-idvgsat');
  st.bias.idvd = on('bi-idvd');

  st.math.digits = num('ma-digits', 5);
  st.math.iterations = num('ma-iter', 25);
  st.math.notdamped = num('ma-notdamped', 100);
  const sm = $('#ma-submethod'); if (sm) st.math.subMethod = sm.value;

  st.plot.field = on('pl-field'); st.plot.carriers = on('pl-carriers');
  st.plot.mobility = on('pl-mobility'); st.plot.bands = on('pl-bands');
  st.plot.temperature = on('pl-temp');

  for (const g of Object.keys(st.workfunction)) {
    st.workfunction[g] = num('wf-' + g, st.workfunction[g]);
  }

  st.meshControl.size = num('sdev-mesh', 20) / 10;
}

/* ---------------------------------------------------------------- mesh */

function sdevSyncMesh() {
  const slider = $('#sdev-mesh');
  const out = $('#sdev-mesh-val');
  if (!slider) return;
  const nm = Number(slider.value) / 10;
  if (out) out.textContent = nm.toFixed(1) + ' nm';
  if (sdev.settings) sdev.settings.meshControl.size = nm;

  const pre = $('#sdev-mesh-block');
  if (pre && sdev.parsed && window.SDevice) {
    pre.textContent = window.SDevice.buildMeshBlock(sdev.parsed, sdev.analysis, nm);
  }
}

/* ----------------------------------------------------- validate + build */

function sdevRenderReport(findings) {
  const el = $('#sdev-report');
  if (!el) return;
  el.innerHTML = findings.map((f) => {
    const mark = f.level === 'ok' ? '✓' : f.level === 'warn' ? '⚠' : '✗';
    return `<div class="sdev-line ${f.level}"><span class="mark">${mark}</span>` +
           `<span>${escapeHtml(f.message)}</span></div>`;
  }).join('');
}

function sdevValidate(quiet) {
  if (!sdev.parsed) {
    sdevRenderReport([{ level: 'error', message: 'No structure loaded. Load or paste an SCM first.' }]);
    return null;
  }
  sdevReadControls();
  const v = window.SDevice.validate(sdev.parsed, sdev.analysis, sdev.settings);
  sdevRenderReport(v.findings);
  if (!quiet) {
    const errs = v.findings.filter((f) => f.level === 'error').length;
    const warns = v.findings.filter((f) => f.level === 'warn').length;
    sdevSetStatus(errs ? 'error' : warns ? 'warn' : 'ok',
      errs ? `<strong>${errs} error(s)</strong> - fix these before generating.`
           : warns ? `<strong>Valid, with ${warns} warning(s).</strong>`
                   : '<strong>Valid.</strong> Everything checks out against the structure.');
  }
  return v;
}

function sdevRenderCode(text) {
  const pre = $('#sdev-code');
  const label = $('#sdev-lines');
  const dl = $('#sdev-download');
  if (!pre) return;
  pre.textContent = '';
  const body = String(text || '');
  if (!body.trim()) {
    if (label) label.textContent = '';
    if (dl) dl.disabled = true;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of body.replace(/\n$/, '').split('\n')) {
    const div = document.createElement('div');
    div.className = 'cl';
    div.innerHTML = sdevHighlight(line);
    frag.appendChild(div);
  }
  pre.appendChild(frag);
  if (label) {
    label.textContent = body.split('\n').length + ' lines, ' +
                        (body.length / 1024).toFixed(1) + ' kB';
  }
  if (dl) dl.disabled = false;
  sdevFind();
}

/** The only syntax this file has: comments, strings, block names, numbers. */
function sdevHighlight(line) {
  const esc = escapeHtml(line);
  if (/^\s*\*/.test(line)) return `<span class="c">${esc}</span>`;
  return esc
    .replace(/(&quot;[^&]*?&quot;)/g, '<span class="s">$1</span>')
    .replace(/\b(File|Electrode|Thermode|Physics|Plot|CurrentPlot|Math|Solve|Quasistationary|Coupled|Goal|Mobility|Recombination)\b/g,
             '<span class="k">$1</span>')
    .replace(/(?<![\w.])(-?\d+\.?\d*(?:e[+-]?\d+)?)(?![\w.])/gi, '<span class="n">$1</span>');
}

function sdevGenerate() {
  if (!sdev.parsed) {
    sdevSetStatus('error', '<strong>No structure loaded.</strong> Load or paste an SCM first.');
    sdevRenderReport([{ level: 'error', message: 'No structure loaded.' }]);
    return;
  }
  const v = sdevValidate(true);
  if (!v) return;

  if (!v.ok) {
    /* refuse rather than emit a deck that will abort, or worse, run and
       give plausible numbers for the wrong structure */
    const errs = v.findings.filter((f) => f.level === 'error');
    sdevSetStatus('error',
      `<strong>Not generated.</strong> ${errs.length} error(s) would make the ` +
      `deck invalid for this structure. See the report.`);
    sdevRenderCode('');
    sdev.cmd = '';
    return;
  }

  sdev.cmd = window.SDevice.buildSdevice(sdev.parsed, sdev.analysis, sdev.settings);
  sdevRenderCode(sdev.cmd);
  const warns = v.findings.filter((f) => f.level === 'warn').length;
  sdevSetStatus(warns ? 'warn' : 'ok',
    `<strong>Generated.</strong> ${sdev.cmd.split('\n').length} lines for ` +
    `${escapeHtml(sdev.settings.grid)}` + (warns ? `, ${warns} warning(s).` : '.'));
}

/* --------------------------------------------------------------- search */

function sdevFind() {
  const q = ($('#sdev-find') || {}).value || '';
  const pre = $('#sdev-code');
  const count = $('#sdev-find-count');
  if (!pre) return;
  pre.querySelectorAll('.hit').forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
  pre.normalize();
  if (!q) { if (count) count.textContent = ''; return; }

  let n = 0;
  const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walk.nextNode()) {
    if (walk.currentNode.nodeValue.toLowerCase().includes(q.toLowerCase())) {
      targets.push(walk.currentNode);
    }
  }
  for (const node of targets) {
    const parts = node.nodeValue.split(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'));
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.toLowerCase() === q.toLowerCase() && part) {
        const m = document.createElement('span');
        m.className = 'hit';
        m.textContent = part;
        frag.appendChild(m);
        n++;
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
    node.replaceWith(frag);
  }
  if (count) count.textContent = n ? `${n} match${n > 1 ? 'es' : ''}` : 'no match';
}

/* ----------------------------------------------------------------- boot */

function initSdevice() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  on('#btn-sdevice', 'click', sdevOpen);
  on('#sdev-close', 'click', sdevClose);
  document.addEventListener('keydown', (e) => {
    const w = $('#sdevice-window');
    if (e.key === 'Escape' && w && !w.hidden) sdevClose();
  });

  on('#sdev-use-current', 'click', () => {
    if (!app.lastScm) {
      sdevSetStatus('error', '<strong>Nothing generated yet.</strong> Press Generate SCM first.');
      return;
    }
    $('#sdev-paste').value = app.lastScm;
    sdevLoad(app.lastScm, 'the generated SCM');
  });

  on('#sdev-choose-file', 'click', () => {
    const f = $('#sdev-file');
    if (f) { f.value = ''; f.click(); }
  });
  on('#sdev-file', 'change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      $('#sdev-paste').value = String(r.result || '');
      sdevLoad(String(r.result || ''), file.name);
    };
    r.onerror = () => sdevSetStatus('error', 'Could not read that file.');
    r.readAsText(file);
  });

  on('#sdev-analyze', 'click', () => {
    const t = $('#sdev-paste');
    sdevLoad(t ? t.value : '', 'pasted text');
  });

  on('#sdev-validate', 'click', () => sdevValidate(false));
  on('#sdev-generate', 'click', sdevGenerate);
  on('#sdev-regen', 'click', sdevGenerate);

  on('#sdev-reset', 'click', () => {
    if (!sdev.parsed) return;
    sdev.settings = window.SDevice.defaultSettings(sdev.parsed, sdev.analysis);
    sdevFillControls();
    sdevSyncMesh();
    sdevGenerate();
    sdevSetStatus('ok', '<strong>Settings reset</strong> to the defaults for this structure.');
  });

  on('#sdev-mesh', 'input', sdevSyncMesh);
  on('#sdev-mesh-copy', 'click', () => {
    const t = ($('#sdev-mesh-block') || {}).textContent || '';
    if (!t.trim()) return;
    navigator.clipboard.writeText(t)
      .then(() => sdevSetStatus('ok', '<strong>Refinement block copied.</strong> Paste it into the SCM before sde:build-mesh.'))
      .catch(() => sdevSetStatus('warn', 'Clipboard blocked by the browser.'));
  });

  on('#sdev-copy', 'click', () => {
    if (!sdev.cmd) return;
    navigator.clipboard.writeText(sdev.cmd)
      .then(() => sdevSetStatus('ok', `<strong>Copied</strong> ${sdev.cmd.split('\n').length} lines.`))
      .catch(() => sdevSetStatus('warn', 'Clipboard blocked by the browser; use Download.'));
  });

  on('#sdev-download', 'click', () => {
    if (!sdev.cmd) return;
    downloadText('sdevice.cmd', sdev.cmd);
    sdevSetStatus('ok', '<strong>Downloaded sdevice.cmd.</strong>');
  });

  on('#sdev-find', 'input', sdevFind);

  on('#sdev-editable', 'change', (e) => {
    const pre = $('#sdev-code');
    if (!pre) return;
    pre.contentEditable = e.target.checked ? 'true' : 'false';
    if (e.target.checked) {
      sdevSetStatus('warn',
        '<strong>Editing by hand.</strong> Regenerate will discard your edits.');
    } else {
      // take the edited text back, so Copy and Download carry it
      sdev.cmd = [...pre.querySelectorAll('.cl')].map((d) => d.textContent).join('\n');
      sdevRenderCode(sdev.cmd);
    }
  });

  // any control change refreshes the settings; the deck is regenerated on
  // demand rather than on every keystroke, so a half-typed number never
  // produces a half-valid file
  const w = $('#sdevice-window');
  if (w) {
    w.addEventListener('change', (e) => {
      if (e.target.closest('#sdev-config')) sdevReadControls();
    });
  }

  $$('#sdevice-window .section-head:not(.static)').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });
}
