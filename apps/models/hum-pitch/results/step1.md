# SwiftF0 front end, step 1: better curve-to-notes (no training), 2026-11-23

Code: `hum_pitch/notes.py`, `scripts/notes_steps.py` (tune / score), `scripts/curve_errors.py`. Full tables by slice:
[notes-steps.md](notes-steps.md); chosen settings: [notes-steps-settings.json](notes-steps-settings.json).
Every setting was chosen on humtrans-tune (149 HumTrans TRAIN recordings) only, greedily step by step, on
"F at +-100 ms with the right MIDI pitch" (so that extra notes cost something; right-note % alone rewards splitting).

Chosen: (1) one global tuning offset per recording (a drifting offset, Gaussian window 2-16 s, was never better);
(2) Krumhansl-Schmuckler key from the notes, notes within 0.45 semitone of the midpoint between two semitones go to
the scale neighbour; (3) energy-onset splits (delta 1.2), scoops of up to 200 ms that glide at least 0.3 semitone
into the next note merge into it, minimum note 0.2 beat (at least 60 ms), tempo from librosa; with the labelled beat
grid the tempo comes from the grid (weighting onsets near grid sixteenths did not help: weight 0 chosen).

## Results (test sets; right note = same MIDI pitch, onset within +-100 ms; error shares of all reference notes)

| step (cumulative) | HumTrans right | prec. | octave | semitone | synthetic right | prec. | octave | semitone |
|---|---|---|---|---|---|---|---|---|
| 0 SwiftF0 + segmentation | 65.6% | 61.9% | 0.0% | 15.1% | 64.6% | 70.0% | 1.1% | 11.4% |
| 1 + tuning offset | 67.4% | 63.4% | 0.0% | 13.4% | 65.9% | 71.3% | 1.1% | 10.4% |
| 2 + key snapping (estimated key) | **71.2%** | 67.0% | 0.0% | 8.6% | 65.1% | 70.4% | 1.0% | 11.1% |
| 2' + key snapping (true key, upper bound) | 72.4% | 68.2% | 0.0% | 6.7% | 68.2% | 73.8% | 1.2% | 6.6% |
| 3 + better splitting, no grid | 70.1% | 71.7% | 0.0% | 9.3% | 60.0% | 71.8% | 0.8% | 10.3% |
| 3' + better splitting, labelled beat grid | 67.5% | 72.7% | 0.0% | 9.1% | 60.5% | 73.1% | 0.9% | 10.0% |
| 3' with the true key (upper bound) | 69.0% | 74.3% | 0.1% | 6.4% | 63.1% | 76.4% | 1.0% | 6.1% |

F (+-100 ms, right pitch) on HumTrans: 0.637 -> 0.654 -> 0.691 -> (0.702) -> 0.709 -> 0.700; synthetic: 0.672 ->
0.685 -> 0.676 -> (0.709) -> 0.654 -> 0.662.

## What it means

* **Tuning offset + key snapping work on real hums**: right notes 65.6% -> 71.2%, semitone errors 15.1% -> 8.6%;
  men gain most (53.5% -> 61.9%). The estimated key is close to the true key on HumTrans (71.2% vs 72.4%).
* **On synthetic hums the estimated key does not help** (65.9% -> 65.1%), the true key does (68.2%; round two
  52% -> 60%): round one has non-diatonic scales (pentatonic, harmonic minor) and 2-bar clips, where the key estimate
  is weak. A key estimator that allows those scales, or one fed by more context (the whole hum), is the next lever.
* **Better splitting is a trade**: on HumTrans it removes spurious notes (precision 67% -> 72%) for about one
  point of recall; on synthetic clips (faster, shorter notes) it loses recall (65% -> 60%). Ablation on
  synthetic test (diagnostic only, not used for tuning): the tempo-relative minimum note length costs most (missed
  18% -> 24%), scoop merging about 2 points, energy onsets add almost nothing. With a grid it is not better than
  without (HumTrans tempos are steady and librosa's tempo is already close). Keep step 3 off, or keep only scoop
  merging, until it is tuned on data that has fast notes.
* Octave errors stay at 0-1%: not a problem to solve here.

## SwiftF0's pitch curve vs the performed curve (pitch.npz), synthetic test, 16 ms frames

| leads | clips | voicing recall | voiced where the reference is silent | within 50 cents | octave err | 50-150 cents | other gross | median abs err |
|---|---|---|---|---|---|---|---|---|
| voice (hum-like synth) | 141 | 96.5% | 33.4% | 99.0% | 0.27% | 0.4% | 0.29% | 3.0 cents |
| voice: SoulX singer | 59 | 90.6% | 21.1% | 97.9% | 0.11% | 1.3% | 0.70% | 6.4 cents |
| breathy | 100 | 97.3% | 42.4% | 98.4% | 0.91% | 0.2% | 0.49% | 3.4 cents |
| instrument | 200 | 87.7% | 36.2% | 89.5% | 2.97% | 1.3% | 6.23% | 5.0 cents |

The "voiced where the reference is silent" share includes reverb tails, note releases and breath noise that do
sound in the audio, so it overstates false alarms. On voice and breathy leads the curve is already within 50 cents
on 98-99% of frames: the note errors come from the hummer's intention (detune, drift) and from the curve-to-notes
step, not from the tracker.
