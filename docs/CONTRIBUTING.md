# Contributing

Thanks for taking a look. This project is a `file://`-only launcher for
WebAssembly Doom engines, so a few rules are stricter than usual.

## Ground rules

- **Never commit game data.** No `.wad`, `.pk3`, `.ipk3` or `.zip` game files,
  commercial or free. Reproduce issues with a Freedoom IWAD downloaded
  separately.
- **Keep `file://` working.** The page may not `fetch()` its own files or start
  a worker from a `file://` URL. Engine payloads travel as classic `<script>`
  bundles; do not add a network request, a module import or a `fetch()` to the
  boot path.
- **No telemetry.** Nothing may leave the machine.
- **Measure before claiming.** Frame rate, memory and load-time claims in the
  docs are measured with the harness in `dev/`; unmeasured numbers do not go in.

## What to run before a pull request

```sh
python3 -m py_compile tools/*.py dev/*.py
```

Then open `index.html` from disk, start each engine with an IWAD you own, save
once, quit, and confirm the save count increases. The launcher runs from the
folder as-is; only the release folders need `tools/build.py`, and there is no
package manager.

If you change `engine/engine.worker.js`, regenerate the bundles that embed it:

```sh
python3 tools/make-portable.py
python3 tools/make-uzdoom-bundle.py --from-bundle
```

If you only change `launcher.js`, `index.html` or `engines.js`, no regeneration
is needed.

## Adding an engine

Use the registry, not the boot code. `engines.js` describes the entry and
`ENGINES.md` documents the supported boot paths (`worker`, `inline`). A bundled
worker engine needs `binaries.bundle` pointing at one generated file that
defines `window.GZ_ENGINE_BUNDLE`; `launcher.js` already knows how to decode it.

## Release checklist

1. Bump `APP_VERSION` in `launcher.js` and the version chip in `index.html`.
2. Add a `CHANGELOG.md` entry with what changed and any measurements.
3. `python3 -m py_compile tools/*.py dev/*.py` passes.
4. `python3 tools/build.py` writes `builds/normal/` and `builds/lite/`; each
   engine boots from `file://` in `builds/normal/`, plays, saves and quits, the
   save count rises and the next launch restores it.
5. `git status` shows no game data, no save archive, no extracted build input
   (`engine/uzdoom-src/`, `engine/gzdoom/gzdoom.js`, `engine/gzdoom/gzdoom.wasm`).
6. `../PROVENANCE.md` still lists the exact upstream tags and the source links for
every shipped binary (GPLv3 source availability).
7. `licenses/` and `../PROVENANCE.md` travel with the release; tag the commit and
   attach a source archive or keep the repository public.

Publishing the repository or a release is a maintainer decision; nothing in the
code uploads or deploys anything.
