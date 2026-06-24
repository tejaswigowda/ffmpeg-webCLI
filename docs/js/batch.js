// js/batch.js
//
// Batch mode: queue multiple files, run the current op (or the current
// stack) against each one, and present per-file results. Batch is
// mutually exclusive with trim (each file runs start-to-end) and
// restricts the op set to those that don't need per-file configuration
// (see `BATCH_UNSUPPORTED` in state.js).
//
// Batch + Stack interplay: when both are on, the entire stack runs
// against each batched file via stack.js's `runBatchStack()` (called
// from `runProcessStack()`).

import { state, BATCH_UNSUPPORTED } from './state.js';
import { blobToDataURL, mime } from './helpers.js';
import { addLog, syncProcessBtn, requestWakeLock, releaseWakeLock } from './ui.js';
import { getFF, fetchFile, isLoaded, loadFFmpeg } from './engine.js';
import { buildOperationArgs } from './operations.js';
import { refreshStackControls, renderStack } from './stack.js';

export function toggleBatchMode() {
  state.batch.mode = !state.batch.mode;
  const btn = document.getElementById('batchToggle');
  const queueList = document.getElementById('batchQueueList');
  const dropZoneText = document.getElementById('dropZoneText');
  const fileInput = document.getElementById('fileInput');
  const trimCard = document.getElementById('trimCard');
  const batchTrimWarning = document.getElementById('batchTrimWarning');
  const batchOutputsWrap = document.getElementById('batchOutputsWrap');

  if (state.batch.mode) {
    btn.classList.add('active');
    queueList.classList.add('visible');
    trimCard.classList.add('disabled');
    batchTrimWarning.style.display = 'inline-block';
    document.getElementById('addStackBtn').disabled = true;
    dropZoneText.innerHTML = '<strong>Click to add files</strong> or drag & drop multiple local files';
    fileInput.multiple = true;

    // Graceful fallback: if a video is already loaded, add it to batch queue
    if (state.input.file) {
      state.batch.queue.push({
        file: state.input.file,
        status: 'pending',
        error: null,
        output: null,
        outputName: null
      });
      addLog(`Graceful fallback: Added "${state.input.file.name}" to batch queue. You can add more files.`, 'ok');
      // Hide the single video display but keep the file in the queue
      document.getElementById('inputVideo').src = '';
      document.getElementById('inputWrap').classList.add('hidden');
      document.getElementById('dropZone').classList.remove('hidden');
    } else {
      state.batch.queue.length = 0;
    }
    updateBatchQueueUI();
    addLog('Batch mode enabled. Drop multiple files to queue them.', 'ok');
  } else {
    btn.classList.remove('active');
    queueList.classList.remove('visible');
    trimCard.classList.remove('disabled');
    batchTrimWarning.style.display = 'none';
    batchOutputsWrap.classList.add('hidden');
    document.getElementById('addStackBtn').disabled = false;
    dropZoneText.innerHTML = '<strong>Click to choose</strong> or drag & drop local file';
    fileInput.multiple = false;
    state.batch.queue.length = 0;
    state.batch.current = null;
    updateBatchQueueUI();
    addLog('Batch mode disabled. Single file mode active.', 'ok');
  }
  syncProcessBtn();
  updateBatchTileStates();
}

export function handleBatchFiles(files) {
  if (!state.batch.mode) return;
  for (const file of files) {
    if (file.type.startsWith('video/') || file.type === 'image/gif') {
      state.batch.queue.push({
        file,
        status: 'pending',
        error: null,
        output: null
      });
    }
  }
  updateBatchQueueUI();
  addLog(`Added ${state.batch.queue.length} file(s) to batch queue.`, 'ok');
  syncProcessBtn();

  // If we're already in stack mode, make the freshly-queued files usable
  // for building a stack: load a representative file (for crop/pad
  // dimensions) and refresh the stack controls.
  if (state.stack.mode && state.batch.queue.length > 0) {
    loadFirstBatchFileForStack();
    refreshStackControls();
    renderStack();
  }
}

// Load the first queued batch file into the input preview so stack ops
// that need source dimensions (crop, pad) have something to read. No-op
// if a file is already loaded.
export function loadFirstBatchFileForStack() {
  if (state.input.file || !state.batch.mode || state.batch.queue.length === 0) return;
  const firstBatchFile = state.batch.queue[0].file;
  const reader = new FileReader();
  reader.onload = (e) => {
    state.input.file = firstBatchFile;
    state.input.ext = firstBatchFile.name.split('.').pop().toLowerCase();
    const video = document.getElementById('inputVideo');
    video.src = e.target.result;
    video.onloadedmetadata = () => {
      document.getElementById('inputWrap').classList.remove('hidden');
      document.getElementById('dropZone').classList.add('hidden');
      addLog(`Loaded first batch file for stack building: "${firstBatchFile.name}"`, 'ok');
      refreshStackControls();
      renderStack();
    };
  };
  reader.readAsDataURL(firstBatchFile);
}

export function updateBatchTileStates() {
  // Disable tiles for batch-unsupported ops when in batch mode and for
  // non-chainable ops when in stack mode.
  document.querySelectorAll('.op-tile').forEach(tile => {
    const opId = tile.id.replace('op-', '');
    const isDisabledByStack = state.stack.mode && !['crop','resizecompress','rotate','adjust','fade','denoise','sharpenblur','speed','pad','volume'].includes(opId);
    const isDisabledByBatch = state.batch.mode && BATCH_UNSUPPORTED.has(opId);
    tile.classList.toggle('disabled', isDisabledByStack || isDisabledByBatch);
  });
}

export function updateBatchQueueUI() {
  const counter = document.getElementById('batchQueueCounter');
  const items = document.getElementById('batchQueueItems');

  counter.textContent = `${state.batch.queue.length} file${state.batch.queue.length !== 1 ? 's' : ''} queued`;

  items.innerHTML = state.batch.queue.map((item, i) => {
    const isDone = item.status === 'done';
    const isError = item.status === 'error';
    return `
      <div class="batch-file-item">
        <div class="batch-file-status ${item.status}">
          ${item.status === 'pending' ? '<i class="fas fa-hourglass-end"></i>' :
            item.status === 'processing' ? '<i class="fas fa-spinner fa-spin"></i>' :
            item.status === 'done' ? '<i class="fas fa-check"></i>' :
            '<i class="fas fa-exclamation"></i>'}
        </div>
        <div class="batch-file-name" title="${item.file.name}">
          <strong>${item.file.name}</strong>
          ${isDone ? `<br><small>→ ${item.outputName}</small>` : ''}
          ${isError ? `<br><small style="color:var(--error)">${item.error}</small>` : ''}
        </div>
        <div class="batch-file-actions">
          ${isDone ? `<button class="batch-btn-sm" onclick="downloadBatchFile(${i})" title="Download"><i class="fas fa-download"></i></button>` : ''}
          <button class="batch-btn-sm" onclick="removeBatchFile(${i})" title="Remove"><i class="fas fa-trash-can"></i></button>
        </div>
      </div>
    `;
  }).join('');
}

export function removeBatchFile(index) {
  state.batch.queue.splice(index, 1);
  updateBatchQueueUI();
  syncProcessBtn();
}

export async function downloadBatchFile(index) {
  const item = state.batch.queue[index];
  if (!item.output) return;
  const a = document.createElement('a');
  a.href = await blobToDataURL(item.output);
  a.download = item.outputName || 'output.mp4';
  a.click();
}

export async function downloadAllBatchFiles() {
  const completed = state.batch.queue.filter(i => i.status === 'done' && i.output);
  if (completed.length === 0) {
    addLog('No completed files to download.', 'warn');
    return;
  }

  // If only one file, download it directly
  if (completed.length === 1) {
    const item = completed[0];
    const a = document.createElement('a');
    a.href = await blobToDataURL(item.output);
    a.download = item.outputName || 'output.mp4';
    a.click();
    return;
  }

  // For multiple files, prompt user to download individually (ZIP path
  // is in downloadBatchAllAsZip below).
  addLog(`${completed.length} files completed. Download each file individually using the download button.`, 'ok');
}

export function clearBatchQueue() {
  state.batch.queue.length = 0;
  state.batch.current = null;
  updateBatchQueueUI();
  updateBatchOutputsDisplay();
  addLog('Batch queue cleared.', 'ok');
  syncProcessBtn();
}

// ── Batch run loop ─────────────────────────────────────────────────────
export async function runBatch() {
  if (state.batch.queue.length === 0) {
    addLog('Batch queue is empty.', 'warn');
    return;
  }

  if (!isLoaded()) {
    await loadFFmpeg();
    if (!isLoaded()) return;
  }

  const btn = document.getElementById('processBtn');
  const opTiles = document.querySelectorAll('.op-tile');
  const progWrap = document.getElementById('progWrap');

  // Show progress bar
  progWrap.classList.remove('hidden');
  document.getElementById('progLabel').textContent = 'Batch Processing…';

  // Disable all operation tiles during batch processing
  opTiles.forEach(t => t.style.pointerEvents = 'none');
  opTiles.forEach(t => t.style.opacity = '0.5');
  btn.disabled = true;

  addLog(`Starting batch processing of ${state.batch.queue.length} file(s)…`, 'ok');

  try {
    await requestWakeLock();

    for (let i = 0; i < state.batch.queue.length; i++) {
      const item = state.batch.queue[i];
      state.batch.current = i;

      // Update progress bar
      const progress = ((i) / state.batch.queue.length) * 100;
      document.getElementById('progFill').style.width = progress + '%';
      document.getElementById('progPct').textContent = Math.round(progress) + '%';

      // Update status to processing
      item.status = 'processing';
      updateBatchQueueUI();

      const progressMsg = `[${i + 1}/${state.batch.queue.length}] Processing: ${item.file.name}`;
      addLog(progressMsg, 'ok');

      try {
        // Run the operation for this file
        await processBatchFile(item);
        item.status = 'done';
      } catch (err) {
        item.status = 'error';
        item.error = err.message || String(err);
        addLog(`Error processing ${item.file.name}: ${item.error}`, 'error');
      }

      updateBatchQueueUI();
    }

    // Finalize progress bar
    document.getElementById('progFill').style.width = '100%';
    document.getElementById('progPct').textContent = '100%';

    const done = state.batch.queue.filter(i => i.status === 'done').length;
    const failed = state.batch.queue.filter(i => i.status === 'error').length;
    addLog(`Batch complete: ${done} succeeded, ${failed} failed.`, done === state.batch.queue.length ? 'ok' : failed === 0 ? 'ok' : 'warn');

  } finally {
    // Hide progress bar
    setTimeout(() => {
      progWrap.classList.add('hidden');
      document.getElementById('progFill').style.width = '0%';
      document.getElementById('progPct').textContent = '0%';
    }, 1000);

    // Update batch outputs display (in case any files were completed)
    updateBatchOutputsDisplay();

    // Re-enable operation tiles
    opTiles.forEach(t => t.style.pointerEvents = 'auto');
    opTiles.forEach(t => t.style.opacity = '1');
    btn.disabled = false;
    state.batch.current = null;
    releaseWakeLock();
  }
}

async function processBatchFile(item) {
  const file = item.file;
  const inputFileExt = file.name.split('.').pop().toLowerCase() || 'mp4';

  // Get output format from batch output format selector
  const outFmt = document.getElementById('stackOutFmt')?.value || 'mp4';
  const outExt = outFmt === 'gif' ? 'gif' :
                 outFmt === 'mkv' ? 'mkv' :
                 outFmt === 'mov' ? 'mov' :
                 outFmt === 'webm' ? 'webm' :
                 outFmt === 'avi' ? 'avi' : 'mp4';

  const inName = 'batchinput_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.' + inputFileExt;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const outName = 'batchoutput_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.' + outExt;
  item.outputName = baseName + '_processed.' + outExt;

  // Write input file
  addLog(`  Writing ${file.name}…`, 'log');
  await getFF().writeFile(inName, await fetchFile(file));

  // Create video element to get dimensions and duration
  const vid = document.createElement('video');
  const url = await blobToDataURL(file);
  vid.src = url;

  await new Promise(resolve => {
    vid.onloadedmetadata = () => resolve();
  });

  // Trim disabled in batch mode — each file processes from start to end
  const hasTrim = false;

  let args = [];

  // Special case: thumbnail uses its own seek logic
  if (state.op.current === 'thumbnail') {
    const t = parseFloat(document.getElementById('thumbTime').value) || 0;
    const thumbFmt = document.getElementById('thumbFmt').value;
    args.push('-ss', t.toFixed(3), '-i', inName, '-vframes', '1');
    if (thumbFmt === 'jpg') args.push('-q:v', '2');
    item.outputName = baseName + '.' + thumbFmt;
  }
  // Special case: gif uses filter_complex
  else if (state.op.current === 'gif') {
    const fps = document.getElementById('gifFps').value || 10;
    const w = document.getElementById('gifW').value || 480;
    if (hasTrim) args.push('-ss', '0', '-t', '0');  // no-op (hasTrim is always false here)
    args.push('-i', inName, '-filter_complex', `[0:v]fps=${fps},scale=${w}:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
    item.outputName = baseName + '.gif';
  }
  // Standard operations with input seeking
  else {
    if (hasTrim) args.push('-ss', '0');
    args.push('-i', inName);
    if (hasTrim) args.push('-t', '0');

    // Build operation-specific arguments
    buildOperationArgs(args, vid, inputFileExt);
  }

  // Add output filename
  args.push(outName);

  // Execute ffmpeg
  addLog(`  Processing ${file.name}…`, 'log');
  try {
    const res = await getFF().exec(args);
    if (res !== 0) throw new Error(`ffmpeg exited with code ${res}`);
  } catch (err) {
    throw new Error(`FFmpeg error: ${err.message}`);
  }

  // Read output
  const data = await getFF().readFile(outName);
  item.output = new Blob([data.buffer], { type: 'video/' + outExt });

  // Cleanup input and output files from virtual filesystem
  try { await getFF().deleteFile(inName); } catch (_) {}
  try { await getFF().deleteFile(outName); } catch (_) {}

  // Update batch outputs display in Output section
  updateBatchOutputsDisplay();
}

// Display completed batch outputs in the Output section.
export function updateBatchOutputsDisplay() {
  const completed = state.batch.queue.filter(item => item.status === 'done');
  const wrap = document.getElementById('batchOutputsWrap');
  const outContent = document.getElementById('outContent');
  const outEmpty = document.getElementById('outEmpty');
  const count = document.getElementById('batchCompleteCount');
  const selectEl = document.getElementById('batchOutputSelect');
  const downloadAllBtn = document.getElementById('downloadAllZipBtn');

  if (!wrap || !downloadAllBtn) {
    return;
  }

  count.textContent = completed.length;

  if (completed.length === 0) {
    wrap.classList.add('hidden');
    return;
  }

  // Show batch outputs in the output section
  wrap.classList.remove('hidden');
  outContent.classList.remove('hidden');
  outEmpty.classList.add('hidden');

  // Update dropdown, preserving current selection if still valid
  const prevValue = selectEl.value;
  selectEl.innerHTML = '<option value="">-- Select file to preview --</option>' +
    completed.map((item) => {
      const batchIdx = state.batch.queue.indexOf(item);
      const sizeMB = item.output.size / 1024 / 1024;
      return `<option value="${batchIdx}">${item.file.name} → ${item.outputName} (${sizeMB.toFixed(2)}MB)</option>`;
    }).join('');

  // Restore previous selection, or auto-select the first completed file
  const validValues = completed.map(item => String(state.batch.queue.indexOf(item)));
  if (prevValue && validValues.includes(prevValue)) {
    selectEl.value = prevValue;
  } else {
    const firstIdx = state.batch.queue.indexOf(completed[0]);
    selectEl.value = String(firstIdx);
    selectBatchOutput(firstIdx);
  }
}

export function selectBatchOutput(batchIdx) {
  if (batchIdx == null || batchIdx === '') return;
  const item = state.batch.queue[parseInt(batchIdx)];
  if (!item || !item.output) return;

  const infoDiv = document.getElementById('batchSelectedFileInfo');
  const sizeMB = item.output.size / 1024 / 1024;

  // Preview the selected file in the main output player
  const outVideo = document.getElementById('outVideo');
  const outImg = document.getElementById('outImg');
  const outAudioWrap = document.getElementById('outAudioWrap');
  const outAudio = document.getElementById('outAudio');
  const url = URL.createObjectURL(item.output);
  const name = (item.outputName || '').toLowerCase();

  // Reset players
  outVideo.classList.add('hidden');
  outImg.classList.add('hidden');
  outAudioWrap.classList.add('hidden');

  if (/\.(png|jpg|jpeg|webp|bmp)$/.test(name)) {
    outImg.src = url;
    outImg.classList.remove('hidden');
  } else if (/\.(mp3|wav|ogg|aac|m4a|flac)$/.test(name)) {
    outAudio.src = url;
    outAudioWrap.classList.remove('hidden');
  } else if (/\.gif$/.test(name)) {
    outImg.src = url;
    outImg.classList.remove('hidden');
  } else {
    outVideo.src = url;
    outVideo.classList.remove('hidden');
  }

  // Update meta line + main download button to point at selected file
  document.getElementById('outMeta').textContent = `${item.outputName} · ${sizeMB.toFixed(2)} MB`;
  const dlBtn = document.getElementById('dlBtn');
  dlBtn.onclick = () => downloadBatchFile(parseInt(batchIdx));

  infoDiv.innerHTML = `
    <strong>Input:</strong> ${item.file.name}<br>
    <strong>Output:</strong> ${item.outputName}<br>
    <strong>Size:</strong> ${sizeMB.toFixed(2)}MB<br>
    <strong>Status:</strong> <span style="color:var(--success);">✓ Complete</span>
  `;
}

export async function downloadBatchAllAsZip() {
  const completed = state.batch.queue.filter(item => item.status === 'done');

  if (completed.length === 0) {
    addLog('No completed files to download', 'warn');
    return;
  }

  // Check if JSZip is available
  if (typeof JSZip === 'undefined') {
    addLog('JSZip library not loaded - cannot create ZIP. Downloading individual files instead.', 'warn');
    // Fall back to individual downloads
    for (const item of completed) {
      const a = document.createElement('a');
      a.href = await blobToDataURL(item.output);
      a.download = item.outputName || 'output.mp4';
      a.click();
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between downloads
    }
    return;
  }

  addLog('Creating ZIP archive…', 'ok');
  const zip = new JSZip();

  try {
    completed.forEach(item => {
      zip.file(item.outputName, item.output);
    });

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `batch_outputs_${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    addLog(`Downloaded all ${completed.length} files as ZIP`, 'ok');
  } catch (err) {
    addLog(`Error creating ZIP: ${err.message}`, 'error');
  }
}
