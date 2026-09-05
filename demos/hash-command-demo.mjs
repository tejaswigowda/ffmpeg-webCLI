#!/usr/bin/env node
// Agent-orchestration demo for ffmpeg-webCLI's hash-JSON command grammar.
//
// Launches headless Chromium, navigates to the tool with a `#cmd=` hash set,
// injects a local video file straight into the page's file input (agent disk
// -> browser memory, never a URL, never a network upload), lets the app
// auto-run the command once the file is present, then reads the produced
// output back out of the page (as the data: URL the app already renders it
// to) and verifies it with ffprobe. This proves the full generate(by hand for
// this MVP) -> validate -> execute -> verify path end to end, headlessly.
//
// Usage:
//   cd demos && npm install         (once; installs the `playwright` package)
//   node hash-command-demo.mjs [/path/to/video.mp4]   (defaults to demos/input.mp4)

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8934;
const INPUT_VIDEO = process.argv[2] || path.join(__dirname, 'input.mp4');
const OUT_DIR = path.join(__dirname, 'out');
const OUT_FILE = path.join(OUT_DIR, 'trim-demo-output.mp4');

// The command JSON. Hand-written for this MVP demo — a small model emitting
// this same shape from a natural-language goal ("trim seconds 5 to 8") is the
// stretch goal, not required to prove the mechanism.
const command = { op: 'trim', args: { start: 5, end: 8 } };

function log(msg) { console.log(`[demo] ${msg}`); }

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch (_) { /* server not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  if (!fs.existsSync(INPUT_VIDEO)) throw new Error(`input video not found: ${INPUT_VIDEO}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('Starting local server (sets the COOP/COEP headers SharedArrayBuffer needs)…');
  const server = spawn(process.execPath, ['server.js', String(PORT)], { cwd: REPO_ROOT, stdio: 'pipe' });
  server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  let browser;
  try {
    await waitForServer(`http://localhost:${PORT}/`);

    log('Launching headless Chromium…');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.log('[page:error]', msg.text()); });
    page.on('pageerror', err => console.log('[page:error]', err.message));

    // Zero-egress check: record every outgoing request during the whole run so
    // we can assert afterwards that nothing carries the file off-device — only
    // our own localhost server and the two CDN asset hosts should be contacted,
    // and none of it should be a POST (setInputFiles never touches the network).
    const requests = [];
    page.on('request', req => requests.push({ url: req.url(), method: req.method() }));

    const hash = '#cmd=' + encodeURIComponent(JSON.stringify(command));
    const url = `http://localhost:${PORT}/${hash}`;
    log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Recipe-link path: no file yet, command should just preload into the UI.
    const banner = await page.textContent('#hashCmdBanner');
    log(`Banner after load (no file yet): "${banner}"`);
    if (!banner || !banner.includes('trim')) {
      throw new Error('expected the recipe banner to preload the trim command before a file is added');
    }

    log(`Injecting local file: ${INPUT_VIDEO}`);
    await page.setInputFiles('#fileInput', INPUT_VIDEO);

    log('Waiting for the app to auto-run the hash command (file + valid command present)…');
    await page.waitForFunction(
      () => ['done', 'error'].includes(document.body.dataset.hashCmdStatus),
      undefined,
      { timeout: 120_000 }
    );

    const status = await page.evaluate(() => document.body.dataset.hashCmdStatus);
    if (status !== 'done') {
      const err = await page.evaluate(() => document.body.dataset.hashCmdError);
      throw new Error(`hash command failed: ${err}`);
    }
    log('Hash command completed — reading output back out of the page…');

    // renderOutput() sets <video id="outVideo">.src to a data: URL (not blob:),
    // so we can pull the produced bytes straight out of the page — no download
    // interception needed.
    const dataUrl = await page.$eval('#outVideo', el => el.src);
    if (!dataUrl.startsWith('data:')) throw new Error('output <video> src is not a data: URL');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    fs.writeFileSync(OUT_FILE, Buffer.from(base64, 'base64'));
    log(`Wrote ${OUT_FILE} (${fs.statSync(OUT_FILE).size} bytes)`);

    log('Checking zero-egress (no request left localhost + the two known asset CDNs, no POSTs)…');
    // blob:/data: URLs never leave the browser process (no socket involved) —
    // that's exactly why the app uses an object URL for the local preview and
    // a data: URL for the output; they are not network egress and are excluded.
    const allowedHosts = ['localhost', '127.0.0.1', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
    const offenders = requests.filter(r => {
      if (r.url.startsWith('blob:') || r.url.startsWith('data:')) return false;
      const host = new URL(r.url).hostname;
      return !allowedHosts.includes(host) || r.method === 'POST';
    });
    if (offenders.length) {
      throw new Error('zero-egress violated: ' + JSON.stringify(offenders.slice(0, 5)));
    }
    log(`${requests.length} requests observed, all to localhost/known asset CDNs, none POST — zero-egress holds.`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  log('Verifying output with ffprobe…');
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'default=noprint_wrappers=1', OUT_FILE,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  console.log(probe.stdout.trim());

  const durMatch = probe.stdout.match(/duration=([\d.]+)/);
  const duration = durMatch ? parseFloat(durMatch[1]) : NaN;
  const expected = command.args.end - command.args.start;
  if (!(Math.abs(duration - expected) < 0.5)) {
    throw new Error(`output duration ${duration}s does not match expected ~${expected}s`);
  }
  if (!/codec_type=video/.test(probe.stdout)) throw new Error('output has no video stream');

  log(`Output duration ${duration.toFixed(2)}s \u2248 expected ${expected}s`);
  log('End-to-end hash-command demo PASSED');
}

main().catch(err => {
  console.error('[demo] FAILED:', (err && err.message) || err);
  process.exit(1);
});
