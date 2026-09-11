// Aurora Ink — Canvas 2D fallback. DOM-side only.
//
// Same mood, lower fidelity: slow drifting radial-gradient blobs tinted by the active palette, a
// field of soft particles advected through a cheap sin/cos curl, additive "lighter" compositing,
// click ripples and a gentle vignette. It honours the same controls (speed, glow, trail, density,
// palette) so it never looks like a different product.

import { PALETTES } from "../webgpu/shaders.js";

const BG = [5, 7, 12];
const MAX_PARTICLES = 1400;

function rgba(c, a) {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

export function createCanvas2DRenderer(canvas, initialConfig) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const state = { ...initialConfig };
  let W = canvas.width || 1;
  let H = canvas.height || 1;
  let time = 0;

  const toColors = (idx) => PALETTES[((idx % PALETTES.length) + PALETTES.length) % PALETTES.length].colors;
  let live = toColors(state.palette).map((c) => c.slice());
  let start = live.map((c) => c.slice());
  let target = live.map((c) => c.slice());
  let blend = 1;
  const BLEND = 1.6;

  const blobs = Array.from({ length: 6 }, (_, i) => ({
    phase: i * 1.7 + 0.6,
    orbit: 0.24 + 0.13 * (((i * 37) % 10) / 10),
    sp: (0.05 + 0.025 * (i % 3)) * (i % 2 === 0 ? 1 : -1),
    rad: 0.42 + 0.16 * (((i * 53) % 10) / 10),
    col: i % 4,
  }));

  const particles = [];
  const ripples = [];

  function maxParticles() {
    const d = Math.min(1, Math.max(0, state.density));
    return Math.max(80, Math.round(140 + (MAX_PARTICLES - 140) * Math.pow(d, 1.4)));
  }

  function spawn(p) {
    p.x = Math.random();
    p.y = Math.random();
    p.vx = 0;
    p.vy = 0;
    p.life = Math.random();
    p.seed = Math.random();
  }
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = { x: 0, y: 0, vx: 0, vy: 0, life: 0, seed: 0 };
    spawn(p);
    particles.push(p);
  }

  function advancePalette(dt) {
    if (blend >= 1) return;
    blend = Math.min(1, blend + dt / BLEND);
    const k = blend * blend * (3 - 2 * blend);
    for (let c = 0; c < 4; c++) {
      for (let ch = 0; ch < 3; ch++) live[c][ch] = start[c][ch] + (target[c][ch] - start[c][ch]) * k;
    }
  }

  function resize(w, h) {
    W = Math.max(1, w);
    H = Math.max(1, h);
  }

  function frame(dt) {
    time += dt;
    advancePalette(dt);

    const speed = 0.15 + state.flowSpeed * 1.4;
    const glow = 0.4 + state.glow * 1.2;
    const aspect = W / H;

    // Partial clear is the trail mechanism: old light lingers and fades.
    const fade = 0.5 - state.trail * 0.36;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(${BG[0]},${BG[1]},${BG[2]},${fade.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);

    // Slow drifting palette blobs.
    ctx.globalCompositeOperation = "lighter";
    const minDim = Math.min(W, H);
    for (const b of blobs) {
      const ang = time * b.sp * speed + b.phase;
      const cx = (0.5 + b.orbit * Math.cos(ang)) * W;
      const cy = (0.5 + b.orbit * 0.62 * Math.sin(ang * 0.8 + b.phase * 1.3)) * H;
      const r = b.rad * minDim * 1.5;
      const c = live[b.col];
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba(c, 0.05 * glow));
      g.addColorStop(0.5, rgba(c, 0.02 * glow));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // Particles advected by a cheap curl-ish field, drawn as short light traces.
    const count = Math.min(maxParticles(), MAX_PARTICLES);
    const trail = 0.2 + state.trail * 1.6;
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      const fx = Math.sin(p.y * 9 + time * 0.5) + Math.cos(p.x * 7 - time * 0.31);
      const fy = Math.cos(p.x * 11 - time * 0.42) + Math.sin(p.y * 8 + time * 0.27);
      p.vx = p.vx * 0.9 + fx * 0.012 * speed;
      p.vy = p.vy * 0.9 + fy * 0.012 * speed;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * (0.05 + 0.1 * p.seed);
      if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05 || p.life <= 0) spawn(p);

      const c = live[1 + (i % 3)];
      const a = 0.16 * glow * Math.min(1, p.life * 3) * (1 - p.life * 0.4);
      ctx.strokeStyle = rgba(c, Math.max(0, a));
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x * W, p.y * H);
      ctx.lineTo((p.x - p.vx * trail) * W, (p.y - p.vy * trail) * H);
      ctx.stroke();
    }

    // Ripples: a soft expanding ring.
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.age += dt;
      const k = rp.age / rp.life;
      if (k >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      const radius = k * 0.55 * minDim;
      const alpha = (1 - k) * 0.28 * rp.strength * glow;
      ctx.strokeStyle = rgba(live[2], Math.max(0, alpha));
      ctx.lineWidth = Math.max(2, 6 * (1 - k));
      ctx.beginPath();
      ctx.arc(rp.x * W, rp.y * H, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Vignette to seat everything in the dark.
    ctx.globalCompositeOperation = "source-over";
    const v = ctx.createRadialGradient(W * 0.5, H * 0.5, minDim * 0.16, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    v.addColorStop(0, "rgba(3,4,8,0)");
    v.addColorStop(1, "rgba(3,4,8,0.72)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  function setConfig(partial) {
    if (!partial) return;
    if (partial.palette !== undefined && partial.palette !== state.palette) {
      state.palette = ((partial.palette % PALETTES.length) + PALETTES.length) % PALETTES.length;
      start = live.map((c) => c.slice());
      target = toColors(state.palette).map((c) => c.slice());
      blend = 0;
    }
    for (const key of ["flowSpeed", "glow", "trail", "interaction", "density"]) {
      if (partial[key] !== undefined) state[key] = Math.min(1, Math.max(0, partial[key]));
    }
  }

  function setPointer() {}

  function addRipple(x, y, strength) {
    if (ripples.length >= 3) ripples.shift();
    ripples.push({ x, y, strength, age: 0, life: 4.5 });
  }

  function destroy() {}

  return { frame, resize, setConfig, setPointer, addRipple, destroy, kind: "canvas2d" };
}
