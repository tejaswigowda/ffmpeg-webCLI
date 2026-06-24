// js/process.js
//
// The single-mode processing pipeline (`processVideo` → `runProcess`).
// This is the giant per-op switch that builds ffmpeg args for each
// operation in single-file mode, then runs ffmpeg and renders the
// output. The batch-mode counterpart is `buildOperationArgs` in
// operations.js — both must stay in sync per-op.
//
// Trim is applied as input seeking (-ss before -i, -t after) and never
// enters the filter chain. The autocaption op has its own multi-stage
// workflow (extract audio → transcribe → confirm → embed) and returns
// early without running ffmpeg here.

import { state } from './state.js';
import { fetchFile, getFF, isLoaded, loadFFmpeg } from './engine.js';
import { parseShellArgs, buildAtempo } from './helpers.js';
import {
  addLog, renderOutput, requestWakeLock, releaseWakeLock,
} from './ui.js';
import { parseSubtitleCues, buildCaptionBurnArgs } from './subtitles.js';
import {
  initializeAutoCaptionTranscriber, extractAudioAsWAV,
  updateAutoCaptionTranscript,
} from './autocaption.js';
import { transcribeViaAPI } from './engine.js';
import { runBatch } from './batch.js';

export async function processVideo() {
  if (state.batch.mode) {
    await runBatch();
  } else {
    await runProcess();
  }
}

export async function runProcess() {
  if (!state.input.file) return;

  if (!isLoaded()) {
    await loadFFmpeg();
    if (!isLoaded()) return; // load failed
  }

  const btn = document.getElementById('processBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…';

  const pw = document.getElementById('progWrap');
  pw.classList.remove('hidden');
  document.getElementById('progFill').style.width = '0%';
  document.getElementById('progPct').textContent  = '0%';

  const inName = 'input.' + state.input.ext;

  try {
    // Request screen wake lock to prevent sleep during processing
    await requestWakeLock();

    addLog('Writing input file…', 'ok');
    await getFF().writeFile(inName, await fetchFile(state.input.file));

    const trimS   = parseFloat(document.getElementById('trimStart').value);
    const trimE   = parseFloat(document.getElementById('trimEnd').value);
    const hasTrim = trimS > 0 || (state.input.vidDur > 0 && trimE < state.input.vidDur - 0.05);

    const args = [];

    // Fast seek before input
    if (hasTrim) args.push('-ss', trimS.toFixed(3));
    args.push('-i', inName);
    // Duration (relative to seek point)
    if (hasTrim) args.push('-t', (trimE - trimS).toFixed(3));

    let ext = 'mp4';

    switch (state.op.current) {
      case 'convert': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'resizecompress': {
        const roundEven = v => { const n = parseInt(v); if (isNaN(n) || n < 0) return '-2'; return String(Math.round(n / 2) * 2 || 2); };
        const wRaw = document.getElementById('rcW').value.trim();
        const hRaw = document.getElementById('rcH').value.trim();
        const w = wRaw ? roundEven(wRaw) : '-2';
        const h = hRaw ? roundEven(hRaw) : '-2';
        const crf    = document.getElementById('rcCrf').value;
        const preset = document.getElementById('rcPreset').value;
        ext = document.getElementById('rcFmt').value;
        args.push('-vf', `scale=${w}:${h}`, '-c:v','libx264','-crf', crf, '-preset', preset, '-c:a','aac','-b:a','128k');
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
      case 'mute': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'gif': {
        const fps = document.getElementById('gifFps').value || 10;
        const w   = document.getElementById('gifW').value   || 480;
        ext = 'gif';
        args.push(
          '-filter_complex',
          `[0:v]fps=${fps},scale=${w}:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`
        );
        break;
      }
      case 'speed': {
        const sp = parseFloat(document.getElementById('speedVal').value);
        ext = document.getElementById('singleOutFmt').value;
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
      case 'rotate': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'crop': {
        const vid = document.getElementById('inputVideo');
        const srcW = vid.videoWidth || 1920, srcH = vid.videoHeight || 1080;
        let cx = parseInt(document.getElementById('cropX').value) || 0;
        let cy = parseInt(document.getElementById('cropY').value) || 0;
        let cw = parseInt(document.getElementById('cropW').value) || (srcW - cx);
        let ch = parseInt(document.getElementById('cropH').value) || (srcH - cy);

        // Validate and clamp crop values
        const maxX = Math.max(0, srcW - 1);
        const maxY = Math.max(0, srcH - 1);
        cx = Math.max(0, Math.min(cx, maxX));
        cy = Math.max(0, Math.min(cy, maxY));
        cw = Math.max(1, Math.min(cw, srcW - cx));
        ch = Math.max(1, Math.min(ch, srcH - cy));

        ext = document.getElementById('singleOutFmt').value;
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
      case 'thumbnail': {
        const t = parseFloat(document.getElementById('thumbTime').value) || 0;
        ext = document.getElementById('thumbFmt').value;
        args.length = 0; // override trim args — seek directly to timestamp
        args.push('-ss', t.toFixed(3), '-i', inName, '-vframes', '1');
        if (ext === 'jpg') args.push('-q:v', '2');
        break;
      }
      case 'reverse': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'fade': {
        ext = document.getElementById('singleOutFmt').value;
        const trimS2 = parseFloat(document.getElementById('trimStart').value) || 0;
        const trimE2 = parseFloat(document.getElementById('trimEnd').value)   || state.input.vidDur;
        const clipDur = trimE2 - trimS2;
        const fi = parseFloat(document.getElementById('fadeIn').value)  || 0;
        const fo = parseFloat(document.getElementById('fadeOut').value) || 0;
        const vFilters = [], aFilters = [];
        if (fi > 0) { vFilters.push(`fade=t=in:st=0:d=${fi}`);           aFilters.push(`afade=t=in:st=0:d=${fi}`); }
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
        ext = document.getElementById('singleOutFmt').value;
        const br  = document.getElementById('adjBright').value;
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
      case 'stripmeta': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'subtitles': {
        if (!state.auxFiles.subtitle) throw new Error('Please choose a subtitle file first.');
        ext = document.getElementById('subsFmt').value;
        const subsName = 'subs.' + state.auxFiles.subtitleExt;
        const burnMethod = document.querySelector('input[name="subsBurnMethod"]:checked').value;

        addLog('Writing subtitle file…', 'ok');
        await getFF().writeFile(subsName, await fetchFile(state.auxFiles.subtitle));

        // Reset args
        args.length = 0;

        if (burnMethod === 'burn') {
          // ── HARD-BURN ──
          // The @ffmpeg/core wasm build ships the `subtitles` filter but no
          // fonts for libass, so it renders nothing. Instead we parse the
          // cues and draw them with the browser canvas, then overlay the
          // resulting images.
          addLog('Rendering subtitle overlays (this re-encodes the video)…', 'ok');
          document.getElementById('progWrap').classList.remove('hidden');
          document.getElementById('progLabel').textContent = 'Encoding with subtitles…';

          let subContent;
          try {
            subContent = new TextDecoder().decode(await getFF().readFile(subsName));
          } catch (e) {
            throw new Error(`Subtitle file not found in ffmpeg filesystem: ${e.message}`);
          }
          const cues = parseSubtitleCues(subContent);
          if (!cues.length) {
            throw new Error('Could not parse any subtitle cues (supported: SRT, VTT, ASS/SSA).');
          }
          addLog(`Parsed ${cues.length} subtitle cues`, 'ok');

          const fontSizeChoice = (document.getElementById('subsFontSize') || {}).value || 'medium';
          const burnArgs = await buildCaptionBurnArgs(cues, inName, fontSizeChoice);
          args.push(...burnArgs);
        } else {
          // ── SOFT EMBED: Embed as subtitle stream (stream copy video/audio) ──
          addLog('Using soft subtitle stream embedding…', 'ok');
          args.push('-i', inName, '-i', subsName);
          const subsCodec = ext === 'mkv' ? 'copy' : 'mov_text';
          args.push('-c:v','copy','-c:a','copy','-c:s', subsCodec,'-map','0:v','-map','0:a','-map','1:s');
        }
        break;
      }
      case 'autocaption': {
        // ── AUTO-CAPTION WORKFLOW (Multi-Stage) ──
        // 1. Extract audio from video
        // 2. Initialize Transcriber and transcribe audio
        // 3. Show transcript for user editing
        // 4. On confirmation, embed subtitles into video
        // CRITICAL: Memory handoff between ffmpeg and whisper to avoid OOM

        ext = document.getElementById('autoCaptionFmt').value;
        const model = document.getElementById('autoCaptionModel').value;

        try {
          // Disable button during processing
          document.getElementById('processBtn').disabled = true;

          // Show main progress bar for transcription
          const pw2 = document.getElementById('progWrap');
          pw2.classList.remove('hidden');
          document.getElementById('autoCaptionTranscriptPanel').classList.add('hidden');
          addLog(`Starting Auto-Caption with ${model} model\u2026`, 'ok');

          // STEP 1: Extract audio to float32 at 16 kHz
          addLog('Stage 1/3: Extracting audio\u2026', 'ok');
          const audioBuffer = await extractAudioAsWAV();

          // Only unload WASM ffmpeg in local-whisper browser mode (frees 31 MB during long transcription)
          if (!state.engine.useServerMode && state.whisper.source === 'local') {
            addLog('Unloading ffmpeg.wasm to free memory during transcription…', 'ok');
            try {
              await state.engine.ffmpeg.terminate();
            } catch (e) {
              console.warn('Error unloading ffmpeg.wasm:', e);
            }
          }

          // STEP 2: Transcribe
          addLog('Stage 2/3: Transcribing with Whisper\u2026', 'ok');

          // Show progress bar
          const progWrap = document.getElementById('progWrap');
          progWrap.classList.remove('hidden');
          document.getElementById('progPct').textContent = '0%';
          document.getElementById('progFill').style.width = '0%';

          let segments;

          if (state.whisper.source === 'api') {
            // ── OpenAI Whisper API mode ──
            if (!state.whisper.apiKey) throw new Error('No OpenAI API key set. Add it in the Auto-Caption panel.');
            document.getElementById('progLabel').textContent = 'Sending to OpenAI Whisper API\u2026';
            const rawSrt = await transcribeViaAPI(audioBuffer, state.whisper.apiKey);
            segments = [];
            for (const block of rawSrt.trim().split(/\n\s*\n/)) {
              const lines = block.trim().split('\n');
              const tcLine = lines.find(l => l.includes('-->'));
              if (!tcLine) continue;
              const [startStr, endStr] = tcLine.split('-->').map(s => s.trim());
              const parseTime = t => {
                const [hms, ms] = t.replace(',', '.').split('.');
                const parts = hms.split(':').map(Number);
                const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
                return h * 3600 + m * 60 + s + Number('0.' + (ms || '0'));
              };
              const text = lines.slice(lines.indexOf(tcLine) + 1).join(' ').trim();
              if (text) segments.push({ start: parseTime(startStr), end: parseTime(endStr), text });
            }
            document.getElementById('progPct').textContent = '100%';
            document.getElementById('progFill').style.width = '100%';
            document.getElementById('progLabel').textContent = 'Transcription complete';
          } else {
            // ── Local Whisper (Transformers.js) mode ──
            document.getElementById('progLabel').textContent = 'Loading model\u2026';
            const transcriber = await initializeAutoCaptionTranscriber();

            const updateProgress = (prog) => {
              if (typeof prog !== 'object' || !prog) return;
              let pct, label;
              if (prog.status === 'progress' || prog.status === 'downloading') {
                const loaded = prog.loaded || 0;
                const total = prog.total || 1;
                pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                label = `Loading model\u2026 ${pct}%`;
                console.log('Model loading progress:', pct + '%');
              }
              // Handle custom transcription progress format
              else if (typeof prog.pct === 'number') {
                pct = prog.pct;
                label = prog.label || `Transcribing\u2026 ${pct}%`;
                console.log('Transcription progress detected: pct=' + pct + ', label=' + label);
              }
              if (typeof pct === 'number' && pct >= 0) {
                document.getElementById('progPct').textContent = `${pct}%`;
                document.getElementById('progFill').style.width = `${pct}%`;
                document.getElementById('progLabel').textContent = label;
              }
            };
            segments = await transcriber.transcribe(audioBuffer, {
              model: model,
              sampleRate: 16000,
              onModelProgress: updateProgress,
              onProgress: updateProgress,
              onStatus: (status) => {
                if (status.stage === 'transcribing') {
                  document.getElementById('progPct').textContent = '0%';
                  document.getElementById('progFill').style.width = '0%';
                  document.getElementById('progLabel').textContent = 'Transcribing…';
                }
              },
            });
            document.getElementById('progPct').textContent = '100%';
            document.getElementById('progFill').style.width = '100%';
            document.getElementById('progLabel').textContent = 'Transcription complete';
          } // end else (local whisper)

          state.whisper.segments = segments;
          addLog(`Transcription complete: ${segments.length} segments`, 'ok');

          // STEP 3: Show transcript for editing
          addLog('Stage 3/3: Ready for review…', 'ok');
          updateAutoCaptionTranscript();
          pw.classList.add('hidden');

          const confirmBtn = document.getElementById('confirmEmbedBtn');
          if (!state.engine.useServerMode && state.whisper.source === 'local') {
            // Browser WASM mode: ffmpeg was terminated — reload in background
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading ffmpeg…';
            addLog('Preparing ffmpeg.wasm for subtitle embedding…', 'ok');
            (async () => {
              try {
                if (!isLoaded()) await loadFFmpeg();
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';
                addLog('ffmpeg.wasm ready.', 'ok');
              } catch (e) {
                addLog('Warning: Could not preload ffmpeg. Will retry on Confirm & Embed.', 'warn');
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';
              }
            })();
          } else {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';
          }
          return; // User clicks Confirm & Embed to continue

        } catch (err) {
          pw.classList.add('hidden');
          const errorMsg = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
          const friendly = /failed to fetch/i.test(errorMsg)
            ? `${errorMsg} — could not reach the model or API. Check your network or API key.`
            : errorMsg;
          addLog(`Auto-Caption error: ${friendly}`, 'err');
          if (!state.engine.useServerMode && state.whisper.source === 'local') {
            try { await loadFFmpeg(); } catch (_) {}
          }
          document.getElementById('processBtn').disabled = false;
          return;
        }
      }
      case 'volume': {
        const vol = parseFloat(document.getElementById('volRange').value).toFixed(3);
        ext = document.getElementById('singleOutFmt').value;
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
      case 'loop': {
        const n = Math.max(1, (parseInt(document.getElementById('loopCount').value) || 3) - 1);
        ext = state.input.ext || 'mp4';
        args.length = 0;
        args.push('-stream_loop', String(n), '-i', inName, '-c', 'copy');
        break;
      }
      case 'overlay': {
        if (!state.auxFiles.overlay) throw new Error('Please choose a logo/image file first.');
        const logoName = 'logo.' + state.auxFiles.overlayExt;
        addLog('Writing logo file\u2026', 'ok');
        await getFF().writeFile(logoName, await fetchFile(state.auxFiles.overlay));
        const pos   = document.getElementById('overlayPos').value;
        const pct   = parseInt(document.getElementById('overlayScale').value) || 15;
        const vidEl = document.getElementById('inputVideo');
        const logoW = Math.round((vidEl.videoWidth || 1920) * pct / 100);
        ext = 'mp4';
        args.length = 0;
        if (hasTrim) args.push('-ss', trimS.toFixed(3), '-t', (trimE - trimS).toFixed(3));
        args.push('-i', inName, '-i', logoName);
        args.push(
          '-filter_complex', `[1:v]scale=${logoW}:-2[logo];[0:v][logo]overlay=${pos}`,
          '-c:a', 'copy'
        );
        break;
      }
      case 'mixaudio': {
        if (!state.auxFiles.mixAudio) throw new Error('Please choose a music/audio file first.');
        const musicName = 'music.' + state.auxFiles.mixAudioExt;
        addLog('Writing music file\u2026', 'ok');
        await getFF().writeFile(musicName, await fetchFile(state.auxFiles.mixAudio));
        const origVol  = parseFloat(document.getElementById('mixOrigVol').value).toFixed(3);
        const musicVol = parseFloat(document.getElementById('mixMusicVol').value).toFixed(3);
        ext = 'mp4';
        args.length = 0;
        args.push('-i', inName, '-stream_loop', '-1', '-i', musicName);
        args.push(
          '-filter_complex',
          `[0:a]volume=${origVol}[a1];[1:a]volume=${musicVol}[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
          '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-shortest'
        );
        break;
      }
      case 'concat': {
        if (!state.auxFiles.concat) throw new Error('Please choose a second clip to append.');
        const clip2Name = 'clip2.' + state.auxFiles.concatExt;
        addLog('Writing second clip\u2026', 'ok');
        await getFF().writeFile(clip2Name, await fetchFile(state.auxFiles.concat));
        ext = 'mp4';
        args.length = 0;
        if (hasTrim) args.push('-ss', trimS.toFixed(3), '-t', (trimE - trimS).toFixed(3));
        args.push('-i', inName, '-i', clip2Name);
        args.push(
          '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]',
          '-map', '[outv]', '-map', '[outa]',
          '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac'
        );
        break;
      }
      case 'sxs': {
        if (!state.auxFiles.sxs) throw new Error('Please choose a second video file first.');
        const sxsName = 'sxs.' + state.auxFiles.sxsExt;
        addLog('Writing second video…', 'ok');
        await getFF().writeFile(sxsName, await fetchFile(state.auxFiles.sxs));
        const sxsLayout = document.getElementById('sxsLayout').value;
        const sxsDim    = parseInt(document.getElementById('sxsDim').value) || 480;
        const sxsAudio  = document.getElementById('sxsAudio').value;
        ext = 'mp4';
        args.length = 0;
        args.push('-i', inName, '-i', sxsName);
        const sxsFc = sxsLayout === 'h'
          ? `[0:v]scale=-2:${sxsDim}[v1];[1:v]scale=-2:${sxsDim}[v2];[v1][v2]hstack=inputs=2[out]`
          : `[0:v]scale=${sxsDim}:-2[v1];[1:v]scale=${sxsDim}:-2[v2];[v1][v2]vstack=inputs=2[out]`;
        args.push('-filter_complex', sxsFc, '-map', '[out]');
        if (sxsAudio === 'none') {
          args.push('-an');
        } else {
          args.push('-map', `${sxsAudio}:a?`);
        }
        args.push('-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-shortest');
        break;
      }
      case 'pip': {
        if (!state.auxFiles.pip) throw new Error('Please choose an overlay video file first.');
        const pipName = 'pip.' + state.auxFiles.pipExt;
        addLog('Writing overlay video…', 'ok');
        await getFF().writeFile(pipName, await fetchFile(state.auxFiles.pip));
        const pipPos  = document.getElementById('pipPos').value;
        const pipPct  = parseInt(document.getElementById('pipScale').value) || 30;
        const pipVid  = document.getElementById('inputVideo');
        const pipW    = Math.round((pipVid.videoWidth || 1920) * pipPct / 100);
        ext = 'mp4';
        args.length = 0;
        if (hasTrim) args.push('-ss', trimS.toFixed(3), '-t', (trimE - trimS).toFixed(3));
        args.push('-i', inName, '-stream_loop', '-1', '-i', pipName);
        args.push(
          '-filter_complex', `[1:v]scale=${pipW}:-2[pip];[0:v][pip]overlay=${pipPos}[out]`,
          '-map', '[out]', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-shortest'
        );
        break;
      }
      case 'info': {
        args.length = 0;
        args.push('-hide_banner', '-i', inName);
        addLog('ffmpeg ' + args.join(' '), 'ok');
        await getFF().exec(args); // exits with code 1 — expected
        addLog('\u2500\u2500\u2500 Deep scan complete \u2014 see log above for full codec / stream details. \u2500\u2500\u2500', 'ok');
        pw.classList.add('hidden');
        return; // finally block re-enables the button
      }
      case 'raw': {
        const userArgs = parseShellArgs(document.getElementById('rawArgs').value);
        ext = document.getElementById('rawExt').value.trim().replace(/^\./, '') || 'mp4';
        if (document.getElementById('rawBypassTrim').checked) {
          args.length = 0;
          args.push('-i', inName);
        }
        // Write optional second input to the virtual FS
        if (state.auxFiles.rawInput2) {
          const in2Name = 'input2.' + state.auxFiles.rawInput2Ext;
          addLog('Writing second input file\u2026', 'ok');
          await getFF().writeFile(in2Name, await fetchFile(state.auxFiles.rawInput2));
        }
        args.push(...userArgs);
        break;
      }
      case 'pad': {
        const arVal = document.getElementById('padAR').value;
        const [aw, ah] = arVal.split(':').map(Number);
        const color   = document.getElementById('padColor').value;
        const vidEl   = document.getElementById('inputVideo');
        const srcW    = vidEl.videoWidth  || 1920;
        const srcH    = vidEl.videoHeight || 1080;
        const targetAR = aw / ah;
        let tW, tH;
        if (srcW / srcH > targetAR) {
          tW = srcW;
          tH = Math.round(srcW / targetAR / 2) * 2;
        } else {
          tH = srcH;
          tW = Math.round(srcH * targetAR / 2) * 2;
        }
        ext = document.getElementById('singleOutFmt').value;
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
      case 'normalize': {
        const target = document.getElementById('normalizeTarget').value;
        ext = document.getElementById('singleOutFmt').value;
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
      case 'denoise': {
        const str    = document.getElementById('denoiseStrength').value;
        const params = { light: '2:2:3:3', medium: '4:4:6:6', heavy: '10:10:15:15' }[str];
        ext = document.getElementById('singleOutFmt').value;
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
      case 'boomerang': {
        ext = document.getElementById('singleOutFmt').value;
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
      case 'sharpenblur': {
        const mode = document.getElementById('sbMode').value;
        const str  = document.getElementById('sbStrength').value;
        const vfMap = {
          sharpen: { light: 'unsharp=3:3:0.8:3:3:0', medium: 'unsharp=5:5:1.5:5:5:0', heavy: 'unsharp=7:7:3:7:7:0' },
          blur:    { light: 'boxblur=3:1', medium: 'boxblur=6:1', heavy: 'boxblur=12:1' },
        };
        ext = document.getElementById('singleOutFmt').value;
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
    }

    state.op.outExt = ext;
    const outName = 'output.' + ext;
    args.push(outName);

    addLog('ffmpeg ' + args.join(' '), 'ok');
    const exitCode = await getFF().exec(args);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — check your arguments and try again.`);
    addLog('Done!', 'ok');

    const data = await getFF().readFile(outName);
    await renderOutput(data, ext);

    // Clean up virtual FS
    await getFF().deleteFile(inName).catch(() => {});
    await getFF().deleteFile(outName).catch(() => {});

  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err)) || 'unknown error';
    addLog('Error: ' + errMsg, 'err');
    // Still try to clean up FS on error
    try { await getFF().deleteFile(inName); } catch (_) {}
    try { await getFF().deleteFile('output.' + state.op.outExt); } catch (_) {}
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-gear"></i> Process Video';
    releaseWakeLock(); // Release screen wake lock after processing
  }
}

// ── Download (the last rendered output) ─────────────────────────────────
export async function download() {
  if (!state.op.outBlob) return;
  const a = document.createElement('a');
  // Local import to avoid a circular dep at module-eval time.
  const { blobToDataURL } = await import('./helpers.js');
  a.href = await blobToDataURL(state.op.outBlob);
  a.download = 'output.' + state.op.outExt;
  a.click();
}
