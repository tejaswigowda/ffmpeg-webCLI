#!/usr/bin/env node
/**
 * Static file server for the docs/ folder with a server-side ffmpeg API.
 *
 * Static serving: sets COOP/COEP headers for SharedArrayBuffer (ffmpeg.wasm).
 *
 * API endpoints (used when the browser switches to "Server" engine mode):
 *   GET  /api/status          — check if native ffmpeg is in PATH
 *   POST /api/upload?session=&name=  — upload a file into a temp session dir
 *   POST /api/exec            — run native ffmpeg { session, args }; returns output binary
 *   POST /api/transcribe      — proxy audio to OpenAI Whisper API (header: X-OpenAI-Key)
 *
 * Usage:  node server.js [port]   (default: 5500)
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2] || '5500', 10);
const ROOT = path.join(__dirname, 'docs');

const MIME = {
  '.html' : 'text/html; charset=utf-8',
  '.js'   : 'application/javascript; charset=utf-8',
  '.mjs'  : 'application/javascript; charset=utf-8',
  '.css'  : 'text/css; charset=utf-8',
  '.wasm' : 'application/wasm',
  '.json' : 'application/json; charset=utf-8',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.gif'  : 'image/gif',
  '.svg'  : 'image/svg+xml',
  '.ico'  : 'image/x-icon',
  '.mp4'  : 'video/mp4',
  '.webm' : 'video/webm',
  '.mp3'  : 'audio/mpeg',
  '.wav'  : 'audio/wav',
};

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// ── Session store for server-side ffmpeg ─────────────────────────────────────
// Each exec call gets its own short-lived temp dir; cleaned up after the
// response is streamed or after a 30-minute TTL.
const sessions = new Map(); // id → { dir, files: Set<string>, created: number }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created > 30 * 60 * 1000) dropSession(id);
  }
}, 5 * 60 * 1000);

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
  sessions.delete(id);
}

function getOrCreate(id) {
  if (sessions.has(id)) return sessions.get(id);
  const dir = path.join(os.tmpdir(), `ffwc-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const s = { dir, files: new Set(), created: Date.now() };
  sessions.set(id, s);
  return s;
}

// ── API handler ───────────────────────────────────────────────────────────────
function apiHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function handleAPI(urlPath, q, req, res) {
  apiHeaders(res);

  // ── GET /api/status ───────────────────────────────────────────────────────
  if (urlPath === '/api/status' && req.method === 'GET') {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ available: false, reason: 'ffmpeg not found in PATH' }));
    });
    p.on('close', code => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ available: code === 0 }));
    });
    return;
  }

  // ── POST /api/upload?session=&name= ───────────────────────────────────────
  if (urlPath === '/api/upload' && req.method === 'POST') {
    const session  = q.get('session');
    const fileName = q.get('name');
    if (!session || !fileName) { res.writeHead(400); res.end('Missing session or name'); return; }

    const safeName = path.basename(fileName); // prevent path traversal
    const sess     = getOrCreate(session);
    const filePath = path.join(sess.dir, safeName);

    const ws = fs.createWriteStream(filePath);
    req.pipe(ws);
    ws.on('finish', () => {
      sess.files.add(safeName);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    ws.on('error', err => { res.writeHead(500); res.end(err.message); });
    return;
  }

  // ── POST /api/exec ────────────────────────────────────────────────────────
  // Body: { session: string, args: string[] }
  // Returns: binary output file on success; JSON error on failure.
  if (urlPath === '/api/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
      const { session, args } = parsed;
      if (!session || !Array.isArray(args) || args.length === 0) {
        res.writeHead(400); res.end('Invalid body'); return;
      }

      const sess = sessions.get(session);
      if (!sess) { res.writeHead(404); res.end('Session not found'); return; }

      // Resolve uploaded filenames to full paths — also handles filenames
      // embedded inside filter strings like -vf "subtitles=subs.srt".
      const resolve = arg => {
        if (typeof arg !== 'string') return String(arg);
        let r = arg;
        for (const f of sess.files) {
          const full = path.join(sess.dir, f).replace(/\\/g, '/');
          const esc  = f.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
          // Replace bare filename only (not one already preceded by / or \)
          r = r.replace(new RegExp('(?<![/\\\\])' + esc, 'g'), full);
        }
        return r;
      };

      const rArgs = args.map(resolve);
      // Last arg is always the output filename — always put it in the session dir
      const outBase = path.basename(rArgs[rArgs.length - 1]);
      const outPath = path.join(sess.dir, outBase);
      rArgs[rArgs.length - 1] = outPath;

      const proc = spawn('ffmpeg', ['-y', ...rArgs]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d; });

      proc.on('error', err => {
        dropSession(session);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot start ffmpeg: ' + err.message }));
      });

      proc.on('close', code => {
        if (code !== 0) {
          dropSession(session);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `ffmpeg exited ${code}`, stderr: stderr.slice(-3000) }));
          return;
        }
        fs.stat(outPath, (err, st) => {
          if (err) { dropSession(session); res.writeHead(500); res.end('Output file not created'); return; }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          res.writeHead(200);
          const stream = fs.createReadStream(outPath);
          stream.pipe(res);
          stream.on('close', () => dropSession(session));
        });
      });
    });
    return;
  }

  // ── POST /api/transcribe ─────────────────────────────────────────────────
  // Proxies a WAV audio body to the OpenAI Whisper API and returns SRT text.
  // Header X-OpenAI-Key must carry the API key (never logged).
  if (urlPath === '/api/transcribe' && req.method === 'POST') {
    const apiKey = req.headers['x-openai-key'];
    if (!apiKey) { res.writeHead(400); res.end('Missing X-OpenAI-Key header'); return; }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const audioData = Buffer.concat(chunks);
      const boundary  = 'ffwcbnd' + Date.now();

      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nsrt\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      );
      const tail      = Buffer.from(`\r\n--${boundary}--\r\n`);
      const multipart = Buffer.concat([head, audioData, tail]);

      const opts = {
        hostname: 'api.openai.com',
        path:     '/v1/audio/transcriptions',
        method:   'POST',
        headers:  {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  `multipart/form-data; boundary=${boundary}`,
          'Content-Length': multipart.length,
        },
      };

      const oReq = https.request(opts, oRes => {
        let data = '';
        oRes.on('data', c => { data += c; });
        oRes.on('end', () => {
          res.writeHead(oRes.statusCode, { 'Content-Type': 'text/plain' });
          res.end(data);
        });
      });
      oReq.on('error', err => { res.writeHead(502); res.end('OpenAI request failed: ' + err.message); });
      oReq.write(multipart);
      oReq.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ── Static file server ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Route API requests
  if (urlPath.startsWith('/api/')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    return handleAPI(urlPath, url.searchParams, req, res);
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  // Security: prevent path traversal outside docs/
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // Headers required for SharedArrayBuffer / cross-origin isolation
    res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const baseName = path.basename(filePath);
    if (baseName === 'service-worker.js' || baseName === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (baseName === 'index.html') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    res.setHeader('Content-Type',   mime(filePath));
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving docs/ at http://127.0.0.1:${PORT}`);
  console.log('COOP + COEP headers active — SharedArrayBuffer enabled');
  console.log('Server ffmpeg API: GET /api/status  POST /api/upload  POST /api/exec  POST /api/transcribe');
  console.log('Press Ctrl+C to stop.');
});
