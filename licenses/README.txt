Third-party notices
===================

This folder ships engine code and no game data.

GZDoom 4.11.3 (engine, wasm, Emscripten loader, gzdoom.pk3, game_support.pk3,
game_widescreen_gfx.pk3, brightmaps.pk3, lights.pk3; the raw files are packed
inside engine/portable-engine.js and engine/portable-data.js)
  Copyright (c) ZDoom / GZDoom contributors.
  License: GNU General Public License v3 - see GPL-3.0.txt.
  Engine source: https://github.com/ZDoom/gzdoom (tag g4.11.3)
  WebAssembly port: https://github.com/mungus43/tomb-engine

GZDoom 4.14.2 WebAssembly build (engine/gzdoom414)
  Copyright (c) ZDoom / GZDoom contributors.
  License: GNU General Public License v3 - see GPL-3.0.txt.
  Engine source: https://github.com/ZDoom/gzdoom (tag g4.14.2)
  WebAssembly build: https://github.com/nbarkhina/ZDoomWeb (dist/)

UZDoom 4.14.3 WebAssembly build (engine/uzdoom)
  Copyright (c) UZDoom contributors; UZDoom is a fork of GZDoom.
  License: GNU General Public License v3 - see GPL-3.0.txt.
  Engine source: https://github.com/UZDoom/UZDoom (tag 4.14.3)
  WebAssembly build: https://github.com/blahm1dplays/uzdoom-wasm

Third-party code linked inside the engine binaries (SDL2, zlib, libjpeg,
OpenAL Soft, ZMusic, ADL MIDI / Nuked OPL3, FluidSynth where enabled) keeps its
own licence; all are GPLv3-compatible. Exact versions and commit SHAs are in
PROVENANCE.md at the top of this folder.

Source availability
-------------------

GZDoom and UZDoom are GPLv3. If you redistribute this folder, the corresponding
source for the shipped binaries must remain available: the upstream tags and
the ports named above are the exact sources, and PROVENANCE.md §9 records them.
Keep PROVENANCE.md and this file with any copy of the folder.

Game data
---------

No IWAD, PWAD, PK3 or other game data is included. Doom, Doom II, Heretic,
Hexen and Strife game data are copyrighted works of id Software and its
licensors; supply your own legally obtained copies and do not redistribute them
with this project.

Freedoom is a free, BSD-licensed alternative game data project. It is not
included here; download it separately from https://freedoom.github.io/ and add
its IWAD through the launcher.

Doom is a trademark of id Software. This project is not affiliated with or
endorsed by id Software, ZDoom, GZDoom or UZDoom.
