/* GZDoom Portable launcher.
 *
 * Runs from file://. Everything that would normally be fetched (wasm, loader,
 * PK3s, WADs) is delivered by classic <script> bundles and turned into a Blob
 * worker, because file:// pages may not fetch() or start file:// workers.
 *
 * Save flow: GZDoom writes to MEMFS (/home/web_user/.config/gzdoom). The
 * worker watches that tree and ships changed files here; IndexedDB is the
 * durable store. Export/Import build a ZIP for carrying progress on the USB.
 * The UI never claims the browser wrote to the USB - it cannot.
 */
'use strict';

/* ------------------------------------------------------------------ utils */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const APP_VERSION = '1.7.4';

const PK3S = ['gzdoom.pk3', 'brightmaps.pk3', 'game_support.pk3', 'game_widescreen_gfx.pk3', 'lights.pk3'];
const BIND_ACTIONS = [
  ['forward', 'Move forward', 'w'],
  ['back', 'Move back', 's'],
  ['left', 'Strafe left', 'a'],
  ['right', 'Strafe right', 'd'],
  ['attack', 'Fire', 'mouse1'],
  ['use', 'Use / open', 'e'],
  ['jump', 'Jump', 'space'],
  ['toggleconsole', 'Console', '`'],
];
const DEFAULT_SETTINGS = {
  res: 'window',
  filter: 'nearest',
  // Frame rate is one of three modes. 'uncapped' lets the engine run to its own
  // limit, 'vsync' caps it at the measured monitor refresh (the worker engines
  // cannot truly synchronise to the display - the compositor samples their
  // OffscreenCanvas - so the cap is what makes the three behave alike), and
  // 'custom' uses the slider below.
  fpsMode: 'uncapped',
  // Slider value for 'custom'; '0' keeps a fresh install Uncapped. The settings
  // screen shows 144 and writes it the moment 'Custom limit' is chosen.
  maxfps: '0',
  fullscreen: false,
  fps: true,
  volume: 1,
  music: true,
  sensitivity: 1,
  // Vertical look. Off by default: measured on the reporting machine, leaning
  // the engine's invertmouse off is what makes "mouse up = look up" behave; it
  // is a plain per-engine switch so a build that reads Y the other way round is
  // one tick away. 1.6.1 flips the 1.6.0 default (which was on) once.
  invertY: false,
  binds: {},
  cache: true,
};

const S = {
  caps: null,
  settings: { ...DEFAULT_SETTINGS },
  db: null,
  dbOk: false,
  mem: { files: new Map(), meta: new Map(), games: new Map(), gamedata: new Map() },
  selection: [],
  worker: null,
  workerUrl: null,
  game: null,
  stats: null,
  logLines: [],
  lastSaveAt: 0,
  saveToastShown: false,
  fsAllWaiter: null,
  audio: { ctx: null, master: null, sources: new Map() },
  enginePromise: null,
  engineId: 'gzdoom',
  engine: null,
  inlineWatch: null,
  inlineHideHook: false,
  fpsTimer: null,
  profile: '',
  pendingRecent: null,
  confirmAction: null,
  exportUrl: null,
  firstLaunch: true,
};

/* ------------------------------------------------------------ formatting */
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Math.max(0, Date.now() - ts);
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + ' min ago';
  if (d < 86400000) return Math.floor(d / 3600000) + ' h ago';
  return new Date(ts).toLocaleDateString();
}
function fmtDate(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------------- base64 */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress gzip.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    // The element is only a delivery vehicle: once the script has run its
    // globals live on their own. Leaving it in <head> accumulated one element
    // per launch (three per session) for the life of the tab.
    s.onload = () => { try { s.remove(); } catch (_) {} resolve(); };
    s.onerror = () => {
      try { s.remove(); } catch (_) {}
      reject(new Error('Could not load ' + src + ' (is the engine folder next to index.html?)'));
    };
    document.head.appendChild(s);
  });
}
async function ensureEngineScripts() {
  if (window.GZP_ENGINE && window.GZP_DATA) return;
  if (!S.enginePromise) {
    S.enginePromise = (async () => {
      const bins = (currentEngine() && currentEngine().binaries) || {};
      setBoot('Loading engine bundle…', 8, '');
      for (const src of [bins.loader, bins.data]) {
        if (src) await loadScript(src);
      }
    })();
    S.enginePromise.catch(() => { S.enginePromise = null; });
  }
  return S.enginePromise;
}
/* The bundled engine ships as base64 strings in globals: portable-engine.js is
 * 12.7 MB and portable-data.js 14.3 MB of text, held for as long as the page
 * lives even though only the decoded bytes are used. Once a launch has decoded
 * what it needs they are dead weight, so they are dropped; a later launch
 * re-reads the files, which the browser serves from its own cache. */
function releasePackedGlobals() {
  for (const k of ['GZP_ENGINE', 'GZP_DATA', 'GZ_ENGINE_BUNDLE']) {
    try { delete window[k]; } catch (_) { try { window[k] = undefined; } catch (__) {} }
  }
  S.enginePromise = null;
}

/* ------------------------------------------------------------- storage */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable')); return; }
    let req;
    try {     req = indexedDB.open('gzdoom-portable', 2); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('gamedata')) db.createObjectStore('gamedata', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}
function idbReq(mode, store, fn) {
  return new Promise((resolve, reject) => {
    if (!S.db) { reject(new Error('storage unavailable')); return; }
    let tx;
    try { tx = S.db.transaction(store, mode); } catch (e) { reject(e); return; }
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const store = {
  async all(name) {
    if (!S.dbOk) return Array.from(S.mem[name].values());
    return (await idbReq('readonly', name, (os) => os.getAll())) || [];
  },
  async get(name, key) {
    if (!S.dbOk) return S.mem[name].get(key) || null;
    return await idbReq('readonly', name, (os) => os.get(key));
  },
  async put(name, value) {
    if (!S.dbOk) {
      const k = name === 'files' ? value.key : value.id;
      S.mem[name].set(k, value);
      return;
    }
    await idbReq('readwrite', name, (os) => os.put(value));
  },
  async del(name, key) {
    if (!S.dbOk) { S.mem[name].delete(key); return; }
    await idbReq('readwrite', name, (os) => os.delete(key));
  },
  async clear(name) {
    if (!S.dbOk) { S.mem[name].clear(); return; }
    await idbReq('readwrite', name, (os) => os.clear());
  },
  /* Keys only. Counting saves should not pull every save body into the page. */
  async keys(name) {
    if (!S.dbOk) return Array.from(S.mem[name].keys());
    return (await idbReq('readonly', name, (os) => os.getAllKeys())) || [];
  },
};

/* --------------------------------------------------------------- caps */
/* WebGL2 probe. A tab that has just closed an engine can briefly refuse a new
 * WebGL2 context: Chrome caps live contexts per process, and a worker that was
 * terminated a moment ago may still be holding its own while the GPU process
 * releases it. Probing exactly once turned that into the "enable hardware
 * acceleration" screen on a machine that has acceleration on. Release every
 * probe context and retry with a short backoff before believing it. */
async function probeWebgl2() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 8;
    let gl = null;
    try { gl = cv.getContext('webgl2', { powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false }); } catch (_) { gl = null; }
    if (gl) {
      // Hand the context back immediately: this probe must not hold a GPU
      // context for the lifetime of the page.
      try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (_) {}
      return true;
    }
    cv.width = 1; cv.height = 1;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  return false;
}
async function detectCaps() {
  const webgl2 = await probeWebgl2();
  const caps = {
    file: location.protocol === 'file:',
    worker: typeof Worker === 'function',
    offscreen: typeof OffscreenCanvas !== 'undefined' && !!HTMLCanvasElement.prototype.transferControlToOffscreen,
    webgl2,
    jspi: typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
    idb: typeof indexedDB !== 'undefined',
  };
  caps.ok = caps.worker && caps.offscreen && caps.webgl2 && caps.jspi;
  if (!caps.jspi) {
    caps.reason = 'This browser does not expose JSPI (WebAssembly.Suspending / promising). The GZDoom build suspends on its main loop and needs it. Use a current Chromium browser (Chrome, Edge, Brave, Opera, Vivaldi) 137+, or Firefox with “javascript.options.wasm_js_promise_integration” enabled.';
  } else if (!caps.webgl2) {
    caps.reason = 'WebGL2 could not start, even after four tries. If a game was just closed, the browser may still be releasing its GPU context: reload the page (F5) and press Start game again. If that does not help, enable hardware acceleration in the browser settings.';
  } else if (!caps.offscreen) {
    caps.reason = 'OffscreenCanvas is unavailable. Use a current Chromium browser (Chrome, Edge, Brave, Opera, Vivaldi) or Firefox.';
  } else if (!caps.worker) {
    caps.reason = 'Web Workers are unavailable in this browser.';
  } else {
    caps.reason = '';
  }
  return caps;
}

/* ------------------------------------------------------------- settings */
// Settings are shared by every engine as a base, but each engine keeps its own
// copy: the renderer, resolution and volumes that suit GZDoom are not assumed
// to suit another engine, and switching engines must not silently rewrite the
// other one's choices. `settings` stays the shared record older builds wrote.
function engineSettingsId(id) { return 'settings:' + (id || S.engineId); }
/* One-time defaults fixes for installs created by older builds.
 * - The backbuffer used to be pinned to 1920x1080; following the window renders
 *   exactly the pixels on screen (sharper at native size, cheaper on small or
 *   high-DPI displays).
 * - The frame limiter used to default to 120, which holds a 144/240 Hz display
 *   below its refresh rate for no reason. Uncapped matches what the engine does
 *   natively with vsync off.
 * A value the user actually picked afterwards is left alone. */
/* Defaults fixes applied to one settings record, exactly once each. The shared
 * record and every engine's own record go through this, so the two cannot
 * drift the way two hand-maintained copies did. */
function migrateRecord(v) {
  let changed = false;
  if (!v.resMigrated) {
    v.resMigrated = true; changed = true;
    if (v.res === '1920x1080') v.res = 'window';
  }
  if (!v.maxfpsMigrated) {
    v.maxfpsMigrated = true; changed = true;
    if (v.maxfps === '120') v.maxfps = '0';
  }
  // 1.6.0 shipped Invert mouse Y switched on as a default. 1.6.1 turns it off,
  // once, for installs that inherited that default; a choice made after this
  // runs is kept (the flag is saved with the settings).
  if (!v.invertMigrated) {
    v.invertMigrated = true;
    v.invertY = false;
    changed = true;
  }
  if (!v.fpsModeMigrated) {
    v.fpsModeMigrated = true; changed = true;
    // 1.6.4 and earlier had a VSync checkbox beside a 0/60/120 limit select.
    if (v.vsync) v.fpsMode = 'vsync';
    else if (v.maxfps && String(v.maxfps) !== '0') v.fpsMode = 'custom';
    else v.fpsMode = 'uncapped';
    if (!Number(v.maxfps)) v.maxfps = '144';
    delete v.vsync;
  }
  return changed;
}
function migrateSettings() { return migrateRecord(S.settings); }
async function loadSettings() {
  try {
    const rec = await store.get('meta', 'settings');
    if (rec && rec.value) Object.assign(S.settings, DEFAULT_SETTINGS, rec.value);
  } catch (_) {}
  try {
    const own = await store.get('meta', engineSettingsId());
    if (own && own.value) {
      Object.assign(S.settings, DEFAULT_SETTINGS, own.value);
      // This engine's record decides whether the 1.6.1 invert-Y default has been
      // applied to it: a record written before that release has no marker, and
      // the shared record (already migrated) must not make it look done.
      if (!own.value.invertMigrated) S.settings.invertMigrated = false;
    }
  } catch (_) {}
  if (migrateSettings()) saveSettings();
  await migrateEngineSettings();
}
/* Each engine keeps its own settings record, so the old defaults have to be
 * rewritten in all of them — not just the one that happens to be loaded. */
async function migrateEngineSettings() {
  const engines = (window.GZ_ENGINES && GZ_ENGINES.all()) || [];
  for (const { id } of engines) {
    if (!id || id === S.engineId) continue;   // active record is already done
    let rec = null;
    try { rec = await store.get('meta', 'settings:' + id); } catch (_) {}
    if (!rec || !rec.value || !migrateRecord(rec.value)) continue;
    store.put('meta', { id: 'settings:' + id, value: rec.value }).catch(() => {});
  }
}
/* A slider drag fires `input` on every pixel and each saveSettings() is two
 * IndexedDB writes, so the handlers below coalesce while dragging and flush
 * when the drag ends. */
let settingsSaveTimer = null;
function saveSettingsSoon() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveSettings, 400);
}
function saveSettings() {
  clearTimeout(settingsSaveTimer);
  const value = { ...S.settings };
  store.put('meta', { id: engineSettingsId(), value }).catch(() => {});
  store.put('meta', { id: 'settings', value }).catch(() => {});
}
async function switchEngineSettings(prevId, nextId) {
  const prev = { ...S.settings };
  store.put('meta', { id: engineSettingsId(prevId), value: prev }).catch(() => {});
  Object.assign(S.settings, DEFAULT_SETTINGS);
  let saved = null;
  try { saved = await store.get('meta', engineSettingsId(nextId)); } catch (_) {}
  if (saved && saved.value) Object.assign(S.settings, DEFAULT_SETTINGS, saved.value);
}

/* -------------------------------------------------------------- engines */
function engineEnv() {
  const env = (window.GZ_ENGINES && GZ_ENGINES.environment()) || { file: location.protocol === 'file:' };
  if (S.caps) env.jspi = !!S.caps.jspi;
  return env;
}
function engineBlocked(engine) {
  if (!window.GZ_ENGINES) return 'The engine registry (engines.js) did not load.';
  return GZ_ENGINES.blockedBecause(engine, engineEnv());
}
function currentEngine() {
  if (S.engine) return S.engine;
  const reg = window.GZ_ENGINES;
  S.engine = (reg && reg.get(S.engineId)) || null;
  return S.engine;
}
function savedEngineId() {
  try { return localStorage.getItem('gzportable.engine') || 'gzdoom'; } catch (_) { return 'gzdoom'; }
}
function rememberEngine(id) {
  try { localStorage.setItem('gzportable.engine', id); } catch (_) {}
}
function engineModNote(engine) {
  if (!engine) return '';
  const names = S.selection.map((f) => f.name).join(' ');
  const note = (engine.modNotes || []).find((n) => n.match.test(names));
  return note ? note.text : '';
}
function renderEngine() {
  const reg = window.GZ_ENGINES;
  const list = $('#engine-list');
  if (!reg || !list) return;
  const engine = currentEngine();
  // The cards are static for the life of the page; only their state changes.
  if (!list.children.length) {
    for (const e of reg.all()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'engine-card';
      btn.dataset.id = e.id;
      btn.setAttribute('role', 'radio');
      btn.innerHTML =
        '<span class="ec-top"><span class="ec-name">' + esc(e.name) + '</span>' +
        '<span class="ec-ver">' + esc(e.version) + '</span></span>' +
        '<span class="ec-desc">' + esc(e.description || '') + '</span>' +
        '<span class="ec-tags"><span class="tag ' + (e.badge === 'experimental' ? 'exp' : 'stable') + '">' +
        esc(e.badge || 'engine') + '</span></span>';
      btn.onclick = () => selectEngine(e.id);
      list.appendChild(btn);
    }
    list.addEventListener('keydown', (ev) => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(ev.key)) return;
      const ids = reg.all().map((e) => e.id);
      const at = ids.indexOf(S.engineId);
      const step = (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') ? 1 : -1;
      const next = ids[(at + step + ids.length) % ids.length];
      ev.preventDefault();
      selectEngine(next);
      const btn = list.querySelector('[data-id="' + next + '"]');
      if (btn) btn.focus();
    });
  }
  for (const btn of list.children) {
    const on = btn.dataset.id === (engine ? engine.id : S.engineId);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
  const blocked = engineBlocked(engine);
  const badge = $('#cap-badge');
  if (badge) {
    badge.textContent = blocked ? 'NOT SUPPORTED' : 'READY';
    badge.className = 'badge ' + (blocked ? 'bad' : 'ok');
  }
  const info = $('#engine-info');
  if (info && engine) {
    // Availability is per engine, not per browser: the 4.11.3 and UZDoom builds
    // need JSPI, the 4.14.2 build needs only WebGL2.
    const req = [];
    if (engine.requires && engine.requires.jspi) req.push('JSPI');
    req.push('WebGL2');
    info.innerHTML = '<b>' + esc(reg.label(engine)) + '</b> \u00b7 ' + esc(engine.description || '') +
      '<br>' + esc(engine.compatibility || '') +
      '<br><span class="mono">Requires ' + esc(req.join(' \u00b7 ')) + '</span>';
  }
  const warn = $('#engine-warn');
  if (warn) {
    const msg = blocked || engineModNote(engine);
    warn.textContent = msg;
    warn.hidden = !msg;
    warn.classList.toggle('err', !!blocked);
  }
  updateStartState();
  // Which settings this engine can honour (VSync shows the measured refresh).
  if (typeof renderEngineLimits === 'function') renderEngineLimits();
}
function selectEngine(id) {
  setEngine(id).catch((e) => S.log('[engine] switch failed: ' + e.message));
}
async function setEngine(id, { persist = true } = {}) {
  const reg = window.GZ_ENGINES;
  const engine = reg && reg.get(id);
  if (!engine) return;
  const prevId = S.engineId;
  S.engineId = engine.id;
  S.engine = engine;
  S.enginePromise = null;
  if (persist) {
    rememberEngine(engine.id);
    await switchEngineSettings(prevId, engine.id);
    renderSettings();
    $('#sys-renderer').textContent = 'GLES / WebGL2';
  }
  renderEngine();
}

/* --------------------------------------------------------------- WADs */
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function ascii(b, o, n) {
  let s = '';
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
function inspectWad(bytes) {
  if (bytes.length < 12) throw new Error('File is too small to be a WAD.');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error('Not a WAD file (missing IWAD/PWAD header).');
  const num = u32(bytes, 4), dir = u32(bytes, 8);
  if (!num || dir + num * 16 > bytes.length) throw new Error('WAD directory is damaged or truncated.');
  let maps = 0;
  const n = Math.min(num, 200000);
  for (let i = 0; i < n; i++) {
    const name = ascii(bytes, dir + i * 16 + 8, 8).trim().toUpperCase();
    if (/^(MAP\d\d|E\dM\d)$/.test(name)) maps++;
  }
  return { kind: magic === 'IWAD' ? 'iwad' : 'pwad', maps };
}
function inspectFile(name, bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { kind: 'pk3', maps: 0, archive: true };
  }
  const info = inspectWad(bytes);
  if (info.kind === 'iwad' && !/\.wad$/i.test(name)) name += '.wad';
  return info;
}
function safeName(name, used) {
  let base = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+/, '');
  if (!base) base = 'file.wad';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) base += '.wad';
  let out = base, i = 2;
  while (used.has(out.toLowerCase())) {
    out = base.replace(/(\.[A-Za-z0-9]{1,8})$/, '-' + i + '$1');
    i++;
  }
  used.add(out.toLowerCase());
  return out;
}

/* --------------------------------------------------------------- toasts */
function toast(msg, kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, ms);
}

/* -------------------------------------------------------------- modals */
function openModal(id) { const m = document.getElementById(id); if (m) m.hidden = false; }
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.hidden = true;
  if (id === 'export-modal' && S.exportUrl) { URL.revokeObjectURL(S.exportUrl); S.exportUrl = null; }
}
function askConfirm(title, text, action) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  S.confirmAction = action;
  openModal('confirm-modal');
}

/* --------------------------------------------------------------- boot UI */
function setBoot(text, pct, detail) {
  const sub = $('#boot-sub'), bar = $('#boot-bar'), det = $('#boot-detail');
  if (sub) sub.textContent = text;
  if (bar && pct != null) bar.style.width = Math.max(4, Math.min(100, pct)) + '%';
  if (det) det.textContent = detail || '';
}
function showBoot() { $('#boot').hidden = false; setBoot('Preparing engine…', 4, ''); }
function hideBoot() { $('#boot').hidden = true; }
function showFatal(title, text, detail) {
  hideBoot();
  const card = $('#fatal');
  card.hidden = false;
  card.querySelector('h2').textContent = title;
  $('#fatal-text').textContent = text;
  $('#fatal-detail').textContent = detail || '';
  exitGameUi();
}

/* ------------------------------------------------------------- selection */
function addSelection(files) {
  const used = new Set(S.selection.map((f) => f.storedName));
  for (const f of files) {
    const iwad = S.selection.find((x) => x.info.kind === 'iwad');
    if (f.info.kind === 'iwad' && iwad) {
      toast('Only one base IWAD can be loaded at a time; "' + f.name + '" was ignored.', 'err');
      continue;
    }
    f.storedName = safeName(f.name, used);
    S.selection.push(f);
  }
  renderSelection();
}
function selectionIwad() {
  return S.selection.find((f) => f.info.kind === 'iwad') || null;
}
/* Single place that decides whether Start is available and what the status line
 * says. Every path that changes the selection, the engine or the session state
 * calls it, so the button and the text cannot disagree. */
function updateStartState() {
  const play = $('#btn-play');
  const blocked = engineBlocked(currentEngine());
  const iwad = selectionIwad();
  if (play) play.disabled = !!blocked || !iwad;
  if (blocked) { setStatus(blocked, 'err'); return; }
  if (!iwad) {
    setStatus(S.selection.length
      ? 'Add a base IWAD — a PWAD or PK3 needs a game to load into.'
      : 'Choose a Doom IWAD to start. No game data is included.', S.selection.length ? 'err' : '');
    return;
  }
  setStatus('Ready to launch.', 'ok');
}
function renderSelection() {
  const box = $('#selection'), list = $('#sel-list');
  const iwad = S.selection.find((f) => f.info.kind === 'iwad');
  box.hidden = S.selection.length === 0;
  list.innerHTML = '';
  for (const f of S.selection) {
    const li = document.createElement('li');
    const role = f.info.kind === 'iwad' ? 'IWAD' : (f.info.archive ? 'PK3' : 'PWAD');
    li.innerHTML =
      '<span class="role ' + (f.info.kind === 'iwad' ? 'iwad' : '') + '">' + role + '</span>' +
      '<span class="name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
      '<span class="size">' + fmtBytes(f.size || (f.bytes ? f.bytes.length : 0)) + '</span>' +
      '<button class="rm" title="Remove">×</button>';
    li.querySelector('.rm').onclick = () => {
      S.selection = S.selection.filter((x) => x !== f);
      renderSelection();
    };
    list.appendChild(li);
  }
  const pwads = S.selection.filter((f) => f !== iwad);
  const note = [];
  if (iwad) note.push('Base game: ' + iwad.name);
  else if (S.selection.length) note.push('Add a base IWAD — add-ons need a game to load into.');
  if (pwads.length) note.push(pwads.length + ' add-on file' + (pwads.length > 1 ? 's' : ''));
  if (iwad && iwad.info.maps) note.push(iwad.info.maps + ' maps detected');
  $('#sel-note').textContent = note.join(' · ');
  if (window.GZ_ENGINES) renderEngine();
  else updateStartState();
}
function setStatus(msg, kind) {
  const el = $('#play-status');
  el.textContent = msg;
  el.className = 'status-line ' + (kind || '');
}

/* ---------------------------------------------------------- read files */
async function readPickedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setStatus('Reading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…', '');
  const out = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = inspectFile(file.name, bytes);
      out.push({ name: file.name, bytes, info, file, size: bytes.length });
    } catch (e) {
      toast('"' + file.name + '": ' + e.message, 'err', 7000);
    }
  }
  if (!out.length) { setStatus('No usable WAD/PK3 files selected.', 'err'); return; }
  addSelection(out);
  if (S.pendingRecent) { S.pendingRecent = null; }
}
async function handleRecentClick(rec) {
  let data = null;
  try { data = await store.get('gamedata', rec.id); } catch (_) {}
  if (data && data.entries && data.entries.length) {
    try {
      S.selection = data.entries.map((e) => {
        const bytes = new Uint8Array(e.data);
        return { name: e.name, storedName: e.name, bytes, info: inspectFile(e.name, bytes), size: bytes.length };
      });
      renderSelection();
      launch();
    } catch (e) {
      toast('Stored game could not be read: ' + e.message, 'err');
    }
    return;
  }
  S.pendingRecent = rec;
  $('#file-input').click();
  setStatus('Select "' + rec.label + '" again — this browser did not keep the game files.', '');
}

/* Render size for a launch. 'window' means the actual viewport in device
 * pixels, long side capped at 1920: a 4K panel would otherwise ask the wasm
 * renderer for 8 megapixels per frame, which costs frames and buys nothing at
 * the engines' internal texture resolution. An explicit setting always wins. */
function launchSize() {
  const res = S.settings.res;
  if (res && res !== 'window') {
    const [w, h] = res.split('x').map(Number);
    if (w > 0 && h > 0) return [w, h];
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round((window.innerWidth || 1024) * dpr);
  let h = Math.round((window.innerHeight || 640) * dpr);
  const k = Math.min(1, 1920 / Math.max(w, h, 1));
  const even = (n) => Math.max(320, Math.round((n * k) / 2) * 2);
  return [even(w), even(h)];
}

/* The frame-rate setting in one place: 0 means "no cap". VSync is a cap at the
 * measured monitor refresh, because only the in-page engine can be paced by the
 * display (its loop is driven from the page); the worker engines render into an
 * OffscreenCanvas that the compositor samples, so a cap is how they get the same
 * behaviour. */
function effectiveMaxfps() {
  const mode = S.settings.fpsMode || 'uncapped';
  if (mode === 'vsync') return S.displayHz || 60;
  if (mode === 'custom') {
    const n = Math.round(Number(S.settings.maxfps));
    return n > 0 ? n : 0;
  }
  return 0;
}
/* Monitor refresh, sampled from animation frames (~0.5 s, once per load). */
function measureDisplayHz() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let n = 0;
    const tick = () => {
      n++;
      const dt = performance.now() - t0;
      if (dt < 500) { try { requestAnimationFrame(tick); } catch (_) { resolve(60); } return; }
      resolve(Math.max(24, Math.round(n / (dt / 1000))));
    };
    try { requestAnimationFrame(tick); } catch (_) { resolve(60); }
  });
}

/* ------------------------------------------------------------- launch */
function readSettingsArgs(engine, w, h) {
  const mainThread = !!engine && engine.boot === 'inline';
  // The 4.14-era builds render a screenshot into a texture framebuffer when a
  // save is written; WebGL2 rejects that attachment (the engine then logs
  // glCheckFramebufferStatus failed: GL_FRAMEBUFFER_UNSUPPORTED and the screen
  // stays black). Turning the save picture off skips the whole pass. The save
  // data is unaffected - only its thumbnail in the load menu is missing.
  const savePic = engine && engine.noSavePic ? ['+set', 'storesavepic', '0'] : [];
  const invertY = ['+set', 'invertmouse', S.settings.invertY ? '1' : '0'];
  // The in-page engine owns its audio and its own config; what it cannot guess
  // is the window/render size, so that is all it gets (plus windowed mode).
  // The extra cvars below belong to the worker build, where the launcher drives
  // a fixed-size backbuffer (uiscale/st_scale/vid_scalemode pin the render size).
  if (mainThread) {
    // Without these this build opens its built-in 640x480 window and lets the
    // canvas stretch that frame to the window's shape. Asked for the chosen
    // resolution, it creates that window and renders 1:1; the canvas keeps the
    // engine's aspect ratio and is letterboxed by CSS.
    return [
      '+vid_fullscreen', '0',
      '+vid_defwidth', String(w), '+vid_defheight', String(h),
      '+win_w', String(w), '+win_h', String(h),
      '-width', String(w), '-height', String(h),
      // Rendering parity with the worker build, measured on this build's own
      // cvars: 4.14.2 defaults to gl_texture_filter 4 (smooth trilinear) and
      // gl_texture_filter_anisotropic 8, which smears the 1993-era textures the
      // worker engines draw with filter 0 / anisotropy 1. Same resolution, same
      // canvas, so the filtering was the whole difference.
      '+gl_texture_filter', S.settings.filter === 'linear' ? '4' : '0',
      '+gl_texture_filter_anisotropic', '1',
      '+vid_scalemode', '0',
      '+vid_vsync', S.settings.fpsMode === 'vsync' ? '1' : '0',
      // Same frame-cap and responsiveness arguments as the worker engines: this
      // build's own defaults are vid_maxfps 200 and cl_capfps 1, so the launcher
      // settings (and the ability to run uncapped) never reached it.
      '+vid_maxfps', String(effectiveMaxfps()),
      '+cl_capfps', '0',
      '+set', 'uiscale', '0',
      '+set', 'st_scale', '0',
      '+set', 'mouse_sensitivity', String(S.settings.sensitivity || 1),
      '+set', 'snd_mastervolume', String(S.settings.volume),
      // MIDI synthesis is a per-sample cost on the one thread this build has.
      // Its own default device is already the OPL emulation (`snd_mididevice`
      // reads -5 here; -3 is 4.11.3's OPL id and is ignored by this build), but
      // it opens SIX emulated chips unless told otherwise - the same 6x cost
      // that was cut to one chip on 4.11.3.
      '+set', 'adl_chips_count', '1',
      '+set', 'adl_emulator_id', '2',
      '+set', 'adl_run_at_pcm_rate', '1',
      ...(S.settings.music ? [] : ['-nomusic']),
      ...invertY,
      ...savePic,
      ...(engine && engine.extraArgs ? engine.extraArgs : []),
    ];
  }
  const args = [
    // GLES everywhere. The GL3+ path in these WebAssembly builds renders in a
    // software fallback here: measured 14.4 FPS on 4.11.3 against 106 on GLES
    // for the same scene, so "GL3+" was not a choice, it was a trap.
    '+vid_preferbackend', '1',
    '+vid_fullscreen', '0',
    '+vid_defwidth', String(w), '+vid_defheight', String(h),
    '+win_w', String(w), '+win_h', String(h),
    '+vid_scalemode', '0',
    '+vid_vsync', S.settings.fpsMode === 'vsync' ? '1' : '0',
    ...(S.settings.music ? [] : ['-nomusic']),
    // effectiveMaxfps() returns 0 for uncapped; vid_maxfps 0 disables the cap.
    '+vid_maxfps', String(effectiveMaxfps()),
    '+cl_capfps', '0',
    ...invertY,
    ...savePic,
    '+gl_texture_filter', S.settings.filter === 'linear' ? '4' : '0',
    '+gl_texture_filter_anisotropic', '1',
    '+set', 'uiscale', '0',
    '+set', 'st_scale', '0',
    '+set', 'screenblocks', '10',
    '+set', 'hud_althud', '0',
    '+set', 'mouse_sensitivity', String(S.settings.sensitivity || 1),
    '+set', 'snd_mastervolume', String(S.settings.volume),
    // OPL3 keeps working without FluidSynth, which these builds do not ship;
    // `snd_mididevice -3` pins that device. ADL MIDI then defaults to SIX
    // emulated OPL3 chips - six chips of FM synthesis per sample on the one
    // thread the engine has. One chip (18 voices, more than Doom's 16 channels)
    // with the accurate Nuked core at PCM rate cut the periodic synthesis stall
    // from ~120 ms to ~17 ms p99 (UZDoom: 94 of 460 one-second windows over
    // 100 ms, worst 497 ms, before the fix). Both engines read the same ids, so
    // there is one copy of this now instead of one per engine.
    '+set', 'snd_mididevice', '-3',
    '+set', 'adl_chips_count', '1',
    '+set', 'adl_emulator_id', '2',
    '+set', 'adl_run_at_pcm_rate', '1',
    '+set', 'snd_musicvolume', '0.6',
    '+set', 'snd_sfxvolume', '1',
    // Keep the settings-panel values from being overwritten by a saved ini.
    ...(engine && engine.lockCvars === false ? [] : [
      '+lockcvar',
      'vid_rendermode', 'vid_preferbackend', 'vid_fullscreen',
      'vid_defwidth', 'vid_defheight', 'win_w', 'win_h',
      'vid_scalemode', 'vid_vsync', 'cl_capfps', 'vid_maxfps',
      'uiscale', 'st_scale', 'screenblocks', 'hud_althud',
    ]),
    ...(engine && engine.extraArgs ? engine.extraArgs : []),
  ];
  return args;
}
function bindsConfig() {
  const binds = S.settings.binds || {};
  // Base bindings the launcher owns. SDL2 in this engine build never registers
  // a DOM 'wheel' listener, so the browser wheel never becomes MWheelUp/Down;
  // the launcher replays a wheel notch as one of these two keys instead. Both
  // are unbound in GZDoom's defaults, so nothing the player relies on is taken.
  const lines = ['bind "[" "weapprev"', 'bind "]" "weapnext"'];
  for (const [action, , def] of BIND_ACTIONS) {
    // Only write bindings the user actually changed; GZDoom's defaults are
    // already correct for everything else.
    if (!(action in binds)) continue;
    const key = binds[action] || def;
    if (!key) continue;
    const cmd = action === 'toggleconsole' ? 'toggleconsole' : '+' + action;
    lines.push('bind "' + String(key).replace(/"/g, '') + '" "' + cmd + '"');
  }
  return lines.join('\n');
}

async function launch() {
  const engine = currentEngine();
  const blocked = engine ? engineBlocked(engine) : 'No engine selected.';
  if (blocked) {
    showFatal((engine ? engine.name : 'This engine') + ' cannot start here', blocked, '');
    return;
  }
  if (!engine || (engine.boot !== 'worker' && engine.boot !== 'inline')) {
    showFatal('Engine not available', 'This folder only ships the bundled WebAssembly engines. Add the engine\u2019s files and a boot path before selecting it.', '');
    return;
  }
  if (engine.boot === 'inline') {
    // The in-page engine needs WebGL2 and WebAssembly only: no worker, no
    // OffscreenCanvas and no JSPI, so weaker browsers can still use it.
    if (!S.caps.webgl2) { showFatal('This browser cannot run ' + engine.name + ' ' + engine.version, 'It needs WebGL2, which this browser does not provide.', ''); return; }
  } else if (!S.caps.ok) { showFatal('This browser cannot run GZDoom Portable', S.caps.reason, ''); return; }
  if (S.game) return;
  const iwadEntry = selectionIwad();
  if (!iwadEntry) { setStatus('Add a base IWAD (DOOM.WAD, DOOM2.WAD, HERETIC.WAD…) to start.', 'err'); return; }

  $('#btn-play').disabled = true;
  showBoot();
  S.saveToastShown = false;
  try {
    // The in-page engine opens its own AudioContext for its own SDL audio, so a
    // launcher-side context here would only hold an unused audio device open on
    // the machines that take the lightest path.
    if (engine.boot !== 'inline') ensureAudio();
    // Ask for fullscreen while the click's user activation is still valid.
    if (S.settings.fullscreen) requestFullscreen().catch(() => {});

    const [w, h] = launchSize();

    // Work out the plan before spending time decoding the engine.
    const pwads = S.selection.filter((f) => f !== iwadEntry);

    // Launching transfers the byte buffers to the worker, which detaches them.
    // A second launch (retry after an engine error, or play-again) must re-read
    // the files the user picked instead of handing the worker empty arrays.
    for (const f of [iwadEntry, ...pwads]) {
      if (f.bytes && f.bytes.byteLength) continue;
      if (!f.file) throw new Error('"' + f.name + '" was already handed to the engine. Pick it again to relaunch.');
      f.bytes = new Uint8Array(await f.file.arrayBuffer());
      f.size = f.bytes.length;
      f.info = inspectFile(f.name, f.bytes);
    }

    let wasm = null;
    let pk3Bytes = {};
    // Each worker engine either uses the original GZP_* bundles or ships its own
    // single bundle (glue + worker source + wasm + archives) named by the
    // registry entry, so adding an engine never edits the boot code.
    let bundle = null;
    // Reserved names: a user file called gzdoom.pk3 must not overwrite the
    // engine's own archive in MEMFS, whoever provides it (the in-page engine
    // ships its data as gzdoom.data, and that file is gzdoom.pk3 once unpacked).
    let archives = PK3S;
    if (engine.boot === 'worker') {
      if (engine.binaries && engine.binaries.bundle) {
        setBoot('Loading ' + engine.name + ' ' + engine.version + '…', 44, engine.binaries.bundle);
        await loadScript(engine.binaries.bundle);
        bundle = window.GZ_ENGINE_BUNDLE;
        if (!bundle || !bundle.loader) throw new Error(engine.binaries.bundle + ' did not define the engine bundle.');
        archives = Object.keys(bundle.archives || {});
        setBoot('Decoding WebAssembly…', 52, bundle.version || engine.name);
        wasm = bundle.gzip ? await gunzip(b64ToBytes(bundle.wasm)) : b64ToBytes(bundle.wasm);
        setBoot('Decoding engine archives…', 64, archives.join(' · '));
        for (const k of archives) {
          const packed = b64ToBytes(bundle.archives[k]);
          pk3Bytes[k] = bundle.gzip ? await gunzip(packed) : packed;
        }
      } else {
        await ensureEngineScripts();
        setBoot('Decoding WebAssembly…', 48, 'engine/gzdoom/portable-engine.js');
        wasm = b64ToBytes(window.GZP_ENGINE.wasm);
        setBoot('Decoding support archives…', 62, PK3S.join(' · '));
        for (const k of PK3S) pk3Bytes[k] = b64ToBytes(window.GZP_DATA[k]);
      }
    }

    // Unique in-MEMFS file names, preserving the user's names where safe.
    // Seed with the bundled archive names: a user file called gzdoom.pk3 must
    // not overwrite the engine's own base archive in MEMFS (GZDoom would then
    // load the wrong file and silently ignore the user's PK3).
    const used = new Set(archives.map((k) => k.toLowerCase()));
    const files = {};
    const iwadStored = safeName(iwadEntry.name, used);
    files['/' + iwadStored] = iwadEntry.bytes;
    const pwadStored = [];
    for (const f of pwads) {
      const n = safeName(f.name, used);
      files['/' + n] = f.bytes;
      pwadStored.push(n);
    }
    if (engine.boot === 'worker') for (const k of archives) files['/' + k] = pk3Bytes[k];

    const totalBytes = iwadEntry.bytes.length + pwads.reduce((n, f) => n + f.bytes.length, 0);
    // Saves and the engine's own config belong to this exact combination of
    // engine and game files. The launcher restores every row it holds into the
    // engine's save root, and GZDoom's Load Game menu lists whatever is in
    // there - which is how a save from one game turned up inside a different
    // mod set. Each launch now gets its own profile folder.
    S.profile = saveProfileId(engine.id, gameId(iwadStored, pwadStored, totalBytes));

    const cfg = bindsConfig();
    if (cfg) {
      files['/portable.cfg'] = new TextEncoder().encode(cfg + '\n');
    }

    const args = ['-iwad', iwadStored];
    if (pwadStored.length) args.push('-file', ...pwadStored);

    // Start at the title screen. No -warp: the player picks New Game, a
    // difficulty and (for Doom 1) an episode, exactly like native GZDoom. A
    // PWAD's maps are still selectable from the menu once its IWAD loads.
    if (cfg) args.push('-exec', 'portable.cfg');
    args.push(...readSettingsArgs(engine, w, h));

    setBoot('Restoring saves…', 72, '');
    let stateFiles = {};
    // UZDoom and GZDoom both name their slots doomsav0.zds, so the store keeps
    // an engine-specific name prefix. Only this engine's files are restored.
    S.savePrefix = (engine.saves && engine.saves.keyPrefix) || '';
    // Remember this profile so an import made before the first launch of a
    // session can still be attached to the right game.
    store.put('meta', { id: 'lastProfile', value: { profile: S.profile, engine: engine.id, game: iwadStored } }).catch(() => {});
    try {
      const moved = await adoptUnprofiledSaves(iwadStored);
      if (moved) S.log('[saves] moved ' + moved + ' pre-profile file(s) into ' + S.profile);
      // Only this launch's profile can be restored, and its rows are the only
      // ones worth loading: reading every stored save (all engines, all games)
      // pulled megabytes into the page on every start.
      const pre = 'prof/' + S.profile + '/';
      const keys = await store.keys('files');
      for (const storeKey of keys) {
        if (!storeKey.startsWith(pre)) continue;
        const r = await store.get('files', storeKey);
        if (!r || !r.data) continue;
        const key = fromStoreKey(storeKey);
        if (key) stateFiles[key] = new Uint8Array(r.data);
      }
      if (Object.keys(stateFiles).length) S.log('[saves] restoring ' + Object.keys(stateFiles).length + ' file(s)');
    } catch (e) { S.log('[saves] restore failed: ' + e.message); }

    setBoot('Starting engine worker…', 82, engine.name + ' ' + engine.version);
    // Copy the game bytes before they are transferred/detached so the recent
    // games list can cache them without re-picking files next time.
    // Cache the game files for the recent-games list BEFORE the engine takes the
    // bytes. IndexedDB clones them when they are written, which replaces the old
    // `.slice()` copies: those kept a full second copy of the IWAD (28 MB for
    // a large IWAD) alive on every single launch.
    const gameKey = gameId(iwadStored, pwadStored, totalBytes);
    let cached = false;
    if (S.settings.cache && S.dbOk && totalBytes <= 96 * 1048576) {
      cached = await cacheGameFiles({ id: gameKey, iwadStored, pwadsStored: pwadStored, iwadEntry, pwads, totalBytes });
    }

    if (engine.boot === 'inline') {
      await bootInline({ w, h, files, args, stateFiles, displayName: iwadEntry.name, engine });
    } else {
      await bootWorker({ w, h, files, args, stateFiles, wasm, iwadStored, pwads: pwadStored, displayName: iwadEntry.name, bundle, engine });
    }

    rememberGame({ iwadEntry, pwads, iwadStored, pwadsStored: pwadStored, displayName: iwadEntry.name, totalBytes, cached });

  } catch (e) {
    S.log('[fatal] ' + (e && e.message));
    try { if (S.game) await endGame({ skipSnapshot: true }); } catch (_) {}
    updateStartState();
    showFatal('GZDoom could not start', e && e.message ? e.message : String(e), S.logLines.slice(-25).join('\n'));
  }
}

/* One boot promise for both engine paths: resolve when the runtime reports it is
 * up, reject on a driver/worker error or a timeout, and hand the settle
 * functions to S.game where the message handler and the inline driver callbacks
 * can reach them. */
function waitForBoot(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The engine did not finish booting. See the engine log in Settings.')), ms);
    S.game.readyResolve = (v) => { clearTimeout(timer); resolve(v); };
    S.game.readyReject = (e) => { clearTimeout(timer); reject(e); };
  });
}

async function bootWorker({ w, h, files, args, stateFiles, wasm, iwadStored, pwads, displayName, bundle, engine }) {
  const stage = $('#stage');
  stage.textContent = '';
  const cv = document.createElement('canvas');
  cv.className = 'game-canvas';
  cv.width = w; cv.height = h;
  cv.tabIndex = 1;
  stage.appendChild(cv);

  let offscreen;
  try { offscreen = cv.transferControlToOffscreen(); }
  catch (e) { throw new Error('Could not transfer the canvas to the worker: ' + e.message); }

  const loaderSrc = bundle ? bundle.loader : window.GZP_ENGINE.loader;
  const workerSrc = bundle ? bundle.worker : window.GZP_ENGINE.worker;
  const source = 'self.__GZP_LOADER_SRC = ' + JSON.stringify(loaderSrc) + ';\n' + workerSrc;
  const blob = new Blob([source], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  let worker;
  try { worker = new Worker(url); }
  catch (e) { URL.revokeObjectURL(url); throw new Error('This browser refused to start the engine worker: ' + e.message); }

  const abort = new AbortController();
  S.worker = worker;
  S.workerUrl = url;
  S.game = { canvas: cv, worker, abort, w, h, displayName, startedAt: Date.now() };

  const ready = waitForBoot(90000);

  worker.onerror = (e) => {
    S.log('[worker error] ' + (e.message || 'unknown'));
    if (S.game && S.game.readyReject) S.game.readyReject(new Error('Engine worker error: ' + (e.message || 'unknown')));
  };
  worker.onmessage = (ev) => onWorkerMessage(ev.data);

  bindInput(cv, abort.signal);
  enterGameUi();
  setBoot('GZDoom is booting…', 92, 'MAP loads after the engine initialises');

  const transfers = [offscreen, wasm.buffer];
  for (const v of Object.values(files)) if (v && v.buffer) transfers.push(v.buffer);
  for (const v of Object.values(stateFiles)) if (v && v.buffer) transfers.push(v.buffer);

  worker.postMessage({
    type: 'boot',
    canvas: offscreen,
    pinW: w, pinH: h,
    args,
    files,
    stateFiles,
    wasm: wasm.buffer,
    // Where this engine keeps saves and its ini inside MEMFS.
    configRoot: (engine && engine.saves && engine.saves.memRoot) || '',
    configIni: (engine && engine.saves && engine.saves.ini) || '',
    saveRoot: (engine && engine.saves && engine.saves.memSaveRoot) || '',
    engineName: engine ? engine.name + ' ' + engine.version : '',
    devMode: new URLSearchParams(location.search).has('dev'),
    // ?dev=1 also raises the engine-log rate limit so startup warnings are
    // visible when diagnosing a mod that misbehaves.
    logAll: new URLSearchParams(location.search).has('dev'),
  }, transfers);

  await ready;
  hideBoot();
  $('#game-fps').hidden = !S.settings.fps;
  cv.focus();
  S.log('[boot] ' + displayName + ' · ' + w + 'x' + h + ' · ' + (pwads.length ? pwads.length + ' add-on(s)' : 'no add-ons'));
  // The engine has its copy of the bytes now; the base64 they came from is dead
  // weight in this page for as long as the session lasts.
  releasePackedGlobals();
  return true;
}

/* Boot a single-threaded engine on the page itself (GZDoom 4.14.2).
 * No worker and no OffscreenCanvas: this build wants a real DOM canvas and a
 * real AudioContext, and it reads its own bytes through Emscripten hooks, so it
 * still works from file://. Because the wasm runtime cannot be re-instantiated
 * in the same tab, leaving the game reloads the launcher (see endGame). */
async function bootInline({ w, h, files, args, stateFiles, displayName, engine }) {
  const stage = $('#stage');
  stage.textContent = '';
  enterGameUi();
  const abort = new AbortController();
  const cv = document.createElement('canvas');
  cv.className = 'game-canvas';
  // Emscripten's HTML5 layer and several GZDoom browser ports look the drawing
  // surface up by this id; without it the engine renders (it was handed the
  // element directly) but its pointer-lock and canvas-size helpers resolve to
  // nothing.
  cv.id = 'canvas';
  cv.tabIndex = 1;
  stage.appendChild(cv);
  bindInlineInput(cv, abort.signal);

  // This build sizes its SDL window from the canvas box it sees when it starts
  // and takes its render resolution from -width/-height (the launcher passes
  // them at the chosen resolution). A canvas attribute larger than its CSS box
  // makes the engine draw into a corner, so the driver nudges the backing store
  // to the CSS box and lets the CSS box scale the frame.


  S.game = { canvas: cv, worker: null, inline: true, abort, w, h, displayName, startedAt: Date.now() };
  setBoot('Loading ' + engine.name + ' ' + engine.version + '…', 86, 'engine/gzdoom414');

  const script = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    // Hand the element back as soon as it has run (see loadScript).
    s.onload = () => { try { s.remove(); } catch (_) {} res(true); };
    s.onerror = () => { try { s.remove(); } catch (_) {} rej(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });

  S.log('[boot] ' + displayName + ' · ' + engine.name + ' ' + engine.version + ' · ' + w + 'x' + h);

  const bins414 = engine.binaries || {};
  if (!window.GZ414_WASM_B64) { setBoot('Reading engine binary…', 88, 'wasm'); await script(bins414.wasm); }
  if (!window.GZ414_DATA_B64) { setBoot('Reading engine data…', 90, 'engine data'); await script(bins414.data); }
  if (!window.GZ414) await script(bins414.driver);

  const mem = {};
  for (const [k, v] of Object.entries(stateFiles || {})) {
    const p = window.GZ414.savePath(k);
    if (p) mem[p] = v;
  }

  setBoot('GZDoom is booting…', 93, 'MAP loads after the engine initialises');
  const ready = waitForBoot(120000);

  window.GZ414
    .start({
      canvas: cv,
      files,
      stateFiles: mem,
      args,
      // With VSync the driver must leave the loop on requestAnimationFrame,
      // which is what paces it to the display; every other mode drives it from
      // timers so the engine's own cap decides.
      uncapped: S.settings.fpsMode !== 'vsync',
      // The custom limit is enforced by the driver's scheduler for this build;
      // its own vid_maxfps is ignored (see driver.js).
      capFps: S.settings.fpsMode === 'custom' ? effectiveMaxfps() : 0,
      onLog: (t, stream) => S.log((stream === 'err' ? '[err] ' : '') + t),
      onReady: () => { if (S.game && S.game.readyResolve) S.game.readyResolve(true); },
      onAbort: (reason) => {
        if (S.game && S.game.readyReject) S.game.readyReject(new Error('GZDoom aborted: ' + reason));
        else showFatal('GZDoom stopped', String(reason), S.logLines.slice(-25).join('\n'));
      },
    })
    .catch((e) => { if (S.game && S.game.readyReject) S.game.readyReject(e); else S.log('[414] ' + e.message); });

  await ready;
  hideBoot();
  cv.focus();
  // Same for this build: the wasm and its data live in the runtime, so the
  // base64 they were decoded from can go (another ~20 MB in this tab).
  try { delete window.GZ414_WASM_B64; delete window.GZ414_DATA_B64; } catch (_) {}
  // The engine wrote the WADs into its own memory filesystem and the driver
  // drops its references: the JS copies are dead weight for the rest of the
  // session (a total conversion is ~190 MB). The File handles stay, so the
  // relaunch path re-reads what it needs.
  for (const f of S.selection) if (f.file) f.bytes = null;
  S.saveToastShown = false;
  startInlineSaveWatch();
  startInlineFpsWatch();
  return true;
}

/* --------------------------------------------------------- worker msgs */
function onWorkerMessage(m) {
  if (!m) return;
  if (m.audio) { handleAudio(m); return; }
  switch (m.type) {
    case 'ready':
      S.log('[engine] ready');
      if (S.game && S.game.readyResolve) S.game.readyResolve(true);
      break;
    case 'log':
      if (m.msg) S.log((m.stream === 'stderr' ? '[err] ' : '') + m.msg);
      break;
    case 'abort':
      S.log('[ABORT] ' + m.reason);
      if (S.game && S.game.readyReject) S.game.readyReject(new Error('GZDoom aborted: ' + m.reason));
      else showFatal('GZDoom stopped', String(m.reason), S.logLines.slice(-25).join('\n'));
      break;
    case 'error':
      S.log('[engine error] ' + (m.message || ''));
      if (m.stack && new URLSearchParams(location.search).has('dev')) S.log('[stack] ' + String(m.stack).split('\n').slice(0, 6).join(' | '));
      if (S.game && S.game.readyReject) S.game.readyReject(new Error(m.message || 'Engine error'));
      break;
    case 'frame-stats':
      S.stats = m;
      updateFps(m);
      break;
    case 'fs-ready':
      S.log('[saves] watching the config tree (' + m.count + ' existing files)');
      refreshSaveUI();
      break;
    case 'fs-changed':
      saveFiles(m.files, m.deleted);
      break;
    case 'fs-all':
      if (S.fsAllWaiter) { const r = S.fsAllWaiter; S.fsAllWaiter = null; r(m.files || []); }
      break;
    case 'engine-exit':
      onEngineExit(m.code);
      break;
    case 'gl-lost':
      S.log('[gl] the browser lost the GPU context' + (m.reason ? ': ' + m.reason : ''));
      toast('The browser took the GPU context away from the game. Press “Back to launcher”, then start it again.', 'err', 9000);
      break;
    case 'gl-released':
      break;
    default:
      break;
  }
}
function onEngineExit(code) {
  if (!S.game) return;
  S.log('[engine] session ended (' + code + ')');
  setTimeout(() => {
    endGame();
    toast('GZDoom closed. Saves captured so far are in browser storage.', '', 5200);
  }, 600);
}

/* --------------------------------------------------------------- audio */
function ensureAudio() {
  if (S.audio.ctx) {
    if (S.audio.ctx.state === 'suspended') S.audio.ctx.resume().catch(() => {});
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = S.settings.volume;
    master.connect(ctx.destination);
    S.audio.ctx = ctx;
    S.audio.master = master;
    ctx.resume().catch(() => {});
    S.log('[audio] context ' + ctx.state);
  } catch (e) {
    S.log('[audio] failed: ' + e.message);
  }
}
// Scheduling lead for the first chunk of a source. Later chunks of a stream are
// queued back-to-back behind the previous one, so this only affects attack
// latency, not steady-state music.
const AUDIO_LEAD = 0.04;
// How long after a chunk's last sample a new chunk for the same AL source still
// counts as a continuation of that stream rather than a fresh one-shot.
const STREAM_JOIN = 0.2;

function audioGainValue(m) {
  return (typeof m.gain === 'number' && isFinite(m.gain)) ? m.gain : 1;
}
function audioStream(m) {
  // One GainNode per AL source id, reused by every chunk it plays. Music is a
  // single AL source fed 0.5 s buffers forever; rebuilding a node graph per
  // chunk was pure garbage on the main thread.
  const key = m.streamId || m.sourceId;
  let st = S.audio.sources.get(key);
  if (!st) {
    const gain = S.audio.ctx.createGain();
    gain.gain.value = audioGainValue(m);
    gain.connect(S.audio.master);
    st = { gain, nodes: new Set(), lastEnd: 0 };
    S.audio.sources.set(key, st);
  } else if (st.gain.gain.value !== audioGainValue(m)) {
    st.gain.gain.value = audioGainValue(m);
  }
  return st;
}

function handleAudio(m) {
  const ctx = S.audio.ctx;
  if (!ctx || !S.audio.master) return;
  switch (m.audio) {
    case 'play': {
      const frames = m.ch0 && m.ch0.length;
      if (!frames) return;
      const channels = m.channels || 1;
      const rate = m.sampleRate || ctx.sampleRate;
      const rateMul = m.playbackRate || 1;
      const buf = ctx.createBuffer(channels, frames, rate);
      buf.copyToChannel(m.ch0, 0);
      if (channels > 1 && m.ch1) buf.copyToChannel(m.ch1, 1);

      const st = audioStream(m);
      const now = ctx.currentTime;
      const offset = m.offset || 0;
      const dur = m.loop ? Infinity : Math.max(0, buf.duration - offset) / rateMul;
      let when;
      if (m.loop) {
        // Looping sounds can overlap themselves; they never chain.
        when = now + AUDIO_LEAD;
      } else if (st.lastEnd && st.lastEnd > now - STREAM_JOIN) {
        // The source is still sounding, or just finished: chain this chunk
        // exactly behind it. Music arrives this way, one buffer at a time, and
        // chaining keeps the Web Audio queue ahead of the engine's timeline so
        // there is no seam, overlap or restart at each buffer boundary.
        when = Math.max(st.lastEnd, now + 0.005);
      } else {
        when = now + AUDIO_LEAD;
      }
      if (!m.loop) st.lastEnd = when + dur;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rateMul;
      src.loop = !!m.loop;
      if (m.loop && m.loopEnd) { src.loopStart = Math.max(0, m.loopStart || 0); src.loopEnd = m.loopEnd; }
      src.connect(st.gain);
      try { src.start(when, offset); } catch (_) { try { src.start(0, offset); } catch (__) {} }
      st.nodes.add(src);
      src.onended = () => { st.nodes.delete(src); };
      break;
    }
    case 'stop': {
      const key = m.streamId || m.sourceId;
      const st = S.audio.sources.get(key);
      if (st) {
        for (const src of st.nodes) {
          try { src.onended = null; src.stop(0); } catch (_) {}
          try { src.disconnect(); } catch (_) {}
          try { src.buffer = null; } catch (_) {}
        }
        try { st.gain.disconnect(); } catch (_) {}
        S.audio.sources.delete(key);
      }
      break;
    }
    default: break;
  }
}
function stopAudio() {
  for (const st of S.audio.sources.values()) {
    for (const src of st.nodes) {
      try { src.onended = null; src.stop(0); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      // Drop the PCM now: an AudioBuffer is the largest thing a source holds
      // and the context keeps finished sources reachable until it is closed.
      try { src.buffer = null; } catch (_) {}
    }
    try { st.gain.disconnect(); } catch (_) {}
  }
  S.audio.sources.clear();
  // The context itself keeps every node and buffer it has played. Leaving it
  // open across sessions accumulated six listeners (the ended-handlers) per
  // launch and held their buffers; a fresh context is created on the next
  // launch by ensureAudio().
  const ctx = S.audio.ctx;
  S.audio.ctx = null;
  S.audio.master = null;
  if (ctx && ctx.state !== 'closed') { try { ctx.close(); } catch (_) {} }
}

/* ---------------------------------------------------------------- FPS */
function updateFps(m) {
  if (!S.settings.fps) return;
  const win = m.win1s || {};
  // A second with no presented frame is worth showing as 0 rather than leaving
  // the last number on screen: that stale reading is what makes a stopped
  // engine look healthy.
  const fps = win.frames ? win.fps : 0;
  const el = $('#game-fps');
  const text = fps.toFixed(0) + ' FPS';
  el.hidden = false;
  if (el.textContent !== text) el.textContent = text;
  // The engine can draw faster than the screen shows: the compositor samples
  // the canvas at the refresh rate, so the tooltip says both numbers.
  el.title = 'engine frames · slowest frame ' + (m.win1s.max || 0).toFixed(1) + ' ms · ' +
    (m.totalFrames || 0) + ' frames' + (S.displayHz ? ' · screen ' + S.displayHz + ' Hz' : '');
}

/* The in-page engine reports no frame statistics (it has no worker), so the
 * driver counts the frames it presents and this turns that into the same
 * readout the worker engines produce. */
function framesNow() {
  try { return window.GZ414 && window.GZ414.frames ? window.GZ414.frames() : 0; } catch (_) { return 0; }
}
function stopInlineFpsWatch() {
  if (S.fpsTimer) { clearInterval(S.fpsTimer); S.fpsTimer = null; }
  const el = $('#game-fps');
  if (el) el.hidden = true;
}
function startInlineFpsWatch() {
  stopInlineFpsWatch();
  const el = $('#game-fps');
  if (!el || !S.settings.fps || !S.game) return;
  let last = framesNow();
  let t = performance.now();
  el.hidden = false;
  el.textContent = '-- FPS';
  el.title = 'frames presented by the in-page engine';
  S.fpsTimer = setInterval(() => {
    if (!S.game) { stopInlineFpsWatch(); return; }
    const n = framesNow();
    const now = performance.now();
    const dt = (now - t) / 1000;
    if (dt < 0.4) return;
    const fps = (n - last) / dt;
    last = n; t = now;
    if (!(fps >= 0)) return;
    const text = fps.toFixed(0) + ' FPS';
    el.hidden = false;
    if (el.textContent !== text) el.textContent = text;
  }, 500);
}

/* --------------------------------------------------------------- input */
function uiModalOpen() {
  return !!document.querySelector('.modal:not([hidden])');
}
function bindInput(canvas, signal) {
  const opts = { capture: true, signal };
  const send = (msg) => { if (S.worker) S.worker.postMessage(msg); };
  const keyInit = (e) => ({
    code: e.code, key: e.key, keyCode: e.keyCode, which: e.which,
    charCode: e.charCode || 0, repeat: !!e.repeat,
    shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
    location: e.location, bubbles: true, cancelable: true,
  });
  const onKeyDown = (e) => {
    if (uiModalOpen()) return;
    if (e.altKey && e.code === 'Enter') { e.preventDefault(); toggleFullscreen(); return; }
    send({ type: 'input', target: 'window', evType: 'keydown', init: keyInit(e) });
    if (document.pointerLockElement === canvas) e.preventDefault();
  };
  const onKeyUp = (e) => {
    if (uiModalOpen()) return;
    send({ type: 'input', target: 'window', evType: 'keyup', init: keyInit(e) });
  };
  const onKeyPress = (e) => {
    if (uiModalOpen()) return;
    // SDL's text input path (console, player name entry) consumes keypress.
    send({ type: 'input', target: 'window', evType: 'keypress', init: keyInit(e) });
  };
  // The worker routes keyboard events to its window shim, so forward once.
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('keyup', onKeyUp, opts);
  window.addEventListener('keypress', onKeyPress, opts);

  const mouseInit = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, r.width);
    const sy = canvas.height / Math.max(1, r.height);
    return {
      clientX: (e.clientX - r.left) * sx, clientY: (e.clientY - r.top) * sy,
      offsetX: (e.offsetX || 0) * sx, offsetY: (e.offsetY || 0) * sy,
      movementX: e.movementX || 0, movementY: e.movementY || 0,
      button: e.button, buttons: e.buttons,
      deltaX: e.deltaX || 0, deltaY: e.deltaY || 0, deltaZ: e.deltaZ || 0, deltaMode: e.deltaMode || 0,
      shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
      bubbles: true, cancelable: true,
    };
  };
  const mouse = (type) => (e) => {
    if (type === 'wheel') e.preventDefault();
    send({ type: 'input', target: 'canvas', evType: type, init: mouseInit(e) });
  };
  canvas.addEventListener('mousedown', mouse('mousedown'), { signal });
  canvas.addEventListener('mouseup', mouse('mouseup'), { signal });
  canvas.addEventListener('mousemove', mouse('mousemove'), { signal });
  // Wheel: forward the real event (harmless, and correct if a future engine
  // build does register SDL wheel input), then replay the notch as the two
  // keys bound to weapon cycling above. Emscripten's SDL2 here has no 'wheel'
  // listener at all, so without this a scroll does nothing.
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    send({ type: 'input', target: 'canvas', evType: 'wheel', init: mouseInit(e) });
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = (e.deltaY || 0) * scale;
    if (!dy) return;
    if (Math.sign(dy) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAcc += dy;
    if (Math.abs(wheelAcc) < 40) return;   // ~one notch, whatever the device
    const next = wheelAcc > 0;
    wheelAcc = 0;
    const init = next
      ? { code: 'BracketRight', key: ']', keyCode: 221, which: 221, charCode: 0, bubbles: true, cancelable: true }
      : { code: 'BracketLeft', key: '[', keyCode: 219, which: 219, charCode: 0, bubbles: true, cancelable: true };
    send({ type: 'input', target: 'window', evType: 'keydown', init });
    setTimeout(() => send({ type: 'input', target: 'window', evType: 'keyup', init }), 30);
  }, { passive: false, signal });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  }, { signal });

  const lockChange = () => {
    const locked = document.pointerLockElement === canvas;
    $('#game').classList.toggle('locked', locked);
    $('#pointer-hint').hidden = locked || $('#game').hidden;
    send({ type: 'pointerlock', locked });
    if (!locked) $('#pointer-hint').hidden = false;
    if (locked) {
      clearTimeout(S.hintTimer);
      $('#game-hint').style.opacity = '0';
    }
  };
  document.addEventListener('pointerlockchange', lockChange, { signal });
  document.addEventListener('pointerlockerror', () => toast('Pointer lock was refused — click the game again.', 'err'), { signal });

  const vis = () => send({ type: 'visibility', state: document.visibilityState });
  document.addEventListener('visibilitychange', vis, { signal });
  window.addEventListener('blur', () => send({ type: 'input', target: 'window', evType: 'blur', init: {} }), { signal });
  window.addEventListener('focus', () => send({ type: 'input', target: 'window', evType: 'focus', init: {} }), { signal });

  window.addEventListener('gamepadconnected', () => {
    toast('Gamepad connected. GZDoom reads it directly; mapping is in the GZDoom menu.', '', 5200);
  }, { signal });
}

/* Input for an engine that runs on the page itself (GZDoom 4.14.2).
 *
 * Unlike the worker build, this one has no event bridge: the engine's own
 * Emscripten listeners are attached to the real DOM, so key and button events
 * arrive on their own. What does not happen on its own is pointer lock. This
 * build never acquires it, so the browser keeps reporting absolute cursor
 * coordinates in clientX/clientY and zero movementX/movementY, and GZDoom
 * throws mouse motion and clicks away while the mouse is uncaptured. Asking
 * for the lock from this click - a real user gesture - is what turns on
 * relative motion; after that the engine's existing handlers work. */
function bindInlineInput(canvas, signal) {
  const isLocked = () => document.pointerLockElement === canvas;
  const lock = () => {
    if (isLocked()) return;
    // Plain lock, exactly like the worker engines. Asking for
    // { unadjustedMovement: true } returns raw device deltas instead of the
    // browser's screen-normalised ones; on X11 those come straight from evdev,
    // where +Y points up, so vertical look was inverted on this engine only
    // (horizontal, and every other engine here, were fine).
    let p;
    try { p = canvas.requestPointerLock(); } catch (_) { p = null; }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };

  canvas.addEventListener('click', lock, { signal });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  // Some browsers deliver the click that starts the game to the control that
  // launched it; a click anywhere on the game layer then still captures.
  $('#game').addEventListener('mousedown', (e) => {
    if (e.target === canvas || e.target === $('#stage')) lock();
  }, { signal });

  const onLockChange = () => {
    const on = isLocked();
    $('#game').classList.toggle('locked', on);
    $('#pointer-hint').hidden = on || $('#game').hidden;
    if (on) {
      clearTimeout(S.hintTimer);
      $('#game-hint').style.opacity = '0';
    }
  };
  document.addEventListener('pointerlockchange', onLockChange, { signal });
  // A failed request is not always fatal: the unadjusted-movement request
  // rejects on platforms that do not implement it, and the plain request that
  // follows immediately succeeds. Only complain when no lock arrived.
  document.addEventListener('pointerlockerror', () => {
    setTimeout(() => {
      if (!isLocked()) toast('The browser refused to capture the mouse. Click the game area again.', 'err');
    }, 500);
  }, { signal });

  window.addEventListener('keydown', (e) => {
    if (uiModalOpen()) return;
    if (e.altKey && e.code === 'Enter') { e.preventDefault(); toggleFullscreen(); }
  }, { capture: true, signal });
}

/* --------------------------------------------------------------- game UI */
function enterGameUi() {
  $('#launcher').hidden = true;
  $('#game').hidden = false;
  $('#pointer-hint').hidden = true;
  $('#game').classList.remove('locked');
  const hint = $('#game-hint');
  hint.style.opacity = '1';
  clearTimeout(S.hintTimer);
  S.hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, 7000);
  document.body.style.overflow = 'hidden';
}
function exitGameUi() {
  stopInlineFpsWatch();
  $('#game').hidden = true;
  $('#launcher').hidden = false;
  document.body.style.overflow = '';
  $('#pointer-hint').hidden = true;
  $('#game-fps').hidden = true;
  $('#game-hint').style.opacity = '1';
  clearTimeout(S.hintTimer);
  $('#game').classList.remove('locked');
}
function requestFullscreen() {
  if (document.fullscreenElement) return Promise.resolve();
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  return Promise.reject(new Error('fullscreen unavailable'));
}
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    requestFullscreen().catch((e) => toast('Fullscreen is unavailable: ' + e.message, 'err'));
  }
}

async function requestFsAll(timeout = 1800) {
  if (!S.worker) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; S.fsAllWaiter = null; resolve(v); } };
    S.fsAllWaiter = finish;
    try { S.worker.postMessage({ type: 'fs-get-all' }); } catch (_) { finish(null); }
    setTimeout(() => finish(null), timeout);
  });
}
async function endGame(opts = {}) {
  const game = S.game;
  if (!game) { exitGameUi(); return; }
  if (game.inline) {
    // The in-page engine has no worker to terminate, and its wasm runtime
    // cannot be started twice in one tab, so: capture the saves it wrote into
    // MEMFS, drop the canvas, then reload into a clean launcher.
    stopInlineSaveWatch();
    stopInlineFpsWatch();
    if (window.GZ414 && !opts.skipSnapshot) {
      try {
        const found = window.GZ414.exportSaves();
        const rows = Object.entries(found).map(([key, data]) => ({ key, data, mtime: Date.now() }));
        if (rows.length) await saveFiles(rows, []);
        S.log('[saves] exported ' + rows.length + ' file(s) from ' + (game.displayName || 'the game'));
      } catch (e) { S.log('[saves] export failed: ' + e.message); }
    }
    game.abort.abort();
    exitGameUi();
    $('#stage').textContent = '';
    S.game = null;
    S.stats = null;
    // A finished session reloads the tab: this engine's wasm runtime cannot be
    // started twice in one. A failed boot arrives here from launch()'s catch
    // through the same call, and reloading there replaced the fatal screen the
    // player needs with a silent return to the launcher.
    if (!opts.skipSnapshot) { location.reload(); return; }
    refreshSaveUI();
    updateStartState();
    return;
  }
  const worker = game.worker;
  if (worker && !opts.skipSnapshot) {
    try {
      const files = await requestFsAll(1500);
      if (files && files.length) await saveFiles(files, []);
    } catch (_) {}
  }
  game.abort.abort();
  await releaseWorkerGl(worker);
  try { worker.terminate(); } catch (_) {}
  if (S.workerUrl) { URL.revokeObjectURL(S.workerUrl); S.workerUrl = null; }
  stopAudio();
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (_) {} }
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) {} }
  $('#stage').textContent = '';
  S.game = null;
  S.worker = null;
  S.stats = null;
  // Back at the launcher with no engine loaded: the base64 bundles are the
  // biggest thing this page still holds (tens of MB of text), so let them go.
  releasePackedGlobals();
  exitGameUi();
  refreshSaveUI();
  updateStartState();
}

async function quitToLauncher() {
  if (!S.game) return;
  askConfirm('Leave the game?', 'Progress that GZDoom has already saved is kept. Anything only in memory (current level state, unsaved settings changes) is lost.', async () => {
    showBoot();
    setBoot('Saving session…', 50, 'copying save files from the engine');
    await endGame();
    hideBoot();
    refreshSaveUI();
    toast('Session closed. Save files remain in browser storage.', 'ok');
  });
}

/* ------------------------------------------------------------- save I/O */
/* One profile per (engine, exact file set). Rows are stored as
 * 'prof/<profile>/saves/<game>/slot.zds'; the engine only ever sees the part
 * after the profile folder, so nothing from another engine or another WAD set
 * can be restored into the save root this launch. */
function saveProfileId(engineId, gameKey) {
  const s = String(engineId) + '|' + String(gameKey || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const slug = String(gameKey || '').split('|')[0]
    .replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '').slice(0, 12).toLowerCase() || 'game';
  return String(engineId) + '-' + slug + '-' + (h >>> 0).toString(36);
}
// Insert this engine's prefix after the folder part: 'saves/x.zds' becomes
// 'saves/uz-x.zds', then the profile folder goes in front of everything.
function toStoreKey(key) {
  if (!key) return key;
  let k = key;
  const p = S.savePrefix;
  if (p) {
    const i = k.indexOf('/');
    const folder = i < 0 ? '' : k.slice(0, i + 1);
    // Config file names already differ per engine (gzdoom.ini / uzdoom.ini).
    if (folder !== 'config/') k = i < 0 ? p + k : folder + p + k.slice(i + 1);
  }
  return S.profile ? 'prof/' + S.profile + '/' + k : k;
}
// Reverse of toStoreKey; '' means "belongs to another engine or another game".
function fromStoreKey(key) {
  if (!S.profile || !key) return '';
  const pre = 'prof/' + S.profile + '/';
  if (!key.startsWith(pre)) return '';
  key = key.slice(pre.length);
  const p = S.savePrefix;
  const i = key.indexOf('/');
  const folder = i < 0 ? '' : key.slice(0, i + 1);
  const name = i < 0 ? key : key.slice(i + 1);
  if (!folder || !/^(saves|screenshots|config)\//.test(folder)) return '';
  if (!p || folder === 'config/') return key;
  return name.startsWith(p) ? folder + name.slice(p.length) : '';
}
/* Everything stored before profiles existed (1.6.1 and earlier), plus archives
 * imported before a game was picked, sits outside a profile folder. The first
 * launch that matches a row's game takes it in: GZDoom names its save folders
 * after the game ('doom.doom2'), so the IWAD's base name identifies
 * them. Rows for other games stay untouched, for their own next launch. */
async function adoptUnprofiledSaves(iwadStored) {
  if (!S.profile) return 0;
  const base = String(iwadStored).replace(/\.[^.]+$/, '').toLowerCase();
  let keys = [];
  try { keys = await store.keys('files'); } catch (_) { return 0; }
  let n = 0;
  for (const key of keys) {
    // Decide from the key alone. Reading the body first only to discover that
    // the row belongs to another game pulled every stored save into the page on
    // every launch - the multi-megabyte read the profile folders exist to
    // avoid. `store.keys()` already returns the row keys.
    let rest = '';
    if (key.startsWith('prof/_imported/')) rest = key.slice('prof/_imported/'.length);
    else if (!key.startsWith('prof/')) rest = key;
    if (!rest) continue;
    const m = /^(saves|screenshots)\/([^/]+)\/(.+)$/.exec(rest);
    if (m) {
      // Match the game folder narrowly: identity words plus the IWAD's base
      // name and nothing else. GZDoom appends every loaded file to the folder,
      // so 'doom.doom2.<mod>' must NOT be adopted by a plain Doom II launch -
      // that is the mixed-game load this whole change exists to stop.
      const folder = m[2].toLowerCase().replace(/^uz-/, '');
      const identity = { doom: 1, doom2: 1, freedoom: 1, heretic: 1, hexen: 1, strife: 1 };
      const segs = folder.split('.').filter(Boolean);
      const words = segs.filter((s) => !identity[s]);
      // These engines name the folder '<game>.<iwad>' - 'doom.doom2' for Doom
      // II - so the IWAD's base name is the LAST identity segment, not the
      // whole folder. Comparing the whole folder to the base only ever adopted
      // a bare 'doom2' folder, which the engines do not write, so a legacy save
      // set from a plain no-add-on launch was never adopted at all. An add-on
      // appends its own name after that segment; those rows stay put on purpose.
      const plain = words.length === 0 && segs[segs.length - 1] === base;
      const baseOnly = words.length === 1 && words[0] === base;
      if (!plain && !baseOnly) continue;
    } else if (!/^config\//.test(rest)) continue;
    let r = null;
    try { r = await store.get('files', key); } catch (_) { continue; }
    if (!r || !r.data) continue;
    // Normalise the destination: drop the folder's uz- prefix and add this
    // engine's prefix to the file name.
    if (m) {
      const p = S.savePrefix || '';
      let name = m[2].replace(/^uz-/, '');
      if (p && !name.startsWith(p)) name = p + name;
      rest = m[1] + '/' + name + '/' + m[3];
    }
    try {
      await store.put('files', { key: 'prof/' + S.profile + '/' + rest, data: r.data, mtime: r.mtime || Date.now() });
      await store.del('files', key);
      n++;
    } catch (_) { /* keep the original row */ }
  }
  return n;
}

async function saveFiles(files, deleted) {
  let n = 0;
  for (const f of files || []) {
    try {
      await store.put('files', { key: toStoreKey(f.key), data: f.data, mtime: f.mtime || Date.now() });
      n++;
    } catch (e) { S.log('[saves] store failed for ' + f.key + ': ' + e.message); }
  }
  for (const k of deleted || []) {
    try { await store.del('files', toStoreKey(k)); } catch (_) {}
  }
  if (n) {
    const touchedSave = (files || []).some((f) => f.key.startsWith('saves/'));
    if (touchedSave) {
      S.lastSaveAt = Date.now();
      store.put('meta', { id: 'lastSaveAt', value: S.lastSaveAt }).catch(() => {});
      if (!S.saveToastShown && S.game) {
        S.saveToastShown = true;
        toast('Save captured — stored in this browser. Export it to carry it on the USB.', 'ok', 6500);
      }
    }
    refreshSaveUI();
  }
  return n;
}
/* ------------------------------------------------- saves while playing */
/* The in-page engine (4.14.2) has no worker whose filesystem the launcher can
 * poll: its saves live in the page's own MEMFS and used to be read only when
 * you left the game. So a save made mid-game looked like nothing happened, and
 * leaving the page before quitting lost it. Poll the driver instead, store what
 * changed, and keep playing - no reload, no exit. */
let inlineSigs = new Map();
function stopInlineSaveWatch() {
  if (S.inlineWatch) { clearInterval(S.inlineWatch); S.inlineWatch = null; }
}
/* Read the in-page engine's save tree and store whatever changed since the last
 * look. Returns the number of rows written. Also called when the page becomes
 * hidden: Chromium slows timers in hidden tabs (to roughly once a second, and
 * to once a minute after five minutes hidden), so without that second caller a
 * save made just before the window is minimised could wait for the slow poll -
 * or be lost if the tab is then closed. */
async function captureInlineSaves() {
  if (!S.game || !S.game.inline || !window.GZ414) return 0;
  // Stat first, read only what changed. The old version read every save and
  // hashed its bytes to notice changes - megabytes of copying every two
  // seconds on the same thread the in-page engine renders on.
  let stats = null;
  try { stats = window.GZ414.saveStats(); } catch (_) { return 0; }
  const changed = [];
  for (const [key, sig] of Object.entries(stats || {})) {
    if (inlineSigs.get(key) === sig) continue;
    inlineSigs.set(key, sig);
    changed.push(key);
  }
  if (!changed.length) return 0;
  let found = null;
  try { found = window.GZ414.exportSaves(changed); } catch (_) { return 0; }
  const rows = [];
  for (const key of changed) {
    const data = found && found[key];
    if (data && data.length) rows.push({ key, data, mtime: Date.now() });
  }
  if (!rows.length) return 0;
  await saveFiles(rows, []);
  S.log('[saves] captured ' + rows.map((r) => r.key).join(', '));
  return rows.length;
}
function startInlineSaveWatch() {
  stopInlineSaveWatch();
  inlineSigs = new Map();
  S.inlineWatch = setInterval(captureInlineSaves, 2000);
  if (!S.inlineHideHook) {
    S.inlineHideHook = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') captureInlineSaves();
    });
  }
}
/* Hand the worker's WebGL context back before the page terminates it. A
 * terminated worker's context is not freed until the GPU process notices, and
 * the next engine could then fail to get a WebGL2 context at all - which used
 * to surface as the "enable hardware acceleration" screen. */
function releaseWorkerGl(worker) {
  return new Promise((resolve) => {
    if (!worker) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const onMsg = (e) => { if (e.data && e.data.type === 'gl-released') finish(); };
    try { worker.addEventListener('message', onMsg); } catch (_) {}
    try { worker.postMessage({ type: 'release-gl' }); } catch (_) { finish(); return; }
    setTimeout(finish, 500);
  });
}
let saveUiTimer = null;
function refreshSaveUI() {
  clearTimeout(saveUiTimer);
  saveUiTimer = setTimeout(doRefreshSaveUI, 120);
}
async function doRefreshSaveUI() {
  // Keys only: loading every save body just to count them could pull tens of
  // megabytes into the page on a long-lived install.
  let keys = [];
  try { keys = await store.keys('files'); } catch (_) {}
  const saves = keys.filter((k) => /(^|\/)saves\//.test(k));
  let latest = S.lastSaveAt || 0;
  if (!latest) {
    try { const rec = await store.get('meta', 'lastSaveAt'); latest = (rec && rec.value) || 0; } catch (_) {}
  }
  $('#save-count').textContent = String(saves.length);
  $('#save-last').textContent = latest ? fmtAgo(latest) : (saves.length ? 'stored' : '—');
  $('#save-count').title = saves.map((k) => k.replace(/^prof\/[^/]+\//, '').replace(/^saves\//, '')).join('\n') || 'No saves yet';
  const white = $('#storage-where'), dot = $('#storage-dot');
  if (S.dbOk) {
    white.innerHTML = 'Browser storage · <b>this computer</b>';
    dot.className = 'dot ' + (saves.length ? 'ok' : 'warn');
    $('#footer-note').textContent = 'Saves are in this browser. Export them to move to another computer.';
  } else {
    white.innerHTML = 'Memory only · <b>lost when this tab closes</b>';
    dot.className = 'dot bad';
    $('#footer-note').textContent = 'This browser blocked IndexedDB. Export saves before closing the tab.';
  }
  updateQuotaHint();
}
async function updateQuotaHint() {
  const el = $('#quota-hint');
  if (!el) return;
  if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
  try {
    const est = await navigator.storage.estimate();
    el.textContent = 'Browser storage used: ' + fmtBytes(est.usage || 0) + ' of ~' + fmtBytes(est.quota || 0) + ' available.';
  } catch (_) { el.textContent = ''; }
}

/* -------------------------------------------------------------- recent */
function gameId(iwadStored, pwads, totalBytes) {
  return ([iwadStored].concat(pwads || []).join('|') + ':' + (totalBytes || 0)).toLowerCase();
}
/* Write this game's bytes to IndexedDB for the recent-games list. Cloned by the
 * store, so no copy is made here; bails out when the quota is too tight. */
async function cacheGameFiles({ id, iwadStored, pwadsStored, iwadEntry, pwads, totalBytes }) {
  try {
    // Re-writing the same megabytes on every launch is pure churn. The key
    // includes the names and sizes, and the game row is only marked cached
    // after a complete write, so a cached row already holds these files.
    const known = await store.get('games', id);
    if (known && known.cached) return true;
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota && (est.quota - (est.usage || 0)) <= totalBytes + 120 * 1048576) return false;
    }
    const entries = [
      { name: iwadStored, role: 'iwad', data: iwadEntry.bytes.buffer },
      ...pwads.map((f, i) => ({ name: pwadsStored[i], role: 'pwad', data: f.bytes.buffer })),
    ];
    await store.put('gamedata', { id, entries });
    return true;
  } catch (e) {
    S.log('[recent] ' + e.message);
    return false;
  }
}
async function rememberGame({ iwadEntry, pwads, iwadStored, pwadsStored, displayName, totalBytes, cached }) {
  try {
    const id = gameId(iwadStored, pwadsStored, totalBytes);
    const stored = !!cached;
    const record = {
      id,
      label: displayName + (pwads.length ? ' + ' + pwads.length + ' add-on' + (pwads.length > 1 ? 's' : '') : ''),
      displayName,
      iwadName: iwadStored,
      pwadNames: pwadsStored,
      engine: S.engineId,
      when: Date.now(),
      cached: stored,
    };
    await store.put('games', record);
    await pruneRecent();
    renderRecent();
    if (!stored && S.settings.cache && totalBytes > 0) {
      S.log('[recent] game files not cached (size or quota)');
    }
  } catch (e) {
    S.log('[recent] ' + e.message);
    toast('Game files were not cached (storage is full). You can still reload them by picking the files again.', 'err', 6000);
  }
}
async function pruneRecent() {
  try {
    const rows = await store.all('games');
    rows.sort((a, b) => b.when - a.when);
    for (const r of rows.slice(10)) { await store.del('games', r.id); await store.del('gamedata', r.id); }
  } catch (_) {}
}
async function renderRecent() {
  const list = $('#recent-list');
  if (!list) return;
  let rows = [];
  try { rows = await store.all('games'); } catch (_) {}
  rows.sort((a, b) => b.when - a.when);
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<li class="muted small">Nothing yet.</li>';
    return;
  }
  for (const r of rows.slice(0, 7)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = '<span class="rname" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
      '<span class="rw">' + (r.cached ? '' : 'pick again · ') + fmtAgo(r.when) + '</span>';
    b.onclick = () => handleRecentClick(r);
    li.appendChild(b);
    list.appendChild(li);
  }
}

/* ----------------------------------------------------------------- ZIP */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
}
function buildZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = dosTime(now), date = dosDate(now);
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);       // UTF-8 names
    dv.setUint16(8, 0, true);            // stored
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  // The end-of-directory record is 22 bytes, so anything shorter cannot be a
  // ZIP; without this the search below starts at a negative offset and throws
  // a DataView range error instead of the friendly message.
  if (u8.length < 22) throw new Error('Not a ZIP archive (the file is too small).');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const start = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= start; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (end-of-directory record missing).');
  const count = dv.getUint16(eocd + 10, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff >= u8.length) throw new Error('ZIP central directory is out of range.');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    let data = u8.subarray(dataOff, dataOff + csize);
    if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method !== 0) {
      continue;
    }
    out.push({ name, data });
  }
  return out;
}

function normalizeImportKey(name) {
  let n = String(name).replace(/\\/g, '/').replace(/^\.?\//, '');
  if (n.startsWith('__MACOSX/') || n.endsWith('/')) return null;
  if (n.includes('..')) return null;
  // Archives written by 1.6.2 and later already carry the profile folder.
  if (/^prof\/[^/]+\/(saves|screenshots|config)\//.test(n)) return n;
  // Older archives (and hand-made ZIPs) keep a profile-less layout: park them
  // outside any game, where the next launch that matches the game takes them in.
  const prof = 'prof/' + (S.profile || '_imported') + '/';
  if (n.startsWith('saves/') || n.startsWith('config/') || n.startsWith('screenshots/')) return prof + n;
  if (n.startsWith('savegames/')) return prof + 'saves/' + n.slice('savegames/'.length);
  if (n === 'gzdoom.ini') return prof + 'config/gzdoom.ini';
  return null;
}

/* ------------------------------------------------------------ exporting */
async function collectSaveFiles() {
  let files = null;
  if (S.worker) {
    // A live worker reports bare engine paths; store them with this launch's
    // profile so an archive exported mid-session keys like every other row.
    const live = await requestFsAll(2200);
    if (live) files = live.map((f) => ({ key: toStoreKey(f.key), data: f.data, mtime: f.mtime }));
  } else if (S.game && S.game.inline && window.GZ414) {
    // The in-page engine keeps its saves in its own MEMFS, and the watcher only
    // copies them out every couple of seconds: a save written just before the
    // player pressed Export was not in the store yet. Ask the engine for its
    // tree, as the worker path does, and merge it over this profile's stored
    // rows so config/ and screenshots/ entries the tree does not cover stay in
    // the archive.
    let found = null;
    try { found = window.GZ414.exportSaves(); } catch (_) { found = null; }
    if (found) {
      const pre = S.profile ? 'prof/' + S.profile + '/' : '';
      const byKey = new Map();
      let keys = [];
      try { keys = await store.keys('files'); } catch (_) {}
      for (const k of keys) {
        if (pre && !k.startsWith(pre)) continue;
        let r = null;
        try { r = await store.get('files', k); } catch (_) { continue; }
        if (!r || !r.data) continue;
        byKey.set(k, { key: k, data: r.data, mtime: r.mtime });
      }
      for (const [key, data] of Object.entries(found)) {
        if (!data || !data.length) continue;
        const k = toStoreKey(key);
        byKey.set(k, { key: k, data, mtime: Date.now() });
      }
      files = Array.from(byKey.values());
    }
  }
  if (!files) {
    const rows = await store.all('files');
    files = rows.filter((r) => r.data).map((r) => ({ key: r.key, data: r.data, mtime: r.mtime }));
  }
  return (files || []).sort((a, b) => a.key.localeCompare(b.key));
}
async function exportSaves() {
  const files = await collectSaveFiles();
  if (!files.length) {
    toast('No saves or config files have been created yet. Start a game and save once.', '', 5200);
    return;
  }
  const manifest = new TextEncoder().encode(
    'GZDoom Portable save archive\n' +
    'Created: ' + new Date().toISOString() + '\n' +
    'App: ' + APP_VERSION + ' · ' +
    (window.GZ_ENGINES && currentEngine() ? GZ_ENGINES.label(currentEngine()) : 'GZDoom') + '\n\n' +
    'Contents are relative to GZDoom\'s config directory: saves/, config/, screenshots/.\n' +
    'Put this ZIP in the backups/ folder on the USB drive. Import it on another\n' +
    'computer with the Import saves button. Saves are not written to the USB by\n' +
    'the browser automatically.\n'
  );
  const settingsJson = JSON.stringify({ app: 'gzdoom-portable', version: APP_VERSION, settings: S.settings }, null, 1);
  const entries = [
    { name: 'README.txt', data: manifest },
    { name: 'config/portable-settings.json', data: new TextEncoder().encode(settingsJson) },
  ];
  for (const f of files) entries.push({ name: f.key, data: f.data });
  const zip = buildZip(entries);
  const name = 'GZDoom-Portable-Saves-' + fmtDate().replace(/[: ]/g, '-') + '.zip';
  if (S.exportUrl) URL.revokeObjectURL(S.exportUrl);
  S.exportUrl = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));

  $('#export-summary').textContent = files.length + ' file(s), ' + fmtBytes(zip.length) + '. Saved ' + fmtDate();
  const ul = $('#export-files');
  ul.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = '<span>' + esc(f.key) + '</span><span>' + fmtBytes(f.data.byteLength || f.data.length) + '</span>';
    ul.appendChild(li);
  }
  const a = $('#export-download');
  a.href = S.exportUrl;
  a.download = name;
  openModal('export-modal');
  S.log('[export] ' + name + ' · ' + files.length + ' files · ' + zip.length + ' bytes');
}

async function importSaveArchive(file) {
  if (!file) return;
  try {
    setStatus('Reading archive ' + file.name + '…', '');
    // A profile-less archive is attached to the last game this browser played,
    // so an export/import round trip lands where it came from.
    if (!S.profile) {
      try {
        const lp = await store.get('meta', 'lastProfile');
        if (lp && lp.value && lp.value.profile) S.profile = lp.value.profile;
      } catch (_) {}
    }
    const entries = await unzip(await file.arrayBuffer());
    const usable = [];
    let settingsImported = false;
    for (const e of entries) {
      if (/(^|\/)portable-settings\.json$/.test(e.name)) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(e.data));
          if (parsed && parsed.settings && typeof parsed.settings === 'object') {
            const allowed = {};
            for (const k of Object.keys(DEFAULT_SETTINGS)) {
              if (k in parsed.settings) allowed[k] = parsed.settings[k];
            }
            Object.assign(S.settings, allowed);
            saveSettings();
            renderSettings();
            settingsImported = true;
          }
        } catch (_) {}
        continue;
      }
      const key = normalizeImportKey(e.name);
      if (key) usable.push({ key, data: e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) });
    }
    if (!usable.length && settingsImported) {
      toast('Imported launcher settings (the archive had no save files).', 'ok', 6000);
      setStatus('Imported launcher settings.', 'ok');
      refreshSaveUI();
      return;
    }
    if (!usable.length) throw new Error('No GZDoom save files were found in this archive.');
    let n = 0;
    for (const f of usable) {
      await store.put('files', { key: f.key, data: f.data, mtime: Date.now() });
      n++;
    }
    if (S.worker) {
      // The engine knows nothing about profiles: hand it bare paths, but only
      // for this launch's profile. Writing another game's or engine's saves
      // into the live MEMFS listed them in this session and the next save scan
      // then copied them into the running profile, which is the cross-game mix
      // the profile folders exist to prevent. Everything imported is stored, so
      // the files for other games load on their own next launch.
      const pre = S.profile ? 'prof/' + S.profile + '/' : '';
      const live = usable
        .filter((f) => !pre || f.key.startsWith(pre))
        .map((f) => ({ key: fromStoreKey(f.key) || f.key.replace(/^prof\/[^/]+\//, ''), data: f.data }));
      if (live.length) {
        S.worker.postMessage({ type: 'fs-write', files: live }, live.map((f) => f.data));
        toast('Imported ' + n + ' file(s). They are available in the GZDoom save menu now.', 'ok', 6000);
      } else {
        toast('Imported ' + n + ' file(s) for another game or engine. They load the next time you start it.', 'ok', 6500);
      }
    } else {
      toast('Imported ' + n + ' file(s). They will be loaded the next time you start GZDoom.' + (settingsImported ? ' Launcher settings were restored too.' : ''), 'ok', 6000);
    }
    refreshSaveUI();
    setStatus('Imported ' + n + ' save/config file(s).', 'ok');
  } catch (e) {
    toast('Import failed: ' + e.message, 'err', 8000);
    setStatus('Import failed: ' + e.message, 'err');
  }
}

/* ------------------------------------------------------------- settings UI */
function renderSettings() {
  const s = S.settings;
  // The record being edited belongs to one engine; say which one instead of
  // letting a resolution or bind change look global.
  const own = $('#settings-engine');
  if (own) {
    const engine = currentEngine();
    own.textContent = (engine && window.GZ_ENGINES ? GZ_ENGINES.label(engine) : 'This engine') +
      ' · kept separately for each engine';
  }
  $('#set-res').value = s.res;
  $('#set-filter').value = s.filter;
  const mode = s.fpsMode || 'uncapped';
  $('#set-fpsmode').value = mode;
  $('#set-maxfps').value = String(Number(s.maxfps) || 144);
  $('#set-maxfps-val').textContent = (Number(s.maxfps) || 144) + ' FPS';
  $('#fps-limit-row').hidden = mode !== 'custom';
  renderEngineLimits();
  $('#set-fullscreen').checked = !!s.fullscreen;
  $('#set-fps').checked = !!s.fps;
  $('#set-sens').value = String(s.sensitivity);
  $('#set-sens-val').textContent = Number(s.sensitivity).toFixed(2);
  $('#set-inverty').checked = !!s.invertY;
  $('#set-volume').value = String(s.volume);
  $('#set-volume-val').textContent = Math.round(s.volume * 100) + '%';
  $('#set-music').checked = !!s.music;
  $('#set-cache').checked = !!s.cache;
  renderBinds();
  updateQuotaHint();
}
/* The frame-rate modes mean the same thing on every engine. Two controls do
 * not, so the settings screen says which instead of pretending they all work
 * everywhere: the Renderer choice only exists in the 4.11.3 build. */
function renderEngineLimits() {
  const hint = document.querySelector('#fps-limit-row .hint');
  if (hint) {
    const hz = S.displayHz ? ' (this screen: ' + S.displayHz + ' Hz)' : '';
    hint.textContent = 'Only used when Frame rate is “Custom limit”. VSync caps every engine at the measured monitor refresh' + hz + '; Uncapped lets each engine run to its own limit.';
  }
}
function renderBinds() {
  const box = $('#binds');
  box.innerHTML = '';
  for (const [action, label, def] of BIND_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const key = (action in S.settings.binds) ? S.settings.binds[action] : def;
    row.innerHTML = '<span>' + esc(label) + '</span><button class="bind-btn">' + esc(key || '—') + '</button>';
    const b = row.querySelector('button');
    b.onclick = () => captureBind(b, action);
    box.appendChild(row);
  }
}
function captureBind(button, action) {
  button.classList.add('capturing');
  button.textContent = 'press a key…';
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', onKey, true);
    const name = keyNameFromEvent(e);
    if (!name) { renderBinds(); toast('That key cannot be bound.', 'err'); return; }
    S.settings.binds[action] = name;
    saveSettings();
    renderBinds();
  };
  window.addEventListener('keydown', onKey, true);
}
function keyNameFromEvent(e) {
  const code = e.code || '';
  const map = {
    Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Backspace: 'backspace',
    Escape: 'escape', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow', ArrowRight: 'rightarrow',
    ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift',
    AltLeft: 'alt', AltRight: 'alt', CapsLock: 'capslock', Insert: 'ins', Delete: 'del',
    Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
  };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return 'kp' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return null;
}

/* ------------------------------------------------------------- log pane */
S.log = (line) => {
  const clean = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  if (!clean.trim()) return;
  S.logLines.push(clean);
  if (S.logLines.length > 400) S.logLines.splice(0, S.logLines.length - 400);
};
function renderLog() {
  const el = $('#eng-log');
  if (!el) return;
  el.textContent = S.logLines.length ? S.logLines.slice(-200).join('\n') : 'No engine output yet.';
  el.scrollTop = el.scrollHeight;
}

/* ----------------------------------------------------------------- init */
async function init() {
  S.caps = await detectCaps();
  // A remembered id from a build that no longer ships that entry must not leave
  // the launcher showing "Unknown engine" with Start disabled and nothing to
  // click out of it: fall back to the first engine this browser can actually
  // run, and let the engine log say why the choice changed.
  const remembered = savedEngineId();
  const registry = window.GZ_ENGINES;
  if (registry && !registry.get(remembered)) {
    const pick = registry.fallback(engineEnv());
    S.engineId = pick ? pick.id : remembered;
    S.log('[engine] remembered engine "' + remembered + '" is not in this build; using ' + S.engineId);
  } else {
    S.engineId = remembered;
  }

  // Storage first: settings and saves come from it.
  try {
    S.db = await openDb();
    S.dbOk = true;
  } catch (e) {
    S.db = null;
    S.dbOk = false;
    S.log('[storage] IndexedDB unavailable: ' + (e && e.message));
  }
  await loadSettings();

  const rt = [];
  if (S.caps.jspi) rt.push('JSPI');
  if (S.caps.offscreen) rt.push('OffscreenCanvas');
  if (S.caps.webgl2) rt.push('WebGL2');
  // Chromium browsers all put "Chrome/<version>" in the UA string, so the name
  // is decided by the tokens in front of it: OPR for Opera, Vivaldi, Edg for
  // Edge, and Brave (which ships no token at all) by its own navigator object.
  const ua = navigator.userAgent;
  const uaVer = (re) => { const m = ua.match(re); return m ? m[1] : null; };
  const brands = [
    ['Brave', 'brave' in navigator ? uaVer(/Chrome\/([0-9.]+)/) : null],
    ['Opera', uaVer(/OPR\/([0-9.]+)/)],
    ['Vivaldi', uaVer(/Vivaldi\/([0-9.]+)/)],
    ['Edge', uaVer(/Edg\/([0-9.]+)/)],
    ['Firefox', uaVer(/Firefox\/([0-9.]+)/)],
    ['Chrome', uaVer(/Chrome\/([0-9.]+)/)],
    ['Safari', uaVer(/Version\/([0-9.]+)[^)]*Safari/)],
  ];
  const brand = brands.find((b) => b[1]);
  const brandVer = brand && brand[1].match(/([0-9.]+)/);
  $('#sys-browser').textContent = brand
    ? brand[0] + ' ' + brandVer[1].split('.')[0]
    : navigator.userAgent.slice(0, 28);
  $('#sys-runtime').textContent = rt.join(' · ') || 'missing';
  $('#sys-renderer').textContent = 'GLES / WebGL2';
  $('#sys-origin').textContent = S.caps.file ? 'file:// (offline)' : location.protocol + '//' + location.host;

  if (!S.dbOk) {
    toast('IndexedDB is blocked. Saves will only live in this tab — export them before closing.', 'err', 9000);
  }

  renderSelection();
  renderEngine();
  renderSettings();
  // Only used by the VSync mode; sampled once so the settings screen can show
  // what it will cap to.
  measureDisplayHz().then((hz) => { S.displayHz = hz; renderEngineLimits(); });
  renderRecent();
  await doRefreshSaveUI();
  renderLog();
  // No global "this browser cannot run" screen: each engine carries its own
  // requirements, and the picker reports the one that is actually selected.
  updateStartState();

  // UI wiring
  const pick = () => $('#file-input').click();
  $('#dropzone').onclick = pick;
  $('#dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  $('#file-input').onchange = async (e) => { await readPickedFiles(e.target.files); e.target.value = ''; };
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    await readPickedFiles(e.dataTransfer.files);
  });
  $('#btn-clear').onclick = () => { S.selection = []; renderSelection(); };
  $('#btn-play').onclick = () => launch();
  $('#btn-settings').onclick = () => { renderSettings(); renderLog(); openModal('settings-modal'); };
  $('#btn-help').onclick = () => openModal('help-modal');
  $('#btn-getwad').onclick = () => openModal('help-modal');
  $('#btn-fatal-reload').onclick = () => location.reload();
  const versionChip = $('#version-chip');
  if (versionChip) versionChip.textContent = 'v' + APP_VERSION;
  $$('[data-close]').forEach((b) => b.onclick = () => closeModal(b.dataset.close));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); }));
  $('#confirm-yes').onclick = async () => {
    const action = S.confirmAction;
    S.confirmAction = null;
    closeModal('confirm-modal');
    if (action) await action();
  };

  $('#btn-export').onclick = exportSaves;
  $('#btn-export2').onclick = exportSaves;
  $('#btn-import').onclick = () => $('#import-input').click();
  $('#btn-import2').onclick = () => $('#import-input').click();
  $('#import-input').onchange = async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await importSaveArchive(f); };
  $('#btn-forget').onclick = () => askConfirm('Clear recent games?', 'This removes the cached game files (not your saves).', async () => {
    await store.clear('games');
    await store.clear('gamedata');
    renderRecent();
    toast('Recent games cleared.', 'ok');
  });
  $('#btn-wipe').onclick = () => {
    if (S.game) { toast('Close the game first, then clear the saved data.', 'err'); return; }
    askConfirm('Delete all browser saves?', 'This erases saves, config and screenshots stored by this page in this browser. Export a backup first if you may want them later. This cannot be undone.', async () => {
      await store.clear('files');
      // The panel shows the last save time even with an empty store, so the
      // timestamp has to go with the files or it claims a save that is gone.
      S.lastSaveAt = 0;
      store.del('meta', 'lastSaveAt').catch(() => {});
      refreshSaveUI();
      toast('Browser save store cleared.', 'ok');
    });
  };

  $('#btn-quit').onclick = quitToLauncher;
  $('#btn-fullscreen').onclick = toggleFullscreen;
  $('#game').addEventListener('click', (e) => {
    if (e.target.id === 'game' || e.target.id === 'stage') {
      const cv = S.game && S.game.canvas;
      if (cv) cv.requestPointerLock();
    }
  });
  // Settings inputs
  $('#set-res').onchange = (e) => { S.settings.res = e.target.value; saveSettings(); toast('Resolution applies the next time you press Start game.', '', 3600); };
  $('#set-filter').onchange = (e) => { S.settings.filter = e.target.value; saveSettings(); };
  $('#set-fpsmode').onchange = (e) => {
    S.settings.fpsMode = e.target.value;
    if (e.target.value === 'custom' && !Number(S.settings.maxfps)) S.settings.maxfps = '144';
    $('#fps-limit-row').hidden = e.target.value !== 'custom';
    $('#set-maxfps').value = String(Number(S.settings.maxfps) || 144);
    $('#set-maxfps-val').textContent = (Number(S.settings.maxfps) || 144) + ' FPS';
    saveSettings();
    toast('Frame rate applies on the next launch.', '', 3200);
  };
  $('#set-maxfps').oninput = (e) => {
    S.settings.maxfps = String(Number(e.target.value));
    $('#set-maxfps-val').textContent = S.settings.maxfps + ' FPS';
    saveSettingsSoon();
  };
  $('#set-maxfps').onchange = saveSettings;
  $('#set-fullscreen').onchange = async (e) => {
    S.settings.fullscreen = e.target.checked; saveSettings();
    if (S.game) {
      if (e.target.checked) requestFullscreen().catch(() => toast('Fullscreen was refused by the browser.', 'err'));
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };
  $('#set-fps').onchange = (e) => {
    S.settings.fps = e.target.checked; saveSettings();
    if (S.game && S.game.inline) { if (e.target.checked) startInlineFpsWatch(); else stopInlineFpsWatch(); return; }
    $('#game-fps').hidden = !S.settings.fps || !S.game;
    if (S.game && S.settings.fps) $('#game-fps').textContent = '-- FPS';
  };
  $('#set-inverty').onchange = (e) => {
    S.settings.invertY = e.target.checked;
    saveSettings();
    toast('Mouse Y applies on the next launch.', '', 3600);
  };
  $('#set-sens').oninput = (e) => {
    S.settings.sensitivity = Number(e.target.value);
    $('#set-sens-val').textContent = S.settings.sensitivity.toFixed(2);
    saveSettingsSoon();
  };
  $('#set-sens').onchange = saveSettings;
  $('#set-volume').oninput = (e) => {
    S.settings.volume = Number(e.target.value);
    $('#set-volume-val').textContent = Math.round(S.settings.volume * 100) + '%';
    if (S.audio.master) S.audio.master.gain.value = S.settings.volume;
    saveSettingsSoon();
  };
  $('#set-volume').onchange = saveSettings;
  $('#set-music').onchange = (e) => { S.settings.music = e.target.checked; saveSettings(); };
  $('#set-cache').onchange = (e) => { S.settings.cache = e.target.checked; saveSettings(); };

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) S.settings.fullscreen = false;
    else S.settings.fullscreen = true;
    $('#set-fullscreen').checked = !!document.fullscreenElement;
    saveSettings();
  });
  document.addEventListener('pointerlockchange', () => {
    if (S.game) $('#pointer-hint').hidden = !!document.pointerLockElement;
  });

  // Clicking anywhere resumes a suspended AudioContext (autoplay policy).
  document.addEventListener('pointerdown', () => { if (S.audio.ctx && S.audio.ctx.state === 'suspended') S.audio.ctx.resume().catch(() => {}); }, { capture: true });

  // Keyboard shortcut: Esc in launcher closes modals.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const id of ['settings-modal', 'help-modal', 'export-modal', 'confirm-modal']) {
        const m = document.getElementById(id);
        if (m && !m.hidden) { closeModal(id); e.preventDefault(); return; }
      }
    }
  });

  S.log('[app] ' + APP_VERSION + ' · protocol=' + location.protocol + ' · caps=' + JSON.stringify(S.caps));
}


init().catch((e) => {
  showFatal('Launcher failed to start', e && e.message ? e.message : String(e), (e && e.stack) || '');
});
