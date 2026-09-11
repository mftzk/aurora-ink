# ART DIRECTION — round 2 (review feedback on the harness frames)

The gates pass, but the *look* is not there yet. I reviewed the actual frames in `tools/out/`
(`frame-t0.png`, `frame-palette-3-emerald-aurora.png`, `frame-ripple.png`, `frame-particles.png`)
at 512×288 with the default config. All numbers below are for that frame size — express them
relative to resolution so they scale to 1920×1080.

**You cannot see the images, so follow these numbers literally and let the reviewer judge.**

## 1. Kill the hard bright horizontal band along the bottom edge
Every frame ends on a bright teal line at the very bottom row (`frame-t0.png`,
`frame-palette-2`, `frame-palette-3`) — it reads as a rendering artifact, not as art.
- Requirement: the bottom-most rows must not form a line — `meanLum(rows h-1..h-4) <= meanLum(rows h-24..h-12) * 1.05`.
- Likely causes to check: velocity/dye border handling, the orbiting emitter path reaching the
  border, or the dye/emissive texture covering only part of the frame.
- Fix by fading the dye + emissive out with a soft edge mask (`smoothstep` over the outer ~4% of
  width/height on all four sides), so the frame dissolves into the darkness instead of ending on an edge.
- Keep the dark-corner harness check passing (corner < 0.12).

## 2. Particles currently read as noise, not as drifting light
The frame is covered in a uniform field of tiny sharp dots (harness measured 1.68% of pixels with
lum > 0.35). It looks like static/snow. Change:
- **Count**: at 512×288 the default density (0.45) must yield ≈ 3 000–5 000 active particles
  (rule of thumb `count ≈ area * 0.055 * mix(0.25, 1.0, density)` → ~15 k at 1920×1080). Cap the
  capacity at 65536 as before.
- **Sprite**: soft gaussian falloff, core radius ≈ 0.008 × frame height (≈ 2.3 px at 288) with the
  falloff reaching ~3× that. No 1–2 px hard dots.
- **Brightness**: a single particle must peak at ≈ 0.30–0.35 before compositing — faint motes.
- **Shape**: streak, not dot — length 3–6× the width, aligned with the local flow velocity.
- **Placement**: bias respawn/visibility by the local dye (aurora) intensity so motes appear inside
  the glowing bands and travel with them. No uniform starfield.
- Target after the change: fraction of pixels with lum > 0.35 at default density ≈ 0.15–0.6%.
  The harness check "light traces / particles are visible" (threshold 0.05% at density 0.6) must
  still pass, and "visual density slider changes the image" must still pass.

## 3. Aurora must read as ribbons
Right now the bands are soft fog. Make them structured:
- 2–4 clearly readable elongated bands, each 4–10% of frame height thick, curved, following the flow.
- Sharpen across the band axis (`smoothstep` over a narrow range) while keeping a wide soft outer falloff.
- Brightness gradient along each band (dimmer at the ends), palette gradient across the band
  (`col0` → `col1` → `col2` core).
- Constraints: peak ≤ 0.55, mean 0.06–0.10, corner < 0.05, motion slow and non-flickering.

## 4. The click ripple reads as a filled blob
`frame-ripple.png` shows a soft cyan disc at the click point. It should be an **expanding soft
annulus**: ring radius growing with age, ring thickness ≈ 8–15% of the radius, brightness falling
off with age, and only a very faint filled core (≤ 15% of ring brightness, decaying fast). It must
read as an energy wave travelling outward through the flow, not a light bulb.

## 5. Composition / negative space
Keep the corners genuinely dark and the aurora confined to a flowing diagonal region instead of
covering the whole frame evenly. Depth is: dark bed → faint nebula → 2–4 ribbons → sparse motes.

## 6. Canvas 2D fallback (`tools/out/qa/final-desktop.png`) needs the same treatment
It currently draws long straight hard-edged streaks that look like scratches/rain:
- Replace with soft curved strands: short quadratic curves following a slowly rotating curl field,
  line width varying ~1–3 px, alpha 0.02–0.06, `lineCap: "round"`, `globalCompositeOperation: "lighter"`.
- Add 3–4 large soft radial-gradient nebula blobs (additive, very low alpha) behind the strands,
  plus a gentle vignette.
- Fewer, slower, softer — it must feel like the same product as the GPU path.

## Gate (unchanged, must all stay green)
- `bash tools/run_wgpu_check.sh` → `ALL CHECKS PASSED` (do NOT edit the harness to make it pass)
- `npm run build` → clean
- `bash tools/run_qa.sh` → `ALL QA CHECKS PASSED`
