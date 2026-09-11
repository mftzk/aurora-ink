// Aurora Ink — WGSL source, palettes and uniform layout constants.
//
// This file is intentionally DOM-free: it is imported directly by the Deno/wgpu verification
// harness, so it must never touch window/document/navigator.
//
// Art direction: a calm, dark field of drifting aurora ribbons suspended in liquid ink with a
// faint nebula behind them and slow particles leaving soft light trails. Every pass is tuned to
// stay laminar and slow; nothing here flashes.

// ---------------------------------------------------------------------------------------------
// Uniform buffer — exactly 176 bytes (11 x vec4), written once per frame and bound in every pass.
//
//   res     x,y = canvas px          z,w = velocity grid cells
//   timing  x = sim seconds          y = dt          z = frame index   w = palette blend 0..1
//   ptr     x,y = pointer uv         z = pointer strength 0..1          w = visual density 0..1
//   ripA/B/C x,y = ripple uv         z = normalized age 0..1            w = strength
//   col0..3 live palette colours (rgb 0..1)
//   ctrl    x flowSpeed  y glow  z trail  w interaction (all 0..1)
//
// Aspect (w/h) and the dye texel size are derived from `res` inside the shaders, which keeps the
// whole control surface inside the fixed 176-byte budget.
export const UNIFORM_BYTES = 176;

// Particles are stored as 6 f32 per particle (x, y, vx, vy, life, seed) in one big storage buffer.
export const PARTICLE_CAPACITY = 65536;

// Five calm palettes. Index 0..4, index 2 is warm, index 0 is the cool reference the harness
// compares warmth against. Each colour is [r, g, b] in 0..1.
export const PALETTES = [
  {
    id: "deep-ocean",
    name: "Deep Ocean",
    colors: [
      [0.015, 0.055, 0.16],
      [0.02, 0.18, 0.36],
      [0.04, 0.4, 0.55],
      [0.32, 0.72, 0.82],
    ],
  },
  {
    id: "purple-nebula",
    name: "Purple Nebula",
    colors: [
      [0.05, 0.025, 0.14],
      [0.18, 0.06, 0.34],
      [0.38, 0.16, 0.58],
      [0.66, 0.45, 0.86],
    ],
  },
  {
    id: "sunset-amber",
    name: "Sunset Amber",
    colors: [
      [0.18, 0.045, 0.02],
      [0.45, 0.14, 0.03],
      [0.82, 0.38, 0.07],
      [1.0, 0.72, 0.32],
    ],
  },
  {
    id: "emerald-aurora",
    name: "Emerald Aurora",
    colors: [
      [0.02, 0.1, 0.07],
      [0.04, 0.32, 0.2],
      [0.08, 0.6, 0.38],
      [0.5, 0.9, 0.68],
    ],
  },
  {
    id: "monochrome-blue",
    name: "Monochrome Blue",
    colors: [
      [0.035, 0.05, 0.1],
      [0.11, 0.16, 0.32],
      [0.3, 0.4, 0.64],
      [0.78, 0.84, 0.98],
    ],
  },
];

// Shared WGSL: uniform struct, hash/value-noise/fbm, palette lookup, radial swirl helpers and a
// fullscreen-triangle vertex entry (`vsFull`). Concatenated into every module so each one is
// standalone-compilable, exactly as the harness expects.
const COMMON = /* wgsl */ `
const PI: f32 = 3.141592653589793;

struct Params {
  res: vec4<f32>,
  timing: vec4<f32>,
  ptr: vec4<f32>,
  ripA: vec4<f32>,
  ripB: vec4<f32>,
  ripC: vec4<f32>,
  col0: vec4<f32>,
  col1: vec4<f32>,
  col2: vec4<f32>,
  col3: vec4<f32>,
  ctrl: vec4<f32>,
};
@group(0) @binding(0) var<uniform> P: Params;

// Quintic-interpolated value noise. Smooth gradients are most of what makes the scene read as
// "premium" rather than "procedural", so the interpolation is smootherstep and nothing is linear.
fn hash11(p: f32) -> f32 {
  var x: f32 = fract(p * 0.1031);
  x = x * (x + 33.33);
  x = x * (x + x);
  return fract(x);
}
fn hash21(p: vec2<f32>) -> f32 {
  var q: vec2<f32> = fract(p * vec2<f32>(123.34, 345.45));
  q = q + vec2<f32>(dot(q, q + 34.345));
  return fract(q.x * q.y);
}
fn hash22(p: vec2<f32>) -> vec2<f32> {
  var q: vec2<f32> = fract(p * vec2<f32>(123.34, 345.45));
  q = q + vec2<f32>(dot(q, q + 34.345));
  return fract(q * q.yx + q.yx);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i: vec2<f32> = floor(p);
  let f: vec2<f32> = fract(p);
  let u: vec2<f32> = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a: f32 = hash21(i);
  let b: f32 = hash21(i + vec2<f32>(1.0, 0.0));
  let c: f32 = hash21(i + vec2<f32>(0.0, 1.0));
  let d: f32 = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p0: vec2<f32>, oct: i32) -> f32 {
  var p: vec2<f32> = p0;
  var sum: f32 = 0.0;
  var amp: f32 = 0.5;
  var norm: f32 = 0.0;
  for (var i: i32 = 0; i < oct; i = i + 1) {
    sum = sum + amp * vnoise(p);
    norm = norm + amp;
    p = p * 2.02 + vec2<f32>(1.7, -1.3);
    amp = amp * 0.5;
  }
  return sum / max(norm, 1e-5);
}
fn rot2(a: f32) -> mat2x2<f32> {
  let c: f32 = cos(a);
  let s: f32 = sin(a);
  return mat2x2<f32>(c, -s, s, c);
}
fn safeNorm(v: vec2<f32>) -> vec2<f32> {
  return v / max(length(v), 1e-6);
}
// Continuous 4-colour palette lookup, used for ribbons, particles and the nebula.
fn palette(t: f32) -> vec3<f32> {
  let x: f32 = clamp(t, 0.0, 1.0) * 3.0;
  var c: vec3<f32> = P.col0.rgb;
  if (x < 1.0) {
    c = mix(P.col0.rgb, P.col1.rgb, x);
  } else if (x < 2.0) {
    c = mix(P.col1.rgb, P.col2.rgb, x - 1.0);
  } else {
    c = mix(P.col2.rgb, P.col3.rgb, x - 2.0);
  }
  return c;
}
// Tangential, distance-faded swirl. Used for the large-scale vortices, the orbiting emitters and
// the pointer, so all three share the same soft "pushing silk" feel.
fn vortex(p: vec2<f32>, c: vec2<f32>, w: f32) -> vec2<f32> {
  let d: vec2<f32> = p - c;
  let r: f32 = max(length(d), 1e-4);
  let fall: f32 = exp(-r * r * 3.0);
  let tang: vec2<f32> = vec2<f32>(-d.y, d.x) / r;
  return tang * fall * w;
}
// A ripple is an expanding soft annulus, not a disc: the ring radius grows with age while its
// thickness stays a small fraction of that radius, so the energy reads as a wave travelling
// outward through the flow. Only a faint, fast-decaying core remains at the centre.
fn rippleForce(p: vec2<f32>, rr: vec4<f32>, aspect: f32) -> vec2<f32> {
  if (rr.w <= 0.0001) {
    return vec2<f32>(0.0, 0.0);
  }
  let c: vec2<f32> = vec2<f32>(rr.x * aspect, rr.y);
  let age: f32 = rr.z;
  let radius: f32 = age * 0.45;
  let thick: f32 = max(0.02, radius * 0.30);
  let d: vec2<f32> = p - c;
  let dist: f32 = max(length(d), 1e-4);
  let ring: f32 = exp(-pow((dist - radius) / thick, 2.0));
  let decay: f32 = 1.0 - age;
  return safeNorm(d) * ring * decay * rr.w * mix(0.3, 1.4, P.ctrl.w) * 0.7;
}
fn rippleDye(p: vec2<f32>, rr: vec4<f32>, aspect: f32, base: vec3<f32>) -> vec3<f32> {
  if (rr.w <= 0.0001) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let c: vec2<f32> = vec2<f32>(rr.x * aspect, rr.y);
  let age: f32 = rr.z;
  let radius: f32 = age * 0.5;
  let thick: f32 = max(0.014, radius * 0.22);
  let d: vec2<f32> = p - c;
  let dist: f32 = length(d);
  let ring: f32 = exp(-pow((dist - radius) / thick, 2.0));
  // A very faint filled core, kept under ~13% of the ring and fading faster than the ring.
  let core: f32 = exp(-pow(dist / max(radius + 0.03, 0.03), 2.0)) * 0.13 * (1.0 - age);
  let decay: f32 = pow(1.0 - age, 1.5);
  return base * (ring + core) * decay * rr.w * mix(0.3, 1.4, P.ctrl.w) * 1.5;
}
fn aspect() -> f32 {
  return P.res.x / max(P.res.y, 1.0);
}

// Soft frame-edge mask. Multiplying by this dissolves the composition into the dark bed over the
// outer few percent of the frame instead of letting it end on a hard, bright edge.
fn edgeMask(uv: vec2<f32>) -> f32 {
  let e: f32 = 0.12;
  return smoothstep(0.0, e, uv.x) * smoothstep(0.0, e, 1.0 - uv.x)
    * smoothstep(0.0, e, uv.y) * smoothstep(0.0, e, 1.0 - uv.y);
}

// The aurora band field, shared by the dye pass (which paints it) and the particle pass (which
// chooses respawn points inside it). Returns (core, halo, band, region):
//   band  0 at the gap between ribbons, 1 along the ribbon centre line
//   core  narrow bright spine
//   halo  wide soft outer falloff
//   region large-scale diagonal confinement so ribbons occupy a flowing swath, not the whole frame
fn auroraCoords(p: vec2<f32>) -> vec4<f32> {
  let t: f32 = P.timing.x;
  let q: vec2<f32> = rot2(t * 0.012 + 0.5) * p;
  let warp: f32 = (fbm(q * vec2<f32>(0.30, 0.55) + vec2<f32>(t * 0.008, -t * 0.006), 2) - 0.5) * 1.5
    + (fbm(q * vec2<f32>(0.95, 1.30) + vec2<f32>(-t * 0.010, t * 0.007), 2) - 0.5) * 0.55;
  let across: f32 = q.y * 2.3 + warp;
  let ph: f32 = fract(across);
  let band: f32 = 1.0 - abs(ph - 0.5) * 2.0;
  // Narrow bright spine + a wide, much dimmer outer falloff: enough to read as a ribbon without
  // flooding the frame.
  let core: f32 = pow(band, 3.0);
  let halo: f32 = pow(band, 1.4);
  let diag: f32 = p.y - 0.5 * p.x / max(aspect(), 1e-3);
  let region: f32 = exp(-pow((diag - 0.47) / 0.30, 2.0));
  return vec4<f32>(core, halo, band, clamp(region, 0.0, 1.0));
}

// A second, much fainter ribbon system set at another angle and drifting the other way. It sits
// behind the main aurora and is what gives the frame depth: two layers, not one flat wash.
fn auroraCoords2(p: vec2<f32>) -> vec4<f32> {
  let t: f32 = P.timing.x;
  let q: vec2<f32> = rot2(-0.38 + t * -0.006) * p;
  let warp: f32 = (fbm(q * vec2<f32>(0.42, 0.68) + vec2<f32>(-t * 0.006, t * 0.005), 2) - 0.5) * 1.6;
  let across: f32 = q.y * 1.45 + warp;
  let ph: f32 = fract(across);
  let band: f32 = 1.0 - abs(ph - 0.5) * 2.0;
  let core: f32 = pow(band, 2.4);
  let halo: f32 = pow(band, 1.2);
  let diag: f32 = p.y + 0.35 * p.x / max(aspect(), 1e-3);
  let region: f32 = exp(-pow((diag - 0.58) / 0.44, 2.0));
  return vec4<f32>(core, halo, band, clamp(region, 0.0, 1.0));
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Fullscreen triangle. uv.y is flipped so that uv (0,0) is the top-left in texture space,
// matching the WebGPU texture origin used by the compute passes.
@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> VSOut {
  let raw: vec2<f32> = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VSOut;
  out.pos = vec4<f32>(raw * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(raw.x, 1.0 - raw.y);
  return out;
}
`;

// ---------------------------------------------------------------------------------------------
// 1. velocity — curl-noise flow + vortices + orbiting emitters + pointer swirl + ripples.
//    Kept laminar and slow; max |v| is roughly mix(0.03, 0.9, flowSpeed) uv/s.
const velocity = COMMON + /* wgsl */ `
@group(0) @binding(1) var velIn: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var velB: texture_2d<f32>;
@group(0) @binding(4) var velOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let grid: vec2<u32> = vec2<u32>(u32(P.res.z), u32(P.res.w));
  if (gid.x >= grid.x || gid.y >= grid.y) {
    return;
  }
  let uv: vec2<f32> = (vec2<f32>(gid.xy) + 0.5) / max(P.res.zw, vec2<f32>(1.0, 1.0));
  let t: f32 = P.timing.x;
  let asp: f32 = aspect();
  // Slow the flow a little below the nominal band: the ink should feel suspended, not poured.
  let speed: f32 = mix(0.03, 0.9, P.ctrl.x) * 0.30;
  let p: vec2<f32> = vec2<f32>(uv.x * asp, uv.y);
  let drift: vec2<f32> = vec2<f32>(t * 0.011, t * -0.008);

  // Two low-frequency noise fields give a direction field; the second is offset and counter-drifting
  // so the flow never settles into a static pattern.
  let n1: f32 = fbm(p * 0.85 + drift, 2);
  let n2: f32 = fbm(p * 0.85 + vec2<f32>(3.1, 7.7) - drift * 0.7, 2);
  var v: vec2<f32> = vec2<f32>(n2 - 0.5, 0.5 - n1) * 1.5;

  // Large-scale vortices.
  v = v + vortex(p, vec2<f32>(0.30, 0.42), 0.9);
  v = v + vortex(p, vec2<f32>(0.72, 0.58), -0.7);

  // Two orbiting emitters inject rotational flow so the field keeps living on its own.
  let e1: vec2<f32> = vec2<f32>(0.5 + 0.28 * cos(t * 0.05), 0.5 + 0.22 * sin(t * 0.065));
  let e2: vec2<f32> = vec2<f32>(0.5 + 0.33 * cos(t * -0.04 + 1.7), 0.5 + 0.26 * sin(t * -0.045));
  v = v + vortex(p, e1, 1.2) * 0.6;
  v = v + vortex(p, e2, -1.0) * 0.6;

  // Pointer swirl: tangential to the pointer, scaled by strength and interaction.
  let pp: vec2<f32> = vec2<f32>(P.ptr.x * asp, P.ptr.y);
  let dp: vec2<f32> = p - pp;
  let rp: f32 = max(length(dp), 1e-4);
  let pfall: f32 = exp(-rp * rp * 7.0);
  v = v + vec2<f32>(-dp.y, dp.x) / rp * pfall * P.ptr.z * mix(0.15, 1.7, P.ctrl.w) * 1.5;

  v = v + rippleForce(p, P.ripA, asp);
  v = v + rippleForce(p, P.ripB, asp);
  v = v + rippleForce(p, P.ripC, asp);

  // Normalise to the target speed band, then ease from the previous frame for temporal softness.
  let dir: vec2<f32> = safeNorm(v);
  let mag: f32 = speed * smoothstep(0.05, 0.95, length(v)) * 1.35;
  let prev: vec2<f32> = textureSampleLevel(velIn, samp, uv, 0.0).xy;
  var vel: vec2<f32> = mix(prev, dir * mag, 0.05);

  // Soft wall damping keeps the frame edges from smearing into the vignette.
  let edge: f32 = smoothstep(0.0, 0.10, uv.x) * smoothstep(0.0, 0.10, 1.0 - uv.x)
    * smoothstep(0.0, 0.10, uv.y) * smoothstep(0.0, 0.10, 1.0 - uv.y);
  vel = vel * mix(0.55, 1.0, edge);

  if (!(vel.x == vel.x)) { vel.x = 0.0; }
  if (!(vel.y == vel.y)) { vel.y = 0.0; }
  vel = clamp(vel, vec2<f32>(-2.0, -2.0), vec2<f32>(2.0, 2.0));
  textureStore(velOut, vec2<i32>(gid.xy), vec4<f32>(vel, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------------------------
// 2. dye — semi-Lagrangian advection of the ink field, then additive aurora ribbons, emitters,
//    ripple rings and gentle dissipation/diffusion. This is the main visual pass.
const dye = COMMON + /* wgsl */ `
@group(0) @binding(1) var velTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var dyeIn: texture_2d<f32>;
@group(0) @binding(4) var dyeOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size: vec2<u32> = vec2<u32>(u32(ceil(P.res.x * 0.5)), u32(ceil(P.res.y * 0.5)));
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let texel: vec2<f32> = 1.0 / vec2<f32>(size);
  let uv: vec2<f32> = (vec2<f32>(gid.xy) + 0.5) * texel;
  let vel: vec2<f32> = textureSampleLevel(velTex, samp, uv, 0.0).xy;
  let back: vec2<f32> = uv - vel * P.timing.y;

  var c: vec3<f32> = textureSampleLevel(dyeIn, samp, back, 0.0).rgb;
  let decay: f32 = pow(mix(0.955, 0.9985, P.ctrl.z), P.timing.y * 60.0);
  c = c * decay;

  // Tiny tent diffusion so the ink edges stay liquid rather than pixel-sharp.
  let l: vec3<f32> = textureSampleLevel(dyeIn, samp, back + vec2<f32>(-texel.x, 0.0), 0.0).rgb;
  let r: vec3<f32> = textureSampleLevel(dyeIn, samp, back + vec2<f32>(texel.x, 0.0), 0.0).rgb;
  let up: vec3<f32> = textureSampleLevel(dyeIn, samp, back + vec2<f32>(0.0, -texel.y), 0.0).rgb;
  let dn: vec3<f32> = textureSampleLevel(dyeIn, samp, back + vec2<f32>(0.0, texel.y), 0.0).rgb;
  c = mix(c, (l + r + up + dn) * 0.25, 0.020);

  let t: f32 = P.timing.x;
  let asp: f32 = aspect();
  let p: vec2<f32> = vec2<f32>(uv.x * asp, uv.y);
  let dens: f32 = mix(0.45, 1.25, P.ptr.w);

  // Emission is scaled by the amount the field loses to dissipation each frame. That keeps the
  // ink's steady-state opacity stable as the "trail length" slider changes, instead of letting a
  // long trail slowly accumulate into a white-out.
  let inject: f32 = (1.0 - decay) * 1.0;

  // Aurora ribbons: elongated curved bands. Brightness has a gradient along the band (via along)
  // and the palette runs across it — col0/col1 in the halo, col2/col3 in the bright spine.
  let ac: vec4<f32> = auroraCoords(p);
  let along: f32 = 0.30 + 0.70 * fbm(vec2<f32>(p.x * 0.42 + t * 0.016, p.y * 0.30), 2);
  let amp: f32 = dens * along;
  let g: f32 = ac.z;
  let cA: vec3<f32> = mix(P.col0.rgb, P.col1.rgb, smoothstep(0.0, 0.7, g));
  let cB: vec3<f32> = mix(P.col1.rgb, P.col2.rgb, smoothstep(0.55, 1.0, g));
  let ribbonCol: vec3<f32> = mix(cA, cB, g);
  var aurora: vec3<f32> = ribbonCol * ac.y * amp * 1.60;
  aurora = aurora + P.col2.rgb * ac.x * amp * 6.20;
  aurora = aurora + P.col3.rgb * ac.x * ac.x * amp * 3.50;

  // The two emitters paint a little palette light into the field at the same positions the velocity
  // pass uses, so the light sources and the flow agree.
  let e1: vec2<f32> = vec2<f32>(0.5 + 0.28 * cos(t * 0.05), 0.5 + 0.22 * sin(t * 0.065));
  let e2: vec2<f32> = vec2<f32>(0.5 + 0.33 * cos(t * -0.04 + 1.7), 0.5 + 0.26 * sin(t * -0.045));
  // (The orbiting emitters stir the velocity field only; painting them into the ink made two
  // hard bright blobs travel across the frame.)

  // Confine the ribbons to a flowing diagonal swath, then break that swath up with a
  // large-scale noise mask so the glow appears and dissolves irregularly instead of forming
  // geometric wedges. Real aurora is patchy.
  let blotch: f32 = smoothstep(0.32, 0.86, fbm(p * vec2<f32>(0.9, 1.5) + vec2<f32>(t * 0.010, -t * 0.008), 3));
  aurora = aurora * ac.w * (0.28 + 0.72 * blotch);

  // Second, fainter layer behind the main band.
  let ac2: vec4<f32> = auroraCoords2(p);
  let c2: vec3<f32> = mix(P.col0.rgb, P.col1.rgb, ac2.z) * ac2.y * 0.55 + P.col1.rgb * ac2.x * 0.75;
  aurora = aurora + c2 * amp * ac2.w * (0.22 + 0.78 * blotch) * 0.30;
  c = c + aurora * inject;

  c = c + rippleDye(p, P.ripA, asp, P.col2.rgb) * inject * 0.9;
  c = c + rippleDye(p, P.ripB, asp, P.col3.rgb) * inject * 0.9;
  c = c + rippleDye(p, P.ripC, asp, P.col1.rgb) * inject * 0.9;

  // Dissolve the whole ink field into the dark bed over the outer few percent of the frame.
  c = c * edgeMask(uv);
  c = min(c, vec3<f32>(8.0, 8.0, 8.0));
  if (!(c.x == c.x)) { c = vec3<f32>(0.0, 0.0, 0.0); }
  textureStore(dyeOut, vec2<i32>(gid.xy), vec4<f32>(c, 1.0));
}
`;

// ---------------------------------------------------------------------------------------------
// 3. particlesUpdate — integrate particles through the velocity field with inertia, age them and
//    respawn the dead at fresh random positions. Slow drift, never darting.
const particlesUpdate = COMMON + /* wgsl */ `
@group(0) @binding(1) var velTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> parts: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Density rule: roughly one mote per ~18 px^2 of area at full density, so the count scales with
  // resolution and reads as sparse drifting light rather than a starfield. Capped at the buffer.
  let count: u32 = min(u32(round(P.res.x * P.res.y * 0.0012 * mix(0.25, 1.0, clamp(P.ptr.w, 0.0, 1.0)))), 65536u);
  let i: u32 = gid.x;
  if (i >= count) {
    return;
  }
  let base: u32 = i * 6u;
  var px: f32 = parts[base + 0u];
  var py: f32 = parts[base + 1u];
  var vx: f32 = parts[base + 2u];
  var vy: f32 = parts[base + 3u];
  var life: f32 = parts[base + 4u];
  var seed: f32 = parts[base + 5u];

  let uv: vec2<f32> = vec2<f32>(px, py);
  let field: vec2<f32> = textureSampleLevel(velTex, samp, clamp(uv, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0)), 0.0).xy;
  // Very slow, low-amplitude wander: the particles should read as suspended motes, not darts.
  let jitter: vec2<f32> = (hash22(vec2<f32>(seed * 31.7, floor(P.timing.x * 0.4) + seed)) - 0.5) * 0.012;
  vx = vx * 0.95 + (field.x * 0.35 + jitter.x) * 0.05;
  vy = vy * 0.95 + (field.y * 0.35 + jitter.y) * 0.05;
  px = px + vx * P.timing.y;
  py = py + vy * P.timing.y;
  life = life - mix(0.08, 0.20, hash11(seed * 3.1)) * P.timing.y;

  if (px < -0.05 || px > 1.05 || py < -0.05 || py > 1.05 || life <= 0.0) {
    // Respawn biased toward the aurora bands: sample a few candidates and keep the one with the
    // strongest local ribbon/region intensity, so motes appear inside the glow instead of as a
    // uniform dusting over the whole frame.
    var best: vec2<f32> = hash22(vec2<f32>(seed * 17.3 + P.timing.z * 0.0007, seed * 5.9));
    var bestScore: f32 = -1.0;
    let asp: f32 = aspect();
    for (var k: i32 = 0; k < 4; k = k + 1) {
      let fk: f32 = f32(k);
      let h: vec2<f32> = hash22(vec2<f32>(seed * 17.3 + P.timing.z * 0.0007 + fk * 7.13, seed * 5.9 + fk * 2.31));
      let ac: vec4<f32> = auroraCoords(vec2<f32>(h.x * asp, h.y));
      let score: f32 = ac.x * 1.0 + ac.y * ac.w * 0.7 + hash21(h * 91.7) * 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    px = best.x;
    py = best.y;
    vx = 0.0;
    vy = 0.0;
    life = 1.0;
    seed = fract(seed + 0.137 + P.timing.z * 0.0001);
  }

  parts[base + 0u] = px;
  parts[base + 1u] = py;
  parts[base + 2u] = vx;
  parts[base + 3u] = vy;
  parts[base + 4u] = life;
  parts[base + 5u] = seed;
}
`;

// ---------------------------------------------------------------------------------------------
// 4. particleDraw — soft elongated sprites drawn additively into the emissive texture. The stretch
//    along velocity is what reads as a slow light trail.
const particleDraw = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> parts: array<f32>;

struct POut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) alpha: f32,
};

fn quadCorner(vi: u32) -> vec2<f32> {
  var pts: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  return pts[vi];
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  let base: u32 = ii * 6u;
  let px: f32 = parts[base + 0u];
  let py: f32 = parts[base + 1u];
  let vx: f32 = parts[base + 2u];
  let vy: f32 = parts[base + 3u];
  let life: f32 = parts[base + 4u];
  let seed: f32 = parts[base + 5u];

  let speed: f32 = length(vec2<f32>(vx, vy));
  let dir: vec2<f32> = safeNorm(vec2<f32>(vx, vy) + vec2<f32>(1e-4, 1e-4));
  let perp: vec2<f32> = vec2<f32>(-dir.y, dir.x);
  // Soft mote: a gaussian whose cross-flow sigma is ~0.006-0.010 of the frame height (about
  // 2-3 px at 288) and whose along-flow sigma is 3-6x that, so it reads as a streak.
  let sigma: f32 = mix(0.0022, 0.0038, hash11(seed * 7.3));
  let ratio: f32 = mix(4.0, 7.0, hash11(seed * 4.1));
  let corner: vec2<f32> = quadCorner(vi) - vec2<f32>(0.5, 0.5);
  let off: vec2<f32> = dir * (corner.x * 3.0 * sigma * ratio) + perp * (corner.y * 3.0 * sigma);
  let posUv: vec2<f32> = vec2<f32>(px, py) + off;
  let fade: f32 = sin(clamp(life, 0.0, 1.0) * PI);
  // Fade sprites at the frame border so off-screen particles cannot stack into a bright rim.
  let edge: f32 = smoothstep(0.0, 0.05, posUv.x) * smoothstep(0.0, 0.05, 1.0 - posUv.x)
    * smoothstep(0.0, 0.05, posUv.y) * smoothstep(0.0, 0.05, 1.0 - posUv.y);

  var out: POut;
  out.pos = vec4<f32>(posUv.x * 2.0 - 1.0, 1.0 - posUv.y * 2.0, 0.0, 1.0);
  out.local = corner * 3.0;
  out.color = mix(P.col2.rgb, P.col3.rgb, 0.45);
  out.alpha = fade * 0.17 * edge * mix(0.7, 1.0, hash11(seed * 2.7));
  return out;
}

@fragment
fn fs(in: POut) -> @location(0) vec4<f32> {
  // local is already normalised by the anisotropic sigmas, so this is a gaussian ellipse.
  let glow: f32 = exp(-dot(in.local, in.local));
  let g: f32 = glow * in.alpha;
  return vec4<f32>(in.color * g, g);
}
`;

// ---------------------------------------------------------------------------------------------
// 5. bright — soft-knee threshold of dye + emissive into the first bloom mip.
const bright = COMMON + /* wgsl */ `
@group(0) @binding(1) var dyeTex: texture_2d<f32>;
@group(0) @binding(2) var emTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let dye: vec3<f32> = textureSampleLevel(dyeTex, samp, in.uv, 0.0).rgb;
  let em: vec3<f32> = textureSampleLevel(emTex, samp, in.uv, 0.0).rgb;
  let c: vec3<f32> = dye + em;
  let knee: f32 = 0.75;
  let soft: vec3<f32> = max(c - vec3<f32>(knee, knee, knee), vec3<f32>(0.0, 0.0, 0.0));
  let b: vec3<f32> = soft * soft / (soft + vec3<f32>(0.25, 0.25, 0.25));
  return vec4<f32>(b * mix(0.7, 1.15, P.ctrl.y), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// 6. downsample — tent-filter into the next coarser bloom mip.
const downsample = COMMON + /* wgsl */ `
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let t: vec2<f32> = 1.0 / vec2<f32>(textureDimensions(src));
  let c: vec3<f32> = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  let n: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(0.0, -t.y), 0.0).rgb;
  let s: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(0.0, t.y), 0.0).rgb;
  let e: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, 0.0), 0.0).rgb;
  let w: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, 0.0), 0.0).rgb;
  let ne: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  let nw: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, -t.y), 0.0).rgb;
  let se: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, t.y), 0.0).rgb;
  let sw: vec3<f32> = textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, t.y), 0.0).rgb;
  return vec4<f32>((c * 4.0 + (n + s + e + w) * 2.0 + (ne + nw + se + sw)) / 16.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// 7. upsample — 3x3 tent, added back into the finer mip (additive blend at pipeline level).
const upsample = COMMON + /* wgsl */ `
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let t: vec2<f32> = 1.0 / vec2<f32>(textureDimensions(src));
  var col: vec3<f32> = textureSampleLevel(src, samp, in.uv, 0.0).rgb * 4.0;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, 0.0), 0.0).rgb * 2.0;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, 0.0), 0.0).rgb * 2.0;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(0.0, t.y), 0.0).rgb * 2.0;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(0.0, -t.y), 0.0).rgb * 2.0;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, t.y), 0.0).rgb;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, t.y), 0.0).rgb;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  col = col + textureSampleLevel(src, samp, in.uv + vec2<f32>(-t.x, -t.y), 0.0).rgb;
  return vec4<f32>((col / 16.0) * mix(0.6, 0.85, P.ctrl.y), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// 8. composite — dark base + procedural nebula + dye + emissive + bloom, tonemapped, vignetted
//    and dithered so the dark gradients never band.
const composite = COMMON + /* wgsl */ `
@group(0) @binding(1) var dyeTex: texture_2d<f32>;
@group(0) @binding(2) var emTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let uv: vec2<f32> = in.uv;
  let asp: f32 = aspect();
  let t: f32 = P.timing.x;
  let glow: f32 = P.ctrl.y;
  let p: vec2<f32> = vec2<f32>(uv.x * asp, uv.y);

  // Slowly drifting, domain-warped nebula: a whisper of colour behind everything.
  let drift: vec2<f32> = vec2<f32>(t * 0.006, t * -0.004);
  let w1: vec2<f32> = vec2<f32>(
    fbm(p * 0.9 + drift, 3),
    fbm(p * 0.9 + drift + vec2<f32>(4.2, 1.1), 3)
  );
  let n: f32 = fbm(p * 1.1 + (w1 - 0.5) * 1.4 + drift, 4);
  let neb: f32 = pow(smoothstep(0.32, 0.95, n), 1.4);

  var col: vec3<f32> = vec3<f32>(0.0196, 0.0275, 0.0471);
  col = col + mix(P.col0.rgb, P.col1.rgb, n) * neb * 0.17;

  let dye: vec3<f32> = textureSampleLevel(dyeTex, samp, uv, 0.0).rgb;
  let em: vec3<f32> = textureSampleLevel(emTex, samp, uv, 0.0).rgb;
  let bloom: vec3<f32> = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  col = col + dye * mix(0.75, 1.10, glow);
  col = col + em * mix(0.50, 1.30, glow);
  col = col + bloom * mix(0.25, 0.90, glow);

  col = col / (vec3<f32>(1.0, 1.0, 1.0) + col) * mix(0.95, 1.15, glow);

  let q: vec2<f32> = (uv - vec2<f32>(0.5, 0.5)) * vec2<f32>(1.0, 0.92);
  let vig: f32 = 1.0 - smoothstep(0.35, 1.15, length(q) * 1.25);
  col = col * mix(0.86, 1.0, vig);
  // Final border dissolve: bloom can smear bright ink outward, so mask the composited frame too.
  col = col * edgeMask(uv);

  // Static per-pixel dither: it breaks banding without shimmering frame to frame.
  let dither: f32 = (hash21(uv * P.res.xy) - 0.5) / 255.0;
  col = col + vec3<f32>(dither, dither, dither);
  col = max(col, vec3<f32>(0.0, 0.0, 0.0));
  return vec4<f32>(col, 1.0);
}
`;

export const WGSL_MODULES = {
  velocity,
  dye,
  particlesUpdate,
  particleDraw,
  bright,
  downsample,
  upsample,
  composite,
};

export const SIM_TEXTURE_FORMAT = "rgba16float";
