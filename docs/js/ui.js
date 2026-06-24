// js/ui.js
//
// Cross-cutting UI helpers: log panel, process-button state sync, info
// panel, output-size estimator, shared output renderer, and screen
// wake-lock. None of these know about a specific operation; they're the
// glue every op module calls into.

import { state } from './state.js';
import { fmtTime, fmtBytes, mime, blobToDataURL } from './helpers.js';

// ── Log panel ──────────────────────────────────────────────────────────
export function addLog(msg, type = '', icon = '') {
  const log  = document.getElementById('log');
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  if (icon) {
    const i = document.createElement('i');
    i.className = icon;
    line.appendChild(i);
    line.appendChild(document.createTextNode(' ' + msg));
  } else {
    line.textContent = msg;
  }
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

export function clearLog() {
  document.getElementById('log').innerHTML = '';
}

// ── Process-button sync ────────────────────────────────────────────────
// Reflects the current input/engine/stack state onto the Process button
// label and disabled state. Called from many places after state changes.
export function syncProcessBtn() {
  const btn = document.getElementById('processBtn');
  const hasInput = state.input.file || (state.batch.mode && state.batch.queue.length > 0);

  // Inline the isLoaded() check to avoid a circular import with engine.js.
  const loaded = state.engine.useServerMode
    ? state.engine.serverModeReady
    : document.getElementById('statusDot').classList.contains('loaded');

  if (!hasInput) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-gear"></i> Process Video';
  } else if (!loaded) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> Load ffmpeg &amp; Process';
  } else {
    btn.disabled = false;
    const label = state.batch.mode ? 'Process Queue' : 'Process Video';
    btn.innerHTML = `<i class="fas fa-gear"></i> ${label}`;
  }
  refreshStackControls();
  if (state.stack.mode) renderStack();
}

// `refreshStackControls` and `renderStack` live in stack.js but
// syncProcessBtn calls them. Defer via window to avoid a circular import.
function refreshStackControls() {
  const fn = window.refreshStackControls;
  if (typeof fn === 'function') fn();
}
function renderStack() {
  const fn = window.renderStack;
  if (typeof fn === 'function') fn();
}

// ── Media Info panel ───────────────────────────────────────────────────
export function updateInfoPanel() {
  const el = document.getElementById('infoBasic');
  if (!el) return;
  if (!state.input.file) {
    el.innerHTML = '<span style="color:var(--muted)">Load a video file to see its properties.</span>';
    return;
  }
  const vid = document.getElementById('inputVideo');
  const br  = state.input.file.size > 0 && state.input.vidDur > 0
    ? Math.round(state.input.file.size * 8 / state.input.vidDur / 1000) + ' kb/s' : '—';
  el.innerHTML =
    `<strong>File:</strong> ${state.input.file.name}<br>` +
    `<strong>Size:</strong> ${fmtBytes(state.input.file.size)}<br>` +
    `<strong>Duration:</strong> ${fmtTime(state.input.vidDur)}<br>` +
    `<strong>Resolution:</strong> ${vid.videoWidth || '—'}&thinsp;×&thinsp;${vid.videoHeight || '—'}<br>` +
    `<strong>Est. bitrate:</strong> ${br}<br>` +
    `<strong>Type:</strong> ${state.input.file.type || ('.' + state.input.ext)}`;
}

// ── Output-size estimator ──────────────────────────────────────────────
// All figures are heuristic estimates, not guarantees. Hidden for ops
// that can't be estimated (subtitles, autocaption, raw, info, etc.).
export function updateSizeEstimate() {
  const wrap = document.getElementById('sizeEstWrap');
  if (state.stack.mode) { wrap.classList.add('hidden'); return; }
  if (!state.input.file || !state.input.vidDur || state.input.vidDur <= 0) { wrap.classList.add('hidden'); return; }

  const srcSize    = state.input.file.size;
  const srcBitrate = (srcSize * 8) / state.input.vidDur;        // bps
  const vid        = document.getElementById('inputVideo');
  const srcW       = vid.videoWidth  || 1920;
  const srcH       = vid.videoHeight || 1080;
  // Separate audio portion (~12% of total bitrate, capped at 192 kbps)
  const audioBps   = Math.min(192000, srcBitrate * 0.12);
  const videoBps   = Math.max(0, srcBitrate - audioBps);

  const trimS = parseFloat(document.getElementById('trimStart').value) || 0;
  const trimE = parseFloat(document.getElementById('trimEnd').value)   || state.input.vidDur;
  const dur   = Math.max(0.1, trimE - trimS);

  let estimated = 0;
  switch (state.op.current) {
    case 'convert': {
      const fmt    = document.getElementById('singleOutFmt').value;
      // VP9 typically achieves ~55% of H.264 file size at similar quality
      const factor = fmt === 'webm' ? 0.55 : fmt === 'avi' ? 1.1 : 1.0;
      estimated = srcSize * (dur / state.input.vidDur) * factor;
      break;
    }
    case 'resizecompress': {
      const wVal = Math.max(1, parseInt(document.getElementById('rcW').value)  || srcW);
      const hVal = Math.max(1, parseInt(document.getElementById('rcH').value)  || srcH);
      const crf  = parseInt(document.getElementById('rcCrf').value) || 28;
      const areaRatio = (wVal * hVal) / (srcW * srcH);
      // CRF 23 is H.264 baseline; each 6 steps doubles/halves bitrate
      const crfFactor = Math.pow(2, (23 - crf) / 6);
      estimated = (videoBps * areaRatio * crfFactor / 8 + 16000) * dur;
      break;
    }
    case 'audio': {
      const rates = { mp3: 16000, aac: 16000, wav: 176400, ogg: 16000, flac: 88200 };
      estimated = (rates[document.getElementById('audioFmt').value] || 16000) * dur;
      break;
    }
    case 'mute': {
      estimated = videoBps / 8 * dur;
      break;
    }
    case 'gif': {
      const fps = Math.max(1, parseInt(document.getElementById('gifFps').value) || 10);
      const w   = Math.max(1, parseInt(document.getElementById('gifW').value)   || 480);
      const h   = Math.max(1, Math.round(w * srcH / srcW));
      // GIF LZW compression on video frames: rough 0.35 bytes/pixel/frame
      estimated = w * h * fps * dur * 0.35;
      break;
    }
    case 'speed': {
      const sp = parseFloat(document.getElementById('speedVal').value) || 2;
      estimated = srcBitrate / 8 * dur / sp;
      break;
    }
    case 'rotate':   { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'reverse':  { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'fade':     { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'adjust':   { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'stripmeta':  { estimated = srcSize * 0.99; break; }
    case 'subtitles':  { wrap.classList.add('hidden'); return; }
    case 'autocaption': { wrap.classList.add('hidden'); return; }
    case 'volume':   { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'overlay':  { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'mixaudio': { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'loop':     { const n = Math.max(1, parseInt(document.getElementById('loopCount').value) || 3); estimated = srcSize * n; break; }
    case 'concat':   { wrap.classList.add('hidden'); return; }
    case 'sxs':      { wrap.classList.add('hidden'); return; }
    case 'pip':      { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'info':     { wrap.classList.add('hidden'); return; }
    case 'thumbnail':{ wrap.classList.add('hidden'); return; }
    case 'raw':       { wrap.classList.add('hidden'); return; }
    case 'pad':        { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'normalize':  { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'denoise':    { estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'boomerang':  { estimated = srcSize * (dur / state.input.vidDur) * 2; break; }
    case 'sharpenblur':{ estimated = srcSize * (dur / state.input.vidDur); break; }
    case 'crop': {
      const cx = parseInt(document.getElementById('cropX').value) || 0;
      const cy = parseInt(document.getElementById('cropY').value) || 0;
      const cw = parseInt(document.getElementById('cropW').value) || (srcW - cx);
      const ch = parseInt(document.getElementById('cropH').value) || (srcH - cy);
      estimated = srcSize * (dur / state.input.vidDur) * (cw * ch) / (srcW * srcH);
      break;
    }
  }

  if (estimated <= 0) { wrap.classList.add('hidden'); return; }

  document.getElementById('sizeEstVal').textContent = fmtBytes(Math.round(estimated));
  const ratio   = estimated / srcSize;
  const deltaEl = document.getElementById('sizeDelta');
  if (ratio < 0.95) {
    deltaEl.innerHTML  = `<i class="fas fa-arrow-down"></i> ${Math.round((1 - ratio) * 100)}% smaller`;
    deltaEl.className   = 'size-delta smaller';
  } else if (ratio > 1.05) {
    deltaEl.innerHTML  = `<i class="fas fa-arrow-up"></i> ${Math.round((ratio - 1) * 100)}% larger`;
    deltaEl.className   = 'size-delta larger';
  } else {
    deltaEl.innerHTML  = `<i class="fas fa-equals"></i> same size`;
    deltaEl.className   = 'size-delta';
  }
  wrap.classList.remove('hidden');
}

// ── Shared output renderer ─────────────────────────────────────────────
// Used by both the single-op runProcess() and the stack runProcessStack()
// so result-display logic lives in exactly one place.
export async function renderOutput(data, ext) {
  state.op.outExt  = ext;
  state.op.outBlob = new Blob([data.buffer], { type: mime(ext) });
  // Use a data: URL — no blob: URL means no range-request failures.
  const url = await blobToDataURL(state.op.outBlob);

  const audioExts = ['mp3','aac','wav','ogg','flac'];
  const imageExts = ['jpg','png'];
  const ov  = document.getElementById('outVideo');
  const oa  = document.getElementById('outAudio');
  const oaw = document.getElementById('outAudioWrap');
  const oim = document.getElementById('outImg');

  document.getElementById('outEmpty').classList.add('hidden');
  document.getElementById('outContent').classList.remove('hidden');

  if (audioExts.includes(ext)) {
    ov.classList.add('hidden'); oaw.classList.remove('hidden'); oim.classList.add('hidden');
    oa.src = url;
  } else if (imageExts.includes(ext)) {
    ov.classList.add('hidden'); oaw.classList.add('hidden'); oim.classList.remove('hidden');
    oim.src = url;
  } else {
    ov.classList.remove('hidden'); oaw.classList.add('hidden'); oim.classList.add('hidden');
    ov.src = url;
  }

  const metaText = `${fmtBytes(data.buffer.byteLength)} · ${ext.toUpperCase()}`;
  document.getElementById('outMeta').textContent = metaText;
  document.getElementById('quickOutMeta').textContent = metaText;
  document.getElementById('dlBtn').innerHTML = `<i class="fas fa-download"></i> Download output.${ext}`;
  document.getElementById('dlBtn').onclick = download;
  document.getElementById('quickDlBtn').innerHTML = `<i class="fas fa-download"></i> Download output.${ext}`;
  // Hide batch outputs section in single mode output
  const bw = document.getElementById('batchOutputsWrap');
  if (bw) bw.classList.add('hidden');

  // Show quick download in options panel (only in single mode, not batch)
  if (!state.batch.mode) {
    document.getElementById('quickDownloadWrap').classList.remove('hidden');
  }
}

// `download` lives in process.js but renderOutput wires the onclick.
// Defer via window to avoid a circular import.
function download() {
  const fn = window.download;
  if (typeof fn === 'function') fn();
}

// ── Screen Wake Lock ───────────────────────────────────────────────────
// Prevent screen from sleeping during processing.
export async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      addLog('Screen will stay on during processing', 'ok', 'fas fa-mobile-screen-button');
    }
  } catch (err) {
    // Silently ignore — wake lock is best-effort.
  }
}

export function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().then(() => {
      state.wakeLock = null;
    });
  }
}

// Release wake lock if page loses visibility.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.wakeLock) {
    releaseWakeLock();
  }
});
