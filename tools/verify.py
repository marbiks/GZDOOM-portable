#!/usr/bin/env python3
"""Release checks for things a diff of the edited file cannot show.

1. Both generated bundles embed the current `engine/engine.worker.js`. Editing
   the worker and forgetting to repack leaves the shipped engines on old code,
   which is exactly how UZDoom kept its 4 ms frame clamp after 1.7.2.
2. `index.html`'s version chip matches `APP_VERSION` in the launcher.
3. `engines.js` declares no field the launcher never reads.

    python3 tools/verify.py        # exit 1 on any failure
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLES = ('engine/portable-engine.js', 'engine/uzdoom/bundle.js')

# Registry fields the launcher (or engines.js itself) actually reads.
REGISTRY_FIELDS = {
    'id', 'name', 'version', 'build', 'boot', 'badge', 'description',
    'compatibility', 'requires', 'blockedReason', 'binaries', 'saves', 'docs',
    'modNotes', 'experimental', 'noSavePic', 'lockCvars', 'extraArgs', 'fileUrl',
    'file', 'crossOriginIsolated', 'server', 'sharedArrayBuffer', 'jspi', 'wasm',
    'loader', 'data', 'glue', 'driver', 'bundle', 'keyPrefix', 'memRoot',
    'memSaveRoot', 'ini',
}


def read(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        raise SystemExit('missing file: ' + rel)
    return open(path, encoding='utf-8').read()


def bundle_payload(rel):
    text = read(rel)
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


def check_bundles(fail):
    source = read('engine/engine.worker.js')
    for rel in BUNDLES:
        data = bundle_payload(rel)
        worker = data.get('worker')
        if not isinstance(worker, str) or worker != source:
            fail.append(rel + ': worker source differs from engine/engine.worker.js')
        else:
            print('ok   %-28s worker %d bytes' % (rel, len(worker)))
        if rel.startswith('engine/uzdoom') and not data.get('gzip'):
            fail.append(rel + ': expected the gzip-packed layout')


def check_version(fail):
    app = re.search(r"APP_VERSION = '([^']+)'", read('launcher.js'))
    chip = re.search(r'id="version-chip"[^>]*>v([0-9.]+)<', read('index.html'))
    if not app or not chip:
        fail.append('version: could not find APP_VERSION or the version chip')
    elif app.group(1) != chip.group(1):
        fail.append('version: APP_VERSION %s != index.html chip %s' % (app.group(1), chip.group(1)))
    else:
        print('ok   version %s' % app.group(1))


def check_registry(fail):
    declared = set(re.findall(r'^\s{4,}([A-Za-z_]+):', read('engines.js'), re.M))
    extra = sorted(k for k in declared if k not in REGISTRY_FIELDS)
    if extra:
        fail.append('engines.js declares unread field(s): ' + ', '.join(extra))
    else:
        print('ok   engines.js %d fields, all read' % len(declared))


def main():
    fail = []
    check_bundles(fail)
    check_version(fail)
    check_registry(fail)
    if fail:
        print('\n'.join('FAIL ' + f for f in fail), file=sys.stderr)
        print('Bundles: repack with tools/make-portable.py / tools/make-uzdoom-bundle.py',
              file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
