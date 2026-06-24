// js/helpers.js
// Pure utility functions with no DOM dependencies (except where noted).
// These are shared across every other module.

/** Convert a Blob/File to a data: URL via FileReader — no blob: URL created. */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(/** @type {string} */ (r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Format seconds as `M:SS.s` (e.g. 75.4 → "1:15.4"). Returns "0:00.0" for invalid input. */
export function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00.0';
  const m   = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${String(sec).padStart(4, '0')}`;
}

/** Human-readable byte sizes (B / KB / MB). */
export function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** Map a file extension to a MIME type for Blob construction. */
export function mime(ext) {
  return ({
    mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska',
    mov:'video/quicktime', avi:'video/x-msvideo', gif:'image/gif',
    mp3:'audio/mpeg', aac:'audio/aac', wav:'audio/wav',
    ogg:'audio/ogg', flac:'audio/flac',
    jpg:'image/jpeg', png:'image/png',
  })[ext] || 'application/octet-stream';
}

/** Simple clamp — never returns a value outside [min, max]. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Split a shell-like argument string into tokens. Handles double and
 * single quotes (preserves spaces inside). Used by the Raw-FFmpeg op.
 */
export function parseShellArgs(str) {
  const result = [];
  let cur = '', inQ = false, qChar = '';
  for (const ch of str) {
    if (inQ) {
      if (ch === qChar) inQ = false;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = true; qChar = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { result.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) result.push(cur);
  return result;
}

/**
 * Build a chain of `atempo` filters that achieves any positive speed
 * factor. ffmpeg's `atempo` only accepts 0.5–2.0 per stage, so out-of-range
 * speeds are composed by chaining 2.0 (or 0.5) stages.
 */
export function buildAtempo(sp) {
  if (sp >= 0.5 && sp <= 2.0) return `atempo=${sp}`;
  if (sp > 2.0) {
    const stages = [];
    let rem = sp;
    while (rem > 2.0) { stages.push('atempo=2.0'); rem /= 2.0; }
    stages.push(`atempo=${rem.toFixed(4)}`);
    return stages.join(',');
  }
  // sp < 0.5
  const stages = [];
  let rem = sp;
  while (rem < 0.5) { stages.push('atempo=0.5'); rem /= 0.5; }
  stages.push(`atempo=${rem.toFixed(4)}`);
  return stages.join(',');
}

/** Read the source video's intrinsic dimensions from the live <video> element. */
export function getVideoSize() {
  const vid = document.getElementById('inputVideo');
  return { w: vid.videoWidth || 0, h: vid.videoHeight || 0 };
}
