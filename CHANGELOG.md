# Changelog

## 1.7.3 — a download with only what you need to play

### Docs

- The README is written for someone who has never used a Doom source port:
  where to get a game, where to put it, which file to open, which engine to pick,
  in plain words. No key list — bindings live in Settings → Input.
- Game links point at the Freedoom download page instead of naming one WAD file:
  any of their games works.
- Browser support names every Chromium browser (Chrome, Edge, Brave, Opera,
  Vivaldi) in the README, the in-app Help and the capability message. The System
  panel reports Opera, Vivaldi, Edge and Brave under their own names instead of
  calling them all "Chrome". Brave, Opera and Vivaldi are untested here; the
  docs say so and call Chrome/Edge the tested pair.

### Packaging

- The downloadable ZIP is built from an explicit whitelist: the launcher, the
  three engine bundles, README, LICENSE, PROVENANCE, the licences and the
  `saves/`, `config/` and `backups/` placeholders. `dev/`, `tools/`, `.github/`,
  `engine/engine.worker.js`, the development docs and the dotfiles are no longer
  shipped.
- README links to `ENGINES.md`, `CHANGELOG.md` and `CONTRIBUTING.md` became
  absolute GitHub URLs so the shipped copy has no broken relative links.

## 1.7.2 — the 4 ms frame clamp, removed from every engine

### What was wrong

All three builds end every frame in a zero-delay timer: 4.11.3's and UZDoom's
Emscripten glue implement `emscripten_sleep(0)` as `setTimeout(resolve, 0)`, and
the in-page 4.14.2 driver scheduled its whole render loop the same way. Chrome
clamps nested timers below 4 ms up to 4 ms, so every frame carried a fixed 4 ms
of dead time no matter how cheap the frame was.

All three now service zero-delay work from a `MessageChannel` task, which is not
clamped and is still a real task (the compositor keeps painting). Timers with a
real deadline keep the native implementation, so the frame cap still decides.

### UZDoom looked exempt, and was not

The first UZDoom test patched `GZ_ENGINE_BUNDLE.worker` in the page before
pressing Play and measured no change, which looked like proof that its build
never yields through a timer. The patch never ran: `launch()` loads the bundle
script again, and that load replaces `GZ_ENGINE_BUNDLE` with a fresh object, so
the worker was built from the unpatched copy. Counting the worker's own
`setTimeout` calls from a prelude injected after the launcher's load showed the
truth - about 300 delay-0 timeouts every two seconds, one per frame. Rebuilding
`engine/uzdoom/bundle.js` from the fixed worker (the shim reached 367 FPS) closed
the gap:

| Engine | before | after |
| --- | --- | --- |
| GZDoom 4.11.3 (worker yield) | 103.2 FPS | 249.9 FPS |
| GZDoom 4.14.2 (driver scheduler) | 139.2 FPS | 278.5 FPS |
| UZDoom 4.14.3 (worker yield) | 138.8 FPS | 276.9 FPS |

The range across runs on this machine is wide (4.11.3 measured 245-390 FPS,
4.14.2 289-295, UZDoom 275-367 with the same code), so compare the pairs, not
the absolute numbers.

One ceiling no engine work can lift: the browser presents an OffscreenCanvas at
the display refresh, measured at 142–146 Hz here. Above that the engine draws
frames the screen never shows. Uncapped still keeps input latency lowest and a cap
still works (`+vid_maxfps 146` → 145 FPS on 4.11.3, custom 100 → 98.8 FPS on
4.14.2).

CPU, same machine, every browser process of that profile summed: 0.35 cores
clamped, 0.82 cores uncapped after - 3.2 ms of CPU per frame became 2.2 ms, and
the total is higher only because there are 2.5x more frames. A 146 cap measured
0.96 cores at 145 FPS, twice, so 4.11.3's own limiter costs more CPU than letting
it run. `+vid_maxfps 30` on 4.11.3 and UZDoom measured 34.8 FPS at 1.01 and 0.89
cores: the engine's limiter busy-waits rather than sleeping, so a cap saves
frames but not power. That is the engines' own `I_Sleep`, not reachable from the
launcher short of not capping at all.

### Is the counter right?

It was checked because the numbers looked too good. The launcher counts a frame
where the renderer binds the default framebuffer after a render target, so the
check was each engine's own `+vid_fps` overlay, drawn by the engine:

- 4.11.3: overlay 253 FPS against the launcher's 249.9, and 258 frames per
  wall-clock second from the worker counter (overlay 248, "3 ms (261 fps)"
  before).
- UZDoom: overlay 281 against 276.9 (overlay 139 against 137.9 before).
- 4.14.2: overlay 289 against 278.5 (overlay 143 against 140 before).

All three agree, and `requestAnimationFrame` in the same tab read 142/s - that
is the display, not the engine. This replaces the 1.7.1 diagnosis too: 156 draw
calls per frame and a frame rate that did not move with resolution, lights,
bloom, SSAO or shadow maps meant the cost was never in rendering, it was a
clamped yield that no cvar can reach.

### Simplified

- One `waitForBoot()` instead of two copies of the ready-promise, timeout and
  settle-function wiring (90 s for the worker, 120 s for the in-page build).
- The audio bridge's per-source record carried a `nextTime` field and two
  underrun counters that nothing read; the stream-chaining logic that matters
  is unchanged.
- `engines.js` keeps only fields the launcher reads: `glesOnly` (a renderer
  choice that no longer exists), `requires.threads` and the prose fields
  `saves.namespace` / `saves.format` / `saves.note` are gone, along with the
  comments that referred to them.
- Dead code: an empty branch in `unzip()`, an unused `keys` variable in
  `renderBinds()`, a `cached` flag assigned twice in `rememberGame()`, the
  listener-count diag in the worker's EventTarget shim, and two no-op lines in
  the in-page boot.
- The FPS overlay's tooltip said "p95" but showed the slowest frame of the
  window; it now says what it shows, and the overlay shows `0 FPS` after a
  second without a presented frame instead of leaving the last number up, which
  made a stalled engine look healthy.
- The worker's 1-second window no longer computes `pct60`/`pct70` ("share of
  frames over target"): nothing has read them since the old perf HUD went, and
  they travelled in a message sent ten times a second.
- Both yield queues hand their callbacks out in enqueue order through a plain
  array of ids instead of walking a Map's insertion order by iterator, so a
  cancelled zero-delay callback is skipped where it is read, not by rebuilding
  the iterator.
- Slider drags wrote browser storage on every pixel (two IndexedDB writes per
  `input` event); saves are coalesced during the drag and flushed on `change`.
- The save-refresh path logged the screenshot count every 120 ms, and leaving an
  in-page session left its frame statistics behind for the next one.
- `tools/verify.py` checks what a diff cannot: both generated bundles embed the
  current `engine/engine.worker.js` (the mistake this section is about), the
  version chip matches `APP_VERSION`, and `engines.js` declares no field the
  launcher never reads. The CI job runs it, and no longer has to inline that
  logic as shell heredocs.
- The 4.14.2 scheduler owns its animation-frame ids (a counter above the
  browser's own id space), so `cancelAnimationFrame` stops handing a foreign id
  to the native cancel.

### Docs

- `README.md` now opens with what a first-time player needs: open
  `index.html`, download the free Freedoom WAD, drop it on the page, press
  **Start game**. It says up front that the game itself is not bundled, says
  where to put the file and which file to open, and explains the three engines
  in plain words ("start here", "for new mods", "the newest") before the
  technical table. No key list: bindings live in Settings.

### Verified

- Frame counters cross-checked against each engine's own `+vid_fps` overlay, in
  screenshots (see above).
- A save written into MEMFS during a session still reaches browser storage
  (test file captured under `prof/.../saves/doom.doom2/`), and the save watcher
  still scans every 1.5 s (`fsScans` advancing).
- Frame caps still pace: 146 → 145 FPS on 4.11.3, custom 100 → 98.8 FPS on
  4.14.2.
- UZDoom was rebuilt from the fixed worker and measured 276.9 FPS; a save written
  into its MEMFS during the session reached browser storage
  (`prof/uzdoom-freedoom2-.../saves/uz-uzcheck.zds`).
- Every id the launcher looks up exists in `index.html` (75 checked), and both
  bundles match their source (`tools/verify.py`).
- The CI job now parses the JavaScript, refuses committed game data, checks the
  bundles against their source, the version chip against `APP_VERSION`, and that
  `engines.js` declares no field the launcher does not read.
- Version 1.7.2.

## 1.7.1 — save safety and launcher fixes

### Saves

- **Export includes a save made moments earlier.** The in-page engine (GZDoom
  4.14.2) keeps its savegames in its own memory filesystem, which the launcher
  copies into browser storage every two seconds. Export read only browser
  storage, so a save written in the second or two before pressing **Export** was
  missing from the ZIP. Export now asks the running engine for its tree first -
  as it already did for the worker engines - and merges it over that profile's
  stored rows, so the archive keeps the `config/` and `screenshots/` entries the
  engine's own tree does not cover.
- The in-page engine's saves are also captured as soon as the page is hidden.
  Chromium slows timers in hidden tabs (to roughly once a second, and once a
  minute after five minutes hidden), so a save made just before minimising the
  window could wait for that poll, or be lost if the tab was then closed.
- **Legacy saves from a plain launch are adopted at last.** A game folder is
  named like `doom.doom2`, and the matcher compared that whole folder with the
  IWAD name `doom2`, so it rejected exactly the folder these engines write:
  saves stored before 1.6.2 (and archives imported before a game was picked)
  stayed parked and never appeared in a game. The IWAD's name is now matched as
  the folder's last game segment; a Doom 1 launch still refuses Doom II's
  folder, and a folder with an add-on's name in it is still left alone.
- **A launch no longer reads every stored save body.** Legacy-save adoption
  fetched each IndexedDB row and only then asked whether the row could belong
  to this game, so a long-lived install pulled every save of every game and
  engine into the page on each start. The match is made on the row key first
  and only candidate rows are read.
- **Importing while a game is running stays inside this game.** The live worker
  used to receive every file in the archive, including saves from another game
  or engine; the next save scan then filed those under the running profile.
  Only files for the current profile are handed to the engine now - the rest
  are stored and load on their own next launch.
- Export while the in-page engine runs reads that profile's keys instead of
  every stored body.
- Clearing browser saves also clears the "last save" time, so the panel stops
  showing a timestamp above a zero count.

### Engine paths (measured)

- **The in-page engine no longer holds the WADs twice.** Its driver kept every
  file it had written into MEMFS pinned in a closure for the whole session, and
  the launcher kept its own copy as well. With SharpShooter3D (181 MB of WADs)
  the renderer's PSS measured 700 MB; with the copies released after boot it
  measures 521 MB. The File handles stay, so a relaunch re-reads the files.
- **Save polling reads only what changed.** The watcher read every save and
  hashed its bytes every 2 s — 1.54 ms per tick for 8 x 200 KB saves, on the
  same thread the in-page engine renders on. It now compares size+mtime from
  MEMFS (0.12 ms when nothing changed; 0.28 ms and one file read when a save
  was written).
- 4.11.3 measured 105.4 FPS at 1280x720, 105.9 at 640x400 and 106.1 with
  lights, bloom, SSAO and shadow maps off - no cvar moved it. That was read as
  "draw-call bound" here; 1.7.2 shows it was a clamped 4 ms frame yield, and
  the engine measures 390 FPS at the same settings once that is fixed.

### Simplified

- One `migrateRecord()` routine now migrates the shared settings record and
  every engine's own record; the two hand-written copies had drifted.
- One ADL MIDI argument block for the worker engines instead of two identical
  ones behind engine-id checks. Verified against the running launcher: the
  generated argument list for 4.11.3 and UZDoom is unchanged.

### Launcher

- **A remembered engine that this build does not ship no longer dead-ends.**
  The unknown id was kept, the picker read "Unknown engine" and Start stayed
  disabled with nothing explaining it. The launcher now falls back to the first
  engine the browser can run and notes the change in the engine log.
- **A failed 4.14.2 boot shows the error instead of reloading.** Ending a real
  session has to reload the tab (that wasm runtime cannot start twice), and the
  failed-boot path went through the same call, so the fatal card was replaced
  by a silent reload back to the launcher.
- The launcher no longer opens its own `AudioContext` when it starts the in-page
  engine, which brings its own. The extra context only held an unused audio
  device open on the machines that take the lightest path.
- Importing a file shorter than a ZIP end record now reports "not a ZIP archive"
  instead of failing with a DataView range error.
- Removed the last remains of the renderer setting (a dead `DEFAULT_SETTINGS`
  entry, its migration and a write to an element that does not exist) and a
  no-op ternary in the PK3 header check.

### Docs

- `README.md`: Settings → Resolution overrides the 1920-pixel render cap rather
  than only lowering it, and the Save section says what Export reads.
- `engines.js`: the save-location strings for GZDoom 4.11.3 and 4.14.2 name the
  folders those builds actually write to (`savegames/` and `/Save`).
- Version 1.7.1.

## 1.7.0 — release preparation: no game data, new launcher

### Game data removed

Freedoom 1, Freedoom 2 and FreeDM are gone from the project: the two IWADs in
`wads/`, the generated `engine/portable-wads.js` bundle, the Freedoom licence
text, the wad step in `tools/make-portable.py`, and every launcher path that
used them (the **Play FreeDM** button, `loadBundledWad()`, the `bundled` flags in
recent-game records and boot calls). The launcher now requires an IWAD the user
supplies and says so in the UI, with a help section pointing at Freedoom as a
separate download. Nothing in this folder redistributes game data.

Older entries below mention FreeDM because it shipped in those versions; that
history is left as written rather than rewritten.

### Launcher

- The engine dropdown is now three selectable cards with a recommendation tag,
  the engine's compatibility line and its requirements (JSPI / WebGL2). Arrow
  keys move between cards; the active card is `aria-checked` and the only one in
  the tab order.
- The empty state explains that no game data is bundled and what an IWAD is;
  **Start game** stays disabled until a base IWAD is selected, instead of
  launching a PWAD into nothing.
- New palette and layout: warm accent for the primary action and active engine,
  clearer panel hierarchy, larger hit areas, a version chip, and a **Reload
  launcher** action on the fatal screen.
- The capability badge now follows the selected engine (it could previously go
  stale after switching engines).

### Memory and I/O

- The Save data panel counts saves from IndexedDB **keys** and reads the last
  change from a small `meta` record, instead of loading every stored save body
  on each refresh. On a long-lived install that was the largest avoidable read
  in the page.
- Legacy-save adoption lists keys first and fetches only the rows that can
  belong to this game.
- Starting a game restores only the current profile's save rows; it used to
  load every stored save, for every engine and game, into the page first.
- A launch no longer rewrites an unchanged game into IndexedDB: if the recent
  entry is already cached, the multi-megabyte `gamedata` write is skipped.
- Carries the 1.6.8 fixes: no `<script>` element or AudioContext handler
  accumulation across sessions.

### Repository and legal

- `README.md` rewritten for a public release: no bundled game data, a where-to-
  get-an-IWAD section, measured performance/memory numbers, project layout,
  rebuild instructions and the licence/source position.
- `licenses/README.txt` rewritten without Freedoom and with a source-
  availability section; `PROVENANCE.md` gains §9 with the exact upstream tags
  and the GPLv3 source obligation.
- `CONTRIBUTING.md` (rules, pre-PR checks, release checklist), a CI workflow
  that compiles the helper scripts and rejects committed WAD/PK3 files, and a
  `.gitignore` that keeps game data and extracted build inputs out of git.
- Version 1.7.0.

## 1.6.8 — memory: two real accumulations fixed, the rest measured

### What was tested

Six alternating GZDoom 4.11.3 / UZDoom sessions in one page (the picker does
not reload), five GZDoom 4.14.2 sessions (that engine reloads on quit), and a
1920×1080 canvas run — each cycle booted the engine, loaded MAP01, then quit
through the same `endGame()` path the Back to launcher button uses. Between
samples the JS heap was force-collected twice, and renderer and GPU process RSS
were read from `/proc`, not guessed.

| Point | Renderer RSS | Script elements | Live listeners |
| --- | --- | --- | --- |
| fresh launcher | 326–334 MB | 2 | 59 |
| 6 worker sessions, after the last quit | 368–391 MB | 2 | 60 |
| in game | 570–617 MB | 2 | 79 |
| 4.14.2, after each reload | 353–358 MB | 2 | — |

The post-quit number is flat from cycle to cycle (not cumulative), and it keeps
falling: 375 MB two seconds after quitting, 352 MB after 30 s, against a 332 MB
fresh launcher. That is Chromium holding freed engine pages in its allocator,
not JavaScript keeping them. Loading the three bundles on a fresh page and
dropping their globals confirms it: 372 → 336 MB, so the 38 MB of base64 text is
reclaimed once the engine owns the decoded bytes.

There is therefore **no 100 MB-per-session leak** in this build. A 450 MB tab is
the engine peak plus that retained allocator (and the GPU process, which stays
flat at 217–226 MB in all runs); reloading the launcher returns it to baseline.

### What was actually accumulating

Two things grew without bound, both invisible to a JS heap reading:

- **One `<script>` element per bundle per launch.** After six sessions the page
  held 20 script elements instead of 2. The elements were only delivery
  vehicles — their globals are used and then deleted — so they are now removed
  as soon as they have run (launcher, in-page loader and the 4.14.2 glue
  loader). Verified: 2 elements after six sessions.
- **The AudioContext was never closed.** Every launch added six ended-handlers
  to the page and its finished `BufferSource`s stayed reachable from the audio
timeline, with their PCM attached. `stopAudio()` now detaches and disconnects
  each source, drops its buffer, and closes the context; `ensureAudio()` builds
  a fresh one on the next launch. Verified: listeners return to 60 after every
  quit (was 59 → 96 after six), and audio still starts in each session (source
  starts counted 17, 32, 49, 66 across four launches).

`S.stats` is also dropped when a session ends (the last telemetry frame, which
with `?dev=1` carries the 600-entry ring).

## 1.6.7 — 41 MB of duplicate payloads gone, no dev diagnostics in normal play

### The folder no longer stores the same bytes twice

The demo went from 189 MB / 46 files to **148 MB / 37 files**:

- `wads/freedm.wad` (22.2 MB) was byte-identical to the gzip payload already
  inside `engine/portable-wads.js`. Removed; the bundled FreeDM button reads the
  bundle, as before.
- `engine/gzdoom.js`, `gzdoom.wasm` and the five support PK3s (19.7 MB) were
  duplicated inside `portable-engine.js` / `portable-data.js`. Removed.
- `dev/__pycache__` (a stale Python bytecode cache) removed, and the audio
  investigation notes moved from the top level into `dev/`.

`tools/make-portable.py` recreates any missing input from its own bundle before
rebuilding (`--from-bundle` rewrites all of them), so a rebuild still works on
the trimmed folder. Round-trip checked in both directions: every restored file
matched the original by SHA-256, and regenerating produced MD5-identical
bundles.

### Telemetry: the FPS overlay no longer pays for debugging data

`frame-stats` runs ten times a second. It used to copy all 600 frame timestamps
and ship them with the hitch log, draw-call counters, filesystem-scan timing,
listener bookkeeping and audio bridge counters even in a normal session. It now
reads the 1-second window straight from the ring and sends only
`{fps, mean, min, max, pct60, pct70}`; the frame graph, hitches and counters are
built only with `?dev=1`. The listener log is capped and dev-only (it grew for
the whole session with nothing reading it), and the unused canvas-readback
message, its launcher handler and the launcher's long-task observer were removed.
Nothing user-visible changed: the overlay still updates five to ten times a
second and the `?dev=1` view still has every counter it documents.

### UZDoom and 4.11.3: measured again, both draw-submission bound

Same rig and scene (FreeDM MAP01, 532×564 canvas, headless Chromium 157, AMD
iGPU). Recorded because the numbers were reported as regressions:

| Engine | Measured now | Every cvar tried |
| --- | --- | --- |
| UZDoom 4.14.3 | 137–142 FPS | `vid_maxfps 1000`, `gl_light_shadowmap 0`, `gl_multisample 0`, `gl_particles_style 0`, `cl_maxdecals 0` — no change |
| GZDoom 4.11.3 | 101–107 FPS | the 1.6.6 list plus `gl_sort_textures 1`, `gl_multithread 0/1`, `vid_scalemode 1`, `vid_maxfps 1000` — no change |

The UZDoom overlay was checked against the engine's own on-screen `vid_fps` at
the same moment (138 vs 133), so it is not under-counting. Both workers spend
their frame in draw submission (257 and 308 calls), which no console variable
reduces.

Render size is the one thing that does move them. The same UZDoom session:

| Canvas | FPS |
| --- | --- |
| 320×200 | 145–147 |
| 532×564 (test window) | 137–142 |
| 1920×1080 | 120–127 |

The launcher renders at the window size in device pixels (long side capped at
1920), so a maximised or HiDPI window costs frames; Settings → Resolution is
where to trade that back. This is also the likely source of the 155 FPS reading
reported for an earlier session: it was taken at a smaller canvas than the
1920-wide one used now, not from a build that has since become slower.

What improved between 4.11 and 4.14 is upstream code, not a setting: 4.12–4.14
reworked scene and draw-list handling, and 4.14.2's release notes list "Revert
clipper to older code path when not in Ortho/OOB (speed improvement)" (commit
`c7d25f1`). No cvar selects that path, and there is no Emscripten/CMake/Ninja
toolchain in this folder to rebuild 4.11.3 with it. GLES stays pinned: it is the
fastest backend in these builds (106 FPS against 14.4 on GL3+).

## 1.6.6 — GL3+ removed, 4.11.3 tuning measured, one less copy of the IWAD

### GL3+ was a trap, not a choice

Measured on 4.11.3, same map and canvas: GLES **106 FPS**, GL3+ **14.4 FPS**.
The GL3 path in these WebAssembly builds lands in a software fallback, so the
Renderer setting is gone and every engine is pinned to `vid_preferbackend 1`
(GLES). A stored `gl3` choice migrates to GLES once. This is also the answer to
the UZDoom report: UZDoom never received the GL3 backend (its arguments were
`1` in both cases), so the ~10 FPS it showed was run-to-run variance.

### 4.11.3: what actually costs frame time

Every candidate was measured in one session at MAP01, one setting at a time
(engine's own frame statistics):

| Setting | FPS |
| --- | --- |
| baseline as shipped | 101.6 |
| `gl_multisample 0` | 96.5–101.3 (noise) |
| `+ gl_particles_style 0` (smooth → square) | 102.2 |
| `+ gl_light_particles 0` | 102.2 |
| `+ gl_light_sprites 0` | 102.1 |
| `+ cl_maxdecals 256` | 102.8 |
| `+ gl_texture_filter 2` | 102.0 |
| `gl_lights false` (big visual loss) | 103.1 |

Nothing in that list is worth a visual change: the build is CPU-bound on its own
per-frame work (308 draw calls at ~32 µs each), which is why the newer engines
render the same scene faster. The launcher therefore keeps the defaults and
does not disable lights, particles or decals behind your back.

### RAM: no second copy of the game files

The recent-games cache used to be filled from `bytes.slice()` copies — a full
extra copy of the IWAD (22 MB for freedm.wad, 28 MB for freedoom1.wad) alive on
every launch. IndexedDB clones buffers when they are written, so the cache is now
written from the original buffers before the engine takes them. Verified: the
cache row is still written and the Recent games list still works.

## 1.6.5 — One frame-rate control for all three engines

### Uncapped / VSync / Custom, on every engine

The 1.6.4 VSync checkbox only changed the in-page engine, because only that
engine can be paced by the display. Frame rate is now one setting with three
modes that mean the same thing everywhere:

- **Uncapped** — 4.14.2 measured 137 FPS, 4.11.3 101, UZDoom 141.
- **VSync** — capped at the measured monitor refresh (the launcher samples it
  once per load: 61 Hz here). 4.14.2 leaves its loop on the animation frame;
  the worker engines take `+vid_maxfps <refresh>`, since the compositor samples
  their OffscreenCanvas and a real display sync is not available to them.
  Measured: 4.14.2 60 FPS, 4.11.3 59 FPS.
- **Custom limit** — a 30–300 slider. 4.14.2's build ignores `vid_maxfps`
  (a 100 cap still drew 137), so the driver paces its loop instead; measured
  100 FPS at a 100 cap and 59 at 60. The worker engines use `vid_maxfps`
  (4.11.3: 86 at a 90 cap).

Existing installs migrate once: the old VSync checkbox became `vsync`, a
non-zero old limit became `custom`.

### Settings that only one engine could honour now say so

The Renderer choice (GLES / GL3+) exists in the 4.11.3 build only; the settings
screen disables it for the GLES-only builds (4.14.2, UZDoom) and names the reason
instead of silently ignoring it. The volume slider now reaches 4.14.2
(`snd_mastervolume` was hardcoded) and the worker engines too. Resolution,
filtering, frame rate, sensitivity, invert Y, music, binds and the FPS counter
were already common to all three.

### While a game runs

The launcher now drops the boot payloads as soon as the engine owns them: the
two 4.14.2 base64 files (17.9 MB + 19.5 MB of text) and the three worker bundles
(12.7 + 14.3 + 11.2 MB, measured at 23.6 MB RSS when loaded on an idle launcher)
used to sit in the page for the whole session.

## 1.6.4 — VSync switch, uncapped 4.14.2, less RAM after a session

### The refresh ceiling is now a setting

4.14.2 is the only engine that renders on the page's main thread, and
emscripten runs that loop through `requestAnimationFrame` — so the engine was
pinned to the monitor refresh (60 in the test rig, 144 on a 144 Hz screen) and
no `vid_vsync` value could change it. Unless VSync is ticked, the driver now
schedules that loop with timers instead: **137–139 FPS in the same session that
used to read exactly 60**, and 60 again with VSync on (measured, both ways).

Settings → **VSync** is new, off by default. All three engines take `vid_vsync`
from it; the frame-cap setting still applies on top.

### Memory at the launcher

The bundled engine and FreeDM arrive as 12.7 MB + 14.3 MB + 11.2 MB of base64
in globals. After quitting back to the launcher they were held for the rest of
the session with nothing using them; loading the same three files by hand on an
idle launcher added **23.6 MB RSS**, and they are now released when the session
ends (the next launch re-reads them from the browser's cache). Verified over two
launch→quit cycles: the second launch boots normally with the globals gone.

For scale, the launcher page's own JS heap is ~9.5 MB with no game; a blank tab
in the same browser is ~2.3 MB. A 140 MB tab is mostly Chromium's own renderer
and GPU processes, not this page.

### Why 4.11.3 reads lower than UZDoom

Both worker engines get identical arguments and the same canvas size. Measured
on MAP01: 4.11.3 submits 308 draw calls per frame at 31.8 µs each (101 FPS),
UZDoom 257 at 27.6 µs (141 FPS). That is the engine's own renderer doing less
work per frame, not a launcher setting.

The 35 FPS reading on 4.11.3/UZDoom menu screens is GZDoom's own menu frame
limiter; 4.14.2's menu is uncapped. Nothing in the launcher caps it.

## 1.6.3 — Honest FPS on 4.14.2, and the missing engine arguments

### The 4.14.2 FPS counter was double-counting

The driver counted every bind of the default framebuffer, and GZDoom binds it
more than once per frame (deferred pass, HUD, 2D) — so a 140 FPS game read 280.
It now counts the transition back to the default framebuffer, the same rule
`engine.worker.js` has always used.

Cross-checked against GZDoom's own `vid_fps` display in one screenshot per
engine: 4.11.3 engine 101 fps / overlay 99, UZDoom 116 / 118, 4.14.2 60 / 60
before the fix read 120. All three now report frames actually drawn.

### 4.14.2 was missing the worker engines' arguments

The in-page branch returned early, so it never received the frame-cap and
synthesis settings the other engines get. It now gets `+vid_maxfps` (its own
default is 200), `+cl_capfps 0` (its default is 1), `uiscale`/`st_scale`,
`mouse_sensitivity`, `snd_mastervolume`, and the OPL tuning
(`adl_chips_count 1`, `adl_emulator_id 2`, `adl_run_at_pcm_rate 1`) that removed
the FM synthesis stalls on 4.11.3 — its console confirms `adl_chips_count` drops
from the default 6 to 1. Its MIDI device is left alone: this build already opens
its own OPL emulation (`snd_mididevice` reads -5; 4.11.3's -3 is ignored there).
The launcher's frame cap, sensitivity and volume settings now reach this engine
too.

No engine has settings the others lack, and nothing was tuned for 4.14.2 alone:
its 60 FPS reading is the browser's animation-frame clock, because it is the
only engine that renders on the page's main thread.

## 1.6.2 — Save profiles, sharp 4.14.2, FPS on the in-page engine

### Saves are scoped per engine and per game

Every launch now derives a profile from the engine id and the exact IWAD/mod
file set, stores rows under `prof/<profile>/saves/<game>/…`, and restores only
that profile. This closes the reported hole: a Freedoom Phase 1 save made in
4.11.3 was restored into 4.14.2 running an unrelated mod set, and loading it
mixed two games' assets (cracked map, wrong sounds, broken sprites).

Verified: 4.11.3 + FreeDM stored under `prof/gzdoom-freedm-…`; launching 4.14.2
with the same game left its save root empty; 4.14.2 + `freedoom1.wad` was a
third profile, also empty at start; back on 4.11.3, exactly one file was
restored. Export/import round trip kept both profiles intact.

Rows written by 1.6.1 and earlier have no profile folder. The first launch whose
game matches (GZDoom names save folders after the game) takes them in; rows for
other games are left alone for their own launch.

### 4.14.2 drew blurred textures

The in-page build was running at its own defaults: `gl_texture_filter 4`
(smooth trilinear) and `gl_texture_filter_anisotropic 8`. The worker engines
have always been launched with filter 0 and anisotropy 1, which is the crisp
look. 4.14.2 now receives the same cvars, tied to the Texture filter setting.
Measured on one fixed view, switching only that cvar in the console: Laplacian
variance 62.1 (filter 0) vs 21.0 (filter 4) — its default was ~3x softer.

### FPS counter on 4.14.2

The in-page engine has no worker to report frame statistics, so its readout was
permanently hidden. The driver now counts presented frames (default-framebuffer
binds on the WebGL context it already wraps) and the launcher turns that into
the same "NNN FPS" label. Verified in game: steady 120 FPS while the frame
counter advanced 120 per second, so the hook is one count per frame.

## 1.6.1 — Invert mouse Y off by default

1.6.0 shipped `Invert mouse Y` switched on as a default. With it on, the
reporting machine's look was still inverted, so the default is now **off**:
`+set invertmouse 0` on every engine unless the box is ticked.

Installs that inherited the 1.6.0 default are corrected once, in every engine's
saved settings record (`invertMigrated` marker), and a choice made afterwards is
kept. The box stays per engine, so a build that reads Y the other way round (the
4.14.2 line) is one tick away without touching 4.11.3.

Verified from a fresh profile: the checkbox is unticked, and the engine argument
list contains `+set invertmouse 0` for all three engines. Also verified that a
stored `invertY: true` record without the marker is rewritten to `false` on the
next load, for the active engine record and for the others.

## 1.6.0 — saving works mid-game, GPU context release, mouse Y setting

### Saving in GZDoom 4.14.2 and UZDoom: three separate defects

All three were reproduced in a real Chromium session driven over CDP, by
starting MAP01 from the menu and saving through the engine's own Save Game
screen (name typed, confirmed). Measured before the fixes:

| Engine | Before | After |
| --- | --- | --- |
| GZDoom 4.11.3 | save captured, toast shown | unchanged |
| GZDoom 4.14.2 | `Game saved.` in the log, nothing captured, canvas black | captured 2 s later, still in game, canvas keeps rendering |

| UZDoom 4.14.3 | `Game saved.` + `glCheckFramebufferStatus failed: GL_FRAMEBUFFER_UNSUPPORTED`, canvas black | captured, still in game, no framebuffer error |

1. **The console and save-name field could not be typed in.** The worker built
   keyboard events with `new KeyboardEvent(type, init)`; that constructor has no
   `keyCode`/`which`/`charCode` members, so it silently dropped them and
   Emscripten's SDL2 text-input path received 0. GZDoom's Save Game screen
   requires a name, so the save could not be confirmed — the screen just went
   dark behind the menu. `engine.worker.js` now pins the legacy fields as own
   properties on the event.
2. **GZDoom 4.14.2 never exported anything, and kept saves in a place nobody
   looked.** `GZ414.exportSaves()` referenced an `fs()` helper that only existed
   inside `G.start`, so it always threw `fs is not a function`; even a correct
   call would have read `~/.config/gzdoom/savegames`, while this build writes to
   `/Save/<game>/…` at the filesystem root. The helper moved to module scope and
   the driver walks `/Save` plus the XDG paths.
3. **UZDoom's save root was wrong.** The engine writes
   `~/.local/share/games/uzdoom/savegames` (measured from its own fs tree), not
   `~/.local/share/uzdoom`; the watcher never saw a file. Fixed in the registry.

### Saving no longer takes you out of the game

- GZDoom 4.14.2's saves are now read from the page every 2 s while you play
  (size + FNV signature per file), stored and confirmed with a toast. Previously
  the only capture happened when you left the game, which unavoidably reloads the
  launcher. Leaving still does a final capture as a safety net.
- The worker engines already polled every 1.5 s; they now actually find
  UZDoom's files, so the same "keep playing, export later" flow works there.

### The black screen after saving, and the context it killed

GZDoom and its forks draw a screenshot into a texture framebuffer when a save is
written. On 4.14.2 and UZDoom WebGL2 rejects that attachment
(`GL_FRAMEBUFFER_UNSUPPORTED`). On 4.11.3 the pass is worse: the log reads
`Game saved.` and then the browser **loses the WebGL context** — the canvas goes
black while the frame counter keeps running at ~119 FPS, and that dead context is
what made the next engine in the same tab fail its WebGL2 probe.

All three engines now start with `+set storesavepic 0`, skipping the picture.
Verified on each: save, stay in game, gameplay visible immediately afterwards, Esc
opens the menu, and no `gl-lost` event is raised. The save data is complete —
only the load-menu thumbnail is missing (`No Picture`).

### GPU context released, WebGL2 probe retried

- Leaving a worker game now sends `release-gl`: the worker calls
  `WEBGL_lose_context.loseContext()` and only then is the worker terminated. A
  terminated worker's context can otherwise stay alive until the GPU process
  notices, and the next engine in the same tab could fail to create one.
- The startup WebGL2 probe releases its own context and retries four times with
  a short backoff. The message for a genuine failure no longer sends you to the
  hardware-acceleration setting first — it offers a reload first.
- The worker reports `webglcontextlost` to the page, which explains it instead of
  going silently black.
- Verified: quit 4.11.3, start UZDoom in the same tab — context created, engine
  booted, no fatal, no "hardware acceleration" screen.

### Mouse Y is a per-engine setting

`Invert mouse Y` (Settings → Input) now drives `+set invertmouse 0|1` for every
engine, stored per engine. The 4.14.2-only `extraArgs` hack is gone.

### Frame-rate accounting

- `+vid_maxfps` now passes the Frame cap setting literally; the old
  `settings.maxfps || '120'` fallback never applied (the string `'0'` is truthy)
  and only made the code look as if uncapped came with a default.
- Measured, FreeDM MAP01, 21 one-second windows per engine, same window and
  settings: GZDoom 4.11.3 101.8 FPS median / 9.82 ms mean / 3 windows with a
  frame over 33 ms; UZDoom 138.0 FPS / 7.25 ms / 6 windows. Neither had a frame
  over 100 ms. Menus cap themselves at 35 FPS, which is why the samples are
  taken in-game.
- UZDoom's ADL MIDI emulator core was re-measured with the Nuked core
  (`adl_emulator_id 2`) and the older cheap core: 138 FPS median, 7.25 ms mean,
  0 of 21 windows over 100 ms with Nuked. The half-second stalls that motivated
  the cheap core came from six chips, not from the core, so UZDoom now uses the
  same Nuked core as 4.11.3 and the two engines sound alike.

### Documentation and repository preparation

- `README.md` replaces `README.txt`: GitHub-rendered, with the save flow,
  measurements, limits and licences; the launcher's "Read manual" link follows.
- `COMPATIBILITY.md` replaces `COMPATIBILITY_REPORT.md` and keeps only the
  engine-level findings (WAD/PK3 loading, MAPINFO behaviour, wheel handling,
  audio bridge, save paths, pacing), with no third-party game data or notes.
- `LICENSE` (GPL-3.0), `.gitignore`, `.gitattributes` (generated bundles kept
  byte-exact).
- `PROVENANCE.md` and `ENGINES.md` updated for the changes above.
- No mention of any third-party commercial game or its files remains; none of
  its files were ever present in this folder.

## 1.5.3 — experimental labels, provenance record

- Picker entries labelled `GZDoom 4.14.2 (Experimental)` and
  `UZDoom 4.14.3 (Experimental)`; a registry flag (`experimental: true`) drives
  the suffix. GZDoom 4.11.3's entry and arguments unchanged.
- `PROVENANCE.md` records upstream repositories, tags and commit SHAs, which
  public WebAssembly build produced each binary, the ports' documented build
  flags, every local change, the licence position and the rebuild procedure —
  including the gap: these are upstream-derived prebuilt Emscripten binaries
  repackaged for `file://`, not compiled in this folder, and the single-threaded
  UZDoom port is pinned to 4.14.3 while upstream stable is 5.0.3.
- Re-verified: all three engines boot from `file://`, render, and log their own
  startup banners.

## 1.5.2 — 4.14.2 look direction, UZDoom stalls, per-frame JS

- 4.14.2 vertical look was corrected with that engine's `invertmouse` (now a
  setting rather than a hardcoded argument).
- UZDoom microfreezes traced to OPL3 synthesis, like 4.11.3 before: windows with
  a frame over 100 ms fell from 94 of 460 (shipped defaults) to 12 of 430 with
  one ADL chip at PCM rate.
- Draw-call counters moved behind `?dev=1` (they cost one JS call per draw).
- `powerPreference: 'high-performance'` on both WebGL paths.

## 1.5.1 — inverted look actually fixed, render at the window

- The 4.14.2 vertical-look difference came from the launcher asking for
  `unadjustedMovement` pointer lock there and a plain lock everywhere else; all
  engines now ask for a plain lock.
- Default resolution became **Window (native)** (viewport in device pixels, long
  side capped at 1920) instead of a fixed 1920×1080, with a one-time migration
  for installs that never touched the setting.
- Default frame limiter became **Uncapped** instead of 120.
- UZDoom no longer receives `+lockcvar` (it dropped that command and parsed the
  cvar names as commands).

## 1.4.0 — UZDoom from the USB stick, no server anywhere

- UZDoom replaced with a single-threaded 4.14.3 WebAssembly build: no pthreads,
  no `SharedArrayBuffer`, no COOP/COEP, no server.
- Packaged as one 20 MB `engine/uzdoom/bundle.js` (glue, worker source, wasm,
  engine PK3s; gzip + base64), loadable from a classic `<script>`.
- Registry grew `binaries.bundle`, `saves.memRoot`, `saves.ini`,
  `saves.keyPrefix` and `saves.memSaveRoot`, so a worker engine can be added as
  data.
- Per-engine save namespaces and a second save root, so UZDoom's saves and ini
  cannot collide with GZDoom's.

## 1.3.0 — mouse input on 4.14.2, second engine selectable

- 4.14.2 never acquired pointer lock, so the mouse was dead there; a click on
  the game now requests the lock and the engine's own handlers take over.
- The game canvas carries `id="canvas"`, which Emscripten's element lookups use.
- Availability became per engine: a missing JSPI no longer disables an engine
  that does not need it.

## 1.2.0 — second engine bundled

- GZDoom 4.14.2 added as `boot: 'inline'`: glue, wasm and engine data as base64
  plus a driver that feeds Emscripten's `getPreloadedPackage`/`wasmBinary` hooks,
  so it runs on the page with no worker, no JSPI and no server.
- Savegames captured to browser storage when leaving the game, restored on the
  next launch (leaving reloads the launcher; the wasm runtime cannot start twice
  in one tab).
- Audio investigation with an instrumented AudioContext showed that the earlier
  engine's silence on a particular commercial data set was decided inside that
  engine build, not by the launcher's audio bridge, worker or OffscreenCanvas.

## 1.1.0 — engine registry

- `engines.js` registry: id, name, version, build, requirements, boot path, save
  namespace and per-engine notes; the launcher no longer hard-codes an engine.
- Engine picker with requirements shown up front; the choice is remembered.
- Settings stored per engine (`settings:<id>`), with the old shared record kept
  as a fallback.
- Audio diagnostics counters (sources, buffers, nodes) behind `?dev=1`.

## 1.0.0 — portable launcher

- GZDoom 4.11.3 WebAssembly engine that runs from `file://` in a worker.
- Bundled FreeDM, Freedoom 1/2, save export/import, recent games, settings.
- Mouse-wheel replay as `[` / `]` for the engine build whose SDL2 layer never
  registers a wheel listener.
