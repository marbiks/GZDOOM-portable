GZDoom 4.14.2 engine bundle
==========================

Provenance
----------
Upstream project : https://github.com/nbarkhina/ZDoomWeb  (dist/)
Files used       : dist/gzdoom.wasm, dist/gzdoom.js, dist/gzdoom.data
Engine banner    : GZDoom g4.14.2-1-ge0e0b26df - 2026-06-28 - SDL version
Licence          : GPL-3.0 (same engine as 4.11.3, newer upstream release)

What is here
------------
glue.js       the Emscripten glue, unmodified (gzdoom.js from dist)
wasm-b64.js   gzdoom.wasm as base64, so a file:// page can read it
              (file:// pages may not fetch() their own files)
data-b64.js   gzdoom.data as base64; that file is the engine's gzdoom.pk3
driver.js     the launcher side: sets window.Module with
                getPreloadedPackage -> data bytes
                wasmBinary          -> wasm bytes
              so the glue never requests anything over the network, writes the
              launcher's files into MEMFS, calls Module.callMain(args), and
              exposes the saves written into MEMFS back to the launcher.

Saves
-----
This build runs with HOME unset, so GZDoom 4.14.2 writes its savegames to

    /Save/<game-folder>/save00.zds

at the root of its in-memory filesystem (measured with the engine's own file
tree), not to the ~/.config/gzdoom/savegames path 4.11.3 uses. GZ414.exportSaves()
walks /Save and the XDG fallbacks, and GZ414.savePath() puts restored files back
into /Save. The launcher polls that every 2 s while you play, so a save made
mid-game is stored without leaving the game.

The launcher starts this engine with `+set storesavepic 0`. The 4.14 renderer
draws a screenshot into a texture framebuffer when a save is written; WebGL2
refuses that attachment (the engine logs
"glCheckFramebufferStatus failed: GL_FRAMEBUFFER_UNSUPPORTED") and the screen
stays black afterwards. With the picture off the save is complete and play
continues; only the thumbnail in the Load Game menu is missing.

Single-threaded
---------------
The glue contains no SharedArrayBuffer / pthread code, so this engine needs no
COOP/COEP headers and runs from index.html without a server.

Differences you will notice
---------------------------
* Vertical mouse look runs the opposite way round inside this build: its SDL
  mouse path feeds motion with the opposite sign to 4.11.3 and UZDoom, while yaw
  is correct. The launcher's "Invert mouse Y" setting (off by default) passes
  `+set invertmouse 0|1` per engine, so the other engines are unaffected and the
  direction can be corrected for this build alone. Mouse capture itself is a
  plain pointer lock, like the worker engines.
* Renders at the resolution the launcher asks for via -width/-height plus
  +vid_defwidth/+vid_defheight/+win_w/+win_h. Without those it starts at its
  built-in 640x480. The canvas keeps the engine's aspect ratio and is letterboxed
  in the stage, so the frame is never stretched to the window's shape.
* The wasm runtime cannot be started twice in one tab: leaving the game reloads
  the launcher.

Rebuilding wasm-b64.js / data-b64.js
------------------------------------
Download the three dist files from the upstream repository and run the same
base64 step (any tool), writing:

  window.GZ414_WASM_B64 = "<base64 of gzdoom.wasm>";
  window.GZ414_DATA_B64 = "<base64 of gzdoom.data>";
