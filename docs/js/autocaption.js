// js/autocaption.js
//
// Auto-Caption workflow: extract audio → transcribe (local Whisper via
// Transformers.js OR OpenAI API via server proxy) → show editable
// transcript → embed as soft or hard-burnt subtitles.
//
// Memory management is critical here: ffmpeg.wasm and Whisper together
// can exceed browser memory limits. The workflow explicitly terminates
// ffmpeg.wasm before transcription (in local-browser mode) and reloads
// it afterwards for the subtitle-embedding step.

import { state } from './state.js';
import { addLog, renderOutput } from './ui.js';
import { getFF, fetchFile, isLoaded, loadFFmpeg, transcribeViaAPI } from './engine.js';
import { parseSubtitleCues, buildCaptionBurnArgs, segmentsToSRT } from './subtitles.js';

/**
 * Update info text based on selected Whisper model.
 */
export function updateAutoCaptionInfo() {
  const model = document.getElementById('autoCaptionModel').value;
  const sizeMap = { tiny: '39 MB', base: '140 MB', small: '466 MB', medium: '1.5 GB' };
  const qualityMap = { tiny: 'Lower quality, very fast', base: 'Balanced quality & speed (recommended)', small: 'Higher quality, slower', medium: 'Best quality, very slow' };
  const infoEl = document.getElementById('autoCaptionInfo');
  infoEl.textContent = `${model} model (${sizeMap[model]}): ${qualityMap[model]}. Downloads and caches on first use.`;
}

/**
 * Lazily initialize the Transcriber. Reused across multiple transcriptions
 * to avoid repeated model downloads. NOTE: Must be explicitly disposed
 * to free memory before re-engaging ffmpeg.
 */
export async function initializeAutoCaptionTranscriber(onProgress) {
  if (!state.whisper.transcriber) {
    // Dynamically import Transcriber from the vendored module
    const { Transcriber } = await import('./transcriber.js');
    state.whisper.transcriber = new Transcriber();
  }
  return state.whisper.transcriber;
}

/**
 * Extract audio from video and convert to WAV (16 kHz mono PCM).
 * Returns Float32Array of audio samples at 16 kHz.
 *
 * ── MEMORY MANAGEMENT NOTE ──
 * This runs ffmpeg extraction. After this completes, ffmpeg's working
 * buffers should be freed before loading the transcriber to avoid
 * resident memory peaks.
 */
export async function extractAudioAsWAV() {
  try {
    addLog('Extracting audio track...', 'ok');
    const inName = 'input.' + state.input.ext;

    addLog(`Using input file: ${inName}`, 'log');

    // Extract audio as 16-bit PCM WAV at 16 kHz (Whisper's required format)
    const args = ['-i', inName, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', 'audio.wav'];
    const exitCode = await getFF().exec(args);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg audio extraction failed with exit code ${exitCode}`);
    }

    addLog('Reading audio data...', 'ok');
    const wavData = await getFF().readFile('audio.wav');
    if (!wavData || wavData.length === 0) {
      throw new Error('Audio file is empty or could not be read');
    }

    const wavBuf = wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength);

    // Parse WAV: skip 44-byte header, read s16 samples, convert to float32
    const view = new DataView(wavBuf);
    const numSamples = Math.floor((wavBuf.byteLength - 44) / 2);
    if (numSamples <= 0) {
      throw new Error(`Invalid WAV data: file size ${wavBuf.byteLength}`);
    }

    const float32Audio = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s16 = view.getInt16(44 + i * 2, true); // little-endian
      float32Audio[i] = s16 / 32768.0; // normalize to [-1, 1]
    }

    addLog(`Extracted ${(numSamples / 16000).toFixed(2)}s of audio (${numSamples} samples @ 16 kHz)`, 'ok');

    // ── MEMORY MANAGEMENT: Clean up extracted WAV from ffmpeg filesystem ──
    try {
      await getFF().deleteFile('audio.wav');
    } catch (e) {
      addLog(`Warning: Could not delete audio.wav: ${e.message || String(e)}`, 'log');
    }

    return float32Audio;
  } catch (err) {
    const errorMsg = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
    addLog(`Error extracting audio: ${errorMsg}`, 'err');
    throw err;
  }
}

/**
 * Update transcript text area with current segments as editable SRT.
 */
export function updateAutoCaptionTranscript() {
  if (!state.whisper.segments) return;
  const srt = segmentsToSRT(state.whisper.segments);
  state.whisper.srt = srt;
  document.getElementById('autoCaptionTranscript').value = srt;
  document.getElementById('autoCaptionTranscriptPanel').classList.remove('hidden');
}

/**
 * Clear/reset the transcript.
 */
export function clearAutoCaptionTranscript() {
  document.getElementById('autoCaptionTranscript').value = '';
  state.whisper.srt = '';
  document.getElementById('autoCaptionTranscriptPanel').classList.add('hidden');
}

/**
 * Confirm edited transcript and embed as subtitles.
 * Called after the user reviews and edits the transcript.
 */
export async function confirmAutoCaptionTranscript() {
  const confirmBtn = document.getElementById('confirmEmbedBtn');
  try {
    // Disable button during embedding
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Embedding…';
    document.getElementById('processBtn').disabled = true;

    state.whisper.srt = document.getElementById('autoCaptionTranscript').value;
    if (!state.whisper.srt.trim()) {
      throw new Error('Transcript is empty');
    }

    // Save SRT content before cleanup
    const srtContent = state.whisper.srt;

    if (!state.engine.useServerMode) {
      // WASM mode: ensure ffmpeg.wasm is reloaded after transcription terminated it
      addLog('Verifying ffmpeg.wasm is loaded and ready…', 'ok');
      let retries = 0;
      while (!isLoaded() && retries < 30) {
        await new Promise(r => setTimeout(r, 200));
        retries++;
      }
      if (!isLoaded()) {
        try {
          await loadFFmpeg();
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
          throw new Error('Failed to load ffmpeg.wasm: ' + (e.message || String(e)));
        }
      }
      if (!isLoaded() || !state.engine.ffmpeg || typeof state.engine.ffmpeg.writeFile !== 'function') {
        throw new Error('FFmpeg failed to initialize properly. Please try again or reload the page.');
      }
      if (state.engine.ffmpeg && typeof state.engine.ffmpeg.load === 'function') {
        try {
          const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
          const classWorkerURL = new URL('./worker.js', location.href).href;
          await state.engine.ffmpeg.load({ classWorkerURL, coreURL: `${coreBase}/ffmpeg-core.js`, wasmURL: `${coreBase}/ffmpeg-core.wasm` });
        } catch (e) {
          console.warn('ffmpeg.load() in embed:', e.message);
        }
      }
    }

    addLog('Writing SRT subtitle file…', 'ok');
    try {
      await getFF().writeFile('autogen.srt', new TextEncoder().encode(srtContent));
    } catch (e) {
      console.error('Error writing SRT file:', e);
      throw new Error('Failed to write subtitle file: ' + (e.message || String(e)));
    }

    // ── CRITICAL: Restore input file to ffmpeg filesystem ──
    // ffmpeg.terminate() cleared the filesystem, so we must re-write the
    // input file before we can use it for subtitle embedding.
    const inName = 'input.' + state.input.ext;
    addLog(`Restoring input file to ffmpeg filesystem: ${inName}…`, 'ok');
    try {
      if (!state.input.file) {
        throw new Error('Input file not available - original file lost');
      }
      await getFF().writeFile(inName, await fetchFile(state.input.file));
      addLog('Input file restored successfully', 'ok');
    } catch (e) {
      console.error('Error restoring input file:', e);
      throw new Error('Failed to restore input file to ffmpeg: ' + (e.message || String(e)));
    }

    if (state.whisper.source === 'local') {
      // Clean up Whisper model weights before re-engaging ffmpeg (OOM prevention)
      if (state.whisper.transcriber && typeof state.whisper.transcriber.dispose === 'function') {
        try { await state.whisper.transcriber.dispose(); } catch (_) {}
      }
    }
    state.whisper.transcriber = null;
    state.whisper.segments = null;
    state.whisper.srt = null;

    // Force garbage collection hint (non-standard but helps some engines)
    if (typeof gc === 'function') gc();

    addLog('Embedding subtitles…', 'ok');

    // Use user-selected format with appropriate subtitle codec
    const fmt = (document.getElementById('autoCaptionFmt').value || 'mp4').trim().toLowerCase();

    // SRT-only output: skip ffmpeg, just download the SRT file
    if (fmt === 'srt') {
      const blob = new Blob([srtContent], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.input.file ? state.input.file.name.replace(/\.[^.]+$/, '') : 'captions') + '.srt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      addLog('SRT file downloaded.', 'ok');
      document.getElementById('autoCaptionTranscriptPanel').classList.add('hidden');
      document.getElementById('processBtn').disabled = false;
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';
      return;
    }

    if (!fmt || (fmt !== 'mp4' && fmt !== 'mkv')) {
      throw new Error(`Invalid format: ${fmt}`);
    }

    const burnCheckbox = document.getElementById('autoCaptionBurn');
    const burnSubtitles = burnCheckbox ? burnCheckbox.checked : false;
    const outName = 'output.' + fmt;

    addLog(`DEBUG: Format=${fmt}, Burn=${burnSubtitles}, SRT length=${srtContent ? srtContent.length : 0}`, 'ok');

    // Build ffmpeg args
    const args = [];

    if (burnSubtitles) {
      if (state.engine.useServerMode) {
        // Server mode: native libass handles subtitle rendering
        addLog('Burning subtitles with native libass…', 'ok');
        args.push('-i', inName);
        args.push('-vf', "subtitles=autogen.srt:force_style='FontSize=22'");
        args.push('-c:a', 'copy', outName);
      } else {
        // Browser WASM mode: no fonts in core build — canvas overlay approach
        addLog('Rendering caption overlays…', 'ok');
        document.getElementById('progWrap').classList.remove('hidden');
        document.getElementById('progLabel').textContent = 'Encoding with subtitles…';
        const cues = parseSubtitleCues(srtContent);
        if (!cues.length) throw new Error('No caption cues found to burn.');
        const fontSizeChoice = (document.getElementById('autoCaptionFontSize') || {}).value || 'medium';
        const burnArgs = await buildCaptionBurnArgs(cues, inName, fontSizeChoice);
        args.push(...burnArgs, outName);
      }
    } else {
      // ── SOFT EMBED: Embed as subtitle stream (stream copy video/audio) ──
      addLog('Using soft subtitle stream embedding…', 'ok');
      const subsCodec = fmt === 'mkv' ? 'copy' : 'mov_text';
      args.push('-i', inName, '-i', 'autogen.srt');
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', subsCodec, '-map', '0:v', '-map', '0:a', '-map', '1:s');
      args.push(outName);
    }

    addLog(`ffmpeg ${args.join(' ')}`, 'ok');

    const exitCode = await getFF().exec(args);

    if (exitCode !== 0) throw new Error(`ffmpeg subtitle embedding failed with code ${exitCode}. Check FFmpeg log above for details.`);

    addLog('Done!', 'ok');

    // Read and display output
    const data = await getFF().readFile(outName);
    await renderOutput(data, fmt);

    // Cleanup
    await getFF().deleteFile(outName).catch(() => {});
    await getFF().deleteFile('autogen.srt').catch(() => {});
    if (burnSubtitles) {
      for (let i = 0; i < 100000; i++) {
        try { await getFF().deleteFile(`caption_${i}.png`); }
        catch { break; }
      }
    }

    // Hide transcript panel
    document.getElementById('autoCaptionTranscriptPanel').classList.add('hidden');
    document.getElementById('progWrap').classList.add('hidden');

    // Re-enable buttons
    document.getElementById('processBtn').disabled = false;
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';

  } catch (err) {
    const errorMsg = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
    addLog(`Error confirming transcript: ${errorMsg}`, 'err');
    document.getElementById('processBtn').disabled = false;
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm & Embed';
  }
}

/**
 * Explicitly clean up transcriber and its model to free memory.
 * Called before re-engaging ffmpeg to prevent OOM.
 */
export async function cleanupAutoCaptionResources() {
  try {
    if (state.whisper.transcriber && typeof state.whisper.transcriber.dispose === 'function') {
      await state.whisper.transcriber.dispose();
    }
  } catch (e) {
    // Ignore errors during cleanup
  }
  state.whisper.transcriber = null;
  state.whisper.segments = null;

  // Hint garbage collection
  if (typeof gc === 'function') gc();
}
