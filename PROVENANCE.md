# Engine provenance, build record and limitations

Audit date: 2026-11-22. This file records what is actually inside `engine/`, where
it came from, what was changed, what was verified, and what still separates this
folder from a from-source rebuild.

No game data is included or redistributed. Freedoom/FreeDM data was removed in
1.7.0; the launcher asks for an IWAD at run time. Nothing here may be used to
redistribute commercial Doom, Heretic, Hexen or Strife data.

## 1. Engines in this folder

| Picker entry | Upstream | Release / commit | Shipped `engine/` artifact |
| --- | --- | --- | --- |
| GZDoom 4.11.3 | https://github.com/ZDoom/gzdoom | tag `g4.11.3` = `6ce809efe2902e43ceaa7031b875225d3a0367de` | `gzdoom.wasm` / `gzdoom.js` from the tomb-engine WebAssembly port (`mungus43/tomb-engine`, GPL-3.0), embedded into `engine/gzdoom/portable-engine.js` |
| GZDoom 4.14.2 (Experimental) | https://github.com/ZDoom/gzdoom | tag `g4.14.2` = `99aa489d09015a95bb78df2b30ede29f328cc874`; the shipped binary's own banner is `GZDoom g4.14.2-1-ge0e0b26df` (tag + 1 commit) | `gzdoom.wasm`, `gzdoom.js`, `gzdoom.data` from `nbarkhina/ZDoomWeb` `dist/`, stored as `engine/gzdoom414/{wasm,glue,data}-b64.js` |
| UZDoom 4.14.3 (Experimental) | https://github.com/UZDoom/UZDoom | tag `4.14.3` = `1cb7598afadbe7ffe753b2eaf1b887e58e988036` (released 2025-11-28) | `uzdoom.wasm` + glue + engine PK3s from `blahm1dplays/uzdoom-wasm` (formerly `derpyder/uzdoom-wasm`), single-threaded, packed in `engine/uzdoom/bundle.js` |

The two `(Experimental)` entries — GZDoom 4.14.2 and UZDoom — are independent of
each other and of GZDoom 4.11.3: separate binaries, boot paths, settings records
and save namespaces.

## 2. What "built from upstream" means for these binaries

These are upstream-derived Emscripten builds, but they were **not compiled in
this workspace**:

- **GZDoom 4.11.3**: compiled by the tomb-engine port from GZDoom `g4.11.3`
  (pinned, with its `[rcos-port]` patches), then embedded here.
- **GZDoom 4.14.2**: compiled by ZDoomWeb from GZDoom `g4.14.2` (+1 commit),
  shipped as a `dist/` with no local source patches. This folder keeps the
  binary, glue and data byte-for-byte and only repackages them for `file://`
  (base64 in classic scripts, because a `file://` page may not `fetch()`).
- **UZDoom 4.14.3**: compiled by the `uzdoom-wasm` port from UZDoom `4.14.3`
  with that port's own source patch series (JSPI/worker/audio adaptation), as a
  single-threaded build. This folder keeps the wasm and engine PK3s
  byte-for-byte, and replaces the port's page/loader scripts with the launcher's
  own worker (`engine/engine.worker.js`), so the boot path matches the GZDoom
  engines.

There is no GZDoom or UZDoom source tree, and no Emscripten/CMake/Ninja
toolchain, in this folder. Audited 2026-11-22 on the build machine:
`emcc`, `em++`, `cmake`, `ninja`, `node` and `bun` are all absent (`clang`,
`python3` and `git` are present, and the network was reachable). Section 6 lists
what a from-source rebuild requires; until that is done, the honest description
of these two engines is **upstream-derived prebuilt WebAssembly, repackaged for
`file://`**, not independently compiled here.

## 3. Target version vs shipped version

- GZDoom: the brief's target is 4.14.2, and the shipped binary is 4.14.2 (+1
  commit). Matched.
- UZDoom: the brief asks for the latest stable upstream release. At the time of
  this audit that is **UZDoom 5.0.3** (released 2026-09-23, commit
  `7910df7102033fd7754a317f3254f24101135926`). The single-threaded WebAssembly
  port is pinned to **4.14.3**, which is what ships here. A 5.0.3 wasm build
  does not exist in this folder and would require the from-source build below.

## 4. Build configurations (documented by the ports, per their own repositories)

| Port | Toolchain and flags |
| --- | --- |
| `nbarkhina/ZDoomWeb` (drives the shipped 4.14.2) | emsdk **3.1.49**; CMake; `make -j$(nproc)` (or its `build.sh`) |
| `mungus43/tomb-engine` (drives 4.11.3; same worker the UZDoom bundle uses) | Two stages: native CMake build of `re2c` + `lemon` (CMake 3.16+, NMake or Ninja), then `emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DDYN_OPENAL=OFF -DDYN_FLUIDSYNTH=OFF -DDYN_SNDFILE=OFF -DNO_OPENAL=OFF -DCMAKE_EXE_LINKER_FLAGS_RELEASE="-sJSPI=1" gzdoom-src`, then `ninja -j (ncpu-1)` |
| `blahm1dplays/uzdoom-wasm` (drives the shipped UZDoom) | Windows + Visual Studio Build Tools for the native host tools, Python 3.10+, emsdk, CMake, Ninja; `build.ps1`; `build-pk3s.py` because CMake's `add_pk3` is a no-op under Emscripten; source is upstream UZDoom + an `[rcos-port]` patch series |

These flags are reproduced from the ports' own documentation. They are not
recoverable from the shipped `.wasm`/`.js` artifacts, so they describe how the
binaries were produced upstream, not a build performed here.

## 5. Local changes in this folder

No upstream engine source is modified, because no engine source is present.
Everything below is launcher-side or packaging:

| Area | Change | File |
| --- | --- | --- |
| Packaging | Glue, wasm, engine data and PK3s delivered as classic `<script>` payloads (base64, gzip where useful) so nothing is fetched from `file://` | `engine/gzdoom/portable-*.js`, `engine/gzdoom414/*-b64.js`, `engine/uzdoom/bundle.js`, `tools/*.py` |
| GZDoom 4.14.2 boot | `driver.js` feeds `getPreloadedPackage`/`wasmBinary`, writes MEMFS, calls `Module.callMain`, exports saves | `engine/gzdoom414/driver.js` |
| UZDoom boot | Launcher's own worker replaces the port's page scripts (DOM/audio shims, input bridge, save watcher) | `engine/engine.worker.js`, `tools/make-uzdoom-bundle.py` |
| Mouse look | **Invert mouse Y** setting (default off, per engine) drives `+set invertmouse 0|1`; the 4.14-era builds feed vertical motion with the opposite sign to 4.11.3 | `launcher.js` (`DEFAULT_SETTINGS.invertY`, `readSettingsArgs()`), `index.html` |
| Music pacing | ADL MIDI tuning (`snd_mididevice -3`, one chip, PCM rate); all engines use the Nuked core | `launcher.js` `readSettingsArgs()` |
| Save capture | Worker engines: filesystem watcher poll (1.5 s). In-page 4.14.2: page-side poll of the driver (2 s). Save roots measured per engine: `/Save`, `~/.local/share/games/uzdoom/savegames` | `engine/engine.worker.js`, `engine/gzdoom414/driver.js`, `launcher.js`, `engines.js` |
| Save pictures | `+set storesavepic 0` on every engine: the save-screenshot pass loses the WebGL context on 4.11.3 (canvas black right after `Game saved.`) and fails as `GL_FRAMEBUFFER_UNSUPPORTED` on 4.14-era builds | `engines.js` (`noSavePic`), `launcher.js` |
| Keyboard bridge | Synthesised `KeyboardEvent`s get `keyCode`/`which`/`charCode`/`keyLocation` pinned as own properties; the constructor drops them and Emscripten's SDL2 text input then types nothing | `engine/engine.worker.js` |
| GPU contexts | `WEBGL_lose_context` on leave (worker message `release-gl`), WebGL2 probe retried four times, `webglcontextlost` reported to the page | `engine/engine.worker.js`, `launcher.js` |
| GPU selection | `powerPreference: 'high-performance'` on the WebGL context | `engine/engine.worker.js`, `engine/gzdoom414/driver.js` |
| Per-frame cost | Draw-call counters installed only with `?dev=1` | `engine/engine.worker.js` |
| Integration | Two registry entries, labelled `(Experimental)`; existing GZDoom 4.11.3 entry untouched | `engines.js`, `launcher.js` |

The raw inputs those bundles were made from (`gzdoom.js`, `gzdoom.wasm`, the
support PK3s) are not shipped a second time: each is stored byte-for-byte inside
its bundle, and `python3 tools/make-portable.py` recreates any missing one from
there before rebuilding. Round-trip checked: the restored files match the
originals by SHA-256 and the regenerated bundles by MD5.

## 6. Rebuilding from source (not done here)

What it takes, in the order the reference ports do it:

1. Emscripten SDK (3.1.49 for the GZDoom 4.14.x line; `emsdk install 3.1.49`),
   CMake 3.16+, Ninja, Python 3, and a native C++ toolchain for `re2c`/`lemon`.
2. GZDoom 4.14.2 at `99aa489d09015a95bb78df2b30ede29f328cc874`: two-stage build
   as in section 4, `-sJSPI=1`, OpenAL enabled, no pthreads (`SharedArrayBuffer`
   is unavailable on `file://`).
3. UZDoom at the port's pinned commit **plus its patch series**
   (JSPI/worker/audio/renderer adaptations). Upstream UZDoom alone does not
   produce a `file://`-runnable build; that is exactly the work the port
   encodes.
4. UZDoom 5.0.3 would need the same patch series rebased onto `5.0.3`.
5. Repack: `python3 tools/make-portable.py` (GZDoom 4.11.3 payloads),
   base64 step for `engine/gzdoom414`, `python3 tools/make-uzdoom-bundle.py
   --from-bundle` (UZDoom), then re-run the file:// boot checks.

Approximate cost on this machine (8 cores, 14 GB RAM): emsdk install ~1.5 GB
download, GZDoom configure/build tens of minutes, plus an unknown amount of
porting/debug time for the UZDoom patch series. Nothing in this folder has been
built that way yet.

## 7. Licences

- GZDoom and UZDoom engine code: **GPLv3** (`licenses/GPL-3.0.txt`). The
  WebAssembly builds link the same engine code, so the combined binaries are
  GPLv3.
- tomb-engine: GPL-3.0. ZDoomWeb declares no licence file in its repository; as
  a build of GPLv3 GZDoom, the resulting binary is GPLv3.
- uzdoom-wasm: no declared licence in its repository; as a build of GPLv3
  UZDoom, the resulting binary is GPLv3.
- Third-party code inside the binaries (SDL2, zlib, libjpeg, OpenAL Soft,
  ZMusic, ADL MIDI / Nuked OPL3, FluidSynth where enabled) keeps its own
  licence; see `licenses/README.txt` for the notices shipped here.
- No game data is included. Doom, Heretic, Hexen and Strife IWADs are
  copyrighted and must not be redistributed with this folder. Freedoom is a free
  alternative the user downloads separately (https://freedoom.github.io/).

## 8. Verification record (2026-11-22, this machine)

Chromium 157 (Brave binary), headless, page opened as
`file:///…/index.html?dev=1` — no server, no headers, no network use.

| Engine | Picker entry | Badge | Boot result | Log evidence |
| --- | --- | --- | --- | --- |
| `gzdoom` | `GZDoom 4.11.3` | READY | game visible, no fatal, canvas 532×564, 32 FPS | engine trace frames (`D_Display`, `FShader::Bind`) |
| `gzdoom414` | `GZDoom 4.14.2 (Experimental)` | READY | game visible, no fatal, canvas 532×564 | `P_Init`, test-IWAD banner, `D_CheckNetGame`, `player 1 of 1` |
| `uzdoom` | `UZDoom 4.14.3 (Experimental)` | READY | game visible, no fatal, canvas 532×564, 8 FPS | `uzdoom-trace`, ZScript compile, `P_Init`, `D_CheckNetGame` |

All three engines are selectable, launch independently from `file://`, and
produce their own engine banners. The absolute frame rates are not meaningful
here: headless Chromium pins these canvases near 30 FPS.

Save round trips (2026-11-22, same harness, driven over CDP with real key
presses): all three engines reached `MAP01 - Tech Test`, saved through the
engine's own Save Game screen, and the launcher stored
`prof/<engine>-<game>-<hash>/saves/<game>/save00.zds` while play continued — 4.11.3 and UZDoom through the
worker watcher, 4.14.2 through the page-side poll. UZDoom's save landed under
its own `uz-` prefix; 4.14.2's was previously lost to a scoping bug in
`exportSaves` and a wrong save root.

Quitting 4.11.3 and starting UZDoom in the same tab was also verified: the WebGL2
probe passed, the engine booted, no fatal screen.

Not verified: real-mouse look direction (pointer lock is refused in every local
browser session, so only a real mouse can confirm it), UZDoom's in-game
wheel behaviour, and mods beyond the test IWAD. See `docs/COMPATIBILITY.md`
for the engine-level findings and `docs/CHANGELOG.md` for what changed when.

## 9. Source availability (GPLv3)

GZDoom and UZDoom are GPLv3 programs, and the shipped `.wasm`/`.js` files are
builds of those programs, so distributing them carries the source obligation.

- **GZDoom 4.11.3**: tag `g4.11.3` (`6ce809efe2902e43ceaa7031b875225d3a0367de`)
  at https://github.com/ZDoom/gzdoom, built by
  https://github.com/mungus43/tomb-engine.
- **GZDoom 4.14.2**: tag `g4.14.2` (`99aa489d09015a95bb78df2b30ede29f328cc874`)
  at https://github.com/ZDoom/gzdoom, built by
  https://github.com/nbarkhina/ZDoomWeb (`dist/`).
- **UZDoom 4.14.3**: tag `4.14.3` (`1cb7598afadbe7ffe753b2eaf1b887e58e988036`)
  at https://github.com/UZDoom/UZDoom, built by
  https://github.com/blahm1dplays/uzdoom-wasm plus that port's patch series.

The local packaging code (base64 bundles, worker, driver, tools) is in this
repository under GPL-3.0. No engine source is modified here.

If you redistribute this folder, keep this file, `licenses/` and these links
with it. The corresponding source is public at the tags above; a redistribution
should make that availability explicit, either by keeping this repository
public or by shipping a source archive next to the binaries. Removing this
notice weakens compliance with GPLv3 §6. Where a wasm port does not declare a
licence file, its binary is still GPLv3 because it is a build of GPLv3 engine
code.
