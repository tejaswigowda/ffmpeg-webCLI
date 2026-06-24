// js/crop.js
//
// Visual crop selector: renders the current input-video frame to a canvas
// and overlays a draggable selection box. State lives in `state.crop`.
//
// The selection rectangle is constrained to the source video dimensions
// and snapped to a minimum size so handles stay grabbable. Pixel values
// are also written to hidden <input> elements (cropX/Y/W/H) so the rest
// of the app — operations.js, stack.js — can read them with the same
// `document.getElementById('cropX').value` pattern as the original.

import { state } from './state.js';
import { clamp, getVideoSize } from './helpers.js';
import { updateSizeEstimate } from './ui.js';

export function setCropFromPixels(next, shouldEstimate = true) {
  const { w: srcW, h: srcH } = getVideoSize();
  if (!srcW || !srcH) {
    state.crop.x = 0; state.crop.y = 0; state.crop.w = 0; state.crop.h = 0;
    syncCropUI();
    return;
  }

  const minW = Math.min(state.crop.MIN_PX, srcW);
  const minH = Math.min(state.crop.MIN_PX, srcH);
  let w = clamp(Math.round(next.w), minW, srcW);
  let h = clamp(Math.round(next.h), minH, srcH);
  let x = clamp(Math.round(next.x), 0, srcW - w);
  let y = clamp(Math.round(next.y), 0, srcH - h);

  if (x + w > srcW) w = srcW - x;
  if (y + h > srcH) h = srcH - y;

  state.crop.x = x; state.crop.y = y; state.crop.w = w; state.crop.h = h;
  syncCropUI();
  if (shouldEstimate) updateSizeEstimate();
}

export function syncCropUI() {
  const { w: srcW, h: srcH } = getVideoSize();
  const summary = document.getElementById('cropSummary');
  const selection = document.getElementById('cropSelection');
  const empty = document.getElementById('cropEmpty');
  const canvas = document.getElementById('cropCanvas');

  document.getElementById('cropX').value = state.crop.x || 0;
  document.getElementById('cropY').value = state.crop.y || 0;
  document.getElementById('cropW').value = state.crop.w || '';
  document.getElementById('cropH').value = state.crop.h || '';

  if (!srcW || !srcH || !state.input.file) {
    summary.textContent = 'Load a video to crop.';
    selection.classList.add('hidden');
    canvas.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  summary.textContent = `${state.crop.w} x ${state.crop.h} at X ${state.crop.x}, Y ${state.crop.y}`;
  selection.style.left = (state.crop.x / srcW * 100) + '%';
  selection.style.top = (state.crop.y / srcH * 100) + '%';
  selection.style.width = (state.crop.w / srcW * 100) + '%';
  selection.style.height = (state.crop.h / srcH * 100) + '%';
  if (!canvas.classList.contains('hidden')) selection.classList.remove('hidden');
}

export function renderCropFrame() {
  const vid = document.getElementById('inputVideo');
  const canvas = document.getElementById('cropCanvas');
  const empty = document.getElementById('cropEmpty');
  const selection = document.getElementById('cropSelection');
  const { w: srcW, h: srcH } = getVideoSize();

  if (!state.input.file || !srcW || !srcH || vid.readyState < 2) {
    syncCropUI();
    return;
  }

  const previewW = Math.min(srcW, 1200);
  const previewH = Math.max(1, Math.round(previewW * srcH / srcW));
  canvas.width = previewW;
  canvas.height = previewH;
  canvas.getContext('2d').drawImage(vid, 0, 0, previewW, previewH);
  canvas.classList.remove('hidden');
  empty.classList.add('hidden');
  selection.classList.remove('hidden');
  syncCropUI();
}

export function resetCropSelection() {
  const { w: srcW, h: srcH } = getVideoSize();
  if (!srcW || !srcH) {
    setCropFromPixels({ x: 0, y: 0, w: 0, h: 0 });
    return;
  }
  setCropFromPixels({ x: 0, y: 0, w: srcW, h: srcH });
  renderCropFrame();
}

// ── Pointer drag handlers (wired once at module load) ──────────────────
function startCropDrag(e) {
  const { w: srcW, h: srcH } = getVideoSize();
  if (!srcW || !srcH || !state.input.file) return;

  const handle = e.target.dataset && e.target.dataset.handle;
  const selection = document.getElementById('cropSelection');
  if (!handle && e.target !== selection) return;

  e.preventDefault();
  const stage = document.getElementById('cropStage');
  const rect = stage.getBoundingClientRect();
  state.crop.drag = {
    pointerId: e.pointerId,
    mode: handle || 'move',
    startX: e.clientX,
    startY: e.clientY,
    scaleX: srcW / rect.width,
    scaleY: srcH / rect.height,
    crop: { x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h }
  };
  stage.setPointerCapture(e.pointerId);
}

function moveCropDrag(e) {
  const drag = state.crop.drag;
  if (!drag || drag.pointerId !== e.pointerId) return;

  const { w: srcW, h: srcH } = getVideoSize();
  const dx = (e.clientX - drag.startX) * drag.scaleX;
  const dy = (e.clientY - drag.startY) * drag.scaleY;
  const minW = Math.min(state.crop.MIN_PX, srcW);
  const minH = Math.min(state.crop.MIN_PX, srcH);
  let left = drag.crop.x;
  let top = drag.crop.y;
  let right = drag.crop.x + drag.crop.w;
  let bottom = drag.crop.y + drag.crop.h;

  if (drag.mode === 'move') {
    setCropFromPixels({ x: drag.crop.x + dx, y: drag.crop.y + dy, w: drag.crop.w, h: drag.crop.h });
    return;
  }

  if (drag.mode.includes('w')) left = clamp(drag.crop.x + dx, 0, right - minW);
  if (drag.mode.includes('e')) right = clamp(drag.crop.x + drag.crop.w + dx, left + minW, srcW);
  if (drag.mode.includes('n')) top = clamp(drag.crop.y + dy, 0, bottom - minH);
  if (drag.mode.includes('s')) bottom = clamp(drag.crop.y + drag.crop.h + dy, top + minH, srcH);

  setCropFromPixels({ x: left, y: top, w: right - left, h: bottom - top });
}

function endCropDrag(e) {
  if (!state.crop.drag || state.crop.drag.pointerId !== e.pointerId) return;
  document.getElementById('cropStage').releasePointerCapture(e.pointerId);
  state.crop.drag = null;
}

document.getElementById('cropStage').addEventListener('pointerdown', startCropDrag);
document.getElementById('cropStage').addEventListener('pointermove', moveCropDrag);
document.getElementById('cropStage').addEventListener('pointerup', endCropDrag);
document.getElementById('cropStage').addEventListener('pointercancel', endCropDrag);
document.getElementById('inputVideo').addEventListener('loadeddata', () => {
  if (state.op.current === 'crop') renderCropFrame();
});
document.getElementById('inputVideo').addEventListener('seeked', () => {
  if (state.op.current === 'crop') renderCropFrame();
});
window.addEventListener('resize', syncCropUI);
