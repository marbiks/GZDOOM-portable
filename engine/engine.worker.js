// engine.worker.js — GZDoom engine running in a Web Worker with OffscreenCanvas.
//
// The single-threaded baseline stop-motions
// because emscripten_sleep(0) yields drain into the main thread's microtask
// queue and Chrome's compositor never gets a paint slot. Moving the engine off
// the main thread lets the compositor pull frames from the OffscreenCanvas at
// vsync regardless of how busy the engine is. That's the unlock.
//
// Audio: workers have no AudioContext. The shim below captures OpenAL's PCM and
// posts it to the page, which owns the real AudioContext and plays it through
// BufferSourceNodes. Output is stereo; positional panning is flattened.

'use strict';

// ---------------------------------------------------------------------------
// 0. FRAME YIELD
//
// The engine ends every frame with `emscripten_sleep(0)`, which emscripten
// implements as `new Promise(resolve => setTimeout(resolve, 0))`. Chrome clamps
// nested timers below 4 ms to 4 ms, so every frame carried a fixed 4 ms of dead
// time regardless of how cheap the frame was. Measured on Freedoom MAP01 at
// 540x600 (same settings, same machine): 9.59 ms per frame / 105 FPS before,
// 3.19 ms / 315 FPS with this shim.
//
// A MessageChannel task is not clamped and is still a real task, so the event
// loop - and with it the compositor sampling the OffscreenCanvas - keeps
// running. Only "now" (delay <= 0) is routed through it: timers with a real
// deadline keep the native implementation, because the frame cap (vid_maxfps)
// and the OpenAL queue lookahead depend on those delays.
// ---------------------------------------------------------------------------
(function fastYield() {
  if (typeof MessageChannel === 'undefined') return;
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeClearTimeout = self.clearTimeout.bind(self);
  const channel = new MessageChannel();
  const pending = new Map();   // id -> callback
  const queue = [];            // ids waiting their turn, oldest first
  let nextId = 1;
  channel.port1.onmessage = () => {
    const id = queue.shift();
    const fn = id === undefined ? undefined : pending.get(id);
    if (!fn) return;           // cleared between queueing and now
    pending.delete(id);
    try { fn(); } catch (e) {
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[worker] timer threw: ' + (e && e.message) });
    }
  };
  self.setTimeout = function (fn, ms) {
    if (ms > 0 || typeof fn !== 'function') return nativeSetTimeout.apply(self, arguments);
    const args = Array.prototype.slice.call(arguments, 2);
    const id = nextId++;
    pending.set(id, () => fn.apply(self, args));
    queue.push(id);
    channel.port2.postMessage(0);
    return id;
  };
  self.clearTimeout = function (id) {
    pending.delete(id);        // its queued turn is a no-op when it comes up
    return nativeClearTimeout(id);
  };
})();

// ---------------------------------------------------------------------------
// 1. DOM SHIMS
//
// emscripten's SDL2 port reaches for `window`, `document`, `location`, and
// `navigator`. None exist in a DedicatedWorker. Provide just enough surface to
// avoid TypeErrors at engine boot. Anything not stubbed here will throw the
// first time the engine touches it — we'll patch as bugs surface.
// ---------------------------------------------------------------------------

// Instrumented EventTarget shim — logs when listeners are added so we can
// see exactly where emscripten/SDL2 attached its input handlers.
const _attachLog = [];
function makeEventTarget(label) {
  const map = new Map(); // type -> Set<listener>
  const target = {
    __label: label,
    addEventListener(type, fn, opts) {
      if (!fn) return;
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      // Listener bookkeeping is a ?dev=1 diagnostic only; outside dev mode it
      // would grow for the whole session with nothing reading it.
      if (self.__devMode && _attachLog.length < 256) {
        _attachLog.push({ on: label, type, capture: !!(opts && opts.capture || opts === true) });
      }
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      const list = map.get(evt.type);
      if (!list || list.size === 0) return true;
      // Real EventTarget.dispatchEvent populates `target` and `currentTarget`
      // for the duration of dispatch. Our shim objects aren't real EventTargets,
      // so emscripten listeners reading `e.target.id` crashed (target was null).
      // Override the read-only properties for the duration of the dispatch.
      try {
        Object.defineProperty(evt, 'target',        { value: target, configurable: true });
        Object.defineProperty(evt, 'currentTarget', { value: target, configurable: true });
        Object.defineProperty(evt, 'srcElement',    { value: target, configurable: true });
      } catch (_) {}
      for (const fn of [...list]) {
        try { fn.call(target, evt); } catch (e) {
          self.postMessage({ type: 'log', stream: 'stderr',
            msg: '[worker] listener threw for ' + evt.type + ': ' + (e && e.message) });
        }
      }
      return !evt.defaultPrevented;
    },
  };
  return target;
}

// Pointer-lock state lives on `document`. Engine reads
// `document.pointerLockElement` to decide whether to consume mouse-look deltas.
const docTarget = makeEventTarget('document');
const winTarget = makeEventTarget('window');

// Build the `document` shim. Some methods (createElement, getElementById)
// MUST return sensible objects — emscripten's SDL2 setup probes them.
// `id`/`nodeName` — emscripten focus/blur/etc. handlers read `e.target.id` and
// `e.target.nodeName` when reporting events. Provide them so handlers don't NPE.
const documentShim = Object.assign(docTarget, {
  id: '',
  nodeName: '#document',
  // emscripten calls getElementById('canvas') in autoResumeAudioContext (which
  // we don't care about) and in a couple of GL helpers. Return our canvas when
  // asked for 'canvas', null otherwise.
  getElementById(id) {
    if (id === 'canvas' && self.__moduleCanvas) return self.__moduleCanvas;
    return null;
  },
  querySelector(sel) {
    if (sel === '#canvas' || sel === 'canvas') return self.__moduleCanvas || null;
    return null;
  },
  createElement(tag) {
    const t = String(tag || '').toLowerCase();
    // SDL_CreateColorCursor (EM_ASM at gzdoom.js:1141602) does
    // `document.createElement('canvas')` then `getContext('2d')` to render a
    // pixel-data cursor. Returning a real OffscreenCanvas lets that path work.
    if (t === 'canvas') {
      const c = new OffscreenCanvas(1, 1);
      // Some emscripten paths assign `c.style`; give it a soft target.
      try { c.style = {}; } catch (_) {}
      // SDL_CreateColorCursor stores the result of `canvas.toDataURL('image/png')`.
      // OffscreenCanvas doesn't have toDataURL (only convertToBlob, which is async).
      // In our pointer-lock setup the cursor data URL is stored but never rendered
      // as a CSS cursor (no DOM cursor in the worker), so an empty data URL works.
      try { c.toDataURL = () => 'data:image/png;base64,'; } catch (_) {}
      return c;
    }
    // Anything else — inert stub.
    return { tagName: t.toUpperCase(), style: {}, addEventListener(){}, removeEventListener(){}, appendChild(){} };
  },
  // Pointer-lock surface. We mutate `pointerLockElement` from main-side input
  // forwarding when the canvas enters / exits pointer lock on the real DOM.
  pointerLockElement: null,
  // Visibility / focus. Engine pauses gametics on visibilitychange.
  visibilityState: 'visible',
  hidden: false,
  hasFocus() { return true; },
  // body — emscripten uses `document.body?.requestPointerLock` as a *feature
  // probe* to decide whether to register a pointerlockchange callback. If
  // it's falsy, the callback is never registered and the engine never learns
  // the pointer locked → SDL2 keeps mouse in absolute (cursor) mode and view
  // rotation never happens. Provide the same surface a real HTMLBodyElement
  // has so the probe passes.
  body: {
    appendChild() {}, removeChild() {}, style: {},
    requestPointerLock() {},
    requestFullscreen() { return Promise.reject(new Error('blocked')); },
    addEventListener() {}, removeEventListener() {},
  },
  documentElement: {
    style: {}, clientWidth: 320, clientHeight: 200,
    requestPointerLock() {},
    requestFullscreen() { return Promise.reject(new Error('blocked')); },
  },
  // Some emscripten paths probe `document.exitPointerLock`. Make it a noop.
  exitPointerLock() {},
});

const windowShim = Object.assign(winTarget, {
  id: '',
  nodeName: '#window',
  // emscripten's OpenAL bridge reads `window.AudioContext`; the shim class
  // defined below is installed here and on globalThis before the engine starts.
  innerWidth: 320,
  innerHeight: 200,
  devicePixelRatio: 1,
  document: documentShim,
  // Some emscripten helpers reach for `performance` and `console` via window —
  // workers have both globally, but the lookup chain `window.performance` would
  // be undefined without forwarding.
  performance,
  console,
  navigator: self.navigator,
  location: { href: '/', search: '', protocol: 'https:' },
  // The single-threaded harness wrapped requestAnimationFrame. In a worker,
  // rAF doesn't exist by default. Provide a Promise-resolved-microtask fallback
  // so anything that calls rAF gets serviced — but it won't be vsync-paced.
  // The engine doesn't use rAF under asyncify/JSPI; this is just a safety net.
  requestAnimationFrame(cb) {
    const id = ++rafCounter;
    Promise.resolve().then(() => cb(performance.now()));
    return id;
  },
  cancelAnimationFrame() {},
});

// Install on globalThis so unqualified `document.X` and `window.X` work.
// NOTE: `self.location` is read-only in a worker (WorkerLocation), so don't
// reassign it — emscripten reads location.href via the native one, which has
// the same shape. windowShim.location stays for window.location.X chains.
self.window = windowShim;
self.document = documentShim;

// ---------------------------------------------------------------------------
// AUDIO SHIM
//
// Emscripten's OpenAL bridge (library_openal.js, baked into gzdoom.js) needs
// a working `AudioContext` constructor in worker scope or `alcOpenDevice`
// returns NULL and the engine falls back to nosound. AudioContext isn't
// available in DedicatedWorkerGlobalScope (main thread only per spec), so we
// shim it.
//
// Strategy: capture audio data at `source.start()` (the moment openal hands a
// filled AudioBuffer to Web Audio for playback) and post the int16-equivalent
// PCM to main, where a real AudioContext replays via a real BufferSourceNode
// chain. Main is the thing actually wired to speakers; worker just produces
// data.
//
// What this misses (acceptable trade for MVP audio):
// - 3D positional audio (panner nodes are stubbed; everything plays stereo)
// - Doppler / cone gain (skipped)
// - Param automation (setValueAtTime curves applied at value-set time only)
// - playbackRate scrubbing during playback (snapshot at start)
//
// What this gets right:
// - Music (long-running buffered stream from ZMusic ADL OPL3 synth)
// - SFX (one-shot buffer playback)
// - Gain control (master gain + per-source gain)
// - Looping (passes loop/loopStart/loopEnd through)
// - Timing alignment (start(when) honored via AudioContext-time arithmetic)
let _audioId = 1;
const _audioCtxStartWall = performance.now() / 1000;

// Bridge-side cost counters. They measure only the JS shim work (buffer
// allocation, channel copy, postMessage), which is what tells a bridge problem
// apart from engine-side synthesis time: a frame gap with no bridge time is
// time spent inside wasm, not here.
const audioDiag = {
  allocs: 0, allocMs: 0, allocMax: 0,
  plays: 0, frames: 0, bytes: 0,
  srcsCreated: 0, gainsCreated: 0, pannersCreated: 0, stops: 0,
  copyMs: 0, copyMax: 0, postMs: 0, postMax: 0,
  events: [],
};

class _FakeAudioParam {
  constructor(initial) { this.value = initial; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  setValueCurveAtTime() { return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}

class _FakeAudioBuffer {
  constructor(channels, frames, sampleRate) {
    this._id = _audioId++;
    this.numberOfChannels = channels;
    this.length = frames;
    this.sampleRate = sampleRate;
    this.duration = frames / sampleRate;
    this._channels = [];
    for (let c = 0; c < channels; c++) this._channels.push(new Float32Array(frames));
    // openal sets these as custom props for loop point handling
    this._loopStart = 0;
    this._loopEnd = 0;
  }
  getChannelData(c) { return this._channels[c]; }
  copyToChannel(src, channel, offset) {
    this._channels[channel].set(src, offset || 0);
  }
  copyFromChannel(dst, channel, offset) {
    const c = this._channels[channel];
    for (let i = 0; i < dst.length; i++) dst[i] = c[(offset || 0) + i] || 0;
  }
}

class _FakeGainNode {
  constructor() {
    this._id = _audioId++;
    this.gain = new _FakeAudioParam(1);
    this._connectedTo = null;
  }
  connect(target) {
    this._connectedTo = target;
    self.postMessage({ audio: 'connect', src: this._id, dst: target ? target._id : -1, dstKind: target && target._kind });
    return target;
  }
  disconnect() {
    self.postMessage({ audio: 'disconnect', src: this._id });
    this._connectedTo = null;
  }
}

class _FakePannerNode {
  constructor() {
    this._id = _audioId++;
    this._connectedTo = null;
    this.positionX = new _FakeAudioParam(0);
    this.positionY = new _FakeAudioParam(0);
    this.positionZ = new _FakeAudioParam(0);
    this.orientationX = new _FakeAudioParam(1);
    this.orientationY = new _FakeAudioParam(0);
    this.orientationZ = new _FakeAudioParam(0);
    this.panningModel = 'HRTF';
    this.distanceModel = 'inverse';
    this.refDistance = 1; this.maxDistance = 10000; this.rolloffFactor = 1;
    this.coneInnerAngle = 360; this.coneOuterAngle = 360; this.coneOuterGain = 0;
  }
  setPosition() {} setOrientation() {} setVelocity() {}
  connect(target) { this._connectedTo = target; return target; }
  disconnect() { this._connectedTo = null; }
}

class _FakeBufferSource {
  constructor() {
    this._id = _audioId++;
    this._buffer = null;
    this._connectedTo = null;
    this.playbackRate = new _FakeAudioParam(1);
    this.detune = new _FakeAudioParam(0);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this._duration = 0;
    this._startOffset = 0;
    this._skipCount = 0;
    this._started = false;
    this._stopped = false;
    this.onended = null;
  }
  get buffer() { return this._buffer; }
  set buffer(b) { this._buffer = b; }
  connect(target) {
    this._connectedTo = target;
    return target;
  }
  disconnect() { this._connectedTo = null; }
  start(when, offset, duration) {
    if (this._started) return;
    this._started = true;
    const buf = this._buffer;
    if (!buf) return;
    // Pack channels for transfer. We slice to detach our local copy (so engine
    // can reuse the buffer for the next playback without our pending message
    // seeing stale data).
    const tCopy = performance.now();
    const ch0 = new Float32Array(buf._channels[0]);
    const ch1 = buf._channels[1] ? new Float32Array(buf._channels[1]) : null;
    const copyMs = performance.now() - tCopy;
    // Resolve gain by walking the connect chain — typical openal pattern is
    // BufferSource -> GainNode -> destination (or BufferSource -> Panner -> GainNode -> destination).
    let gain = 1;
    let node = this._connectedTo;
    while (node) {
      if (node.gain && typeof node.gain.value === 'number') gain *= node.gain.value;
      node = node._connectedTo;
    }
    // Ownership: emscripten's AL creates a fresh BufferSourceNode per queued
    // buffer, but every one of them is wired into the same per-source gain
    // node. That gain node's id is the stable identity of the AL source, and
    // it is what the main thread needs to keep a stream in order and to reuse
    // one gain node instead of allocating one per chunk.
    let cursor = this._connectedTo, alId = this._id;
    while (cursor) {
      if (cursor._kind === 'gain' || cursor.gain) { alId = cursor._id; break; }
      cursor = cursor._connectedTo;
    }
    const tPost = performance.now();
    self.postMessage({
      audio: 'play',
      sourceId: this._id,
      streamId: alId,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      ch0, ch1,
      when: when || 0,
      offset: offset || 0,
      duration: duration === undefined ? -1 : duration,
      loop: !!this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      playbackRate: this.playbackRate.value,
      gain,
    }, ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer]);
    const postMs = performance.now() - tPost;
    audioDiag.plays++;
    audioDiag.frames += buf.length;
    audioDiag.bytes += (ch0.length + (ch1 ? ch1.length : 0)) * 4;
    audioDiag.copyMs += copyMs;
    if (copyMs > audioDiag.copyMax) audioDiag.copyMax = copyMs;
    audioDiag.postMs += postMs;
    if (postMs > audioDiag.postMax) audioDiag.postMax = postMs;

  }
  stop(when) {
    if (this._stopped) return;
    this._stopped = true;
    audioDiag.stops++;
    self.postMessage({ audio: 'stop', sourceId: this._id, when: when || 0 });
  }
  addEventListener() {} removeEventListener() {}
}

class _FakeAudioListener {
  constructor() {
    this.positionX = new _FakeAudioParam(0);
    this.positionY = new _FakeAudioParam(0);
    this.positionZ = new _FakeAudioParam(0);
    this.forwardX = new _FakeAudioParam(0);
    this.forwardY = new _FakeAudioParam(0);
    this.forwardZ = new _FakeAudioParam(-1);
    this.upX = new _FakeAudioParam(0);
    this.upY = new _FakeAudioParam(1);
    this.upZ = new _FakeAudioParam(0);
  }
  setPosition() {} setOrientation() {} setVelocity() {}
}

class _FakeAudioContext {
  constructor(opts) {
    this._id = _audioId++;
    this.sampleRate = (opts && opts.sampleRate) || 44100;
    this.state = 'running';
    this.destination = { _id: -1, _kind: 'destination', connect() {}, disconnect() {} };
    this.listener = new _FakeAudioListener();
    self.postMessage({ audio: 'ctx-new', id: this._id, sampleRate: this.sampleRate });
  }
  get currentTime() {
    return performance.now() / 1000 - _audioCtxStartWall;
  }
  createBuffer(channels, frames, sampleRate) {
    const t0 = performance.now();
    const b = new _FakeAudioBuffer(channels, frames, sampleRate);
    const ms = performance.now() - t0;
    audioDiag.allocs++;
    audioDiag.allocMs += ms;
    if (ms > audioDiag.allocMax) audioDiag.allocMax = ms;
    return b;
  }
  createBufferSource() { audioDiag.srcsCreated++; return new _FakeBufferSource(); }
  createGain() { audioDiag.gainsCreated++; return new _FakeGainNode(); }
  createPanner() { audioDiag.pannersCreated++; return new _FakePannerNode(); }
  createStereoPanner() { return new _FakeGainNode(); /* close enough */ }
  createDelay() { return new _FakeGainNode(); }
  createBiquadFilter() { return new _FakeGainNode(); }
  createDynamicsCompressor() { return new _FakeGainNode(); }
  createAnalyser() { return new _FakeGainNode(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  addEventListener() {} removeEventListener() {}
  decodeAudioData(arrayBuf, success, fail) {
    // Best-effort stub — engine doesn't typically call this for music/SFX
    // (which come through openal buffer queue, not Web Audio decode).
    const reject = new Error('decodeAudioData stub — no decoder in worker');
    if (typeof fail === 'function') fail(reject);
    return Promise.reject(reject);
  }
}

self.AudioContext = _FakeAudioContext;
self.webkitAudioContext = _FakeAudioContext;
windowShim.AudioContext = _FakeAudioContext;
windowShim.webkitAudioContext = _FakeAudioContext;

// `screen` is a window-only global. emscripten_get_screen_size reads
// `screen.width` and `screen.height` during I_InitGraphics. Provide our own
// — the engine just needs SOMETHING here, the value is mostly used to clamp
// "fullscreen" video modes which we never enter.
self.screen = self.screen || {
  width: 1920, height: 1080,
  availWidth: 1920, availHeight: 1080,
  colorDepth: 24, pixelDepth: 24,
};
windowShim.screen = self.screen;

// `localStorage` is not available in DedicatedWorker. emscripten's
// SDL_GetPrefPath / IDBFS may probe for it. Provide an in-memory stub so
// nothing throws — savegame persistence is out of scope for the smoke harness.
const _lsStore = new Map();
self.localStorage = self.localStorage || {
  getItem(k) { return _lsStore.has(k) ? _lsStore.get(k) : null; },
  setItem(k, v) { _lsStore.set(String(k), String(v)); },
  removeItem(k) { _lsStore.delete(k); },
  clear() { _lsStore.clear(); },
  key(i) { return [..._lsStore.keys()][i] || null; },
  get length() { return _lsStore.size; },
};
windowShim.localStorage = self.localStorage;
// matchMedia is sometimes consulted for `prefers-color-scheme` etc. — never
// matches in our shim.
windowShim.matchMedia = (q) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){} });

let rafCounter = 0;

// ---------------------------------------------------------------------------
// 2. CANVAS WRAP
//
// OffscreenCanvas IS an EventTarget and supports getContext('webgl2'), but
// it's missing DOM-only properties the SDL2 port touches: `style`,
// `clientWidth`, `clientHeight`, `getBoundingClientRect`, `focus()`,
// `requestPointerLock()`, etc. We monkey-patch them onto the instance.
//
// We do NOT proxy the OffscreenCanvas — emscripten's `instanceof` checks and
// canvas-identity lookups (`Module.canvas === <result of registration>`) rely
// on real-identity, and proxies break those.
// ---------------------------------------------------------------------------

// Backbuffer pin: defaults to 320x200 (Doom's true native res). Configurable
// via boot message {pinW, pinH} so the smoke harness can sweep canvas sizes
// for perf testing. SBARINFO + menu coords were authored against 320x200;
// larger backbuffers render the world correctly but UI elements stay at
// their authored size unless uiscale/st_scale cvars are bumped.
let PIN_W = 320, PIN_H = 200;

function instrumentCanvasAddListener(canvas) {
  const origAdd = canvas.addEventListener.bind(canvas);
  canvas.addEventListener = function (type, fn, opts) {
    if (self.__devMode && _attachLog.length < 256) {
      _attachLog.push({ on: 'canvas', type, capture: !!(opts && opts.capture || opts === true) });
    }
    return origAdd(type, fn, opts);
  };
}

function augmentOffscreenCanvas(canvas) {
  const styleStub = new Proxy({}, {
    get(t, prop) { return t[prop] !== undefined ? t[prop] : ''; },
    set(t, prop, v) { t[prop] = v; return true; },
  });
  // OffscreenCanvas in Chrome is fairly permissive about adding own properties.
  // Where direct assignment fails, fall back to defineProperty with configurable.
  function pin(name, getter, setter) {
    try {
      Object.defineProperty(canvas, name, {
        configurable: true,
        get: getter,
        set: setter || (() => {}),
      });
    } catch (_) {
      // best effort — if defineProperty refuses, the engine usually still works
    }
  }
  // Force backbuffer to the pinned size, then trap further writes.
  try { canvas.width = PIN_W; canvas.height = PIN_H; } catch (_) {}
  const origDescW = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'width');
  const origDescH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'height');
  if (origDescW && origDescH && origDescW.set && origDescH.set) {
    pin('width',
      () => origDescW.get.call(canvas),
      (v) => {
        if (v !== PIN_W) self.postMessage({ type: 'log', stream: 'stderr',
          msg: '[worker] canvas-pin: clamping width=' + v + ' -> ' + PIN_W });
        origDescW.set.call(canvas, PIN_W);
      });
    pin('height',
      () => origDescH.get.call(canvas),
      (v) => {
        if (v !== PIN_H) self.postMessage({ type: 'log', stream: 'stderr',
          msg: '[worker] canvas-pin: clamping height=' + v + ' -> ' + PIN_H });
        origDescH.set.call(canvas, PIN_H);
      });
  }
  try { canvas.style = styleStub; } catch (_) { pin('style', () => styleStub); }
  pin('clientWidth',  () => canvas.width);
  pin('clientHeight', () => canvas.height);
  pin('offsetWidth',  () => canvas.width);
  pin('offsetHeight', () => canvas.height);
  pin('scrollWidth',  () => canvas.width);
  pin('scrollHeight', () => canvas.height);
  pin('clientTop',    () => 0);
  pin('clientLeft',   () => 0);
  pin('offsetTop',    () => 0);
  pin('offsetLeft',   () => 0);
  pin('parentNode',   () => documentShim.body);
  pin('ownerDocument',() => documentShim);
  canvas.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: canvas.width, bottom: canvas.height,
             width: canvas.width, height: canvas.height };
  };
  // Focus / pointer-lock are real-DOM-only — these noops just keep emscripten
  // happy. Real pointer-lock happens on the main-side canvas; we just route
  // mouse-delta events from main and rely on the engine's `m_use_mouse=1` path.
  canvas.focus = function () {};
  canvas.blur = function () {};
  canvas.requestPointerLock = function () {};
  canvas.requestFullscreen = function () { return Promise.reject(new Error('blocked')); };
  // tagName for `instanceof`-fallback checks in libraries that read it.
  if (!('tagName' in canvas)) {
    pin('tagName', () => 'CANVAS');
    pin('nodeName', () => 'CANVAS');
  }
}

// ---------------------------------------------------------------------------
// 3. FRAME-STAT TELEMETRY HOOK
//
// Hook the WebGL2 context's `bindFramebuffer` after engine boot to count
// frames the same way the single-threaded harness did: count transitions from
// a non-default FB binding back to the default (canvas) — that's the canonical
// "frame end / present pass" moment. Post stats to main on a 200ms cadence.
// ---------------------------------------------------------------------------

const fg = {
  ts: new Float64Array(600),
  head: 0,
  total: 0,
  lastBoundWasNonDefault: false,
  drawCalls: 0,
};

// ---------------------------------------------------------------------------
// 3b. ENGINE LOG FILTER
//
// GZDoom redraws its console with ANSI escapes and this build also emits a
// [trace] line for every display stage, several times per frame. Forwarding
// that to the page is pure overhead. Strip escape-only lines, drop the trace
// spam unless devMode is on, and cap the message rate.
// ---------------------------------------------------------------------------
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
let logBudget = 20;          // messages per second
let logDropped = 0;
setInterval(() => {
  if (logDropped > 0) {
    self.postMessage({ type: 'log', stream: 'stdout',
      msg: '[worker] ' + logDropped + ' engine log lines suppressed' });
    logDropped = 0;
  }
  logBudget = self.__logAll ? 5000 : 20;
}, 1000);

function postEngineLog(stream, msg) {
  const raw = String(msg);
  if (/\[trace\]/.test(raw) && !self.__logAll) return;
  const clean = raw
    .replace(ANSI_RE, '')
    .replace(/\x1b[78]/g, '')            // save/restore-cursor, not CSI
    .replace(/[\x1b\x07\x00]/g, '')
    .replace(/^[0-9\[\]=.]*\]?/, '');   // leftover console bar fragments
  if (!clean.trim()) return;
  if (logBudget <= 0) { logDropped++; return; }
  logBudget--;
  self.postMessage({ type: 'log', stream, msg: clean.slice(0, 4000) });
}

// ---------------------------------------------------------------------------
// 3c. SAVE / CONFIG BRIDGE
//
// Emscripten's MEMFS is the only writable filesystem in this build (IDBFS is
// not linked). The engine writes saves and gzdoom.ini here:
//   /home/web_user/.config/gzdoom/{savegames, screenshots, gzdoom.ini}
// The worker watches that tree and ships changed files to the page, which owns
// durable storage (IndexedDB + export/import). Nothing claims the bytes are on
// the USB stick - the page is explicit about where they live.
// ---------------------------------------------------------------------------
// The page names the tree: GZDoom uses .../.config/gzdoom/gzdoom.ini, UZDoom
// uses .../.config/uzdoom/uzdoom.ini. Both are passed in the boot message.
let CONFIG_ROOT = '/home/web_user/.config/gzdoom';
let CONFIG_INI = 'gzdoom.ini';
// Some engines (UZDoom) follow the XDG split on Linux: ini under .config, but
// saves and screenshots under .local/share. Empty means "same as config".
let SAVE_ROOT = '';
const savesDir = () => (SAVE_ROOT || CONFIG_ROOT) + '/savegames';
const FS_SCAN_MS = 1500;
let fsTimer = null;
let fsIndex = new Map();   // abs path -> 'size:mtimeMs'
let fsPrimed = false;
let fsScanMax = 0, fsScans = 0;

function keyToAbs(key) {
  if (key.startsWith('saves/')) return savesDir() + '/' + key.slice(6);
  if (key.startsWith('config/')) return CONFIG_ROOT + '/' + key.slice(7);
  if (key.startsWith('screenshots/')) return (SAVE_ROOT || CONFIG_ROOT) + '/screenshots/' + key.slice(12);
  return null;
}

function absToKey(abs) {
  const dirs = SAVE_ROOT ? [SAVE_ROOT, CONFIG_ROOT] : [CONFIG_ROOT];
  for (const root of dirs) {
    if (abs.startsWith(root + '/savegames/')) return 'saves/' + abs.slice((root + '/savegames/').length);
    if (abs.startsWith(root + '/screenshots/')) return 'screenshots/' + abs.slice((root + '/screenshots/').length);
  }
  if (abs === CONFIG_ROOT + '/' + CONFIG_INI) return 'config/' + CONFIG_INI;
  return null;
}

function ensureDir(absDir) {
  const FS = self.Module.FS;
  const parts = absDir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try { FS.stat(cur); } catch (_) { try { FS.mkdir(cur); } catch (__) {} }
  }
}

function walkFs(absDir, out) {
  const FS = self.Module.FS;
  let entries;
  try { entries = FS.readdir(absDir); } catch (_) { return; }
  for (const name of entries) {
    if (name === '.' || name === '..') continue;
    const abs = absDir + '/' + name;
    let st;
    try { st = FS.stat(abs); } catch (_) { continue; }
    if (FS.isDir(st.mode)) { walkFs(abs, out); continue; }
    const key = absToKey(abs);
    if (!key) continue;
    out.push({ abs, key, size: st.size, mtime: Math.floor(st.mtime.getTime()) });
  }
}

function scanFs() {
  const files = [];
  walkFs(CONFIG_ROOT, files);
  if (SAVE_ROOT && SAVE_ROOT !== CONFIG_ROOT) walkFs(SAVE_ROOT, files);
  return files;
}

function readEngineFile(abs) {
  const data = self.Module.FS.readFile(abs);
  return data.slice().buffer;
}

function diffFs(files) {
  const changed = [], deleted = [];
  const next = new Map();
  for (const f of files) {
    const sig = f.size + ':' + f.mtime;
    next.set(f.abs, sig);
    if (fsIndex.get(f.abs) !== sig) changed.push(f);
  }
  for (const prev of fsIndex.keys()) if (!next.has(prev)) deleted.push(prev);
  fsIndex = next;
  return { changed, deleted };
}

function postFsChanges(files) {
  const { changed, deleted } = diffFs(files);
  const payload = [];
  const transfers = [];
  for (const f of changed) {
    try {
      const buf = readEngineFile(f.abs);
      payload.push({ key: f.key, data: buf, mtime: f.mtime });
      transfers.push(buf);
    } catch (e) {
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[fs] read failed ' + f.key + ': ' + e.message });
    }
  }
  const keys = deleted.map(absToKey).filter(Boolean);
  if (payload.length || keys.length) {
    self.postMessage({ type: 'fs-changed', files: payload, deleted: keys }, transfers);
  }
}

function startFsWatch() {
  if (fsTimer) return;
  try { ensureDir(savesDir()); } catch (_) {}
  try { ensureDir((SAVE_ROOT || CONFIG_ROOT) + '/screenshots'); } catch (_) {}
  fsPrimed = false;
  fsIndex = new Map();
  const initial = scanFs();
  // First scan only builds the baseline; the page already has these bytes.
  for (const f of initial) fsIndex.set(f.abs, f.size + ':' + f.mtime);
  fsPrimed = true;
  self.postMessage({ type: 'fs-ready', count: initial.length });
  fsTimer = setInterval(() => {
    if (!self.Module || !self.Module.FS) return;
    const t0 = performance.now();
    postFsChanges(scanFs());
    fsScanMax = Math.max(fsScanMax, performance.now() - t0);
    fsScans++;
  }, FS_SCAN_MS);
}

function stopFsWatch() { if (fsTimer) { clearInterval(fsTimer); fsTimer = null; } }

function finalFsScan() {
  try { postFsChanges(scanFs()); } catch (_) {}
}

function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') {
    // base64 (only used by the build's restore test fixtures)
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('unsupported file payload: ' + Object.prototype.toString.call(v));
}

function writeStateFiles(stateFiles) {
  const FS = self.Module.FS;
  let n = 0;
  for (const [key, bytes] of Object.entries(stateFiles || {})) {
    const abs = keyToAbs(key);
    if (!abs) continue;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    ensureDir(dir);
    try {
      FS.writeFile(abs, asBytes(bytes));
      const st = FS.stat(abs);
      fsIndex.set(abs, st.size + ':' + Math.floor(st.mtime.getTime()));
      n++;
    } catch (e) {
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[fs] seed failed ' + key + ': ' + e.message });
    }
  }
  if (n) self.postMessage({ type: 'log', stream: 'stdout', msg: '[worker] restored ' + n + ' save/config files' });
}

function installGLHook(canvas) {
  // Wrap getContext so we hook the GL context the engine creates. Note that
  // emscripten registers the context via its own `emscripten_webgl_create_context`
  // path which eventually calls `canvas.getContext('webgl2', ...)`.
  const orig = canvas.getContext.bind(canvas);
  canvas.getContext = function (type, attrs) {
    // Emscripten asks for powerPreference 'default', which lets a hybrid-GPU
    // machine hand this canvas to the integrated chip. The engine is the only
    // heavy consumer in the tab, so ask for the discrete one where there is one;
    // browsers without a choice ignore it.
    if (attrs && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      attrs = Object.assign({}, attrs, { powerPreference: 'high-performance' });
    }
    const ctx = orig(type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      // Chrome can revoke a context (GPU reset, context cap, driver restart).
      // Silence is the worst outcome - the game just goes black - so report it
      // and let the page say what happened.
      try {
        ctx.canvas.addEventListener('webglcontextlost', (ev) => {
          self.postMessage({ type: 'gl-lost', reason: String((ev && ev.statusMessage) || '') });
        });
      } catch (_) {}
      const origBindFB = ctx.bindFramebuffer.bind(ctx);
      const FB_TARGET = ctx.FRAMEBUFFER;
      ctx.bindFramebuffer = function (target, fb) {
        const isDefault = (fb === null || fb === 0);
        if (isDefault && fg.lastBoundWasNonDefault && target === FB_TARGET) {
          const now = performance.now();
          fg.ts[fg.head] = now;
          fg.head = (fg.head + 1) % fg.ts.length;
          fg.total++;
        }
        fg.lastBoundWasNonDefault = !isDefault;
        return origBindFB(target, fb);
      };
      // Draw-call counting is diagnostic only, and it costs one extra JS call on
      // every draw - thousands per frame, since GZDoom submits one call per wall,
      // flat and sprite. Outside dev mode the frame clock needs nothing but the
      // framebuffer hook above, so the draw wrappers are not installed at all.
      if (self.__devMode) {
        const wrapDraw = (name) => {
          const o = ctx[name];
          if (typeof o !== 'function') return;
          ctx[name] = function () { fg.drawCalls++; return o.apply(ctx, arguments); };
        };
        ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements']
          .forEach(wrapDraw);
        const origClear = ctx.clear.bind(ctx);
        ctx.clear = function (mask) { fg.drawCalls++; return origClear(mask); };
      }
    }
    return ctx;
  };
}

// Telemetry pump: every 100ms, ship a window of recent frame intervals plus
// 1-second-window aggregate metrics (instantaneous FPS, min/max) so the FPS
// readout can react to changes faster than a slow moving average.
let telemTimer = null;
let lastSentTotal = 0;
const hitchLog = [];
let lastHitchT = 0;
let inputMsgs = 0;
function startTelemetry() {
  if (telemTimer) return;
  telemTimer = setInterval(() => {
    const now = performance.now();
    const L = fg.ts.length;
    const count = Math.min(fg.total, L);

    // 1-second rolling window, read straight from the frame ring. Only the
    // timestamps inside that second are touched, so a normal session no longer
    // copies all 600 entries and transfers them to the page ten times a second.
    const oneSecAgo = now - 1000;
    let win1sCount = 0, win1sMin = Infinity, win1sMax = 0, win1sSum = 0;
    let prevT = 0;
    for (let k = 0; k < count; k++) {
      const t = fg.ts[(fg.head - 1 - k + L) % L];
      if (t < oneSecAgo) break;
      if (k > 0) {
        const dt = prevT - t;
        if (dt > 0 && dt < 500) {
          win1sCount++;
          win1sSum += dt;
          if (dt < win1sMin) win1sMin = dt;
          if (dt > win1sMax) win1sMax = dt;
        }
      }
      prevT = t;
    }
    const win1sMean = win1sCount > 0 ? win1sSum / win1sCount : 0;
    const win1sFps  = win1sMean > 0 ? 1000 / win1sMean : 0;
    if (!isFinite(win1sMin)) win1sMin = 0;

    const msg = {
      type: 'frame-stats',
      now,
      totalFrames: fg.total,
      win1s: {
        fps: win1sFps, mean: win1sMean, min: win1sMin, max: win1sMax,
        frames: win1sCount,
      },
    };
    // Everything below exists for ?dev=1 (frame graph, hitch log, draw-call and
    // bridge counters). The FPS overlay needs only the window above.
    if (!self.__devMode) { self.postMessage(msg); return; }

    const recent = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      recent[count - 1 - k] = fg.ts[(fg.head - 1 - k + L) % L];
    }
    // Real stalls (>120ms between presented frames), including gaps longer
    // than the 1s window that the max-frame metric deliberately ignores.
    for (let i = 1; i < count; i++) {
      const dt = recent[i] - recent[i - 1];
      if (dt >= 120 && recent[i] !== lastHitchT) {
        lastHitchT = recent[i];
        hitchLog.push({ t: Math.round(recent[i]), ms: Math.round(dt), inMsgs: inputMsgs });
        if (hitchLog.length > 12) hitchLog.shift();
      }
    }
    const attachSummary = {};
    for (const a of _attachLog) {
      const key = a.on + ':' + a.type;
      attachSummary[key] = (attachSummary[key] || 0) + 1;
    }
    msg.framesSinceLast = fg.total - lastSentTotal;
    msg.drawCalls = fg.drawCalls;
    msg.hitches = hitchLog.slice();
    msg.inputMsgs = inputMsgs;
    msg.fsMs = fsScanMax;
    msg.fsScans = fsScans;
    msg.tsRing = recent;
    msg.workerDiag = { ...workerDiag, attachSummary, attachCount: _attachLog.length, audio: audioDiag };
    self.postMessage(msg, [recent.buffer]);
    lastSentTotal = fg.total;
  }, 100);
}

// ---------------------------------------------------------------------------
// 4. MESSAGE PROTOCOL
//
// From main:
//   { type: 'boot', canvas, args, files: {path: Uint8Array}, devMode }
//   { type: 'input', target: 'window'|'document'|'canvas', evType, init }
//   { type: 'pointerlock', locked: bool }
//   { type: 'visibility', state: 'visible'|'hidden' }
//
// To main:
//   { type: 'ready' }                      after onRuntimeInitialized
//   { type: 'log', stream, msg }           print/printErr
//   { type: 'abort', reason }              engine aborted
//   { type: 'frame-stats', ... }           periodic telemetry
//   { type: 'error', message, stack }      worker-side caught exception
// ---------------------------------------------------------------------------

let booted = false;

self.onerror = (e) => {
  self.postMessage({ type: 'error', message: String(e && e.message || e), stack: e && e.error && e.error.stack });
};
self.onunhandledrejection = (e) => {
  const msg = String(e && e.reason && (e.reason.message || e.reason));
  self.postMessage({ type: 'error', message: 'unhandledrejection: ' + msg, stack: e && e.reason && e.reason.stack });
  // Quitting GZDoom ends the wasm stack in a way JSPI cannot suspend again
  // (SuspendError). That is the engine shutting down, not a crash to hide:
  // flush the filesystem once and tell the page the session ended.
  if (/SuspendError|suspend JS frames/.test(msg)) {
    stopFsWatch();
    finalFsScan();
    self.postMessage({ type: 'engine-exit', code: 'suspend' });
  }
};

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'boot':       return handleBoot(m);
    case 'input':      return handleInput(m);
    case 'pointerlock': return handlePointerLock(m);
    case 'visibility': return handleVisibility(m);
    case 'fs-get-all':    return handleFsGetAll();
    case 'fs-write':      return handleFsWrite(m);
    case 'fs-tree':       return handleFsTree();
    case 'release-gl':    return handleReleaseGl();
    default:
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[worker] unknown message type: ' + m.type });
  }
};

function handleBoot(m) {
  if (booted) return;
  booted = true;

  self.__devMode = !!m.devMode;
  self.__logAll = !!m.logAll;
  if (m.configRoot) CONFIG_ROOT = m.configRoot;
  if (m.configIni) CONFIG_INI = m.configIni;
  if (m.saveRoot) SAVE_ROOT = m.saveRoot;
  if (self.__logAll) logBudget = 5000;   // dev mode starts uncapped

  // Override default pin if boot message specifies a larger canvas size.
  if (m.pinW && m.pinH) {
    PIN_W = m.pinW | 0;
    PIN_H = m.pinH | 0;
  }
  // Also update the shims that report dimensions to the engine.
  windowShim.innerWidth = PIN_W;
  windowShim.innerHeight = PIN_H;
  documentShim.documentElement.clientWidth = PIN_W;
  documentShim.documentElement.clientHeight = PIN_H;

  const canvas = m.canvas;
  if (!canvas) {
    self.postMessage({ type: 'log', stream: 'stderr', msg: '[worker] boot: no canvas in message' });
    return;
  }
  instrumentCanvasAddListener(canvas);  // must wrap BEFORE engine attaches
  augmentOffscreenCanvas(canvas);
  installGLHook(canvas);
  self.__moduleCanvas = canvas;

  // (Diagnostic spy listener removed — mouse-look verified working. Spy was
  // adding per-mousemove overhead.)

  // emscripten convention for specialHTMLTargets:
  //   index 0 = invalid (placeholder)
  //   index 1 = EMSCRIPTEN_EVENT_TARGET_DOCUMENT  → document
  //   index 2 = EMSCRIPTEN_EVENT_TARGET_WINDOW    → window
  //   index 3 = EMSCRIPTEN_EVENT_TARGET_SCREEN    → screen (rarely used)
  // SDL2's emscripten port may pass these numeric pseudo-pointers for
  // keyboard/window events, looked up via findEventTarget. Wrong values here
  // were why mouse-look broke — keyboard/mouse listeners were attaching to
  // wrong targets (our augmented canvas instead of document/window).
  self.specialHTMLTargets = [0, documentShim, windowShim, self.screen];

  self.Module = {
    canvas,
    arguments: m.args || [],
    // file:// cannot fetch gzdoom.wasm. The launcher transfers the bytes.
    wasmBinary: m.wasm || undefined,
    noInitialRun: false,
    preRun: [() => {
      for (const [path, bytes] of Object.entries(m.files || {})) {
        self.Module.FS.writeFile(path, bytes);
      }
      // Saves / gzdoom.ini restored from the page's durable store. Write them
      // into MEMFS before main() so GZDoom's save list sees them at startup.
      writeStateFiles(m.stateFiles);
      self.Module.FS.chdir('/');
      self.postMessage({ type: 'log', stream: 'stdout',
        msg: '[worker] preRun: wrote ' + Object.keys(m.files || {}).length + ' files into MEMFS' });
    }],
    onRuntimeInitialized() {
      self.postMessage({ type: 'ready' });
      startTelemetry();
      startFsWatch();
      // Tell the engine the window has focus right out of the gate. Without
      // this, SDL2 may consider its window inactive and filter input events
      // (including mouse-motion deltas) out of the queue. In a worker there's
      // no native focus to inherit, so we synthesize one.
      setTimeout(() => {
        windowShim.dispatchEvent(makeEvent('focus', {}));
        documentShim.dispatchEvent(makeEvent('focus', {}));
      }, 0);
    },
    // The engine prints ANSI screen updates and per-frame trace lines. Posting
    // those to the page costs a message per line and chokes the main thread,
    // so drop pure control-sequence noise and rate-limit the rest.
    print(...a)    { postEngineLog('stdout', a.join(' ')); },
    printErr(...a) { postEngineLog('stderr', a.join(' ')); },
    onAbort(reason) { self.postMessage({ type: 'abort', reason: String(reason) }); },
    onExit(code) { stopFsWatch(); finalFsScan(); self.postMessage({ type: 'engine-exit', code }); },
    setStatus() {},
    // Important: locateFile should resolve relative to the worker's own
    // location (not the page). When the launcher runs from file:// it passes
    // the loader source itself and no fetch is possible at all.
    locateFile(f) { return f; },
  };

  try {
    const loaderSrc = m.loaderSrc || self.__GZP_LOADER_SRC;
    if (loaderSrc) {
      // Indirect eval runs in global scope, which is where the Emscripten
      // loader expects to declare `Module` (it reads the global we just set).
      (0, eval)(loaderSrc);
    } else {
      importScripts('gzdoom.js');
    }
  } catch (err) {
    self.postMessage({ type: 'error',
      message: 'loading gzdoom.js failed: ' + (err && err.message),
      stack: err && err.stack });
  }
}

// --- Input dispatch -------------------------------------------------------
//
// Main forwards events as plain objects. We synthesize real event instances
// (MouseEvent / KeyboardEvent / WheelEvent are available in DedicatedWorker
// scope in modern browsers) and dispatch them on the correct target. If a
// constructor is unavailable, fall back to a plain object with the same shape
// — emscripten's SDL2 reads properties off the event, not its prototype.

function makeEvent(evType, init) {
  // For Mouse/Wheel events we deliberately use a plain `Event` (not
  // MouseEvent/WheelEvent), then attach properties as own-properties. Reason:
  // `MouseEvent`/`WheelEvent` define `clientX/Y`, `movementX/Y`, `deltaX/Y`,
  // `button`, `buttons` as accessor properties on the prototype, sourced from
  // the C++ event's internal slots. The init-dict path that should populate
  // those slots from constructor options is unreliable in Chrome's worker
  // realm — `new MouseEvent('mousemove', {movementX: 5}).movementX` returns 0.
  // Plain own-properties resolve before prototype lookup, so emscripten's
  // `e.movementX` reads our value as intended.
  if (evType === 'keydown' || evType === 'keyup' || evType === 'keypress') {
    let kev = null;
    try { kev = new KeyboardEvent(evType, init); } catch (_) {}
    if (kev) {
      // KeyboardEvent's init dictionary has no keyCode / which / charCode: the
      // constructor drops them and the getters fall back to 0. Emscripten's
      // SDL2 bridge reads exactly those legacy fields - keydown -> scancode,
      // keypress -> SDL_TEXTINPUT - so a synthesised event with charCode 0
      // types nothing. That is why the console and GZDoom's save-name field
      // stayed empty in the worker engines. Pin the values as own properties.
      for (const k of ['keyCode', 'which', 'charCode', 'keyLocation']) {
        let v = init[k];
        if (v === undefined && k === 'charCode' && evType === 'keypress') v = init.keyCode;
        if (v === undefined) continue;
        try {
          Object.defineProperty(kev, k, { value: v, writable: true, configurable: true, enumerable: true });
        } catch (_) {}
      }
      return kev;
    }
  }
  // Plain Event + own-property assignment for everything else.
  const base = (typeof Event !== 'undefined') ? new Event(evType, { bubbles: true, cancelable: true }) : null;
  const evt = base || { type: evType };
  for (const k in init) {
    try {
      Object.defineProperty(evt, k, { value: init[k], writable: true, configurable: true, enumerable: true });
    } catch (_) {
      try { evt[k] = init[k]; } catch (__) {}
    }
  }
  return evt;
}

// Worker-side mouse-look diagnostics. Counts mousemoves we dispatch and the
// `e.movementX/Y` values an OffscreenCanvas-attached spy listener observes.
// Reported back to main with each frame-stats tick.
const workerDiag = { mmDispatched: 0, mmSpySeen: 0, sumSpyMvX: 0, sumSpyMvY: 0,
                     sumOwnMvX: 0, lastSpyMvX: 0, pointerLockSet: 0 };

function handleInput(m) {
  inputMsgs++;
  const evt = makeEvent(m.evType, m.init || {});
  if (m.evType === 'mousemove') {
    workerDiag.mmDispatched++;
    workerDiag.sumOwnMvX += Math.abs(evt.movementX || 0);
  }
  // Always provide preventDefault / stopPropagation no-ops in case the real
  // event lacks them (plain-object fallback path).
  if (typeof evt.preventDefault !== 'function') evt.preventDefault = () => { evt.defaultPrevented = true; };
  if (typeof evt.stopPropagation !== 'function') evt.stopPropagation = () => {};
  if (typeof evt.stopImmediatePropagation !== 'function') evt.stopImmediatePropagation = () => {};

  // Route precisely based on where SDL2 actually attaches each event type
  // (confirmed via the attach-log diagnostic). Wrong target = listener never
  // fires; previously we fanned out to all three to avoid guessing, but that
  // tripled per-event dispatch cost.
  //
  //   canvas: mousedown/mousemove/mouseenter/mouseleave/wheel/touch*
  //   document: mouseup/pointerlockchange/visibilitychange
  //   window: keydown/keyup/keypress/focus/blur/resize
  switch (m.evType) {
    case 'mousedown': case 'mousemove': case 'mouseenter': case 'mouseleave':
    case 'wheel': case 'mousewheel': case 'click': case 'contextmenu':
    case 'touchstart': case 'touchmove': case 'touchend': case 'touchcancel':
      return self.__moduleCanvas ? self.__moduleCanvas.dispatchEvent(evt) : null;
    case 'mouseup':
      return documentShim.dispatchEvent(evt);
    case 'keydown': case 'keyup': case 'keypress':
    case 'focus': case 'blur':
      return windowShim.dispatchEvent(evt);
    default:
      // Fall back to the caller's requested target for anything not classified.
      switch (m.target) {
        case 'window':   return windowShim.dispatchEvent(evt);
        case 'document': return documentShim.dispatchEvent(evt);
        case 'canvas':
        default:
          return self.__moduleCanvas ? self.__moduleCanvas.dispatchEvent(evt) : null;
      }
  }
}

function handlePointerLock(m) {
  documentShim.pointerLockElement = m.locked ? self.__moduleCanvas : null;
  workerDiag.pointerLockSet = m.locked ? 1 : 0;
  documentShim.dispatchEvent(makeEvent('pointerlockchange', {}));
}

// Diagnostic: list files in the writable home tree. Used by the build tests to
// confirm where the engine actually writes saves.
function handleFsTree() {
  const FS = self.Module.FS;
  const out = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = FS.readdir(dir); } catch (_) { return; }
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const p = dir + '/' + name;
      let st;
      try { st = FS.stat(p); } catch (_) { continue; }
      if (FS.isDir(st.mode)) walk(p, depth + 1);
      else out.push(p + ':' + st.size);
    }
  }
  walk('/home/web_user', 0);
  self.postMessage({ type: 'fs-tree', files: out });
}

// Give the GPU context back before the page terminates this worker. A
// terminated worker's context is not freed until the GPU process notices, and
// the next engine launched in the same tab could then fail to create a WebGL2
// context at all.
function handleReleaseGl() {
  stopFsWatch();
  if (telemTimer) { clearInterval(telemTimer); telemTimer = null; }
  try {
    const cv = self.__moduleCanvas;
    const gl = cv && (cv.getContext('webgl2') || cv.getContext('webgl'));
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (_) {}
  self.postMessage({ type: 'gl-released' });
}

// Full snapshot for export. Returns every save/config/screenshot file.
function handleFsGetAll() {
  const files = scanFs();
  const payload = [], transfers = [];
  for (const f of files) {
    try {
      const buf = readEngineFile(f.abs);
      payload.push({ key: f.key, data: buf, mtime: f.mtime });
      transfers.push(buf);
    } catch (_) {}
  }
  self.postMessage({ type: 'fs-all', files: payload }, transfers);
}

// Import while the engine is running: write files into MEMFS so the in-game
// save list picks them up without a restart.
function handleFsWrite(m) {
  const FS = self.Module.FS;
  const written = [];
  for (const f of m.files || []) {
    const abs = keyToAbs(f.key);
    if (!abs) continue;
    ensureDir(abs.slice(0, abs.lastIndexOf('/')));
    try {
      FS.writeFile(abs, new Uint8Array(f.data));
      const st = FS.stat(abs);
      fsIndex.set(abs, st.size + ':' + Math.floor(st.mtime.getTime()));
      written.push(f.key);
    } catch (e) {
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[fs] import failed ' + f.key + ': ' + e.message });
    }
  }
  self.postMessage({ type: 'fs-written', keys: written });
}

function handleVisibility(m) {
  documentShim.visibilityState = m.state;
  documentShim.hidden = (m.state === 'hidden');
  documentShim.dispatchEvent(makeEvent('visibilitychange', {}));
}

self.postMessage({ type: 'log', stream: 'stdout', msg: '[worker] booted, awaiting message...' });
