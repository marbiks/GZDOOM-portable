# GZDoom Portable

**Open `index.html` in a modern browser and play.** Nothing to install, nothing
to set up, no internet: the
whole Doom engine lives in this folder, so it runs straight from a USB stick or
your desktop.

The game itself is not included, because game files are copyrighted. Download
the free game, take the WAD out of its ZIP, drop that on the page, press **Start
game**. That is the whole setup.

[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

## What this is

- **One folder, three engines.** GZDoom 4.11.3, GZDoom 4.14.2 and UZDoom
  4.14.3, each with its own settings and its own saves.
- **Runs from `file://`.** No server, no installation, no background process.
- **No game data is included.** Bring `DOOM.WAD`, `DOOM2.WAD`, `HERETIC.WAD`, …
  or the free [Freedoom](https://freedoom.github.io/).
- **Saves survive a tab close.** They are kept in this browser, apart per engine
  and per game, and export to a ZIP.

## Two downloads

Both are this launcher with the same three engines; take whichever you like.

- **Normal** (`GZDoom-Portable-<version>.zip`) — everything included.
- **Lite** (`GZDoom-Portable-<version>-lite.zip`) — about 17 MB smaller. It
  leaves out one optional pack of widescreen artwork, so status bars and menus
  use the classic 4:3 art. Engines, saves, mods and settings work the same.

## Start here

You need this folder, a modern browser, and one **game file**.

### 1. Open the launcher

Double-click **`index.html`**. It is the only file you open; keep the whole
folder together, because the page loads everything beside it.

- If the file opens in a text editor, right-click it → **Open with** → your
  browser.
- `index.html` on its own does not work.

### 2. Get a game file (a "WAD")

- An **IWAD** is the game itself — `DOOM.WAD`, `DOOM2.WAD`, `HERETIC.WAD`,
  `HEXEN.WAD`, … You need exactly one.
- A **PWAD** or **PK3** is an add-on: new levels, a weapon mod, a total
  conversion. Optional, any number.

The free game is **Freedoom**: <https://freedoom.github.io/>. It downloads as a
ZIP — extract the WAD files inside and add one of them. Phase 1 and Phase 2 are
both complete games; either works. More places to get game files are below.

### 3. Put the file somewhere you can find it

Next to `index.html`, in Downloads, on the desktop — anywhere works. The
launcher does not scan folders; you pick the file in the dialog.

### 4. Add the file to the page

Drag the WAD onto the big **Add your game files** box, or click it and browse.
Add mods the same way, in the order they should load (later files override
earlier ones). The game is then remembered under **Recent games**.

### 5. Press Start game

Leave the first engine (GZDoom 4.11.3) selected unless you want newer features.
Wait for the title screen, then click the game once so it takes the mouse.
Resolution, volume, frame rate, mouse and key bindings are in **Settings**.

### 6. Next time

Open `index.html` again, choose the game under **Recent games** (or add it
again), press **Start game**. Your saves are still there.

## Where to get game files

- **Freedoom — free:** <https://freedoom.github.io/>. Complete Doom games,
  BSD-licensed, legal to copy and pass on.
- **Doom, Doom II, Heretic, Hexen, Strife — paid:** buy them on GOG or Steam and
  use the `.WAD` files from your own installation.
- **Mods and extra levels:** the [idgames archive](https://www.doomworld.com/idgames/)
  and Doomworld's releases forum. A mod still needs an IWAD to run.

## Which engine should I pick?

- **GZDoom 4.11.3 — start here.** The stable default.
- **GZDoom 4.14.2 — for new mods.** The newest GZDoom features.
- **UZDoom 4.14.3 — the newest engine.** Three years of upstream work beyond
  4.11.3.

Run one at a time. Each keeps its own settings and saves, so trying another
never damages the first. A mod that needs a newer engine will not run on an
older one; that is why all three are in the folder.

All three run in most modern browsers. The two worker engines need JSPI; GZDoom
4.14.2 needs only WebGL2, so it is also the one to try in an older browser.
Engine details are in
[ENGINES.md](https://github.com/marbiks/GZDOOM-portable/blob/main/docs/ENGINES.md)
and [COMPATIBILITY.md](https://github.com/marbiks/GZDOOM-portable/blob/main/docs/COMPATIBILITY.md);
where each binary comes from is in [PROVENANCE.md](PROVENANCE.md).

## Loading WADs

Choose one IWAD and any number of add-ons (`.wad`, `.pk3`, `.ipk3`, `.zip`).
Drag and drop works. Only one IWAD loads at a time; add-ons without an IWAD
cannot start, and the launcher says so instead of guessing.

Load order is GZDoom's: later files override earlier ones, and DECORATE,
ZScript, ACS, MAPINFO/UMDF, PK3 and IPK3 mods load as they do natively. A total
conversion that ships its own `gzdoom.pk3` must be added **last**, after its
WADs; the launcher renames it so it cannot overwrite the engine's own archive.
Each game opens on its own title screen.

## Saves

A page opened from `file://` cannot write into this folder, so saves are stored
in this browser (IndexedDB) while you play:

- A save is picked up within a couple of seconds; nothing reloads.
- A toast confirms it, and the **Save data** panel shows the count.
- Saves are kept apart per engine and per game, so nothing mixes.

**Export** builds a ZIP with your saves, config and launcher settings;
**Import** restores it on another computer. Keep that ZIP with the folder (for
example in `backups/`); the browser cannot write there itself.

Browser storage belongs to one browser profile. Saves do not follow the folder
until you export and import them.

## Settings

Resolution, texture filtering, frame rate, fullscreen, FPS counter, mouse
sensitivity, invert mouse Y, volume, music and key bindings. Every engine keeps
its own copy, so switching engines does not rewrite the other one's settings.

**Frame rate** has three modes: *Uncapped* (default), *VSync* (a cap at the
monitor refresh) and *Custom limit* (30–300).

**Invert mouse Y is off by default.** Vertical look differs between these engine
builds, and the setting is stored per engine.

## Performance

All three engines are fast enough for Doom. The frame rate depends mostly on
the render size: the launcher draws at the window size in device pixels, with
the long side capped at 1920. A maximised or HiDPI window costs frames —
Settings → **Resolution** gives them back.

A screen can only show its own refresh rate, so numbers above it are headroom,
not extra smoothness. Measurements are in
[`CHANGELOG.md`](https://github.com/marbiks/GZDOOM-portable/blob/main/docs/CHANGELOG.md).

## Browser support and limits

- Most modern browsers with WebGL2; the two worker engines also need JSPI.
  Tested here on current Chromium.
- Audio is stereo.
- Music is synthesised on the engine thread.
- GZDoom 4.14.2 runs one session per page load: leaving the game reloads the
  launcher, and it starts again normally after that.
- Save-game thumbnails are off (`storesavepic 0`) because the picture pass
  breaks the GPU context. Saves are complete; only the load-menu image is
  missing.
- Browser storage is per profile; see Saves above.
- Touch input is not implemented; use keyboard + mouse or a gamepad.

## Troubleshooting

**Nothing happens when opening `index.html`.** Open it in a modern browser; some
file managers open HTML in a text editor. The page must stay next to `engine/`.

**"This browser cannot run…" / NOT SUPPORTED.** The browser is too old or
hardware acceleration is off. Update it and check `chrome://gpu`; if you just
left another game, reload once.

**Start game stays disabled.** No IWAD is selected. Add `DOOM.WAD`,
`DOOM2.WAD`, a Freedoom IWAD or another base game; a PWAD/PK3 alone cannot
start.

**Black screen after Start.** Open Settings → Engine log; the engine's own
output and any startup failure are there.

**No sound.** Check the volume in Settings and, for music, the **Play music**
check box. Audio is stereo.

**A save did not appear.** Give it a couple of seconds; the launcher polls.
Check the Save data panel's count and the toast.

**Need a clean start.** Settings → *Clear browser saves* (saves only), and
Recent games → *Clear* (cached game files).

## Folder layout

```
index.html                  Launcher page. Open this.
launcher.js                 UI, storage, archive import/export, engine boot.
engines.js                  Engine list (the picker reads only this).
engine/                     The three engines, one folder each.
backups/ saves/ config/     Folders for your exported save archives and config.
licenses/                   GPLv3 text and third-party notices.
PROVENANCE.md               Upstream tags, build sources, local changes.
```

The engines travel inside the page as classic scripts because a `file://` page
may not `fetch()` its own files or start a worker from a `file://` URL in
Chromium. Two of them then run in a worker; GZDoom 4.14.2 runs on the page.

## Licences and legal

- **Launcher code:** GPL-3.0 ([LICENSE](LICENSE)).
- **GZDoom, UZDoom and their WebAssembly builds:** GPL-3.0
  ([licenses/GPL-3.0.txt](licenses/GPL-3.0.txt)). Sources and build provenance
  are in [PROVENANCE.md](PROVENANCE.md).
- **Third-party code inside the binaries** (SDL2, zlib, libjpeg, OpenAL Soft,
  ZMusic, ADL MIDI/Nuked OPL3): notices in
  [licenses/README.txt](licenses/README.txt).
- **No game data is included.** Doom, Doom II, Heretic, Hexen and Strife IWADs
  are copyrighted; supply your own and do not redistribute them with this
  folder. [Freedoom](https://freedoom.github.io/) is a free alternative.
- **Doom is a trademark of id Software.** This project is not affiliated with or
  endorsed by id Software, ZDoom, GZDoom or UZDoom.

GPLv3 requires the corresponding source for a distributed binary to be
available. If you pass this folder on, keep `PROVENANCE.md` and `licenses/` with
it. No tracking, no analytics, no network requests.

## Contributing

Bug reports and pull requests are welcome — see
[CONTRIBUTING.md](https://github.com/marbiks/GZDOOM-portable/blob/main/docs/CONTRIBUTING.md).
Please do not attach game WADs to issues or commits: reproduce with a Freedoom
IWAD instead. Rebuilding the engine bundles is documented there, and rebuilding
from source in [PROVENANCE.md](PROVENANCE.md) §6.
