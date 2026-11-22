# GZDoom Portable

An offline Doom launcher for a USB stick, a folder, or a laptop: three
WebAssembly engines, one page, no server, no installer, no network. Open
`index.html`, add an IWAD you own, and play.

[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

- **Three engines, one launcher.** GZDoom 4.11.3, GZDoom 4.14.2 and UZDoom
  4.14.3, each with its own settings and its own saves.
- **Runs from `file://`.** No headers, no `SharedArrayBuffer`, no pthreads and
  no background process. The engine binaries travel inside the page as classic
  scripts and become a Blob worker at launch.
- **No game data is included.** Pick your own `DOOM.WAD`, `DOOM2.WAD`,
  `HERETIC.WAD`, … or download the free [Freedoom](https://freedoom.github.io/)
  separately. Commercial IWADs are never redistributed with this project.
- **Saves survive a tab close.** Saves are captured while you play into
  IndexedDB, kept apart per engine and per game, and export to a ZIP.

## Quick start

1. Copy the whole folder to a USB drive, external disk or any local path.
2. Open `index.html` in Chrome or Edge 137+ (Firefox works with JSPI enabled for
   the worker engines; GZDoom 4.14.2 only needs WebGL2).
3. Add one IWAD plus any `.wad`, `.pk3`, `.ipk3` or `.zip` add-ons.
4. Press **Start game**, then click the game once to capture the mouse.

Keep the folder together: the page loads `launcher.js`, `engines.js` and
`engine/`. Moving `index.html` alone breaks the relative paths.

### Where to get an IWAD

- **Freedoom** — free, BSD-licensed game data: <https://freedoom.github.io/>.
  Download `freedoom1.wad` or `freedoom2.wad` and add it like any other IWAD.
- **Doom, Doom II, Heretic, Hexen, Strife** — buy them (GOG, Steam) and use the
  `.WAD` files from your own installation. They are copyrighted; do not commit
  them to this repository or share them with it.
- Free stand-alone episodes and mods (`.wad`/`.pk3`) still need a base IWAD.

## Engines

| Entry | How it runs | Needs | Character |
| --- | --- | --- | --- |
| **GZDoom 4.11.3** | Web Worker + OffscreenCanvas | JSPI, WebGL2 | Best general-purpose choice; measured ~250 FPS (103 before 1.7.2) |
| **GZDoom 4.14.2** | in-page, own canvas and AudioContext | WebGL2 only | Newest GZDoom features; leaving the game reloads the launcher |
| **UZDoom 4.14.3** | Web Worker + OffscreenCanvas | JSPI, WebGL2 | Upstream UZDoom; separate saves from GZDoom |

The picker is driven entirely by [`engines.js`](engines.js); adding an engine is
documented in [ENGINES.md](ENGINES.md). Where every binary comes from, its
upstream tag and commit, the port's build flags and the local changes are in
[PROVENANCE.md](PROVENANCE.md).

## Loading WADs

Choose one IWAD and any number of add-ons (`.wad`, `.pk3`, `.ipk3`, `.zip`).
Drag and drop works. Only one IWAD loads at a time; add-ons without an IWAD
cannot start, and the launcher says so instead of guessing.

Load order is GZDoom's: later files override earlier ones. DECORATE, ZScript,
ACS, MAPINFO/UMDF, PK3 and IPK3 mods load as they do natively.

A total conversion that ships its own `gzdoom.pk3` — SharpShooter3D does — is
added like any other file and must come **last**, after its WADs: its
`DECALDEF` refers to actors those WADs define, and it supplies the textures
their `ANIMDEFS` names. The launcher renames it so it cannot overwrite the
engine's own archive. Each game opens
on its own title screen — the launcher never forces a map.

## Saves

A page opened from `file://` cannot write into this folder, and the launcher
never pretends otherwise. Saves are stored in this browser (IndexedDB) while you
play:

- A save made mid-game is picked up within a couple of seconds; you keep
  playing. Nothing reloads and nothing kicks you back to the launcher.
- GZDoom 4.11.3 and UZDoom: the worker's save tree is polled every 1.5 s.
- GZDoom 4.14.2: the page checks the engine's file tree every 2 s and reads
  only the files that changed, and checks once more as soon as the page is
  hidden.
- A toast confirms the capture; the **Save data** panel shows the count.

**Export** asks a running engine for its current files first, then builds a ZIP
with `prof/`, `config/` and your launcher settings; **Import** restores it on
another computer. Keep the ZIP with the folder (for
example in `backups/`); the browser cannot write there itself.

Save locations inside the engines: GZDoom 4.11.3
`~/.config/gzdoom/savegames`, GZDoom 4.14.2 `/Save`, UZDoom
`~/.local/share/games/uzdoom/savegames`.

**Saves are kept apart per engine and per game.** Each launch gets a profile —
the engine id plus the exact IWAD/mod set — and only that profile is restored
into the engine's save tree. A save from one game therefore cannot appear in a
different mod set, and 4.14.2 never sees 4.11.3's slots. Rows read
`prof/<engine>-<game>-<hash>/saves/<game>/…`, and the exported ZIP keeps that
layout. Saves written by 1.6.1 and earlier had no profile folder: the first
launch whose game matches adopts them; the rest stay put.

## Settings

Resolution, texture filtering, frame rate, fullscreen, FPS counter, mouse
sensitivity, invert mouse Y, volume, music and key bindings. Every engine keeps
its own copy of the resolution, filtering, frame-rate and input choices;
switching engines does not rewrite the other one's settings.

**Frame rate** has three modes, the same on every engine: *Uncapped* (default),
*VSync* (a cap at the monitor refresh the launcher measures once per load) and
*Custom limit* (30–300). The worker engines cannot truly sync to the display —
the compositor samples their canvas — so VSync there is the same cap.

There is no renderer choice: every engine runs the GLES backend. The 4.11.3
build offered GL3+ and it measured 14.4 FPS against 106 on GLES for the same
scene, so it was removed.

**Invert mouse Y is off by default.** Vertical look differs between these engine
builds: 4.14.2 feeds pointer-lock Y motion the opposite way round from 4.11.3.
The setting drives the engine's own `invertmouse` and is stored per engine.

## Performance and memory

Measured with the launcher's own frame clock (`?dev=1`), MAP01 from a Freedoom
test IWAD (not shipped), one sample per engine, same window and
settings, headless Chromium 157 on an AMD integrated GPU:

| Engine | FPS (one sample) | Mean frame |
| --- | --- | --- |
| GZDoom 4.11.3 | 249.9 | 4.00 ms |
| GZDoom 4.14.2 (VSync off) | 278.5 | 3.59 ms |
| UZDoom 4.14.3 | 276.9 | 3.61 ms |

All three uncapped, one view. Run-to-run spread on this machine is wide
(4.11.3 measured 235-390 across runs, UZDoom 275-367), so read the three as
roughly equal and compare pairs rather than trusting one number. With the
frame-yield fix switched off, 4.11.3 read 103.2 FPS and both other builds
~139: that 4 ms per frame was the browser clamping a zero-delay timer, not the
renderer (see 1.7.2 in [`CHANGELOG.md`](CHANGELOG.md)).

**Engine frame rate and screen frame rate are two different numbers.** The
worker engines draw into an OffscreenCanvas that the compositor samples at the
display refresh, measured at 142–146 Hz here. Above that the engine is drawing
frames the screen never shows, so the overlay can read 250 while the eye sees
~145. That is why Uncapped is a latency setting rather than a sharpness one. It
is also the lighter setting on the CPU: the engines' own frame limiter busy-waits
(`+vid_maxfps 30` measured 0.89–1.01 cores at 34.8 FPS, against 0.54 cores
uncapped), so a cap cuts GPU work but not CPU time.

GZDoom 4.14.2 runs on the page's main thread. Uncapped (the default) its driver
runs the loop from timers; a custom limit is paced to the slider (100 cap → 100
FPS measured); VSync leaves the loop on the browser's animation frame, which is
where its 60 FPS samples come from. 4.11.3 and UZDoom cap their own menus at
35 FPS, so measurements are taken in-game.

Render size is the one real lever: the same UZDoom scene measured 145–147 FPS at
320×200, 137–142 at 532×564 and 120–127 at 1920×1080. The launcher renders at
the window size in device pixels, long side capped at 1920. Settings →
Resolution overrides that cap with the exact size you pick (320×200 up to
3840×2160).

Why 4.11.3 used to look slow: 156 draw calls per frame at 1280×720, and a
frame rate that did not move with resolution or with lights, bloom, SSAO and
shadow maps off. That was read here as a draw-call bound engine; it was the
clamped 4 ms frame yield described above, which no cvar can reach. With the
yield fixed the same view renders in 3.9 ms.

What 4.12–4.14 changed upstream is still real - 4.14.2's notes list "Revert
clipper to older code path when not in Ortho/OOB (speed improvement)"
(`c7d25f1`) - but it is not what held this build back.

Memory was measured the same way, because a tab that has run a few engines looks
heavy. Six alternating sessions (4.11.3, UZDoom) and five 4.14.2 sessions do not
compound: once a session ends the renderer settles back to 352 MB from a 332 MB
fresh launcher (peak in game 570–617 MB at the test canvas), and the GPU process
stays at 217–226 MB throughout. That residue is Chromium holding freed pages in
its allocator, not the page keeping them — the base64 bundles themselves are
reclaimed when the engine takes the decoded bytes. Two things did grow per
launch and are fixed: one `<script>` element per bundle (20 after six sessions,
now 2) and the AudioContext's ended-handlers and buffers (the context is now
closed on quit; audio was re-verified across four launches).

GZDoom 4.14.2 also releases its copy of the WAD bytes once they are in its own
memory filesystem: a 181 MB total conversion measured 521 MB of renderer PSS
instead of 700 MB.

1.7.0 also stops the UI from loading every save body just to count saves, and
stops re-caching an unchanged game in IndexedDB on every launch.

What the launcher does for pacing, all engine-side and reversible:

- Engine in a Web Worker with an OffscreenCanvas, so the compositor presents
  frames at vsync regardless of how busy the engine is.
- The engine's `emscripten_sleep(0)` frame yield (4.11.3) and the in-page loop's
  zero-delay scheduling (4.14.2) are serviced from a `MessageChannel` task
  instead of `setTimeout(0)`, which Chrome clamps to 4 ms. Timers with a real
  deadline keep the native implementation, so the frame cap still decides.
- Vsync off, `vid_maxfps` from the Frame cap setting (Uncapped by default),
  `cl_capfps 0`. Measured at a 146 cap: 145 FPS. A cap costs more CPU than
  uncapped on 4.11.3 (0.96 vs 0.82 cores), because the engine's limiter spins.
- ADL MIDI (OPL3) tuned per engine: one emulated chip at PCM rate instead of six,
  cutting the periodic synthesis stall from about 120 ms to 17 ms p99.
- `powerPreference: 'high-performance'` on the WebGL context, so a hybrid-GPU
  machine uses the discrete chip.
- Draw-call counters only with `?dev=1`; they cost one JS call per draw.

## GPU contexts and switching engines

Leaving a game returns its WebGL context (`WEBGL_lose_context`) before the
worker is terminated, and the launcher retries the WebGL2 probe four times with
a short backoff before concluding it is unavailable. Without that, closing one
engine and starting another in the same tab could fail the second engine's
context and show the "enable hardware acceleration" screen on a machine that has
acceleration on.

## Project layout

```
index.html                  Launcher page. Open this.
launcher.js                 UI, storage, archive import/export, engine boot.
engines.js                  Engine registry (the picker reads only this).
engine/
  portable-engine.js        Generated: worker + Emscripten loader + wasm (base64).
  portable-data.js          Generated: GZDoom support PK3s (base64).
  engine.worker.js          Worker source: DOM/audio shims, input bridge,
                            save watcher, telemetry.
  gzdoom414/                GZDoom 4.14.2: glue, wasm, engine data, driver.
  uzdoom/bundle.js          UZDoom 4.14.3: glue, wasm and engine PK3s, one file.
backups/ saves/ config/     Folders for your own save archives (not game data).
tools/make-portable.py      Regenerates the engine/portable-*.js bundles.
tools/make-uzdoom-bundle.py Regenerates engine/uzdoom/bundle.js.
tools/verify.py             Checks bundles, version chip and registry (CI runs it).
dev/                        Optional CDP diagnostics harness (not needed to play).
licenses/                   GPLv3 text and third-party notices.
PROVENANCE.md               Upstream tags/commits, build sources, local changes.
COMPATIBILITY.md            Engine-level findings and limits.
CHANGELOG.md                What changed when, with measurements.
```

Why base64 bundles: a `file://` page may not `fetch()` its own files or start a
worker from a `file://` URL in Chromium. Classic `<script>` tags work, so the
engine, its wasm and the support PK3s arrive as scripts and are turned into a
Blob worker at runtime. The engine binary itself is unchanged.

## Browser support and limits

- Chrome or Edge 137+ (JSPI stable). Firefox 128+ needs
  `javascript.options.wasm_js_promise_integration` — untested here. Safari does
  not provide JSPI and is not supported for the worker engines; GZDoom 4.14.2
  only needs WebGL2 and may work.
- Audio is stereo: OpenAL positional panning is flattened in the worker audio
  bridge.
- Music is synthesised on the engine thread (no threads in these builds).
- GZDoom 4.14.2 cannot be started twice in one tab; leaving the game reloads the
  launcher.
- Save-game screenshots are off on all three engines (`storesavepic 0`): the
  picture pass makes Chromium lose the GPU context (4.14-era builds also log
  `GL_FRAMEBUFFER_UNSUPPORTED`) and the screen stayed black after saving. Saves
  are complete; only the load-menu thumbnail is missing.
- Browser storage is per profile. Saves do not follow the folder until you
  export/import the ZIP.
- Touch input is not implemented; keyboard + mouse or a gamepad.
- Mods that need engine features newer than the selected engine's version will
  fail on that engine — that is what the three entries are for.

## Troubleshooting

**Nothing happens when opening `index.html`.** Use Chrome or Edge; some file
managers open HTML in a text editor. The page must stay next to `engine/`.

**"This browser cannot run…" / NOT SUPPORTED.** The selected engine's
requirements are missing: JSPI for the two worker engines, WebGL2 for all three.
Update the browser; check `chrome://gpu`. If you just left another game, reload
once — see *GPU contexts* above.

**Start game stays disabled.** No IWAD is selected. Add `DOOM.WAD`,
`DOOM2.WAD`, a Freedoom IWAD or another base game; a PWAD/PK3 alone cannot start.

**Black screen after Start.** Open Settings → Engine log. Both the missing
WebGL2 case and an engine startup failure are reported there.

**No sound.** Click the page once (autoplay policy) and check the volume. Audio
is stereo.

**A save did not appear.** Give it a couple of seconds; the launcher polls. Check
the Save data panel's count, and the toast. Saves are per engine.

**Need a clean start.** Settings → *Clear browser saves* (saves only) and
Recent games → *Clear* (cached game files).

## Rebuilding the bundles

Only needed if you replace engine files. Python 3, no other tooling:

```sh
python3 tools/make-portable.py                     # GZDoom 4.11.3 payloads
python3 tools/make-uzdoom-bundle.py --from-bundle  # UZDoom, from its own bundle
```

The raw loader, wasm and support PK3s are not stored twice: each already lives
inside a generated bundle, and `make-portable.py` recreates a missing input from
its bundle before rebuilding (`--from-bundle` rewrites all of them).
`make-uzdoom-bundle.py` also accepts `--fetch` to download the inputs its bundle
was made from. GZDoom 4.14.2's `*-b64.js` files are produced by base64-encoding
the upstream `dist/` files; see `engine/gzdoom414/README.txt`.

A from-source engine rebuild (Emscripten, CMake, Ninja, and the UZDoom port's
patch series) is documented in [PROVENANCE.md](PROVENANCE.md) §6. It was not
done here; the shipped binaries are upstream-derived prebuilt WebAssembly,
repackaged for `file://`.

## Licences and legal

- **Launcher code** in this folder: GPL-3.0 ([LICENSE](LICENSE)).
  Copyright (C) 2026 the GZDoom Portable contributors.
- **GZDoom, UZDoom and their WebAssembly builds**: GPL-3.0
  ([licenses/GPL-3.0.txt](licenses/GPL-3.0.txt)). Corresponding sources and
  build provenance are listed in [PROVENANCE.md](PROVENANCE.md) §1, §4 and §9.
- **Third-party code inside the binaries** (SDL2, zlib, libjpeg, OpenAL Soft,
  ZMusic, ADL MIDI/Nuked OPL3): notices in
  [licenses/README.txt](licenses/README.txt).
- **No game data is included.** Doom, Doom II, Heretic, Hexen and Strife IWADs
  are copyrighted works; supply your own and do not redistribute them with this
  folder. [Freedoom](https://freedoom.github.io/) is a free alternative you can
  download separately.
- **Doom is a trademark of id Software.** This project is not affiliated with or
  endorsed by id Software, ZDoom, GZDoom or UZDoom.

GPLv3 requires that the source corresponding to a distributed binary be
available. If you redistribute this folder, keep `PROVENANCE.md`,
`licenses/` and the source links with it. See §9 of PROVENANCE for the exact
upstream revisions.

No tracking, no analytics, no network requests. Everything runs locally.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Please do not attach game WADs to issues or commits: reproduce with a Freedoom
IWAD instead.
