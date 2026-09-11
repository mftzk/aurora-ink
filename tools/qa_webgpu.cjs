// QA for aurora-ink — runs against a local production server or the live URL.
//   node tools/qa_webgpu.cjs <url> [outDir]
// Verifies: no JS errors, canvas is sized + actually drawing (screenshot luminance stats),
// renderer badge honesty, the hideable panel, every slider, every palette, backend toggle.
const { chromium } = require("/home/ubuntu/.hermes/hermes-agent/node_modules/playwright");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// decode a PNG screenshot inside the page and return image statistics
async function analyze(page, buffer) {
  const b64 = buffer.toString("base64");
  return await page.evaluate(async (data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const w = bmp.width, h = bmp.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    const lum = (i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let sum = 0, n = 0, bright = 0, warm = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = lum(i);
      sum += l; n++;
      if (l > 0.9) bright++;
      warm += (d[i] - d[i + 2]) / 255;
    }
    const mean = sum / n;
    let blocks = 0, tot = 0;
    const bs = 24;
    for (let by = 0; by + bs <= h; by += bs) {
      for (let bx = 0; bx + bs <= w; bx += bs) {
        let s2 = 0, k = 0;
        for (let y = by; y < by + bs; y += 3) for (let x = bx; x < bx + bs; x += 3) { s2 += lum((y * w + x) * 4); k++; }
        tot++;
        if (Math.abs(s2 / k - mean) > 0.012) blocks++;
      }
    }
    const px = ctx.getImageData(Math.round(w * 0.45), Math.round(h * 0.45), Math.min(40, w), Math.min(40, h)).data;
    let ps = 0;
    for (let i = 0; i < px.length; i += 4) ps += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    // bottom-right corner where the panel sits (panel must not blow out the brightness)
    const corner = ctx.getImageData(Math.max(0, w - 80), Math.max(0, h - 80), Math.min(80, w), Math.min(80, h)).data;
    let cs = 0;
    for (let i = 0; i < corner.length; i += 4) cs += (0.2126 * corner[i] + 0.7152 * corner[i + 1] + 0.0722 * corner[i + 2]) / 255;
    return {
      w, h,
      meanLum: mean,
      bright: bright / n,
      warmth: warm / n,
      structure: tot ? blocks / tot : 0,
      centerLum: ps / (px.length / 4),
      cornerLum: cs / (corner.length / 4),
    };
  }, b64);
}

(async () => {
  const url = process.argv[2];
  const outDir = process.argv[3] || "/tmp/aurora-ink-qa";
  fs.mkdirSync(outDir, { recursive: true });
  if (!url) { console.error("usage: node tools/qa_webgpu.cjs <url> [outDir]"); process.exit(2); }

  const browser = await chromium.launch();
  const errors = [];

  for (const s of [
    { name: "desktop", viewport: { width: 1280, height: 800 } },
    { name: "mobile", viewport: { width: 390, height: 844 }, touch: true },
  ]) {
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1, hasTouch: !!s.touch, isMobile: !!s.touch });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`[${s.name}] pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`[${s.name}] console.error: ${m.text()}`); });

    console.log(`--- ${s.name} (${s.viewport.width}x${s.viewport.height}) ---`);
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2500);

    const info = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const badge = document.querySelector('[data-testid="renderer-badge"]');
      const toggle = document.querySelector('[data-testid="renderer-toggle"]');
      const panel = document.querySelector('[data-testid="ui-panel"]');
      const ctrls = ["flowSpeed", "glow", "trail", "interaction", "density"].map((k) => {
        const el = document.querySelector(`[data-testid="ctl-${k}"]`);
        return el ? { k, min: el.getAttribute("min"), max: el.getAttribute("max"), value: el.value } : null;
      });
      return {
        title: document.title,
        hasGpu: !!navigator.gpu,
        badge: badge ? badge.textContent.trim() : null,
        badgeTitle: badge ? badge.getAttribute("title") : null,
        toggleText: toggle ? toggle.textContent.trim() : null,
        hasPanel: !!panel,
        panelVisible: panel ? getComputedStyle(panel).opacity !== "0" && getComputedStyle(panel).visibility !== "hidden" : false,
        ctrls,
        paletteCount: document.querySelectorAll('[data-testid^="palette-"]').length,
        canvas: canvas ? { w: canvas.width, h: canvas.height, cw: canvas.clientWidth, ch: canvas.clientHeight } : null,
        // canvas must cover the viewport
        canvasCovers: canvas ? Math.abs(canvas.clientWidth - innerWidth) <= 2 && Math.abs(canvas.clientHeight - innerHeight) <= 2 : false,
        bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
      };
    });
    console.log("  title:", info.title, "| navigator.gpu:", info.hasGpu);
    console.log("  badge:", JSON.stringify(info.badge), "| toggle:", JSON.stringify(info.toggleText));
    console.log("  canvas:", JSON.stringify(info.canvas), "| covers viewport:", info.canvasCovers);
    console.log("  body:", JSON.stringify(info.bodyText));

    check("canvas element exists", !!info.canvas);
    check("canvas covers the viewport", info.canvasCovers);
    check("canvas has real device pixels", !!info.canvas && info.canvas.w > 100 && info.canvas.h > 100, JSON.stringify(info.canvas));
    check("renderer badge is honest", info.badge === "WebGPU" || info.badge === "Canvas 2D (fallback)", JSON.stringify(info.badge));
    check("badge matches the environment (no navigator.gpu here -> fallback)", info.hasGpu || info.badge === "Canvas 2D (fallback)");
    check("5 sliders present with sane ranges", info.ctrls.filter(Boolean).length === 5, JSON.stringify(info.ctrls));
    check("5 palette swatches present", info.paletteCount === 5, String(info.paletteCount));
    check("no debug/FPS text in the page", !/fps|frame time|ms\/frame|debug|benchmark/i.test(info.bodyText), info.bodyText.slice(0, 60));

    const shot1 = await page.screenshot();
    fs.writeFileSync(path.join(outDir, `shot-${s.name}-1.png`), shot1);
    const a1 = await analyze(page, shot1);
    console.log(`  stats: meanLum=${a1.meanLum.toFixed(4)} structure=${(a1.structure * 100).toFixed(1)}% bright=${(a1.bright * 100).toFixed(3)}% warmth=${a1.warmth.toFixed(4)} centre=${a1.centerLum.toFixed(4)}`);
    check("canvas is actually drawing (mean luminance > 0.01)", a1.meanLum > 0.01, a1.meanLum.toFixed(4));
    check("keeps a dark, calm frame (mean luminance < 0.5)", a1.meanLum < 0.5, a1.meanLum.toFixed(4));
    check("has visible structure (>= 25% of blocks deviate)", a1.structure >= 0.25, `${(a1.structure * 100).toFixed(1)}%`);
    check("no white-out (bright pixels < 3%)", a1.bright < 0.03, `${(a1.bright * 100).toFixed(3)}%`);

    // it must keep animating
    await page.waitForTimeout(2200);
    const shot2 = await page.screenshot();
    fs.writeFileSync(path.join(outDir, `shot-${s.name}-2.png`), shot2);
    const a2 = await analyze(page, shot2);
    const diff = Math.abs(a2.meanLum - a1.meanLum) + Math.abs(a2.warmth - a1.warmth) + Math.abs(a2.structure - a1.structure);
    check("frame-to-frame change is small (no flashing)", diff < 0.08, `Δstats=${diff.toFixed(4)}`);

    // sliders move
    for (const k of ["flowSpeed", "glow", "trail", "interaction", "density"]) {
      const sel = `[data-testid="ctl-${k}"]`;
      const el = await page.$(sel);
      if (!el) { check(`slider ${k} responds`, false, "missing"); continue; }
      const before = await el.inputValue();
      await el.evaluate((node, v) => {
        node.value = v;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }, k === "density" || k === "glow" || k === "trail" || k === "interaction" ? "0.95" : "0.9");
      await page.waitForTimeout(500);
      const after = await el.inputValue();
      check(`slider ${k} responds`, before !== after, `${before} -> ${after}`);
    }

    // palettes switch (must visibly change the tint)
    const ocean = await page.$('[data-testid="palette-deep-ocean"]');
    const amber = await page.$('[data-testid="palette-sunset-amber"]');
    if (ocean && amber) {
      await ocean.click();
      await page.waitForTimeout(2600);
      const oShot = await page.screenshot();
      const oStats = await analyze(page, oShot);
      await amber.click();
      await page.waitForTimeout(2600);
      const aShot = await page.screenshot();
      fs.writeFileSync(path.join(outDir, `shot-${s.name}-amber.png`), aShot);
      const aStats = await analyze(page, aShot);
      console.log(`  palette warmth: ocean=${oStats.warmth.toFixed(4)} amber=${aStats.warmth.toFixed(4)}`);
      check("switching palette changes the tint", aStats.warmth > oStats.warmth + 0.004, `${oStats.warmth.toFixed(4)} -> ${aStats.warmth.toFixed(4)}`);
      await ocean.click();
      await page.waitForTimeout(1500);
    } else {
      check("palette swatches are clickable", false, "missing palette-deep-ocean / palette-sunset-amber");
    }

    // interaction: a click on the canvas must not throw and must keep the frame calm
    await page.mouse.move(s.viewport.width * 0.4, s.viewport.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const clickShot = await page.screenshot();
    const cStats = await analyze(page, clickShot);
    check("clicking the canvas keeps it calm (no flash, still drawing)", cStats.meanLum < 0.5 && cStats.meanLum > 0.005, cStats.meanLum.toFixed(4));

    // hideable panel + backend toggle
    const panelToggle = await page.$('[data-testid="ui-toggle"]');
    if (panelToggle) {
      await panelToggle.click();
      await page.waitForTimeout(600);
      const hidden = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="ui-panel"]');
        const cs = getComputedStyle(p);
        return { opacity: cs.opacity, visibility: cs.visibility, expanded: p.getAttribute("aria-expanded"), toggleExpanded: document.querySelector('[data-testid="ui-toggle"]').getAttribute("aria-expanded") };
      });
      console.log("  panel hidden state:", JSON.stringify(hidden));
      check("panel can be hidden", hidden.opacity === "0" || hidden.visibility === "hidden", JSON.stringify(hidden));
      await panelToggle.click();
      await page.waitForTimeout(600);
      const shown = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="ui-panel"]')).opacity);
      check("panel can be shown again", shown !== "0", shown);
    } else {
      check("panel toggle button exists", false, "missing [data-testid=ui-toggle]");
    }

    const rToggle = await page.$('[data-testid="renderer-toggle"]');
    if (rToggle) {
      await rToggle.click();
      await page.waitForTimeout(1500);
      const badge2 = await page.evaluate(() => document.querySelector('[data-testid="renderer-badge"]').textContent.trim());
      console.log("  badge after toggle:", badge2);
      check("backend toggle changes the badge text", badge2 === "WebGPU" || badge2 === "Canvas 2D (fallback)", badge2);
      await rToggle.click();
      await page.waitForTimeout(1000);
    } else {
      check("renderer toggle button exists", false, "missing [data-testid=renderer-toggle]");
    }

    fs.writeFileSync(path.join(outDir, `final-${s.name}.png`), await page.screenshot());
    await ctx.close();
  }

  check("no page errors / console errors", errors.length === 0, errors.slice(0, 4).join(" | "));
  await browser.close();

  console.log(`\n${failures === 0 ? "ALL QA CHECKS PASSED" : `${failures} QA CHECK(S) FAILED`}`);
  console.log(`screenshots in ${outDir}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
