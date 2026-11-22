# GZDoom WASM audio / frame-pacing investigation

Scope: the portable build in this folder (worker rendering + OffscreenCanvas + WebGL2,
`file://` launch, offline). Tested with a Freedoom test IWAD, MAP01, at 1920x1080 in headless Chromium 157
(Brave binary) on Linux, AMD Radeon integrated GPU. Audio output could not be *heard* on the
test machine (no audio device); every audio conclusion below is from instrumented numbers,
not from listening.

## 1. Root cause

Music synthesis on the engine's render thread, multiplied by six.

ZMusic's ADL MIDI device is what actually opens in this build (the stream is always 44100 Hz
in 0.5 s blocks = 22050 frames, which is `SoftSynthMIDIDevice(44100)` with the default
`StreamBlockSize = 2`; the OPL device would emit the much smaller blocks implied by
`StreamBlockSize = 14`). GZDoom's ADL defaults are:

```
adl_chips_count   6      <- six emulated OPL3 chips
adl_emulator_id   0      <- MAME core
adl_run_at_pcm_rate false
```

Six OPL3 chips are emulated sample by sample for every rendered chunk. That is ~100-140 ms of
pure wasm work once per 0.5 s chunk, executed inside `UpdateSounds` on the same thread that
produces frames, so the picture stops dead twice a second.

Proof that it is CPU, not a suspension: a 10 ms `setInterval` inside the worker fires **0-2
times** during a 110-136 ms frame gap where it should fire ~12, and then bunches up
afterwards. The thread is busy, not idling in JSPI. The gap also always ends exactly at the
`alBufferData` hand-off (`createBuffer`), i.e. after the synthesis and before any launcher
code runs.

## 2. Was music synthesis responsible?

Yes, and it was the only periodic cost. Profile of the worker over 6 s with music playing:
1.17 s inside a handful of wasm synth functions, 3.2 s idle. Disabling music removes every
periodic stall (see table). Some engine-side cost remains per chunk even at one chip
(~17 ms p99), which is the price of synthesising on the render thread.

## 3. Was worker-to-main audio transport responsible?

No. Measured over an 18 s run (39 music chunks + SFX):

- 0.1-0.5 ms per chunk in the worker (typed-array alloc + channel copy + `postMessage`),
- PCM buffers are transferable (`postMessage` transfer list), no structured-clone copy,
- main thread handled all 175 audio messages in **12.2 ms total, 1.0 ms worst case**,
- ~2 music messages/s, 88 KB PCM per message.

That is ~0.7 % of one frame per second of gameplay. Increasing the batch size would only make
each stall longer, so it was not done.

## 4. Was Web Audio scheduling responsible?

No. Chunks are chained on the Web Audio clock: each `AudioBufferSourceNode.start(when)` is
scheduled exactly where the previous chunk ends, with ~0.5-1.0 s of audio queued ahead, one
reused `GainNode` per OpenAL source, and full teardown on stop. Over the measured runs: 0
underruns, 0 overlapping/gapped stream joins. (One earlier run with a 0.29 s look-ahead showed
a single underrun; with the current lead it is consistently zero.)

## 5. Is rendering an independent bottleneck?

No. With music off the same scene runs at 93.4 FPS, p99 15.6 ms. With the tuned music settings
it runs at 93.1 FPS, p99 16.7 ms. The residual difference is the one-chip synthesis above; the
renderer itself has no separate problem (no frame over 120 ms; the only long frames are level
load and GC).

## 6. What changed

`launcher.js` → `readSettingsArgs()` now pins three engine cvars alongside the existing
`snd_mididevice -3`:

```
+set adl_chips_count 1        one OPL3 chip = 18 two-op voices (Doom MUS has 16 channels)
+set adl_emulator_id 2        the cheapest of the four libADLMIDI cores measured here
+set adl_run_at_pcm_rate 1    emulate at 44100 Hz instead of 49716 Hz + resample
```

Nothing else in the audio path changed in this pass: the existing bridge (transferable PCM,
per-source gain node, sample-accurate chaining, 40 ms lead + 200 ms join guard) was already
measured to be negligible and is kept. `README.md` sections were rewritten with the
new numbers and the remaining limitation. All temporary instrumentation (bench auto-launch,
worker audio event log, 10 ms liveness probe) has been removed from the shipped files;
`engine/portable-engine.js` was regenerated with `tools/make-portable.py`.

## 7. Why it works

Cost per chunk is linear in the number of emulated chips: 6 chips → ~120 ms, 2 chips → ~47 ms
p99, 1 chip → ~17 ms p99. Doom's music never needs more than one OPL3 (DMX playback used a
single OPL2 with 9 voices), so dropping from six to one loses no polyphony that Doom uses. The
core choice and `run_at_pcm_rate` shave the leftover 20-40 %.

## 8. Measurements

Same WAD, map, resolution, renderer, 599 frames per run, frame gaps from the worker's own
frame-timestamp ring.

| condition | FPS | p50 | p95 | p99 | max | gaps > 40 ms |
|---|---|---|---|---|---|---|
| music off | 93.4 | 11.5 | 14.0 | 15.6 | 39.7 | none |
| music on, stock ADL (6 chips, core 0) | 72 | 11.7 | 16.0 | 119 | 139.7 | 10-12 per run, 110-136 ms |
| 1 chip, core 0 | 88.8 | 11.6 | 14.7 | 29.8 | 40.5 | 1 |
| 2 chips, core 0 | 87.4 | 11.4 | 14.7 | 47.2 | 73.4 | 6, 45-50 ms |
| 1 chip, core 1 | 90.8 | 11.5 | 14.7 | 24.8 | 40.0 | 1 |
| 1 chip, core 2 | 93.0 | 11.3 | 14.4 | 16.9 | 33.6 | none |
| 1 chip, core 3 | 86.9 | 11.7 | 16.2 | 21.5 | 38.8 | none |
| 1 chip, core 2, pcm-rate | 92.9 | 11.5 | 14.3 | 16.0 | 40.2 | 1 |
| **shipped settings** (1 chip, core 2, pcm-rate) | **93.1** | **11.5** | **14.4** | **16.7** | **44.9** | **1 (45 ms)** |
| shipped settings + 12 pistol shots (heavy SFX) | 89.0 | 11.5 | 14.7 | 17.4 | 43.5 | 1 (44 ms) |

Audio health in the shipped run: 39 chunks, 0 underruns, 2 stream nodes, 0.97 s queued ahead.
Regression check: plain `file://index.html` → Play with a test IWAD boots to a 1920x1080 canvas,
JSPI/OffscreenCanvas/WebGL2 all present, zero console errors.

Rejected alternatives, on evidence:

- **AudioWorklet / ring buffer.** The measured bottleneck is synthesis cost, not delivery. Both
  add a thread hop without reducing the 17 ms of work, and `SharedArrayBuffer` needs COOP/COEP
  headers, which would break the `file://` requirement. Transferable-buffer message passing
  already costs <1 ms per chunk.
- **Bigger streaming buffers.** Each chunk is already 0.5 s; larger blocks make each stall
  longer, not rarer.
- **Lower `snd_samplerate`.** It does not affect the music stream (fixed at 44100 Hz for ADL).

## 9. Remaining limitations

- Music is still synthesised on the render thread, so a chunk's cost lands in one frame. At one
  chip that is ~17 ms p99, occasionally ~45 ms when it collides with level loading or GC. This
  machine hits ~90-120 FPS at 1920x1080, so 17 ms fits inside one frame; a slower GPU-limited
  setup will absorb it less well. Eliminating it entirely requires rebuilding the engine with
  music synth off-thread (upstream's thread-based `BackgroundProc`/`UpdateSounds` split) or a
  smaller ZMusic stream block — neither is possible without the engine toolchain, which is not
  in this folder.
- `snd_mididevice -3` is kept as configured, but this build opens ADL MIDI regardless (proved
  by the chunk geometry and by the fact that `adl_chips_count` controls the cost). The tuning
  therefore targets ADL.
- No audible verification was possible: the test machine has no audio output device. Numbers
  show no underruns, no stream joins with gaps, and p99 16.7 ms frame pacing, but "sounds
  right" and "no clicks" must be confirmed by ear on a real machine.
- The Settings music toggle still disables music entirely (`-nomusic`); it is no longer needed
  for smooth pacing.
