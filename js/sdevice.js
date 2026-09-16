/* ==========================================================================
   js/sdevice.js
   --------------------------------------------------------------------------
   Writes a Sentaurus Device command file for whatever structure was loaded.

   The SCM is the source of truth. Every electrode in the generated deck is
   a contact that actually exists in the parsed file, every region named in
   CurrentPlot is a region that actually exists, and the mesh filename comes
   from the file's own sde:build-mesh call. Nothing here is a template with
   the names filled in: load a seven-contact structure and you get seven
   electrodes, load an eight-contact one and you get eight.

   That distinction is not cosmetic. A deck that declares an electrode the
   mesh does not have makes SDevice abort; a deck that silently omits one
   the mesh does have leaves that region floating, which is a physics bug
   that still converges and still produces plausible-looking curves.

   Style follows the reference deck: plain Sentaurus syntax, explicit
   numbers, no macros or intermediate definitions. A command file is read
   and edited by hand far more often than it is generated.

   Loaded as a classic script; exposes window.SDevice.
   ========================================================================== */

'use strict';

(function () {

  /* ==================================================================
     1. ELECTRODE ROLES
     ==================================================================
     Contact names carry their role and their device, but not in one
     fixed convention: source_n, n_source, nSource and SOURCE_N all turn
     up. Matching on the parts rather than on a whole name means an
     unfamiliar file still classifies, and anything genuinely unknown is
     reported as such rather than guessed at.
     ================================================================== */

  function classifyElectrode(name) {
    const s = String(name);
    const low = s.toLowerCase();

    let role = 'other';
    if (/gate/.test(low)) role = 'gate';
    else if (/source/.test(low)) role = 'source';
    else if (/drain/.test(low)) role = 'drain';
    else if (/well|body|tub/.test(low)) role = 'well';
    else if (/sub|bulk|back/.test(low)) role = 'bulk';

    /* device tag: a leading or trailing n/p that is not part of a word */
    let device = null;
    if (/(^|[^a-z])n($|[^a-z])/.test(low) || /_n$|^n_/.test(low)) device = 'n';
    if (/(^|[^a-z])p($|[^a-z])/.test(low) || /_p$|^p_/.test(low)) device = 'p';
    if (/nmos|nfet/.test(low)) device = 'n';
    if (/pmos|pfet/.test(low)) device = 'p';
    if (role === 'well' && /nwell|n_well|welln|well_n/.test(low)) device = 'p'; // an n-well is the pFET body
    if (role === 'bulk') device = null;

    return { name: s, role, device };
  }

  function classifyElectrodes(contacts) {
    return (contacts || []).map((c) => classifyElectrode(c.name));
  }

  /** Group the classified electrodes into the devices they belong to. */
  function devicesOf(elec) {
    const tags = [...new Set(elec.filter((e) => e.device).map((e) => e.device))].sort();
    return tags.map((tag) => ({
      tag,
      gate: elec.find((e) => e.device === tag && e.role === 'gate'),
      source: elec.find((e) => e.device === tag && e.role === 'source'),
      drain: elec.find((e) => e.device === tag && e.role === 'drain'),
      well: elec.find((e) => e.device === tag && e.role === 'well'),
    })).filter((d) => d.gate && d.source && d.drain);
  }


  /* ==================================================================
     2. DEFAULTS
     ================================================================== */

  function defaultSettings(parsed, analysis) {
    const elec = classifyElectrodes(parsed.contacts);
    const devs = devicesOf(elec);
    const bulk = elec.find((e) => e.role === 'bulk');

    const wf = {};
    for (const d of devs) {
      // an undoped, fully depleted body wants both metals near midgap
      wf[d.gate.name] = d.tag === 'p' ? 4.73 : 4.49;
    }

    return {
      stem: parsed.meshPrefix || 'device',
      /* the grid FILE, not the mesh-size control below - these were both
         called `mesh` and the object literal silently kept the last one,
         so every deck came out with Grid = "[object Object]" */
      grid: parsed.meshPrefix ? parsed.meshPrefix + '_msh.tdr' : 'device_msh.tdr',

      workfunction: wf,
      temperature: 300,

      physics: {
        fermi: true,
        eid: true,                 // EffectiveIntrinsicDensity(OldSlotboom)
        mobDoping: true,
        mobEnormal: true,
        mobHighField: true,
        srh: true,
        auger: true,
        band2band: false,
        avalanche: false,
        quantum: false,
        bandgapNarrowing: 'Slotboom',   // '' turns it off
        surfaceSRH: false,              // interface recombination at the gate oxide
        tunneling: '',                  // '' | 'NonlocalPath' | 'Schenk'
      },

      thermal: {
        enabled: true,
        thermode: bulk ? bulk.name : null,
        ambient: 300,
        surfaceResistance: 0,
        latticeInit: 300,          // initial lattice temperature
        heatFlux: true,            // write the heat-flux output variables
      },

      bias: {
        vdd: 0.75,
        vdlin: 0.05,
        vgStart: -0.30,            // start below Vt so Ioff and SS are in range
        vgStep: 0.02,
        vdStep: 0.02,
        idvd: true,
        idvgLin: true,
        idvgSat: true,
        /* Starting potentials per electrode, keyed by the name that is
           actually in the SCM - never a hard-coded "source"/"drain". */
        initial: Object.fromEntries(elec.map((e) => [e.name, 0])),
        sweepQuantity: 'voltage',  // voltage | current
        analysis: 'quasistationary', // quasistationary | transient
        transientEnd: 1e-9,
        transientStep: 1e-12,
      },

      math: {
        digits: 5,
        iterations: 25,
        notdamped: 100,
        extrapolate: true,
        derivatives: true,
        relErrControl: true,
        method: 'Blocked',
        subMethod: 'ParDiSo',
        initialGuess: 'zero',      // zero | previous
      },

      plot: {
        potential: true, field: true, carriers: true, doping: true,
        current: true, mobility: true, bands: true, recombination: true,
        temperature: true,
      },

      output: {
        currentPlot: true,         // the CurrentPlot / .plt log
        extraction: true,          // the extraction notes at the foot
      },

      meshControl: { size: 2.0 },  // nm, for the SCM refinement block
    };
  }


  /* ==================================================================
     3. VALIDATION
     ==================================================================
     Run before anything is generated. A finding that would make the deck
     wrong is an error and blocks generation; anything that only limits
     what can be extracted is a warning.
     ================================================================== */

  function validate(parsed, analysis, st) {
    const out = [];
    const ok = (m) => out.push({ level: 'ok', message: m });
    const warn = (m) => out.push({ level: 'warn', message: m });
    const err = (m) => out.push({ level: 'error', message: m });

    const regions = parsed.regions || [];
    const contacts = parsed.contacts || [];
    const elec = classifyElectrodes(contacts);
    const devs = devicesOf(elec);

    /* ---- structure ---- */
    if (!regions.length) err('No regions found - the SCM did not yield any geometry.');
    else ok(`${regions.length} regions detected`);

    const mats = [...new Set(regions.map((r) => r.material))];
    if (!mats.length) err('No materials found.');
    else ok(`${mats.length} materials detected: ${mats.join(', ')}`);

    const semi = regions.filter((r) => /^(silicon|germanium|sige)$/i.test(r.material));
    if (!semi.length) err('No semiconductor region - SDevice has nothing to solve in.');
    else ok(`${semi.length} semiconductor regions`);

    if (!contacts.length) {
      err('No contacts defined - a device with no electrodes cannot be biased.');
    } else {
      ok(`${contacts.length} contacts detected: ${contacts.map((c) => c.name).join(', ')}`);
    }

    /* every contact must actually land on a region, or the mesh will not
       carry it and SDevice will abort on the Electrode block */
    for (const c of contacts) {
      const pts = (c.faces || []).filter(Boolean);
      if (!pts.length) {
        warn(`Contact "${c.name}" is declared but never placed on a face - ` +
             `it may not exist in the mesh.`);
        continue;
      }
      const landed = pts.some((p) => regions.some((r) =>
        p.x >= r.x0 - 1e-9 && p.x <= r.x1 + 1e-9 &&
        p.y >= r.y0 - 1e-9 && p.y <= r.y1 + 1e-9 &&
        p.z >= r.z0 - 1e-9 && p.z <= r.z1 + 1e-9));
      if (!landed) {
        err(`Contact "${c.name}" picks a point that is not on any region - ` +
            `the electrode will be missing from the mesh.`);
      }
    }

    /* ---- per-device completeness ---- */
    if (!devs.length) {
      const roles = elec.map((e) => `${e.name}:${e.role}`).join(', ');
      err('No complete device found. A device needs a gate, a source and a ' +
          `drain that share an n/p tag. Detected roles: ${roles || 'none'}.`);
    }
    for (const d of devs) {
      ok(`${d.tag.toUpperCase()}MOS complete: gate "${d.gate.name}", ` +
         `source "${d.source.name}", drain "${d.drain.name}"`);
    }

    /* an electrode with no obvious role is not an error, but the deck
       will leave it at 0 V and the user should know that */
    for (const e of elec) {
      if (e.role === 'other') {
        warn(`Electrode "${e.name}" has no recognised role - it is declared ` +
             `and held at 0 V, but nothing sweeps it.`);
      }
    }

    /* a body region with no electrode floats: converges, wrong answer */
    for (const d of devs) {
      if (d.tag !== 'p') continue;
      if (!d.well) {
        warn(`No well or body electrode for the PMOS. If its source/drain sit ` +
             `on a well region with no contact, that body floats and the ` +
             `parasitic bipolar can swamp the channel current.`);
      } else {
        ok(`PMOS body electrode "${d.well.name}" present`);
      }
    }

    /* ---- mesh ---- */
    if (!parsed.meshPrefix) {
      warn('No sde:build-mesh call found - the Grid filename is a guess. ' +
           'Check the File block before running.');
    } else {
      ok(`Grid file: ${st.grid}`);
    }

    /* ---- thermal ---- */
    if (st.thermal.enabled) {
      if (!st.thermal.thermode) {
        err('Self-heating is enabled but no thermal contact is selected. ' +
            'A Thermodynamic run with no Thermode has no heat sink: the ' +
            'device heats without limit and the solve will not converge.');
      } else if (!contacts.some((c) => c.name === st.thermal.thermode)) {
        err(`Thermal contact "${st.thermal.thermode}" is not one of the ` +
            `contacts in this structure.`);
      } else {
        ok(`Thermal contact: "${st.thermal.thermode}" at ${st.thermal.ambient} K`);
      }
    } else {
      ok('Self-heating disabled - isothermal solve');
    }

    /* ---- bias ---- */
    for (const d of devs) {
      for (const e of [d.gate, d.source, d.drain]) {
        if (!contacts.some((c) => c.name === e.name)) {
          err(`Bias references electrode "${e.name}", which is not in the structure.`);
        }
      }
    }
    if (!(st.bias.vdd > 0)) err('Supply voltage must be positive.');

    /* ---- output / extraction ---- */
    const wanted = currentPlotRegions(regions, devs);
    for (const rname of wanted) {
      if (!regions.some((r) => r.name === rname)) {
        err(`CurrentPlot references region "${rname}", which does not exist.`);
      }
    }
    if (wanted.length) ok(`Per-region temperature output: ${wanted.join(', ')}`);
    else if (st.thermal.enabled) {
      warn('No drain or channel region matched for per-region temperature; ' +
           'only the global maximum will be written.');
    }

    return { findings: out, ok: !out.some((f) => f.level === 'error'), electrodes: elec, devices: devs };
  }

  /** Regions worth a per-device temperature column: the drain and the hottest channel. */
  function currentPlotRegions(regions, devs) {
    const picked = [];
    for (const d of devs) {
      const drain = regions.find((r) =>
        new RegExp(`^${d.tag}_?drain$`, 'i').test(r.name));
      if (drain) picked.push(drain.name);
      // the topmost channel segment is the furthest from the heat sink
      const chans = regions.filter((r) =>
        new RegExp(`^${d.tag}_`, 'i').test(r.name) && /chan/i.test(r.name));
      if (chans.length) {
        picked.push(chans.slice().sort((a, b) => b.y1 - a.y1)[0].name);
      }
    }
    return picked;
  }


  /* ==================================================================
     4. THE COMMAND FILE
     ================================================================== */

  const f = (v, d) => Number(v).toFixed(d === undefined ? 2 : d);

  function buildSdevice(parsed, analysis, st) {
    const regions = parsed.regions || [];
    const elec = classifyElectrodes(parsed.contacts);
    const devs = devicesOf(elec);
    const L = [];
    const P = (...xs) => L.push(...xs);

    /* ---------------- header ---------------- */
    const mats = [...new Set(regions.map((r) => r.material))].sort();
    P('*  sdevice.cmd  --  generated from ' + st.grid);
    P(`*  ${regions.length} regions  |  ${mats.join(', ')}`);
    P(`*  ${elec.length} electrodes: ${elec.map((e) => e.name).join(', ')}`);
    if (analysis && analysis.architecture) P(`*  ${analysis.architecture.name}`);
    P('*  Regenerate this file if the mesh is rebuilt from a different structure.');
    P('');

    /* ---------------- File ---------------- */
    P('File {');
    P(`    Grid    = "${st.grid}"`);
    P(`    Plot    = "${st.stem}_des.tdr"`);
    P(`    Current = "${st.stem}_des.plt"`);
    P(`    Output  = "${st.stem}_des.log"`);
    P('}');
    P('');

    /* ---------------- Electrode ---------------- */
    P('*  Every contact in the mesh must appear here or SDevice aborts.');
    P('Electrode {');
    for (const e of elec) {
      const wf = st.workfunction[e.name];
      const tag = e.role === 'other' ? '' : `   * ${e.role}${e.device ? ' (' + e.device + ')' : ''}`;
      P(`    { Name="${e.name}"` + ' '.repeat(Math.max(1, 12 - e.name.length)) +
        `Voltage=0.0` + (wf !== undefined ? `  Workfunction=${f(wf)}` : '') + ' }' + tag);
    }
    P('}');
    P('');

    /* ---------------- Thermode ---------------- */
    if (st.thermal.enabled && st.thermal.thermode) {
      P('*  Single heat sink; every other contact stays adiabatic.');
      P('Thermode {');
      P(`    { Name = "${st.thermal.thermode}"  Temperature = ${st.thermal.ambient}` +
        `  SurfaceResistance = ${Number(st.thermal.surfaceResistance).toFixed(1)} }`);
      P('}');
      P('');
    }

    /* ---------------- Physics ---------------- */
    const ph = st.physics;
    P('Physics {');
    P(`    Temperature = ${st.temperature}`);
    if (ph.fermi) P('    Fermi');
    if (ph.eid) P('    EffectiveIntrinsicDensity( OldSlotboom )');
    if (ph.bandgapNarrowing) P(`    EffectiveIntrinsicDensity( BandGapNarrowing( ${ph.bandgapNarrowing} ) )`);
    const mob = [];
    if (ph.mobDoping) mob.push('DopingDependence');
    if (ph.mobEnormal) mob.push('Enormal');
    if (ph.mobHighField) mob.push('HighFieldSaturation');
    if (mob.length) {
      P('    Mobility(');
      for (const m of mob) P(`        ${m}`);
      P('    )');
    }
    const rec = [];
    if (ph.srh) rec.push('SRH( DopingDependence )');
    if (ph.auger) rec.push('Auger');
    if (ph.band2band) rec.push('Band2Band( Model = Hurkx )');
    if (ph.avalanche) rec.push('Avalanche( vanOverstraeten )');
    if (ph.surfaceSRH) rec.push('SurfaceSRH');
    if (rec.length) {
      P('    Recombination(');
      for (const r of rec) P(`        ${r}`);
      P('    )');
    }
    if (ph.tunneling) P(`    eBarrierTunneling( ${ph.tunneling} )  hBarrierTunneling( ${ph.tunneling} )`);
    if (ph.quantum) P('    eQuantumPotential  hQuantumPotential');
    if (st.thermal.enabled) {
      P('    Thermodynamic');
      P(`    LatticeTemperature = ${st.thermal.latticeInit}`);
    }
    P('}');
    P('');

    /* ---------------- Plot ---------------- */
    const pl = st.plot;
    P('Plot {');
    if (pl.potential) P('    Potential\n    SpaceCharge');
    if (pl.field) P('    ElectricField/Vector');
    if (pl.carriers) P('    eDensity\n    hDensity\n    eQuasiFermiEnergy\n    hQuasiFermiEnergy');
    if (pl.doping) P('    Doping\n    DonorConcentration\n    AcceptorConcentration');
    if (pl.current) P('    Current/Vector\n    eCurrent/Vector\n    hCurrent/Vector');
    if (pl.mobility) P('    eMobility\n    hMobility\n    eVelocity\n    hVelocity');
    if (pl.bands) P('    BandGap\n    ConductionBandEnergy\n    ValenceBandEnergy');
    if (pl.recombination) P('    SRHRecombination');
    if (pl.temperature && st.thermal.enabled) {
      P('    LatticeTemperature\n    TotalHeat\n    ThermalConductivity\n    LatticeHeatFlux/Vector');
    }
    P('}');
    P('');

    /* ---------------- CurrentPlot ---------------- */
    if (st.output.currentPlot) {
      const rows = [];
      if (st.thermal.enabled) {
        rows.push('    LatticeTemperature( Maximum( Material = "Silicon" )');
        rows.push('                        Average( Material = "Silicon" ) )');
        for (const rname of currentPlotRegions(regions, devs)) {
          rows.push(`    LatticeTemperature( Maximum( Region = "${rname}" ) )`);
        }
        if (st.thermal.heatFlux) {
          rows.push('    TotalHeat( Integrate( Material = "Silicon" ) )');
        }
      }
      /* Without self-heating there is nothing thermal to log, but the .plt
         is still worth writing: it is where the I-V curves come from. */
      if (rows.length) {
        P('CurrentPlot {');
        for (const r of rows) P(r);
        P('}');
        P('');
      }
    }

    /* ---------------- Math ---------------- */
    const m = st.math;
    P('Math {');
    if (m.extrapolate) P('    Extrapolate');
    if (m.derivatives) P('    Derivatives');
    if (m.relErrControl) P('    RelErrControl');
    P(`    Digits            = ${m.digits}`);
    P('    ErRef( electron ) = 1.0e10');
    P('    ErRef( hole )     = 1.0e10');
    P(`    Iterations        = ${m.iterations}`);
    P(`    Notdamped         = ${m.notdamped}`);
    P(`    Method    = ${m.method}`);
    P(`    SubMethod = ${m.subMethod}`);
    P('    ExitOnFailure');
    P('}');
    P('');

    /* ---------------- Solve ---------------- */
    P(...solveBlock(st, devs));

    /* ---------------- extraction notes ---------------- */
    if (st.output.extraction) {
      P('');
      P(...extractionNotes(st, devs));
    }

    return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  /** The carrier set each Coupled step solves for. */
  function coupledSet(st) {
    return st.thermal.enabled
      ? 'Coupled { Poisson Electron Hole Temperature }'
      : 'Coupled { Poisson Electron Hole }';
  }

  function ramp(goalName, voltage, st, indent) {
    const i = indent || '    ';
    return [
      `${i}Quasistationary(`,
      `${i}    InitialStep = 0.05  Increment = 1.3`,
      `${i}    MinStep = 1.0e-5    MaxStep = 0.1`,
      `${i}    Goal { Name = "${goalName}"  Voltage = ${voltage} }`,
      `${i}){ ${coupledSet(st)} }`,
      '',
    ];
  }

  function sweep(goalName, voltage, st, indent) {
    const i = indent || '    ';
    const step = (st.bias && st.bias.vgStep) || 0.02;
    return [
      `${i}Quasistationary(`,
      `${i}    InitialStep = ${step}  Increment = 1.2`,
      `${i}    MinStep = 1.0e-6    MaxStep = ${step}`,
      `${i}    Goal { Name = "${goalName}"  Voltage = ${voltage} }`,
      `${i}){ ${coupledSet(st)} }`,
      '',
    ];
  }

  function solveBlock(st, devs) {
    const L = [];
    const b = st.bias;

    L.push('Solve {');
    L.push('');
    L.push('*   ---- equilibrium ----');
    L.push('    NewCurrentPrefix = "init_"');
    /* Any electrode the user gave a non-zero starting potential is ramped
       to it before equilibrium. The names come from the SCM, so this works
       for whatever electrodes the structure actually declares. */
    for (const [name, v] of Object.entries(b.initial || {})) {
      if (!v) continue;
      L.push(`    Set( "${name}" = ${Number(v).toFixed(3)} )`);
    }
    L.push('    Coupled( Iterations = 100 ) { Poisson }');
    L.push('    Coupled                    { Poisson Electron Hole }');
    if (st.thermal.enabled) {
      L.push('    Coupled                    { Poisson Electron Hole Temperature }');
    }
    L.push('');

    for (const d of devs) {
      /* PMOS biases are negative; the sign is physics, not a label */
      const sgn = d.tag === 'p' ? -1 : 1;
      const vdd = (sgn * b.vdd).toFixed(2);
      const vlin = (sgn * b.vdlin).toFixed(2);
      const vg0 = (sgn * b.vgStart).toFixed(2);
      const T = d.tag;

      L.push(`*   ================= ${T.toUpperCase()}MOS =================`);
      L.push(`*   source "${d.source.name}" stays at 0 V.` +
             (d.well ? `  Body "${d.well.name}" is held at the source potential,` : ''));
      if (d.well) L.push('*   which is what an n-well tap does in a real layout.');
      L.push('');

      if (b.idvgLin) {
        L.push(`    NewCurrentPrefix = "${T}_pre_lin_"`);
        L.push(...ramp(d.drain.name, vlin, st));
        L.push(...ramp(d.gate.name, vg0, st));
        L.push(`    NewCurrentPrefix = "${T}_idvg_lin_"`);
        L.push(...sweep(d.gate.name, vdd, st));
      }

      if (b.idvgSat) {
        L.push(`    NewCurrentPrefix = "${T}_pre_sat_"`);
        L.push(...ramp(d.gate.name, vg0, st));
        L.push(...ramp(d.drain.name, vdd, st));
        L.push(`    NewCurrentPrefix = "${T}_idvg_sat_"`);
        L.push(...sweep(d.gate.name, vdd, st));
        L.push(`    Plot( FilePrefix = "${T}_final" NoOverwrite )`);
        L.push('');
      }

      if (b.idvd) {
        L.push(`    NewCurrentPrefix = "${T}_pre_vd_"`);
        L.push(...ramp(d.drain.name, '0.0', st));
        L.push(`    NewCurrentPrefix = "${T}_idvd_"`);
        L.push(...sweep(d.drain.name, vdd, st));
      }

      /* return to zero so the next device starts from the same clean state */
      L.push(`*   ---- return ${T.toUpperCase()}MOS to zero ----`);
      L.push(`    NewCurrentPrefix = "${T}_reset_"`);
      L.push(...ramp(d.gate.name, '0.0', st));
      L.push(...ramp(d.drain.name, '0.0', st));
    }

    L.push('}');
    return L;
  }

  /**
   * Only the two notes that stop a wrong number being reported: the drain
   * current sign, and what Rth does and does not mean here. Everything else
   * an engineer can read off the deck itself.
   */
  function extractionNotes(st, devs) {
    const L = [];
    L.push('*  SDevice reports current INTO a contact as positive, so the two');
    L.push('*  device types have opposite drain current signs:');
    for (const d of devs) {
      L.push(`*     ID_${d.tag} = ${d.tag === 'p' ? '-' : ' '}I(${d.drain.name})` +
             (d.tag === 'p' ? '   a positive I(drain) here means the body is floating' : ''));
    }
    if (st.thermal.enabled) {
      L.push('*');
      L.push('*  Rth = dT / (ID x VDS). With adiabatic side walls it grows with the');
      L.push('*  domain depth and does not converge, so it is a property of the');
      L.push('*  domain as much as the device. Compare two devices on the same');
      L.push('*  domain; do not quote it as an absolute.');
    }
    return L;
  }


  /* ==================================================================
     5. MESH REFINEMENT BLOCK
     ==================================================================
     Mesh refinement is defined in the SDE script, not in sdevice.cmd -
     by the time SDevice runs, the mesh is already a .tdr file. So the
     slider writes SCM commands, to be pasted in before meshing, rather
     than pretending to change something the command file controls.
     ================================================================== */

  function buildMeshBlock(parsed, analysis, sizeNm) {
    const um = Math.max(0.0002, sizeNm / 1000);
    const regions = parsed.regions || [];
    if (!regions.length) return '';

    const b = window.SDEAnalyze ? window.SDEAnalyze.boundsOf(regions) : null;
    if (!b) return '';

    const fine = um;                 // at the features that matter
    const coarse = um * 8;           // in the bulk, where nothing is thin
    const mid = um * 3;
    const q = (v) => Number(v.toPrecision(3));
    const pos = (x, y, z) => `(position ${Number(x.toPrecision(6))} ` +
                             `${Number(y.toPrecision(6))} ${Number(z.toPrecision(6))})`;

    const L = [];
    L.push(';; ---- mesh refinement, generated for the loaded structure ----');
    L.push(`;;  target element size ${sizeNm} nm at the active regions.`);
    L.push(';;  Paste into the SCM before (sde:build-mesh ...).');
    L.push('');
    L.push(`(sdedr:define-refinement-size "RS_global" ${q(coarse)} ${q(coarse)} ${q(coarse)} ` +
           `${q(mid)} ${q(mid)} ${q(mid)})`);
    L.push(`(sdedr:define-refinement-window "RW_global" "Cuboid" ` +
           `${pos(b.x0, b.y0, b.z0)} ${pos(b.x1, b.y1, b.z1)})`);
    L.push('(sdedr:define-refinement-placement "RP_global" "RS_global" "RW_global")');
    L.push('');

    /* the active band: everything above the substrate top */
    const above = regions.filter((r) => r.y1 > 1e-9 && r.y0 >= -1e-9);
    if (above.length) {
      const a = window.SDEAnalyze.boundsOf(above);
      L.push(`(sdedr:define-refinement-size "RS_active" ${q(mid)} ${q(fine)} ${q(mid)} ` +
             `${q(fine)} ${q(fine / 2)} ${q(fine)})`);
      L.push(`(sdedr:define-refinement-window "RW_active" "Cuboid" ` +
             `${pos(a.x0, a.y0, a.z0)} ${pos(a.x1, a.y1, a.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_active" "RS_active" "RW_active")');
      L.push('');
    }

    /* the gate dielectric is the thinnest thing in the structure, so it
       sets the Y minimum; X and Z stay coarse because nothing is thin there */
    const diel = regions.filter((r) => /hfo2|sio2|al2o3|zro2/i.test(r.material));
    if (diel.length) {
      const thin = Math.min(...diel.map((r) =>
        Math.min(r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0)));
      const dy = Math.max(0.0002, Math.min(fine / 2, thin / 3));
      const d = window.SDEAnalyze.boundsOf(diel);
      L.push(`;;  thinnest dielectric is ${Number((thin * 1000).toPrecision(3))} nm, so Y is resolved to ${Number((dy * 1000).toPrecision(3))} nm`);
      L.push(`(sdedr:define-refinement-size "RS_diel" ${q(mid)} ${q(dy * 2)} ${q(mid)} ` +
             `${q(fine)} ${q(dy)} ${q(fine)})`);
      L.push(`(sdedr:define-refinement-window "RW_diel" "Cuboid" ` +
             `${pos(d.x0, d.y0, d.z0)} ${pos(d.x1, d.y1, d.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_diel" "RS_diel" "RW_diel")');
      L.push('');
    }

    /* the deep substrate carries heat, not current: coarse is fine */
    const below = regions.filter((r) => r.y0 < -1e-9);
    if (below.length) {
      const s = window.SDEAnalyze.boundsOf(below);
      L.push(`(sdedr:define-refinement-size "RS_sub" ${q(coarse * 1.5)} ${q(coarse * 1.5)} ` +
             `${q(coarse * 1.5)} ${q(mid)} ${q(mid)} ${q(mid)})`);
      L.push(`(sdedr:define-refinement-window "RW_sub" "Cuboid" ` +
             `${pos(s.x0, s.y0, s.z0)} ${pos(s.x1, s.y1, s.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_sub" "RS_sub" "RW_sub")');
    }

    return L.join('\n') + '\n';
  }


  window.SDevice = {
    classifyElectrodes, devicesOf, defaultSettings,
    validate, buildSdevice, buildMeshBlock, currentPlotRegions,
  };

})();
