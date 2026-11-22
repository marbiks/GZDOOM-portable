UZDoom WebAssembly build (bundled engine)
=========================================

Provenance
----------
Upstream engine : https://github.com/UZDoom/UZDoom   (g4.14.3, GZDoom 4.x fork)
WASM port       : https://github.com/derpyder/uzdoom-wasm
Build taken from: https://rejectedcoins.com/uzdoom-smoke/  on 2026-11-21
                  (uzdoom.js, uzdoom.wasm, engine.worker.js and the engine PK3s)
Version         : UZDoom g4.14.3, single-threaded.
Licence         : GPLv3 (inherited from UZDoom). See licenses/GPL-3.0.txt.

Why this build: it is single-threaded, so it needs no pthreads, no
SharedArrayBuffer and no COOP/COEP headers - it starts straight from
index.html over file://, exactly like the GZDoom engines beside it.

Local changes: the engine binaries are byte-for-byte what the build serves. The
build's own page, loader, melt and touch scripts are NOT used: this folder boots
the same wasm through the launcher's own engine worker
(engine/engine.worker.js + engine.worker), which supplies the DOM/audio shims,
the input bridge, the save watcher and the same argument handling as GZDoom.
tools/make-uzdoom-bundle.py documents every step of that packaging.


Files
-----
bundle.js   Generated. One classic <script> that sets window.GZ_ENGINE_BUNDLE:
              loader    the Emscripten glue (uzdoom.js) as source text
              worker    engine/engine.worker.js as source text
              wasm      uzdoom.wasm, gzip + base64 (8.6 MB -> 3.5 MB)
              archives  uzdoom.pk3, game_support.pk3, brightmaps.pk3,
                        game_widescreen_gfx.pk3, lights.pk3 (gzip + base64)
            A file:// page may not fetch() its own files or start a worker from
            a file:// URL, but classic <script> tags work; the launcher turns
            this bundle into a Blob worker. 20 MB, against 79 MB for the
            pthreads build this replaced.


How it runs
-----------
Click Play: the launcher transfers the game canvas to a Web Worker, decodes the
wasm and archives with DecompressionStream, writes them into the engine's
filesystem, then starts UZDoom with the selected IWAD and PWADs (same picker,
same load order as the GZDoom engines). Nothing is fetched at runtime; the
folder can sit on a USB stick without a network.

Requirements: WebAssembly, WebGL2, Web Worker + OffscreenCanvas, JSPI
(WebAssembly.Suspending) - the same set as the bundled GZDoom 4.11.3. The
capability badge in the launcher reports each one per engine; on a browser
without JSPI, choose GZDoom 4.14.2, which needs only WebGL2.


Saves
-----
UZDoom follows the XDG split of its Linux build inside the engine's in-memory
filesystem:

    /home/web_user/.config/uzdoom/uzdoom.ini          settings
    /home/web_user/.local/share/games/uzdoom/savegames/    saves
    /home/web_user/.local/share/games/uzdoom/screenshots/  screenshots

The worker watches both trees (the registry's saves.memRoot / memSaveRoot) and
hands every new or changed file to the launcher, which stores it in this
computer's browser storage with a `uz-` file-name prefix
(`saves/uz-<slot>.zds`). That prefix keeps UZDoom from overwriting a GZDoom save
of the same slot: both engines name their files doomsav0.zds. Restore maps the
prefix back, so the engine always sees its own names.


Rebuilding bundle.js
--------------------
    python3 tools/make-uzdoom-bundle.py --fetch    # download inputs, repack

Inputs are not kept in this folder (the bundle already carries them); the build
URL above is the only source. Nothing in the launcher or the engines uses the
network at run time.


What was verified here
----------------------
Chromium 157, page opened as file:// (no server, no headers):

- UZDoom boots, loads a test IWAD you supply, renders the title screen at
  1920x1080 and the launcher reports 27-30 FPS in headless software GL.
- Audio starts (Web Audio buffer-source counters) during the title and menu.
- Engine log shows a normal UZDoom start-up; no worker or wasm errors.
- Save restore was checked with a seeded file: a stored `saves/uz-test.zds` is
  written into `/home/web_user/.local/share/games/uzdoom/savegames/test.zds` at boot,
  a stored GZDoom save is ignored by UZDoom, and the reverse holds for GZDoom
  4.11.3 (which still restores its unprefixed rows).

Not verified for UZDoom in this folder: in-game mouse look and weapon switching,
save round-trips, and mods beyond the test IWAD. Those are verified for the
GZDoom engines only. This machine has no audio output device, so audio was
measured as source starts, not listened to.
