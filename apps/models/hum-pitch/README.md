# hum-pitch: how well do existing note transcribers turn humming into notes?

Baseline before fine-tuning a note model for "hum a song". Measurement only, CPU only, nothing trained.
Results: [results/baseline.md](results/baseline.md) (generated tables: [results/tables.md](results/tables.md)).

## Test data

| set | what | clips |
|---|---|---|
| `humtrans-test` | real hums, HumTrans official TEST split (CC BY-NC: evaluation only), as aligned in `hum-beats/test-humtrans` | 296 |
| `humtrans-tune` | real hums from the HumTrans TRAIN split (`hum-beats/dev-humtrans`), only to choose Basic Pitch's settings | 149 |
| `synth-test` | synthetic hums: 250 from round one (`hum-beats/full/test`), 250 from round two (`hum-beats/r2b/test`), each 100 voice + 50 breathy + 100 instrument leads | 500 |

References:
* **HumTrans**: the score MIDI shifted by the per-recording time offset fitted in hum-beats (the hummers sang
  along with about 0.2 s latency; `build_humtrans_test.py` stores the shifted times in each recording's JSON),
  then moved by whole octaves to the octave the person actually hummed in (`scripts/fit_octaves.py`; HumTrans
  writes the score's octave, and most men hum an octave below it).
* **Synthetic**: the INTENDED MIDI pitch at the PERFORMED onset and offset (the fine-tuning target). Notes swallowed
  entirely are left out.

## Models

* **Basic Pitch** (Spotify, Apache-2.0, `basic-pitch` 0.4.0, TensorFlow ICASSP 2022 model): defaults (onset 0.5,
  frame 0.3, minimum note 127.7 ms, melodia trick) and settings tuned on `humtrans-tune`.
* **pYIN** (librosa) + note segmentation.
* **SwiftF0** (`swift-f0` 0.3.0, ONNX, CPU) + the same note segmentation.

Note segmentation (`hum_pitch/core.py: segment_notes`): frames that are unvoiced or more than 40 dB below the
clip's loudest frame are silence (gaps up to 30 ms are bridged); inside a sounding stretch a new note starts when
the pitch leaves the current note's median by more than 0.7 semitone for at least 50 ms; notes shorter than 80 ms
are dropped; a note's pitch is its median rounded to a semitone. Repeated notes of the same pitch with no
silence between them stay one note.

## Metrics (`hum_pitch/core.py: clip_metrics`, mir_eval 0.8.2)

* note F-measure, onset only (+-50 ms, +-50 cents), mean over clips;
* note F-measure, onset and offset (offset within 20% of the note length or 50 ms), mean over clips;
* right pitch: share of reference notes with an estimated note of the same MIDI pitch (class and octave) starting
  within +-100 ms; the rest are classed as octave error, one-semitone error, other wrong pitch (an estimated note
  of another pitch within +-100 ms) or missed. Pooled over notes. All estimates are whole MIDI notes.

## Run it

```bash
V=~/.local/share/casperaki/venvs/hum-pitch/bin/python   # Python 3.11: basic-pitch 0.4.0, tensorflow 2.14, numpy<2, setuptools<81, swift-f0, librosa, mir_eval
cd ~/apps/casperaki/apps/models/hum-pitch
$V -I scripts/build_sets.py                                   # set manifests -> /mnt/d/casperaki-data/hum-pitch/sets/
for m in basic-pitch pyin swiftf0; do $V -I scripts/predict.py --model $m --sets humtrans-tune humtrans-test synth-test --workers 6; done
$V -I scripts/fit_octaves.py --sets humtrans-tune humtrans-test
$V -I scripts/tune_basic_pitch.py --set humtrans-tune
$V -I scripts/score.py                                        # results/tables.md, per-clip CSV in /mnt/d/casperaki-data/hum-pitch/results/
```

Venv set-up: `uv venv --python 3.11 ~/.local/share/casperaki/venvs/hum-pitch` then
`uv pip install basic-pitch mir_eval librosa pretty_midi soundfile swift-f0 "numpy<2" "setuptools<81"`
(TensorFlow 2.14 breaks on numpy 2; resampy needs `pkg_resources`).
