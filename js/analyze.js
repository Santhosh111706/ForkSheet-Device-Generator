/* ==========================================================================
   js/analyze.js
   --------------------------------------------------------------------------
   Structure analysis for a loaded SDE/SCM file.

   window.SDE.parse() turns a script into a list of cuboids. That is a pile
   of coordinates; it is not a device. This file turns it back into one: it
   works out which architecture it is looking at, then measures the design
   parameters an engineer would actually ask about - gate length, sheet
   pitch, collar thickness, junction planes, doping, contacts - and says
   which regions each figure came from, so no number is unexplainable.

   Two independent halves:

     analyze(parsed)          what the structure IS
     check(regions, contacts) whether it is SELF-CONSISTENT

   check() is deliberately generic. generator.js already has validate(),
   which knows the Forksheet rules and is much sharper for that one
   architecture; this one knows nothing about any architecture and so runs
   on anything, including a file this app did not produce.

   Loaded as a classic script; exposes window.SDEAnalyze.
   ========================================================================== */

'use strict';

(function () {

  /* Coordinates are micrometres. Two faces within a picometre are the same
     face: that is far below any real process dimension, but comfortably
     above the rounding in a 6-decimal SCM literal. */
  const TOL = 1e-9;

  const eq = (a, b) => Math.abs(a - b) < TOL;
  const span = (r, ax) => r[ax + '1'] - r[ax + '0'];
  const uniq = (xs) => [...new Set(xs)];
  const round = (v, p) => Number(Number(v).toPrecision(p === undefined ? 6 : p));

  /** micrometres to a readable nanometre string. */
  function nm(v) {
    if (!Number.isFinite(v)) return '-';
    return (v * 1000).toFixed(v * 1000 < 10 ? 2 : 1) + ' nm';
  }
  function um(v) {
    if (!Number.isFinite(v)) return '-';
    return round(v) + ' µm';
  }

  /* ==================================================================
     Overlap / adjacency primitives
     ================================================================== */

  /** Volume shared by two boxes. Zero when they only touch on a face. */
  function overlapVolume(a, b) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (ox <= TOL || oy <= TOL || oz <= TOL) return 0;
    return ox * oy * oz;
  }

  /** True when the two boxes share a face of non-zero area. */
  function touches(a, b) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (ox < -TOL || oy < -TOL || oz < -TOL) return false;
    const flat = [Math.abs(ox) < TOL, Math.abs(oy) < TOL, Math.abs(oz) < TOL];
    const flatCount = flat.filter(Boolean).length;
    if (flatCount !== 1) return false;            // edge or corner contact only
    return ox > -TOL && oy > -TOL && oz > -TOL;
  }

  /** Smallest axis gap between two boxes; 0 if they touch or overlap. */
  function gapBetween(a, b) {
    const g = (lo1, hi1, lo2, hi2) => Math.max(lo1 - hi2, lo2 - hi1, 0);
    const gx = g(a.x0, a.x1, b.x0, b.x1);
    const gy = g(a.y0, a.y1, b.y0, b.y1);
    const gz = g(a.z0, a.z1, b.z0, b.z1);
    return Math.max(gx, gy, gz);
  }

  const contains = (r, p) =>
    p.x >= r.x0 - TOL && p.x <= r.x1 + TOL &&
    p.y >= r.y0 - TOL && p.y <= r.y1 + TOL &&
    p.z >= r.z0 - TOL && p.z <= r.z1 + TOL;


  /* ==================================================================
     CONSISTENCY CHECK
     ================================================================== */

  /**
   * Geometric self-consistency of an arbitrary region list.
   *
   * Categories reported: overlap, gap, disconnected, contact, degenerate.
   * Everything is a measurement, never a guess about intent - a "gap" is
   * only reported between regions that are nearly touching, because two
   * regions genuinely far apart are not a defect.
   */
  function check(regions, contacts) {
    const issues = [];
    /* `regions` is the list of region names a finding refers to. The viewer
       uses it to outline them, which is what turns "these two overlap" from
       a sentence into something you can look at. */
    const add = (kind, severity, message, names) =>
      issues.push({ kind, severity, message, regions: names || [] });

    if (!regions || !regions.length) {
      add('degenerate', 'error', 'The structure contains no regions.');
      return { issues, ok: false, counts: tally(issues) };
    }

    /* ---- degenerate boxes ---- */
    for (const r of regions) {
      for (const ax of ['x', 'y', 'z']) {
        const s = span(r, ax);
        if (s <= TOL) {
          add('degenerate', 'error',
            `Region "${r.name}" has zero or negative ${ax.toUpperCase()} extent (${round(s)}).`,
            [r.name]);
        }
      }
    }

    /* ---- overlaps ---- */
    const overlaps = [];
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const v = overlapVolume(regions[i], regions[j]);
        if (v > TOL) overlaps.push([regions[i], regions[j], v]);
      }
    }
    overlaps.sort((a, b) => b[2] - a[2]);
    for (const [a, b, v] of overlaps.slice(0, 20)) {
      add('overlap', 'error',
        `"${a.name}" and "${b.name}" share ${round(v, 3)} µm³ of volume.`,
        [a.name, b.name]);
    }
    if (overlaps.length > 20) {
      add('overlap', 'error', `...and ${overlaps.length - 20} further overlapping pairs.`);
    }

    /* ---- connectivity ---- */
    const adj = regions.map(() => []);
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (touches(regions[i], regions[j]) || overlapVolume(regions[i], regions[j]) > TOL) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }
    const seen = new Array(regions.length).fill(false);
    const islands = [];
    for (let s = 0; s < regions.length; s++) {
      if (seen[s]) continue;
      const stack = [s];
      const group = [];
      seen[s] = true;
      while (stack.length) {
        const k = stack.pop();
        group.push(k);
        for (const nb of adj[k]) if (!seen[nb]) { seen[nb] = true; stack.push(nb); }
      }
      islands.push(group);
    }
    islands.sort((a, b) => b.length - a.length);
    if (islands.length > 1) {
      for (const g of islands.slice(1)) {
        const names = g.map((k) => regions[k].name);
        add('disconnected', 'error',
          `${names.length} region(s) touch nothing else in the structure: ` +
          names.slice(0, 6).join(', ') + (names.length > 6 ? ', ...' : '') + '.',
          names);
      }
    }

    /* ---- near misses: a gap small enough to be a mistake ----
       A pairwise test alone is useless here. In a gate-all-around stack the
       channel sits a collar-thickness away from the gate metal by design,
       and that space is filled by a third region - the high-k collar. Left
       pairwise, this fired on all 13 such pairs in a perfectly valid
       structure, which is worse than not checking at all.

       So a gap is only real if the space between the two regions is EMPTY.
       The volume between them is sampled, and if every sample lands inside
       some other region the pair is simply separated by a neighbour, not
       disconnected from it. */
    const nearGaps = [];
    const maxGap = 0.002;                 // 2 nm: below any intentional spacing here
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i], b = regions[j];
        const g = gapBetween(a, b);
        if (g <= TOL || g > maxGap) continue;
        // require real overlap on the two axes that are not the gap axis
        const oxy = [
          Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
          Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
          Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0),
        ];
        if (oxy.filter((v) => v > TOL).length < 2) continue;
        if (bridgeIsFilled(a, b, regions, i, j)) continue;
        nearGaps.push([a, b, g]);
      }
    }
    nearGaps.sort((a, b) => a[2] - b[2]);
    for (const [a, b, g] of nearGaps.slice(0, 12)) {
      add('gap', 'warn',
        `"${a.name}" and "${b.name}" are ${nm(g)} apart - too small to be deliberate spacing.`,
        [a.name, b.name]);
    }
    if (nearGaps.length > 12) {
      add('gap', 'warn', `...and ${nearGaps.length - 12} further sub-2 nm gaps.`);
    }

    /* ---- contacts ---- */
    for (const c of (contacts || [])) {
      if (!c.faces || !c.faces.length) {
        add('contact', 'warn', `Contact set "${c.name}" is declared but never placed on a face.`, []);
        continue;
      }
      c.faces.forEach((p, k) => {
        if (!p) {
          add('contact', 'warn',
            `Contact "${c.name}" placement ${k + 1} has no resolvable pick point.`, []);
          return;
        }
        const owners = regions.filter((r) => contains(r, p));
        if (!owners.length) {
          add('contact', 'error',
            `Contact "${c.name}" picks (${round(p.x)}, ${round(p.y)}, ${round(p.z)}), ` +
            `which is not on any region.`, []);
        }
      });
    }

    return { issues, ok: !issues.some((i) => i.severity === 'error'), counts: tally(issues) };
  }

  /**
   * Is the space separating two nearly-touching boxes occupied by something?
   *
   * Builds the box that spans the gap - the shared footprint on the two
   * axes they overlap on, times the gap interval on the third - and samples
   * it. If every sample is inside some other region, the two are separated
   * by a neighbour rather than by a void, and there is nothing to report.
   */
  function bridgeIsFilled(a, b, regions, ia, ib) {
    // which axis is the gap on
    const axes = ['x', 'y', 'z'];
    let gapAxis = null;
    for (const ax of axes) {
      const lo1 = a[ax + '0'], hi1 = a[ax + '1'];
      const lo2 = b[ax + '0'], hi2 = b[ax + '1'];
      if (lo1 - hi2 > TOL) { gapAxis = { ax, lo: hi2, hi: lo1 }; break; }
      if (lo2 - hi1 > TOL) { gapAxis = { ax, lo: hi1, hi: lo2 }; break; }
    }
    if (!gapAxis) return true;

    const bridge = {};
    for (const ax of axes) {
      if (ax === gapAxis.ax) {
        bridge[ax + '0'] = gapAxis.lo;
        bridge[ax + '1'] = gapAxis.hi;
      } else {
        bridge[ax + '0'] = Math.max(a[ax + '0'], b[ax + '0']);
        bridge[ax + '1'] = Math.min(a[ax + '1'], b[ax + '1']);
      }
    }

    // a single neighbour covering the whole bridge is the common case
    for (let k = 0; k < regions.length; k++) {
      if (k === ia || k === ib) continue;
      const r = regions[k];
      if (r.x0 <= bridge.x0 + TOL && r.x1 >= bridge.x1 - TOL &&
          r.y0 <= bridge.y0 + TOL && r.y1 >= bridge.y1 - TOL &&
          r.z0 <= bridge.z0 + TOL && r.z1 >= bridge.z1 - TOL) return true;
    }

    // otherwise sample, which catches a bridge covered by several regions
    const others = regions.filter((_, k) => k !== ia && k !== ib);
    const at = (ax, t) => bridge[ax + '0'] + (bridge[ax + '1'] - bridge[ax + '0']) * t;
    const ts = [0.25, 0.5, 0.75];
    for (const tx of ts) {
      for (const ty of ts) {
        for (const tz of ts) {
          const p = { x: at('x', tx), y: at('y', ty), z: at('z', tz) };
          if (!others.some((r) => contains(r, p))) return false;
        }
      }
    }
    return true;
  }

  function tally(issues) {
    const c = { overlap: 0, gap: 0, disconnected: 0, contact: 0, degenerate: 0,
                error: 0, warn: 0 };
    for (const i of issues) {
      if (c[i.kind] !== undefined) c[i.kind]++;
      if (c[i.severity] !== undefined) c[i.severity]++;
    }
    return c;
  }


  /* ==================================================================
     ARCHITECTURE DETECTION
     ================================================================== */

  /**
   * Find the stacked channel columns.
   *
   * A channel column is a set of semiconductor boxes that share the same Z
   * footprint and sit at different heights. That is what a nanosheet stack
   * is, geometrically, and it does not depend on any naming convention -
   * so it works on files this generator did not write.
   */
  function findChannelColumns(regions) {
    const semi = regions.filter((r) => /^(silicon|germanium|sige|si)$/i.test(r.material));
    if (!semi.length) return [];

    /* Three physical facts separate a channel from everything else made of
       the same material, and all three are needed:

         1. it is under the gate      - excludes the source/drain pads
         2. it is above the substrate - excludes the bulk and the wells
         3. it is thin                - excludes anything else tall

       Getting this wrong is not subtle. With only (1) the substrate slabs
       became "channel columns" 50 nm thick; with only (3) the pads did. */
    const metal = regions.filter((r) =>
      /tin|tan|tungsten|^w$|poly|aluminum|aluminium|copper|metal/i.test(r.material));
    const gate = metal.length
      ? { x0: Math.min(...metal.map((r) => r.x0)), x1: Math.max(...metal.map((r) => r.x1)) }
      : null;

    const below = regions.filter((r) => r.y0 < -TOL);
    const substrateTop = below.length ? Math.max(...below.map((r) => r.y1)) : -Infinity;

    let cand = semi.filter((r) =>
      r.y0 >= substrateTop - TOL &&
      (!gate || (Math.min(r.x1, gate.x1) - Math.max(r.x0, gate.x0)) > TOL));
    if (!cand.length) return [];

    const heights = cand.map((r) => span(r, 'y')).sort((a, b) => a - b);
    const thinnest = heights[0];
    cand = cand.filter((r) => span(r, 'y') <= thinnest * 1.5 + TOL);
    if (!cand.length) return [];

    /* Group by Z footprint: that is what separates nMOS from pMOS. */
    const byZ = new Map();
    for (const r of cand) {
      const k = `${round(r.z0, 9)}|${round(r.z1, 9)}`;
      if (!byZ.has(k)) byZ.set(k, []);
      byZ.get(k).push(r);
    }

    const cols = [];
    for (const [, group] of byZ) {
      const bands = [];
      for (const r of group) {
        const hit = bands.find((b) => eq(b.y0, r.y0) && eq(b.y1, r.y1));
        if (hit) hit.parts.push(r);
        else bands.push({ y0: r.y0, y1: r.y1, parts: [r] });
      }
      bands.sort((a, b) => a.y0 - b.y0);
      if (!bands.length) continue;

      /* Recover the pieces the gate window clipped off. A sheet is usually
         split into extension | channel | extension, and only the middle
         piece sits strictly under the gate; the extensions share its Y band
         and Z footprint, so pull them back in for the segment report. */
      const z0 = group[0].z0, z1 = group[0].z1;
      for (const b of bands) {
        b.parts = semi.filter((r) =>
          eq(r.y0, b.y0) && eq(r.y1, b.y1) && eq(r.z0, z0) && eq(r.z1, z1))
          .sort((p, q) => p.x0 - q.x0);
      }

      cols.push({ z0, z1, bands, regions: group });
    }
    cols.sort((a, b) => a.z0 - b.z0);
    return cols;
  }


  /** Identify the architecture from the geometry, not from the file name. */
  function detectArchitecture(regions, columns) {
    const evidence = [];
    const mats = uniq(regions.map((r) => r.material));
    const bbox = boundsOf(regions);

    // a fork wall is a dielectric slab spanning the whole device in X and
    // sitting between two channel columns in Z
    let wall = null;
    if (columns.length >= 2) {
      const between = [columns[0].z1, columns[1].z0];
      wall = regions.find((r) =>
        /si3n4|nitride|sio2|oxide/i.test(r.material) &&
        eq(r.x0, bbox.x0) && eq(r.x1, bbox.x1) &&
        r.z0 >= between[0] - TOL && r.z1 <= between[1] + TOL &&
        span(r, 'y') > span(r, 'z'));
    }

    if (wall && columns.length >= 2) {
      evidence.push(`${columns.length} channel columns separated in Z`);
      evidence.push(`full-length ${wall.material} wall "${wall.name}" between them`);
      evidence.push(`${columns[0].bands.length} stacked sheets per column`);
      return { id: 'forksheet', name: 'Forksheet CMOS', confidence: 'high', evidence, wall, columns };
    }
    if (columns.length === 1 && columns[0].bands.length >= 1) {
      evidence.push(`one channel column with ${columns[0].bands.length} stacked sheets`);
      evidence.push(`gate metals: ${mats.filter((m) => /tin|tan|tungsten|w|poly/i.test(m)).join(', ') || 'none found'}`);
      return { id: 'nanosheet', name: 'Stacked nanosheet / GAA', confidence: 'medium', evidence, columns };
    }
    if (columns.length >= 2 && !wall) {
      evidence.push(`${columns.length} channel columns, no dielectric wall between them`);
      return { id: 'multi-column', name: 'Multi-column device', confidence: 'low', evidence, columns };
    }
    evidence.push(`${regions.length} regions, ${mats.length} materials, no stacked channel pattern found`);
    return { id: 'generic', name: 'Generic SDE structure', confidence: 'low', evidence, columns };
  }

  function boundsOf(regions) {
    return {
      x0: Math.min(...regions.map((r) => r.x0)), x1: Math.max(...regions.map((r) => r.x1)),
      y0: Math.min(...regions.map((r) => r.y0)), y1: Math.max(...regions.map((r) => r.y1)),
      z0: Math.min(...regions.map((r) => r.z0)), z1: Math.max(...regions.map((r) => r.z1)),
    };
  }


  /* ==================================================================
     PARAMETER EXTRACTION
     ================================================================== */

  const P = (label, value, note) => ({ label, value, note: note || '' });

  /**
   * Measure every design parameter the geometry actually determines.
   * Each entry records where the number came from, so a surprising figure
   * can be traced back to the regions it was measured on.
   */
  function analyze(parsed) {
    const regions = (parsed.regions || []).slice();
    if (!regions.length) {
      return { ok: false, reason: 'no regions', groups: [], architecture: null };
    }

    const bbox = boundsOf(regions);
    const columns = findChannelColumns(regions);
    const arch = detectArchitecture(regions, columns);
    const groups = [];
    const mats = uniq(regions.map((r) => r.material)).sort();

    const isMetal = (m) => /tin|tan|tungsten|^w$|poly|aluminum|aluminium|copper|metal/i.test(m);
    const isHighK = (m) => /hfo2|hf|al2o3|zro2/i.test(m);
    const isNitride = (m) => /si3n4|nitride/i.test(m);
    const isOxide = (m) => /sio2|oxide/i.test(m);

    const metal = regions.filter((r) => isMetal(r.material));
    const highk = regions.filter((r) => isHighK(r.material));
    const nitride = regions.filter((r) => isNitride(r.material));
    const oxide = regions.filter((r) => isOxide(r.material));

    /* ---------------- architecture ---------------- */
    groups.push({
      title: 'Architecture',
      params: [
        P('Detected', arch.name, arch.confidence + ' confidence'),
        P('Regions', String(regions.length)),
        P('Materials', String(mats.length), mats.join(', ')),
        P('Channel columns', String(columns.length),
          columns.length ? 'separated in Z' : 'no stacked channel pattern'),
        P('Device extent X', `${um(bbox.x1 - bbox.x0)}`, `${round(bbox.x0)} .. ${round(bbox.x1)}`),
        P('Device extent Y', `${um(bbox.y1 - bbox.y0)}`, `${round(bbox.y0)} .. ${round(bbox.y1)}`),
        P('Device extent Z', `${um(bbox.z1 - bbox.z0)}`, `${round(bbox.z0)} .. ${round(bbox.z1)}`),
      ],
      evidence: arch.evidence,
    });

    /* ---------------- gate ---------------- */
    if (metal.length) {
      const gx0 = Math.min(...metal.map((r) => r.x0));
      const gx1 = Math.max(...metal.map((r) => r.x1));
      const gy0 = Math.min(...metal.map((r) => r.y0));
      const gy1 = Math.max(...metal.map((r) => r.y1));
      // the gate length is the X extent that most gate pieces share
      const lens = metal.map((r) => span(r, 'x'));
      const modeLen = mode(lens.map((v) => round(v, 9)));
      const params = [
        P('Gate length L_G', nm(modeLen), `most common X extent of ${metal.length} metal regions`),
        P('Gate X window', `${round(gx0)} .. ${round(gx1)}`, 'start .. end along transport'),
        P('Gate centre X', round((gx0 + gx1) / 2, 6) + ' µm'),
        P('Gate stack height', nm(gy1 - gy0), `${round(gy0)} .. ${round(gy1)} in Y`),
        P('Gate metal pieces', String(metal.length), uniq(metal.map((r) => r.material)).join(', ')),
        P('Gate metal volume', round(metal.reduce((a, r) =>
          a + span(r, 'x') * span(r, 'y') * span(r, 'z'), 0), 4) + ' µm³'),
      ];
      // per-column gate envelope in Z
      for (const [i, c] of columns.entries()) {
        const env = metal.filter((r) => r.z1 > c.z0 - 0.05 && r.z0 < c.z1 + 0.05);
        if (env.length) {
          const z0 = Math.min(...env.map((r) => r.z0)), z1 = Math.max(...env.map((r) => r.z1));
          params.push(P(`Gate envelope Z, column ${i + 1}`, `${round(z0)} .. ${round(z1)}`,
            `width ${nm(z1 - z0)}`));
        }
      }
      groups.push({ title: 'Gate', params });
    }

    /* ---------------- channels / sheets ---------------- */
    if (columns.length) {
      const params = [];
      for (const [i, c] of columns.entries()) {
        const b = c.bands;
        const th = b.map((x) => x.y1 - x.y0);
        const pitches = [];
        for (let k = 1; k < b.length; k++) pitches.push(b[k].y0 - b[k - 1].y0);
        const gaps = [];
        for (let k = 1; k < b.length; k++) gaps.push(b[k].y0 - b[k - 1].y1);

        params.push(P(`Column ${i + 1}: sheets`, String(b.length), 'stacked in Y'));
        params.push(P(`Column ${i + 1}: sheet thickness T_NS`, nm(th[0]),
          uniq(th.map((v) => round(v, 9))).length > 1 ? 'NOT uniform: ' + th.map(nm).join(', ') : 'uniform'));
        params.push(P(`Column ${i + 1}: sheet width W_NS`, nm(c.z1 - c.z0),
          `Z ${round(c.z0)} .. ${round(c.z1)}`));
        if (pitches.length) {
          params.push(P(`Column ${i + 1}: sheet pitch`, nm(pitches[0]),
            uniq(pitches.map((v) => round(v, 9))).length > 1 ? 'NOT uniform' : 'uniform, sheet + gap'));
          params.push(P(`Column ${i + 1}: vertical gap`, nm(gaps[0]),
            'metal + dielectric between sheets'));
        }
        params.push(P(`Column ${i + 1}: stack Y range`,
          `${round(b[0].y0)} .. ${round(b[b.length - 1].y1)}`,
          `bottom sheet to top sheet`));
        // lateral split of each band: extension | channel | extension
        const widest = b[0].parts.slice().sort((p, q) => p.x0 - q.x0);
        if (widest.length > 1) {
          params.push(P(`Column ${i + 1}: sheet segments`, String(widest.length),
            widest.map((r) => r.name).join(' | ')));
        }
      }
      groups.push({ title: 'Channel / nanosheets', params });
    }

    /* ---------------- source / drain and junctions ---------------- */
    {
      const params = [];
      const semi = regions.filter((r) => /silicon|germanium|sige/i.test(r.material));
      const gx = metal.length
        ? [Math.min(...metal.map((r) => r.x0)), Math.max(...metal.map((r) => r.x1))]
        : null;
      if (gx) {
        const src = semi.filter((r) => r.x1 <= gx[0] + TOL && r.y1 > 0);
        const drn = semi.filter((r) => r.x0 >= gx[1] - TOL && r.y1 > 0);
        const pad = (set) => {
          if (!set.length) return null;
          const x0 = Math.min(...set.map((r) => r.x0)), x1 = Math.max(...set.map((r) => r.x1));
          const y0 = Math.min(...set.map((r) => r.y0)), y1 = Math.max(...set.map((r) => r.y1));
          return { x0, x1, y0, y1 };
        };
        const s = pad(src), d = pad(drn);
        if (s) {
          params.push(P('Source X window', `${round(s.x0)} .. ${round(s.x1)}`, `length ${nm(s.x1 - s.x0)}`));
          params.push(P('Source height', nm(s.y1 - s.y0), `${round(s.y0)} .. ${round(s.y1)}`));
        }
        if (d) {
          params.push(P('Drain X window', `${round(d.x0)} .. ${round(d.x1)}`, `length ${nm(d.x1 - d.x0)}`));
          params.push(P('Drain height', nm(d.y1 - d.y0), `${round(d.y0)} .. ${round(d.y1)}`));
        }
        // extension = semiconductor between the pad edge and the gate edge
        const pads = uniq(semi.map((r) => round(r.x1, 9))).sort((a, b) => a - b);
        const padEdge = pads.filter((v) => v < gx[0] - TOL).pop();
        if (padEdge !== undefined) {
          params.push(P('S/D extension length', nm(gx[0] - padEdge),
            `pad edge ${round(padEdge)} to gate edge ${round(gx[0])}`));
        }
        params.push(P('Junction plane, source side', round(gx[0], 6) + ' µm',
          'doping changes at the gate edge'));
        params.push(P('Junction plane, drain side', round(gx[1], 6) + ' µm',
          'doping changes at the gate edge'));
      }
      // well / substrate junction planes
      const sub = regions.filter((r) => r.y1 <= TOL);
      if (sub.length) {
        const yb = Math.min(...sub.map((r) => r.y0));
        const wellTops = uniq(sub.map((r) => round(r.y1, 9)));
        const wellSplits = uniq(sub.map((r) => round(r.z1, 9))).filter(
          (z) => z > bbox.z0 + TOL && z < bbox.z1 - TOL);
        params.push(P('Substrate depth', nm(-yb), `bottom at ${round(yb)}`));
        params.push(P('Substrate regions', String(sub.length), sub.map((r) => r.name).join(', ')));
        const wellBottoms = uniq(sub.map((r) => round(r.y0, 9))).filter((v) => v > yb + TOL);
        if (wellBottoms.length) {
          params.push(P('Well depth', nm(-wellBottoms[0]),
            `well/bulk junction at y = ${wellBottoms[0]}`));
        }
        if (wellSplits.length) {
          params.push(P('Well split plane Z', wellSplits.map((v) => round(v, 6)).join(', '),
            'n-well / p-well boundary'));
        }
        if (wellTops.length) {
          params.push(P('Substrate top', round(Math.max(...wellTops), 6) + ' µm'));
        }
      }
      if (params.length) groups.push({ title: 'Source / drain, junctions, substrate', params });
    }

    /* ---------------- alignment and relationships ----------------
       Distances between features, and a verdict on each one. A number on
       its own does not say whether the structure is right; "gate starts
       exactly where the spacer ends" does. */
    if (metal.length && columns.length) {
      const params = [];
      const gx0 = Math.min(...metal.map((r) => r.x0));
      const gx1 = Math.max(...metal.map((r) => r.x1));
      const semi = regions.filter((r) => /silicon|germanium|sige/i.test(r.material));
      const verdict = (ok, good, bad) => (ok ? 'ALIGNED - ' + good : 'CHECK - ' + bad);

      /* The pad edge, not the extension edge. The extension runs right up
         to the gate, so an inclusive test finds the gate edge itself and
         reports a source-to-gate distance of zero. Strictly-less-than
         skips the extension and lands on the pad, which is the distance
         that was being asked for - and it comes out equal to the spacer
         thickness, as it should. */
      const padL = semi.filter((r) => r.x1 < gx0 - TOL && r.y1 > TOL)
        .map((r) => r.x1).sort((a, b) => b - a)[0];
      const padR = semi.filter((r) => r.x0 > gx1 + TOL && r.y1 > TOL)
        .map((r) => r.x0).sort((a, b) => a - b)[0];
      if (padL !== undefined) {
        params.push(P('Source-to-gate distance', nm(gx0 - padL),
          'source pad edge ' + round(padL) + ' to gate edge ' + round(gx0)));
      }
      if (padR !== undefined) {
        params.push(P('Drain-to-gate distance', nm(padR - gx1),
          'gate edge ' + round(gx1) + ' to drain pad edge ' + round(padR)));
      }
      if (padL !== undefined && padR !== undefined) {
        const sym = Math.abs((gx0 - padL) - (padR - gx1));
        params.push(P('Source/drain symmetry', sym <= TOL ? 'symmetric' : nm(sym) + ' difference',
          verdict(sym <= TOL, 'both sides equal', 'the two sides differ')));
      }

      // channel relative to the gate
      for (const [i, c] of columns.entries()) {
        const chan = c.bands[0].parts.filter((r) =>
          r.x0 >= gx0 - TOL && r.x1 <= gx1 + TOL);
        if (chan.length) {
          const cx0 = Math.min(...chan.map((r) => r.x0));
          const cx1 = Math.max(...chan.map((r) => r.x1));
          const ok = eq(cx0, gx0) && eq(cx1, gx1);
          params.push(P(`Channel-to-gate, column ${i + 1}`,
            ok ? 'coincident' : `${nm(Math.abs(cx0 - gx0))} / ${nm(Math.abs(cx1 - gx1))} offset`,
            verdict(ok, 'the gated length is exactly the channel segment',
                    'the channel does not start and end on the gate edges')));
        }
        // the sheet stack must reach both pads
        const band = c.bands[0].parts;
        if (band.length) {
          const x0 = Math.min(...band.map((r) => r.x0));
          const x1 = Math.max(...band.map((r) => r.x1));
          const reaches = padL !== undefined && padR !== undefined &&
                          eq(x0, padL) && eq(x1, padR);
          params.push(P(`Channel-to-S/D, column ${i + 1}`,
            reaches ? 'continuous' : `${round(x0)} .. ${round(x1)}`,
            verdict(reaches, 'sheet meets both pads with no gap',
                    'sheet does not span pad edge to pad edge')));
        }
      }

      // spacers relative to the gate
      const spacers = nitride.filter((r) => !arch.wall || r.name !== arch.wall.name);
      if (spacers.length) {
        const left = spacers.filter((r) => eq(r.x1, gx0));
        const right = spacers.filter((r) => eq(r.x0, gx1));
        const ok = left.length > 0 && right.length > 0;
        params.push(P('Spacer-to-gate', ok ? 'abutting both edges'
          : `${left.length} left, ${right.length} right`,
          verdict(ok, 'spacers meet the gate with no gap or overlap',
                  'at least one side does not meet the gate edge')));
        if (padL !== undefined && left.length) {
          const sx0 = Math.min(...left.map((r) => r.x0));
          params.push(P('Spacer-to-source', eq(sx0, padL) ? 'abutting' : nm(Math.abs(sx0 - padL)),
            verdict(eq(sx0, padL), 'spacer meets the source pad',
                    'spacer does not meet the source pad edge')));
        }
        // inner vs outer: a spacer between the sheets is an inner spacer
        const stackY = columns.length
          ? [columns[0].bands[0].y0, columns[0].bands[columns[0].bands.length - 1].y1]
          : null;
        if (stackY) {
          const inner = spacers.filter((r) => r.y0 >= stackY[0] - TOL && r.y1 <= stackY[1] + TOL);
          const outer = spacers.filter((r) => !(r.y0 >= stackY[0] - TOL && r.y1 <= stackY[1] + TOL));
          params.push(P('Inner spacer pieces', String(inner.length),
            inner.length ? 'between the sheets, thickness ' +
              nm(Math.min(...inner.map((r) => span(r, 'x')))) : 'none inside the stack'));
          params.push(P('Outer spacer pieces', String(outer.length),
            outer.length ? 'above, below or beside the stack, thickness ' +
              nm(Math.min(...outer.map((r) => span(r, 'x')))) : 'none'));
        }
      }

      // dielectric enclosure of each sheet
      if (highk.length && columns.length) {
        const perSheet = highk.length / columns.reduce((a, c) => a + c.bands.length, 0);
        params.push(P('Dielectric enclosure', perSheet >= 4 ? 'closed on all four sides'
          : round(perSheet, 3) + ' slabs per sheet',
          verdict(perSheet >= 4, 'no path from channel to metal avoids the collar',
                  'the collar does not fully enclose each sheet')));
      }

      // the two devices, for a forksheet
      if (columns.length >= 2) {
        const dz = columns[1].z0 - columns[0].z1;
        const sameY = eq(columns[0].bands[0].y0, columns[1].bands[0].y0) &&
                      columns[0].bands.length === columns[1].bands.length;
        params.push(P('nFET/pFET stack alignment', sameY ? 'level, equal sheet count'
          : 'stacks differ',
          verdict(sameY, 'both devices sit at the same heights',
                  'the two stacks are not at matching heights')));
        params.push(P('Complementary device spacing', nm(dz),
          'channel edge to channel edge across the wall'));
      }

      if (params.length) groups.push({ title: 'Alignment and relationships', params });
    }

    /* ---------------- gate dielectric ---------------- */
    if (highk.length) {
      const thick = highk.map((r) => Math.min(span(r, 'x'), span(r, 'y'), span(r, 'z')));
      groups.push({
        title: 'Gate dielectric',
        params: [
          P('Material', uniq(highk.map((r) => r.material)).join(', ')),
          P('Thickness', nm(Math.min(...thick)),
            uniq(thick.map((v) => round(v, 9))).length > 1
              ? 'varies: ' + uniq(thick.map((v) => round(v, 9))).map(nm).join(', ')
              : 'uniform on all faces'),
          P('Pieces', String(highk.length),
            columns.length ? `${highk.length / Math.max(columns.length, 1)} per column` : ''),
          P('Collar coverage', collarCoverage(highk, columns)),
        ],
      });
    }

    /* ---------------- spacers, liner, fork wall ---------------- */
    {
      const params = [];
      if (arch.wall) {
        const w = arch.wall;
        params.push(P('Fork wall material', w.material, `region "${w.name}"`));
        params.push(P('Fork wall thickness T_FORK', nm(span(w, 'z')),
          `Z ${round(w.z0)} .. ${round(w.z1)}`));
        params.push(P('Fork wall height', nm(span(w, 'y')), `${round(w.y0)} .. ${round(w.y1)}`));
        params.push(P('Fork wall length', nm(span(w, 'x')), 'full device length'));
        if (columns.length >= 2) {
          const g1 = columns[0].z1, g2 = columns[1].z0;
          params.push(P('nMOS-to-pMOS separation', nm(g2 - g1),
            `channel edge ${round(g1)} to channel edge ${round(g2)}`));
        }
      }
      // spacers: nitride that is not the wall, sitting beside the gate in X
      const spacers = nitride.filter((r) => !arch.wall || r.name !== arch.wall.name);
      if (spacers.length && metal.length) {
        const gx0 = Math.min(...metal.map((r) => r.x0));
        const gx1 = Math.max(...metal.map((r) => r.x1));
        const left = spacers.filter((r) => eq(r.x1, gx0));
        const right = spacers.filter((r) => eq(r.x0, gx1));
        const th = [...left, ...right].map((r) => span(r, 'x'));
        params.push(P('Spacer material', uniq(spacers.map((r) => r.material)).join(', ')));
        if (th.length) {
          params.push(P('Spacer thickness', nm(Math.min(...th)),
            `${left.length} piece(s) source side, ${right.length} drain side`));
        }
        params.push(P('Spacer pieces', String(spacers.length), 'total, both sides'));
      }
      if (oxide.length) {
        const liner = oxide.slice().sort((a, b) => span(a, 'y') - span(b, 'y'))[0];
        params.push(P('Gate liner material', uniq(oxide.map((r) => r.material)).join(', ')));
        params.push(P('Gate liner thickness', nm(span(liner, 'y')), `region "${liner.name}"`));
      }
      if (params.length) groups.push({ title: 'Spacers, liner, isolation', params });
    }

    /* ---------------- doping ---------------- */
    {
      const params = [];
      const byName = new Map((parsed.profiles || []).map((p) => [p.name, p]));
      for (const d of (parsed.doping || [])) {
        const prof = byName.get(d.profile);
        const species = prof ? String(prof.field).replace(/ActiveConcentration$/, '') : '?';
        const conc = prof ? prof.value : '?';
        params.push(P(d.region, `${species} ${fmtConc(conc)}`, `profile "${d.profile}"`));
      }
      if ((parsed.profiles || []).length && !params.length) {
        for (const p of parsed.profiles) {
          params.push(P(p.name, `${String(p.field).replace(/ActiveConcentration$/, '')} ${fmtConc(p.value)}`,
            'defined but not placed on a region'));
        }
      }
      if (params.length) {
        groups.push({
          title: `Doping (${(parsed.profiles || []).length} profiles, ${(parsed.doping || []).length} placements)`,
          params,
        });
      }
    }

    /* ---------------- materials ---------------- */
    {
      const params = mats.map((m) => {
        const set = regions.filter((r) => r.material === m);
        const vol = set.reduce((a, r) => a + span(r, 'x') * span(r, 'y') * span(r, 'z'), 0);
        return P(m, `${set.length} region(s)`, `${round(vol, 4)} µm³`);
      });
      groups.push({ title: 'Material assignments', params });
    }

    /* ---------------- contacts ---------------- */
    {
      const params = [];
      for (const c of (parsed.contacts || [])) {
        const pts = (c.faces || []).filter(Boolean);
        if (!pts.length) {
          params.push(P(c.name, 'declared, not placed', ''));
          continue;
        }
        for (const p of pts) {
          const owner = regions.filter((r) => contains(r, p));
          params.push(P(c.name,
            `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`,
            owner.length ? 'on ' + owner.map((r) => r.name).join(', ') : 'NOT on any region'));
        }
      }
      params.push(P('Work function', 'not in this file',
        'SDE geometry stores contact name, colour and display width only; ' +
        'work function is a device property set in sdevice.cmd'));
      groups.push({ title: `Contacts (${(parsed.contacts || []).length})`, params });
    }

    /* ---------------- mesh ---------------- */
    {
      const params = [];
      const sizes = (parsed.refinements || []).filter((r) => /define-refinement-size/.test(r.op));
      for (const s of sizes) {
        const a = s.args;
        params.push(P(String(a[0]),
          `max ${a.slice(1, 4).map((v) => round(v, 4)).join(' / ')}`,
          `min ${a.slice(4, 7).map((v) => round(v, 4)).join(' / ')} (X/Y/Z µm)`));
      }
      if (parsed.meshPrefix) {
        params.push(P('Mesh output', `${parsed.meshPrefix}_msh.tdr`, 'from sde:build-mesh'));
      }
      if (params.length) groups.push({ title: 'Mesh refinement', params });
    }

    return {
      ok: true,
      architecture: arch,
      bbox,
      columns,
      groups,
      regionCount: regions.length,
      materialCount: mats.length,
    };
  }

  /** Is the high-k actually wrapped all the way round each sheet? */
  function collarCoverage(highk, columns) {
    if (!columns.length) return `${highk.length} pieces`;
    const perSheet = highk.length / columns.reduce((a, c) => a + c.bands.length, 0);
    if (Math.abs(perSheet - 4) < 0.01) return '4 slabs per sheet - fully closed collar';
    if (Math.abs(perSheet - 2) < 0.01) return '2 slabs per sheet - top and bottom only';
    return `${round(perSheet, 3)} pieces per sheet`;
  }

  function fmtConc(v) {
    if (typeof v !== 'number') return String(v);
    if (Math.abs(v) >= 1e4) return v.toExponential().replace('e+', 'e') + ' cm⁻³';
    return String(v);
  }

  function mode(values) {
    const count = new Map();
    for (const v of values) count.set(v, (count.get(v) || 0) + 1);
    let best = values[0], n = 0;
    for (const [v, c] of count) if (c > n) { n = c; best = v; }
    return best;
  }

  window.SDEAnalyze = { analyze, check, boundsOf, overlapVolume, touches, gapBetween };

})();
