# Forksheet CMOS SCM Generator

A **static, browser-only** parametric generator for 3D Forksheet CMOS
Sentaurus SDE geometry, with a live interactive 3D preview.

It is a direct port of the Python generator `gen_forksheet.py`. The generated
`.scm` files are **byte-identical** to the Python output for the same inputs,
and are compatible with the SCM Device Viewer project.

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
- Download the `.scm`, or copy it to the clipboard

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
├── README.md
├── css/
│   └── style.css       dark engineering / TCAD interface
└── js/
    ├── generator.js    port of gen_forksheet.py: compute, validate, buildScm
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
6. Press **Reset** to restore every default.

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
| `case_name(...)` | `caseName(...)` |
| `n(v)` number formatter | `n(v)` |
| `SWEEP_MODE` one_at_a_time / full_grid | Mode dropdown |

The SCM template was converted mechanically from the Python f-string rather
than retyped, and the output was then diffed against the Python generator:

```
IDENTICAL  fork_TNS_0.004_WNS_0.022_TFORK_0.007.scm  (23026 bytes)
IDENTICAL  fork_TNS_0.004_WNS_0.030_TFORK_0.008.scm  (22966 bytes)
IDENTICAL  fork_TNS_0.005_WNS_0.020_TFORK_0.006.scm  (22964 bytes)
IDENTICAL  fork_TNS_0.006_WNS_0.015_TFORK_0.010.scm  (22980 bytes)
IDENTICAL  fork_TNS_0.006_WNS_0.030_TFORK_0.008.scm  (22967 bytes)
IDENTICAL  fork_TNS_0.008_WNS_0.025_TFORK_0.012.scm  (22984 bytes)
6 identical, 0 differing
```

Validation was checked to return the same error and warning counts as the
Python version across eight cases, valid and invalid. Sweep case counts match
too: 8 for one-at-a-time, 27 for the full grid.

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