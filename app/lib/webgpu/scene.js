// Aurora Ink — orchestration layer. DOM-free so the Deno/wgpu harness can drive it directly.
//
// createGPUScene() owns every GPU resource and the per-frame pass order:
//   velocity -> dye -> particlesUpdate -> particleDraw -> bright -> downsample x3 -> upsample x3
// update(dt) advances the simulation by dt only (never wall clock) and submits those passes.
// render(view) composites the finished frame into the caller's target and submits its own encoder.
//
// `render` is deliberately separate from `update` so the harness can run N simulation steps and
// then read back a single frame; queue ordering keeps the result correct.

import { createPipelines, SIM_TEXTURE_FORMAT } from "./pipelines.js";
import { PALETTES, PARTICLE_CAPACITY, UNIFORM_BYTES } from "./shaders.js";

export const DEFAULT_CONFIG = {
  flowSpeed: 0.35,
  glow: 0.5,
  trail: 0.6,
  interaction: 0.5,
  density: 0.45,
  palette: 0,
};

const SIM = SIM_TEXTURE_FORMAT;
const UNIFORM_FLOATS = UNIFORM_BYTES / 4; // 44
const RIPPLE_LIFE = 5.0; // seconds — matches the ~4-6 s growing/fading energy wave

const PARTICLE_FLOATS = PARTICLE_CAPACITY * 6;
const PARTICLE_BYTES = PARTICLE_FLOATS * 4;

// Kept in lock-step with the WGSL `particlesUpdate` formula. The upper bound is deliberately
// modest: particles are an accent (soft drifting motes), not the subject — the ink is. A low
// count also keeps the software Vulkan adapter used by the verification harness tractable.
function particleCount(density) {
  const d = Math.min(1, Math.max(0, density));
  const n = Math.round(800 + 5000 * Math.pow(d, 1.4));
  return Math.min(n, PARTICLE_CAPACITY);
}

export function createGPUScene(device, { format, width, height, config }) {
  // WebGPU usage flags are read here (not at module scope) so this module stays importable in
  // plain Node/Deno without a GPU global present.
  const STORE_USAGE =
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const RENDER_USAGE = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

  const pipelines = createPipelines(device, format);
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const uniformBuffer = device.createBuffer({
    label: "aurora-uniforms",
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uf = new Float32Array(UNIFORM_FLOATS);

  const state = { ...DEFAULT_CONFIG, ...(config || {}) };

  // Palette crossfade state: live colours lerp from start -> target over >= 1.5 s.
  const PALETTE_BLEND_SECONDS = 1.6;
  let liveCols = PALETTES[state.palette % PALETTES.length].colors.map((c) => c.slice());
  let startCols = liveCols.map((c) => c.slice());
  let targetCols = liveCols.map((c) => c.slice());
  let blend = 1;

  let simTime = 0;
  let frame = 0;
  let ptr = { x: 0.5, y: 0.5, strength: 0 };

  // Up to three live ripples; the oldest is recycled when a fourth arrives.
  const ripples = [null, null, null];

  // Particle storage: 6 f32 per particle. Randomised once; the shader keeps it alive.
  const particleBuffer = device.createBuffer({
    label: "aurora-particles",
    size: PARTICLE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  initParticles();

  let width_ = 0;
  let height_ = 0;
  let velW = 0;
  let velH = 0;
  let dyeW = 0;
  let dyeH = 0;
  let velIdx = 0;
  let dyeIdx = 0;

  let resources = null; // { velTex, dyeTex, emissive, bloom, views, bind }

  function initParticles() {
    const data = new Float32Array(PARTICLE_FLOATS);
    for (let i = 0; i < PARTICLE_CAPACITY; i++) {
      const o = i * 6;
      data[o + 0] = Math.random();
      data[o + 1] = Math.random();
      data[o + 2] = 0;
      data[o + 3] = 0;
      data[o + 4] = Math.random();
      data[o + 5] = Math.random();
    }
    device.queue.writeBuffer(particleBuffer, 0, data);
  }

  function clearTexture(texture, w, h) {
    const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
    const data = new Uint8Array(bytesPerRow * h);
    device.queue.writeTexture({ texture }, data, { bytesPerRow, rowsPerImage: h }, [w, h, 1]);
  }

  function allocate(w, h) {
    releaseResources();
    width_ = Math.max(1, Math.floor(w));
    height_ = Math.max(1, Math.floor(h));
    velW = Math.max(1, Math.ceil(width_ / 4));
    velH = Math.max(1, Math.ceil(height_ / 4));
    dyeW = Math.max(1, Math.ceil(width_ / 2));
    dyeH = Math.max(1, Math.ceil(height_ / 2));

    const velTex = [
      device.createTexture({ size: [velW, velH], format: SIM, usage: STORE_USAGE }),
      device.createTexture({ size: [velW, velH], format: SIM, usage: STORE_USAGE }),
    ];
    const dyeTex = [
      device.createTexture({ size: [dyeW, dyeH], format: SIM, usage: STORE_USAGE }),
      device.createTexture({ size: [dyeW, dyeH], format: SIM, usage: STORE_USAGE }),
    ];
    clearTexture(velTex[0], velW, velH);
    clearTexture(velTex[1], velW, velH);
    clearTexture(dyeTex[0], dyeW, dyeH);
    clearTexture(dyeTex[1], dyeW, dyeH);

    const emissive = device.createTexture({ size: [dyeW, dyeH], format: SIM, usage: RENDER_USAGE });

    const bloom = [];
    for (let i = 0; i < 4; i++) {
      const bw = Math.max(8, Math.ceil(width_ / (2 << i)));
      const bh = Math.max(8, Math.ceil(height_ / (2 << i)));
      bloom.push(device.createTexture({ size: [bw, bh], format: SIM, usage: RENDER_USAGE }));
    }

    const velView = velTex.map((t) => t.createView());
    const dyeView = dyeTex.map((t) => t.createView());
    const emView = emissive.createView();
    const bloomView = bloom.map((t) => t.createView());

    const L = pipelines.layouts;
    const bind = {
      velocity: [0, 1].map((inIdx) =>
        device.createBindGroup({
          layout: L.compute,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: velView[inIdx] },
            { binding: 2, resource: sampler },
            { binding: 3, resource: velView[inIdx] },
            { binding: 4, resource: velView[1 - inIdx] },
          ],
        }),
      ),
      // [currentVelocityIndex][dyeInIndex]
      dye: [0, 1].map((vIdx) =>
        [0, 1].map((dIdx) =>
          device.createBindGroup({
            layout: L.compute,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: velView[vIdx] },
              { binding: 2, resource: sampler },
              { binding: 3, resource: dyeView[dIdx] },
              { binding: 4, resource: dyeView[1 - dIdx] },
            ],
          }),
        ),
      ),
      particlesUpdate: [0, 1].map((vIdx) =>
        device.createBindGroup({
          layout: L.particlesUpdate,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: velView[vIdx] },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: particleBuffer } },
          ],
        }),
      ),
      particleDraw: device.createBindGroup({
        layout: L.particleDraw,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: particleBuffer } },
        ],
      }),
      bright: [0, 1].map((dIdx) =>
        device.createBindGroup({
          layout: L.bright,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: dyeView[dIdx] },
            { binding: 2, resource: emView },
            { binding: 3, resource: sampler },
          ],
        }),
      ),
      blur: [0, 1, 2, 3].map((i) =>
        device.createBindGroup({
          layout: L.blur,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: bloomView[i] },
            { binding: 2, resource: sampler },
          ],
        }),
      ),
      composite: [0, 1].map((dIdx) =>
        device.createBindGroup({
          layout: L.composite,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: dyeView[dIdx] },
            { binding: 2, resource: emView },
            { binding: 3, resource: bloomView[0] },
            { binding: 4, resource: sampler },
          ],
        }),
      ),
    };

    resources = { velTex, dyeTex, emissive, bloom, views: { velView, dyeView, emView, bloomView }, bind };
  }

  function releaseResources() {
    if (!resources) return;
    for (const t of resources.velTex) t.destroy();
    for (const t of resources.dyeTex) t.destroy();
    resources.emissive.destroy();
    for (const t of resources.bloom) t.destroy();
    resources = null;
  }

  function writeUniforms(dt) {
    const d = Math.min(1, Math.max(0, state.density));
    uf[0] = width_;
    uf[1] = height_;
    uf[2] = velW;
    uf[3] = velH;

    uf[4] = simTime;
    uf[5] = dt;
    uf[6] = frame;
    uf[7] = blend;

    uf[8] = ptr.x;
    uf[9] = ptr.y;
    uf[10] = ptr.strength;
    uf[11] = d;

    for (let i = 0; i < 3; i++) {
      const o = 12 + i * 4;
      const r = ripples[i];
      if (r && r.active) {
        uf[o + 0] = r.x;
        uf[o + 1] = r.y;
        uf[o + 2] = Math.min(1, r.age / RIPPLE_LIFE);
        uf[o + 3] = r.strength;
      } else {
        uf[o + 0] = 0;
        uf[o + 1] = 0;
        uf[o + 2] = 1;
        uf[o + 3] = 0;
      }
    }

    for (let c = 0; c < 4; c++) {
      const o = 24 + c * 4;
      uf[o + 0] = liveCols[c][0];
      uf[o + 1] = liveCols[c][1];
      uf[o + 2] = liveCols[c][2];
      uf[o + 3] = 0;
    }

    uf[40] = state.flowSpeed;
    uf[41] = state.glow;
    uf[42] = state.trail;
    uf[43] = state.interaction;

    device.queue.writeBuffer(uniformBuffer, 0, uf);
  }

  function advancePalette(dt) {
    if (blend >= 1) return;
    blend = Math.min(1, blend + dt / PALETTE_BLEND_SECONDS);
    const k = blend * blend * (3 - 2 * blend);
    for (let c = 0; c < 4; c++) {
      for (let ch = 0; ch < 3; ch++) {
        liveCols[c][ch] = startCols[c][ch] + (targetCols[c][ch] - startCols[c][ch]) * k;
      }
    }
  }

  function advanceRipples(dt) {
    for (let i = 0; i < 3; i++) {
      const r = ripples[i];
      if (!r || !r.active) continue;
      r.age += dt;
      if (r.age >= RIPPLE_LIFE) r.active = false;
    }
  }

  function update(dt) {
    if (!resources) return;
    const step = Math.max(0, Math.min(dt, 0.1));
    simTime += step;
    frame = (frame + 1) >>> 0;
    advancePalette(step);
    advanceRipples(step);
    writeUniforms(step);

    const count = particleCount(state.density);
    const enc = device.createCommandEncoder({ label: "aurora-sim" });

    // 1. velocity flow field (reads velIn, writes the other ping-pong target)
    const velInIdx = velIdx;
    let cp = enc.beginComputePass();
    cp.setPipeline(pipelines.velocity);
    cp.setBindGroup(0, resources.bind.velocity[velInIdx]);
    cp.dispatchWorkgroups(Math.ceil(velW / 8), Math.ceil(velH / 8));
    cp.end();
    velIdx = 1 - velInIdx;

    // 2. dye advection + aurora emission
    const dyeInIdx = dyeIdx;
    cp = enc.beginComputePass();
    cp.setPipeline(pipelines.dye);
    cp.setBindGroup(0, resources.bind.dye[velIdx][dyeInIdx]);
    cp.dispatchWorkgroups(Math.ceil(dyeW / 8), Math.ceil(dyeH / 8));
    cp.end();
    dyeIdx = 1 - dyeInIdx;

    // 3. particle integration
    cp = enc.beginComputePass();
    cp.setPipeline(pipelines.particlesUpdate);
    cp.setBindGroup(0, resources.bind.particlesUpdate[velIdx]);
    cp.dispatchWorkgroups(Math.max(1, Math.ceil(count / 256)));
    cp.end();

    // 4. particle sprites -> emissive (cleared each frame, additive)
    let rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: resources.views.emView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    rp.setPipeline(pipelines.particleDraw);
    rp.setBindGroup(0, resources.bind.particleDraw);
    rp.draw(6, count);
    rp.end();

    // 5. bright-pass -> bloom mip 0
    rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: resources.views.bloomView[0],
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    rp.setPipeline(pipelines.bright);
    rp.setBindGroup(0, resources.bind.bright[dyeIdx]);
    rp.draw(3);
    rp.end();

    // 6. downsample bloom mips 1..3
    for (let i = 0; i < 3; i++) {
      rp = enc.beginRenderPass({
        colorAttachments: [
          {
            view: resources.views.bloomView[i + 1],
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      rp.setPipeline(pipelines.downsample);
      rp.setBindGroup(0, resources.bind.blur[i]);
      rp.draw(3);
      rp.end();
    }

    // 7. upsample mips 3..1, added back into the finer mip
    for (let i = 3; i >= 1; i--) {
      rp = enc.beginRenderPass({
        colorAttachments: [
          {
            view: resources.views.bloomView[i - 1],
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      rp.setPipeline(pipelines.upsample);
      rp.setBindGroup(0, resources.bind.blur[i]);
      rp.draw(3);
      rp.end();
    }

    device.queue.submit([enc.finish()]);
  }

  function render(targetView) {
    if (!resources) return;
    const enc = device.createCommandEncoder({ label: "aurora-composite" });
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    rp.setPipeline(pipelines.composite);
    rp.setBindGroup(0, resources.bind.composite[dyeIdx]);
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
  }

  function resize(w, h) {
    if (Math.floor(w) === width_ && Math.floor(h) === height_ && resources) return;
    allocate(w, h);
  }

  function setConfig(partial) {
    if (!partial) return;
    if (partial.palette !== undefined && partial.palette !== state.palette) {
      const idx = ((partial.palette % PALETTES.length) + PALETTES.length) % PALETTES.length;
      state.palette = idx;
      startCols = liveCols.map((c) => c.slice());
      targetCols = PALETTES[idx].colors.map((c) => c.slice());
      blend = 0;
    }
    for (const key of ["flowSpeed", "glow", "trail", "interaction", "density"]) {
      if (partial[key] !== undefined) state[key] = Math.min(1, Math.max(0, partial[key]));
    }
  }

  function setPointer(p) {
    if (!p) return;
    if (p.x !== undefined) ptr.x = p.x;
    if (p.y !== undefined) ptr.y = p.y;
    if (p.strength !== undefined) ptr.strength = Math.min(1, Math.max(0, p.strength));
  }

  function addRipple(x, y, strength) {
    let slot = -1;
    for (let i = 0; i < 3; i++) {
      if (!ripples[i] || !ripples[i].active) {
        slot = i;
        break;
      }
    }
    if (slot === -1) {
      // Recycle the oldest live ripple.
      let oldest = 0;
      for (let i = 1; i < 3; i++) if (ripples[i].age > ripples[oldest].age) oldest = i;
      slot = oldest;
    }
    ripples[slot] = {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      strength: Math.min(1, Math.max(0, strength)),
      age: 0,
      active: true,
    };
  }

  function destroy() {
    releaseResources();
    uniformBuffer.destroy();
    particleBuffer.destroy();
  }

  allocate(width, height);

  return {
    update,
    render,
    resize,
    setConfig,
    setPointer,
    addRipple,
    destroy,
    get config() {
      return { ...state };
    },
  };
}
