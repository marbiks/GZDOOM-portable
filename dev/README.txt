dev/
====

Development diagnostics only - not needed to play, not loaded by index.html.

cdp.py
  Minimal Chrome DevTools Protocol client (stdlib only) for driving a real
  Chromium window during verification: navigate, evaluate, real clicks, key
  presses, screenshots. Used because headless Chromium (and the chat preview
  browser) refuse pointer lock (WrongDocumentError), so mouse input can only be
  checked in a real window:

    /opt/brave-origin-bin/brave --no-sandbox --no-first-run \
      --user-data-dir=/tmp/gztest --remote-debugging-port=9793 about:blank
    python3 dev/cdp.py 9793 file:///path/to/index.html

  The launcher's own ?dev=1 mode gives the engine log, per-frame telemetry
  (S.stats: frame times, hitches, draw calls) and the draw-call counters; without
  it only the FPS/hitch clock runs.

AUDIO_PERFORMANCE_REPORT.md
  The audio/pacing investigation behind the ADL MIDI tuning (one chip, PCM
  rate, Nuked core): measurements, rejected alternatives and limits. Kept out
  of the top-level folder because it is engineering notes, not user docs.
