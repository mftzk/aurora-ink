// Aurora Ink — browser glue. This is the only file in the graphics layer allowed to touch the DOM.
//
// It owns the canvas, the device pixel ratio (capped), the resize observers, the RAF loop, the
// pointer/ripple input and the idle "ambient life" heartbeat. It tries the live WebGPU path first
// and falls back honestly to the Canvas 2D renderer if there is no adapter, no device, or the
// device is lost. The badge is driven from here.

import { createGPUScene, DEFAULT_CONFIG } from "./scene.js";
import { createCanvas2DRenderer } from "../canvas2d/renderer.js";

const MAX_PIXELS = 2_400_000;
const IDLE_BEFORE_AMBIENT = 12_000; // ms without pointer input
const AMBIENT_MIN = 22_000;
const AMBIENT_SPAN = 18_000;

function desiredDpr(cssW, cssH) {
  let dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const area = Math.max(1, cssW * cssH);
  if (area * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / area);
  return Math.max(0.4, Math.min(2, dpr));
}

export function createRenderer(canvas, initialConfig, onStatus) {
  const state = {
    config: { ...DEFAULT_CONFIG, ...(initialConfig || {}) },
    pointer: { x: 0.5, y: 0.5, strength: 0, energy: 0 },
    mode: null,
  };

  let active = null;
  let running = true;
  let destroyed = false;
  let rafId = 0;
  let last = 0;
  let lastInteraction = (typeof performance !== "undefined" ? performance.now() : 0);
  let nextAmbient = lastInteraction + IDLE_BEFORE_AMBIENT + AMBIENT_MIN;
  let cssW = 1;
  let cssH = 1;

  const setMode = (mode) => {
    state.mode = mode;
    if (onStatus) onStatus(mode);
  };

  function resizeNow() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width || canvas.clientWidth || 1);
    cssH = Math.max(1, rect.height || canvas.clientHeight || 1);
    const dpr = desiredDpr(cssW, cssH);
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    if (active) active.resize(pw, ph);
  }

  async function buildGPU() {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    let adapter = null;
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    } catch {
      return null;
    }
    if (!adapter) return null;

    let device = null;
    try {
      device = await adapter.requestDevice();
    } catch {
      return null;
    }
    const context = canvas.getContext("webgpu");
    if (!context) return null;

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    const scene = createGPUScene(device, {
      format,
      width: Math.max(64, canvas.width || 1),
      height: Math.max(64, canvas.height || 1),
      config: state.config,
    });

    const controller = {
      kind: "webgpu",
      frame(dt) {
        if (destroyed) return;
        scene.update(dt);
        scene.render(context.getCurrentTexture().createView());
      },
      resize(w, h) {
        scene.resize(Math.max(64, w), Math.max(64, h));
      },
      setConfig(partial) {
        scene.setConfig(partial);
      },
      setPointer(p) {
        scene.setPointer(p);
      },
      addRipple(x, y, s) {
        scene.addRipple(x, y, s);
      },
      destroy() {
        try {
          scene.destroy();
        } catch {
          /* ignore */
        }
      },
    };

    // If the device disappears we must degrade honestly rather than show a frozen frame.
    device.lost.then(() => {
      if (destroyed || active !== controller) return;
      switchTo(false);
    });

    return controller;
  }

  async function switchTo(preferGPU) {
    if (destroyed) return;
    if (active && active.destroy) active.destroy();
    active = null;

    if (preferGPU) {
      const gpu = await buildGPU();
      if (destroyed) {
        if (gpu) gpu.destroy();
        return;
      }
      if (gpu) active = gpu;
    }

    if (!active) {
      active = createCanvas2DRenderer(canvas, state.config);
      active.resize(Math.max(1, canvas.width || 1), Math.max(1, canvas.height || 1));
      active.setConfig(state.config);
    }

    setMode(active.kind);
    resizeNow();
  }

  function loop(now) {
    if (!running || destroyed) return;
    rafId = requestAnimationFrame(loop);
    const dt = last ? Math.min(0.05, Math.max(0, (now - last) / 1000)) : 1 / 60;
    last = now;

    // Ease the pointer strength so it feels like pushing silk, and decay when idle.
    const ptr = state.pointer;
    ptr.energy *= 0.94;
    ptr.strength += (ptr.energy - ptr.strength) * 0.08;

    if (active) {
      active.setPointer(ptr);
      // Ambient life: a very soft automatic ripple after long stretches without input.
      if (now - lastInteraction > IDLE_BEFORE_AMBIENT && now > nextAmbient) {
        active.addRipple(Math.random(), Math.random(), 0.16);
        nextAmbient = now + AMBIENT_MIN + Math.random() * AMBIENT_SPAN;
      }
      active.frame(dt);
    }
  }

  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const prev = state.pointer;
    const dx = x - prev.x;
    const dy = y - prev.y;
    const speed = Math.min(1, Math.hypot(dx, dy) * 6);
    prev.x = x;
    prev.y = y;
    prev.energy = Math.min(1, prev.energy + speed * 0.5 + 0.08);
    lastInteraction = e.timeStamp || performance.now();
  }

  function onPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (active) active.addRipple(x, y, 1);
    lastInteraction = e.timeStamp || performance.now();
  }

  function onPointerLeave() {
    state.pointer.energy = 0;
  }

  function onVisibility() {
    running = !document.hidden;
    last = 0;
    if (running) rafId = requestAnimationFrame(loop);
    else cancelAnimationFrame(rafId);
  }

  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
  canvas.addEventListener("pointerleave", onPointerLeave, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => resizeNow());
    resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", resizeNow);

  resizeNow();
  switchTo(true);
  rafId = requestAnimationFrame(loop);

  return {
    get mode() {
      return state.mode;
    },
    setConfig(partial) {
      Object.assign(state.config, partial || {});
      if (active) active.setConfig(partial);
    },
    setPointer(p) {
      if (!p) return;
      if (p.x !== undefined) state.pointer.x = p.x;
      if (p.y !== undefined) state.pointer.y = p.y;
      if (p.strength !== undefined) state.pointer.energy = p.strength;
      lastInteraction = performance.now();
    },
    addRipple(x, y, s) {
      if (active) active.addRipple(x, y, s);
    },
    toggleRenderer() {
      const nextPreferGPU = state.mode !== "webgpu";
      switchTo(nextPreferGPU);
    },
    destroy() {
      destroyed = true;
      running = false;
      cancelAnimationFrame(rafId);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resizeNow);
      if (resizeObserver) resizeObserver.disconnect();
      if (active && active.destroy) active.destroy();
      active = null;
    },
  };
}
