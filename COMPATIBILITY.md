# Compatibility notes

What loads, what does not, and what was measured. Everything here was checked in
this folder with the shipped engines; nothing is quoted from other sources
without saying so.

## How it is tested

Chromium 157 (Brave binary), page opened as `file:///…/index.html`, no server,
no headers, no network. Two harnesses:

- `dev/cdp.py` — a stdlib Chrome DevTools Protocol client. Real key events, real
  clicks, screenshots, page evaluation. Used for the save, pacing and
  engine-switch runs below.
- `?dev=1` — the launcher's own diagnostics: per-frame telemetry from the worker
  (`S.stats`: 1 s windows with mean/min/max frame time, hitch list, draw calls,
  audio counters) and the unfiltered engine log.

Absolute frame rates from headless Chromium are only comparable between runs on
this machine, which is why every number below is a before/after comparison with
the same scene and settings.

## Engine start-up

| Engine | Boots from `file://` | Needs | Log evidence |
| --- | --- | --- | --- |
| GZDoom 4.11.3 | yes | JSPI, WebGL2, worker + OffscreenCanvas | `D_Display` trace frames, `P_Init` |
| GZDoom 4.14.2 | yes | WebGL2 | `P_Init`, test-IWAD banner, `MAP01 - Tech Test` |
| UZDoom 4.14.3 | yes | JSPI, WebGL2, worker + OffscreenCanvas | `uzdoom-trace`, ZScript compile, `P_Init` |

Menu, New Game and difficulty keys work on all three with only keyboard events;
a game reaches `MAP01 - Tech Test` from the test IWAD.

## WAD / PK3 loading

- IWAD detection reads the WAD header and directory; PWADs, PK3/ZIP/IPK3
  archives are accepted and handed to the engine in pick order, later files
  overriding earlier ones (`-file`).
- The bundled archive names are reserved in the in-memory filesystem, so a user
  file called `gzdoom.pk3` is renamed instead of replacing the engine's own base
  archive.
- Recent games cache up to ~96 MB of picked files in IndexedDB so a relaunch does
  not need the file picker again.

### MAPINFO

Found while testing mods on 4.11.3: a MAPINFO that adds a full map block with
properties aborts that build (it throws and JSPI cannot suspend), while MAPINFO
that only sets map titles loads. 4.14.2 and UZDoom are newer and were not seen
aborting on the same data. Treat this as an engine-version difference: if a map
pack will not start, try another engine entry.

## Mouse and wheel

- Pointer lock is requested with a plain `canvas.requestPointerLock()` on every
  engine. The 4.14.2 build never asks for it itself; without the launcher's
  request the engine ignores motion and clicks because the cursor is uncaptured.
- Vertical look: the 4.14-era builds feed pointer-lock Y motion with the opposite
  sign to 4.11.3. The launcher therefore starts every engine with the engine's
  own `invertmouse`, driven by the **Invert mouse Y** setting (default off, stored
  per engine). The direction itself cannot be measured in headless Chromium —
  pointer lock is refused there — so this follows the engine builds' behaviour
  and the setting exists to correct it per engine.
- Wheel: 4.11.3's SDL2 layer never registers a wheel listener, so the launcher
  replays each notch as `[` / `]`, bound to `weapprev` / `weapnext` in the
  generated config. 4.14.2 handles the wheel natively (`MWheelUp`/`MWheelDown`);
  the replay is harmless there because those keys are unbound by default.

## Audio

The worker engines have no `AudioContext`, so `engine.worker.js` shims one and
posts PCM to the page, which owns the real context. Consequences, all measured:

- Stereo only: OpenAL positional panning is flattened.
- One gain node per AL source is reused and chunks are chained sample-accurately
  (each starts where the previous ends). The bridge costs 0.1–0.5 ms per chunk
  and the main thread spends at most ~0.7 ms handling one.
- MIDI is synthesised on the engine thread. ADL MIDI defaults to six emulated
  OPL3 chips; with one chip at PCM rate the periodic stall fell from 100–140 ms
  to ~17 ms p99 on 4.11.3, and the frame rate rose from ~72 to ~93 FPS at
  1920×1080 with music on — the same as with music off.
- UZDoom gets the same tuning (one chip, PCM rate, Nuked core). Measured with
  Nuked *before* the 1.7.2 yield fix: 138 FPS median, 7.25 ms mean, 0 of 21
  one-second windows with a frame over 100 ms. That run was bound by the 4 ms
  timer clamp, not by audio, so the stall numbers still stand while its absolute
  frame rate is history: the same configuration now measures ~275 FPS.

## Saves

Where each engine writes, and how the launcher finds it:

| Engine | Engine-side location | Capture |
| --- | --- | --- |
| GZDoom 4.11.3 | `~/.config/gzdoom/savegames/<game>/` | worker polls the tree every 1.5 s |
| GZDoom 4.14.2 | `/Save/<game>/` (HOME is unset in this build) | page reads the MEMFS every 2 s |
| UZDoom 4.14.3 | `~/.local/share/games/uzdoom/savegames/<game>/` | worker polls the tree every 1.5 s |

Typing matters here: until 1.6.0 the worker's keyboard events carried no
`charCode`/`keyCode`, so the Save Game screen's name field could not be filled
in and the save was never confirmed — the screen simply went dark. With the
legacy fields pinned, the flow above works with ordinary key presses.

Saves sit in a per-game subfolder, so the watchers walk the trees instead of
listing one directory.

Storage is scoped per engine **and** per game: every launch computes a profile
from the engine id and the exact file set, stores rows as
`prof/<profile>/saves/<game>/…`, and restores only that profile into the
engine's save tree. Without this, every row the launcher held landed in the
engine's save root and GZDoom's Load Game menu listed all of them — which is how
a save from one IWAD came up inside a different mod set on another engine.

Verified end to end: a 4.11.3 save appears in IndexedDB under profile
`gzdoom-doom2-…` within a couple of seconds, a toast confirms it, and play
continues without leaving the game. Launching 4.14.2 with the same game left its
save root **empty** (the 4.11.3 slot was not restored); a second 4.14.2 session
with a different IWAD also started with an empty save root; and going back to
4.11.3 with the first IWAD restored exactly one file, its own. Importing the exported
ZIP on a clean browser kept both profiles intact and restored only the matching
one.

Known limit: `storesavepic 0` is passed to every engine. Measured on 4.11.3,
the save-screenshot pass (a texture framebuffer readback) made Chromium lose the
WebGL context immediately after `Game saved.`: the canvas went black while the
frame counter kept running, and the dead context is what made the next engine
fail to get a WebGL2 context in the same tab. The 4.14-era engines log
`glCheckFramebufferStatus failed: GL_FRAMEBUFFER_UNSUPPORTED` for the same pass.
With the picture off, saving leaves the game rendering on all three; the save is
complete and only its thumbnail in the Load Game menu is missing.

## Backend

GLES (`vid_preferbackend 1`) on every engine. The 4.11.3 build also offers a GL3+
backend, and selecting it was measured at **14.4 FPS** against **106 FPS** on
GLES for the same scene — that path lands in a software fallback under
WebGL2/Emscripten — so the launcher no longer exposes it and forces GLES.

## Rendering defaults

GZDoom 4.14.2 ships `gl_texture_filter 4` (smooth trilinear) and
`gl_texture_filter_anisotropic 8`. The worker builds were launched with filter 0
and anisotropy 1, so the same textures looked smeared on 4.14.2 and crisp on the
others; its own console reports both values (`gl_texture_filter` is "4"
(default: "4")). Every engine now receives the same pair, tied to the launcher's
Texture filter setting.

Measured on one fixed view of MAP01, switching only the cvar through the
console: high-frequency energy (Laplacian variance) in the centre of the frame
was 62.1 with filter 0 and 21.0 with filter 4, i.e. the 4.14.2 default was about
three times softer than what the other engines draw.

## Frame pacing

MAP01, one sample per engine, same window, same settings, `?dev=1`, all
uncapped:

| Engine | FPS (one sample) | Mean frame |
| --- | --- | --- |
| GZDoom 4.11.3 | 249.9 | 4.00 ms |
| GZDoom 4.14.2 (VSync off) | 278.5 | 3.59 ms |
| UZDoom 4.14.3 | 276.9 | 3.61 ms |

With the frame-yield fix disabled, 4.11.3 read 103.2 FPS and 4.14.2 and UZDoom
both ~139 - the 101–106 FPS this file used to quote for 4.11.3. The gap those
older numbers showed was a 4 ms per-frame timer clamp in all three builds, not
the renderer (CHANGELOG 1.7.2); UZDoom first measured as exempt because the test
patch was thrown away when the launcher re-loaded its bundle.

These are engine frame rates. The browser presents an OffscreenCanvas at the
display refresh (142–146 Hz here), so above that the engine draws frames the
screen does not show; the counters were checked against each engine's own `+vid_fps`
overlay (4.11.3 253 vs 249.9, UZDoom 281 vs 276.9, 4.14.2 289 vs 278.5) and agree.
A cap is not a power saving here either: `+vid_maxfps 30` measured 34.8 FPS at
0.89–1.01 cores, because the engines' limiter busy-waits.

4.14.2 is the only engine that renders on the page's main thread, so with VSync
on it runs inside `requestAnimationFrame` and cannot pass the display refresh
(engine's own counter and the launcher overlay both read 16 ms / 60 fps). VSync
off, the default, has the driver schedule that loop from timers instead. The
worker engines draw into an OffscreenCanvas and are never refresh-locked.

Menus are not capped by the launcher: 4.11.3 and UZDoom cap their own menus at
35 FPS, 4.14.2 does not.

### Frame-rate modes

Uncapped is `vid_maxfps 0` in the worker engines and is what the table above
uses. A cap is the engine's own `vid_maxfps` there - measured 146 cap → 145 FPS
on 4.11.3, 0.96 cores - and the driver's scheduler in 4.14.2, whose `vid_maxfps`
is ignored (a 100 cap still drew 137 in the 1.6.x run; with the driver's own cap,
100 → 98.8 FPS). VSync in the worker engines is the
same cap at the refresh measured at load, because the compositor samples their
OffscreenCanvas and there is no real display sync to take; 4.14.2 gets a real
one by leaving its loop on animation frames.

4.11.3's overlay read 99 FPS against 101 on the engine's own `vid_fps` counter,
and 4.14.2 read 60/60: the two counters agree to within their rounding, so the
overlay above is what these numbers come from.

The engines cap their own menus at 35 FPS; samples taken on a menu screen read
exactly 35.0 FPS and are not comparable — check the screenshot before trusting a
number.

## Known limitations

- Audio is stereo; no positional panning.
- Music synthesis happens on the engine thread (no threads in these builds).
- GZDoom 4.14.2 cannot start twice in one tab: leaving the game reloads the
  launcher.
- Pointer lock, and therefore look direction, cannot be exercised in headless
  Chromium; that part needs a real window and a real mouse.
- Browser storage is per profile: saves do not follow the folder until exported.
- Touch input is not implemented.
