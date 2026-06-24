// js/files.js
//
// Source-file loading (drag&drop + file picker), per-op auxiliary input
// pickers (subtitles, overlay, mixAudio, concat, sxs, pip, raw input2),
// and the "clear input" action. Updates `state.input` and `state.auxFiles`
// and triggers the UI refresh cascade.

import { state } from './state.js';
import { blobToDataURL, fmtBytes } from './helpers.js';

import { addLog, syncProcessBtn, updateInfoPanel, updateSizeEstimate } from './ui.js';
import { updateTrim } from './trim.js';
import { resetCropSelection, setCropFromPixels } from './crop.js';
import { updateRawPreview } from './raw.js';

// ── Drag & drop wiring (runs once on module load) ──────────────────────
const dz = document.getElementById('dropZone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// ── File picker entry point (also called from inline onchange) ─────────
export function handleFileInput(input) {
  if (!input.files) return;
  if (state.batch.mode) {
    handleBatchFiles(input.files);
  } else {
    handleFile(input.files[0]);
  }
  input.value = '';  // Reset so same file can be added again
}

// `handleBatchFiles` lives in batch.js; defer via window to avoid a
// circular import.
function handleBatchFiles(files) {
  const fn = window.handleBatchFiles;
  if (typeof fn === 'function') fn(files);
}

// ── Single-file load ───────────────────────────────────────────────────
export async function handleFile(file) {
  if (!file) return;
  state.input.file = file;
  state.input.ext  = file.name.split('.').pop().toLowerCase() || 'mp4';

  // Hide quick download when loading a new file (old output is no longer relevant)
  document.getElementById('quickDownloadWrap').classList.add('hidden');

  const vid = document.getElementById('inputVideo');
  // Use a data: URL instead of blob: URL — avoids ERR_REQUEST_RANGE_NOT_SATISFIABLE.
  // Skip inline preview for files > 200 MB to avoid excessive memory use.
  if (file.size <= 200 * 1024 * 1024) {
    vid.src = await blobToDataURL(file);
  } else {
    vid.src = '';
    addLog(`Preview skipped for large file (${fmtBytes(file.size)}); processing will still work.`, 'ok');
  }
  vid.onloadedmetadata = () => {
    state.input.vidDur = vid.duration;
    const s = document.getElementById('trimStart');
    const e = document.getElementById('trimEnd');
    const step = Math.max(0.1, state.input.vidDur / 2000);
    [s, e].forEach(r => { r.max = state.input.vidDur; r.step = step; });
    e.value = state.input.vidDur;
    document.getElementById('vidDur').textContent = require_fmtTime(state.input.vidDur);
    document.getElementById('endVal').textContent  = require_fmtTime(state.input.vidDur);
    updateTrim();
    // Auto-fill resize & compress dimensions from source video
    if (vid.videoWidth)  document.getElementById('rcW').value = vid.videoWidth;
    if (vid.videoHeight) document.getElementById('rcH').value = vid.videoHeight;
    resetCropSelection();
    // Auto-fill thumbnail timestamp to midpoint
    document.getElementById('thumbTime').value = (state.input.vidDur / 2).toFixed(1);
    updateSizeEstimate();
    updateRawPreview();
  };
  document.getElementById('inputWrap').classList.remove('hidden');
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('inputMeta').textContent = `${file.name}  ·  ${fmtBytes(file.size)}`;
  syncProcessBtn();
  updateInfoPanel();
  addLog(`File loaded: ${file.name} (${fmtBytes(file.size)})`, 'ok');
}

// Local import of fmtTime without circular dep noise (helpers is leaf).
import { fmtTime as require_fmtTime } from './helpers.js';

export function clearInput() {
  if (state.batch.mode) return;  // Don't clear in batch mode
  state.input.file = null;
  document.getElementById('inputVideo').src = '';
  document.getElementById('inputWrap').classList.add('hidden');
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('quickDownloadWrap').classList.add('hidden');
  document.getElementById('outEmpty').classList.remove('hidden');
  document.getElementById('outContent').classList.add('hidden');
  setCropFromPixels({ x: 0, y: 0, w: 0, h: 0 });
  syncProcessBtn();
  updateSizeEstimate();
}

// ── Per-op auxiliary file pickers ──────────────────────────────────────
export function onSubtitleFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.subtitle = input.files[0];
  state.auxFiles.subtitleExt = state.auxFiles.subtitle.name.split('.').pop().toLowerCase();
  document.getElementById('subtitleFileName').textContent = state.auxFiles.subtitle.name;
}

export function onOverlayFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.overlay = input.files[0];
  state.auxFiles.overlayExt = state.auxFiles.overlay.name.split('.').pop().toLowerCase();
  document.getElementById('overlayFileName').textContent = state.auxFiles.overlay.name;
}

export function onMixAudioFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.mixAudio = input.files[0];
  state.auxFiles.mixAudioExt = state.auxFiles.mixAudio.name.split('.').pop().toLowerCase();
  document.getElementById('mixAudioFileName').textContent = state.auxFiles.mixAudio.name;
}

export function onConcatFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.concat = input.files[0];
  state.auxFiles.concatExt = state.auxFiles.concat.name.split('.').pop().toLowerCase();
  document.getElementById('concatFileName').textContent = state.auxFiles.concat.name;
}

export function onSxsFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.sxs = input.files[0];
  state.auxFiles.sxsExt = state.auxFiles.sxs.name.split('.').pop().toLowerCase();
  document.getElementById('sxsFileName').textContent = state.auxFiles.sxs.name;
}

export function onPipFileChange(input) {
  if (!input.files.length) return;
  state.auxFiles.pip = input.files[0];
  state.auxFiles.pipExt = state.auxFiles.pip.name.split('.').pop().toLowerCase();
  document.getElementById('pipFileName').textContent = state.auxFiles.pip.name;
}

export function onRawInput2Change(input) {
  if (!input.files.length) return;
  state.auxFiles.rawInput2 = input.files[0];
  state.auxFiles.rawInput2Ext = state.auxFiles.rawInput2.name.split('.').pop().toLowerCase();
  const fsName  = 'input2.' + state.auxFiles.rawInput2Ext;
  document.getElementById('rawInput2Name').textContent = '\u2192 stored as ' + fsName;
  // Auto-update any existing input2.<ext> reference in the args textarea
  const ta = document.getElementById('rawArgs');
  ta.value = ta.value.replace(/\binput2\.\w+/g, fsName);
  updateRawPreview();
}
