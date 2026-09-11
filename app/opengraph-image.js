import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          padding: "72px 80px",
          background: "linear-gradient(140deg, #0a1226 0%, #05070c 55%, #0b0f1a 100%)",
          color: "#e7ecf3",
          fontFamily: "system-ui, sans-serif",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -140,
            right: -80,
            width: 620,
            height: 620,
            borderRadius: 620,
            background:
              "radial-gradient(circle at center, rgba(63,182,196,0.5) 0%, rgba(29,91,143,0.18) 45%, rgba(5,7,12,0) 70%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 120,
            left: -120,
            width: 520,
            height: 520,
            borderRadius: 520,
            background:
              "radial-gradient(circle at center, rgba(120,80,220,0.35) 0%, rgba(5,7,12,0) 70%)",
          }}
        />
        <div
          style={{
            fontSize: 26,
            letterSpacing: 8,
            textTransform: "uppercase",
            color: "#9aa4b2",
            marginBottom: 18,
          }}
        >
          Ambient generative
        </div>
        <div style={{ fontSize: 104, fontWeight: 600, letterSpacing: -2 }}>Aurora Ink</div>
        <div style={{ fontSize: 30, color: "#9aa4b2", marginTop: 16 }}>
          Flowing aurora. Liquid ink. Slow light.
        </div>
      </div>
    ),
    size
  );
}
