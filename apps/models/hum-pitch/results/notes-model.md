# Hum-to-notes model, run one (round one only), 2026-11-23

Full tables: [model-bigru128-humnotes-r1-20261123-1750.md](model-bigru128-humnotes-r1-20261123-1750.md).

## What was trained

* **Inputs** (`scripts/features.py`, computed once from the clip AUDIO, never from pitch.npz): per SwiftF0 frame (16 ms)
  the SwiftF0 pitch, voiced flag, confidence, loudness (dB below the clip's loudest frame) and onset strength;
  the model adds the pitch-class circle and a soft 12-class pitch-class vector.
* **Outputs** (`hum_pitch/model.py`): per frame note onset, note active, and a correction of -4..+4 semitones to
  the tracked pitch rounded to a semitone (the intended pitch); per clip a key signature (12 classes) from attention
  pooling plus a learned, rotation-equivariant 12-step template on the clip's pitch-class histogram.
  Notes are decoded from onset/activity peaks; a note's pitch is the one with the largest summed probability.
* **Labels**: round one's INTENDED MIDI pitch at the PERFORMED onset and offset. The generator stored no key, so the
  key target is the diatonic scale(s) that hold most of the intended notes (uniform over ties: pentatonic melodies
  fit two or three). HumTrans's MIDI key signatures are reliable (98.8% of score notes inside them) and score the key.
* **Model**: conv + 2-layer bidirectional GRU, hidden 128, 649k parameters.
* **Run** `bigru128-humnotes-r1-20261123-1750` on casdgx01 GPU 2 (tmux `hum-pitch-train`): 27,500 round-one train
  clips, ONE epoch (1,719 steps, batch 16, AdamW 2e-3, 100 warm-up steps, cosine), 5 minutes. Every clip transposed
  by a random -6..+5 semitones (input, labels and key move together), so all 12 keys are equally common and absolute
  pitch says nothing about the key (round one's own key spread is already even: 73-99 dev clips per tonic).
  Final checkpoint scored. Run folder: casdgx01 `~/casperaki/hum-pitch/runs/...`, copy in
  `/mnt/d/casperaki-data/hum-pitch/runs/bigru128-humnotes-r1-20261123-1750/` (final.pt 2.6 MB, events, config).
* **Dev** (round-one dev, 1,000 clips, no shared family): frame correction accuracy 86.0% ("never correct" shortcut)
  -> 94.1%; key signature among the best-fitting scales 13% -> 87%; losses still falling slowly at the end.
* **Pilots** (2,000 and 8,000 clips) found one bug before the full run: the key head did not learn at all (loss stuck
  at ln 12). Fixed by giving the network pitch-class inputs and the template key path; the 8,000-clip pilot then
  reached 81% on the key.
* **Decoding thresholds** chosen on humtrans-tune (HumTrans TRAIN) only: onset 0.9, activity 0.5 (the onset threshold
  sits at the top of the grid: the onset head fires too often on real hums).

## Scores (test; right note = same MIDI pitch, onset within +-100 ms)

| set | system | right note | precision | F | octave | semitone | missed | key = MIDI signature | key fits notes best |
|---|---|---|---|---|---|---|---|---|---|
| HumTrans, 296 | today's best (SwiftF0 + tuning + est. key snap) | 71.2% | 67.0% | 0.691 | 0.0% | 8.6% | 15.9% | 49.0% (K-S) | 67.9% |
| | **model** | **72.2%** | **70.3%** | **0.712** | 0.0% | 13.7% | 11.3% | 40.2% | 77.4% |
| HumTrans women, 138 | today's best | 82.3% | 82.5% | 0.824 | 0.1% | 4.3% | 12.1% | 58.0% | 78.3% |
| | model | 82.3% | 81.3% | 0.818 | 0.1% | 9.6% | 7.3% | 50.0% | 90.6% |
| HumTrans men, 158 | today's best | 61.9% | 55.3% | 0.584 | 0.0% | 12.2% | 19.1% | 41.1% | 58.9% |
| | model | 63.6% | 61.2% | 0.624 | 0.0% | 17.2% | 14.6% | 31.6% | 65.8% |
| synthetic voice, 200 | today's best / model | 66.1% / 71.7% | 70.4% / 75.8% | 0.682 / 0.737 | 0.1% / 0.2% | 12.4% / 13.2% | 16.8% / 9.3% | n/a | 46.5% / 64.5% |
| synthetic breathy, 100 | today's best / model | 64.8% / 68.5% | 68.2% / 74.4% | 0.664 / 0.713 | 0.3% / 0.5% | 16.1% / 15.0% | 15.7% / 11.4% | n/a | 53.0% / 74.0% |
| synthetic instrument, 200 | today's best / model | 64.2% / 67.9% | 71.6% / 75.5% | 0.677 / 0.715 | 2.3% / 3.4% | 7.4% / 7.9% | 21.2% / 11.3% | n/a | 58.0% / 79.5% |
| synthetic round one, 250 | today's best / model | 75.4% / 79.9% | 85.3% / 90.9% | 0.800 / 0.851 | 1.0% / 1.5% | 4.0% / 2.4% | 18.7% / 12.9% | n/a | 60.0% / 91.2% |
| synthetic round two, 250 | today's best / model | 54.3% / 58.6% | 56.2% / 60.6% | 0.552 / 0.596 | 1.1% / 1.6% | 18.6% / 21.0% | 18.0% / 8.1% | n/a | 44.8% / 53.6% |

## Reading

* **It beats today's best on real hums, narrowly**: right notes 71.2% -> 72.2%, precision 67.0% -> 70.3%, F 0.691 ->
  0.712. It finds notes much better (missed 15.9% -> 11.3%) but gets their pitch wrong more often (semitone errors
  8.6% -> 13.7%): the pitch corrections it learned on round one's synthetic detune do not carry over to real hummers.
  On round-two clips (real-hum pitch deviations) it is also worse on semitones (18.6% -> 21.0%).
* **Key**: the model's key signature is one of the scales that best hold the notes on 77% of HumTrans recordings
  (Krumhansl-Schmuckler on today's best notes: 68%), but it names the exact MIDI signature less often (40% vs 49%).
  Many HumTrans melodies fit two signatures equally, and the model was trained on such ties as uniform targets, so it
  has no reason to prefer the written one. Tonic and mode (which chords need) are not learned yet: no key was stored.

## Between 72% and 90% on real hums

1. **Semitone errors, 13.7%** (the biggest block). The model needs real-hum pitch behaviour in training: round two's
   contours are taken from HumTrans TRAIN hums (licence decision pending); round-one's synthetic detune is too clean.
   Cheaper now: take the model's notes (onsets, offsets) and pitch them with step 1's tuning offset + key snapping
   (8.6% semitone errors there); untested.
2. **Missed notes, 11.3%**: partly the HumTrans reference itself (onsets 30-45 ms early from the energy-onset
   alignment, repeated notes hummed legato); partly real misses (men 14.6%).
3. **Men** are 19 points behind women at every step.
4. **Key**: train on stored keys (tonic and mode) instead of ties; let the key output feed the pitch decision.
