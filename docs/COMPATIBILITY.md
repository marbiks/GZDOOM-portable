# Compatibility notes

What runs, what each engine needs, and the limits that are not obvious. Measured
numbers and their history live in [`CHANGELOG.md`](CHANGELOG.md).

## How this is tested

Chromium 157 (Brave), page opened as `file:///…/index.html`, no server, no
headers, no network. Input and save flows are driven through `dev/cdp.py`; the
launcher's own `?dev=1` mode adds per-frame telemetry and the unfiltered engine
log.

## Engine start-up

| Engine | Boots from `file://` | Needs | Runs |
| --- | --- | --- | --- |
| GZDoom 4.11.3 | yes | JSPI, WebGL2 | Web Worker + OffscreenCanvas |
| GZDoom 4.14.2 | yes | WebGL2 | on the page, own canvas and AudioContext |
| UZDoom 4.14.3 | yes | JSPI, WebGL2 | Web Worker + OffscreenCanvas |

No `SharedArrayBuffer`, pthreads, headers or server are needed. All three open
their own title screen; the launcher does not pass `-warp`.

## WAD / PK3 loading

- IWAD detection reads the WAD header and directory. PWADs and PK3/ZIP/IPK3
  archives are accepted and handed to the engine in pick order, so later files
  override earlier ones.
- Only one IWAD is accepted per launch; add-ons without one cannot start.
- The bundled archive names are reserved in the in-memory filesystem, so a user
  file called `gzdoom.pk3` is renamed instead of replacing the engine's own
  archive.
- Recent games cache the picked files in IndexedDB (up to 96 MB) so a relaunch
  does not need the file picker again.

### MAPINFO

Found on 4.11.3: a MAPINFO that adds a full map block with properties aborts that
build (it throws and JSPI cannot suspend), while MAPINFO that only sets map
titles loads. The newer engines were not seen aborting on the same data. If a
map pack will not start, try another engine entry.

## Mouse and wheel

- Pointer lock is requested by the launcher on every engine. The 4.14.2 build
  never asks for it itself; without the request it ignores motion and clicks.
- Vertical look: the 4.14-era builds feed pointer-lock Y motion with the opposite
  sign to 4.11.3. The **Invert mouse Y** setting (default off, per engine) drives
  the engine's own `invertmouse`.
- Wheel: 4.11.3's SDL2 layer never registers a wheel listener, so the launcher
  replays each notch as `[` / `]`, bound to `weapprev` / `weapnext` in the
  generated config. 4.14.2 handles the wheel natively; the replay is harmless
  there because those keys are unbound by default.

## Audio

The worker engines have no `AudioContext`; `engine.worker.js` shims one and
posts PCM to the page, which owns the real context. Consequences:

- Stereo only: OpenAL positional panning is flattened.
- One gain node per AL source is reused and chunks are chained sample-accurately.
- Music is synthesised on the engine thread. The launcher tunes ADL MIDI to one
  emulated OPL3 chip at PCM rate, which removes the periodic synthesis stalls
  these single-threaded builds had with the default six chips.

## Saves

| Engine | Engine-side location | Capture |
| --- | --- | --- |
| GZDoom 4.11.3 | `~/.config/gzdoom/savegames/<game>/` | worker polls the tree every 1.5 s |
| GZDoom 4.14.2 | `/Save/<game>/` (HOME is unset in this build) | page reads the MEMFS every 2 s |
| UZDoom 4.14.3 | `~/.local/share/games/uzdoom/savegames/<game>/` | worker polls the tree every 1.5 s |

Storage is scoped per engine **and** per game: every launch computes a profile
from the engine id and the exact file set, stores rows as
`prof/<profile>/saves/<game>/…`, and restores only that profile into the
engine's save tree. Without this, GZDoom's Load Game menu would list saves from
every engine and game.

`storesavepic 0` is passed to every engine. The save-screenshot pass makes these
builds lose or reject the GPU context (4.14-era logs
`GL_FRAMEBUFFER_UNSUPPORTED`), leaving a black screen after saving. With the
picture off, saving leaves the game rendering; the save is complete and only its
thumbnail in the Load Game menu is missing.

## Backend and rendering defaults

GLES (`vid_preferbackend 1`) on every engine. The 4.11.3 build's GL3+ backend
falls into a software path under WebAssembly (measured at 14.4 FPS against 106 on
GLES for the same scene), so the launcher no longer offers it.

GZDoom 4.14.2 ships with smooth trilinear filtering and 8× anisotropy; the worker
builds use filter 0 and anisotropy 1. Every engine now receives the same pair,
tied to the launcher's Texture filter setting, so the same textures look the same
on all three.

## Known limitations

- Audio is stereo; no positional panning.
- Music synthesis happens on the engine thread (no threads in these builds).
- GZDoom 4.14.2 cannot start twice in one tab: leaving the game reloads the
  launcher.
- Pointer lock is refused in headless Chromium, so look direction has to be
  checked in a real window.
- 4.11.3 and UZDoom cap their own menus at 35 FPS; that is engine behaviour, not
  the launcher.
- Browser storage is per profile: saves do not follow the folder until exported.
- Touch input is not implemented; keyboard, mouse and gamepad work.
