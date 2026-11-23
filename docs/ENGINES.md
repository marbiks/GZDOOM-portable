# Adding another engine

The picker and the launch requirements come from `engines.js`. `launcher.js` has
one branch per **boot path**, not per engine id, so a worker engine that ships
one bundle slots into the existing path without a launcher change.

## What an engine entry looks like

This is the UZDoom entry as it ships:

```js
{
  id: 'uzdoom',
  name: 'UZDoom',
  version: '4.14.3',
  boot: 'worker',                    // 'worker' | 'inline' | 'external'
  badge: 'experimental',             // short tag shown by the picker
  experimental: true,                // adds "(Experimental)" to the label
  description: 'Newest upstream features.',
  compatibility: '...',              // what it is good and bad at
  requires: {
    fileUrl: true,                   // can it run from a file:// page?
    sharedArrayBuffer: false,        // needs SAB (never available from file://)
    jspi: true,                      // needs WebAssembly.Suspending
  },
  binaries: { bundle: 'engine/uzdoom/bundle.js' },
  saves: {
    keyPrefix: 'uz-',                // prefix for this engine's save files
    memRoot: '/home/web_user/.config/uzdoom',                // ini/config
    memSaveRoot: '/home/web_user/.local/share/games/uzdoom', // saves
    ini: 'uzdoom.ini',
  },
  noSavePic: true,                   // start with +set storesavepic 0
  lockCvars: false,                  // skip +lockcvar (UZDoom dropped it)
  modNotes: [],                      // regexes tested against picked file names
}
```

Other fields: `blockedReason` is shown instead of launching an `external` entry,
and `extraArgs` appends engine-specific arguments last. `requires` is also
checked against `crossOriginIsolated`, which no shipped engine uses.

## Boot paths

**`worker` + `binaries.bundle`.** One classic `<script>` sets
`window.GZ_ENGINE_BUNDLE = { loader, worker, wasm, gzip, archives }`. The
launcher decodes it, creates the worker and feeds it WADs, saves and arguments.
`engine/uzdoom/bundle.js` is the reference. This path needs no engine-specific
code.

**`worker` without a bundle.** `binaries.loader` and `binaries.data` load the
`GZP_ENGINE` / `GZP_DATA` globals used by GZDoom 4.11.3. Those global names are
engine-specific, so a new worker engine should ship a bundle instead.

**`inline`.** The build runs on the page. The launcher creates the canvas, loads
`binaries.wasm`, `binaries.data` and `binaries.driver`, and calls the driver's
`start()` function. The current driver uses GZDoom-4.14-specific globals, so a
different inline engine needs one small function next to `bootInline()` in
`launcher.js`; everything above that point (file picking, IWAD detection, save
export/import, settings UI, wheel replay) is shared.

The driver contract is:

```
window.MYENGINE.start({ canvas, files, stateFiles, args, onLog, onReady, onAbort })
```

with `files` as `{ '/name.wad': Uint8Array }` and `args` the engine command line.

**`external`.** The engine cannot run from `file://`; `blockedReason` explains
why and keeps Play disabled.

## Rules that keep this modular

- Add only fields the code reads. `tools/verify.py` fails on a key outside the
  documented set.
- Branch on `boot`, `requires` and `saves`, not on an engine id.
- Keep save namespaces separate. Every launch gets a profile from the engine id
  and the exact file set (`prof/<engine>-<game>-<hash>/`) and restores only that
  profile; `keyPrefix` keeps the engines' own save names apart.
- Keep settings per engine (`settings:<id>`).
- Adding an entry must not change an existing engine's arguments. GZDoom's list
  lives in `readSettingsArgs()` in `launcher.js`.

## Bundled engines

| id | Engine | How it runs | Server | Threads / SAB |
|---|---|---|---|---|
| `gzdoom` | GZDoom 4.11.3 | Web Worker + OffscreenCanvas + audio bridge | no | no |
| `gzdoom414` | GZDoom 4.14.2 (Experimental) | on the page, own canvas and AudioContext | no | no |
| `uzdoom` | UZDoom 4.14.3 (Experimental) | Web Worker + OffscreenCanvas | no | no |

All three boot from `file://` with no headers, `SharedArrayBuffer` or pthreads.
Where each binary comes from, its upstream tag and commit, and what a
from-source rebuild needs are in [`../PROVENANCE.md`](../PROVENANCE.md).

## Which one to pick

- **GZDoom 4.11.3** is the longest-tested engine: worker rendering, saves, mod
  loading and the wheel replay.
- **GZDoom 4.14.2** needs only WebGL2, so it is the one to use when JSPI is
  unavailable or a mod wants newer ZScript/UDMF features.
- **UZDoom 4.14.3** is the newest engine in this folder, but its WebAssembly port
  is pinned to 4.14.3 while upstream stable is newer (see PROVENANCE §3).

## UZDoom notes

It starts like 4.11.3: open `index.html`, pick UZDoom, add an IWAD and any
add-ons, press Start game. It needs JSPI and WebGL2; on a browser without JSPI use
4.14.2.

Its `uzdoom.ini` is read from `/home/web_user/.config/uzdoom` and its saves from
`/home/web_user/.local/share/games/uzdoom/savegames` — the XDG split this engine
uses, measured from its own filesystem tree. Saves are separate from GZDoom's
and cannot be swapped between them.

Like the other two it carries `noSavePic: true`: the save-screenshot pass draws
into a texture framebuffer that these WebGL2 builds reject, and on 4.11.3 it
costs the WebGL context. Saves are complete; only the load-menu thumbnail is
missing.
