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

  /**
   * Resolve every contact pick point to the actual FACE it lands on.
   *
   * `(sdegeo:set-contact-faces (find-face-id (position x y z)) "name")` names
   * a face by a point that has to lie on it. SDE then makes that whole face
   * the electrode - so a contact is a rectangle on a region boundary, not a
   * point, and drawing it as a dot or a text label throws away both its area
   * and its orientation.
   *
   * The point is on a face when exactly one of its coordinates sits on one of
   * the region's six bounds while the other two are inside. That single axis
   * is the face normal; the face itself spans the region's full extent in the
   * other two axes.
   *
   * A point on an edge or a corner matches two or three axes at once and is
   * ambiguous; those are reported with axis null so the caller can fall back
   * to a marker and the checker can flag them.
   */
  function resolveContacts(regions, contacts) {
    const out = [];
    for (const c of (contacts || [])) {
      const pts = (c.faces || []).filter(Boolean);
      if (!pts.length) {
        out.push({ name: c.name, kind: 'unplaced', at: null, region: null,
                   axis: null, side: null, rect: null, area: 0 });
        continue;
      }
      for (const p of pts) {
        const owners = regions.filter((r) => contains(r, p));
        if (!owners.length) {
          out.push({ name: c.name, kind: 'unattached', at: p, region: null,
                     axis: null, side: null, rect: null, area: 0 });
          continue;
        }
        /* Several regions can share the face the point lies on. Prefer the
           one whose face is actually exposed, then the larger of them. */
        let best = null;
        for (const r of owners) {
          const hits = [];
          for (const ax of ['x', 'y', 'z']) {
            if (Math.abs(p[ax] - r[ax + '0']) < TOL) hits.push([ax, 'min']);
            if (Math.abs(p[ax] - r[ax + '1']) < TOL) hits.push([ax, 'max']);
          }
          if (hits.length !== 1) continue;
          const [axis, side] = hits[0];
          const cand = { region: r, axis, side,
                         exposed: faceIsExposed(regions, r, axis, side) };
          if (!best || (cand.exposed && !best.exposed) ||
              (cand.exposed === best.exposed && volumeOf(r) > volumeOf(best.region))) {
            best = cand;
          }
        }
        if (!best) {
          out.push({ name: c.name, kind: 'ambiguous', at: p,
                     region: owners[0].name, axis: null, side: null,
                     rect: null, area: 0 });
          continue;
        }
        const r = best.region, ax = best.axis;
        const at = best.side === 'min' ? r[ax + '0'] : r[ax + '1'];
        const other = ['x', 'y', 'z'].filter((k) => k !== ax);
        const rect = { axis: ax, at };
        for (const k of other) { rect[k + '0'] = r[k + '0']; rect[k + '1'] = r[k + '1']; }
        const area = (rect[other[0] + '1'] - rect[other[0] + '0']) *
                     (rect[other[1] + '1'] - rect[other[1] + '0']);
        out.push({ name: c.name, kind: 'face', at: p, region: r.name,
                   material: r.material, axis: ax, side: best.side,
                   exposed: best.exposed, rect, area });
      }
    }
    return out;
  }

  /** Is this face of this region open, or is a neighbour sitting on it? */
  function faceIsExposed(regions, r, axis, side) {
    const at = side === 'min' ? r[axis + '0'] : r[axis + '1'];
    const other = ['x', 'y', 'z'].filter((k) => k !== axis);
    let covered = 0;
    const total = (r[other[0] + '1'] - r[other[0] + '0']) *
                  (r[other[1] + '1'] - r[other[1] + '0']);
    for (const q of regions) {
      if (q === r) continue;
      const meets = side === 'min' ? Math.abs(q[axis + '1'] - at) < TOL
                                   : Math.abs(q[axis + '0'] - at) < TOL;
      if (!meets) continue;
      let a = 1;
      for (const k of other) {
        a *= Math.max(0, Math.min(r[k + '1'], q[k + '1']) - Math.max(r[k + '0'], q[k + '0']));
      }
      covered += a;
    }
    return covered < total * 0.5;
  }

  function volumeOf(r) {
    return (r.x1 - r.x0) * (r.y1 - r.y0) * (r.z1 - r.z0);
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
     DOPING MODEL
     ==================================================================
     SDE assigns doping with sdedr:define-constant-profile-region, which
     binds a named profile to a named region. So the spatial distribution
     IS the region map - there is no analytic profile to sample. What does
     need care is that a region can carry more than one placement: the net
     is donors minus acceptors, and the sign of that is the type. Reporting
     only the last profile seen would mislabel any counter-doped region.
     ================================================================== */

  const DONORS = /phosphorus|arsenic|antimony|nitrogen/i;
  const ACCEPTORS = /boron|aluminum|aluminium|gallium|indium/i;

  /* Classes and the colours the viewer paints them: n-type RED, p-type
     BLUE, darker with increasing concentration so N+ reads as stronger
     than N at a glance. The two families are opposite ends of the wheel,
     so the junction between them is the most visible line in the view. */
  const DOPING_CLASSES = [
    { id: 'Nplus',  label: 'N+', color: '#b71c1c', min: 1e19, type: 'n',
      range: '>= 1e19 cm^-3' },
    { id: 'N',      label: 'N',  color: '#ef5350', min: 1e16, type: 'n',
      range: '1e16 - 1e19 cm^-3' },
    { id: 'Nminus', label: 'N-', color: '#ffcdd2', min: 0,    type: 'n',
      range: '< 1e16 cm^-3' },
    { id: 'Pplus',  label: 'P+', color: '#0d47a1', min: 1e19, type: 'p',
      range: '>= 1e19 cm^-3' },
    { id: 'P',      label: 'P',  color: '#42a5f5', min: 1e16, type: 'p',
      range: '1e16 - 1e19 cm^-3' },
    { id: 'Pminus', label: 'P-', color: '#b3e5fc', min: 0,    type: 'p',
      range: '< 1e16 cm^-3' },
  ];
  const UNDOPED = { id: 'undoped', label: 'undoped', color: '#5a636e',
                    type: null, range: 'no profile placed' };

  function classify(type, conc) {
    if (!type || !(conc > 0)) return UNDOPED;
    const band = conc >= 1e19 ? 0 : conc >= 1e16 ? 1 : 2;
    return DOPING_CLASSES.find((c) => c.type === type &&
      c.id === DOPING_CLASSES[band + (type === 'p' ? 3 : 0)].id) ||
      DOPING_CLASSES[band + (type === 'p' ? 3 : 0)];
  }

  /**
   * region name -> doping description, built from the file's own profiles.
   * Nothing is assumed: a region with no placement is reported as undoped
   * rather than being given a plausible default.
   */
  function dopingMap(parsed) {
    const byProfile = new Map((parsed.profiles || []).map((p) => [p.name, p]));
    const map = new Map();

    for (const d of (parsed.doping || [])) {
      const prof = byProfile.get(d.profile);
      if (!prof) continue;
      const species = String(prof.field).replace(/ActiveConcentration$/i, '');
      const conc = Number(prof.value);
      const type = DONORS.test(species) ? 'n' : ACCEPTORS.test(species) ? 'p' : null;
      if (!map.has(d.region)) {
        map.set(d.region, { region: d.region, placements: [], donors: 0, acceptors: 0 });
      }
      const e = map.get(d.region);
      e.placements.push({ profile: d.profile, placement: d.placement, species, conc, type });
      if (type === 'n') e.donors += conc;
      else if (type === 'p') e.acceptors += conc;
    }

    for (const e of map.values()) {
      const net = e.donors - e.acceptors;
      e.netType = net > 0 ? 'n' : net < 0 ? 'p' : null;
      e.netConc = Math.abs(net);
      e.counterDoped = e.donors > 0 && e.acceptors > 0;
      const cls = classify(e.netType, e.netConc);
      e.class = cls.id;
      e.label = cls.label;
      e.color = cls.color;
      e.range = cls.range;
      e.species = uniq(e.placements.map((p) => p.species)).join(' + ');
    }
    return map;
  }

  /** The legend the viewer draws, limited to classes actually present. */
  function dopingLegend(map) {
    const present = new Set([...map.values()].map((e) => e.class));
    const rows = DOPING_CLASSES.filter((c) => present.has(c.id)).map((c) => ({
      label: c.label, color: c.color, range: c.range,
      type: c.type === 'n' ? 'n-type (donors)' : 'p-type (acceptors)',
      count: [...map.values()].filter((e) => e.class === c.id).length,
    }));
    return rows;
  }

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
  function check(regions, contacts, parsed) {
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

    /* ---- overlaps ----
       An overlap is NOT an error. SDE resolves overlapping bodies by the
       current boolean rule, and a later create-cuboid replacing part of an
       earlier one is a normal, deliberate way to build a structure. Calling
       it an error would condemn perfectly good files.

       What IS worth reporting is the consequence: an earlier region that
       later ones have completely replaced contributes nothing to the final
       structure, so any doping or contact attached to it is attached to
       something that is no longer there. That is a real defect, and it is
       only visible once the overlaps are resolved. */
    const overlaps = [];
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const v = overlapVolume(regions[i], regions[j]);
        if (v > TOL) overlaps.push([regions[i], regions[j], v, i, j]);
      }
    }
    overlaps.sort((a, b) => b[2] - a[2]);

    if (overlaps.length) {
      const pairs = overlaps.slice(0, 6)
        .map(([a, b]) => `${a.name}/${b.name}`).join(', ');
      add('overlap', 'info',
        `${overlaps.length} overlapping pair(s); later regions replace earlier ` +
        `ones where they intersect: ${pairs}` + (overlaps.length > 6 ? ', ...' : '') + '.',
        uniq(overlaps.slice(0, 12).flatMap(([a, b]) => [a.name, b.name])));
    }

    /* a region wholly swallowed by regions created after it */
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const later = regions.slice(i + 1).filter((o) => overlapVolume(r, o) > TOL);
      if (!later.length) continue;
      if (fullyCovered(r, later)) {
        add('replaced', 'error',
          `"${r.name}" is completely replaced by later region(s) ` +
          `(${later.slice(0, 3).map((o) => o.name).join(', ')}) and does not ` +
          `survive into the final structure.`,
          [r.name].concat(later.slice(0, 3).map((o) => o.name)));
      }
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

    /* ---- doping placed on regions that exist, and semiconductors doped ---- */
    if (parsed) {
      const names = new Set(regions.map((r) => r.name));
      const profNames = new Set((parsed.profiles || []).map((p) => p.name));

      for (const d of (parsed.doping || [])) {
        if (!names.has(d.region)) {
          add('doping', 'error',
            `Doping placement "${d.placement}" targets region "${d.region}", ` +
            `which does not exist in this structure.`, []);
        }
        if (!profNames.has(d.profile)) {
          add('doping', 'error',
            `Doping placement "${d.placement}" uses profile "${d.profile}", ` +
            `which is never defined.`, [d.region]);
        }
      }

      const doped = new Set((parsed.doping || []).map((d) => d.region));
      const undoped = regions.filter((r) =>
        /^(silicon|germanium|sige|si)$/i.test(r.material) && !doped.has(r.name));
      if (undoped.length) {
        add('doping', 'warn',
          `${undoped.length} semiconductor region(s) carry no doping profile: ` +
          undoped.slice(0, 5).map((r) => r.name).join(', ') +
          (undoped.length > 5 ? ', ...' : '') + '.',
          undoped.map((r) => r.name));
      }
    }

    /* ---- material assignment: metal must not touch semiconductor ----
       A gate metal sharing a face with a channel is a short, not a design.
       Checked on faces rather than proximity, so a legitimate metal-over-
       dielectric stack is untouched. */
    const isMetal = (m) => /tin|tan|tungsten|^w$|poly|aluminum|aluminium|copper/i.test(m);
    const isSemi = (m) => /^(silicon|germanium|sige|si)$/i.test(m);
    const shorts = [];
    for (const a of regions.filter((r) => isMetal(r.material))) {
      for (const b of regions.filter((r) => isSemi(r.material))) {
        if (touches(a, b) || overlapVolume(a, b) > TOL) shorts.push([a, b]);
      }
    }
    for (const [a, b] of shorts.slice(0, 8)) {
      add('material', 'error',
        `Gate metal "${a.name}" meets semiconductor "${b.name}" directly - ` +
        `no dielectric between them.`, [a.name, b.name]);
    }
    if (shorts.length > 8) {
      add('material', 'error', `...and ${shorts.length - 8} further metal-to-semiconductor contacts.`);
    }

    return { issues, ok: !issues.some((i) => i.severity === 'error'), counts: tally(issues) };
  }

  /**
   * Regions an architecture is expected to have. Reported as missing only
   * when the architecture was positively identified, so a structure this
   * code does not recognise is never told it is incomplete.
   */
  function checkRequired(regions, arch) {
    const issues = [];
    if (!arch || arch.confidence === 'low') return issues;

    const names = regions.map((r) => r.name);
    const has = (re) => names.some((n) => re.test(n));
    const want = [
      [/substrate|bulk/i, 'a substrate region'],
      [/source/i, 'a source region'],
      [/drain/i, 'a drain region'],
      [/gate/i, 'a gate region'],
    ];
    if (arch.id === 'forksheet') want.push([/wall|fork/i, 'the fork dielectric wall']);

    for (const [re, what] of want) {
      if (!has(re)) {
        issues.push({ kind: 'missing', severity: 'error', regions: [],
          message: `No region matching ${what} was found, but the structure was ` +
                   `identified as ${arch.name}.` });
      }
    }
    return issues;
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

  /**
   * Is box `r` entirely inside the union of `others`?
   *
   * Exact CSG is not needed and not worth it here: the box is sampled on a
   * grid, and if every sample is covered the region has nothing of its own
   * left. A coarse grid can only ever miss a defect, never invent one,
   * which is the right direction for this to fail in.
   */
  function fullyCovered(r, others) {
    const N = 4;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        for (let k = 0; k < N; k++) {
          const p = {
            x: r.x0 + (r.x1 - r.x0) * ((i + 0.5) / N),
            y: r.y0 + (r.y1 - r.y0) * ((j + 0.5) / N),
            z: r.z0 + (r.z1 - r.z0) * ((k + 0.5) / N),
          };
          if (!others.some((o) => contains(o, p))) return false;
        }
      }
    }
    return true;
  }

  function tally(issues) {
    const c = { overlap: 0, gap: 0, disconnected: 0, contact: 0, degenerate: 0,
                replaced: 0, missing: 0, material: 0, doping: 0,
                error: 0, warn: 0, info: 0 };
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
        P('Gate width (Z)', nm(Math.max(...metal.map((r) => span(r, 'z')))),
          'widest gate metal piece across the sheet'),
      ];
      /* The gate metal appears at three thicknesses: the slabs between
         sheets, the bottom and top slabs, and the bridge that joins them
         down the open side. Reporting only one of them hides the stack. */
      {
        const ys = metal.map((r) => round(span(r, 'y'), 9));
        const zs = metal.map((r) => round(span(r, 'z'), 9));
        params.push(P('Gate metal thickness', nm(Math.min(...ys)),
          'thinnest slab; inter-sheet fill'));
        const bridge = metal.filter((r) => span(r, 'y') > Math.min(...ys) * 1.5);
        if (bridge.length) {
          params.push(P('Gate bridge thickness', nm(Math.min(...bridge.map((r) => span(r, 'z')))),
            `${bridge.length} piece(s) joining the slabs down the open Z side`));
          params.push(P('Gate bridge height', nm(Math.max(...bridge.map((r) => span(r, 'y')))),
            'spans the whole sheet stack'));
        }
      }
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
          /* The gated middle segment is the channel; the outer two are the
             source and drain extensions. Their lengths are separate design
             parameters and were not being reported at all. */
          const mid = widest[Math.floor(widest.length / 2)];
          params.push(P(`Column ${i + 1}: channel length`, nm(span(mid, 'x')),
            `gated segment "${mid.name}"`));
          if (widest.length >= 3) {
            params.push(P(`Column ${i + 1}: extension length`,
              nm(span(widest[0], 'x')),
              `source side; drain side ${nm(span(widest[widest.length - 1], 'x'))}`));
          }
          params.push(P(`Column ${i + 1}: channel cross-section`,
            `${nm(span(mid, 'z'))} x ${nm(span(mid, 'y'))}`,
            'width x thickness, the conducting cross-section'));
        }
      }
      /* Lateral spacing: sheet to sheet across the fork, which is what the
         wall thickness plus the two dielectric stacks actually buys. */
      if (columns.length > 1) {
        const sorted = columns.slice().sort((a, b2) => a.z0 - b2.z0);
        for (let i = 1; i < sorted.length; i++) {
          params.push(P(`Lateral sheet spacing ${i}-${i + 1}`,
            nm(sorted[i].z0 - sorted[i - 1].z1),
            'channel edge to channel edge across the fork wall'));
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
          const z0 = Math.min(...set.map((r) => r.z0)), z1 = Math.max(...set.map((r) => r.z1));
          const vol = set.reduce((a, r) =>
            a + span(r, 'x') * span(r, 'y') * span(r, 'z'), 0);
          return { x0, x1, y0, y1, z0, z1, vol, n: set.length };
        };
        /* Length, height and width are three separate design parameters and
           the pad volume is what actually sets series resistance, so all
           four are reported rather than just the X window. */
        const padRows = (tag, b2) => {
          params.push(P(tag + ' length', nm(b2.x1 - b2.x0), 'along transport (X)'));
          params.push(P(tag + ' height', nm(b2.y1 - b2.y0), `${round(b2.y0)} .. ${round(b2.y1)} in Y`));
          params.push(P(tag + ' width', nm(b2.z1 - b2.z0), `${round(b2.z0)} .. ${round(b2.z1)} in Z`));
          params.push(P(tag + ' volume', round(b2.vol, 6) + ' µm³',
            `${b2.n} region(s)`));
        };
        const s = pad(src), d = pad(drn);
        /* A forksheet has two of everything side by side in Z. Measuring
           the envelope of both pads at once reports the whole device width
           as "source width", which is not a pad dimension at all - so each
           pad is measured against the column it belongs to. */
        const perColumn = (set, tag) => {
          if (!columns.length) return false;
          let any = false;
          for (const [i, c] of columns.entries()) {
            const own = set.filter((r) => r.z1 > c.z0 - TOL && r.z0 < c.z1 + TOL);
            const b2 = pad(own);
            if (!b2) continue;
            any = true;
            padRows(`${tag} ${i + 1}`, b2);
          }
          return any;
        };
        if (s) {
          params.push(P('Source X window', `${round(s.x0)} .. ${round(s.x1)}`, `length ${nm(s.x1 - s.x0)}`));
          if (!perColumn(src, 'Source')) padRows('Source', s);
        }
        if (d) {
          params.push(P('Drain X window', `${round(d.x0)} .. ${round(d.x1)}`, `length ${nm(d.x1 - d.x0)}`));
          if (!perColumn(drn, 'Drain')) padRows('Drain', d);
        }
        // extension = semiconductor between the pad edge and the gate edge
        const pads = uniq(semi.map((r) => round(r.x1, 9))).sort((a, b) => a - b);
        const padEdge = pads.filter((v) => v < gx[0] - TOL).pop();
        if (padEdge !== undefined) {
          params.push(P('S/D extension length', nm(gx[0] - padEdge),
            `pad edge ${round(padEdge)} to gate edge ${round(gx[0])}`));
          /* The extension carries the same cross-section as the sheet it
             continues, which is what its series resistance depends on. */
          const ext = semi.filter((r) => r.x1 <= gx[0] + TOL && r.x0 >= padEdge - TOL &&
            span(r, 'x') < (gx[1] - gx[0]) && r.y0 > 0);
          if (ext.length) {
            params.push(P('S/D extension cross-section',
              `${nm(Math.min(...ext.map((r) => span(r, 'z'))))} x ` +
              `${nm(Math.min(...ext.map((r) => span(r, 'y'))))}`,
              `width x thickness, ${ext.length} extension region(s) per side`));
          }
        }
        params.push(P('Junction plane, source side', round(gx[0], 6) + ' µm',
          'doping changes at the gate edge'));
        params.push(P('Junction plane, drain side', round(gx[1], 6) + ' µm',
          'doping changes at the gate edge'));

        // raised source/drain: pads standing proud of the top sheet
        if (columns.length && s && d) {
          const stackTop = Math.max(...columns.map((c) => c.bands[c.bands.length - 1].y1));
          const raise = Math.max(s.y1, d.y1) - stackTop;
          params.push(P('Raised source/drain', raise > TOL ? nm(raise) : 'not raised',
            raise > TOL ? `pads stand ${nm(raise)} above the top sheet`
                        : `pad top ${round(Math.max(s.y1, d.y1))} is level with the top sheet`));
        }
        // junction depth: how far the doped pad reaches below the bottom sheet
        if (columns.length && s) {
          const stackBottom = Math.min(...columns.map((c) => c.bands[0].y0));
          params.push(P('Junction depth', nm(Math.max(0, stackBottom - s.y0)),
            `pad bottom ${round(s.y0)} to lowest sheet ${round(stackBottom)}`));
        }
      }

      // channel material, taken from the gated segments themselves
      if (columns.length) {
        const chanMats = uniq(columns.flatMap((c) =>
          c.bands.flatMap((b) => b.parts.map((r) => r.material))));
        params.push(P('Channel material', chanMats.join(', '),
          chanMats.length > 1 ? 'more than one material in the channel stack'
                              : 'uniform across every sheet'));
      }

      // STI: buried oxide or nitride spanning laterally below the surface
      {
        const sti = regions.filter((r) =>
          /sio2|oxide|si3n4|nitride/i.test(r.material) && r.y0 < -TOL);
        if (sti.length) {
          params.push(P('STI / buried isolation', `${sti.length} region(s)`,
            sti.map((r) => `${r.name} ${nm(span(r, 'y'))} deep, ${nm(span(r, 'x'))} wide`)
              .slice(0, 3).join('; ')));
        } else {
          params.push(P('STI / buried isolation', 'none in this structure',
            'no dielectric region extends below y = 0; isolation here is the ' +
            'fork wall and the well split'));
        }
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
        const sx0 = Math.min(...sub.map((r) => r.x0)), sx1 = Math.max(...sub.map((r) => r.x1));
        const sz0 = Math.min(...sub.map((r) => r.z0)), sz1 = Math.max(...sub.map((r) => r.z1));
        params.push(P('Substrate length (X)', nm(sx1 - sx0), `${round(sx0)} .. ${round(sx1)}`));
        params.push(P('Substrate width (Z)', nm(sz1 - sz0), `${round(sz0)} .. ${round(sz1)}`));
        params.push(P('Substrate volume',
          round(sub.reduce((a, r) => a + span(r, 'x') * span(r, 'y') * span(r, 'z'), 0), 6) + ' µm³',
          'thermal domain, not a wafer thickness'));
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
          ...stackRows(regions, columns),
          eotStack(gateStackLayers(regions, columns)),
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
        const both = [...left, ...right];
        if (both.length) {
          params.push(P('Spacer height', nm(Math.max(...both.map((r) => span(r, 'y')))),
            'tallest spacer piece, liner to device top'));
          params.push(P('Spacer width (Z)', nm(Math.max(...both.map((r) => span(r, 'z')))),
            'widest spacer piece across the sheet'));
          /* Inner spacers are the ones that sit inside a channel column in
             Z - they fill the gaps between the sheets and are what a real
             GAA inner-spacer module forms. Everything else is an outer
             spacer running down the side of the stack. Classifying by Z
             POSITION, not by Z extent: the inner pieces span the full
             channel width, so "narrower" picks out the wrong set. */
          const inColumn = (r) => columns.some((c) =>
            r.z0 > c.z0 - TOL && r.z1 < c.z1 + TOL);
          const inner = both.filter(inColumn);
          const outer = both.filter((r) => !inColumn(r));
          if (inner.length) {
            params.push(P('Inner spacer dimensions',
              `${nm(Math.min(...inner.map((r) => span(r, 'x'))))} x ` +
              `${nm(Math.min(...inner.map((r) => span(r, 'y'))))} x ` +
              `${nm(Math.max(...inner.map((r) => span(r, 'z'))))}`,
              `${inner.length} piece(s), thickness x height x width; between the sheets`));
            params.push(P('Inner spacer height range',
              `${nm(Math.min(...inner.map((r) => span(r, 'y'))))} .. ` +
              `${nm(Math.max(...inner.map((r) => span(r, 'y'))))}`,
              'the sheet gaps they fill differ at the bottom and top of the stack'));
          }
          if (outer.length) {
            params.push(P('Outer spacer dimensions',
              `${nm(Math.min(...outer.map((r) => span(r, 'x'))))} x ` +
              `${nm(Math.max(...outer.map((r) => span(r, 'y'))))} x ` +
              `${nm(Math.max(...outer.map((r) => span(r, 'z'))))}`,
              `${outer.length} piece(s), thickness x height x width; beside the stack`));
          }
        }
        params.push(P('Spacer pieces', String(spacers.length), 'total, both sides'));
      }
      const stackOx = stackOxide(regions);
      const linerOx = oxide.filter((r) => !stackOx.has(r));
      if (linerOx.length) {
        const liner = linerOx.slice().sort((a, b) => span(a, 'y') - span(b, 'y'))[0];
        params.push(P('Gate liner material', uniq(linerOx.map((r) => r.material)).join(', ')));
        params.push(P('Gate liner thickness', nm(span(liner, 'y')), `region "${liner.name}"`));
      }
      if (params.length) groups.push({ title: 'Spacers, liner, isolation', params });
    }

    /* ---------------- doping ---------------- */
    {
      const params = [];
      const byName = new Map((parsed.profiles || []).map((p) => [p.name, p]));
      const map = dopingMap(parsed);
      for (const d of (parsed.doping || [])) {
        const prof = byName.get(d.profile);
        const species = prof ? String(prof.field).replace(/ActiveConcentration$/, '') : '?';
        const conc = prof ? prof.value : '?';
        /* The species alone does not say whether a region reads as N+ or P:
           that is the class the viewer colours it by, so it belongs here. */
        const e = map && (map.get ? map.get(d.region) : null);
        const cls = e ? `${e.label} ${e.netType === 'n' ? 'n-type' : 'p-type'}` +
          (e.counterDoped ? ', counter-doped' : '') : '';
        params.push(P(d.region, `${species} ${fmtConc(conc)}`,
          cls ? `${cls} - profile "${d.profile}"` : `profile "${d.profile}"`));
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
      /* A contact is a face, so report the face: which one, on what, how
         big, and what role it plays. The pick point on its own says where
         the script asked, not what the electrode actually is. */
      const ROLE = [
        [/source/i, 'source'], [/drain/i, 'drain'], [/gate/i, 'gate'],
        [/well|body|bulk|sub/i, 'body / substrate'],
      ];
      const roleOf = (n) => {
        for (const [re, r] of ROLE) if (re.test(n)) return r;
        return 'other';
      };
      for (const c of resolveContacts(regions, parsed.contacts || [])) {
        if (c.kind === 'unplaced') {
          params.push(P(c.name, 'declared, not placed', roleOf(c.name)));
          continue;
        }
        if (c.kind !== 'face') {
          params.push(P(c.name,
            c.at ? `(${round(c.at.x)}, ${round(c.at.y)}, ${round(c.at.z)})` : '-',
            c.kind === 'unattached' ? 'NOT on any region'
                                    : 'pick point on an edge or corner - ambiguous'));
          continue;
        }
        const face = `${c.side === 'max' ? '+' : '-'}${c.axis}`;
        const other = ['x', 'y', 'z'].filter((k) => k !== c.axis);
        const dims = other.map((k) => nm(c.rect[k + '1'] - c.rect[k + '0'])).join(' x ');
        /* round() here is toPrecision, not decimal places - passing 1 turned
           1140 nm2 into 1000. Areas want a fixed decimal, not one sig fig. */
        params.push(P(c.name, `face contact, ${face} of ${c.region}`,
          `${roleOf(c.name)} - ${dims} = ${(c.area * 1e6).toFixed(1)} nm², ` +
          `${c.material}, at ${c.axis} = ${round(c.rect.at)}` +
          (c.exposed ? '' : ' (buried face)')));
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

  /**
   * Equivalent oxide thickness.
   *
   * EOT is not in the file - it depends on the permittivity of the
   * dielectric, which SDE does not record - so the constant used is named
   * in the note rather than hidden. Anyone using a different k for their
   * HfO2 can scale the figure.
   */
  const K_VALUES = { HfO2: 25, Al2O3: 9, ZrO2: 25, SiO2: 3.9, Si3N4: 7.5 };

  /**
   * EOT of the whole gate stack, in series.
   *
   * A gate-all-around stack is usually two layers: a thin interfacial SiO2
   * on the silicon with the high-k outside it. Taking only the high-k - as
   * this did while the structure was single-layer - understates the EOT by
   * the entire interfacial thickness, and the IL is often the larger of the
   * two terms. Every layer between channel and metal contributes
   * t * (3.9 / k).
   */
  function eotStack(layers) {
    if (!layers.length) return P('EOT', 'not derivable', 'no gate dielectric found');
    let total = 0;
    const parts = [];
    for (const [material, t] of layers) {
      const k = K_VALUES[material];
      if (!k) {
        return P('EOT', 'not derivable', `no permittivity known for ${material}`);
      }
      total += t * 3.9 / k;
      parts.push(`${nm(t)} ${material} (k=${k})`);
    }
    return P('EOT', nm(total),
      parts.join(' + ') + ', in series against SiO2 at k = 3.9; ' +
      'k is not stored in the SCM');
  }

  /**
   * Recover the parametric model's inputs by measuring the geometry.
   *
   * The step-by-step script carries no (define ...) block - every
   * coordinate is a literal - so there is nothing to read back. Measuring
   * instead turns out to be the better answer anyway: it works on any
   * forksheet file, including ones this generator never wrote.
   *
   * Only values that can be measured are returned, each with a note saying
   * how. Anything not derivable is simply absent, so the caller leaves that
   * control alone rather than overwriting it with a guess.
   */
  function extractParams(parsed) {
    const regions = (parsed.regions || []);
    if (!regions.length) return null;

    const columns = findChannelColumns(regions);
    const arch = detectArchitecture(regions, columns);
    if (!columns.length) return { params: {}, from: {}, arch, columns };

    const params = {}, from = {};
    const put = (k, v, how) => {
      if (Number.isFinite(v) && v > TOL) { params[k] = round(v, 9); from[k] = how; }
    };

    const isMetal = (m) => /tin|tan|tungsten|^w$|poly|aluminum|aluminium|copper/i.test(m);
    const isHighK = (m) => /hfo2|al2o3|zro2/i.test(m);
    const metal = regions.filter((r) => isMetal(r.material));
    const highk = regions.filter((r) => isHighK(r.material));
    const semi = regions.filter((r) => /^(silicon|germanium|sige)$/i.test(r.material));

    const c0 = columns[0];
    const b0 = c0.bands[0];
    put('T_NS', b0.y1 - b0.y0, 'height of a sheet band');
    put('W_NS', c0.z1 - c0.z0, 'Z footprint of the channel column');
    put('N_SHEETS', c0.bands.length, 'number of bands in column 1');

    if (metal.length) {
      const gx0 = Math.min(...metal.map((r) => r.x0));
      const gx1 = Math.max(...metal.map((r) => r.x1));
      put('L_G', mode(metal.map((r) => round(span(r, 'x'), 9))),
          'most common X extent among the gate metal pieces');

      // the pad edge, skipping the extension that runs up to the gate
      const padEdges = semi.filter((r) => r.x1 < gx0 - TOL && r.y1 > TOL).map((r) => r.x1);
      if (padEdges.length) {
        const padL = Math.max(...padEdges);
        put('T_SPACER', gx0 - padL, 'gate edge to source pad edge');
        const pad = semi.filter((r) => Math.abs(r.x1 - padL) < TOL && r.y1 > TOL);
        if (pad.length) put('L_PAD', padL - Math.min(...pad.map((r) => r.x0)), 'source pad X extent');
      }
      // gate bridge: metal outer face to the high-k outer face, in Z
      if (highk.length) {
        const colMetal = metal.filter((r) => r.z0 < c0.z0 + TOL);
        const colHk = highk.filter((r) => r.z0 < c0.z0 + TOL);
        if (colMetal.length && colHk.length) {
          put('T_BRIDGE', Math.min(...colHk.map((r) => r.z0)) - Math.min(...colMetal.map((r) => r.z0)),
              'gate outer face to high-k outer face in Z');
        }
      }
    }

    if (arch.wall) put('T_FORK', span(arch.wall, 'z'), `Z thickness of "${arch.wall.name}"`);

    if (highk.length) {
      const t = Math.min(...highk.map((r) =>
        Math.min(span(r, 'x'), span(r, 'y'), span(r, 'z'))));
      put('T_HFO2', t, 'thinnest high-k slab');

      /* The collar is the whole dielectric stack, not just the high-k. Any
         interfacial layer inside it counts towards the pitch as well, so it
         has to be measured before the metal can be backed out of it. */
      const stackOx = stackOxide(regions);
      let t_il = 0;
      if (stackOx.size) {
        t_il = Math.min(...[...stackOx].map((r) =>
          Math.min(span(r, 'x'), span(r, 'y'), span(r, 'z'))));
        put('T_IL', t_il, 'thinnest interfacial oxide slab');
      }
      if (c0.bands.length > 1) {
        const pitch = c0.bands[1].y0 - c0.bands[0].y0;
        put('T_METAL', pitch - (b0.y1 - b0.y0) - 2 * (t + t_il),
            'sheet pitch minus the sheet and both full dielectric collars');
      }
    }

    const stackOx2 = stackOxide(regions);
    const oxide = regions.filter((r) =>
      /^sio2$/i.test(r.material) && !stackOx2.has(r));
    if (oxide.length) {
      const liner = oxide.slice().sort((a, b) => span(a, 'y') - span(b, 'y'))[0];
      put('T_LINER', span(liner, 'y'), `Y thickness of "${liner.name}"`);
    }

    const below = regions.filter((r) => r.y0 < -TOL);
    if (below.length) {
      put('T_DOMAIN', -Math.min(...below.map((r) => r.y0)), 'deepest region below y = 0');
      const wellBottoms = uniq(below.map((r) => round(r.y0, 9)))
        .filter((v) => v > Math.min(...below.map((r) => r.y0)) + TOL);
      if (wellBottoms.length) put('T_WELL', -Math.max(...wellBottoms), 'well / bulk boundary');
    }

    return { params, from, arch, columns };
  }

  /**
   * Each layer of the gate stack as its own row.
   *
   * The high-k rows above describe only the high-k. A two-layer stack has an
   * interfacial oxide underneath it that is usually the thicker contributor
   * to EOT, and it is a design parameter in its own right, so it is listed
   * rather than left to be inferred from the EOT note.
   */
  function stackRows(regions, columns) {
    const layers = gateStackLayers(regions, columns);
    if (layers.length < 2) return [];
    const rows = [];
    for (const [material, t] of layers) {
      rows.push(P(material + ' layer thickness', nm(t),
        material === 'SiO2' ? 'interfacial layer, against the silicon'
                            : 'outside the interfacial layer'));
    }
    rows.push(P('Total dielectric thickness',
      nm(layers.reduce((a, [, t]) => a + t, 0)),
      `${layers.length} layers between channel and gate metal`));
    return rows;
  }

  /**
   * Oxide that belongs to the gate stack, as opposed to the gate liner.
   *
   * Told apart by geometry, not by name: the interfacial oxide is built
   * against the high-k, so it touches it on some face; the liner sits well
   * away from it. This matters because the interfacial layer is thinner
   * than the liner, so "the thinnest oxide" - which is what this used to
   * look for while the stack was single-layer - now finds the wrong one.
   */
  function stackOxide(regions) {
    const hk = regions.filter((r) => /hfo2|al2o3|zro2/i.test(r.material));
    if (!hk.length) return new Set();
    const near = (a, b, ax) =>
      a[ax + '0'] < b[ax + '1'] + TOL && b[ax + '0'] < a[ax + '1'] + TOL;
    const out = new Set();
    for (const r of regions) {
      if (!/^sio2$/i.test(r.material)) continue;
      if (hk.some((h) => near(r, h, 'x') && near(r, h, 'y') && near(r, h, 'z'))) {
        out.add(r);
      }
    }
    return out;
  }

  /**
   * The dielectric layers between channel and gate metal, thinnest first.
   * Found by geometry: any dielectric region that wraps a channel column
   * and sits inside the gate window is part of the stack.
   */
  function gateStackLayers(regions, columns) {
    if (!columns.length) return [];
    const c0 = columns[0];
    const diel = regions.filter((r) =>
      /hfo2|sio2|al2o3|zro2/i.test(r.material) &&
      r.z1 > c0.z0 - 0.05 && r.z0 < c0.z1 + 0.05 &&
      r.y0 > -TOL &&
      /_(IL|HfO2|hk|ox)_/i.test(r.name));
    const byMat = new Map();
    for (const r of diel) {
      const t = Math.min(span(r, 'x'), span(r, 'y'), span(r, 'z'));
      const cur = byMat.get(r.material);
      if (cur === undefined || t < cur) byMat.set(r.material, t);
    }
    return [...byMat.entries()].sort((a, b) => a[1] - b[1]);
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

  window.SDEAnalyze = {
    analyze, check, checkRequired, extractParams,
    dopingMap, dopingLegend, classify, resolveContacts,
    boundsOf, overlapVolume, touches, gapBetween,
    DOPING_CLASSES, UNDOPED,
  };

})();
