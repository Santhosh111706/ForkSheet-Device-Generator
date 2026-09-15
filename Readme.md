# Forksheet CMOS SCM Generator

**Live app:** <https://santhosh111706.github.io/ForkSheet-Device-Generator/>

A **static, browser-only** parametric generator for 3D Forksheet CMOS
Sentaurus SDE geometry, with a live interactive 3D preview.

It is a direct port of the Python generator `gen_forksheet.py` and emits the
**V8 baseline** structure. The generated `.scm` files are compatible with the
SCM Device Viewer project.

Output is a **step-by-step script** by default: every command written out one
by one, no comments, in the order a device is built - parameters, geometry,
doping, contacts, mesh, build. Two structured formats are also available under
Generation options. All three describe the same device.

It also **reads** SDE: open an `.scm` file, paste commands, or drag a file onto
the page. The input is recognised by its content, so a saved file and a pasted
fragment take the same path. A loaded structure is then measured - architecture,
gate, stack, junctions, doping, contacts, mesh - and checked for overlaps, gaps,
disconnected regions and contacts that land on nothing.

No Python, no Flask, no backend, no Node.js, no npm and no build step.
Everything runs in the browser.

---

## Features

**Generator**

- All three study parameters: `T_NS`, `W_NS`, `T_FORK`
- All nine fixed design constants exposed under Advanced:
  `L_PAD`, `T_SPACER`, `L_G`, `T_HFO2`, `T_METAL`, `T_LINER`, `T_BRIDGE`,
  `T_SUB`, `T_WELL`, plus the three mesh minimums
- Every dependent coordinate recomputed from those inputs, exactly as the
  Python `compute()` does
- Full validation: input sanity, mesh-resolution warnings, and eleven
  geometric checks (overlaps, gate connectivity, metal-to-silicon contact,
  source-channel-drain continuity, HfO<sub>2</sub> collar closure, spacer
  interference, nMOS/pMOS isolation, contact placement)
- Three generation modes: single case, sweep one parameter at a time,
  and full grid, matching the Python `SWEEP_MODE` options
- Mesh prefix `auto` or a fixed custom name
- Three output formats: step-by-step commands (default), the V8 helper
  procedures, or those procedures with their comments
- Download the `.scm`, or copy it to the clipboard

**Structure analysis**

- Every loaded or generated structure is measured and reported: architecture,
  gate length and position, channel count, thickness, width and pitch, source
  and drain dimensions, extension lengths, junction planes, spacer and collar
  thicknesses, fork wall dimensions, substrate and well depths, doping per
  region, material assignments, contact pick points and mesh refinements
- Around 100 measured values for the default structure, each recording which
  regions it was measured from
- Architecture is inferred from geometry, not from names or the file
  extension, so it works on files this app did not generate
- A consistency check runs before every generation and reports overlaps,
  empty gaps, disconnected regions, invalid contacts and degenerate boxes.
  Errors block the download; nothing inconsistent can be saved

**Editable parameters**

- Primary geometry: `T_NS`, `W_NS`, `T_FORK`, `N_SHEETS`
- Twelve design constants: pad length, spacer, gate length, collar, gate
  metal, liner, bridge, substrate and well depths, three mesh minimums
- Nine doping concentrations, one per profile
- `N_SHEETS` rebuilds the whole stack: sheet bands, inter-gate metal bands,
  collar slabs, spacer pieces and doping placements all follow. Verified from
  1 to 8 sheets, every one geometrically consistent
- Changing any parameter recomputes every dependent coordinate, so source,
  channel and drain stay connected, the collar stays closed, spacers stay
  against the gate and contacts stay on their regions - these are checked,
  not assumed

**Input**

- Open an `.scm` file, paste SDE text, or drop a file anywhere on the page
- The format is detected from the content, not the file extension, so a
  `.txt` holding SDE commands is read correctly
- Input that binds `T_NS`, `W_NS` and the fork wall is loaded into the
  controls and drives the parametric model, sweeps and validation included
- Any other SDE text is shown as geometry: the regions go to the 3D preview
  and the script panel gets the same commands written back out cleanly
- Procedure definitions are expanded, so a script whose geometry is built by
  a helper called once per transistor is read correctly

**Script view**

- The generated commands, numbered line by line
- Line numbers come from a CSS counter, so selecting the text copies the
  commands without the gutter
- Copy, Download and Expand; expanding hands the whole centre column to the
  script

**Live 3D preview**

- Rebuilds whenever a parameter changes
- Every region drawn at its real cuboid coordinates
- Unique colour per material, identical to `models/region.py`
- Rotate, zoom and pan
- Click a region to select and highlight it
- Selected region name, material, all six bounds, three lengths and volume
- Camera presets: Front, Back, Left, Right, Top, Bottom, Isometric, Reset
- Perspective and orthographic projection
- Surface and wireframe modes, opacity slider, edge toggle
- XYZ axes indicator
- Resizes correctly with the browser window, with the sidebars, and after an
  Android orientation change

**Interface layout**

- Three-column workspace: parameters on the left, preview and generated SCM in
  the centre, region inspector on the right
- Both sidebars are independently resizable by dragging the handle beside them.
  Arrow keys nudge a focused handle, `Home` or a double click restores the
  default width, and the widths are remembered between visits
- Both sidebars scroll on their own; the centre column keeps whatever width is
  left and is never allowed below 380 px
- Either sidebar can be collapsed entirely from the header, which hands its
  width to the 3D preview
- Below 1000 px the sidebars become off-canvas drawers over a scrim, opened
  from the header and closed by the header button, the drawer's close button,
  the scrim or `Escape`. The preview keeps the full width underneath
- Generate and Download are mirrored in the header, so the primary actions stay
  reachable while the parameters panel is closed
- Verified at 1920x1080, 1600x900, 1440x900, 1366x768, 1280x720, 1002x700,
  and on Android portrait (412x915, 360x640) and landscape (915x412)

---

## Project structure

```
project/
├── index.html          all generator controls, preview, SCM output
├── Readme.md
├── css/
│   └── style.css       dark engineering / TCAD interface
└── js/
    ├── generator.js    compute, validate, buildScm, buildFlatScm, import, layout
    ├── sde-parser.js   reader and evaluator for SDE text; window.SDE
    ├── analyze.js      parameter extraction + consistency check; window.SDEAnalyze
    └── preview.js      Three.js scene, picking, cameras
```

---

## Running it

**Locally.** Open `index.html` in a browser. That is the whole procedure.

Three.js is loaded as a classic (non-module) script, which is deliberate: ES
modules are blocked over `file://` URLs, so a module-based page would not open
from disk. Pinning `three@0.147.0` gets the last release that ships both the
UMD build and `examples/js/controls/OrbitControls.js`.

If you prefer to serve it:

```bash
python -m http.server 8000     # then open http://localhost:8000
```

**GitHub Pages.**

1. Push these files to a repository, with `index.html` at the repository root.
2. **Settings → Pages**.
3. **Source**: Deploy from a branch.
4. Branch **main**, folder **/ (root)**.
5. Save. The site appears at `https://<username>.github.io/<repo>/`.

All asset paths are relative, so it works at the site root and at a project
sub-path alike.

---

## How to use it

1. Set **T_NS**, **W_NS** and **T_FORK**. The preview updates as you type.
2. The status panel reports validity. Errors block generation and say exactly
   what is wrong; warnings let generation proceed.
3. Press **Generate** to produce the SCM text and show it at the bottom.
4. Press **Download .scm** to save it. The filename follows the Python
   convention: `fork_TNS_0.006_WNS_0.030_TFORK_0.008.scm`.
5. For a sweep, change **Mode**, enter comma-separated value lists, and press
   **Download all cases**. Files download one after another with a short gap,
   since browsers throttle rapid successive downloads.
6. Change **Output format** if you want one of the structured forms rather
   than the default step-by-step script.
7. Press **Reset** to restore every default.

To read an existing script instead, open the **Import SDE / SCM** panel,
press **Open** in the header, or drag a file onto the page.

In the preview: left-drag rotates, right-drag pans, scroll zooms, and clicking
a region selects it and fills the inspector.

---

## Relationship to the Python generator

`gen_forksheet.py` is the source of truth. These parts were carried across
without change in behaviour:

| Python | JavaScript |
|---|---|
| `compute(t_ns, w_ns, t_fork)` | `compute(t_ns, w_ns, t_fork, C)` |
| `region_list(g)` | `regionList(g, C)` |
| `validate(...)` | `validate(...)` |
| `build_scm(g, mesh_prefix)` | `buildScm(G, meshPrefix, C)` |
| (n/a - browser-only) | `buildFlatScm()` step-by-step emitter |
| (n/a - browser-only) | `stripScmComments()`, `emitScm()` |
| (n/a - browser-only) | `window.SDE.parse()` / `.detect()` / `.format()` |
| (n/a - browser-only) | `window.SDEAnalyze.analyze()` / `.check()` |
| `case_name(...)` | `caseName(...)` |
| `n(v)` number formatter | `n(v)` |
| `SWEEP_MODE` one_at_a_time / full_grid | Mode dropdown |

The SCM template was converted mechanically from the Python f-string rather
than retyped; the original port was diffed byte for byte against the Python
output. `buildScm()` is still that verbatim emitter. Comment stripping is a
separate pass in `stripScmComments()`, applied afterwards by `emitScm()`, so
the annotated text is never altered - only optionally reduced.

Current output, measured across the six reference cases. Every case produces
88 regions, 5 materials, 7 contacts, 25 doping placements and 23 refinements
in every format:

| case | step-by-step | structured | annotated |
|---|---|---|---|
| `fork_TNS_0.004_WNS_0.022_TFORK_0.007` | 259 lines, 16102 B | 282 lines, 11563 B | 482 lines, 22926 B |
| `fork_TNS_0.004_WNS_0.030_TFORK_0.008` | 259 lines, 16096 B | 282 lines, 11557 B | 482 lines, 22917 B |
| `fork_TNS_0.005_WNS_0.020_TFORK_0.006` | 259 lines, 16095 B | 282 lines, 11558 B | 482 lines, 22915 B |
| `fork_TNS_0.006_WNS_0.015_TFORK_0.010` | 259 lines, 16101 B | 282 lines, 11560 B | 482 lines, 22931 B |
| `fork_TNS_0.006_WNS_0.030_TFORK_0.008` | 259 lines, 16095 B | 282 lines, 11556 B | 482 lines, 22918 B |
| `fork_TNS_0.008_WNS_0.025_TFORK_0.012` | 259 lines, 16104 B | 282 lines, 11563 B | 482 lines, 22935 B |

The step-by-step script is longer in bytes than the structured one because
each cuboid is written out instead of being produced by a procedure called
twice; it is the same 88 regions either way.

Equivalence is not asserted, it is checked. The test parses the step-by-step
output and the annotated output with `window.SDE` and compares the resulting
region lists - name, material and all six bounds - plus the doping
placements, contacts, refinements and mesh prefix. It also compares the
step-by-step regions against `regionList()` directly. Parentheses stay
balanced, every line is a complete command, and no `;` survives in the
comment-free formats, including when a custom mesh prefix contains one.

Sweep case counts: 8 for one-at-a-time, 27 for the full grid.

The analyser is checked the same way, against a structure whose inputs are
known: it must measure back exactly what the generator was given. Sheet
thickness, width, pitch, gate length, spacer, collar, liner, substrate and
well depths, fork wall thickness, sheet count and column count all match.

The consistency checker is checked in both directions - it must stay silent
on a valid structure and must not. An early pairwise version reported 13
"gaps" in a perfectly good device, because in a gate-all-around stack the
channel sits a collar-thickness from the gate metal by design and that space
is filled by the collar. It now samples the volume between two regions and
only reports a gap if that volume is empty. On a deliberately broken
structure it still detects the overlap, the island, the sub-nanometre gap
and the contact that lands on nothing.

| sheets | regions | doping placements | inter-gate bands | consistency |
|---|---|---|---|---|
| 1 | 48 | 13 | 0 | clean |
| 2 | 68 | 19 | 1 | clean |
| 3 | 88 | 25 | 2 | clean |
| 4 | 108 | 31 | 3 | clean |
| 6 | 148 | 43 | 5 | clean |
| 8 | 188 | 55 | 7 | clean |

A note on scope: SDE geometry files do not carry a work function. A contact
set stores a name, a colour and a display line width; the work function is a
device property and belongs in `sdevice.cmd`. The analyser says so rather
than inventing a value.

Output from this generator was loaded into the SCM Device Viewer and passed
all eleven geometry checks: 88 regions, 5 materials, 7 contacts, no overlaps,
both gates connected.

---

## Browser support

Any modern desktop browser with WebGL: Chrome, Edge, Firefox or Safari.
An internet connection is needed on first load to fetch Three.js from the CDN.
To run fully offline, download `three.min.js` and `OrbitControls.js` into
`js/vendor/` and point the two `<script src>` tags at them.

If `OrbitControls.js` fails to load, `preview.js` falls back to its own orbit
controller, so rotate, zoom and pan keep working.

---

## Licence

Add a `LICENSE` file and state the licence here before publishing.
