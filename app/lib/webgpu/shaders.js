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
// A ripple is a soft expanding annulus: radius grows with age, energy fades as (1 - age).
fn rippleForce(p: vec2<f32>, rr: vec4<f32>, aspect: f32) -> vec2<f32> {
  if (rr.w <= 0.0001) {
    return vec2<f32>(0.0, 0.0);
  }
  let c: vec2<f32> = vec2<f32>(rr.x * aspect, rr.y);
  let age: f32 = rr.z;
  let radius: f32 = age * 0.8;
  let d: vec2<f32> = p - c;
  let dist: f32 = max(length(d), 1e-4);
  let ring: f32 = exp(-pow((dist - radius) / 0.13, 2.0));
  let decay: f32 = 1.0 - age;
  return safeNorm(d) * ring * decay * rr.w * mix(0.3, 1.4, P.ctrl.w) * 0.9;
}
fn rippleDye(p: vec2<f32>, rr: vec4<f32>, aspect: f32, base: vec3<f32>) -> vec3<f32> {
  if (rr.w <= 0.0001) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let c: vec2<f32> = vec2<f32>(rr.x * aspect, rr.y);
  let age: f32 = rr.z;
  let radius: f32 = age * 0.8;
  let d: vec2<f32> = p - c;
  let dist: f32 = length(d);
  let ring: f32 = exp(-pow((dist - radius) / 0.07, 2.0));
  let decay: f32 = 1.0 - age;
  return base * ring * decay * rr.w * mix(0.3, 1.4, P.ctrl.w) * 1.6;
}
fn aspect() -> f32 {
  return P.res.x / max(P.res.y, 1.0);
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
  let speed: f32 = mix(0.03, 0.9, P.ctrl.x) * 0.36;
  let p: vec2<f32> = vec2<f32>(uv.x * asp, uv.y);
  let drift: vec2<f32> = vec2<f32>(t * 0.011, t * -0.008);

  // Two low-frequency noise fields give a direction field; the second is offset and counter-drifting
  // so the flow never settles into a static pattern.
  let n1: f32 = fbm(p * 1.3 + drift, 3);
  let n2: f32 = fbm(p * 1.3 + vec2<f32>(3.1, 7.7) - drift * 0.7, 3);
  var v: vec2<f32> = vec2<f32>(n2 - 0.5, 0.5 - n1) * 2.0;

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
  let mag: f32 = speed * clamp(length(v), 0.15, 1.3);
  let prev: vec2<f32> = textureSampleLevel(velIn, samp, uv, 0.0).xy;
  var vel: vec2<f32> = mix(prev, dir * mag, 0.05);

  // Soft wall damping keeps the frame edges from smearing into the vignette.
  let edge: f32 = smoothstep(0.0, 0.14, uv.x) * smoothstep(0.0, 0.14, 1.0 - uv.x)
    * smoothstep(0.0, 0.14, uv.y) * smoothstep(0.0, 0.14, 1.0 - uv.y);
  vel = vel * mix(0.12, 1.0, edge);

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
  c = mix(c, (l + r + up + dn) * 0.25, 0.015);

  let t: f32 = P.timing.x;
  let asp: f32 = aspect();
  let p: vec2<f32> = vec2<f32>(uv.x * asp, uv.y);
  let dens: f32 = mix(0.5, 1.6, P.ptr.w);

  // Emission is scaled by the amount the field loses to dissipation each frame. That keeps the
  // ink's steady-state opacity stable as the "trail length" slider changes, instead of letting a
  // long trail slowly accumulate into a white-out.
  let inject: f32 = (1.0 - decay) * 4.0;

  // Anisotropic stratified noise stretched along a slowly rotating axis -> soft long ribbons.
  // Deliberately low frequency and only 3 octaves: fine detail would make the whole field
  // shimmer when it drifts even slightly.
  let rd: mat2x2<f32> = rot2(t * 0.012);
  let q: vec2<f32> = rd * p;
  let strat: f32 = fbm(vec2<f32>(q.x * 0.55, q.y * 1.5) + vec2<f32>(t * 0.01, t * 0.017), 3);
  let ribbon: f32 = smoothstep(0.43, 0.76, strat);
  let core: f32 = smoothstep(0.82, 1.0, strat);
  var aurora: vec3<f32> = palette(strat) * ribbon * dens * 1.8;
  aurora = aurora + P.col2.rgb * smoothstep(0.5, 0.9, strat) * dens * 1.0;
  aurora = aurora + P.col3.rgb * core * dens * 2.0;

  // Keep the very edge of the frame quiet so the vignette and the dark border read as one.
  let edge: f32 = smoothstep(0.0, 0.2, uv.x) * smoothstep(0.0, 0.2, 1.0 - uv.x)
    * smoothstep(0.0, 0.2, uv.y) * smoothstep(0.0, 0.2, 1.0 - uv.y);
  aurora = aurora * mix(0.25, 1.0, edge);

  // The two emitters paint soft palette light into the field at the same positions the velocity
  // pass uses, so the light sources and the flow agree.
  let e1: vec2<f32> = vec2<f32>(0.5 + 0.28 * cos(t * 0.05), 0.5 + 0.22 * sin(t * 0.065));
  let e2: vec2<f32> = vec2<f32>(0.5 + 0.33 * cos(t * -0.04 + 1.7), 0.5 + 0.26 * sin(t * -0.045));
  aurora = aurora + P.col1.rgb * exp(-dot(p - e1, p - e1) * 9.0) * dens * 0.18;
  aurora = aurora + P.col2.rgb * exp(-dot(p - e2, p - e2) * 11.0) * dens * 0.15;

  c = c + aurora * inject;

  c = c + rippleDye(p, P.ripA, asp, P.col2.rgb) * inject * 0.9;
  c = c + rippleDye(p, P.ripB, asp, P.col3.rgb) * inject * 0.9;
  c = c + rippleDye(p, P.ripC, asp, P.col1.rgb) * inject * 0.9;

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
  let count: u32 = u32(round(800.0 + 5000.0 * pow(clamp(P.ptr.w, 0.0, 1.0), 1.4)));
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
    let h: vec2<f32> = hash22(vec2<f32>(seed * 17.3 + P.timing.z * 0.0007, seed * 5.9));
    px = h.x;
    py = h.y;
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
  let size: f32 = mix(0.006, 0.018, hash11(seed * 7.3));
  let stretch: f32 = 1.0 + clamp(speed * 16.0, 0.0, 3.0);
  let corner: vec2<f32> = quadCorner(vi) - vec2<f32>(0.5, 0.5);
  let off: vec2<f32> = dir * corner.x * size * stretch + perp * corner.y * size;
  let posUv: vec2<f32> = vec2<f32>(px, py) + off;
  let fade: f32 = sin(clamp(life, 0.0, 1.0) * PI);
  let sp: f32 = clamp(speed * 8.0, 0.0, 1.0);
  // Fade sprites at the frame border so off-screen particles cannot stack into a bright rim.
  let edge: f32 = smoothstep(0.0, 0.07, posUv.x) * smoothstep(0.0, 0.07, 1.0 - posUv.x)
    * smoothstep(0.0, 0.07, posUv.y) * smoothstep(0.0, 0.07, 1.0 - posUv.y);

  var out: POut;
  out.pos = vec4<f32>(posUv.x * 2.0 - 1.0, 1.0 - posUv.y * 2.0, 0.0, 1.0);
  out.local = corner + vec2<f32>(0.5, 0.5);
  out.color = mix(P.col1.rgb, P.col3.rgb, sp) + P.col3.rgb * 0.7;
  out.alpha = fade * mix(0.35, 0.85, hash11(seed * 2.7)) * (0.15 + 0.85 * edge);
  return out;
}

@fragment
fn fs(in: POut) -> @location(0) vec4<f32> {
  let d: vec2<f32> = (in.local - vec2<f32>(0.5, 0.5)) * 2.0;
  let r: f32 = length(d);
  let a: f32 = 1.0 - smoothstep(0.0, 1.0, r);
  let glow: f32 = a * a * in.alpha;
  return vec4<f32>(in.color * glow, glow);
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
  let knee: f32 = 0.55;
  let soft: vec3<f32> = max(c - vec3<f32>(knee, knee, knee), vec3<f32>(0.0, 0.0, 0.0));
  let b: vec3<f32> = soft * soft / (soft + vec3<f32>(0.25, 0.25, 0.25));
  return vec4<f32>(b * mix(0.9, 1.4, P.ctrl.y), 1.0);
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
  col = col + mix(P.col0.rgb, P.col1.rgb, n) * neb * 0.16;

  let dye: vec3<f32> = textureSampleLevel(dyeTex, samp, uv, 0.0).rgb;
  let em: vec3<f32> = textureSampleLevel(emTex, samp, uv, 0.0).rgb;
  let bloom: vec3<f32> = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  col = col + dye * mix(0.85, 1.25, glow);
  col = col + em * mix(0.55, 1.7, glow);
  col = col + bloom * mix(0.35, 1.5, glow);

  col = col / (vec3<f32>(1.0, 1.0, 1.0) + col) * mix(0.95, 1.15, glow);

  let q: vec2<f32> = (uv - vec2<f32>(0.5, 0.5)) * vec2<f32>(1.0, 0.92);
  let vig: f32 = 1.0 - smoothstep(0.3, 1.05, length(q) * 1.5);
  col = col * mix(0.72, 1.0, vig);

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
