'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildFfmpegArgs } = require('./lib/ffmpeg');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MEDIA = path.join(ROOT, 'media');
const DATA = path.join(ROOT, 'data');
const TMP = path.join(DATA, 'tmp');
const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

for (const d of [MEDIA, DATA, TMP]) fs.mkdirSync(d, { recursive: true });

const DEFAULTS = {
  settings: {
    rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    streamKey: '',
    zoomLink: '',
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2500,
    preset: 'veryfast',
  },
  scene: { background: '#101014', layers: [] },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

const settingsPath = path.join(DATA, 'settings.json');
const scenePath = path.join(DATA, 'scene.json');

function getSettings() {
  return { ...DEFAULTS.settings, ...readJson(settingsPath, DEFAULTS.settings) };
}
function getScene() {
  return { ...DEFAULTS.scene, ...readJson(scenePath, DEFAULTS.scene) };
}

/* ------------------------------------------------------------------ */
/* Stream manager                                                      */
/* ------------------------------------------------------------------ */

const stream = {
  proc: null,
  startedAt: null,
  error: null,
  log: [],
};

function pushLog(line) {
  String(line)
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((l) => {
      stream.log.push(l);
    });
  if (stream.log.length > 600) stream.log.splice(0, stream.log.length - 600);
}

function streamStatus() {
  return {
    running: !!stream.proc,
    startedAt: stream.startedAt,
    pid: stream.proc ? stream.proc.pid : null,
    error: stream.error,
    log: stream.log.slice(-120),
  };
}

function buildRtmp(settings) {
  const base = String(settings.rtmpUrl || '').trim().replace(/\/+$/, '');
  const key = String(settings.streamKey || '').trim().replace(/^\/+/, '');
  if (!base || !key) throw new Error('RTMP URL and stream key are required');
  return `${base}/${key}`;
}

function startStream() {
  if (stream.proc) throw new Error('Stream is already running');
  const settings = getSettings();
  const scene = getScene();
  const rtmp = buildRtmp(settings);

  const { args, warnings, layerCount } = buildFfmpegArgs({
    settings,
    scene,
    rtmp,
    mediaDir: MEDIA,
    ffprobePath: FFPROBE,
    textDir: TMP,
  });

  stream.error = null;
  stream.log = [];
  pushLog(`ffmpeg ${args.join(' ')}`);
  warnings.forEach((w) => pushLog(`warning: ${w}`));
  pushLog(`scene: ${layerCount} layer(s) -> ${settings.width}x${settings.height}@${settings.fps}`);

  const proc = spawn(FFMPEG, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  stream.proc = proc;
  stream.startedAt = Date.now();

  proc.stderr.on('data', (d) => pushLog(d.toString()));
  proc.on('error', (e) => {
    stream.error = e.message;
    pushLog(`spawn error: ${e.message}`);
    stream.proc = null;
    stream.startedAt = null;
  });
  proc.on('exit', (code, signal) => {
    pushLog(`ffmpeg exited (code=${code}, signal=${signal})`);
    if (code && code !== 0) stream.error = `ffmpeg exited with code ${code}`;
    stream.proc = null;
    stream.startedAt = null;
  });

  return streamStatus();
}

function stopStream() {
  const proc = stream.proc;
  if (!proc) return streamStatus();
  try {
    proc.stdin.write('q');
  } catch (_) {}
  setTimeout(() => {
    if (stream.proc) {
      try {
        proc.kill();
      } catch (_) {}
    }
  }, 2500);
  return streamStatus();
}

async function restartStream() {
  if (stream.proc) {
    stopStream();
    for (let i = 0; i < 40 && stream.proc; i++) await new Promise((r) => setTimeout(r, 150));
  }
  return startStream();
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': type,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function safeName(name) {
  return path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 160);
}

function listMedia() {
  try {
    return fs
      .readdirSync(MEDIA)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const st = fs.statSync(path.join(MEDIA, f));
        const ext = path.extname(f).toLowerCase();
        return {
          name: f,
          src: `media/${f}`,
          size: st.size,
          mtime: st.mtimeMs,
          type: /\.(png|jpe?g|gif|webp|svg)$/i.test(ext)
            ? 'image'
            : /\.(mp4|webm|mov|mkv)$/i.test(ext)
            ? 'video'
            : 'other',
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // Allow the GitHub Pages copy of the UI (https://<user>.github.io/...) to
  // call this local server, including Chrome's private-network preflight.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        settings: getSettings(),
        scene: getScene(),
        media: listMedia(),
        stream: streamStatus(),
        root: ROOT,
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const merged = { ...getSettings(), ...body };
      writeJson(settingsPath, merged);
      return sendJson(res, 200, { ok: true, settings: merged });
    }

    if (p === '/api/scene' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const merged = { background: '#101014', layers: [], ...body };
      writeJson(scenePath, merged);
      return sendJson(res, 200, { ok: true, scene: merged });
    }

    if (p === '/api/media' && req.method === 'GET') {
      return sendJson(res, 200, { media: listMedia() });
    }

    if (p === '/api/media' && req.method === 'PUT') {
      const name = safeName(url.searchParams.get('name') || 'file');
      if (!name) return sendJson(res, 400, { error: 'bad name' });
      let target = path.join(MEDIA, name);
      if (fs.existsSync(target)) {
        target = path.join(MEDIA, `${Date.now()}-${name}`);
      }
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(target);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      return sendJson(res, 200, { ok: true, name: path.basename(target), src: `media/${path.basename(target)}`, media: listMedia() });
    }

    if (p === '/api/media' && req.method === 'DELETE') {
      const name = safeName(url.searchParams.get('name'));
      const target = path.join(MEDIA, name);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return sendJson(res, 200, { ok: true, media: listMedia() });
    }

    if (p === '/api/stream/start' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, stream: startStream() });
    }
    if (p === '/api/stream/stop' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, stream: stopStream() });
    }
    if (p === '/api/stream/restart' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, stream: await restartStream() });
    }
    if (p === '/api/stream/status' && req.method === 'GET') {
      return sendJson(res, 200, streamStatus());
    }

    if (p === '/api/ffmpeg/version' && req.method === 'GET') {
      return new Promise((resolve) => {
        const proc = spawn(FFMPEG, ['-version'], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.on('error', (e) => {
          sendJson(res, 500, { error: e.message });
          resolve();
        });
        proc.on('exit', () => {
          sendJson(res, 200, { version: out.split('\n')[0] || 'unknown' });
          resolve();
        });
      });
    }

    // static
    if (p === '/' || p === '/index.html') {
      return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    }
    if (p.startsWith('/media/')) {
      return serveFile(req, res, path.join(MEDIA, safeName(decodeURIComponent(p.slice(7)))));
    }
    const file = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return serveFile(req, res, file);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is the studio already running?\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Cloud OBS Studio  ->  ${url}\n  media: ${MEDIA}\n`);
  if (process.platform === 'win32' && process.env.NO_OPEN !== '1') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

process.on('SIGINT', () => {
  stopStream();
  setTimeout(() => process.exit(0), 500);
});
