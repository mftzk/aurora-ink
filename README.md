# Aurora Ink

A calm, generative ambient scene: flowing aurora ribbons suspended in liquid ink, a whispering
nebula behind them, and slow motes of light leaving soft trails. It is built to be left running as
a wallpaper — never chaotic, never flashing.

Built with **Next.js**, plain **ESM JavaScript** for the graphics layer, and hand-written **WGSL**
on raw **WebGPU**. No WebGL, no shader libraries, no npm dependencies beyond `next`/`react`.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

Everything is generated on the GPU at runtime. If the browser has no WebGPU adapter (or the device
is lost) the app honestly falls back to a Canvas 2D renderer with the same mood and controls, and
the panel badge changes from `WebGPU` to `Canvas 2D (fallback)`.

## Controls

The tucked-away panel lives in the bottom-right; the circular button (or the `H` key) hides it.
All sliders are `0..1`.

| control | effect |
|---|---|
| Flow | flow + noise drift speed (`mix(0.03, 0.9, v)` uv/s) |
| Glow | bloom strength, emissive scale and exposure |
| Trails | ink dissipation per 1/60 s (`mix(0.955, 0.9985, v)`) |
| Interaction | pointer swirl and ripple amplitude |
| Density | aurora emission and particle count |
| Palette | five palettes, crossfaded over 1.6 s |

Pointer movement bends the flow tangentially (it should feel like pushing silk); clicking raises a
soft expanding ripple. After a long idle spell the scene quietly ripples on its own so it never
looks frozen.

## How it works

`app/lib/webgpu/` is deliberately DOM-free and is driven directly by the verification harness.

- **shaders.js** — the WGSL for every pass, the five palettes, the 176-byte uniform layout and the
  particle capacity. A shared `COMMON` block (quintic value-noise, fbm, palette lookup, radial
  swirl/ripple helpers) is concatenated into each module so every module compiles standalone.
- **pipelines.js** — explicit `GPUBindGroupLayout`s (never `layout: "auto"`) and the eight
  pipelines, memoising one `GPUShaderModule` per pass per device.
- **scene.js** — owns the ping-pong velocity/dye fields, the emissive and bloom mip chain, the
  particle storage buffer and the per-frame pass order. `update(dt)` advances the sim by `dt` only
  and submits the simulation; `render(view)` composites into a caller-supplied view and submits its
  own command buffer.
- **renderer.js** — the only DOM-touching file: canvas, capped DPR, `ResizeObserver`, RAF loop,
  pointer input, idle heartbeat, and the WebGPU→Canvas 2D switch.
- **canvas2d/renderer.js** — the fallback: drifting palette blobs, three soft aurora ribbons built
  from parallel low-alpha strokes, a few hundred curved light traces through a cheap sin/cos curl,
  additive `lighter` compositing, ripple rings and a vignette.

### Passes per frame

1. **velocity** — curl-style noise flow, large-scale vortices, two slowly orbiting emitters,
   pointer swirl, ripple impulses and edge damping. Laminar and slow.
2. **dye** — semi-Lagrangian advection of the ink, then two layered aurora ribbon systems (a main
   band plus a fainter, differently angled one behind it), broken up by a large-scale noise mask so
   the glow appears and dissolves irregularly instead of forming geometric wedges, plus ripple rings.
   Emission is scaled by the frame's dissipation, so the ink's steady-state density is stable at any
   trail length. Ribbons are deliberately *wide and soft*: at half resolution, semi-Lagrangian
   advection diffuse hairline spines away within a few frames, so a wide band is what actually
   survives on screen (and it is what real aurora looks like anyway).
3. **particlesUpdate** — particles integrated with inertia through the velocity field, aged and
   respawned.
4. **particleDraw** — additive soft sprites elongated 4–7× along velocity into the half-resolution
   emissive target. Motes are small and dim by design (`~0.0012` per device pixel at full density):
   big bright sprites turn the frame into a woven fabric of streaks rather than drifting light.
5. **bright** — soft-knee threshold of dye + emissive into bloom mip 0.
6–7. **downsample ×3 / upsample ×3** — a small tent bloom chain.
8. **composite** — dark base `#05070c`, slowly drifting domain-warped nebula, dye, emissive and
   bloom, a filmic tonemap, a gentle vignette and a static per-pixel 1/255 dither.

## Verification

The scene is verified against real pixel readbacks, not source inspection.

- `bash tools/run_wgpu_check.sh` renders the real scene through Deno + wgpu on the software Vulkan
  driver (lavapipe) and checks: every WGSL module compiles, every pipeline builds for both
  `rgba8unorm` and `bgra8unorm`, the frame is dark but structured, motion is real yet gentle,
  ripples brighten then decay, all five palettes render with the right warm/cool statistics,
  particles are visible and the density slider changes the image, and `resize()` reallocates
  cleanly. Frames are written to `tools/out/` for eyeballing.
- `npm run build` — production build (Next 16 + Turbopack).
- `bash tools/run_qa.sh` — Playwright against a local production server: no page errors, the canvas
  covers and draws the viewport, the renderer badge is honest, every slider and palette works, the
  panel toggles, and the backend switch is graceful.
- `bash tools/run_preview.sh [palette]` — fast (~1 min) preview render at 384×216 that writes frames
  to `tools/preview/` for art direction while tuning the shaders.

All three gates pass.
