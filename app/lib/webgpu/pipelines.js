// Aurora Ink — explicit GPU bind group layouts and render/compute pipelines.
//
// Every layout is hand-written (never `layout: "auto"`) so scene.js can build bind groups
// predictably and so the harness can verify them for both rgba8unorm and bgra8unorm targets.
// Shader modules are memoised per device — one module per pass, created once.

import { WGSL_MODULES } from "./shaders.js";

export const SIM_TEXTURE_FORMAT = "rgba16float";

const moduleCache = new WeakMap();

function shaderModules(device) {
  let mods = moduleCache.get(device);
  if (!mods) {
    mods = {};
    for (const [name, code] of Object.entries(WGSL_MODULES)) {
      mods[name] = device.createShaderModule({ code, label: `aurora-${name}` });
    }
    moduleCache.set(device, mods);
  }
  return mods;
}

export function createPipelines(device, format) {
  const mods = shaderModules(device);
  const SIM = SIM_TEXTURE_FORMAT;
  const COMPUTE = GPUShaderStage.COMPUTE;
  const FRAGMENT = GPUShaderStage.FRAGMENT;
  const VERTEX = GPUShaderStage.VERTEX;

  // Compute passes share one shape: uniform | sampled | sampler | sampled | storage-write.
  const compute = device.createBindGroupLayout({
    label: "aurora-compute",
    entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: COMPUTE, sampler: { type: "filtering" } },
      { binding: 3, visibility: COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: COMPUTE, storageTexture: { access: "write-only", format: SIM } },
    ],
  });

  const particlesUpdate = device.createBindGroupLayout({
    label: "aurora-particles-update",
    entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: COMPUTE, sampler: { type: "filtering" } },
      { binding: 3, visibility: COMPUTE, buffer: { type: "storage" } },
    ],
  });

  // Particle draw reads the sim buffer as read-only storage in the vertex stage.
  const particleDraw = device.createBindGroupLayout({
    label: "aurora-particle-draw",
    entries: [
      { binding: 0, visibility: VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  // Blur chain: uniform | sampled | sampler.
  const blur = device.createBindGroupLayout({
    label: "aurora-blur",
    entries: [
      { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const bright = device.createBindGroupLayout({
    label: "aurora-bright",
    entries: [
      { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const composite = device.createBindGroupLayout({
    label: "aurora-composite",
    entries: [
      { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const layouts = { compute, particlesUpdate, particleDraw, blur, bright, composite };

  const additive = {
    color: { srcFactor: "one", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
  };

  const velocityPipeline = device.createComputePipeline({
    label: "aurora-velocity",
    layout: device.createPipelineLayout({ bindGroupLayouts: [compute] }),
    compute: { module: mods.velocity, entryPoint: "main" },
  });

  const dyePipeline = device.createComputePipeline({
    label: "aurora-dye",
    layout: device.createPipelineLayout({ bindGroupLayouts: [compute] }),
    compute: { module: mods.dye, entryPoint: "main" },
  });

  const particlesUpdatePipeline = device.createComputePipeline({
    label: "aurora-particles-update",
    layout: device.createPipelineLayout({ bindGroupLayouts: [particlesUpdate] }),
    compute: { module: mods.particlesUpdate, entryPoint: "main" },
  });

  const particleDrawPipeline = device.createRenderPipeline({
    label: "aurora-particle-draw",
    layout: device.createPipelineLayout({ bindGroupLayouts: [particleDraw] }),
    vertex: { module: mods.particleDraw, entryPoint: "vs" },
    fragment: {
      module: mods.particleDraw,
      entryPoint: "fs",
      targets: [{ format: SIM, blend: additive }],
    },
    primitive: { topology: "triangle-list" },
  });

  const brightPipeline = device.createRenderPipeline({
    label: "aurora-bright",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bright] }),
    vertex: { module: mods.bright, entryPoint: "vsFull" },
    fragment: { module: mods.bright, entryPoint: "fs", targets: [{ format: SIM }] },
    primitive: { topology: "triangle-list" },
  });

  const downsamplePipeline = device.createRenderPipeline({
    label: "aurora-downsample",
    layout: device.createPipelineLayout({ bindGroupLayouts: [blur] }),
    vertex: { module: mods.downsample, entryPoint: "vsFull" },
    fragment: { module: mods.downsample, entryPoint: "fs", targets: [{ format: SIM }] },
    primitive: { topology: "triangle-list" },
  });

  const upsamplePipeline = device.createRenderPipeline({
    label: "aurora-upsample",
    layout: device.createPipelineLayout({ bindGroupLayouts: [blur] }),
    vertex: { module: mods.upsample, entryPoint: "vsFull" },
    fragment: { module: mods.upsample, entryPoint: "fs", targets: [{ format: SIM, blend: additive }] },
    primitive: { topology: "triangle-list" },
  });

  const compositePipeline = device.createRenderPipeline({
    label: "aurora-composite",
    layout: device.createPipelineLayout({ bindGroupLayouts: [composite] }),
    vertex: { module: mods.composite, entryPoint: "vsFull" },
    fragment: { module: mods.composite, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  return {
    velocity: velocityPipeline,
    dye: dyePipeline,
    particlesUpdate: particlesUpdatePipeline,
    particleDraw: particleDrawPipeline,
    bright: brightPipeline,
    downsample: downsamplePipeline,
    upsample: upsamplePipeline,
    composite: compositePipeline,
    layouts,
  };
}
