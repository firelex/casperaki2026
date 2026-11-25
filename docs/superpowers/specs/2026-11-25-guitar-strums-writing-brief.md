# Brief: writing strummed-guitar grooves for Casperaki

Casperaki is a music generator. Its guitar track can play **recorded whole-chord strums** of a real guitar (short
or long, downward or upward), plus optional single picked strings and a few guitar noises. You will write
**original strumming grooves** that a human reviewer listens to and approves one by one in a review page (the
"pattern lab"). Approved grooves are then used in generated songs of the genres they are tagged with.

## How a groove is played

- Songs are always in bars of **4 beats**. A beat is a quarter note. Positions are in beats from the start of the
  pattern: bar 1 is beats 0 to just under 4, bar 2 is beats 4 to just under 8, and so on.
- A pattern of N bars loops over a section of the song. Every strum takes **whatever chord the song is playing at
  that beat**, so you never write chord names: you write rhythm and stroke only.
- Allowed positions: sixteenth notes (multiples of 0.25) or eighth-note triplets (multiples of 1/3; write
  0.333333, 0.666667, 1.333333 and so on, with six decimals). A 12/8, 6/8 or shuffle feel is written with triplet
  positions inside the 4-beat bars.
- **Strum strokes** (field `strums`, each `[beat, stroke, length in beats]`):
  - `down`: a short downward strum (a chop or normal strum); length usually 0.25 to 1.
  - `up`: a short upward strum, lighter; typically on off-beats (the "and" or the "e"/"a").
  - `longDown`: a downward strum left to ring; length is how long it rings (for example 2 or 4 beats).
  - `longUp`: an upward strum left to ring.
  - Leave space: a gap between strums is a muted or resting hand. Silence is part of the groove.
- **Picks** (optional field `picks`, each `[beat, strings, length in beats, velocity 1-127]`): single notes of the
  chord's guitar shape, strings counted from the lowest note of the chord shape (0 = the bass note, up to 5). Use
  them sparingly, for a bass note before a strum (country "boom-chick"), or a little melodic answer at the end of a
  phrase. Several strings in one pick sound as a small arpeggiated strum.
- **Guitar noises** (optional field `fx`, each `[beat, name]`, name one of `fx1`, `fx2`, `fx4`, `fx6`): recorded
  string noises and slides that make a part sound played by hand (fret squeaks, muted scratches, slides). Use at
  most one or two per bar, usually just before a strong beat or at the end of a phrase.

## What to deliver

A JSON file (path given in your task) holding a list of **proposals**. Each proposal is one groove idea, a "style",
with several patterns: at least one quiet pattern for verses (`"energy": "low"`) and at least one busy one for
choruses (`"energy": "high"`); optionally a third pattern with no `energy` (any section). The busy pattern must have
**more strums per bar** than every quiet pattern of the same style. Write patterns as **4-bar phrases** (`"bars": 4`):
bars 1 to 3 state the groove, bar 4 varies it (a fill, a pushed strum that anticipates the next bar on beat 3.75 or
3.5 left ringing into it, a stop, or a long ringing chord). 2-bar patterns are fine for very simple grooves.

```json
[
  {
    "id": "gs-urban-neo-soul-chops",
    "family": "guitar",
    "kind": "guitarStrums",
    "name": "Neo-soul offbeat chops",
    "genres": ["urban"],
    "rationale": "Plain-English explanation for the reviewer: what the groove is, where the accents fall, how the quiet and busy versions differ, and what bar 4 does.",
    "patterns": [
      { "bars": 4, "energy": "low", "strums": [[1.5, "down", 0.25], [3.5, "down", 0.25], [5.5, "down", 0.25], [7.5, "down", 0.25], [9.5, "down", 0.25], [11.5, "down", 0.25], [13.5, "down", 0.25], [15, "longDown", 1]], "fx": [[14.75, "fx2"]] },
      { "bars": 4, "energy": "high", "strums": [[0.5, "down", 0.25], [1.5, "down", 0.25], [1.75, "up", 0.25], [2.5, "down", 0.25], [3.5, "down", 0.25]], "picks": [[0, [0], 0.5, 90]] }
    ]
  }
]
```

(The example is shortened: real busy patterns fill all 4 bars.)

Rules:
- `id`: lowercase words joined by hyphens, starting with `gs-<genre>-`, unique.
- `name`: short and descriptive. `rationale`: two to four plain sentences for a reviewer who is a musician.
- `genres`: the genre you are writing for (you may add a second genre only where the groove truly fits both).
- **Original writing only.** Never transcribe or imitate the guitar part of a specific existing song, and never name
  songs or artists. Write in the idiom of the genre.
- Every proposal must be clearly different from the others: different accent placement, density, use of long
  strums, picks or triplet feel. Do not pad the count with near-copies (moving one strum is not a new groove).
- Make them musical and playable by one guitarist with one hand strumming: no two strums on the same beat, no
  strums closer than a sixteenth (or a triplet eighth in triplet grooves), long strums must not be cut by the next
  strum sooner than they would naturally be damped (that is fine, just intended).

## Checking

From `/home/roli79/apps/casperaki/packages/arrangement` run:

```
npx tsx scripts/check-guitar-strums.ts <your file name>
```

It loads every proposal (the format must be valid), checks the grid, that no two patterns share a rhythm (also against
other genres' files, which other writers are filling at the same time), that no pattern copies the existing guitar
bank, and that busy patterns are busier than quiet ones. Fix everything it reports and run it again until it prints
"no problems". Only touch your own file.
