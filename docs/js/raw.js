// js/raw.js
//
// "Raw FFmpeg" operation: a small library of example commands the user
// can click to populate the args textarea, plus the live `ffmpeg ...`
// command preview that updates as the user edits the args/output-ext/
// bypass-trim fields.

import { state } from './state.js';
import { parseShellArgs } from './helpers.js';

// ── Example library ────────────────────────────────────────────────────
const RAW_EXAMPLES = [
  { label: '<i class="fas fa-stamp"></i> Color-bar watermark',    args: '-vf "drawbox=x=iw-220:y=ih-55:w=210:h=45:color=black@0.5:t=fill,drawbox=x=iw-218:y=ih-53:w=206:h=41:color=white@0.25:t=fill" -c:v libx264 -crf 23 -preset fast -c:a copy', ext: 'mp4' },
  { label: '<i class="fas fa-gauge-high"></i> Cap framerate to 24 fps',  args: '-vf fps=24 -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                                          ext: 'mp4' },
  { label: '<i class="fas fa-palette"></i> Convert to grayscale',    args: '-vf format=gray -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                                     ext: 'mp4' },
  { label: '<i class="fas fa-volume-high"></i> Loudness normalize',      args: '-af loudnorm -c:v copy',                                                                                                                                          ext: 'mp4' },
  { label: '<i class="fas fa-box"></i> Lossless remux (copy)',   args: '-c copy',                                                                                                                                                          ext: 'mp4' },
  { label: '<i class="fas fa-tv"></i> Letterbox / pillarbox',   args: '-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" -c:v libx264 -crf 23 -c:a aac',                                ext: 'mp4' },
  { label: '<i class="fas fa-broom"></i> Denoise (hqdn3d)',        args: '-vf hqdn3d -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                                         ext: 'mp4' },
  { label: '<i class="fas fa-magnifying-glass"></i> Sharpen (unsharp)',       args: '-vf unsharp=5:5:1.5:5:5:0 -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                          ext: 'mp4' },
  { label: '<i class="fas fa-bullseye"></i> Stabilize (deshake)',     args: '-vf deshake -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                                         ext: 'mp4' },
  { label: '<i class="fas fa-moon"></i> Vignette effect',         args: '-vf vignette=PI/4 -c:v libx264 -crf 23 -preset fast -c:a copy',                                                                                                   ext: 'mp4' },
  { label: '<i class="fas fa-file-audio"></i> Extract audio as WAV',    args: '-vn -acodec pcm_s16le',                                                                                                                                           ext: 'wav' },
  { label: '<i class="fas fa-image"></i> Extract first frame',     args: '-vframes 1',                                                                                                                                                       ext: 'png' },
  { label: '<i class="fas fa-music"></i> Replace audio track',     args: '-i input2.mp3 -map 0:v:0 -map 1:a:0 -shortest -c:v copy -c:a aac',  ext: 'mp4', needsInput2: true  },
];

export function initRawExamples() {
  const list = document.getElementById('rawExamplesList');
  RAW_EXAMPLES.forEach(ex => {
    const btn = document.createElement('button');
    btn.className = 'raw-example-btn';
    const preview = ex.args.length > 55 ? ex.args.slice(0, 52) + '\u2026' : ex.args;
    const badge = ex.needsInput2 ? '<span class="rex-input2-badge">+ 2nd file</span>' : '';
    btn.innerHTML = `<span class="rex-label">${ex.label}</span>${badge}<code class="rex-code">${preview}</code>`;
    btn.onclick = () => {
      document.getElementById('rawArgs').value = ex.args;
      document.getElementById('rawExt').value  = ex.ext;
      updateRawPreview();
      document.getElementById('rawExamplesPanel').removeAttribute('open');
      if (ex.needsInput2 && !state.auxFiles.rawInput2) {
        const row = document.getElementById('rawInput2Row');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        row.classList.remove('input2-highlight');
        void row.offsetWidth; // force reflow to restart animation
        row.classList.add('input2-highlight');
        row.addEventListener('animationend', () => row.classList.remove('input2-highlight'), { once: true });
      }
    };
    list.appendChild(btn);
  });
}

// ── Live command preview ───────────────────────────────────────────────
export function updateRawPreview() {
  if (state.op.current !== 'raw') return;
  const el = document.getElementById('cmdPreview');
  if (!state.input.file) { el.textContent = '(load a file first)'; return; }
  const inN    = 'input.' + (state.input.ext || 'mp4');
  const ext    = document.getElementById('rawExt').value.trim().replace(/^\./, '') || 'mp4';
  const bypass = document.getElementById('rawBypassTrim').checked;
  const trimS  = parseFloat(document.getElementById('trimStart').value) || 0;
  const trimE  = parseFloat(document.getElementById('trimEnd').value)   || state.input.vidDur;
  const hasTrim = !bypass && (trimS > 0 || (state.input.vidDur > 0 && trimE < state.input.vidDur - 0.05));
  const parts = ['ffmpeg'];
  if (hasTrim) parts.push('-ss', trimS.toFixed(3));
  parts.push('-i', inN);
  if (hasTrim) parts.push('-t', (trimE - trimS).toFixed(3));
  const userArgs = parseShellArgs(document.getElementById('rawArgs').value);
  parts.push(...userArgs);
  parts.push('output.' + ext);
  el.textContent = parts.join(' ');
}
