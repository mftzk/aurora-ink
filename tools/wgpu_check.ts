// Headless WebGPU verification harness for aurora-ink.
//
// Runs with Deno (navigator.gpu via wgpu) against the software Vulkan driver (lavapipe):
//   bash tools/run_wgpu_check.sh
//
// This harness is the CONTRACT for app/lib/webgpu/*.js. It renders the real scene on a real
// WebGPU implementation and judges the pixels it reads back — never the source code.
//
// Checks:
//   1. every WGSL module compiles
//   2. createPipelines() builds every pipeline (rgba8unorm + bgra8unorm) with no validation error
//   3. the scene renders a dark, structured, calm frame (not flat, not white-out, not debug-looking)
//   4. motion is real AND gentle: 0.1 s apart frames barely differ, 2 s apart frames clearly differ
//   5. a click ripple brightens the flow locally, then the energy decays
//   6. all five palettes render and the warm/cool statistics actually track the palette
//   7. particle / light-trace pass draws pixels
//   8. resize() reallocates cleanly (no validation errors, still renders)
//   9. PNG frames written to tools/out/ for eyeballing

import * as shaders from "../app/lib/webgpu/shaders.js";
import * as pipelines from "../app/lib/webgpu/pipelines.js";
import * as sceneMod from "../app/lib/webgpu/scene.js";

const FORMAT = "rgba8unorm" as GPUTextureFormat;
const W = 512; // width*4 is a multiple of 256 → legal copyTextureToBuffer bytesPerRow
const H = 288;
const OUT_DIR = new URL("./out/", import.meta.url);

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- PNG encoder (no deps)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function writePng(path: string, rgba: Uint8Array, width: number, height: number) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = new Uint8Array(8 + (12 + 13) + (12 + idat.length) + 12);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const c of [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]) {
    png.set(c, o);
    o += c.length;
  }
  await Deno.mkdir(OUT_DIR, { recursive: true });
  await Deno.writeFile(path, png);
}

// ---------------------------------------------------------------- pixel stats
const lum = (p: Uint8Array, i: number) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;

function meanLum(px: Uint8Array) {
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += lum(px, i);
  return s / (px.length / 4);
}
function regionalMean(px: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      s += lum(px, (y * w + x) * 4);
      n++;
    }
  }
  return s / Math.max(1, n);
}
function meanAbsDiff(a: Uint8Array, b: Uint8Array) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return s / n / 255;
}
/** mean (r - b): negative = cool/blue, positive = warm. */
function warmth(px: Uint8Array, w: number) {
  let s = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    s += (px[i] - px[i + 2]) / 255;
    n++;
  }
  return s / n;
}
function brightFraction(px: Uint8Array, t: number) {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (lum(px, i) > t) n++;
  return n / (px.length / 4);
}
function structure(px: Uint8Array, w: number, h: number) {
  // fraction of 16x16 blocks whose mean luminance differs from the global mean by > 0.01
  const g = meanLum(px);
  let n = 0, tot = 0;
  for (let by = 0; by + 16 <= h; by += 16) {
    for (let bx = 0; bx + 16 <= w; bx += 16) {
      tot++;
      if (Math.abs(regionalMean(px, w, bx, by, bx + 16, by + 16) - g) > 0.012) n++;
    }
  }
  return tot ? n / tot : 0;
}
function brightestPixel(px: Uint8Array) {
  let best = 0, bi = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = lum(px, i);
    if (l > best) { best = l; bi = i; }
  }
  return { l: best, rgb: [px[bi], px[bi + 1], px[bi + 2]] };
}
/** integral-image box filter (O(1) per box) over the luminance channel */
function boxMean(px: Uint8Array, w: number, h: number) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum(px, (y * w + x) * 4);
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + row;
    }
  }
  return (cx: number, cy: number, r: number) => {
    const x0 = Math.max(0, Math.round(cx - r)), x1 = Math.min(w, Math.round(cx + r));
    const y0 = Math.max(0, Math.round(cy - r)), y1 = Math.min(h, Math.round(cy + r));
    const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
    return s / Math.max(1, (x1 - x0) * (y1 - y0));
  };
}

// ---------------------------------------------------------------- GPU setup
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  console.error("NO WEBGPU ADAPTER — export VK_ICD_FILENAMES (see tools/run_wgpu_check.sh).");
  Deno.exit(2);
}
const device = await adapter.requestDevice();
const problems: string[] = [];
(device as any).addEventListener("uncapturederror", (e: any) => problems.push(String(e.error?.message ?? e)));
console.log("adapter:", JSON.stringify((adapter as any).info ?? {}));
console.log(`frame size: ${W}x${H}`);

console.log("\n[1] WGSL modules compile");
const modules = shaders.WGSL_MODULES ?? {};
check("shaders.js exports WGSL_MODULES (object of named WGSL strings)", Object.keys(modules).length >= 6, Object.keys(modules).join(", "));
for (const [name, src] of Object.entries(modules)) {
  const code = src as string;
  check(`${name} is non-trivial WGSL`, typeof code === "string" && code.length > 120, `${code?.length ?? 0} chars`);
  try {
    device.pushErrorScope("validation");
    device.createShaderModule({ code, label: name });
    const err = await device.popErrorScope();
    check(`${name} compiles`, !err, err ? (err as GPUError).message : "ok");
  } catch (e) {
    check(`${name} compiles`, false, String(e));
  }
}

console.log("\n[2] createPipelines()");
for (const fmt of [FORMAT, "bgra8unorm" as GPUTextureFormat]) {
  try {
    device.pushErrorScope("validation");
    const p: any = pipelines.createPipelines(device, fmt);
    const err = await device.popErrorScope();
    const need = ["velocity", "dye", "particlesUpdate", "particleDraw", "bright", "downsample", "upsample", "composite"];
    const missing = need.filter((k) => !p?.[k]);
    check(`createPipelines(${fmt}) returns every pipeline`, missing.length === 0, missing.length ? `missing: ${missing.join(",")}` : need.length + " pipelines");
    check(`createPipelines(${fmt}) no validation error`, !err, err ? (err as GPUError).message : "ok");
  } catch (e) {
    check(`createPipelines(${fmt}) runs`, false, String(e));
  }
}

console.log("\n[3] scene renders");
const CONFIG = { flowSpeed: 0.35, glow: 0.5, trail: 0.6, interaction: 0.5, density: 0.45, palette: 0 };
let scene: any = null;
try {
  device.pushErrorScope("validation");
  scene = (sceneMod as any).createGPUScene(device, { format: FORMAT, width: W, height: H, config: { ...CONFIG } });
  const err = await device.popErrorScope();
  check("createGPUScene() builds every texture/bind group", !!scene, err ? (err as GPUError).message : "ok");
  check("scene exposes update/render/resize", typeof scene?.update === "function" && typeof scene?.render === "function" && typeof scene?.resize === "function");
} catch (e) {
  check("createGPUScene() runs", false, String(e));
}
if (!scene) {
  console.log(`\n${failures} CHECK(S) FAILED (scene could not be created)`);
  Deno.exit(1);
}

const target = device.createTexture({
  size: [W, H],
  format: FORMAT,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

async function grab(): Promise<Uint8Array> {
  scene.render(target.createView());
  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const read = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow }, [W, H]);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(read.getMappedRange().slice(0));
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) px.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
  read.unmap();
  read.destroy();
  return px;
}
function step(frames: number, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) scene.update(dt);
}

step(200); // ~3.3 s of warm-up
const a = await grab();
await writePng(new URL("frame-t0.png", OUT_DIR).pathname, a, W, H);

const meanA = meanLum(a);
const structA = structure(a, W, H);
const brightA = brightFraction(a, 0.9);
const darkRegion = regionalMean(a, W, 0, 0, 96, 64);
const peak = brightestPixel(a);
console.log(
  `  stats: meanLum=${meanA.toFixed(4)} structure=${(structA * 100).toFixed(1)}% bright(>0.9)=${(brightA * 100).toFixed(3)}% ` +
    `corner=${darkRegion.toFixed(4)} peak=${peak.l.toFixed(3)} rgb@peak=${peak.rgb.join(",")}`,
);
check("renders actual content (mean luminance > 0.01)", meanA > 0.01, meanA.toFixed(4));
check("stays calm & dark (mean luminance < 0.45)", meanA < 0.45, meanA.toFixed(4));
check("has visual structure, not a flat fill (>=35% of blocks deviate)", structA >= 0.35, `${(structA * 100).toFixed(1)}%`);
check("no blown-out whites (bright pixels < 2%)", brightA < 0.02, `${(brightA * 100).toFixed(3)}%`);
check("background is dark in the corners (< 0.12)", darkRegion < 0.12, darkRegion.toFixed(4));
check("visible light sources exist (peak luminance > 0.25)", peak.l > 0.25, peak.l.toFixed(3));

console.log("\n[4] motion is real but gentle");
step(6); // 0.1 s
const b = await grab();
step(120); // +2 s
const c = await grab();
await writePng(new URL("frame-t1.png", OUT_DIR).pathname, c, W, H);
const dShort = meanAbsDiff(a, b);
const dLong = meanAbsDiff(a, c);
console.log(`  mean|Δ| 0.1s=${dShort.toFixed(5)}  2.1s=${dLong.toFixed(5)}`);
check("the scene animates over 2 s (Δ >= 0.0015)", dLong >= 0.0015, dLong.toFixed(5));
check("no per-frame flashing (Δ over 0.1 s <= 0.02)", dShort <= 0.02, dShort.toFixed(5));
check("motion is gradual (2.1 s Δ >= 3x the 0.1 s Δ)", dLong >= dShort * 3, `${dLong.toFixed(5)} vs ${dShort.toFixed(5)}`);
check("brightness does not swing between frames", Math.abs(meanLum(b) - meanA) < 0.03, `${meanA.toFixed(4)} -> ${meanLum(b).toFixed(4)}`);

console.log("\n[5] click ripple");
const before = boxMean(a, W, H);
const baseCenter = before(W / 2, H / 2, 40);
scene.addRipple(0.5, 0.5, 1.0);
step(30); // 0.5 s later the wave is still near the centre
const rip = await grab();
await writePng(new URL("frame-ripple.png", OUT_DIR).pathname, rip, W, H);
const after = boxMean(rip, W, H);
const ripCenter = after(W / 2, H / 2, 40);
const farCorner = after(40, 40, 40);
console.log(`  centre lum ${baseCenter.toFixed(4)} -> ${ripCenter.toFixed(4)} (far corner ${farCorner.toFixed(4)})`);
check("ripple adds energy at the click point", ripCenter > baseCenter + 0.002, `${baseCenter.toFixed(4)} -> ${ripCenter.toFixed(4)}`);
step(400); // ~6.7 s: energy must decay
const settled = await grab();
const settledCenter = boxMean(settled, W, H)(W / 2, H / 2, 40);
console.log(`  centre after ~6.7 s: ${settledCenter.toFixed(4)}`);
check("ripple energy decays (settles below the ripple peak)", settledCenter < ripCenter, `${ripCenter.toFixed(4)} -> ${settledCenter.toFixed(4)}`);

console.log("\n[6] palettes");
const palettes = shaders.PALETTES ?? [];
check("5 calm palettes exported", palettes.length === 5, palettes.map((p: any) => p.name ?? p.id).join(", "));
const warmthByPalette: number[] = [];
for (let i = 0; i < palettes.length; i++) {
  scene.setConfig({ palette: i, density: 0.5, glow: 0.55 });
  step(210); // ~3.5 s: palette crossfade + flow turnover
  const img = await grab();
  const name = String(palettes[i].name ?? i).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await writePng(new URL(`frame-palette-${i}-${name}.png`, OUT_DIR).pathname, img, W, H);
  const w = warmth(img, W);
  const m = meanLum(img);
  const br = brightFraction(img, 0.9);
  warmthByPalette.push(w);
  console.log(`  ${String(palettes[i].name ?? i).padEnd(16)} warmth=${w.toFixed(4)} meanLum=${m.toFixed(4)} bright=${(br * 100).toFixed(3)}%`);
  check(`palette "${palettes[i].name ?? i}" renders calmly`, m > 0.01 && m < 0.45 && br < 0.02, `meanLum=${m.toFixed(4)}`);
}
const warm = warmthByPalette[2]; // sunset amber
const cool = warmthByPalette[0]; // deep ocean
check("warm palette is warmer than the cool palette", warm > cool + 0.01, `amber=${warm.toFixed(4)} ocean=${cool.toFixed(4)}`);
check("cool palettes stay blue-leaning (warmth < 0.08)", Math.max(warmthByPalette[0], warmthByPalette[1], warmthByPalette[4]) < 0.08, JSON.stringify(warmthByPalette.map((v) => +v.toFixed(3))));

console.log("\n[7] particles / light traces");
scene.setConfig({ palette: 0, density: 0.6, glow: 0.6 });
step(240);
const dense = await grab();
await writePng(new URL("frame-particles.png", OUT_DIR).pathname, dense, W, H);
const brightSpots = brightFraction(dense, 0.35);
console.log(`  pixels with lum>0.35: ${(brightSpots * 100).toFixed(2)}%`);
check("light traces / particles are visible", brightSpots > 0.0005, `${(brightSpots * 100).toFixed(3)}%`);
// low density must visibly reduce the effect (the slider does something)
scene.setConfig({ density: 0.05 });
step(300);
const sparse = await grab();
await writePng(new URL("frame-sparse.png", OUT_DIR).pathname, sparse, W, H);
console.log(`  dense meanLum=${meanLum(dense).toFixed(4)} sparse meanLum=${meanLum(sparse).toFixed(4)}`);
check("visual density slider changes the image", Math.abs(meanLum(dense) - meanLum(sparse)) > 0.001, `${meanLum(dense).toFixed(4)} vs ${meanLum(sparse).toFixed(4)}`);

console.log("\n[8] resize");
try {
  device.pushErrorScope("validation");
  scene.resize(384, 216);
  step(30);
  scene.render(target.createView());
  const err = await device.popErrorScope();
  check("resize() reallocates with no validation error", !err, err ? (err as GPUError).message : "ok");
  scene.resize(W, H);
  step(30);
  const img = await grab();
  check("renders after resize back", meanLum(img) > 0.01, meanLum(img).toFixed(4));
} catch (e) {
  check("resize() runs", false, String(e));
}

if (problems.length) {
  console.log("\nuncaptured device errors:");
  for (const p of problems) console.log("  -", p);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`frames written to ${OUT_DIR.pathname}`);
Deno.exit(failures === 0 ? 0 : 1);
