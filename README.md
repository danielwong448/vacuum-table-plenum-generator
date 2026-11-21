# Vacuum Table Plenum Generator

A zero-build, portable web application for designing a 4-quadrant CNC vacuum table plenum from 3/4" MDF and generating clean GRBL v1.1 G-code, featuring live 2D and hardware-accelerated WebGL 3D previews plus STEP and DXF CAD exports.

## Features

- **Flexible Sheet Size (`49" × 97"` Default)**: Automatically populates `49" × 97" × 0.75"` MDF with editable width, length, thickness, outer margin (`1.5"` default), and zone dividers.
- **Live 2D & 3D Split Preview**: Side-by-side interactive 2D CAD drawing and live 3D WebGL model (`Iso`, `Top`, and close-up `Inlet` camera views with drag-to-orbit, scroll-to-zoom, and Shift+drag pan).
- **1:1 Square Pad Mode**: Displays live pad dimensions and optionally overrides the vertical or horizontal zone divider spacing so every vacuum pad has an exact 1:1 aspect ratio.
- **Click-to-Edit Inlet Dimensions**: Click the blue `Between L/R`, `From Front`, or `Between F/B` dimension pills directly on the 2D drawing to position the four inlet holes (with optional front/back symmetry).
- **Recessed Flange Pockets & Spiral Clearing**:
  - Automatically clears grid pads within a user-defined radius (`1.5"` default) around each inlet hole at a dedicated **Pocket Depth** (`0.5"` / `1/2"` default) using a center-outward spiral/offset toolpath with adjustable **Pocket Stepover** (`3 mm` default).
  - Configurable **Cut-Through Depth** (`0.77"` default) and optional **4 × `2mm × 2mm` holding tabs** at the bottom of each inlet cutout.
- **Zig-Zag Grid Slot Entry Ramps**: User-defined entry ramp angle (`30°` default) that ramps into each grid slot, cuts slightly forward, reverses at full pass depth to clear the ramp wedge, and completes the single-slot cut.
- **CAD & Design Exports**:
  - **STEP 3D Solid (`.step`)**: Watertight AP214 manifold B-Rep model in millimeters.
  - **Top-View DXF (`.dxf`)**: AutoCAD R12 layered 2D drawing in active units (`in` or `mm`).
  - **Plenum Design (`.json`)**: Save and reload full design parameters and preferences.
- **Preferences Menu**: Top-left menu includes **Dark Mode**, **Element Size (`Small` / `Regular`)**, and **Units (`in` / `mm`)**.
- **GRBL Toolpath Order**:
  1. Outside perimeter rectangle for each quadrant (`FL` → `FR` → `BR` → `BL`)
  2. Four cut-through inlet holes (`G3` arcs, with optional holding tabs)
  3. Quadrant-by-quadrant: straight vertical slots → horizontal slots → spiral recessed flange pocket clearing

## Direct GitHub Pages Deployment

After pushing once to a public GitHub repository (`git remote add origin <URL>`), run:

```bash
./deploy.sh "Your commit message"
```

This runs the automated test suite (`node tests/verify.js`), commits changes, and pushes directly to `origin main` so GitHub Pages updates automatically.

## GRBL Machine Setup

- **Work Origin (`X0, Y0`)**: Front-Left corner of the MDF sheet (`+X` right, `+Y` back).
- **Z Origin (`Z0`)**: Top surface of the MDF sheet (cuts use negative Z depths).
- **Units**: `G21` (metric millimeters).
- **Defaults**: `24,000 RPM`, `3000 mm/min` feed rate, `1000 mm/min` plunge rate, `5 mm` stepdown per pass, `10 mm` safe Z, `30°` zig-zag ramp angle.
