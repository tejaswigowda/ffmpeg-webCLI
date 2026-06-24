// js/stack.js
//
// Operation stack (chaining) mode: lets the user queue multiple
// single-input, frame-wise operations (crop, resize, rotate, adjust,
// fade, denoise, sharpen/blur, speed, pad, volume) and run them as ONE
// ffmpeg filter chain with a single re-encode. Trim is applied as input
// seeking (-ss / -t) and never enters the filter chain.
//
// Each chainable op contributes one or more filter *fragments*: video
// fragments go into a single `-vf "a,b,c"` chain and audio fragments into
// a single `-af "x,y"` chain, both in stack order. The whole chain is
// encoded ONCE at the end (container/codec chosen by the stack's
// output-format selector).
//
// Only single-input, frame-wise video/audio filters are chainable.
// Multi-input (overlay/concat/sxs/pip/mixaudio/subtitles),
// stream/container flags (convert/mute/audio/stripmeta/loop/normalize/
// info/raw) and whole-clip / different-output-type ops (gif/thumbnail/
// reverse/boomerang) are excluded — see `CHAINABLE` in state.js.
//
// Ordering note: `speed` (setpts/atempo) and `fade` both touch the
// timeline. The chain respects the user's literal order; a fade added
// before a later speed change is NOT rescaled by that speed change. This
// is intentional for v1.

import { state, CHAINABLE, STACK_ICON } from './state.js';
import { addLog, requestWakeLock, releaseWakeLock, renderOutput } from './ui.js';
import { getFF, fetchFile, isLoaded, loadFFmpeg } from './engine.js';
import { blobToDataURL, mime, buildAtempo } from './helpers.js';
import { updateSizeEstimate } from './ui.js';
import { updateBatchTileStates } from './batch.js';

// ── Per-op filter fragments ────────────────────────────────────────────
// Returns { vf?: string[], af?: string[] } for a given stack item.
function opToFilters(item, ctx) {
  const p = item.params;
  const ROT     = { cw90:'transpose=1', ccw90:'transpose=2', '180':'hflip,vflip', hflip:'hflip', vflip:'vflip', hvflip:'hflip,vflip' };
  const DENOISE = { light:'2:2:3:3', medium:'4:4:6:6', heavy:'10:10:15:15' };
  const SB      = { sharpen:{ light:'unsharp=3:3:0.8:3:3:0', medium:'unsharp=5:5:1.5:5:5:0', heavy:'unsharp=7:7:3:7:7:0' },
                    blur:   { light:'boxblur=3:1', medium:'boxblur=6:1', heavy:'boxblur=12:1' } };
  switch (item.op) {
    case 'crop': {
      // Validate and clamp crop values to video dimensions
      const srcW = ctx.srcW || 1920, srcH = ctx.srcH || 1080;
      let x = p.x || 0, y = p.y || 0, w = p.w || (srcW - x), h = p.h || (srcH - y);
      const maxX = Math.max(0, srcW - 1);
      const maxY = Math.max(0, srcH - 1);
      x = Math.max(0, Math.min(x, maxX));
      y = Math.max(0, Math.min(y, maxY));
      w = Math.max(1, Math.min(w, srcW - x));
      h = Math.max(1, Math.min(h, srcH - y));
      return { vf: [`crop=${w}:${h}:${x}:${y}`] };
    }
    case 'resizecompress': return { vf: [`scale=${p.w}:${p.h}`] };
    case 'rotate':         return { vf: [ROT[p.mode]] };
    case 'adjust':         return { vf: [`eq=brightness=${p.br}:contrast=${p.con}:saturation=${p.sat}`] };
    case 'denoise':        return { vf: [`hqdn3d=${DENOISE[p.str]}`] };
    case 'sharpenblur':    return { vf: [SB[p.mode][p.str]] };
    case 'pad':            return { vf: [`pad=${p.tW}:${p.tH}:(ow-iw)/2:(oh-ih)/2:${p.color}`] };
    case 'volume':         return { af: [`volume=${p.vol}`] };
    case 'speed':          return { vf: [`setpts=${(1/p.sp).toFixed(6)}*PTS`], af: [buildAtempo(p.sp)] };
    case 'fade': {
      const vf = [], af = [];
      if (p.fi > 0) { vf.push(`fade=t=in:st=0:d=${p.fi}`); af.push(`afade=t=in:st=0:d=${p.fi}`); }
      if (p.fo > 0) {
        const st = Math.max(0, ctx.clipDur - p.fo).toFixed(3);
        vf.push(`fade=t=out:st=${st}:d=${p.fo}`); af.push(`afade=t=out:st=${st}:d=${p.fo}`);
      }
      return { vf, af };
    }
    default: return {};
  }
}

// Snapshot the currently-selected op's own controls into a plain params
// object. Called at "Add to Stack" time.
function captureStackParams(op) {
  const roundEven = v => { const n = parseInt(v); if (isNaN(n) || n < 0) return '-2'; return String(Math.round(n / 2) * 2 || 2); };
  const vid = document.getElementById('inputVideo');
  const srcW = vid.videoWidth || 1920, srcH = vid.videoHeight || 1080;
  switch (op) {
    case 'crop': {
      const x = parseInt(document.getElementById('cropX').value) || 0;
      const y = parseInt(document.getElementById('cropY').value) || 0;
      const w = parseInt(document.getElementById('cropW').value) || (srcW - x);
      const h = parseInt(document.getElementById('cropH').value) || (srcH - y);
      return { x, y, w, h };
    }
    case 'resizecompress': {
      const wRaw = document.getElementById('rcW').value.trim();
      const hRaw = document.getElementById('rcH').value.trim();
      return { w: wRaw ? roundEven(wRaw) : '-2', h: hRaw ? roundEven(hRaw) : '-2' };
    }
    case 'rotate':      return { mode: document.getElementById('rotateVal').value };
    case 'adjust':      return {
      br:  document.getElementById('adjBright').value,
      con: document.getElementById('adjContrast').value,
      sat: document.getElementById('adjGray').checked ? '0' : document.getElementById('adjSat').value,
      gray: document.getElementById('adjGray').checked
    };
    case 'fade':        return {
      fi: parseFloat(document.getElementById('fadeIn').value)  || 0,
      fo: parseFloat(document.getElementById('fadeOut').value) || 0
    };
    case 'denoise':     return { str: document.getElementById('denoiseStrength').value };
    case 'sharpenblur': return { mode: document.getElementById('sbMode').value, str: document.getElementById('sbStrength').value };
    case 'speed':       return { sp: parseFloat(document.getElementById('speedVal').value) || 2 };
    case 'volume':      return { vol: parseFloat(document.getElementById('volRange').value).toFixed(3) };
    case 'pad': {
      const [aw, ah]  = document.getElementById('padAR').value.split(':').map(Number);
      const color     = document.getElementById('padColor').value;
      const targetAR  = aw / ah;
      let tW, tH;
      if (srcW / srcH > targetAR) { tW = srcW; tH = Math.round(srcW / targetAR / 2) * 2; }
      else                        { tH = srcH; tW = Math.round(srcH * targetAR / 2) * 2; }
      return { tW, tH, color };
    }
    default: return null;
  }
}

function stackItemLabel(op, p) {
  switch (op) {
    case 'crop':           return `Crop ${p.w}×${p.h}`;
    case 'resizecompress': return `Scale ${p.w}×${p.h}`;
    case 'rotate':         return 'Rotate / Flip — ' + ({ cw90:'90° CW', ccw90:'90° CCW', '180':'180°', hflip:'H-flip', vflip:'V-flip', hvflip:'HV-flip' }[p.mode] || p.mode);
    case 'adjust':         return p.gray ? 'Grayscale' : `Adjust (br ${p.br} · con ${p.con} · sat ${p.sat})`;
    case 'fade':           return `Fade in ${p.fi}s / out ${p.fo}s`;
    case 'denoise':        return `Denoise ${p.str}`;
    case 'sharpenblur':    return `${p.mode === 'sharpen' ? 'Sharpen' : 'Blur'} ${p.str}`;
    case 'speed':          return `Speed ${p.sp}×`;
    case 'pad':            return `Pad ${p.tW}×${p.tH}`;
    case 'volume':         return `Volume ${Math.round(parseFloat(p.vol) * 100)}%`;
  }
  return op;
}

// Get codec args for a given output format.
function getFormatCodecArgs(fmt) {
  if (fmt === 'webm') {
    return ['-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus'];
  } else if (fmt === 'gif') {
    return [];
  } else if (fmt === 'avi') {
    return ['-c:v','mpeg4','-q:v','5','-c:a','libmp3lame'];
  } else {
    return ['-c:v','libx264','-preset','fast','-c:a','aac'];
  }
}

// Build the full args array (for exec) AND a readable preview string from
// the current stack + trim + output format. Single source of truth for both.
function composeStackCommand() {
  const inN     = 'input.' + (state.input.ext || 'mp4');
  const outFmt  = document.getElementById('stackOutFmt').value;
  const trimS   = parseFloat(document.getElementById('trimStart').value) || 0;
  const trimE   = parseFloat(document.getElementById('trimEnd').value)   || state.input.vidDur;
  const hasTrim = trimS > 0 || (state.input.vidDur > 0 && trimE < state.input.vidDur - 0.05);
  const clipDur = (hasTrim ? (trimE - trimS) : state.input.vidDur) || 0;

  // Get source video dimensions for crop validation
  const vid = document.getElementById('inputVideo');
  const srcW = vid.videoWidth || 1920;
  const srcH = vid.videoHeight || 1080;

  const ctx     = { clipDur, srcW, srcH };

  const vf = [], af = [];
  for (const item of state.stack.items) {
    const f = opToFilters(item, ctx);
    if (f.vf) vf.push(...f.vf);
    if (f.af) af.push(...f.af);
  }

  const encode = getFormatCodecArgs(outFmt);

  // args: raw values for ffmpeg.exec (no shell quoting).
  const args = [];
  if (hasTrim) args.push('-ss', trimS.toFixed(3));
  args.push('-i', inN);
  if (hasTrim) args.push('-t', (trimE - trimS).toFixed(3));
  if (vf.length) args.push('-vf', vf.join(','));
  if (af.length) args.push('-af', af.join(','));
  args.push(...encode);
  args.push('output.' + outFmt);

  // preview: same command, but filter chains wrapped in quotes for readability.
  const pre = ['ffmpeg'];
  if (hasTrim) pre.push('-ss', trimS.toFixed(3));
  pre.push('-i', inN);
  if (hasTrim) pre.push('-t', (trimE - trimS).toFixed(3));
  if (vf.length) pre.push('-vf', `"${vf.join(',')}"`);
  if (af.length) pre.push('-af', `"${af.join(',')}"`);
  pre.push(...encode);
  pre.push('output.' + outFmt);

  return { args, outFmt, preview: pre.join(' '), empty: state.stack.items.length === 0 };
}

// Build the ffmpeg args for the current stack against an arbitrary file.
// Trim is ignored in batch mode (each file runs start-to-end), matching
// the single-op batch path.
function composeStackArgsFor(inName, outName, srcW, srcH, clipDur) {
  const ctx = { clipDur: clipDur || 0, srcW: srcW || 1920, srcH: srcH || 1080 };
  const vf = [], af = [];
  for (const item of state.stack.items) {
    const f = opToFilters(item, ctx);
    if (f.vf) vf.push(...f.vf);
    if (f.af) af.push(...f.af);
  }
  const outFmt = document.getElementById('stackOutFmt').value;
  const args = ['-i', inName];
  if (vf.length) args.push('-vf', vf.join(','));
  if (af.length) args.push('-af', af.join(','));
  args.push(...getFormatCodecArgs(outFmt));
  args.push(outName);
  return { args, outFmt };
}

// ── Stack UI ───────────────────────────────────────────────────────────
export function updateStackPreview() {
  const el = document.getElementById('stackPreview');
  if (!el) return;
  if (state.stack.items.length === 0) { el.textContent = '(stack is empty — add operations above)'; return; }
  if (!state.input.file)              { el.textContent = '(load a file first)'; return; }
  el.textContent = composeStackCommand().preview;
}

export function renderStack() {
  const list = document.getElementById('stackList');
  if (!list) return;
  if (state.stack.items.length === 0) {
    list.innerHTML = '<div class="stack-empty">No operations yet — configure an op above and click &ldquo;Add to Stack&rdquo;.</div>';
  } else {
    list.innerHTML = state.stack.items.map((it, i) => `
      <div class="stack-item">
        <span class="stack-idx">${i + 1}</span>
        <span class="stack-label"><i class="fas ${STACK_ICON[it.op] || 'fa-gear'}"></i> ${stackItemLabel(it.op, it.params)}</span>
        <span class="stack-controls">
          <button class="stack-mini" title="Move up" onclick="moveStackItem(${i},-1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
          <button class="stack-mini" title="Move down" onclick="moveStackItem(${i},1)" ${i === state.stack.items.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
          <button class="stack-mini danger" title="Remove" onclick="removeStackItem(${i})"><i class="fas fa-xmark"></i></button>
        </span>
      </div>`).join('');
  }
  const pbtn = document.getElementById('processStackBtn');
  pbtn.disabled  = state.stack.items.length === 0 || (!state.input.file && !(state.batch.mode && state.batch.queue.length > 0));
  pbtn.innerHTML = `<i class="fas fa-layer-group"></i> Process Stack${state.stack.items.length ? ` (${state.stack.items.length})` : ''}`;
  updateStackPreview();
}

export function addToStack() {
  const hasInput = !!state.input.file || (state.batch.mode && state.batch.queue.length > 0);
  if (!CHAINABLE.has(state.op.current) || !hasInput) return;
  const params = captureStackParams(state.op.current);
  if (!params) return;
  state.stack.items.push({ id: ++state.stack.seq, op: state.op.current, params });
  renderStack();
}

export function removeStackItem(i) {
  state.stack.items.splice(i, 1);
  renderStack();
}

export function moveStackItem(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.stack.items.length) return;
  [state.stack.items[i], state.stack.items[j]] = [state.stack.items[j], state.stack.items[i]];
  renderStack();
}

// Enable/disable "Add to Stack" and show the exclusion note for the
// current op.
export function refreshStackControls() {
  if (!state.stack.mode) return;
  const addBtn = document.getElementById('addStackBtn');
  const note   = document.getElementById('addStackNote');
  if (!addBtn || !note) return;
  const ok = CHAINABLE.has(state.op.current);
  const hasInput = !!state.input.file || (state.batch.mode && state.batch.queue.length > 0);
  addBtn.disabled = !ok || !hasInput;
  if (ok) {
    note.classList.add('hidden');
    note.innerHTML = '';
  } else {
    const name = (document.getElementById('op-' + state.op.current)?.textContent || state.op.current).trim();
    note.classList.remove('hidden');
    note.innerHTML = `<i class="fas fa-circle-info"></i> &ldquo;${name}&rdquo; is multi-input or whole-file and can&rsquo;t be chained. Use Single mode for it.`;
  }
}

export function setMode(mode) {
  state.stack.mode = (mode === 'stack');
  document.getElementById('modeSingle').classList.toggle('active', !state.stack.mode);
  document.getElementById('modeStack').classList.toggle('active', state.stack.mode);
  document.getElementById('singleOutFmtWrap').classList.toggle('hidden', state.stack.mode);
  document.getElementById('processBtn').classList.toggle('hidden', state.stack.mode);
  document.getElementById('addStackBtn').classList.toggle('hidden', !state.stack.mode);
  document.getElementById('processStackBtn').classList.toggle('hidden', !state.stack.mode);
  document.getElementById('stackSection').classList.toggle('hidden', !state.stack.mode);

  // When entering stack mode with batch files, load the first batch file for stacking
  if (state.stack.mode && state.batch.mode && state.batch.queue.length > 0 && !state.input.file) {
    loadFirstBatchFileForStack();
  }

  document.querySelectorAll('.op-tile').forEach(tile => {
    const opId = tile.id.replace('op-', '');
    tile.classList.toggle('disabled', state.stack.mode && !CHAINABLE.has(opId));
  });

  updateSizeEstimate();
  refreshStackControls();
  renderStack();
  updateBatchTileStates();
}

// `loadFirstBatchFileForStack` lives in batch.js; defer via window.
function loadFirstBatchFileForStack() {
  const fn = window.loadFirstBatchFileForStack;
  if (typeof fn === 'function') fn();
}

// ── Process stack (single file) ────────────────────────────────────────
export async function runProcessStack() {
  if (state.stack.items.length === 0) return;

  // Batch + stack: apply the whole stack to every queued file and show
  // results in the batch outputs div.
  if (state.batch.mode && state.batch.queue.length > 0) {
    await runBatchStack();
    return;
  }

  if (!state.input.file) return;

  if (!isLoaded()) {
    await loadFFmpeg();
    if (!isLoaded()) return;
  }

  // Show progress bar for stack processing
  const progWrap = document.getElementById('progWrap');
  document.getElementById('progLabel').textContent = 'Processing Stack…';

  const btn  = document.getElementById('processStackBtn');
  const orig = btn.innerHTML;
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…';

  const pw = document.getElementById('progWrap');
  pw.classList.remove('hidden');
  document.getElementById('progFill').style.width = '0%';
  document.getElementById('progPct').textContent  = '0%';

  const inName = 'input.' + state.input.ext;
  let outName  = '';
  try {
    await requestWakeLock();
    addLog('Writing input file…', 'ok');
    await getFF().writeFile(inName, await fetchFile(state.input.file));

    const { args, outFmt } = composeStackCommand();
    outName = 'output.' + outFmt;

    addLog('ffmpeg ' + args.join(' '), 'ok');
    const exitCode = await getFF().exec(args);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — check the composed command.`);
    addLog('Done!', 'ok');

    const data = await getFF().readFile(outName);
    await renderOutput(data, outFmt);

    await getFF().deleteFile(inName).catch(() => {});
    await getFF().deleteFile(outName).catch(() => {});
  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err)) || 'unknown error';
    addLog('Error: ' + errMsg, 'err');
    try { await getFF().deleteFile(inName); } catch (_) {}
    try { if (outName) await getFF().deleteFile(outName); } catch (_) {}
  } finally {
    setTimeout(() => {
      pw.classList.add('hidden');
      document.getElementById('progFill').style.width = '0%';
      document.getElementById('progPct').textContent  = '0%';
      document.getElementById('progLabel').textContent = 'Processing…';
    }, 1000);
    btn.disabled  = false;
    btn.innerHTML = orig;
    releaseWakeLock();
  }
}

// ── Process stack across every batched file ────────────────────────────
async function runBatchStack() {
  if (!isLoaded()) {
    await loadFFmpeg();
    if (!isLoaded()) return;
  }

  const btn  = document.getElementById('processStackBtn');
  const orig = btn.innerHTML;
  const opTiles = document.querySelectorAll('.op-tile');
  const progWrap = document.getElementById('progWrap');

  progWrap.classList.remove('hidden');
  document.getElementById('progLabel').textContent = 'Batch Stack…';
  document.getElementById('progFill').style.width = '0%';
  document.getElementById('progPct').textContent  = '0%';

  opTiles.forEach(t => { t.style.pointerEvents = 'none'; t.style.opacity = '0.5'; });
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…';

  addLog(`Starting batch stack (${state.stack.items.length} op${state.stack.items.length === 1 ? '' : 's'}) on ${state.batch.queue.length} file(s)…`, 'ok');

  try {
    await requestWakeLock();

    for (let i = 0; i < state.batch.queue.length; i++) {
      const item = state.batch.queue[i];
      state.batch.current = i;

      document.getElementById('progFill').style.width = (i / state.batch.queue.length * 100) + '%';
      document.getElementById('progPct').textContent  = Math.round(i / state.batch.queue.length * 100) + '%';

      item.status = 'processing';
      updateBatchQueueUI();
      addLog(`[${i + 1}/${state.batch.queue.length}] Processing: ${item.file.name}`, 'ok');

      try {
        await processBatchStackFile(item);
        item.status = 'done';
      } catch (err) {
        item.status = 'error';
        item.error  = err.message || String(err);
        addLog(`Error processing ${item.file.name}: ${item.error}`, 'error');
      }
      updateBatchQueueUI();
    }

    document.getElementById('progFill').style.width = '100%';
    document.getElementById('progPct').textContent  = '100%';

    const done   = state.batch.queue.filter(i => i.status === 'done').length;
    const failed = state.batch.queue.filter(i => i.status === 'error').length;
    addLog(`Batch stack complete: ${done} succeeded, ${failed} failed.`, failed === 0 ? 'ok' : 'warn');
  } finally {
    setTimeout(() => {
      progWrap.classList.add('hidden');
      document.getElementById('progFill').style.width = '0%';
      document.getElementById('progPct').textContent  = '0%';
      document.getElementById('progLabel').textContent = 'Processing…';
    }, 1000);

    updateBatchOutputsDisplay();
    opTiles.forEach(t => { t.style.pointerEvents = 'auto'; t.style.opacity = '1'; });
    btn.disabled  = false;
    btn.innerHTML = orig;
    state.batch.current  = null;
    releaseWakeLock();
  }
}

async function processBatchStackFile(item) {
  const file = item.file;
  const inputFileExt = file.name.split('.').pop().toLowerCase() || 'mp4';
  const outFmt = document.getElementById('stackOutFmt').value;
  const outExt = ['gif','mkv','mov','webm','avi'].includes(outFmt) ? outFmt : 'mp4';

  const rand    = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const inName  = 'batchinput_'  + rand + '.' + inputFileExt;
  const outName = 'batchoutput_' + rand + '.' + outExt;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  item.outputName = baseName + '_processed.' + outExt;

  addLog(`  Writing ${file.name}…`, 'log');
  await getFF().writeFile(inName, await fetchFile(file));

  // Get this file's dimensions/duration so crop/pad/fade compose correctly.
  const vid = document.createElement('video');
  vid.src = await blobToDataURL(file);
  await new Promise(resolve => { vid.onloadedmetadata = () => resolve(); });

  const { args } = composeStackArgsFor(inName, outName, vid.videoWidth, vid.videoHeight, vid.duration);

  addLog('  ffmpeg ' + args.join(' '), 'log');
  const res = await getFF().exec(args);
  if (res !== 0) throw new Error(`ffmpeg exited with code ${res}`);

  const data = await getFF().readFile(outName);
  item.output = new Blob([data.buffer], { type: mime(outExt) });

  try { await getFF().deleteFile(inName); } catch (_) {}
  try { await getFF().deleteFile(outName); } catch (_) {}

  updateBatchOutputsDisplay();
}

// `updateBatchQueueUI` and `updateBatchOutputsDisplay` live in batch.js;
// defer via window to avoid a circular import.
function updateBatchQueueUI() {
  const fn = window.updateBatchQueueUI;
  if (typeof fn === 'function') fn();
}
function updateBatchOutputsDisplay() {
  const fn = window.updateBatchOutputsDisplay;
  if (typeof fn === 'function') fn();
}
