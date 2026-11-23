# AMT spike: completing a hummed melody over given chords

This is a throwaway spike. It asks whether the Anticipatory Music Transformer (AMT; Thickstun et al.,
code github.com/jthickstun/anticipation, weights `stanford-crfm/music-medium-800k`) can take the first
2 or 4 bars of a melody, plus chords for all 8 bars, and write the missing bars without any training.

## Licence

- Code: Apache-2.0 (LICENSE.txt in the repo).
- Weights: every `stanford-crfm/music-*` repo (small, medium and large; 100k, 200k and 800k steps;
  `-ar` variants) is tagged `apache-2.0` on Hugging Face. Commercial use is allowed.
- Training data: the Lakh MIDI dataset (about 176k MIDI files scraped from the web). The dataset is
  published under CC-BY 4.0, but the songs in it are mostly transcriptions of copyrighted music. The
  weights' licence does not resolve that, so it remains a residual risk; the model card claims nothing.

## How to run

The GPU work runs on casdgx01. The venv is at `~/.local/share/casperaki/venvs/amt` there (Python 3.11,
torch 2.4.1, transformers 4.44.2, `pip install -e` of the anticipation repo cloned into
`~/casperaki/amt/anticipation`). `/raid/mstrasser` cannot be created (no permission), so the work dir is
`~/casperaki/amt`.

```
python select_precedents.py          # writes test_melodies.json (20 melodies; runs anywhere)
HF_HUB_DISABLE_IMPLICIT_TOKEN=1 CUDA_VISIBLE_DEVICES=0 \
  python amt_complete.py --out OUT    # 20 melodies x {2,4} prompt bars x top-p {0.95,0.98} x 3 samples
python score.py OUT/completions.jsonl # writes results/score_table.md
python render.py OUT/completions.jsonl --out LISTEN --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 \
  --top-p 0.95 --pick 1 4 7 9 12 17 18
```

`HF_HUB_DISABLE_IMPLICIT_TOKEN=1` is needed only because casdgx01 has an expired Hugging Face token
cached, and the hub rejects it even for this public repo.

## What it does

- **Test melodies:** 20 eight-bar precedents from the brain's vocal banks
  (`packages/arrangement/data/vocals/precedents`): 6 from drLuke, 5 limitedRange, 6 schlager and
  3 stefan. The banks store every melody in C, so each is moved back to its song's original key (10
  different keys) and to an octave whose median pitch lies in 60–71. The banks' "rhythmic-*" entries are
  single-pitch and have no chords, so they cannot be used here.
- **Model input:**
  - The prompt bars of the melody are ordinary events on program 53 ("Voice Oohs").
  - Block chords (bass root plus chord tones) for all 8 bars go on program 0 (piano). They are given as
    anticipated controls, so the model sees each chord 5 seconds ahead.
  - The chords are re-struck at every bar line and at every chord change.
- **Decoding:** a copy of the library's `sample.generate` with two changes:
  - The note token may only be a melody (program 53) note or the model's REST padding token. AMT is a
    multi-instrument model and would otherwise also write drums, bass and so on.
  - The library's clipping of controls in the first 50 ms is removed, because it would drop the chord on
    beat 1.

## Findings (240 completions)

| prompt bars | source | n | notes | strong_chord | all_chord | in_key | near_hum | span | ends_tonic | rhythm_sim | density_ratio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | AMT p=0.95 | 60 | 23.0 | 0.78 | 0.68 | 0.98 | 0.90 | 8.57 | 0.30 | 0.72 | 1.17 |
| 2 | AMT p=0.98 | 60 | 22.8 | 0.74 | 0.66 | 0.98 | 0.92 | 9.55 | 0.22 | 0.73 | 1.14 |
| 2 | original | 20 | 18.9 | 0.87 | 0.68 | 0.96 | 0.81 | 9.65 | 0.10 | 0.82 | 0.92 |
| 4 | AMT p=0.95 | 60 | 14.8 | 0.78 | 0.66 | 0.97 | 0.98 | 8.83 | 0.20 | 0.75 | 1.11 |
| 4 | AMT p=0.98 | 60 | 15.2 | 0.80 | 0.64 | 0.97 | 0.97 | 9.23 | 0.22 | 0.74 | 1.16 |
| 4 | original | 20 | 12.5 | 0.87 | 0.69 | 0.96 | 0.99 | 8.50 | 0.10 | 0.75 | 0.94 |

The columns are defined at the top of `score.py`. "original" is the precedent's own bars after the
prompt, scored the same way.

- **Chord conditioning works.** Against the real chords, 0.74–0.80 of strong-beat notes are chord tones.
  Scored against the same song's chords shifted by two bars, the same completions get 0.45–0.51, about
  chance level (the originals get 0.41–0.43). The model follows the chords, though less tightly than the
  real songs (0.87).
- **It stays in key and in range.** 97–98% of notes are in the key's major scale (the originals: 96%).
  The range stays within the hummed range plus 3 semitones for 90–98% of notes.
- **Motif reuse is a little weaker than in the real songs** with a 2-bar prompt (0.72 against 0.82); with
  a 4-bar prompt it matches them.
- **It writes slightly more notes per bar** than the prompt (×1.1–1.17, where the originals have ×0.93).
- **"Ends on the key note" is a weak test:** these are 8-bar sections (verses and pre-choruses), and only
  10% of the originals end on the key note. AMT ends there in 20–30% of completions.
- **top-p 0.95 against 0.98:** no clear difference.
- **Failures:** 1 of 240 completions has no notes at all. Some completions are poor: 25 have under half
  their strong-beat notes on chord tones, and 23 have under 90% of notes in key. So the brain should
  generate several samples and choose the best with these same checks.

## Speed

- Mean 0.62 s per completion (median 0.56 s, p90 0.97 s, max 1.61 s) on one H100, in fp32 with no KV
  cache. The library re-runs the whole context for every token.
- The longest context was 381 tokens of the 1024-token window, so 8 bars never needed the sliding window.

## Problems found

- **transformers' default SDPA attention breaks the model.** GPT-2's SDPA path ignores the model's
  `scale_attn_by_inverse_layer_idx=True`, which gave a likelihood worse than uniform (negative
  log-likelihood about 13 nats per time token on the repo's example MIDI). Loading with
  `attn_implementation="eager"` fixes it (0.34 nats). The repo pins transformers 4.29.2, which predates
  SDPA. Any serving code must load with eager attention or pin an older transformers.
- **Time is in seconds, not beats:** 10 ms steps and no tempo or bar tokens. Output must be snapped to the
  grid; 3.2% of onsets are more than 30 ms off the nearest 16th note. The model does not know where the
  bar lines are except through the chord onsets.
- **The model has no "key" or "chord" input:** chords have to be voiced as notes of an accompaniment
  instrument. That works, as shown above.
- **Length:** the time vocabulary ends at 100 s and the context at 1024 tokens (341 events). 8 bars of
  melody and chords use about 200–380 tokens, so there is room for about 16–20 bars before the window
  slides.

## Listening files

`/mnt/d/casperaki-data/amt-spike/` on datigator holds 7 melodies (numbers 1, 4, 7, 9, 12, 17 and 18,
across 4 banks and 5 keys). For each there is the original and 6 top-p 0.95 completions (3 from 2 bars,
3 from 4 bars), as MIDI and WAV: piano melody plus quieter piano block chords. `completions.jsonl` there
holds all 240 raw completions.
