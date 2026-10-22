# The World Between Two Frames

An offline-capable, client-side illustrated-space experiment built with Vite, TypeScript, and Three.js. Begin with the attached panorama as a genuinely flat, color-faithful image; pull it into separate image planes, enter the scene, and travel through scene-space apertures into the two authored demonstration tableaux.

> **Interpretation note:** The supplied panorama is included unchanged as the starting artwork. Layer masks are provisional readings of visible pixels, not automatic semantic segmentation or verified 3D reconstruction. The application does not invent unseen backsides, establish map coordinates, or make Starsilk canon claims. The two bundled vector tableaux are clearly labeled procedural demonstrations.

## Run locally

```bash
npm install
npm run dev
```

Vite prints the local URL. For a production build and static preview:

```bash
npm run typecheck
npm run build
npm run preview
```

The distributable static site is written to `dist/`. Runtime rendering, editing, project persistence, and project archives run entirely in the browser. No account, server database, remote model, CDN, or network asset is required after installation.

## Install on a tablet or phone

Live copy: <https://westkitty.github.io/the-world-between-two-frames/>. It is an installable web app that opens full screen and works offline after the first visit.

- **Chrome (Android / Galaxy Tab):** open the link, tap ⋮ → **Add to Home screen** → **Install** (or **Install app**). The app's **···** menu also shows **INSTALL APP** when the browser offers it.
- **Samsung Internet:** tap ≡ → **Add page to** → **Apps screen**.
- **iPhone / iPad Safari:** Share → **Add to Home Screen**.

The build writes `dist/sw.js` (generated from `pwa/sw.js` by `vite.config.ts`), which precaches the app shell and all artwork under a cache name derived from the build's content hash, so each new deploy replaces the old offline copy. The default base path is `/the-world-between-two-frames/`; set `TWBTF_BASE=/` to host at a site root. Icons are generated from the panorama with `python3 pwa/make-icons.py`. Run the smoke journey against a served copy with `SMOKE_URL=<url> npm run smoke`.

## Interaction

- **Depth:** Pull inward from the lit frame edge, drag the Depth slider, or press `+` / `−`. The image separates into five authored depth roles using masked copies of the actual source pixels. At 24% depth, **Enter Image** becomes available.
- **Explore:** Drag on the scene to look. Use arrow keys or the small direction pad to move; use the wheel to move through depth. The aperture is a hit-tested object in the Three.js scene. **Follow the Next Aperture** physically moves through it; the reverse aperture returns to the previous tableau. `Esc` / the return control glides back to the frame.
- **Edit Layers:** Import a PNG, JPEG, or WebP (1–3 images, up to 32 MB each). Use **Edit Layers → Start Outline**, click 3–24 polygon points over the artwork, close the outline, choose a depth role, edge feather and distance, then save. Existing layer guides can also be adjusted or removed.
- **Save / move projects:** Imported original blobs and mask data autosave in versioned IndexedDB. **Export** creates a ZIP with `manifest.json`, every source image, masks, and provenance notes. **Open Project** restores that archive. If storage is denied, the app warns and recommends ZIP export. **Reset Demo** leaves imported images intact; **Delete Imported Project** is separate and explicit.
- **Access/performance:** Controls have keyboard labels and focus styles; the depth slider is keyboard-accessible. Edge/slider drag works with pointer and touch, low-GPU mode lowers render resolution/particle count, reduced-motion mode shortens transitions, and sound is opt-in. On narrow screens, **More** keeps project open/export and sound/fullscreen controls reachable. Fullscreen is optional.

## Source layout

- `src/main.ts` — one Three.js renderer/animation loop, perspective camera, controlled mode transitions, scene-space portal navigation, IndexedDB, image import, manual masks, and ZIP project IO.
- `src/scenes.ts` — scene model, visible-pixel mask presets, procedural demo tableaux, and role/depth definitions.
- `src/styles.css`, `index.html` — responsive archival instrument UI; no remote fonts or assets.
- `public/artwork/` — the attached panorama plus two original procedural SVG demonstration artworks.
- `scripts/smoke.mjs` — deterministic Chromium/Playwright browser journey test.

## Verification

```bash
npm run typecheck
npm run build
npx playwright install chromium   # one-time browser download for the smoke test
npm run smoke
```

The smoke journey checks the flat start, direct frame-edge drag, peel/entry, visible layer-editor access from Explore, a raycast through a visible scene-space aperture plus two forward crossings and a reverse crossing, frame return/reset, fullscreen/resize recovery, reduced-motion transition completion, image import and polygon-mask authoring, IndexedDB reload, ZIP round-trip, mobile controls/touch, PNG alpha preservation, denied-storage messaging, and browser console/runtime errors. It requires a Chromium installation; software rendering may make the test slower.

## Limitations and provenance

Automatic foreground segmentation/inpainting is intentionally not claimed; the bundled polygons are hand-authored guides and user-drawn masks are the complete manual workflow. Background gaps remain atmospheric/original-image continuations rather than factual reconstructions. The attached source file retains its upload filename (`file_00000000f77881f5987cd6d628ca6347.png`). Its provenance and rights remain with the user/uploader; inclusion here is not a public-domain or license declaration. No Starsilk canon repository was modified or scraped.
