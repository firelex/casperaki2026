# hum-beats: synthetic melodies for "hum a song"

Goal: find the tempo, beats and bar starts of a melody someone hums into the browser. We fine-tune the beat
tracker Beat This! (CPJKU, ISMIR 2024, MIT; checkpoint `final0`) on a large labelled set of synthetic
melodies, and score it against the original on held-out synthetic clips, on real hums (HumTrans) and on the
owner's own hum-lab recordings. The same clips carry exact note labels (intended and performed) for later
fine-tuning of pitch / note models (Basic Pitch and others).

Results are in [REPORT.md](REPORT.md).

## What a clip is

One melody line, nothing else: no drums, no accompaniment (the owner's specification; hums never have
either). One sound per clip; the sound changes from clip to clip. 2, 4 or 8 bars (a third each).

| Property | Values (drawn per clip) |
|---|---|
| Tempo | uniform 60-200 BPM (beats per minute, beat as below) |
| Metre | 3/4 (3 quarter-note beats per bar), 4/4 (4), 6/8 (2 dotted-quarter beats per bar) - a third each |
| Rhythm style | straight, swung (off-beat eighths delayed 0.06-0.17 of a beat), syncopated (anticipations); 6/8 is straight or syncopated (it already has the long-short lilt) |
| Timing | perfect 25%, humanised 45%, irregular (rubato) 30% |
| Start | on the downbeat 30%, with a pickup (shorter than a bar) 40%, cut in mid-bar 30%; 2-bar 6/8 clips (only 4 beats) never start mid-bar |
| Pauses | none 65%, a whole silent beat 20%, a whole silent bar 15% (labels continue through them) |
| Lead sound | hum-like synthetic voice 45%, the library's sung "ah" sample 5% (so ~50% voice), breathy instrument (flute, whistle) 12%, library instrument 38% (bass, keys, synths, guitars, strings/brass) |
| Pollution | none 15%, light 30%, medium 30%, heavy 25% |
| Silence | 0.1-1.5 s before the first note, 0.3-1.5 s after the last |

### Melodies (two sources, half the clips each)

1. **The app's vocal precedents** (`packages/arrangement/data/vocals/precedents/mlDataRaw-*.json`, the banks
   used by `packages/arrangement/src/vocals/precedents.ts`): 1,423 distinct sung 8-bar melodies in 4/4. A window
   of 2/4/8 bars is taken, transposed to the sound's range, and re-timed: 3/4 drops the fourth beat of every
   bar; 6/8 maps each 4/4 quarter beat onto a dotted-quarter beat (the off-beat eighth lands on the third
   eighth), so 8 bars of 4/4 become 16 bars of 6/8. Rhythm-only precedents (one repeated pitch) get a
   scale-based pitch walk.
2. **A procedural generator** (`hum_beats/music.py`): scale (major, minor, harmonic minor, dorian,
   mixolydian, phrygian, lydian, major/minor pentatonic), phrases of 1-4 bars, rhythm cells per metre and style
   (no note shorter than 90 ms), stepwise motion with leaps and octave jumps, a contour (arch, rise, fall,
   wave, flat), long phrase ends on stable degrees, the last on the tonic, repeated phrase rhythms, breaths.

### Timing: the tempo map

All score positions are in quarter notes from the first downbeat. A tempo map (seconds per quarter on a
1/48-quarter grid, integrated) turns positions into seconds. Everything that bends time is built into the map,
so the beat labels (the map evaluated at every beat position) follow the warped timeline exactly:

* drift: tempo rises or falls linearly over the clip (up to 5% humanised, 8% irregular);
* wander (rubato): a sum of slow sinusoids over 2-6 bars, up to +-2.5% humanised and +-15% irregular;
* rushing into phrase ends: the 1.5 beats before a phrase-end note are up to 6% (12%) faster;
* hesitations: the half beat before a high or long note is stretched (a breath);
* held notes (irregular only): time slows down over some long notes (fermata-like).

Each strength is scaled by a per-clip tempo amount drawn uniformly from 0 (none) to 1 (strong).

### Performance: what the singer actually does

On top of the map, per note (strengths drawn per clip from none to strong):

* onsets early or late: Gaussian, 10-40 ms humanised, 15-60 ms irregular, 5% of notes slip 2.5 times as far;
* legato versus detached notes, lengths cut short or held over, a final note held too long;
* swallowed short notes: very soft, or missing altogether (kept in the labels, marked `swallowed`);
* uneven loudness: a random walk plus note-to-note noise, with **no metric accent at all**, so loudness never
  marks the bar lines;
* pitch: per-note detuning (up to about +-40 cents, more on leaps and high notes), a slow drift sharp or flat
  (up to a semitone by the end), scoops into notes, falls at note ends, overshoot on leaps, glides between
  legato notes, vibrato that varies in rate (4.3-6.8 Hz) and depth (0-60 cents) and comes in late on long
  notes, micro-jitter. Library instruments get only steady per-note detuning and drift (a piano cannot scoop).

### Sounds

* **Synthetic voice** (`render.py`): a harmonic source with glottal-like spectral tilt plus breath noise,
  through four formant resonators per vowel: "mm" (nasal, low-passed), "oo", "ah", "la" (amplitude dip at each
  onset), "da" (closure and burst at each onset). Voice types humming in their own comfortable octave: low male
  (median MIDI 50), high male (57), female (65, formants x1.16), child (71, x1.28). Breath noise in the longer
  gaps. The amplitude rises 40% of the attack time before each onset, so the perceived onset sits on the label.
* **Breathy instruments**: flute (harmonics plus breath noise), whistle (near-sine, high), by additive synthesis.
* **Library sampler**: the app's multisampled recordings
  (`/mnt/d/.../datigator-instruments/instruments`, slot layout from
  `packages/engine-adapter/data/vst-slice-timings/`). Every long-note slot is cut at its real attack, its pitch
  measured with pYIN (sounding note, tuning in cents, full pitch contour). A recording is used only when pYIN
  agrees with `octave-adjustment-per-row.json` (the recording sounds `-12 x adjustment` semitones from its
  label; note: below, not above) - 196 sounds kept, 38 rejected (chord, FX and palm-muted guitar recordings,
  wrong octaves). Notes play from the nearest slot, pitch-shifted by resampling (at most about 1.5 semitones);
  wobble basses (built-in tempo LFO) and orchestra hits are excluded, as are sounds whose attack takes longer
  than 250 ms.

### Pollution (Spotify `pedalboard` plus numpy)

By level: distortion, compression, reverb, then noise (white, pink, 50/60 Hz mains hum with harmonics,
low room rumble, background-chatter-like babble with irregular syllables) at a signal-to-noise ratio of 30-45 dB
(light), 18-30 dB (medium), 4-18 dB (heavy); "phone recording" colouring (band-pass ~120-250 Hz to 3.4-7 kHz,
mild clipping, then MP3 at low quality or the GSM phone codec); random peak level -25 to -1 dBFS. We checked
that none of the effects delays the signal (latency 0 samples).

## Labels (next to every `<clip>.wav`, mono 16-bit 22,050 Hz)

* `<clip>.beats` - Beat This! format: one line per beat, `time<TAB>beat-in-bar` (1 = downbeat). Beats are
  labelled from the first beat at or after the first note to the last beat before the end of the last note
  (inside the last bar); beats inside rests and pauses are labelled.
* `<clip>.json` - every generation parameter (metre, tempo, style, timing and its amounts, tempo-map events,
  performance and pitch settings, lead sound, pollution chain with values), the beats (time, beat in bar, score
  position), the tempo map (score position to clip time), and the note list. Per note: intended MIDI pitch,
  intended score position (`q_on`, `q_off`, bar, beat in bar) and its time on the warped timeline
  (`onset`, `offset`), the performed times (`performed_onset`, `performed_offset`, null when swallowed
  entirely), velocity, articulation, swallowed, phrase end, and pitch facts (detune in cents, scoop, fall,
  overshoot, vibrato depth). Every note has `part: "lead"` (the only part).
* `<clip>.mid` - the intended melody at its intended positions, with the clip's exact tempo map (MIDI time =
  clip time, checked to 0.3 ms) and metre; the file opens with a short partial measure (k/32) because clips
  start inside a bar, so the MIDI bar lines fall on the labelled downbeats.
* `<clip>.pitch.npz` - the performed pitch curve: `time_s` (10 ms hop) and `cents` (100 x MIDI, NaN where
  nothing sounds). For synthetic sounds it is the exact curve that drove the oscillator; for library sounds it
  is the note's pitch plus the slot recording's own measured contour (its vibrato and bends).

## Splits

Split by family (the source melody: one precedent, or one procedural seed), never by clip: a melody never
appears in two splits. Precedent families go 4% dev, 4% test, 2.5% test-unseen, the rest train.

| split | clips |
|---|---|
| train | 27,500 |
| dev | 1,000 |
| test | 1,000 |
| test-unseen | 500 |

`test-unseen` uses lead sounds never used anywhere else: a sixth vowel "ee" for the synthetic voice, the
ocarina, and nine whole groups of library sounds (electric pianos, analog lead synths, solo reeds, solo violin,
nylon guitars, acoustic bass: 24 recordings).

Real-world test sets (scoring only, never training):

* `test-humtrans` - real hums from HumTrans (CC BY-NC 4.0, so evaluation only), official TEST split. Each
  recording is as long as its MIDI, which is a constant-tempo score; singers hummed along with about 0.2 s
  recording latency. Per recording one constant offset is fitted (the offset that lines up most MIDI notes
  with detected onsets; the tempo is the MIDI's own); recordings where fewer than 60% of notes line up are
  left out. Beats and bar lines come from the MIDI's grid and time signatures.
* `hum-lab` - the owner's recordings from the app's /lab/hum page sent with a meant tempo (kept by the brain
  in `~/casperaki-data/hum-lab/`); scored on tempo only.

## Training (one run)

`scripts/train.py` uses Beat This!'s own data module, Lightning module, shift-tolerant weighted loss and
cosine warm-up schedule, starting from `final0`. Whole model (about 20 M parameters, so an adapter would save
nothing). Learning rate 1e-4 (theirs from scratch: 8e-4), 100 warm-up steps, cosine decay; one epoch with no
oversampling, so every training clip is seen exactly once; batch 16; their online mask augmentation kept
(each mask at most half the clip long: their 2 s masks crash on our shortest clips),
their pre-computed pitch/tempo augmentations dropped (the generator already spreads tempo and pitch); no 5 s
trim in evaluation. Spectrograms are computed exactly as Beat This! computes them at inference
(`scripts/make_bt_data.py`).

## Code

| file | what |
|---|---|
| `hum_beats/sounds.py` | library sound selection, decoding, slot attack trimming, pYIN pitch checks, cache |
| `hum_beats/music.py` | precedents and re-timing, procedural melodies, tempo map, performance |
| `hum_beats/render.py` | pitch curve, voice / breathy / sampler sources, pollution |
| `hum_beats/generate.py` | the plan (families, splits), one clip end to end, labels, MIDI |
| `scripts/build_sound_cache.py` | build the sound cache (`~/.cache/casperaki/hum-beats-sounds`, ~1 GB, regenerable) |
| `scripts/generate.py` | generate a set or a pilot in parallel |
| `scripts/pilot_checks.py` | label alignment, MIDI, pitch-curve and distribution checks, shortcut tests |
| `scripts/make_bt_data.py` | lay train/dev out as Beat This! training data |
| `scripts/train.py` | the fine-tuning run |
| `scripts/humtrans_fetch.py`, `scripts/build_humtrans_test.py` | test-humtrans (single files fetched from the remote zip) |
| `scripts/score.py` | score models on the same files, with breakdowns |

Environment: `~/.local/share/casperaki/venvs/hum-beats` (Python 3.12, torch 2.7.1+cu128, pytorch-lightning 2.5,
pedalboard, librosa, mir_eval 0.8, Beat This! installed from its GitHub source).

Rebuild everything:

```bash
V=~/.local/share/casperaki/venvs/hum-beats/bin/python
cd ~/apps/casperaki/apps/models/hum-beats
$V scripts/build_sound_cache.py --cache-dir ~/.cache/casperaki/hum-beats-sounds
$V scripts/generate.py --out /mnt/d/casperaki-data/hum-beats/full --scale 1.0 --workers 28
$V scripts/make_bt_data.py --data /mnt/d/casperaki-data/hum-beats/full --out /mnt/d/casperaki-data/hum-beats/bt-data
$V scripts/train.py --data-dir /mnt/d/casperaki-data/hum-beats/bt-data --run-dir /mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-<YYYYMMDD-HHMM>
```
