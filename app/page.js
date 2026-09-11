"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createRenderer } from "./lib/webgpu/renderer";
import { PALETTES } from "./lib/webgpu/shaders";
import { DEFAULT_CONFIG } from "./lib/webgpu/scene";

const CONTROLS = [
  { id: "flowSpeed", label: "Flow" },
  { id: "glow", label: "Glow" },
  { id: "trail", label: "Trails" },
  { id: "interaction", label: "Interaction" },
  { id: "density", label: "Density" },
];

const SWATCH_STYLE = (colors) => ({
  background: `linear-gradient(135deg, rgb(${colors[1]
    .map((c) => Math.round(c * 255))
    .join(",")}) 0%, rgb(${colors[2].map((c) => Math.round(c * 255)).join(",")}) 55%, rgb(${colors[3]
    .map((c) => Math.round(c * 255))
    .join(",")}) 100%)`,
});

export default function Page() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const [config, setConfig] = useState(() => ({ ...DEFAULT_CONFIG }));
  const [mode, setMode] = useState(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderer = createRenderer(canvas, { ...DEFAULT_CONFIG }, setMode);
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "h" || e.key === "H") setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSlide = useCallback((key) => (e) => {
    const value = Number(e.target.value);
    rendererRef.current?.setConfig({ [key]: value });
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const onPalette = useCallback((index) => () => {
    rendererRef.current?.setConfig({ palette: index });
    setConfig((prev) => ({ ...prev, palette: index }));
  }, []);

  const onToggleRenderer = useCallback(() => {
    rendererRef.current?.toggleRenderer();
  }, []);

  const badge = mode === "webgpu" ? "WebGPU" : "Canvas 2D (fallback)";

  return (
    <>
      <canvas ref={canvasRef} className="aurora" aria-label="Aurora Ink ambient scene" />

      <section
        id="aurora-panel"
        data-testid="ui-panel"
        className={`panel${open ? "" : " panel--hidden"}`}
        aria-expanded={open}
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <h1 className="panel__title">Aurora Ink</h1>

        {CONTROLS.map(({ id, label }) => (
          <div className="control" key={id}>
            <div className="control__row">
              <label className="control__label" htmlFor={`ctl-${id}`}>
                {label}
              </label>
            </div>
            <input
              id={`ctl-${id}`}
              data-testid={`ctl-${id}`}
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={config[id]}
              onChange={onSlide(id)}
            />
          </div>
        ))}

        <div className="palettes">
          {PALETTES.map((p, i) => (
            <button
              key={p.id}
              type="button"
              data-testid={`palette-${p.id}`}
              aria-label={p.name}
              title={p.name}
              className={`swatch${config.palette === i ? " swatch--active" : ""}`}
              style={SWATCH_STYLE(p.colors)}
              onClick={onPalette(i)}
            />
          ))}
        </div>
        <div className="palette-name">{PALETTES[config.palette]?.name}</div>

        <div className="panel__footer">
          <span data-testid="renderer-badge" className="badge" title={`Renderer: ${badge}`}>
            {badge}
          </span>
          <button
            type="button"
            data-testid="renderer-toggle"
            className="renderer-toggle"
            aria-label="Switch renderer"
            title="Switch renderer"
            onClick={onToggleRenderer}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 8h13l-3-3M20 16H7l3 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="credit">hermes + deepseek</div>
      </section>

      <button
        type="button"
        data-testid="ui-toggle"
        className="ui-toggle"
        aria-expanded={open}
        aria-controls="aurora-panel"
        aria-label={open ? "Hide controls" : "Show controls"}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </>
  );
}
