/* Driver for the bundled GZDoom 4.14.2 WebAssembly build.
 *
 * Why a driver instead of just loading glue.js: this engine is single-threaded
 * and expects a real DOM canvas plus a real AudioContext, so it runs on the
 * page (not in a worker like the bundled 4.11.3 build). The glue is written for
 * an HTTP server: it asks the browser for gzdoom.data and gzdoom.wasm with
 * requests that a file:// page may not make. Emscripten offers supported hooks
 * for both, so the launcher hands the bytes in and the glue never touches the
 * network:
 *
 *   Module.getPreloadedPackage(name, size) -> ArrayBuffer of gzdoom.data
 *   Module.wasmBinary                      -> ArrayBuffer of gzdoom.wasm
 *
 * Everything else is stock Emscripten: onRuntimeInitialized fills MEMFS, then
 * Module.callMain() starts the engine with the command line the launcher built.
 */
(function () {
  'use strict';

  const G = (window.GZ414 = window.GZ414 || {});
  const MB = 1048576;
  /* Where this build keeps its saves. Measured, not assumed: with HOME unset
   * in this Emscripten build GZDoom 4.14 writes saves to /Save at the
   * filesystem root (`/Save/doom.doom2/save00.zds` for Doom II), not
   * to the ~/.config path 4.11.3 used. The XDG paths are kept as fallbacks for
   * other builds of the same engine.
   *
   * These helpers used to live inside G.start, so G.exportSaves could not see
   * them and threw "fs is not a function": every 4.14 save was therefore lost
   * on exit, no matter where it had been written. */
  const fs = () => (window.Module && window.Module.FS) || null;
  const SAVE_ROOTS = [
    '/Save',
    '/home/web_user/.config/gzdoom/savegames',
    '/home/web_user/.local/share/gzdoom/savegames',
    '/home/web_user/.local/share/games/gzdoom/savegames',
  ];
  const CFG_PATHS = ['/gzdoom.ini', '/home/web_user/.config/gzdoom/gzdoom.ini'];

  G.started = false;
  G.ready = false;

  function b64ToBuffer(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  /* opts: { canvas, files:{path:bytes}, stateFiles:{path:bytes}, config:string,
   *         args:[...], onLog(text, stream), onReady(), onAbort(reason) } */
  G.start = function (opts) {
    if (G.started) {
      return Promise.reject(new Error('GZDoom 4.14.2 is already running on this page. Reload the page to start it again.'));
    }
    G.started = true;

    const log = (m) => opts.onLog && opts.onLog(m);
    const wasm = b64ToBuffer(window.GZ414_WASM_B64);
    const data = b64ToBuffer(window.GZ414_DATA_B64);
    log('[414] engine GZDoom 4.14.2 · wasm ' + (wasm.byteLength / MB).toFixed(1) +
        ' MB · engine data ' + (data.byteLength / MB).toFixed(1) + ' MB');

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      function mkdirp(path) {
        const F = fs();
        const parts = path.split('/').slice(1, -1);
        let cur = '';
        for (const p of parts) {
          cur += '/' + p;
          try { F.mkdir(cur); } catch (_) { /* already there */ }
        }
      }
      function write(path, bytes) {
        try {
          mkdirp(path);
          fs().writeFile(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        } catch (e) {
          log('[414] could not write ' + path + ': ' + e.message);
        }
      }

      window.Module = {
        noInitialRun: true,
        canvas: opts.canvas,
        print: (t) => opts.onLog && opts.onLog(t, 'out'),
        printErr: (t) => opts.onLog && opts.onLog(t, 'err'),
        getPreloadedPackage: () => data,
        wasmBinary: wasm,
        locateFile: (p) => p,
        onAbort: (what) => {
          if (opts.onAbort) opts.onAbort(String(what));
          fail(new Error('GZDoom aborted: ' + what));
        },
        onRuntimeInitialized: () => {
          try {
            for (const [path, bytes] of Object.entries(opts.stateFiles || {})) write(path, bytes);
            for (const [path, bytes] of Object.entries(opts.files || {})) write(path, bytes);
            if (opts.config) write(CFG_PATH, new TextEncoder().encode(opts.config));
            /* MEMFS has its own copy and this closure lives for the whole
             * session: keeping the inputs pinned meant a total conversion's
             * 190 MB of WADs stayed in RAM twice. The launcher keeps the File
             * handles, so a relaunch re-reads them. */
            opts.files = null;
            opts.stateFiles = null;
            G.ready = true;
            if (!settled) { settled = true; resolve(true); }
            if (opts.onReady) opts.onReady();
            /* Emscripten sizes the SDL window from the canvas box, and GZDoom
             * adopts the size when the page dispatches 'resize'. These timers
             * must be queued BEFORE callMain: the engine owns the thread from
             * then on, so anything scheduled afterwards never runs. */
            const fire = () => { try { window.dispatchEvent(new Event('resize')); } catch (_) {} };
            [0, 120, 500, 1500].forEach((ms) => setTimeout(fire, ms));

            log('[414] callMain: ' + opts.args.join(' '));
            try { opts.canvas.focus(); } catch (_) {}
            window.Module.callMain(opts.args);
          } catch (e) {
            fail(e);
          }
        },
      };

      /* Emscripten creates the WebGL context with powerPreference 'default',
       * which on a hybrid-GPU machine can land on the integrated chip. Wrap the
       * canvas before the glue loads so the engine asks for the discrete GPU.
       *
       * The same wrapper counts presented frames: this build has no worker to
       * report frame statistics (unlike 4.11.3), and binding the default
       * framebuffer is the per-frame GL call visible from outside the wasm
       * heap. G.frames() feeds the launcher's FPS readout. */
      const cv = opts.canvas;
      let frames = 0;
      const isGl = (type) => type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl';
      const countFrames = (ctx) => {
        if (!ctx || ctx.__gzFrameHook) return ctx;
        ctx.__gzFrameHook = true;
        const bind = ctx.bindFramebuffer;
        if (typeof bind !== 'function') return ctx;
        const FB = typeof ctx.FRAMEBUFFER === 'number' ? ctx.FRAMEBUFFER : 36009;
        // One count per *transition* back to the default framebuffer, exactly
        // like engine.worker.js: a frame renders into render targets and then
        // presents to the default one, but it binds the default framebuffer
        // more than once per frame (deferred pass, HUD, 2D). Counting every
        // default bind read roughly twice the real rate.
        let wasTarget = false;
        ctx.bindFramebuffer = function (target, framebuffer) {
          if (target === FB) {
            const isDefault = framebuffer === null || framebuffer === 0;
            if (isDefault && wasTarget) frames++;
            wasTarget = !isDefault;
          }
          return bind.apply(this, arguments);
        };
        return ctx;
      };
      const getCtx = cv.getContext.bind(cv);
      cv.getContext = function (type, attrs) {
        if (attrs && isGl(type)) {
          attrs = Object.assign({}, attrs, { powerPreference: 'high-performance' });
        }
        const ctx = getCtx(type, attrs);
        if (ctx && isGl(type)) countFrames(ctx);
        return ctx;
      };
      /** Frames presented so far (one per default-framebuffer bind). */
      G.frames = function () { return frames; };

      /* Emscripten schedules the entire main loop through
       * requestAnimationFrame, which ties the engine to the monitor's refresh
       * rate - the 60/144 Hz ceiling. With VSync off, schedule that loop
       * ourselves instead: it then runs as fast as the engine allows.
       *
       * The zero wait matters. Chrome clamps nested timers below 4 ms up to
       * 4 ms, so scheduling each frame with setTimeout(0) added a fixed 4 ms to
       * every frame - the same clamp that held the worker build (4.11.3) at
       * ~105 FPS. `emscripten_sleep(0)` in that engine now goes through a
       * MessageChannel task, which is not clamped; this loop does the same for
       * its own zero-delay frames. Measured on Freedoom MAP01 at 1280x720: 139
       * FPS / 7.2 ms before, 295 FPS / 3.4 ms after. */
      if (opts.uncapped) {
        const pending = new Set();
        const nativeCancel = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : () => {};
        // `vid_maxfps` is not enforced by this build's loop (measured: a 100 cap
        // still drew 137 fps), so the launcher's custom limit is applied here as
        // the scheduling delay instead.
        const cap = Math.max(0, Math.round(Number(opts.capFps) || 0));
        const interval = cap > 0 ? 1000 / cap : 0;
        // Our ids live above the browser's own rAF ids so a cancel can tell
        // the two apart instead of handing a foreign id to the native cancel.
        let nextId = 1 << 24;
        const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
        const zeroWait = new Map();   // id -> callback
        const zeroQueue = [];         // ids waiting for the channel, oldest first
        if (channel) {
          channel.port1.onmessage = () => {
            const id = zeroQueue.shift();
            const fn = id === undefined ? undefined : zeroWait.get(id);
            if (!fn) return;          // cancelled between queueing and now
            zeroWait.delete(id);
            pending.delete(id);
            fn(performance.now());
          };
        }
        // Pace request-to-request. GZDoom asks for the next frame at a point
        // inside the current one, so measuring from the end of the previous
        // callback made the wait collapse to zero (a 100 fps cap drew 124).
        // Spacing the requests themselves by the interval gives the requested
        // rate whatever the engine's internal ordering is.
        let lastReq = 0;
        window.requestAnimationFrame = function (cb) {
          const now = performance.now();
          const wait = interval > 0 ? Math.max(0, Math.round(interval - (now - lastReq))) : 0;
          lastReq = now + wait;
          const id = nextId++;
          pending.add(id);
          if (wait > 0 || !channel) {
            // A real deadline: let the browser schedule it. `pending` is what
            // makes a cancel between now and then effective.
            setTimeout(() => { if (pending.delete(id)) cb(performance.now()); }, wait);
          } else {
            zeroWait.set(id, cb);
            zeroQueue.push(id);
            channel.port2.postMessage(0);
          }
          return id;
        };
        window.cancelAnimationFrame = function (id) {
          if (pending.delete(id)) {
            zeroWait.delete(id);   // a queued turn is a no-op when it comes up
            clearTimeout(id);
            return;
          }
          if (id < (1 << 24)) nativeCancel(id);
        };
      }

      const s = document.createElement('script');
      s.src = opts.glue || 'engine/gzdoom414/glue.js';
      // Same as the launcher's loader: keep the element only until it has run.
      s.onload = () => { try { s.remove(); } catch (_) {} };
      s.onerror = () => { try { s.remove(); } catch (_) {} fail(new Error('Could not load ' + s.src)); };
      document.head.appendChild(s);
    });
  };

  /* Every save reader walks the same roots; only what it does per file differs. */
  function eachSave(root, prefix, fn) {
    const F = fs();
    let names;
    try { names = F.readdir(root); } catch (_) { return; }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const p = root + '/' + name;
      let st;
      try { st = F.stat(p); } catch (_) { continue; }
      if (F.isDir(st.mode)) { eachSave(p, prefix + name + '/', fn); continue; }
      fn('saves/' + prefix + name, p, st);
    }
  }
  function iniPath() {
    const F = fs();
    for (const p of CFG_PATHS) {
      try { if (F.stat(p).size) return p; } catch (_) { /* no ini yet */ }
    }
    return '';
  }

  /** Savegames currently in the engine's MEMFS, as { 'saves/<name>': bytes }.
   *  `only` limits the read to those keys - what the save watcher needs, since
   *  saveStats() already told it which files changed. */
  G.exportSaves = function (only) {
    const out = {};
    const F = fs();
    if (!F) return out;
    const want = only ? new Set(only) : null;
    for (const root of SAVE_ROOTS) {
      eachSave(root, '', (key, p) => {
        if (want && !want.has(key)) return;
        try { out[key] = F.readFile(p); } catch (_) { /* unreadable */ }
      });
    }
    const ini = iniPath();
    if (ini && (!want || want.has('config/gzdoom414.ini'))) {
      try { out['config/gzdoom414.ini'] = F.readFile(ini); } catch (_) { /* unreadable */ }
    }
    return out;
  };

  /** Cheap change signature for the launcher's watcher: key -> 'size:mtime'.
   *  Reading and hashing every save twice a second ran on the same thread the
   *  engine renders on; this is a few stats per file instead. */
  G.saveStats = function () {
    const out = {};
    for (const root of SAVE_ROOTS) {
      eachSave(root, '', (key, p, st) => {
        out[key] = st.size + ':' + Math.floor(st.mtime.getTime());
      });
    }
    const ini = iniPath();
    if (ini) {
      try {
        const st = fs().stat(ini);
        out['config/gzdoom414.ini'] = st.size + ':' + Math.floor(st.mtime.getTime());
      } catch (_) { /* gone */ }
    }
    return out;
  };

  /** MEMFS path for a stored save key ('saves/x.zds'), or '' if not a save. */
  G.savePath = function (key) {
    if (key.startsWith('saves/')) return SAVE_ROOTS[0] + '/' + key.slice(6);
    if (key === 'config/gzdoom414.ini') return CFG_PATHS[0];
    return '';
  };
})();
