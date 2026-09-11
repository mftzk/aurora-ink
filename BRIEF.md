# BRIEF — "Aurora Ink": a calm WebGPU generative scene (Next.js + vanilla JS + WGSL)

You are building a **premium ambient visual** — the kind of thing someone leaves running as a
desktop wallpaper. Beauty first. Nobody is benchmarking anything.

Target feeling: **flowing aurora + liquid ink + soft nebula + slow particles + subtle light
trails**, on a dark background. Slow, fluid, organic. Never chaotic, never flashing.

## Hard rules

- **No new npm dependencies.** Only `next`, `react`, `react-dom` (already in package.json).
  No three.js, no gl-matrix, no GLSL libs. Hand-roll every shader, noise function, and layout.
- **WebGPU directly + WGSL.** No WebGL, no shader transpilers.
- **Vanilla JS for the graphics layer** (plain ESM modules + a React wrapper page only).
- **Nothing in the rendering code may touch `window`/`document`/`navigator`.** All files under
  `app/lib/webgpu/` must be importable in Deno without a DOM — that is how they get verified.
- **No debug affordances:** no FPS counter, no frame-time graph, no grid, no wireframe, no
  "WebGPU enabled" banner other than the tiny badge described below, no console noise.
  Debug info in the shipped page = failed task.
- Do **not** add `output: 'standalone'` to `next.config.mjs` (the platform patches it at build time).
- Do not commit build output (`.next`, `node_modules`, `tools/out`) — `.gitignore` already covers it.

## Acceptance gate (run these, iterate until both pass)

1. `bash tools/run_wgpu_check.sh` → must end with `ALL CHECKS PASSED` (exit code 0).
   This harness renders the real scene on a real WebGPU implementation (Deno + wgpu against the
   software Vulkan driver) and judges **real pixel readbacks**: darkness, structure, gentle-but-real
   motion, ripple decay, all five palettes, particle visibility, density slider effect, resize.
   **`tools/wgpu_check.ts` is the contract — it is not a suggestion.** Read it first, satisfy its
   assertions, do not edit it.
2. `npm run build` → must succeed (Next 16 + Turbopack). Fix every warning that is a real error.
3. `bash tools/run_qa.sh` → Playwright QA against a local production server: no page errors, the
   canvas is drawing, the badge reads `Canvas 2D (fallback)` on this GPU-less box, the panel
   toggles, the sliders move, palette buttons switch. (Read the script; the selectors it uses are
   part of the contract.)

## File layout (exact)

```
app/lib/webgpu/shaders.js    WGSL source + palettes + uniform layout constants   (DOM-free)
app/lib/webgpu/pipelines.js  createPipelines(device, format) -> pipelines        (DOM-free)
app/lib/webgpu/scene.js      createGPUScene(device, {format,width,height,config}) (DOM-free)
app/lib/webgpu/renderer.js   browser glue: canvas, RAF loop, pointer, DPR, fallback switch
app/lib/canvas2d/renderer.js Canvas 2D fallback with the same mood
app/page.js                  "use client" page: canvas + minimal UI panel
app/layout.js                metadata (title "Aurora Ink"), viewport, theme-color #05070c
app/globals.css              reset + panel styles (plain CSS, no Tailwind)
app/api/health/route.js      GET -> { ok: true, app: "aurora-ink", webgpu: true }
app/icon.svg                 tiny aurora-ish favicon (hand-written SVG)
app/opengraph-image.js       next/og ImageResponse 1200x630, dark gradient + title
README.md                    what it is, how to run, how it was verified
```

## Public API contracts (the harness imports exactly these)

`app/lib/webgpu/shaders.js`
- `export const WGSL_MODULES = { velocity, dye, particlesUpdate, particleDraw, bright, downsample, upsample, composite }`
  — each value a complete, standalone WGSL module string (>= ~120 chars). Shared helpers may be
  concatenated in, but never leave a module referencing an undeclared symbol.
- `export const PALETTES = [...]` — **exactly 5** entries `{ id, name, colors: [[r,g,b] x4] }`.
  Ids: `deep-ocean`, `purple-nebula`, `sunset-amber`, `emerald-aurora`, `monochrome-blue`
  (index 0..4 in that order; the harness assumes index 2 = warm, index 0 = cool).
- `export const UNIFORM_BYTES = 176;` (11 × vec4) and `export const PARTICLE_CAPACITY = 65536;`

`app/lib/webgpu/pipelines.js`
- `export function createPipelines(device, format)` → `{ velocity, dye, particlesUpdate, particleDraw, bright, downsample, upsample, composite, layouts: {...} }`.
  Use **explicit** `GPUBindGroupLayout`s (not `layout: 'auto'`) so `scene.js` can build bind groups
  predictably, and reuse shared layouts where the binding shape is identical.
  Must be constructible for both `rgba8unorm` and `bgra8unorm` (harness checks both).
- May also export `SIM_TEXTURE_FORMAT = "rgba16float"`.

`app/lib/webgpu/scene.js`
- `export function createGPUScene(device, { format, width, height, config })` → object with:
  - `update(dtSeconds)` — advances simulation **only by dt** (no wall clock), writes uniforms, records+submits every pass for that frame. `dt` is already clamped by the caller.
  - `render(targetViewOrTextureView)` — draws the composite into a caller-supplied view (the harness
    passes an offscreen texture view; the browser passes `context.getCurrentTexture().createView()`).
    `update(dt)` and `render(view)` may be one call internally, but `render(view)` must exist and must
    submit its command buffer itself (the harness submits its readback encoder afterwards; queue
    order guarantees correctness).
  - `resize(width, height)` — reallocates sim/dye/bloom/emissive textures and bind groups; safe to
    call repeatedly with any size >= 64×64.
  - `setConfig(partialConfig)` — merges into the live config; palette changes **crossfade smoothly
    over >= 1.5 s** (CPU-lerp old→new colours into `col0..col3`, publish the blend in `timing.w`).
  - `setPointer({ x, y, strength })` — uv coordinates in 0..1 (x right, y down), strength 0..1 = how
    hard the pointer is currently bending the flow.
  - `addRipple(x, y, strength)` — uv + 0..1; queues a soft expanding ring/energy wave (max 3 live,
    oldest recycled).
  - `destroy()` — releases buffers/textures.
- `export const DEFAULT_CONFIG = { flowSpeed: 0.35, glow: 0.5, trail: 0.6, interaction: 0.5, density: 0.45, palette: 0 }`

## GPU architecture (implement this; it is chosen for softness + depth)

**Uniform buffer** — one buffer, 176 B, written once per frame, bound in every pass:

```wgsl
struct Params {
  res:    vec4<f32>,   // x,y = canvas px;        z,w = velocity grid cells
  timing: vec4<f32>,   // x = sim seconds; y = dt; z = frame index; w = palette blend 0..1
  ptr:    vec4<f32>,   // x,y = pointer uv; z = pointer strength 0..1; w = aspect (w/h)
  ripA:   vec4<f32>,   // x,y = ripple uv; z = normalized age 0..1; w = strength
  ripB:   vec4<f32>,
  ripC:   vec4<f32>,
  col0:   vec4<f32>,   // live palette colour 0 (rgb 0..1, a unused)
  col1:   vec4<f32>,
  col2:   vec4<f32>,
  col3:   vec4<f32>,
  ctrl:   vec4<f32>,   // x flowSpeed, y glow, z trail, w interaction  (all 0..1)
  ctrl2:  vec4<f32>,   // x density 0..1; y = 1/dyeW; z = 1/dyeH; w = unused
}
```

**Textures**
- velocity field: ping-pong `rgba16float`, size `ceil(w/4) x ceil(h/4)`, `TEXTURE_BINDING | STORAGE_BINDING | COPY_DST`.
- dye field: ping-pong `rgba16float`, size `ceil(w/2) x ceil(h/2)`, same usage. Clear both to zero on (re)alloc.
- emissive (particles/traces): `rgba16float`, half res, `RENDER_ATTACHMENT | TEXTURE_BINDING`, cleared each frame.
- bloom mips: 4 levels, `rgba16float`, `RENDER_ATTACHMENT | TEXTURE_BINDING`, sizes w/2, w/4, w/8, w/16 (>= 8 px).
- **everything the blur/upsample/composite chain reads must be `filterable`** — that is why
  `rgba16float` is used everywhere instead of `rg32float`. One `filtering` + `clamp-to-edge` sampler.

**Passes per frame (this order)**
1. `velocity` — compute 8×8 over the velocity grid. Curl-noise flow (2–3 octaves of smooth value or
   simplex noise, domain-warped, slowly drifting in time) + damping toward zero + gentle large-scale
   vortices + 2 slowly **orbiting emitters** that inject rotational flow (so motion never stops) +
   pointer swirl force (tangential, ∝ smoothed pointer velocity × `interaction`) + ripple impulses
   (radial, decaying with age, radius grows over time) + soft wall damping near the edges.
   Result must be **laminar and slow**: max |v| ≈ mix(0.03, 0.9, flowSpeed) uv/s. Guard against NaN.
2. `dye` — compute at dye resolution. Advect `dyeIn` semi-Lagrangian (bilinear `textureSampleLevel`
   of the velocity field, scaled by dt) → `dyeOut` (write storage texture, `rgba16float`).
   Then, additively:
   - **aurora ribbons**: anisotropic stratified noise — sample fbm along a slowly rotating direction,
     `smoothstep(0.45, 0.95, n)` shaped into soft long ribbons, palette gradient across the ribbon
     (`mix(col0,col1,...)`, `col2` for the glow core, `col3` for the hottest core), amplitude ∝ density.
   - 2 orbiting **emitters** (same positions as in the velocity pass) that paint soft palette light
     into the field.
   - ripple rings: a thin bright annulus travelling outward from the click point, fading with age.
   - dissipation: multiply by `mix(0.955, 0.9985, trail)` per 1/60 s (frame-rate compensated:
     `pow(decay, dt*60)`), plus a tiny 3×3 tent diffusion (weight ~0.02) so edges stay liquid.
   - clamp to <= 8.0 to prevent runaway.
3. `particlesUpdate` — compute, workgroup 256, `dispatchWorkgroups(ceil(count/256))`. Storage buffer
   `array<f32>` (6 floats per particle: x, y, vx, vy, life, seed) read_write; the buffer is also used
   as a read-only storage buffer by `particleDraw`, so give it `STORAGE | COPY_DST | VERTEX`-free usage:
   `GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`. Integrate with the velocity field (bilinear
   sample + a little inertia), age the life, respawn dead particles at random uv with a hash from the
   seed. Slow: particles should drift, not dart.
4. `particleDraw` — render pass into the emissive texture, additive `blend: { srcFactor: 'one', dstFactor: 'one' }`,
   `draw(6, activeCount)` with `instance_index` indexing the particle storage buffer (read-only) —
   no vertex buffers. Each particle is a soft radial sprite, **elongated along its velocity** (that is
   where the light trails come from), colour = palette mix by speed + a pale core (`col3`), alpha
   falloff smooth and wide. Keep the peak brightness reasonable (<= ~3.0 before tonemap).
5. `bright` — threshold dye + emissive with a soft knee (`soft = max(0, c - knee)`, knee ≈ 0.55,
   knee softened over ~0.25) into bloom mip 0.
6. `downsample` ×3 — 13-tap tent filter into mips 1..3.
7. `upsample` ×3 — 3×3 tent upsample, added back into the finer mip (subtle, weight ~0.6–0.85).
8. `composite` (fragment → the caller's view): 
   - **procedural nebula background**: 3–4 octave domain-warped noise drifting very slowly, tinted
     with `col0`/`col1` at low amplitude (peak contribution ≈ 0.10–0.18 luminance), vignette-friendly
     dark base `#05070c`.
   - `+ dye * mix(0.85, 1.25, glow)`
   - `+ emissive`
   - `+ bloom * mix(0.35, 1.5, glow)`
   - soft filmic tonemap (`c / (1 + c)` with a tiny toe, or ACES-lite) + gentle vignette
     (min factor ≈ 0.72 in the extreme corners) + **interleaved-gradient-noise dither at 1/255** so
     the dark gradients never band.
   - No text, no UI, no grid lines in the shader.

**Noise**: hand-write a small hash/value-noise + fbm helper in WGSL (concatenate a shared `COMMON`
string into each module). Quality of the noise is a large part of "does it look premium" — smooth
value-noise or a compact simplex, gradients interpolated with a quintic smootherstep.

## Control mapping (all sliders are 0..1 unless noted)

| control | range / meaning |
|---|---|
| flow speed | flow + noise drift time scale: `mix(0.03, 0.9, v)` uv/s |
| glow | bloom strength `mix(0.35, 1.5, v)`, emissive scale `mix(0.55, 1.7, v)`, exposure `mix(0.95, 1.15, v)` |
| trail length | dye decay per 1/60 s `mix(0.955, 0.9985, v)` |
| interaction strength | pointer force `mix(0.15, 1.7, v)`, ripple amplitude `mix(0.3, 1.4, v)` |
| visual density | particle count `round(mix(1500, 60000, v^1.4))` + aurora emission `mix(0.35, 1.15, v)` |
| palette | index 0..4, crossfaded over >= 1.5 s |

Ambient life: after ~12 s without pointer input, an automatic very soft ripple fires every 22–40 s
(randomised) so a wallpaper session never looks frozen. Keep it much subtler than a real click.

## Interaction

- `pointermove` (mouse/touch/pen): pointer uv + *smoothed* pointer velocity → gentle tangential
  bending of the flow. It must feel like pushing silk, not steering a car: no snapping, no jitter.
- `pointerdown`/click on the canvas: soft ripple/energy wave that grows and fades over ~4–6 s.
- Clicks on the UI panel must never create ripples (stop propagation / ignore pointer events inside the panel).
- Idle decay: when the pointer leaves, strength eases back to 0 over ~1 s.

## UI (minimal, hideable, elegant)

- Fullscreen canvas, `position: fixed; inset: 0`, dark `#05070c` body, no scrollbars, `overflow: hidden`.
- A tucked-away control panel: bottom-right on desktop, comfortable/compact on mobile
  (`@media (max-width: 640px)` → full-width bottom sheet, larger tap targets). Frosted dark surface:
  `rgba(10,12,18,0.45)` + `backdrop-filter: blur(14px)`, hairline border `rgba(255,255,255,0.08)`,
  radius 14px, ~232px wide, 13px system-ui text, muted labels `#9aa4b2`, no bright accent colour.
- Five hairline sliders + five palette swatches (name shown for the active one). Custom-styled
  `input[type=range]` (hairline track, small thumb, `:focus-visible` ring) — no default browser chrome.
- Hide/show: a small circular toggle button in the bottom-right corner (minimal hand-written SVG
  glyph, `data-testid="ui-toggle"`) and the `H` key both toggle the panel. Hidden state = opacity 0 + translateY, 300 ms ease,
  panel not focusable while hidden (`visibility: hidden` / `inert`), `aria-expanded` + `aria-controls`
  kept in sync.
- Footer of the panel: a tiny renderer badge `<span data-testid="renderer-badge">` reading exactly
  `WebGPU` (live GPU path) or `Canvas 2D (fallback)`, plus a `<button data-testid="renderer-toggle"
  aria-label="Switch renderer">` that switches backends at runtime, plus a very small
  `hermes + deepseek` credit line. Nothing else.
- Slider ids/attributes the QA script pokes: give each range input
  `data-testid="ctl-flowSpeed|glow|trail|interaction|density"` (with `min="0" max="1" step="0.01"`),
  each palette swatch `data-testid="palette-<id>"`, the panel container `data-testid="ui-panel"`,
  and the panel toggle button `data-testid="ui-toggle"` with `aria-expanded` mirroring the state.

## Fallback (mandatory, and it must be honest)

- If `navigator.gpu` is missing, `requestAdapter()` returns null, or `device.lost` fires: run the
  Canvas 2D renderer, and set the badge to `Canvas 2D (fallback)`. Never fake a GPU renderer.
- Canvas 2D version: same mood, lower fidelity — slow drifting soft radial-gradient blobs tinted by
  the palette, a few hundred soft particles advected by a cheap sin/cos curl-ish field, additive
  `lighter` compositing, gentle vignette, click ripple. Same controls honoured (speed, glow, trail
  via alpha decay, density via particle count, palette). Must not look like a different product.

## Performance / correctness

- DPR capped so `canvas.width*canvas.height <= 2_400_000`; cap `devicePixelRatio` at 2, then scale down.
- Resize via `ResizeObserver` on the canvas (and `window.resize` as a fallback); debounce texture
  reallocation with a rAF.
- Pause the loop on `document.hidden`, resume on `visibilitychange`.
- Never allocate per frame beyond a few small uniform writes; never create textures per frame.
- A single `GPUShaderModule` per pass, created once (memoised in `pipelines.js`).
- All u32-loop bounds, divisions and `normalize`/`length` calls must be NaN-safe (`max(len, 1e-6)`).

## Style / quality bar

- Comment the *why* of each pass in the code (so a reviewer can follow the art direction).
- Keep modules tidy: `shaders.js` = WGSL + palettes, `pipelines.js` = layouts+pipelines,
  `scene.js` = orchestration, `renderer.js` = DOM glue, `page.js` = React + UI only.
- Write the README last, describing the passes, the controls, and how it was verified.

**Work autonomously: read `tools/wgpu_check.ts` and `tools/qa_webgpu.cjs`, implement everything,
then run the gates above and fix your own bugs until everything passes. Do not stop at the first
error and do not ask questions — the brief is the spec.**
