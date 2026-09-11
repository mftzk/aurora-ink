// Fast visual preview: renders a handful of frames and writes PNGs I can actually look at.
//   bash tools/run_preview.sh            (all palettes)
//   bash tools/run_preview.sh 0          (just palette 0 + ripple + dense)
import * as sceneMod from "../app/lib/webgpu/scene.js";

const FORMAT = "rgba8unorm" as GPUTextureFormat;
const W = 384; // 384*4 = 1536 → multiple of 256
const H = 216;
const OUT = new URL("./preview/", import.meta.url);
const which = Deno.args[0] ?? "all";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function png(path: string, rgba: Uint8Array, w: number, h: number) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const cs = new CompressionStream("deflate"); const wr = cs.writable.getWriter(); wr.write(raw); wr.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const out = new Uint8Array(8 + 25 + (12 + idat.length) + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const c of [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]) { out.set(c, o); o += c.length; }
  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeFile(path, out);
}
const lum = (p: Uint8Array, i: number) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
function stats(px: Uint8Array) {
  let s = 0, n = 0, hi = 0, mid = 0, top = 0;
  for (let i = 0; i < px.length; i += 4) { const l = lum(px, i); s += l; n++; if (l > 0.9) hi++; if (l > 0.5) mid++; if (l > 0.35) top++; }
  const rows = (y0: number, y1: number) => { let s2 = 0, k = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { s2 += lum(px, (y * W + x) * 4); k++; } return s2 / k; };
  const corner = rows(0, 8);
  const bottom = rows(H - 4, H);
  const aboveBottom = rows(H - 24, H - 12);
  return {
    mean: s / n, b90: hi / n, b50: mid / n, b35: top / n,
    corner: corner.toFixed(4), bottom: bottom.toFixed(4), aboveBottom: aboveBottom.toFixed(4),
    bottomRatio: (bottom / Math.max(1e-6, aboveBottom)).toFixed(2),
  };
}

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { console.error("no adapter"); Deno.exit(2); }
const device = await adapter.requestDevice();
const problems: string[] = [];
(device as any).addEventListener("uncapturederror", (e: any) => problems.push(String(e.error?.message ?? e)));

const config = { flowSpeed: 0.35, glow: 0.5, trail: 0.6, interaction: 0.5, density: 0.3, palette: 0 };
const scene: any = (sceneMod as any).createGPUScene(device, { format: FORMAT, width: W, height: H, config: { ...config } });
const target = device.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
async function grab(): Promise<Uint8Array> {
  scene.render(target.createView());
  const bpr = 256 * Math.ceil((W * 4) / 256);
  const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const m = new Uint8Array(buf.getMappedRange().slice(0));
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) px.set(m.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  buf.unmap(); buf.destroy();
  return px;
}
const step = (n: number) => { for (let i = 0; i < n; i++) scene.update(1 / 60); };
const t0 = Date.now();
step(150);
const palettes = which === "all" ? [0, 1, 2, 3, 4] : [Number(which)];
const names = ["ocean", "purple", "amber", "emerald", "mono"];
for (const p of palettes) {
  scene.setConfig({ palette: p, density: 0.3 });
  step(200);
  const img = await grab();
  await png(new URL(`p${p}-${names[p]}.png`, OUT).pathname, img, W, H);
  console.log(`p${p} ${names[p]}:`, JSON.stringify(stats(img)));
}
// ripple
scene.setConfig({ palette: 0, density: 0.3 });
step(60);
scene.addRipple(0.5, 0.5, 1.0);
step(30);
await png(new URL("ripple-0.5s.png", OUT).pathname, await grab(), W, H);
step(60);
await png(new URL("ripple-1.5s.png", OUT).pathname, await grab(), W, H);
// dense + default view
scene.setConfig({ density: 0.85, glow: 0.6 });
step(200);
const dense = await grab();
await png(new URL("dense.png", OUT).pathname, dense, W, H);
console.log("dense:", JSON.stringify(stats(dense)));
console.log("device errors:", problems.length ? problems : "none");
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s  →  ${OUT.pathname}`);
Deno.exit(0);
