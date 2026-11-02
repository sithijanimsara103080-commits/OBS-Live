'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const stage = $('stage');
const stagebox = document.querySelector('.stagebox');

const S = {
  settings: { width: 1280, height: 720, fps: 30, bitrate: 2500, preset: 'veryfast', rtmpUrl: '', streamKey: '', zoomLink: '' },
  scene: { background: '#101014', layers: [] },
  media: [],
  stream: { running: false, startedAt: null, log: [] },
  selectedId: null,
  scale: 1,
  els: new Map(),
  dirty: false,
};

const uid = () => Math.random().toString(36).slice(2, 9);

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */

// When this page is opened from the local server (http://127.0.0.1:3000)
// API_BASE is empty and everything is same-origin. When the same page is
// opened from GitHub Pages, it talks to the studio server running on the PC.
let API_BASE = '';

const LOCAL_CANDIDATES = ['', 'http://127.0.0.1:3000', 'http://localhost:3000'];

function apiUrl(path) { return API_BASE + path; }

function mediaUrl(src) {
  if (!src) return '';
  const s = String(src);
  if (/^[a-z]+:/i.test(s)) return s;
  return apiUrl('/' + s.replace(/^\/+/, ''));
}

async function detectServer() {
  for (const base of LOCAL_CANDIDATES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(base + '/api/state', { signal: ctrl.signal });
      clearTimeout(t);
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('application/json')) {
        API_BASE = base;
        return true;
      }
    } catch (_) {}
  }
  return false;
}

function setOffline(off) {
  $('banner').style.display = off ? 'flex' : 'none';
  for (const id of ['btnStart', 'btnStop', 'btnApply', 'btnSaveSettings', 'drop', 'btnPickImage', 'btnPickVideo', 'btnAddText', 'btnAddColor', 'btnAddScreen']) {
    const el = $(id);
    if (el) el.classList.toggle('disabled', off);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastT;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = 'toast'), 3800);
}

/* ------------------------------------------------------------------ */
/* layout                                                             */
/* ------------------------------------------------------------------ */

function W() { return Math.round(S.settings.width) || 1280; }
function H() { return Math.round(S.settings.height) || 720; }

function layoutStage() {
  const pad = 36;
  const availW = Math.max(200, stagebox.clientWidth - pad);
  const availH = Math.max(120, stagebox.clientHeight - pad);
  const ar = W() / H();
  let w = availW;
  let h = w / ar;
  if (h > availH) { h = availH; w = h * ar; }
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  canvas.style.width = `${W()}px`;
  canvas.style.height = `${H()}px`;
  S.scale = w / W();
  canvas.style.transform = `scale(${S.scale})`;
  stage.style.background = S.scene.background || '#000';
}

window.addEventListener('resize', () => { layoutStage(); });

/* ------------------------------------------------------------------ */
/* canvas rendering                                                   */
/* ------------------------------------------------------------------ */

function baseName(src) {
  return String(src || '').split(/[\\/]/).pop();
}

function layerLabel(l) {
  if (l.type === 'text') return `T: ${(l.text || '').slice(0, 18) || 'text'}`;
  if (l.type === 'color') return `Colour ${l.color}`;
  if (l.type === 'screen') return l.window ? `Win: ${l.window}` : 'Screen';
  return `${l.type === 'video' ? 'Vid' : 'Img'}: ${baseName(l.src)}`;
}

function positionEl(el, l) {
  el.style.left = `${l.x}px`;
  el.style.top = `${l.y}px`;
  el.style.width = `${l.w}px`;
  el.style.height = `${l.h}px`;
  el.style.opacity = l.opacity == null ? 1 : Math.max(0, Math.min(1, l.opacity / 100));
}

function makeLayerEl(l) {
  const d = document.createElement('div');
  d.className = 'layer' + (l.visible === false ? ' hidden' : '') + (l.id === S.selectedId ? ' selected' : '');
  d.dataset.id = l.id;
  positionEl(d, l);

  if (l.type === 'image') {
    const img = document.createElement('img');
    img.className = 'media';
    img.src = mediaUrl(l.src);
    img.alt = '';
    d.appendChild(img);
  } else if (l.type === 'video') {
    const v = document.createElement('video');
    v.className = 'media';
    v.src = mediaUrl(l.src);
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    d.appendChild(v);
    v.play().catch(() => {});
  } else if (l.type === 'text') {
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = l.text || '';
    t.style.fontSize = `${l.fontSize || 48}px`;
    t.style.color = l.fontColor || '#ffffff';
    d.appendChild(t);
  } else if (l.type === 'color') {
    d.style.background = l.color || '#000000';
  } else if (l.type === 'screen') {
    const p = document.createElement('div');
    p.className = 'screenph';
    p.textContent = l.window ? `Window: ${l.window}` : 'Full screen capture';
    d.appendChild(p);
  }

  const r = document.createElement('div');
  r.className = 'resize';
  d.appendChild(r);

  d.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('resize')) return;
    selectLayer(l.id);
    startDrag(e, l, d);
  });
  r.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    startResize(e, l, d);
  });
  return d;
}

function renderCanvas() {
  const frag = document.createDocumentFragment();
  S.els.clear();
  for (const l of S.scene.layers) {
    const el = makeLayerEl(l);
    S.els.set(l.id, el);
    frag.appendChild(el);
  }
  canvas.innerHTML = '';
  canvas.appendChild(frag);
  canvas.style.background = S.scene.background || '#000';
  $('stageEmpty').style.display = S.scene.layers.length ? 'none' : 'flex';
  renderLayerbar();
  renderInspector();
  $('layerCount').textContent = String(S.scene.layers.length);
  requestAnimationFrame(layoutStage);
}

function renderLayerbar() {
  const bar = $('layerbar');
  bar.innerHTML = '';
  if (!S.scene.layers.length) {
    bar.innerHTML = '<span style="color:var(--dim);font-size:12px">No layers yet</span>';
    return;
  }
  [...S.scene.layers].reverse().forEach((l) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (l.id === S.selectedId ? ' sel' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = l.visible !== false;
    cb.title = 'visible';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      l.visible = cb.checked;
      const el = S.els.get(l.id);
      if (el) el.classList.toggle('hidden', !cb.checked);
      saveScene();
    });
    chip.appendChild(cb);
    const label = document.createElement('span');
    label.textContent = layerLabel(l);
    chip.appendChild(label);
    chip.addEventListener('click', () => selectLayer(l.id));
    bar.appendChild(chip);
  });
}

function selectLayer(id) {
  S.selectedId = id;
  for (const [lid, el] of S.els) el.classList.toggle('selected', lid === id);
  renderLayerbar();
  renderInspector();
  requestAnimationFrame(layoutStage);
}

function renderInspector() {
  const box = $('inspector');
  const l = S.scene.layers.find((x) => x.id === S.selectedId);
  if (!l) {
    box.className = 'inspector';
    box.innerHTML = '';
    return;
  }
  box.className = 'inspector on';
  const typeOpts = { image: 'Image', video: 'Video', text: 'Text', color: 'Colour', screen: 'Screen' };

  box.innerHTML = `
    <div class="head">
      <b>${typeOpts[l.type] || l.type}</b>
      <span style="color:var(--dim);font-size:11px">${escapeHtml(layerLabel(l))}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm" data-act="back">&#8595; back</button>
      <button class="btn sm" data-act="front">&#8593; front</button>
      <button class="btn sm red" data-act="del">Delete</button>
    </div>
    <div class="row">
      <input type="number" data-f="x" placeholder="X" value="${Math.round(l.x)}">
      <input type="number" data-f="y" placeholder="Y" value="${Math.round(l.y)}">
      <input type="number" data-f="w" placeholder="W" value="${Math.round(l.w)}">
      <input type="number" data-f="h" placeholder="H" value="${Math.round(l.h)}">
      <input type="number" data-f="opacity" placeholder="%" min="0" max="100" value="${l.opacity == null ? 100 : l.opacity}">
    </div>
    <div class="row" style="margin-top:8px">
      ${l.type === 'text'
        ? `<input type="text" data-f="text" placeholder="Text" value="${escapeAttr(l.text || '')}">
           <input type="number" data-f="fontSize" placeholder="size" value="${l.fontSize || 48}" style="max-width:80px">
           <input type="color" data-f="fontColor" value="${l.fontColor || '#ffffff'}" style="max-width:46px;padding:2px">`
        : ''}
      ${l.type === 'color'
        ? `<input type="color" data-f="color" value="${l.color || '#000000'}" style="max-width:60px;padding:2px">`
        : ''}
      ${l.type === 'screen'
        ? `<input type="text" data-f="window" placeholder="window title (blank = full screen)" value="${escapeAttr(l.window || '')}">`
        : ''}
      ${l.type === 'video'
        ? `<input type="range" data-f="volume" min="0" max="100" value="${l.volume == null ? 100 : l.volume}" style="flex:2">
           <span style="align-self:center;color:var(--dim);font-size:11px">volume</span>
           <label style="align-self:center;font-size:11px;color:var(--dim)"><input type="checkbox" data-f="muted" ${l.muted ? 'checked' : ''}> mute</label>`
        : ''}
    </div>
  `;

  box.querySelectorAll('[data-f]').forEach((inp) => {
    const f = inp.dataset.f;
    const ev = inp.type === 'range' || inp.type === 'text' ? 'input' : 'change';
    inp.addEventListener(ev, () => {
      let v = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (['x', 'y', 'w', 'h', 'opacity', 'fontSize', 'volume'].includes(f)) v = Number(v);
      setLayerField(l, f, v);
    });
  });
  box.querySelector('[data-act=del]').addEventListener('click', () => removeLayer(l.id));
  box.querySelector('[data-act=front]').addEventListener('click', () => moveLayer(l.id, +1));
  box.querySelector('[data-act=back]').addEventListener('click', () => moveLayer(l.id, -1));
}

function setLayerField(l, f, v) {
  l[f] = v;
  const el = S.els.get(l.id);
  if (el) {
    if (['x', 'y', 'w', 'h'].includes(f)) positionEl(el, l);
    if (f === 'opacity') el.style.opacity = Math.max(0, Math.min(1, v / 100));
    if (f === 'text') { const t = el.querySelector('.txt'); if (t) t.textContent = v; }
    if (f === 'fontSize') { const t = el.querySelector('.txt'); if (t) t.style.fontSize = `${v}px`; }
    if (f === 'fontColor') { const t = el.querySelector('.txt'); if (t) t.style.color = v; }
    if (f === 'color') el.style.background = v;
    if (f === 'window') {
      const p = el.querySelector('.screenph');
      if (p) p.textContent = v ? `Window: ${v}` : 'Full screen capture';
    }
  }
  saveScene();
}

/* ------------------------------------------------------------------ */
/* drag / resize                                                      */
/* ------------------------------------------------------------------ */

function startDrag(e, l, el) {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const ox = l.x;
  const oy = l.y;
  const s = S.scale;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    l.x = Math.round(ox + (ev.clientX - sx) / s);
    l.y = Math.round(oy + (ev.clientY - sy) / s);
    positionEl(el, l);
    syncInspector();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    saveScene();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function startResize(e, l, el) {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const ow = l.w;
  const oh = l.h;
  const s = S.scale;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    l.w = Math.max(16, Math.round(ow + (ev.clientX - sx) / s));
    l.h = Math.max(16, Math.round(oh + (ev.clientY - sy) / s));
    positionEl(el, l);
    syncInspector();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    saveScene();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function syncInspector() {
  const l = S.scene.layers.find((x) => x.id === S.selectedId);
  if (!l) return;
  const box = $('inspector');
  ['x', 'y', 'w', 'h'].forEach((f) => {
    const inp = box.querySelector(`[data-f=${f}]`);
    if (inp && document.activeElement !== inp) inp.value = Math.round(l[f]);
  });
}

/* ------------------------------------------------------------------ */
/* layers                                                             */
/* ------------------------------------------------------------------ */

function addLayer(partial) {
  const l = {
    id: uid(), visible: true, opacity: 100,
    x: Math.round(W() * 0.15), y: Math.round(H() * 0.15),
    w: Math.round(W() * 0.7), h: Math.round(H() * 0.7),
    ...partial,
  };
  S.scene.layers.push(l);
  renderCanvas();
  selectLayer(l.id);
  saveScene();
  return l;
}

function removeLayer(id) {
  const i = S.scene.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  S.scene.layers.splice(i, 1);
  if (S.selectedId === id) S.selectedId = null;
  renderCanvas();
  saveScene();
}

function moveLayer(id, dir) {
  const i = S.scene.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.scene.layers.length) return;
  const [l] = S.scene.layers.splice(i, 1);
  S.scene.layers.splice(j, 0, l);
  renderCanvas();
  selectLayer(id);
  saveScene();
}

function fitSize(naturalW, naturalH) {
  const maxW = W() * 0.7;
  const maxH = H() * 0.7;
  const r = Math.min(maxW / naturalW, maxH / naturalH, 1);
  return { w: Math.round(naturalW * r), h: Math.round(naturalH * r) };
}

function centerPos(w, h) {
  return { x: Math.round((W() - w) / 2), y: Math.round((H() - h) / 2) };
}

async function addMediaLayer(src, type) {
  let size = { w: Math.round(W() * 0.5), h: Math.round(H() * 0.5) };
  try {
    if (type === 'image') {
      size = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(fitSize(img.naturalWidth || W(), img.naturalHeight || H()));
        img.onerror = reject;
        img.src = mediaUrl(src);
      });
    } else {
      size = await new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve(fitSize(v.videoWidth || W(), v.videoHeight || H()));
        v.onerror = () => resolve({ w: Math.round(W() * 0.6), h: Math.round(H() * 0.6) });
        v.src = mediaUrl(src);
        setTimeout(() => resolve({ w: Math.round(W() * 0.6), h: Math.round(H() * 0.6) }), 4000);
      });
    }
  } catch (_) {}
  const pos = centerPos(size.w, size.h);
  return addLayer({ type, src, x: pos.x, y: pos.y, w: size.w, h: size.h, volume: 100, muted: false });
}

/* ------------------------------------------------------------------ */
/* media library                                                      */
/* ------------------------------------------------------------------ */

function renderLib() {
  const lib = $('lib');
  lib.innerHTML = '';
  if (!S.media.length) {
    lib.innerHTML = '<span style="color:var(--dim);font-size:11px">empty</span>';
    return;
  }
  for (const m of S.media) {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.title = `${m.name} (${(m.size / 1048576).toFixed(1)} MB)`;
    if (m.type === 'image') {
      const i = document.createElement('img');
      i.src = mediaUrl(m.src);
      d.appendChild(i);
    } else if (m.type === 'video') {
      const v = document.createElement('video');
      v.src = mediaUrl(m.src);
      v.muted = true;
      v.preload = 'metadata';
      d.appendChild(v);
    } else {
      d.innerHTML = '<div style="padding:8px;font-size:10px;color:#888">file</div>';
    }
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = m.name;
    d.appendChild(nm);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.type;
    d.appendChild(tag);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api('DELETE', `/api/media?name=${encodeURIComponent(m.name)}`);
      S.media = (await api('GET', '/api/media')).media;
      renderLib();
    });
    d.appendChild(del);
    d.addEventListener('click', () => addMediaLayer(m.src, m.type === 'video' ? 'video' : 'image'));
    lib.appendChild(d);
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  for (const f of list) {
    const isVideo = f.type.startsWith('video');
    try {
      const res = await fetch(apiUrl(`/api/media?name=${encodeURIComponent(f.name)}`), { method: 'PUT', body: f });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'upload failed');
      S.media = j.media || S.media;
      await addMediaLayer(j.src, isVideo ? 'video' : 'image');
      toast(`Added ${f.name}`);
    } catch (e) {
      toast(`Upload failed: ${e.message}`, true);
    }
  }
  renderLib();
}

/* ------------------------------------------------------------------ */
/* save                                                               */
/* ------------------------------------------------------------------ */

let sceneT;
function saveScene() {
  clearTimeout(sceneT);
  S.dirty = true;
  sceneT = setTimeout(async () => {
    try {
      await api('POST', '/api/scene', S.scene);
      S.dirty = false;
    } catch (e) {
      toast('Could not save scene: ' + e.message, true);
    }
  }, 450);
}

function applySettingsToUi() {
  const s = S.settings;
  $('rtmpUrl').value = s.rtmpUrl || '';
  $('streamKey').value = s.streamKey || '';
  $('zoomLink').value = s.zoomLink || '';
  $('res').value = `${s.width}x${s.height}`;
  if (!$('res').value) {
    const o = document.createElement('option');
    o.value = `${s.width}x${s.height}`;
    o.textContent = `${s.width} x ${s.height}`;
    $('res').appendChild(o);
    $('res').value = o.value;
  }
  $('fps').value = String(s.fps || 30);
  if (!$('fps').value) $('fps').value = '30';
  $('bitrate').value = s.bitrate || 2500;
  $('preset').value = s.preset || 'veryfast';
  $('bg').value = S.scene.background || '#101014';
  $('layerCount').textContent = String(S.scene.layers.length);
}

function collectSettings() {
  const [w, h] = $('res').value.split('x').map(Number);
  return {
    rtmpUrl: $('rtmpUrl').value.trim(),
    streamKey: $('streamKey').value.trim(),
    zoomLink: $('zoomLink').value.trim(),
    width: w || 1280,
    height: h || 720,
    fps: Number($('fps').value) || 30,
    bitrate: Number($('bitrate').value) || 2500,
    preset: $('preset').value || 'veryfast',
  };
}

async function saveSettings(silent) {
  S.settings = collectSettings();
  const bg = $('bg').value.trim() || '#101014';
  S.scene.background = bg;
  try {
    const r = await api('POST', '/api/settings', S.settings);
    S.settings = r.settings;
    await api('POST', '/api/scene', S.scene);
    layoutStage();
    renderCanvas();
    if (!silent) toast('Settings saved');
    return true;
  } catch (e) {
    toast('Save failed: ' + e.message, true);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* stream                                                             */
/* ------------------------------------------------------------------ */

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function applyStreamStatus(st) {
  S.stream = st;
  const live = !!st.running;
  $('dot').className = 'dot' + (live ? ' live' : '');
  $('statusText').textContent = live ? 'LIVE' : 'OFFLINE';
  $('encState').textContent = live ? 'running' : st.error ? 'error' : 'stopped';
  $('encState').style.color = live ? 'var(--green)' : st.error ? 'var(--red)' : '';
  $('btnStart').disabled = live;
  $('btnStop').disabled = !live;
  $('btnApply').disabled = !live;

  const logEl = $('log');
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  logEl.textContent = (st.log || []).join('\n');
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function pollStream() {
  try {
    const st = await api('GET', '/api/stream/status');
    applyStreamStatus(st);
    $('uptime').textContent = st.running && st.startedAt ? fmtUptime(Date.now() - st.startedAt) : '—';
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

async function boot() {
  layoutStage();
  renderCanvas();
  cloudInit();

  const online = await detectServer();
  setOffline(!online);
  if (!online) {
    $('about').innerHTML =
      'Running from GitHub Pages. Start <code>studio\\start-studio.bat</code> on your PC for the full studio, ' +
      'or use the <b>Cloud</b> tab to run the stream on GitHub (PC can be off).';
    switchTab('cloud');
    return;
  }
  $('srcBadge').textContent = 'LOCAL';
  $('srcBadge').title = 'Connected to the studio server on this PC';

  const st = await api('GET', '/api/state');
  S.settings = st.settings;
  S.scene = st.scene;
  S.media = st.media || [];
  if (!Array.isArray(S.scene.layers)) S.scene.layers = [];

  S.scene.layers = S.scene.layers.map((l) => ({ id: l.id || uid(), visible: true, opacity: 100, ...l }));

  applySettingsToUi();
  layoutStage();
  renderCanvas();
  renderLib();
  applyStreamStatus(st.stream);
  $('about').innerHTML =
    `Root: <code>${escapeHtml(st.root || '')}</code><br>` +
    `Encoder: <code>ffmpeg</code> &middot; output: RTMP`;

  setInterval(pollStream, 2000);
  setInterval(() => {
    if (S.stream.running && S.stream.startedAt) {
      $('uptime').textContent = fmtUptime(Date.now() - S.stream.startedAt);
    }
  }, 1000);
}

/* tabs */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('active', x.id === `pane-${name}`));
  if (name === 'cloud') cloudRefresh(true);
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

/* sources */
$('drop').addEventListener('click', () => {
  $('fileInput').setAttribute('accept', 'image/*,video/*');
  $('fileInput').value = '';
  $('fileInput').click();
});
$('fileInput').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
['dragover', 'dragenter'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('drag'); })
);
$('drop').addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

$('btnPickImage').addEventListener('click', () => {
  $('fileInput').setAttribute('accept', 'image/*');
  $('fileInput').value = '';
  $('fileInput').click();
});
$('btnPickVideo').addEventListener('click', () => {
  $('fileInput').setAttribute('accept', 'video/*');
  $('fileInput').value = '';
  $('fileInput').click();
});
$('btnAddText').addEventListener('click', () => {
  addLayer({
    type: 'text', text: 'Your text here',
    fontColor: '#ffffff', fontSize: Math.round(H() / 9),
    x: Math.round(W() * 0.15), y: Math.round(H() * 0.4),
    w: Math.round(W() * 0.7), h: Math.round(H() * 0.2),
  });
});
$('btnAddColor').addEventListener('click', () => {
  addLayer({ type: 'color', color: '#1a1f2b', x: 0, y: 0, w: W(), h: H() });
});
$('btnAddScreen').addEventListener('click', () => {
  addLayer({ type: 'screen', window: '', x: 0, y: 0, w: W(), h: H() });
});

/* settings */
$('btnSaveSettings').addEventListener('click', () => saveSettings(false));
$('bg').addEventListener('change', () => {
  S.scene.background = $('bg').value.trim() || '#101014';
  layoutStage();
  renderCanvas();
  saveScene();
});

/* stream */
$('btnStart').addEventListener('click', async () => {
  const ok = await saveSettings(true);
  if (!ok) return;
  try {
    const r = await api('POST', '/api/stream/start');
    applyStreamStatus(r.stream);
    toast('Going live…');
  } catch (e) {
    toast('Start failed: ' + e.message, true);
  }
});

$('btnStop').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/stream/stop');
    applyStreamStatus(r.stream);
    toast('Stopping stream…');
  } catch (e) {
    toast('Stop failed: ' + e.message, true);
  }
});

$('btnApply').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/stream/restart');
    applyStreamStatus(r.stream);
    toast('Scene applied to the live encoder');
  } catch (e) {
    toast('Apply failed: ' + e.message, true);
  }
});

/* keyboard */
document.addEventListener('keydown', (e) => {
  const l = S.scene.layers.find((x) => x.id === S.selectedId);
  if (!l) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const step = e.shiftKey ? 10 : 1;
  let used = true;
  if (e.key === 'ArrowLeft') l.x -= step;
  else if (e.key === 'ArrowRight') l.x += step;
  else if (e.key === 'ArrowUp') l.y -= step;
  else if (e.key === 'ArrowDown') l.y += step;
  else if (e.key === 'Delete' || e.key === 'Backspace') { removeLayer(l.id); e.preventDefault(); return; }
  else used = false;
  if (used) {
    e.preventDefault();
    const el = S.els.get(l.id);
    if (el) positionEl(el, l);
    syncInspector();
    saveScene();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------------------------------------------ */
/* live embed                                                         */
/* ------------------------------------------------------------------ */

function ytEmbed(input) {
  const u = String(input || '').trim();
  if (!u) return '';
  let m = u.match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1&playsinline=1`;
  m = u.match(/(UC[A-Za-z0-9_-]{22})/);
  if (m) return `https://www.youtube.com/embed/live_stream?channel=${m[1]}&autoplay=1&mute=1`;
  m = u.match(/@([A-Za-z0-9._-]+)/);
  if (m) return `https://www.youtube.com/embed/live_stream?channel=@${encodeURIComponent(m[1])}&autoplay=1&mute=1`;
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return `https://www.youtube.com/embed/${u}?autoplay=1&mute=1&playsinline=1`;
  return '';
}

function ytApply(value) {
  const src = ytEmbed(value);
  if (!src) {
    toast('Could not read that YouTube link', true);
    return false;
  }
  $('ytPlayer').src = src;
  $('ytWrap').style.display = 'block';
  localStorage.setItem('yt_live', String(value || '').trim());
  return true;
}

function ytInit() {
  const saved = localStorage.getItem('yt_live') || '';
  $('ytUrl').value = saved;
  if (saved) ytApply(saved);
  $('ytLoad').addEventListener('click', () => ytApply($('ytUrl').value));
  $('ytOpen').addEventListener('click', () => {
    const v = String($('ytUrl').value || '').trim();
    if (!v) return toast('Paste a YouTube link first', true);
    const url = /^https?:\/\//i.test(v) ? v : `https://www.youtube.com/${v.startsWith('@') ? v + '/live' : v}`;
    window.open(url, '_blank', 'noopener');
  });
  $('ytUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') ytApply($('ytUrl').value); });
}

/* ------------------------------------------------------------------ */
/* cloud (GitHub Actions)                                             */
/* ------------------------------------------------------------------ */

const CLOUD = {
  repo: localStorage.getItem('gh_repo') || 'sithijanimsara103080-commits/OBS-Live',
  workflow: 'live.yml',
  token: localStorage.getItem('gh_token') || '',
  zoom: localStorage.getItem('gh_zoom') || '',
  hours: localStorage.getItem('gh_hours') || '5.5',
  run: null,
  timer: null,
};

function cloudHeaders() {
  const h = { Accept: 'application/vnd.github+json' };
  if (CLOUD.token) h.Authorization = `Bearer ${CLOUD.token}`;
  return h;
}

async function cloudFetch(path, opts) {
  const o = opts || {};
  const r = await fetch('https://api.github.com' + path, {
    ...o,
    headers: { ...cloudHeaders(), ...(o.headers || {}) },
  });
  const txt = await r.text();
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch { j = {}; }
  if (!r.ok) throw new Error(j.message || `GitHub HTTP ${r.status}`);
  return j;
}

function cloudStatusLine(run) {
  if (!run) return '<span class="mut">No runs yet.</span>';
  const st = run.status || '';
  const cc = run.conclusion || '';
  const when = run.created_at ? new Date(run.created_at).toLocaleString() : '';
  const cls = cc === 'success' ? 'ok' : (cc === 'failure' || cc === 'cancelled') ? 'bad' : 'run';
  return `<span class="pill ${cls}">${cc || st}</span> <span class="mut">#${run.run_number} &middot; ${escapeHtml(when)}</span>`;
}

async function cloudRefresh(quiet) {
  try {
    const j = await cloudFetch(`/repos/${CLOUD.repo}/actions/workflows/${CLOUD.workflow}/runs?per_page=5`);
    const runs = j.workflow_runs || [];
    CLOUD.run = runs[0] || null;
    $('cloudStatus').innerHTML = cloudStatusLine(CLOUD.run);
    $('cloudRuns').innerHTML = runs.map((r) =>
      `<div class="runline"><a href="${escapeAttr(r.html_url)}" target="_blank" rel="noopener">#${r.run_number}</a>
       <span class="pill ${r.conclusion === 'success' ? 'ok' : (r.conclusion ? 'bad' : 'run')}">${r.conclusion || r.status}</span>
       <span class="mut">${escapeHtml(new Date(r.created_at).toLocaleString())}</span></div>`
    ).join('') || '<span class="mut">No runs yet.</span>';
    const active = runs.some((r) => r.status === 'queued' || r.status === 'in_progress');
    $('cloudStop').classList.toggle('disabled', !active || !CLOUD.token);
    $('cloudLive').textContent = active ? 'LIVE' : 'idle';
    if (!CLOUD.token) $('cloudHint').textContent = 'Read-only view. Add a token below to start/stop runs from here.';
    else $('cloudHint').textContent = '';
  } catch (e) {
    if (!quiet) toast('Cloud status: ' + e.message, true);
    $('cloudStatus').innerHTML = `<span class="mut">${escapeHtml(e.message)}</span>`;
  }
}

async function cloudSetVariable(name, value) {
  const base = `${CLOUD.repo}/actions/variables`;
  const body = JSON.stringify({ name, value });
  const opts = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body };
  try {
    await cloudFetch(`/repos/${base}/${name}`, opts);
  } catch (e) {
    if (!/already exists|409/i.test(e.message)) throw e;
    await cloudFetch(`/repos/${base}/${name}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }
}

async function cloudStartStream() {
  if (!CLOUD.token) return toast('Paste a GitHub token first', true);
  if (!/^https?:\/\//i.test(CLOUD.zoom)) {
    return toast('Paste the Zoom meeting link first', true);
  }
  const btn = $('cloudStart');
  btn.textContent = '…';
  try {
    await cloudSetVariable('ZOOM_LINK', CLOUD.zoom);
    try {
      await cloudFetch(`/repos/${CLOUD.repo}/actions/workflows/${CLOUD.workflow}/enable`, { method: 'PUT' });
    } catch (e) { if (!/409/i.test(e.message)) throw e; }
    const minutes = String(Math.max(15, Math.round(parseFloat(CLOUD.hours || '5.5') * 60)));
    await cloudFetch(`/repos/${CLOUD.repo}/actions/workflows/${CLOUD.workflow}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { duration_min: minutes } }),
    });
    toast('Going live — runner takes ~1 min');
    setTimeout(() => cloudRefresh(true), 5000);
  } catch (e) {
    toast('Start failed: ' + e.message, true);
  } finally {
    btn.textContent = '\u25B6 Go live now';
  }
}

async function cloudStopStream() {
  if (!CLOUD.token) return toast('Paste a GitHub token first', true);
  try {
    try {
      await cloudFetch(`/repos/${CLOUD.repo}/actions/workflows/${CLOUD.workflow}/disable`, { method: 'PUT' });
    } catch (e) { if (!/409/i.test(e.message)) throw e; }
    for (const st of ['in_progress', 'queued', 'pending', 'waiting']) {
      const j = await cloudFetch(`/repos/${CLOUD.repo}/actions/runs?status=${st}&per_page=20`);
      for (const r of j.workflow_runs || []) {
        await cloudFetch(`/repos/${CLOUD.repo}/actions/runs/${r.id}/cancel`, { method: 'POST' });
      }
    }
    toast('Stopped — auto-restart disabled');
    setTimeout(() => cloudRefresh(true), 3000);
  } catch (e) {
    toast('Stop failed: ' + e.message, true);
  }
}

function cloudInit() {
  $('ghRepo').value = CLOUD.repo;
  $('ghToken').value = CLOUD.token;
  $('ghToken').addEventListener('change', () => {
    CLOUD.token = $('ghToken').value.trim();
    localStorage.setItem('gh_token', CLOUD.token);
    cloudRefresh();
  });
  $('ghRepo').addEventListener('change', () => {
    CLOUD.repo = $('ghRepo').value.trim();
    localStorage.setItem('gh_repo', CLOUD.repo);
    cloudRefresh();
  });
  $('cloudZoom').value = CLOUD.zoom;
  $('cloudZoom').addEventListener('change', () => {
    CLOUD.zoom = $('cloudZoom').value.trim();
    localStorage.setItem('gh_zoom', CLOUD.zoom);
  });
  $('cloudHours').value = CLOUD.hours;
  $('cloudHours').addEventListener('change', () => {
    CLOUD.hours = $('cloudHours').value || '5.5';
    localStorage.setItem('gh_hours', CLOUD.hours);
  });
  $('cloudStart').addEventListener('click', cloudStartStream);
  $('cloudStop').addEventListener('click', cloudStopStream);
  $('cloudOpen').addEventListener('click', () => {
    window.open(`https://github.com/${CLOUD.repo}/actions/workflows/${CLOUD.workflow}`, '_blank', 'noopener');
  });
  setInterval(() => {
    if ($('pane-cloud') && $('pane-cloud').classList.contains('active')) cloudRefresh(true);
  }, 15000);
}

$('bannerOpen').addEventListener('click', () => {
  window.open('http://127.0.0.1:3000', '_blank', 'noopener');
});

$('bannerRetry').addEventListener('click', async () => {
  const b = $('bannerRetry');
  b.textContent = '…';
  const ok = await detectServer();
  b.textContent = 'Retry';
  if (ok) location.reload();
  else toast('Still cannot reach http://127.0.0.1:3000 — run start-studio.bat', true);
});

ytInit();

boot().catch((e) => toast('Failed to load studio: ' + e.message, true));
