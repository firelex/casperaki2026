# hum-beats: report (night of 2026-11-22)

Design: [SPEC.md](SPEC.md). Full score tables: [results/scores-beatthis-hum-20261122-2305.md](results/scores-beatthis-hum-20261122-2305.md).
Data checks on the full set: [results/data-checks-full-set.txt](results/data-checks-full-set.txt).

## In one paragraph

We built 30,000 labelled synthetic melody clips (one melody line each, half of them hum-like voices) and
fine-tuned Beat This! (`final0`) on them in one run of one epoch. On held-out synthetic clips the fine-tuned
model is far better than the original: beat F-measure 0.32 -> 0.53, downbeat F 0.16 -> 0.30, right tempo
21% -> 35%, and just as much better on lead sounds it never heard (test-unseen). **On real hums (HumTrans) it is
not better**: beat F 0.556 -> 0.537 (no significant difference), downbeat F 0.352 -> 0.293 (significantly
worse), right tempo 58% -> 54%, although it makes half as many double-tempo mistakes (24% -> 12%). The
synthetic data teaches something real (tempo octave) but, in this form, does not carry over to real hums.
Recommendation: **keep the hum lab on `final0`** for now. There were no hum-lab recordings yet to test with.

## What was built

* **Data set** `/mnt/d/casperaki-data/hum-beats/full/` (13 GB): 30,000 clips (owner allowed 10,000-30,000;
  generation turned out cheap, 30,000 clips in 12 minutes on 28 processes, and the pilot was clean).

  | split | clips | families (source melodies) |
  |---|---|---|
  | train | 27,500 | about 1,270 precedents + 13,750 procedural seeds |
  | dev | 1,000 | 57 precedents + 500 procedural |
  | test | 1,000 | 57 precedents + 500 procedural |
  | test-unseen | 500 | 36 precedents + 250 procedural, held-out sounds only |

  No family appears in two splits (16,423 families checked); no test-unseen lead sound is used anywhere else.
* **Per clip**: mono 16-bit WAV at 22,050 Hz (what Beat This! uses), `.beats` (Beat This! format), `.json`
  (all parameters, tempo map, intended and performed notes), `.mid` (intended melody with the exact tempo
  map), `.pitch.npz` (performed pitch curve in cents, 10 ms hop).
* **Owner's changes during the night, all applied**: every clip is a single melody line (no drums, no
  accompaniment, no breakdowns; the listed instruments are the sounds the melody is played or hummed with);
  realistic human variation in tempo, precision and pitch, with intended and performed labels stored.
  No clips with drums or accompaniment were ever generated, so nothing had to be discarded.
* **Hum lab**: the brain keeps every recording sent with a meant tempo (`x-meant-bpm`) in
  `~/casperaki-data/hum-lab/` (`BRAIN_HUM_LAB_DIR` in `~/.config/casperaki/brain.env`); the page sends the
  header and says so; spec `apps/brain/test/lab.spec.ts`; committed (837dc4a), brain restarted. No
  recordings there yet.

### Parameter distributions (full set, 30,000 clips)

| | |
|---|---|
| metre | 4/4 34%, 3/4 33%, 6/8 33% |
| bars | 2: 33%, 4: 33%, 8: 34% (24 sparse melodies lengthened to the next size, recorded in their JSON) |
| style | straight 39%, syncopated 39%, swung 22% (6/8 is never "swung") |
| timing | humanised 45%, irregular 30%, perfect 25% |
| start | pickup 42%, on the downbeat 31%, mid-bar 27% |
| lead | synthetic voice 44% + sung library sample 5% (= 49% voice), breathy 12%, bass 8%, synth 8%, keys 8%, strings/brass 8%, guitar 7% |
| voice types (synthetic voices) | low male, high male, female, child: a quarter each |
| vowels | mm, oo, ah, la, da: a fifth each (ee only in test-unseen) |
| pollution | none 15%, light 30%, medium 30%, heavy 25% |
| pause | none 69%, silent beat 18%, silent bar 13% |
| source | precedent 50%, procedural 50% |
| tempo per 20-BPM band (60-80 ... 180-200) | 4,277 / 4,362 / 4,344 / 4,218 / 4,221 / 4,253 / 4,325 |
| length | 3.7 s (5th percentile), 7.7 s (median), 20.5 s (95th), 39.5 s (max); 12 labelled beats median |

### Shortcut tests (full set)

| test | result |
|---|---|
| clip's first labelled beat is a downbeat | 47% |
| first note exactly on beat 1 of a bar | 28% (on any beat: 65%) |
| clip start to first labelled beat | 0.24 / 0.93 / 1.59 s (5th / 50th / 95th percentile) |
| drums | 0% (none at all, per the owner's change) |
| tempo vs uniform 60-200 | Kolmogorov-Smirnov statistic 0.005 |
| mean note velocity | downbeats 0.711, other beats 0.709, off-beat 0.708 (no accent pattern) |
| audio onset strength at downbeats / other beats | mean 1.60, median 1.00 (a few clips pull the mean up; downbeats have more note starts because phrases start there: musical, not a loudness cue) |
| beats preceded by near-silence | downbeats 13%, other beats 12% |

### Label and audio checks

* On-beat notes in perfect-timing clips sit exactly on their beat labels (largest gap 0.00 ms): labels follow the
  same tempo map the notes were placed with.
* Onset detector on the audio (clean / light clips, notes at least 0.2 s apart): on-beat notes found 8.5 ms after
  the label (median), 96% within 30 ms, 100% within 70 ms.
* MIDI read back with pretty_midi: note starts within 0.28 ms of the JSON, bar lines within 0.01 ms of labelled downbeats.
* Performed pitch curve vs pYIN on the audio, per lead kind: median difference 2-4 cents, 88-99% of frames
  within 50 cents, almost no octave errors.
* No effect delays the audio (measured 0 samples for MP3, GSM, reverb, compressor, distortion).

## What the pilot found and what was fixed

Pilot of 500 clips, inspected with `scripts/pilot_checks.py` and by looking at spectrograms with pitch curves and
beat lines drawn over them. Fixed before the bulk run:

1. **The octave table works the other way round from the brief.** `adjustment` in `octave-adjustment-per-row.json`
   is what the engine transposes UP; the recording sounds `label - 12 x adjustment` (a bass labelled c3 sounds c2,
   adjustment +1). pYIN on every slot confirmed it. Note labels use the measured sounding pitch; 38 recordings whose
   measurement disagreed with the table or between slots (chord, FX, palm-muted guitars, odd octaves) are not used.
2. **MIDI beat grid wrong** (bar lines up to 390 ms off, note starts up to 38 ms off): clips start inside a bar and
   pretty_midi counts beats from time 0; the tempo map was averaged per eighth. Now: partial opening measure, exact tempo map.
3. **Library sounds' pitch curve lacked the recording's own vibrato** (bass and sung sample only 54-73% of frames
   within 50 cents); each slot's measured contour is now added (88-98%).
4. **Soft attacks made voice and flute onsets sound 20-35 ms late** vs the label; the rise now starts 40% of the
   attack time early (median now -3 to +17 ms per lead kind).
5. **Breath noise between phrases was as loud as the voice**; now 3-15% of the voice level.
6. **Pickups could be a whole bar** (two beats in 6/8); now always shorter than a bar.
7. **3/4 re-timing lost too many notes** (dropping beat 4 of each 4/4 bar drops every "and of 4"); each bar now
   drops its emptiest beat (82% of notes kept on average).
8. Bass melodies sat too low (around 45 Hz) and the pYIN check could not see below 50 Hz; both fixed.
9. Robustness: 2-bar 6/8 clips (4 beats) never start mid-bar; an empty melody window draws again; sparse melodies
   move up a bar size. A melody-only dry run of all 30,000 plan rows passed before the bulk run.

## The training run

* **Run** `beatthis-hum-20261122-2305` (`/mnt/d/casperaki-data/hum-beats/runs/`): whole model from `final0`,
  learning rate 1e-4, 100 warm-up steps, cosine decay, batch 16, **one epoch: 1,718 steps, each of the 27,500
  training clips seen once**, mixed precision, Beat This!'s shift-tolerant loss and online mask augmentation
  (their pre-computed pitch/tempo augmentation dropped: the generator already spreads both). 6.6 minutes on the
  GPU (23:09-23:16), next to the live servers' 20 GB.
* **A first attempt crashed** (`beatthis-hum-20261122-2254`, step about 1,420): Beat This!'s mask augmentation
  draws masks up to 2 s and fails on our shortest (about 2 s) clips. Masks are now capped at half the clip; every
  training item was run through the data loader once to confirm; then the same configuration ran again from
  `final0` (resuming would have shown some clips twice, against the one-epoch rule). The crashed run had been
  heading the same way (dev beat F 0.452 -> 0.621 by step 1,349).
* **Training loss** (mean per 250 steps): 0.595, 0.496, 0.467, 0.444, 0.447, 0.454, 0.437: fast drop, then flat.
* **Dev during training** (Beat This!'s validation, middle 30 s, nothing trimmed): beat F 0.452 (start) -> 0.543
  (step 149) -> 0.611 (599) -> 0.622 (899) -> 0.627 (1,349) -> 0.634 (1,649); downbeat F 0.185 -> 0.334. No
  divergence. Positive weights recomputed from our data (beat 27, downbeat 101) are close to final0's (19, 86).

## Scores: final checkpoint vs final0, same files

mir_eval F-measure, 70 ms window, mean over clips, nothing trimmed. Tempo ok: median predicted beat interval
within 4% of the labelled one; half / double: within 4% of half or double.

| set | clips | beat F final0 -> fine-tuned | downbeat F | tempo ok | half / double |
|---|---|---|---|---|---|
| dev | 1,000 | 0.315 -> **0.532** | 0.166 -> **0.293** | 18% -> **36%** | 6/6% -> 5/4% |
| test | 1,000 | 0.324 -> **0.528** | 0.163 -> **0.296** | 21% -> **35%** | 4/5% -> 7/4% |
| test-unseen | 500 | 0.324 -> **0.525** | 0.152 -> **0.287** | 21% -> **31%** | 4/8% -> 9/6% |
| test-humtrans (real hums) | 296 | **0.556** -> 0.537 | **0.352** -> 0.293 | **58%** -> 54% | 0/24% -> 1/12% |
| hum-lab (owner) | 0 | no recordings yet | | | |

### Breakdowns on test (final0 -> fine-tuned; every set in results/)

| | beat F | downbeat F | tempo ok |
|---|---|---|---|
| voice lead (synthetic + sung sample), 465 clips | 0.292 -> 0.511 | 0.149 -> 0.284 | 17% -> 32% |
| breathy lead, 128 | 0.126 -> 0.507 | 0.069 -> 0.294 | 6% -> 34% |
| instrument lead, 407 | 0.423 -> 0.554 | 0.208 -> 0.310 | 30% -> 40% |
| timing perfect, 271 | 0.357 -> 0.571 | 0.174 -> 0.328 | 24% -> 43% |
| timing humanised, 432 | 0.336 -> 0.526 | 0.167 -> 0.289 | 24% -> 35% |
| timing irregular, 297 | 0.278 -> 0.492 | 0.146 -> 0.277 | 15% -> 30% |
| 3/4, 319 | 0.333 -> 0.544 | 0.151 -> 0.284 | 20% -> 35% |
| 4/4, 334 | 0.368 -> 0.557 | 0.179 -> 0.273 | 28% -> 40% |
| 6/8, 347 | 0.274 -> 0.486 | 0.157 -> 0.329 | 16% -> 31% |
| 60-90 BPM, 222 | 0.389 -> 0.627 | 0.197 -> 0.333 | 19% -> 49% |
| 90-120 BPM, 225 | 0.357 -> 0.534 | 0.177 -> 0.308 | 32% -> 43% |
| 120-150 BPM, 223 | 0.352 -> 0.512 | 0.161 -> 0.294 | 27% -> 36% |
| 150-200 BPM, 330 | 0.240 -> 0.468 | 0.130 -> 0.264 | 11% -> 21% |
| pollution none, 134 | 0.413 -> 0.594 | 0.233 -> 0.363 | 25% -> 38% |
| light, 330 | 0.369 -> 0.555 | 0.177 -> 0.309 | 25% -> 37% |
| medium, 301 | 0.281 -> 0.520 | 0.147 -> 0.286 | 18% -> 35% |
| heavy, 235 | 0.267 -> 0.464 | 0.122 -> 0.252 | 17% -> 33% |

"Melody alone vs with accompaniment" no longer applies: every clip is a melody alone. Syncopated melodies stay
hardest (test beat F 0.449), and fast tempos (150-200 BPM), where the fine-tuned model now more often halves (18%)
than doubles the tempo.

### Real hums (HumTrans) in more detail

* Beat F: fine-tuned better on 123 recordings, worse on 144, equal on 29; paired Wilcoxon p = 0.20 (no real
  difference). Downbeat F significantly worse (p < 0.001).
* Tempo: half as many double-tempo mistakes (24% -> 12%), but more "other" mistakes (16% -> 29%), in which it places
  about 25% more beats than there are (extra beats at note onsets, most likely). It learned to follow local timing
  (30% of training clips are rubato) and holds a steady pulse less well; HumTrans singers hummed along with
  playback at a steady 65-120 BPM.
* By tempo: better below 75 BPM (0.462 -> 0.526), worse above.
* Same picture on the 238 recordings whose fitted offset is under 0.5 s (0.576 -> 0.547): not caused by doubtful alignments.

Suggested (untested, one run only per the owner's rule): the synthetic data is harder and more irregular than real
hums, and its voices are not yet real enough. Candidates for a next data version: fewer rubato clips, tempo weighted
to the 70-130 BPM people hum at, more realistic voices (or real hums under a licence that allows training), and a
steadier post-processor (Beat This!'s DBN option). The owner's own hum-lab recordings are the test that matters
most; none exist yet.

### Is HumTrans usable?

Yes, for evaluation. Its MIDI is a quantised score (one constant tempo, real time signatures 4/4, 2/4 and
1/4-pickup-plus-4/4, notes on a 16th grid) and each recording is exactly as long as its MIDI; singers hummed along in
time with about 0.2 s recording latency. Per recording one constant offset is fitted (the tempo is the MIDI's own);
296 of 300 sampled test recordings line up (median 96% of notes within 70 ms of an audio onset, 5th percentile 74%),
4 were left out. Caveat: a few fitted offsets are about 1 s and could be a whole beat off (beats still right, bar
lines not), so treat HumTrans downbeats with some caution (the result holds without them). Downloaded: only
`all_midi.zip`, the split file and the 300 WAVs (single files out of the remote zip by HTTP range requests), not the
14.7 GB archive. CC BY-NC: evaluation only, never training.

## Where things are (sizes)

| what | where | size |
|---|---|---|
| data set (wav + labels) | `/mnt/d/casperaki-data/hum-beats/full/{train,dev,test,test-unseen}/`, `plan.jsonl`, `index.jsonl` | 13 GB |
| Beat This! training layout (spectrograms) | `/mnt/d/casperaki-data/hum-beats/bt-data/` | 3.3 GB |
| test-humtrans (22 kHz wav + labels) | `/mnt/d/casperaki-data/hum-beats/test-humtrans/` | 178 MB |
| HumTrans downloads (MIDI, split, 300 wav) | `/mnt/d/casperaki-data/humtrans/` | 365 MB |
| the run | `/mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-20261122-2305/` | 1.5 GB |
| - final checkpoint (the one scored) | `final.ckpt` (with optimiser state), `final-weights.ckpt` (81 MB, loads with `File2Beats(checkpoint_path=...)`) | |
| - intermediate checkpoints | `stepstep=300/600/900/1200/1500.ckpt` | 5 x 243 MB |
| - scores | `scores/per_clip.csv`, `scores/summary.md` | |
| crashed first attempt | `/mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-20261122-2254/` (4 checkpoints) | 973 MB |
| sound cache (regenerable) | `~/.cache/casperaki/hum-beats-sounds/` | 966 MB |
| environment | `~/.local/share/casperaki/venvs/hum-beats/` | |

Deleted: only my own outdated pilot folder (`/mnt/d/casperaki-data/hum-beats/pilot`, earlier generator version) and
my first sound cache.

## For the owner to decide

1. **Switching the hum lab to the new checkpoint: not recommended now** (much better on synthetic hums, not on real
   ones, worse downbeats). Not switched. To try it: point `apps/brain/python/beat_track.py` at
   `/mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-20261122-2305/final-weights.ckpt` (loads like `final0`).
2. Delete the crashed run (973 MB) and the real run's five intermediate checkpoints (1.2 GB)? Listed above; nothing deleted.
3. A second data version along the lines above, scored on hum-lab recordings: please hum some with a tempo entered.
4. Agent Notes was not updated: its server needs an interactive sign-in nobody could do overnight.

## What the data set offers pitch / note models (Basic Pitch and others)

Every clip carries, next to the audio:

* **intended notes** (`json` `notes`): MIDI pitch, score position (bar, beat in bar, quarter notes) and its time on
  the clip's warped timeline (`onset`, `offset`); also as a MIDI file with tempo map and metre (`.mid`);
* **performed notes**: actual onset and offset (`performed_onset`, `performed_offset`), velocity, articulation,
  swallowed notes (soft or missing), per-note detune, scoop, fall, overshoot, vibrato depth;
* **a frame-level performed pitch curve** (`.pitch.npz`: cents every 10 ms, NaN where silent), exact for synthetic
  sounds and measured for library sounds: the per-frame pitch and onset targets Basic Pitch-style models train on;
* every condition (sound, voice type, vowel, pollution chain with values, tempo, timing) for slicing.

A pitch model can train on what was meant (note transcription) or on what was sung (pitch tracking), with the same
family-based splits; test-unseen checks generalisation to new timbres.
