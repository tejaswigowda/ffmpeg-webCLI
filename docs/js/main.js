// js/main.js
//
// Application entry point. Imports every module (which causes their
// top-level side-effects — drag/drop wiring, crop pointer handlers,
// visibility listeners, SW registration — to run), performs the
// first-paint initialisation, and exposes the inline-onclick handlers
// on `window` so the HTML's `onclick="foo()"` attributes resolve.
//
// The inline-handler bridge is unavoidable as long as we keep the
// `onclick=` attributes in the HTML (which we do, per the user's
// preference): ES module scope is private, so functions defined in
// modules are not callable from inline attributes unless explicitly
// attached to `window`.

// ── Side-effect imports (each module wires its own listeners) ───────────
import './ui.js';          // wake-lock visibility listener
import './crop.js';        // crop pointer handlers, video loadeddata/seeked
import './files.js';       // drag & drop wiring
import './pwa.js';         // service-worker registration

// ── Explicit imports for init calls + window bridge ─────────────────────
import { updateTrim } from './trim.js';
import { initRawExamples } from './raw.js';
import { syncProcessBtn } from './ui.js';

// engine.js
import {
  loadFFmpeg, setEngine, setWhisperSource, saveWhisperApiKey,
} from './engine.js';

// files.js
import {
  handleFile, handleFileInput, clearInput,
  onSubtitleFileChange, onOverlayFileChange, onMixAudioFileChange,
  onConcatFileChange, onSxsFileChange, onPipFileChange, onRawInput2Change,
} from './files.js';

// operations.js
import { setOp, updateSizeEstimate } from './operations.js';
// `updateSizeEstimate` actually lives in ui.js; re-exported through
// operations.js's import surface — pull directly from ui.js instead.
import { updateSizeEstimate as _updateSizeEstimate } from './ui.js';

// process.js
import { processVideo, runProcess, download } from './process.js';

// batch.js
import {
  toggleBatchMode, handleBatchFiles, clearBatchQueue,
  removeBatchFile, downloadBatchFile, downloadAllBatchFiles,
  downloadBatchAllAsZip, selectBatchOutput,
  loadFirstBatchFileForStack, updateBatchQueueUI,
  updateBatchOutputsDisplay,
} from './batch.js';

// stack.js
import {
  setMode, addToStack, removeStackItem, moveStackItem,
  runProcessStack, refreshStackControls, renderStack,
  updateStackPreview,
} from './stack.js';

// crop.js (resetCropSelection is called from HTML)
import { resetCropSelection } from './crop.js';

// raw.js (updateRawPreview is called from HTML oninput)
import { updateRawPreview } from './raw.js';

// autocaption.js
import {
  confirmAutoCaptionTranscript, clearAutoCaptionTranscript,
  updateAutoCaptionTranscript, updateAutoCaptionInfo,
} from './autocaption.js';

// ui.js (clearLog)
import { clearLog } from './ui.js';

// runBatch is called from process.js's processVideo(), but also exported
// on window for completeness (legacy inline handlers may reference it).
import { runBatch } from './batch.js';

// ── Expose all functions to window for inline event handlers ────────────
// (Required for inline onclick handlers since this is a <script type="module">)
Object.assign(window, {
  // engine
  loadFFmpeg, setEngine, setWhisperSource, saveWhisperApiKey,
  // files
  handleFile, handleFileInput, clearInput,
  onSubtitleFileChange, onOverlayFileChange, onMixAudioFileChange,
  onConcatFileChange, onSxsFileChange, onPipFileChange, onRawInput2Change,
  // operations
  setOp, updateSizeEstimate: _updateSizeEstimate, updateRawPreview,
  resetCropSelection,
  // process
  processVideo, runProcess, download,
  // batch
  toggleBatchMode, handleBatchFiles, clearBatchQueue,
  removeBatchFile, downloadBatchFile, downloadAllBatchFiles,
  downloadBatchAllAsZip, selectBatchOutput,
  loadFirstBatchFileForStack, updateBatchQueueUI, updateBatchOutputsDisplay,
  runBatch,
  // stack
  setMode, addToStack, removeStackItem, moveStackItem,
  runProcessStack, refreshStackControls, renderStack, updateStackPreview,
  // autocaption
  confirmAutoCaptionTranscript, clearAutoCaptionTranscript,
  updateAutoCaptionTranscript, updateAutoCaptionInfo,
  // ui
  clearLog, updateTrim, syncProcessBtn,
});

// ── First-paint initialisation ──────────────────────────────────────────
updateTrim();
initRawExamples();
