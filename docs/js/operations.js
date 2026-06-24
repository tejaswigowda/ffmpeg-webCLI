// js/operations.js
//
// Two responsibilities:
//
//   1. `setOp(op)` — the operation picker UI controller. Hides/shows the
//      per-op panels, manages the GIF output-format lock, and refreshes
//      dependent UI (size estimate, raw preview, info panel, stack note).
//
//   2. `buildOperationArgs(args, videoEl, inputExt)` — builds the
//      operation-specific ffmpeg args for BATCH processing. This is the
//      batch-mode counterpart of the giant switch in process.js's
//      `runProcess()`. It must stay in sync with that switch — both build
//      the same per-op args, just in different contexts (single-file with
//      trim vs. batch file without trim).
//
// Ops that need per-file configuration or are multi-input (overlay, concat,
// sxs, pip, mixaudio, subtitles, autocaption, raw, info) are excluded from
// batch mode by `BATCH_UNSUPPORTED` in state.js.

import { state, BATCH_UNSUPPORTED } from './state.js';

import { addLog, updateInfoPanel, updateSizeEstimate } from './ui.js';
import { renderCropFrame } from './crop.js';
import { updateRawPreview } from './raw.js';
import { buildAtempo } from './helpers.js';
import { refreshStackControls, updateBatchTileStates } from './stack.js';

export function setOp(op) {
  if (state.stack.mode && !CHAINABLE_has(op)) {
    const name = (document.getElementById('op-' + op)?.textContent || op).trim();
    const note = document.getElementById('addStackNote');
    note.classList.remove('hidden');
    note.innerHTML = '<i class="fas fa-circle-info"></i> &ldquo;' + name + '&rdquo; is multi-input or whole-file and can&rsquo;t be chained. Use Single mode for it.';
    return;
  }

  if (state.batch.mode && BATCH_UNSUPPORTED.has(op)) {
    const name = (document.getElementById('op-' + op)?.textContent || op).trim();
    addLog(`⚠ &ldquo;${name}&rdquo; is not supported in batch mode. It requires per-file configuration or is a multi-input operation.`, 'warn');
    return;
  }

  // Handle GIF format selection: auto-lock to GIF output, disable dropdown
  const outFmtDropdown = document.getElementById('singleOutFmt');
  const outFmtWrap = document.getElementById('singleOutFmtWrap');

  if (state.op.current !== 'gif' && op === 'gif') {
    // Switching TO gif: save current format and lock to gif
    state.op.lastFormatBeforeGif = outFmtDropdown.value;
    outFmtDropdown.value = 'gif';
    outFmtDropdown.disabled = true;
  } else if (state.op.current === 'gif' && op !== 'gif') {
    // Switching AWAY from gif: restore previous format and unlock
    outFmtDropdown.value = state.op.lastFormatBeforeGif;
    outFmtDropdown.disabled = false;
  }

  // Hide general output format selector for Auto-Caption (it has its own format selector)
  if (op === 'autocaption' && outFmtWrap) {
    outFmtWrap.classList.add('hidden');
  } else if (state.op.current === 'autocaption' && outFmtWrap) {
    outFmtWrap.classList.remove('hidden');
  }

  state.op.current = op;
  document.querySelectorAll('.op-tile').forEach(b => b.classList.remove('active'));
  document.getElementById('op-' + op).classList.add('active');
  document.querySelectorAll('.op-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('panel-' + op).classList.remove('hidden');
  if (op === 'crop') renderCropFrame();
  updateSizeEstimate();
  updateRawPreview();
  updateInfoPanel();
  refreshStackControls();
}

function CHAINABLE_has(op) {
  // Local check to avoid importing CHAINABLE redundantly; it's also in state.js.
  return ['crop','resizecompress','rotate','adjust','fade','denoise','sharpenblur','speed','pad','volume'].includes(op);
}

// ── Batch-mode args builder ────────────────────────────────────────────
// Builds operation-specific args (appended to `args`) for a single batch
// file. Mirrors the single-mode switch in process.js.
export function buildOperationArgs(args, videoEl, inputExt) {
  const srcW = videoEl.videoWidth || 1920;
  const srcH = videoEl.videoHeight || 1080;
  const vidDuration = videoEl.duration || 100;
  const inName = 'input_' + videoEl.dataset.batchFileId + '.' + inputExt || 'input.' + inputExt;

  // Get output format (use batch format selector if in batch mode, otherwise single format selector)
  const fmt = state.batch.mode
    ? (document.getElementById('stackOutFmt')?.value || 'mp4')
    : (document.getElementById('singleOutFmt')?.value || 'mp4');

  let ext = fmt === 'gif' ? 'gif' :
            fmt === 'mkv' ? 'mkv' :
            fmt === 'mov' ? 'mov' :
            fmt === 'webm' ? 'webm' :
            fmt === 'avi' ? 'avi' : 'mp4';

  switch (state.op.current) {
    case 'convert': {
      if (['mp4','mkv','mov'].includes(ext)) {
        args.push('-c:v','libx264','-preset','fast','-c:a','aac');
      } else if (ext === 'webm') {
        args.push('-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'gif') {
        args.push('-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse','-an');
      } else if (ext === 'avi') {
        args.push('-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-c:v','copy','-c:a','copy');
      }
      break;
    }
    case 'mute': {
      if (ext === 'gif') {
        args.push('-an','-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse');
      } else if (ext === 'webm') {
        args.push('-an','-c:v','libvpx-vp9','-b:v','0','-crf','30');
      } else if (ext === 'avi') {
        args.push('-an','-c:v','mpeg4','-q:v','5');
      } else {
        args.push('-an','-c:v','libx264','-preset','fast');
      }
      break;
    }
    case 'speed': {
      const sp = parseFloat(document.getElementById('speedVal').value);
      const atempoChain = buildAtempo(sp);
      if (ext === 'gif') {
        args.push('-vf', `setpts=${(1/sp).toFixed(6)}*PTS,fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', `setpts=${(1/sp).toFixed(6)}*PTS`, '-af', atempoChain, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', `setpts=${(1/sp).toFixed(6)}*PTS`, '-af', atempoChain, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', `setpts=${(1/sp).toFixed(6)}*PTS`, '-af', atempoChain, '-c:v','libx264','-preset','fast');
      }
      break;
    }
    case 'crop': {
      let cx = parseInt(document.getElementById('cropX').value) || 0;
      let cy = parseInt(document.getElementById('cropY').value) || 0;
      let cw = parseInt(document.getElementById('cropW').value) || (srcW - cx);
      let ch = parseInt(document.getElementById('cropH').value) || (srcH - cy);

      // Validate and clamp crop values to video dimensions (critical for batch with different video sizes)
      const maxX = Math.max(0, srcW - 1);
      const maxY = Math.max(0, srcH - 1);
      const originalCx = cx, originalCy = cy, originalCw = cw, originalCh = ch;

      cx = Math.max(0, Math.min(cx, maxX));
      cy = Math.max(0, Math.min(cy, maxY));
      cw = Math.max(1, Math.min(cw, srcW - cx));
      ch = Math.max(1, Math.min(ch, srcH - cy));

      // In batch mode, log if crop values were adjusted
      if (state.batch.mode && (cx !== originalCx || cy !== originalCy || cw !== originalCw || ch !== originalCh)) {
        addLog(`  Crop adjusted for this video (${srcW}×${srcH}): (${originalCx},${originalCy} ${originalCw}×${originalCh}) → (${cx},${cy} ${cw}×${ch})`, 'warn');
      }

      const cropVf = `crop=${cw}:${ch}:${cx}:${cy}`;
      if (ext === 'gif') {
        args.push('-vf', `${cropVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', cropVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', cropVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', cropVf, '-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'rotate': {
      const vf = { cw90:'transpose=1', ccw90:'transpose=2', '180':'hflip,vflip', hflip:'hflip', vflip:'vflip', hvflip:'hflip,vflip' };
      const rotVf = vf[document.getElementById('rotateVal').value];
      if (ext === 'gif') {
        args.push('-vf', `${rotVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', rotVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', rotVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', rotVf, '-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'fade': {
      const trimS2 = parseFloat(document.getElementById('trimStart').value) || 0;
      const trimE2 = parseFloat(document.getElementById('trimEnd').value) || vidDuration;
      const clipDur = trimE2 - trimS2;
      const fi = parseFloat(document.getElementById('fadeIn').value) || 0;
      const fo = parseFloat(document.getElementById('fadeOut').value) || 0;
      const vFilters = [], aFilters = [];
      if (fi > 0) { vFilters.push(`fade=t=in:st=0:d=${fi}`); aFilters.push(`afade=t=in:st=0:d=${fi}`); }
      if (fo > 0) { vFilters.push(`fade=t=out:st=${(clipDur-fo).toFixed(3)}:d=${fo}`); aFilters.push(`afade=t=out:st=${(clipDur-fo).toFixed(3)}:d=${fo}`); }
      if (ext === 'gif') {
        const fadeVf = (vFilters.length ? vFilters.join(',') + ',' : '') + 'fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse';
        args.push('-vf', fadeVf, '-an');
      } else if (ext === 'webm') {
        if (vFilters.length) args.push('-vf', vFilters.join(','), '-af', aFilters.join(','));
        args.push('-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        if (vFilters.length) args.push('-vf', vFilters.join(','), '-af', aFilters.join(','));
        args.push('-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        if (vFilters.length) args.push('-vf', vFilters.join(','), '-af', aFilters.join(','));
        args.push('-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'adjust': {
      const br = document.getElementById('adjBright').value;
      const con = document.getElementById('adjContrast').value;
      const sat = document.getElementById('adjGray').checked ? '0' : document.getElementById('adjSat').value;
      const eqVf = `eq=brightness=${br}:contrast=${con}:saturation=${sat}`;
      if (ext === 'gif') {
        args.push('-vf', `${eqVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', eqVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', eqVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', eqVf, '-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'volume': {
      const vol = parseFloat(document.getElementById('volRange').value).toFixed(3);
      if (ext === 'gif') {
        args.push('-af', `volume=${vol}`, '-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-an');
      } else if (ext === 'webm') {
        args.push('-af', `volume=${vol}`, '-c:v','copy', '-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-af', `volume=${vol}`, '-c:v','copy', '-c:a','libmp3lame');
      } else {
        args.push('-af', `volume=${vol}`, '-c:v', 'copy');
      }
      break;
    }
    case 'denoise': {
      const str = document.getElementById('denoiseStrength').value;
      const params = { light: '2:2:3:3', medium: '4:4:6:6', heavy: '10:10:15:15' }[str];
      const denoiseVf = `hqdn3d=${params}`;
      if (ext === 'gif') {
        args.push('-vf', `${denoiseVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', denoiseVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', denoiseVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', denoiseVf, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy');
      }
      break;
    }
    case 'sharpenblur': {
      const mode = document.getElementById('sbMode').value;
      const str  = document.getElementById('sbStrength').value;
      const vfMap = {
        sharpen: { light: 'unsharp=3:3:0.8:3:3:0', medium: 'unsharp=5:5:1.5:5:5:0', heavy: 'unsharp=7:7:3:7:7:0' },
        blur: { light: 'boxblur=3:1', medium: 'boxblur=6:1', heavy: 'boxblur=12:1' },
      };
      const sbVf = vfMap[mode][str];
      if (ext === 'gif') {
        args.push('-vf', `${sbVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', sbVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', sbVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', sbVf, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy');
      }
      break;
    }
    case 'pad': {
      const arVal = document.getElementById('padAR').value;
      const [aw, ah] = arVal.split(':').map(Number);
      const color = document.getElementById('padColor').value;
      const targetAR = aw / ah;
      let tW, tH;
      if (srcW / srcH > targetAR) {
        tW = srcW;
        tH = Math.round(srcW / targetAR / 2) * 2;
      } else {
        tH = srcH;
        tW = Math.round(srcH * targetAR / 2) * 2;
      }
      const padVf = `pad=${tW}:${tH}:(ow-iw)/2:(oh-ih)/2:${color}`;
      if (ext === 'gif') {
        args.push('-vf', `${padVf},fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-an');
      } else if (ext === 'webm') {
        args.push('-vf', padVf, '-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf', padVf, '-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf', padVf, '-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'reverse': {
      if (ext === 'gif') {
        args.push('-vf','reverse,fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse','-an');
      } else if (ext === 'webm') {
        args.push('-vf','reverse','-af','areverse','-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-vf','reverse','-af','areverse','-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-vf','reverse','-af','areverse','-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'boomerang': {
      if (ext === 'gif') {
        args.push('-filter_complex', '[0:v]reverse[rv];[0:v][rv]concat=n=2:v=1:a=0[outv]', '-map', '[outv]', '-an', '-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse');
      } else if (ext === 'webm') {
        args.push('-filter_complex', '[0:v]reverse[rv];[0:v][rv]concat=n=2:v=1:a=0[outv]', '-map', '[outv]', '-an', '-c:v','libvpx-vp9','-b:v','0','-crf','30');
      } else if (ext === 'avi') {
        args.push('-filter_complex', '[0:v]reverse[rv];[0:v][rv]concat=n=2:v=1:a=0[outv]', '-map', '[outv]', '-an', '-c:v','mpeg4','-q:v','5');
      } else {
        args.push('-filter_complex', '[0:v]reverse[rv];[0:v][rv]concat=n=2:v=1:a=0[outv]', '-map', '[outv]', '-an', '-c:v','libx264','-preset','fast');
      }
      break;
    }
    case 'normalize': {
      const target = document.getElementById('normalizeTarget').value;
      if (ext === 'gif') {
        args.push('-af', `loudnorm=I=${target}:LRA=11:TP=-1.5`, '-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-an');
      } else if (ext === 'webm') {
        args.push('-af', `loudnorm=I=${target}:LRA=11:TP=-1.5`, '-c:v','copy', '-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-af', `loudnorm=I=${target}:LRA=11:TP=-1.5`, '-c:v','copy', '-c:a','libmp3lame');
      } else {
        args.push('-af', `loudnorm=I=${target}:LRA=11:TP=-1.5`, '-c:v','copy');
      }
      break;
    }
    case 'audio': {
      ext = document.getElementById('audioFmt').value;
      args.push('-vn');
      if      (ext === 'mp3')  args.push('-c:a','libmp3lame','-q:a','2');
      else if (ext === 'aac')  args.push('-c:a','aac');
      else if (ext === 'wav')  args.push('-c:a','pcm_s16le');
      else if (ext === 'ogg')  args.push('-c:a','libvorbis');
      else if (ext === 'flac') args.push('-c:a','flac');
      break;
    }
    case 'stripmeta': {
      if (ext === 'gif') {
        args.push('-map_metadata','-1','-vf','fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse','-an');
      } else if (ext === 'webm') {
        args.push('-map_metadata','-1','-c:v','libvpx-vp9','-b:v','0','-crf','30','-c:a','libopus');
      } else if (ext === 'avi') {
        args.push('-map_metadata','-1','-c:v','mpeg4','-q:v','5','-c:a','libmp3lame');
      } else {
        args.push('-map_metadata','-1','-c:v','libx264','-preset','fast','-c:a','aac');
      }
      break;
    }
    case 'loop': {
      const loopCount = Math.max(1, parseInt(document.getElementById('loopCount').value) || 3);
      args.push('-stream_loop', loopCount - 1, '-i', inName, '-c', 'copy');
      break;
    }
    case 'overlay': {
      // Logo overlay in batch mode requires per-file second-input handling.
      // The single-mode path uses an aux file picker; in batch we fall back
      // to stream copy so the batch still completes.
      addLog('  Logo overlay in batch mode requires manual per-file configuration. Using stream copy.', 'warn');
      args.push('-c:v', 'copy', '-c:a', 'copy');
      break;
    }
    default:
      // Unsupported operation in batch mode — stream copy as a safe default.
      args.push('-c:v', 'copy', '-c:a', 'copy');
  }
}
