/* Engine registry for the portable launcher.
 *
 * The launcher reads nothing but this table: adding an engine means adding an
 * entry here (and dropping its binary next to `engine/`), not editing
 * launcher.js. Each entry describes what the engine is, what it needs from the
 * browser, how it boots, where its saves live and which settings are its own.
 *
 * Every field here is read by launcher.js; prose about an engine belongs in
 * ENGINES.md, not in the table.
 *
 * `boot` selects the launcher path:
 *   'worker'   - the bundled WebAssembly engine in engine/engine.worker.js
 *                (GZDoom 4.11.3; launch() already knows how to feed it WADs)
 *   'inline'   - a single-threaded WebAssembly engine that runs on the page
 *                itself, with its own canvas and AudioContext (GZDoom 4.14.2).
 *                Also file:// safe: its driver hands the bytes in, the glue
 *                never requests anything over the network.
 *   'external' - a binary that is not part of this folder or cannot run from
 *                file://; the launcher explains why instead of starting it.
 *
 * A 'worker' engine may bring its own bundle (binaries.bundle) holding its glue
 * and worker source, wasm and archives; the launcher then boots it exactly like
 * the original build, with no code change.
 */
window.GZ_ENGINES = (function () {
  'use strict';

  const ENGINES = [
    {
      id: 'gzdoom',
      name: 'GZDoom',
      version: '4.11.3',
      build: 'WebAssembly, single-threaded (tomb-engine build)',
      boot: 'worker',
      badge: 'stable',
      // Measured in Chromium 157: the savegame screenshot pass (glReadPixels
      // into a texture framebuffer) makes the browser lose the WebGL context
      // right after "Game saved." - the canvas stays black at a running frame
      // counter, and the dead context is what broke the next engine started in
      // the same tab. `+set storesavepic 0` skips the picture; the save itself
      // is complete and gameplay carries on.
      noSavePic: true,
      description: 'Web Worker build. Best general-purpose choice.',
      compatibility:
        'Doom, Doom II, Heretic, Hexen and Strife IWADs, plus DeHackEd, DECORATE, ZScript, ACS, MAPINFO and PK3 mods.',
      requires: { fileUrl: true, server: false, sharedArrayBuffer: false, jspi: true },
      blockedReason: '',
      // The wasm and its loader travel inside portable-engine.js; the raw
      // build inputs are not kept in the folder (see tools/make-portable.py).
      binaries: {
        wasm: 'engine/portable-engine.js (gzdoom.wasm, base64)',
        loader: 'engine/portable-engine.js',
        data: 'engine/portable-data.js',
      },
      // Where the engine keeps saves and its ini inside MEMFS. The engine id
      // scopes them in the page's store; nothing here repeats that.
      saves: { memRoot: '/home/web_user/.config/gzdoom', ini: 'gzdoom.ini' },
      docs: 'https://github.com/mungus43/tomb-engine',
      // Shown when a picked file set matches; informational only, it never
      // blocks a launch.
      modNotes: [],
    },
    {
      id: 'gzdoom414',
      name: 'GZDoom',
      version: '4.14.2',
      // 4.14's save screenshot is a texture-render pass WebGL2 rejects
      // (GL_FRAMEBUFFER_UNSUPPORTED), and the screen then stays black. Skipping
      // the picture keeps saving working; the save itself is complete.
      noSavePic: true,
      build: 'WebAssembly, single-threaded (ZDoomWeb build), runs on the page',
      boot: 'inline',
      // This build only carries the GLES renderer (vid_preferbackend 1 is
      // appended for the worker engines); there is no renderer choice to make.
      badge: 'experimental',
      experimental: true,
      description: 'Runs on the page. No worker, no JSPI, so more browsers can start it.',
      compatibility:
        'Current GZDoom ZScript/UDMF/MBF21 support on the page. Saves, PK3s, DECORATE, ACS ' +
        'and MAPINFO load as usual; the engine\u2019s own save screenshots are off (see noSavePic).',
      requires: { fileUrl: true, server: false, sharedArrayBuffer: false, jspi: false },
      blockedReason: '',
      binaries: {
        wasm: 'engine/gzdoom414/wasm-b64.js',
        data: 'engine/gzdoom414/data-b64.js',
        glue: 'engine/gzdoom414/glue.js',
        driver: 'engine/gzdoom414/driver.js',
      },
      // No saves block: this build writes into the page's own MEMFS and its
      // driver reads the tree (GZ414.savePath), so there is no watcher root to
      // declare here.
      docs: 'https://github.com/nbarkhina/ZDoomWeb',
      modNotes: [],
    },
    {
      id: 'uzdoom',
      name: 'UZDoom',
      version: '4.14.3',
      // UZDoom dropped the lockcvar command; sending it there prints a console
      // error and the cvar names after it are parsed as commands.
      lockCvars: false,
      // The 4.14 renderer's save picture is a texture-render pass that WebGL2
      // refuses (GL_FRAMEBUFFER_UNSUPPORTED) and the screen stays black after
      // saving. Turning the save screenshot off skips that pass; the save
      // itself is complete, it just has no thumbnail in the load menu.
      noSavePic: true,
      build: 'WebAssembly, single-threaded (uzdoom-wasm build), runs in a Web Worker',
      boot: 'worker',
      // GLES-only build, like 4.14.2; `vid_preferbackend` would be ignored.
      badge: 'experimental',
      experimental: true,
      description: 'Newest upstream features.',
      compatibility:
        'Three years of upstream changes over 4.11.3 (ZScript, MBF21/id24, renderer fixes) with its ' +
        'own ZMusic. Needs JSPI. Saves are separate from GZDoom\u2019s and not interchangeable.',
      requires: { fileUrl: true, server: false, sharedArrayBuffer: false, jspi: true },
      binaries: {
        bundle: 'engine/uzdoom/bundle.js',
        wasm: 'engine/uzdoom/bundle.js (gzip + base64)',
      },
      saves: {
        keyPrefix: 'uz-',
        memRoot: '/home/web_user/.config/uzdoom',
        // Measured from the engine's own file tree (fs-tree): UZDoom writes
        // saves to ~/.local/share/games/uzdoom/savegames, not
        // ~/.local/share/uzdoom, so the old root never saw a save.
        memSaveRoot: '/home/web_user/.local/share/games/uzdoom',
        ini: 'uzdoom.ini',
      },
      docs: 'https://github.com/derpyder/uzdoom-wasm',
      modNotes: [],
    },
  ];

  const byId = new Map(ENGINES.map((e) => [e.id, e]));

  /** Browser facts the requirements are checked against. */
  function environment() {
    const filePage = location.protocol === 'file:';
    return {
      file: filePage,
      crossOriginIsolated: typeof self !== 'undefined' && !!self.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      jspi:
        typeof WebAssembly !== 'undefined' &&
        typeof WebAssembly.Suspending === 'function' &&
        typeof WebAssembly.promising === 'function',
    };
  }

  /** Why `engine` cannot start in `env`, or '' when it can. */
  function blockedBecause(engine, env) {
    if (!engine) return 'Unknown engine.';
    if (engine.boot !== 'worker' && engine.boot !== 'inline') {
      return engine.blockedReason || engine.name + ' is not bundled in this folder.';
    }
    const req = engine.requires || {};
    if (req.fileUrl === false && env.file) return engine.blockedReason || engine.name + ' cannot run from file://.';
    if (req.sharedArrayBuffer && !env.sharedArrayBuffer) return engine.name + ' needs SharedArrayBuffer, which this page does not have.';
    if (req.crossOriginIsolated && !env.crossOriginIsolated) return engine.name + ' needs a cross-origin isolated page (COOP/COEP headers).';
    if (req.jspi && !env.jspi) return engine.name + ' needs JSPI (WebAssembly.Suspending), which this browser does not expose.';
    return '';
  }

  function all() {
    return ENGINES.slice();
  }
  function get(id) {
    return byId.get(id) || null;
  }
  /** The engine to use when the remembered id is unknown or unusable. */
  function fallback(env) {
    return ENGINES.find((e) => !blockedBecause(e, env)) || ENGINES[0];
  }
  function label(engine) {
    return engine.name + ' ' + engine.version + (engine.experimental ? ' (Experimental)' : '');
  }

  return { all, get, fallback, blockedBecause, environment, label };
})();
