# Forksheet CMOS SCM Generator

**Live app:** <https://santhosh111706.github.io/ForkSheet-Device-Generator/>

A **static, browser-only** parametric generator for 3D Forksheet CMOS
Sentaurus SDE geometry, with a live interactive 3D preview.

It is a direct port of the Python generator `gen_forksheet.py` and emits the
**V13** structure: a two-layer gate stack (interfacial SiO<sub>2</sub> with
HfO<sub>2</sub> outside it), retrograde P and N wells over a 200 nm device
domain, a single asymmetric gate bridge per transistor, and an n-well tap so
the pFET body is not left floating. The generated `.scm` files are compatible
with the SCM Device Viewer project.

Output is a **step-by-step script**: every command written out one by one,
no comments and no `(define ...)` block - each coordinate is a literal
number, so every line stands on its own. The order is the order a device is
built: geometry, doping, contacts, mesh, build. That is the only output
style; there is no option to emit helper procedures or a define block.

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

- The six primary self-heating study variables, all sweepable:
  `T_NS` (nanosheet thickness), `W_NS` (nanosheet width), `L_G` (gate
  length), `T_SPACER` (spacer thickness), `L_PAD` (source/drain length)
  and `N_SHEETS` (number of nanosheets)
- All nine fixed design constants exposed under Advanced:
  `L_PAD`, `T_SPACER`, `L_G`, `T_IL`, `T_HFO2`, `T_METAL`, `T_LINER`,
  `T_BRIDGE`, `T_DOMAIN`, `T_WELL`, plus the mesh size control
- Six doping concentrations as parameters, not constants: `N_SUB`,
  `N_WELLP`, `N_WELLN`, `N_CHAN`, `N_EXT`, `N_SD`
- Every dependent coordinate recomputed from those inputs, exactly as the
  Python `compute()` does
- Full validation: input sanity, mesh-resolution warnings, and eleven
  geometric checks (overlaps, gate connectivity, metal-to-silicon contact,
  source-channel-drain continuity, HfO<sub>2</sub> collar closure, spacer
  interference, nMOS/pMOS isolation, contact placement)
- Three generation modes: single case, sweep one parameter at a time,
  and full grid, matching the Python `SWEEP_MODE` options
- Any subset of seven variables can be swept - the six above plus
  `T_FORK` - each with its own value list, with a live case count
- Mesh prefix `auto` or a fixed custom name
- A mesh size control that rescales every refinement in the emitted script,
  preserving the ratios between them so the channel, the dielectric
  interfaces and the source/drain junctions stay finer than the bulk
- Download the `.scm`, or copy it to the clipboard

**SDevice**

Checked against the Sentaurus Device tutorial and user guide, and the deck
now covers: the `File` section including the `Parameter` .par file;
per-electrode `Voltage`, `Workfunction`, `Resistor`, `Schottky` and
`Barrier`; drift-diffusion, Thermodynamic and Hydrodynamic transport;
mobility, recombination, bandgap-narrowing, interface and tunnelling
models; the full `Plot` dataset list including driving forces and
generation; `Math` with `ErrRef`, `Number_Of_Threads`, `Transient` scheme
and `PlotExplicit`; and `Solve` with `Quasistationary` (including
`Decrement`), `Transient`, `ACCoupled` small-signal, and current-driven
sweeps via `set(... mode current)`.

- A **Generate SDevice** button opens a separate window: load or paste an
  SCM, analyze it, configure, generate `sdevice.cmd`, validate, edit, export
- The deck is built from the **parsed structure, not a template**. Every
  electrode is a contact that exists in the file, every region named in
  `CurrentPlot` is a region that exists, and the `Grid` filename comes from
  the file's own `sde:build-mesh`. Load a seven-contact structure and you
  get seven electrodes; load an eight-contact one and you get eight
- Electrode roles are read from the contact names - gate, source, drain,
  well, bulk, and the n/p device each belongs to - so the bias ramps are
  built per device with the PMOS polarities negated
- Plain Sentaurus syntax throughout: no macros, no parameter blocks, no
  intermediate definitions. The generated file is meant to be read and
  edited by hand
- Configurable: physics models, self-heating and its thermal contact, bias
  sweeps and workfunctions, solver and output, plus a mesh-size slider
- Validation before generation, reported as a `✓ / ⚠ / ✗` list. Errors
  block generation rather than producing a deck that would abort - or
  worse, run and give plausible numbers for the wrong structure
- The code view has line numbers, syntax highlighting, search, an editable
  mode, Copy, Download and Regenerate

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
- A consistency check runs before every generation. Errors block the
  download; nothing inconsistent can be saved
- **Overlaps are not errors.** SDE resolves intersecting bodies by the
  current boolean rule, and a later `create-cuboid` replacing part of an
  earlier one is a normal way to build a structure. Overlaps are reported
  as information. What IS an error is the consequence: a region so
  completely replaced by later ones that it does not survive into the final
  structure, because any doping or contact attached to it is attached to
  something that is no longer there
- Also checked: empty gaps, disconnected regions, invalid contacts,
  degenerate boxes, doping placed on regions or profiles that do not exist,
  semiconductor regions with no doping at all, gate metal meeting
  semiconductor with no dielectric between, and regions an identified
  architecture requires but does not have
- An alignment group reports the relationships rather than bare numbers:
  source-to-gate and drain-to-gate distances, source/drain symmetry,
  channel-to-gate and channel-to-source/drain continuity, spacer-to-gate
  and spacer-to-source abutment, inner and outer spacer pieces, dielectric
  enclosure, nFET/pFET stack alignment and complementary device spacing -
  each with a verdict, not just a measurement

**Editable parameters**

- The six study variables: `T_NS`, `W_NS`, `L_G`, `T_SPACER`, `L_PAD`,
  `N_SHEETS`
- Design constants: `T_FORK`, collar, gate metal, liner, bridge, substrate
  and well depths, three mesh minimums
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
- Input that yields a nanosheet thickness, width and fork wall is loaded
  into the controls and drives the parametric model, sweeps and validation
  included. The values come from `(define ...)` bindings where the file has
  them, and are otherwise **measured from the geometry** - which is what
  makes the step-by-step output round-trip despite carrying no defines, and
  what lets any forksheet file be loaded, not only ones this app wrote
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
- Contacts drawn as the FACES they are, not as labels: `set-contact-faces`
  names a whole region face, so each electrode is a coloured quad on that
  face at its real size and orientation, with its pick point marked. Click
  one for its name, type, the region and material it sits on, its extent
  and its area. A contact that cannot be resolved to a single face - never
  placed, missed every region, or landed on an edge - keeps a marker so it
  stays visible as a fault
- Every region drawn at its real cuboid coordinates
- Unique colour per material, identical to `models/region.py`
- Rotate, zoom and pan
- Click a region to select and highlight it
- Selected region name, material, all six bounds, three lengths and volume
- Camera presets: Front, Back, Left, Right, Top, Bottom, Isometric, Reset
- Perspective and orthographic projection
- Surface and wireframe modes, opacity slider, edge toggle
- XYZ axes indicator
- **Contact markers** drawn at each pick point, colour-coded and labelled.
  Drawn at the point, not over the region, so a misplaced contact is
  visibly floating in space or buried inside the structure
- **Cross-section**: a cutting plane on X, Y or Z with a position slider
  and a flip, for inspecting the inside of the stack
- **Measurement**: click two regions for centre-to-centre distance and the
  face-to-face gap on each axis, drawn in the scene and reported in full
- **Problem highlighting**: every validation finding is clickable and
  outlines the regions it refers to, so "these two overlap" becomes
  something you can look at
- **Validation badge** over the canvas, always showing the current verdict

**Doping visualization**

- A Colour control switches the 3D view between three modes: material,
  doping concentration, and material + doping combined, where doped
  regions take their doping colour and everything else keeps its material,
  with n-type in red and p-type in blue
- n-type is blue and p-type red, darkening with concentration, so N+, N,
  N-, P+, P and P- are all distinguishable at a glance
- The legend follows the mode and lists only the classes actually present,
  each with its concentration range and region count
- Selecting a region reports its doping type, net concentration and the
  profiles placed on it
- Every colour comes from the profiles in the loaded file. A region with no
  placement is reported as undoped rather than given a plausible default
- A region carrying more than one profile is resolved by net doping -
  donors minus acceptors - so a counter-doped region is typed correctly
  rather than taking whichever profile happened to be listed last
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
    ├── generator.js    compute, validate, buildFlatScm, import, layout
    ├── sde-parser.js   reader and evaluator for SDE text; window.SDE
    ├── analyze.js      parameter extraction + consistency check; window.SDEAnalyze
    ├── sdevice.js      sdevice.cmd from a parsed structure; window.SDevice
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

1. Set the six study parameters. The preview updates as you type.
2. The status panel reports validity. Errors block generation and say exactly
   what is wrong; warnings let generation proceed.
3. Press **Generate** to produce the SCM text and show it at the bottom.
4. Press **Download .scm** to save it. The filename follows the Python
   convention: `fork_TNS_0.006_WNS_0.030_TFORK_0.008.scm`.
5. For a sweep, change **Mode**, tick the variables to vary, give each a
   comma-separated list, and press **Download all cases**. The case count
   updates live. Files download one after another with a short gap, since
   browsers throttle rapid successive downloads.
6. Press **Reset** to restore every default.

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
| `build_scm(g, mesh_prefix)` | `buildFlatScm(G, meshPrefix, C)` |
| (n/a - browser-only) | `buildFlatScm()` step-by-step emitter |
| (n/a - browser-only) | `emitScm()` |
| (n/a - browser-only) | `window.SDE.parse()` / `.detect()` / `.format()` |
| (n/a - browser-only) | `window.SDEAnalyze.analyze()` / `.check()` |
| `case_name(...)` | `caseName(...)` |
| `n(v)` number formatter | `n(v)` |
| `SWEEP_MODE` one_at_a_time / full_grid | Mode dropdown |

There is one emitter, `buildFlatScm()`, and it writes geometry straight from
`regionList()` - so the build order has a single source of truth rather than
a template kept in step with it by hand.

Current output at the default geometry: **224 lines, 18513 bytes, zero
`(define ...)` lines and zero comments**, giving 110 regions, 5 materials,
8 contacts, 25 doping placements and 31 refinements.

The region count scales with the sheet count: 54 regions at one nanosheet,
110 at three, 250 at eight. Nothing in the output assumes three sheets,
because nothing in it is a symbol - every coordinate is a literal.

All fourteen parametric inputs can be recovered from a generated file by
measurement alone - `T_NS`, `W_NS`, `T_FORK`, `L_G`, `T_SPACER`, `L_PAD`,
`N_SHEETS`, `T_IL`, `T_HFO2`, `T_METAL`, `T_LINER`, `T_BRIDGE`, `T_DOMAIN`,
`T_WELL` - checked exactly against the values the generator was given.
The interfacial layer and the gate liner are both SiO<sub>2</sub> and the
interfacial layer is the thinner of the two, so they are told apart by
geometry: the interfacial oxide is the one built against the high-k.

Equivalence is not asserted, it is checked. The test parses the generated
output with `window.SDE` and compares the resulting region list - name,
material and all six bounds - against `regionList()` directly, and against
the reference V13 script, including its doping placements, profiles,
contacts and refinements. Parentheses stay balanced, every line is a
complete command, and no `;` and no `(define` survive, including when a
custom mesh prefix contains a semicolon.

**Sweep case counts.** The original three-variable sweep is unchanged: 8
for one-at-a-time, 27 for the full grid over `T_NS`, `W_NS` and `T_FORK`.
With the six study variables ticked, one-at-a-time gives 14 cases (18 list
entries minus the 4 that repeat the control value). A full grid over all
six would be 3^6 = 729 separate downloads, so the case count is shown live
and anything past 300 is refused with an explanation rather than attempted.

**File naming.** A sweep over a variable that is not in the legacy name
would otherwise write every case to the same filename and silently save
one file several times. The legacy stem is kept, and any variable that
actually varies in that sweep is appended:

```
fork_TNS_0.006_WNS_0.030_TFORK_0.008_LG_0.014.scm
fork_TNS_0.006_WNS_0.030_TFORK_0.008_LG_0.020.scm
fork_TNS_0.006_WNS_0.030_TFORK_0.008_TSP_0.004_NNS_2.scm
```

A sweep over only `T_NS`, `W_NS` and `T_FORK` produces exactly the
filenames it always did. The mesh prefix follows the filename, so each
case writes its own `_msh.tdr`.

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

**The SDevice generator is checked against two different structures.** The
app's own output has seven contacts; the V13 reference has eight, the extra
one being an `nwell` electrode on the pFET body. The same code produces a
seven-electrode deck for the first and an eight-electrode deck for the
second, with the right `Grid` filename in each, and reports "no well or body
electrode for the PMOS" only for the one that genuinely lacks it. That is
the test that a template would fail.

**Mesh size is an SCM control, not an SDevice one.** By the time SDevice
runs, the mesh is already a `.tdr` file - refinement is defined in the SDE
script. So there are two mesh controls, and they do different things:

- **Generation options -> Mesh size** rewrites every
  `sdedr:define-refinement-size` in the SCM this app generates. It is the
  real control: change it and the mesh snmesh builds changes. The whole
  table is scaled rather than flattened, so the ratios that carry the
  refinement strategy survive - the junctions and the gate dielectric stay
  finer than the bulk at every setting. 2 nm is the baseline and emits the
  refinement lines unchanged, down to the trailing zeros.
- **SDevice window -> Mesh size** is for a structure loaded from elsewhere.
  It writes a refinement block to paste into that SCM before meshing,
  since this app did not generate it and cannot rewrite it in place.

Two notes on scope, because the honest answer is more useful than a
plausible-looking number:

**EOT is derived, not stored.** Equivalent oxide thickness needs the
permittivity of the dielectric, which SDE does not record. The analyser
computes it from the measured physical thickness and names the constant it
used, so the figure can be rescaled for a different k.

**Work function is not in a `.scm`.** A contact set stores a name, a colour
and a display line width - the numeric argument to
`sdegeo:define-contact-set` is the line width, not a work function. Work
function is a device property and belongs in `sdevice.cmd`. The analyser
reports this rather than inventing a value.

**Some listed features are not present in this architecture.** There is no
STI in the Forksheet baseline - isolation is the Si3N4 fork wall and the
well split - and the source/drain pads are not raised. The analyser reports
what the loaded structure actually contains; it will report STI or raised
source/drain if a file that has them is loaded, and says nothing about them
when it is not.

Output from this generator was loaded back into its own viewer and passed
all eleven geometry checks: 110 regions, 5 materials, 8 contacts, no
overlaps, no gaps, both gates connected, both dielectric collars closed.

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
