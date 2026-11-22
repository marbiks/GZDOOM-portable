# Adding another engine

The launcher reads exactly one thing to know what it can run: the registry in
`engines.js`. `launcher.js` never names an engine, so a new engine is a data
change plus its binary — not a launcher rewrite.

## What an engine entry looks like

```js
{
  id: 'uzdoom',                       // stable key, used in storage namespaces
  name: 'UZDoom',                     // shown in the picker
  version: 'WASM port (early)',
  build: 'WebAssembly + pthreads, WebGL2 renderer',
  boot: 'worker',                     // 'worker' | 'inline' | 'external'
  badge: 'stable',                    // short tag: 'stable' | 'experimental'
  description: '...',                 // one or two sentences, shown under the picker
  compatibility: '...',               // what it is good and bad at
  requires: {
    fileUrl: true,        // can it run from a file:// page?
    sharedArrayBuffer: false,
    jspi: true,           // needs WebAssembly.Suspending
  },
  blockedReason: '...',               // shown instead of launching when it cannot run
  binaries: {
    bundle: 'engine/uzdoom/bundle.js',// worker engines: one script that sets
                                      // window.GZ_ENGINE_BUNDLE
  },
  saves: {                            // where the engine writes inside MEMFS
    keyPrefix: 'uz-',                 // prefix for file names in the shared store
    memRoot: '/home/web_user/.config/uzdoom',          // ini/config
    memSaveRoot: '/home/web_user/.local/share/games/uzdoom', // saves (XDG split)
    ini: 'uzdoom.ini',
  },
  // Optional, all default false/absent:
  experimental: true,   // adds "(Experimental)" to the picker label
  noSavePic: true,      // start with +set storesavepic 0 (4.14 renderer needs it)
  lockCvars: false,     // skip +lockcvar (engines that dropped the command)
  extraArgs: ['+set', 'some_cvar', '1'],  // appended last, engine-specific
  docs: 'https://github.com/blahm1dplays/uzdoom-wasm',
  modNotes: [],                        // regex tested against the picked file names
}
```

## Three steps

1. **Add the entry** to `ENGINES` in `engines.js`. Order in the array is the
   order in the picker.
2. **Ship the files** the entry points at (for a bundled wasm engine: the wasm,
   its loader, and whatever data archives it needs, next to `engine/`).
   `binaries` is only documentation today; the boot code below is what loads
   them, so keep the two in sync.
3. **Teach the launcher how to boot it.** `launch()` in `launcher.js` currently
   has one boot path, `boot: 'worker'`, which builds `files` and `args` and hands
   them to `bootWorker()`. A second bundled engine needs its own small function
   next to `bootWorker()` — feed it the same `files` map (WAD bytes keyed by
   in-memory name) and `args` array, and let it do the engine-specific part
   (worker, wasm instantiation, canvas, save bridge). Everything above that
   point — file picking, IWAD detection, save export/import, the settings UI,
   the wheel-key replay — is shared already.

   If the engine cannot run from `file://` at all, set `requires.fileUrl: false`
   and fill in `blockedReason`; the picker explains it and keeps Play disabled.

   A worker engine can also bring everything itself: point
   `binaries.bundle` at one classic `<script>` that sets
   `window.GZ_ENGINE_BUNDLE = { loader, worker, wasm, gzip, archives }`, where
   `loader` is the Emscripten glue source, `worker` the worker source, `wasm`
   the binary and `archives` a `{ 'name.pk3': bytes }` map (gzip + base64 when
   `gzip` is true). `bootWorker()` then needs no engine-specific code: it uses
   `bundle.loader`/`bundle.worker` instead of the `GZP_*` globals, and
   `saves.memRoot`/`saves.ini` tell the save watcher where the engine writes.
   `engine/uzdoom/bundle.js` (built by `tools/make-uzdoom-bundle.py`) is the
   reference implementation.

## Rules that keep this modular

- Never branch on an engine id outside `engines.js`. Branch on the entry's
  declared fields instead (`boot`, `requires`, `saves.keyPrefix`). Nothing in
  the table is prose: it holds only what `launcher.js` reads, so a field that
  no code reads is a field that will drift.
- Keep save namespaces separate. Two engines that cannot read each other's
  saves must never share a key prefix. The prefix is the *second* line of
  defence: `launcher.js` scopes all saves and engine config per profile
  (`prof/<engine>-<game>-<hash>/`), computed at launch from the engine id and
  the exact IWAD/mod file set, and restores only the profile of the game being
  started.
- Keep settings per engine (`settings:<id>`); the shared record is a fallback,
  not the source of truth.
- Adding an entry must not make an existing engine mandatory or change its
  args. GZDoom's argument list lives in `readSettingsArgs()` and is untouched
  by the registry.


## Bundled engines

| id | Engine | How it runs | Server needed | Threads / SAB |
|---|---|---|---|---|
| `gzdoom` | GZDoom 4.11.3 | Web Worker + OffscreenCanvas + audio bridge | no | no |
| `gzdoom414` | GZDoom 4.14.2 (Experimental) | on the page, own canvas and AudioContext | no | no |
| `uzdoom` | UZDoom 4.14.3 (Experimental) | Web Worker + OffscreenCanvas, single-threaded | no | no |

The `boot` path decides how a build starts (`worker`, `inline`, or `external`
for a binary that cannot run from `file://`). `saves.memRoot` / `saves.ini` /
`saves.memSaveRoot` tell the save watcher where the engine writes, so the watcher
is not GZDoom-specific.

`experimental: true` in an entry adds the `(Experimental)` suffix to the picker
label. Where each binary comes from, its upstream tag and commit SHA, the build
flags of the port that produced it, and what a from-source rebuild needs are in
`PROVENANCE.md`.

### Which one to pick

**GZDoom 4.11.3** is the most exercised engine here: worker rendering, saves,
mod loading and the wheel replay have the longest test history. **GZDoom
4.14.2** needs only WebGL2, so it is the one to use when JSPI is unavailable or
when a mod wants newer ZScript/UDMF features. Both run well above the display
refresh since 1.7.2 (see `COMPATIBILITY.md`). **UZDoom 4.14.3** is the newest
engine, at the cost of being pinned to an older upstream release than UZDoom's
current stable; since 1.7.2 it measures in the same range as the other two.

All three render at the chosen resolution and capture saves mid-game.

### Running UZDoom

UZDoom is the single-threaded g4.14.3 build, so it starts exactly like 4.11.3:
open `index.html`, pick UZDoom, add an IWAD you own plus any add-ons, press
Play. No server, no headers, no extra step. It needs JSPI and
WebGL2, the same as 4.11.3; on browsers without JSPI use 4.14.2.

Its `uzdoom.ini` is read from `/home/web_user/.config/uzdoom` and its saves from
`/home/web_user/.local/share/games/uzdoom/savegames` — the XDG split this engine
uses, measured from its own filesystem tree, not assumed. Both are stored under
the `uzdoom` profile with a `uz-` file prefix, separate from both GZDoom
engines.

Like the other two it carries `noSavePic: true`: the save-screenshot pass draws
into a texture framebuffer that WebGL2 rejects on 4.14-era builds (and that
costs the WebGL context on 4.11.3), leaving the screen black after saving.

### Adding a `boot: 'inline'` engine

An inline engine is a single-threaded WebAssembly build that runs on the page.
Add an entry to `engines.js` with `boot: 'inline'`, a `binaries` block pointing
at its driver/glue/wasm/data files, and let the driver expose one function:

```
window.MYENGINE.start({ canvas, files, stateFiles, args, onLog, onReady, onAbort })
```

The launcher creates the canvas, fills `files` with `{ '/name.wad': bytes }`,
builds the command line and calls that function. Nothing else in `launcher.js`
has to change.
