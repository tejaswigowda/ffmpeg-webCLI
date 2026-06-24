# ffmpeg-webCLI — `index.html` Refactor Notes

## What was done

The original `docs/index.html` was a **4,920-line monolith** containing:
- 304 lines of inline `<style>` (lines 44–347)
- 26 lines of inline theme-bootstrap `<script>` (lines 18–43)
- ~890 lines of HTML body markup (lines 349–1235)
- ~3,680 lines of inline `<script type="module">` containing ~80 functions spanning 11 unrelated concerns (engine, UI, files, crop, batch, stack, subtitles, auto-caption, process, PWA, helpers)

It has been refactored into a **thin ~900-line HTML shell** plus a **focused ES-module tree** under `docs/js/`. No behavioural changes — every inline `onclick=` handler still calls the same function name; only the wiring moved.

## New file tree

```
ffmpeg-webCLI-refactor/
├── server.js                       (unchanged — copied as-is)
└── docs/
    ├── index.html                  (911 lines — pure HTML markup, no inline CSS/JS)
    ├── styles.css                  (306 lines — extracted verbatim from <style>)
    ├── manifest.json               (unchanged)
    ├── vercel.json                 (unchanged)
    ├── worker.js                   (unchanged — same-origin ffmpeg.wasm worker)
    ├── transcriber.js              (unchanged — Whisper Transformers.js)
    ├── coi-serviceworker.js        (unchanged — COOP/COEP shim)
    ├── three-bvh-csg-shim.js       (unchanged)
    ├── service-worker.js           (UPDATED — precache list now includes styles.css + js/*.js; cache version bumped v3→v4)
    └── js/
        ├── theme.js        ( 31) — synchronous theme bootstrap, runs in <head> before paint
        ├── state.js        (122) — single shared state object + constants (CHAINABLE, STACK_ICON, BATCH_UNSUPPORTED)
        ├── helpers.js      ( 95) — pure utils: blobToDataURL, fmtTime, fmtBytes, mime, clamp, parseShellArgs, buildAtempo, getVideoSize
        ├── engine.js       (322) — FFmpeg WASM + serverFF adapter + loadFFmpeg + isLoaded + setEngine + Whisper source toggle + OpenAI API
        ├── ui.js           (281) — addLog, clearLog, syncProcessBtn, updateInfoPanel, updateSizeEstimate, renderOutput, wake-lock
        ├── trim.js         ( 33) — updateTrim (slider sync)
        ├── files.js        (158) — handleFile, clearInput, drag&drop, on*FileChange aux pickers
        ├── crop.js         (167) — crop state + pointer-drag handlers + canvas rendering
        ├── raw.js          ( 73) — RAW_EXAMPLES library + initRawExamples + updateRawPreview
        ├── operations.js   (378) — setOp (UI switching) + buildOperationArgs (batch-mode args builder)
        ├── batch.js        (523) — batch mode UI + runBatch + processBatchFile + outputs display + ZIP download
        ├── stack.js        (510) — operation stack: opToFilters, composeStackCommand, runProcessStack, batch stack
        ├── subtitles.js    (215) — parseSubtitleCues (SRT/VTT/ASS) + buildCaptionBurnArgs (canvas overlay) + segmentsToSRT
        ├── autocaption.js  (328) — extractAudioAsWAV, Transcriber init, transcript UI, confirm-and-embed
        ├── process.js      (751) — processVideo + runProcess (the giant single-mode per-op switch) + download
        ├── pwa.js          ( 61) — service-worker registration + install prompt
        └── main.js         (114) — entry point: imports all modules, runs init, wires window.* exports for inline onclick
```

## Module dependency graph

```
main.js
  ├── ui.js          (wake-lock visibility listener)
  ├── crop.js        (pointer handlers, video loadeddata/seeked)
  ├── files.js       (drag&drop wiring)
  ├── pwa.js         (SW registration)
  ├── trim.js ─┬─ ui.js
  │            ├─ raw.js
  │            └─ stack.js
  ├── raw.js
  ├── engine.js ── ui.js
  ├── files.js ─┬─ ui.js
  │             ├─ trim.js
  │             ├─ crop.js
  │             └─ raw.js
  ├── operations.js ─┬─ ui.js
  │                  ├─ crop.js
  │                  ├─ raw.js
  │                  └─ stack.js
  ├── process.js ─┬─ engine.js
  │               ├─ ui.js
  │               ├─ subtitles.js
  │               ├─ autocaption.js
  │               └─ batch.js
  ├── batch.js ─┬─ engine.js
  │             ├─ ui.js
  │             ├─ operations.js
  │             └─ stack.js
  ├── stack.js ─┬─ ui.js
  │             ├─ engine.js
  │             ├─ helpers.js
  │             └─ batch.js
  ├── autocaption.js ─┬─ engine.js
  │                   ├─ ui.js
  │                   └─ subtitles.js
  └── ui.js ── helpers.js
```

State flows through the shared `state` object from `state.js` — every module reads/writes `state.input.file`, `state.op.current`, `state.engine.useServerMode`, etc. This avoids ES-module live-binding footguns (you can't reassign an imported binding from another module) and gives a single place to look when debugging.

## Circular-import handling

Several modules have genuine circular dependencies (e.g. `engine.js` calls `addLog` from `ui.js`, but `ui.js`'s `syncProcessBtn` calls `isLoaded` from `engine.js`). ES modules handle this fine for *function calls* (the binding is live, and by the time the function is *called* both modules have finished evaluating), but to keep the call sites clean and avoid any chance of referencing an as-yet-undefined binding, a handful of cross-module calls are deferred through `window.*`:

- `ui.js` → `engine.isLoaded` — inlined into `syncProcessBtn` instead of imported
- `ui.js` → `stack.refreshStackControls` / `stack.renderStack` — deferred via `window.*`
- `engine.js` → `autocaption.updateAutoCaptionInfo` — deferred via `window.*`
- `stack.js` → `batch.updateBatchQueueUI` / `updateBatchOutputsDisplay` — deferred via `window.*`
- `files.js` → `batch.handleBatchFiles` — deferred via `window.*`
- `stack.js` → `batch.loadFirstBatchFileForStack` — deferred via `window.*`

`main.js` populates `window.*` with every function the HTML's inline `onclick=` attributes reference (plus the deferred-call targets above) as the very last thing it does, after all modules have finished evaluating.

## Inline onclick handlers — preserved

Per the user's preference, every inline `onclick="foo()"` attribute in the HTML body is unchanged. The functions are exported to `window` from `main.js` so the inline handlers resolve. This means:

- The HTML diff is just `<style>→<link>`, `<script>→<script src>`, and the theme-bootstrap `<script>` moving to `js/theme.js`.
- Every button in the UI still calls exactly the same function name it did before.
- Reading the HTML still tells you what happens on click — no `data-action` indirection.

## Service-worker precache list — updated

`docs/service-worker.js` now precaches:
- `/styles.css` (was inline before, didn't need caching)
- Every `js/*.js` module (17 files — these load on demand via ES-module `import`, so they all need to be in the cache for offline use)
- `/transcriber.js` and `/three-bvh-csg-shim.js` (already served but weren't in the precache list)

Cache version bumped `v3 → v4` so existing clients will re-fetch the new asset list on next visit.

## What did NOT change

- `server.js` — untouched
- `worker.js` — untouched
- `transcriber.js` — untouched
- `coi-serviceworker.js` — untouched
- `three-bvh-csg-shim.js` — untouched
- `manifest.json` — untouched
- `vercel.json` — untouched
- All operation logic (the per-op ffmpeg args, the stack composition, the auto-caption workflow, the subtitle hard-burn renderer) — byte-for-byte identical, just moved

## How to run

Exactly as before — either:

```bash
# Static host (Vercel, GitHub Pages, etc.)
# Just serve the docs/ folder. coi-serviceworker.js handles COOP/COEP.

# OR local dev with the ffmpeg API:
node ../server.js 5500
# → http://127.0.0.1:5500
```

No build step. No bundler. The ES modules load directly via `<script type="module" src="./js/main.js">` and `import` each other with relative URLs — the browser does the rest.

## Verification done

- ✅ `node --check` on all 17 JS modules + 5 support JS files — all parse cleanly
- ✅ Every inline `onclick=` in the new `index.html` references a function name that is exported to `window` in `main.js`
- ✅ Service-worker precache list covers every file the app fetches at runtime
- ⚠️ Browser smoke test (load page, click Load ffmpeg, drag a video, run an op) — **not yet run**. Recommend doing this before merging: open `docs/index.html` via `node server.js 5500` and exercise at least convert, crop, gif, autocaption, and the stack path.
