// js/trim.js
//
// Trim-slider sync. Tiny but called from many places (load, setOp, raw
// preview, stack preview) so it gets its own module.

import { state } from './state.js';
import { fmtTime } from './helpers.js';

import { updateSizeEstimate } from './ui.js';
import { updateRawPreview } from './raw.js';
import { updateStackPreview } from './stack.js';

export function updateTrim() {
  const s  = parseFloat(document.getElementById('trimStart').value);
  const e  = parseFloat(document.getElementById('trimEnd').value);
  const dur = state.input.vidDur || 100;

  if (s >= e) document.getElementById('trimStart').value = Math.max(0, e - 0.1);
  const ss = parseFloat(document.getElementById('trimStart').value);
  const ee = parseFloat(document.getElementById('trimEnd').value);

  document.getElementById('startVal').textContent = fmtTime(ss);
  document.getElementById('endVal').textContent   = fmtTime(ee);
  document.getElementById('trimDur').textContent  = 'Selection: ' + fmtTime(ee - ss);

  const fill = document.getElementById('tlFill');
  fill.style.left  = (ss / dur * 100) + '%';
  fill.style.width = ((ee - ss) / dur * 100) + '%';

  updateSizeEstimate();
  updateRawPreview();
  updateStackPreview();
}
