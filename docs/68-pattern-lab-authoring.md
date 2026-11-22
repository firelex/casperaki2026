# 68 — Writing pattern lab proposals

The pattern lab (`/patterns`, admins; see docs/66) lets the owner hear Casperaki-written patterns in a full
song, next to the same song with today's library, and approve or reject them. This page is the authoring
guide: the formats, how the engine plays them, and the musical rules that keep a pattern good over every
chord the song generator writes.

Proposals are JSON arrays in `packages/arrangement/data/patterns/proposals/*.json`, validated by
`src/patterns/proposals.ts` (`loadPatternProposals`). Every proposal has:

- `id`: kebab-case, unique across all files (the review decision is keyed on it).
- `name`: short and plain.
- `family`, `kind`: see below.
- `genres`: one or more of `ballad`, `brightPop`, `edm`, `latin`, `organicVibes`, `rock`, `schlager`, `urban`.
- `rationale`: 2-4 plain sentences for the reviewer: what it is, why it suits the genre(s), where it
  comes from (and the licence line if it comes from a dataset).

Genre tempos (BPM): ballad 65-80, brightPop 95-129, edm 115-150, latin 90-104, organicVibes 75-109
(acoustic, singer-songwriter, soul-pop), rock 100-129, schlager 120-129 (German pop, Discofox), urban
60-100 (hip hop, R&B).

## Kinds

| family | kind | pattern |
|---|---|---|
| drums | `blueprints` | `{ lane: [beat, …] }` over 2 bars (beats 0 to <8); lanes in `data/patterns/drums/bank-index.json`; no velocity |
| drums | `algo` | name of a generator in `src/patterns/drums-authored.ts` |
| bass | `bassPatterns` | `[[beat, length, semitones from the chord root], …]` over 2 bars |
| keys, pad, popStrings, popBrass, synths, pluckedSynths | `chordTones` | `{ bars, energy?, notes: [[beat, semitones from middle C, length], …] }` |
| guitar | `guitarPicks` | `{ bars, energy?, hits: [[beat, [strings], length, velocity], …] }` |

Beats count from 0 across the whole pattern (bar 2 starts at 4). Patterns loop over the section.

### Chord-tone patterns (`chordTones`)

Each note is written as a fixed pitch (semitones from middle C; 0 = C4, 4 = E4, -12 = C3). For every
note the engine plays **the nearest tone of the chord sounding at the note's start**, a tie going
**down** (`Chord::findNotes` center search: 0, -1, +1, -2, +2 …). Over Am, F, G7, Dm7 … every note
slides to the nearest chord tone, so a voicing keeps its shape and moves as little as possible:
automatic voice leading. The chord's quality (minor, 7th, sus, 9th) decides the actual notes, so nothing
clashes with the harmony.

**Do not write voicings as C major chord tones.** C-E-G (0, 4, 7) collapses over F to C-F-F (E goes up
to F; G ties between F and A and goes down). Space simultaneous notes about a major third apart, on the
grid … -8, -4, 0, 4, 8, 12, 16 … (C, E, G♯, C …; 9 = A works in place of 8). That grid gives every
common triad all three of its tones: 0, 4, 8 → C: C E G, F: C F A, G: B D G, Am: C E A, Dm: D F A,
Em: B E G. The checker's `--verbose` output shows the notes on F and G bars; look there first.

Consequences:

- **Only chord tones sound.** A D or an A written over C becomes C/E or G. Passing tones, scale runs and
  non-chord colour notes are impossible; write melody-like lines as chord-tone arpeggios.
- **Keep simultaneous notes at least a third apart** (3+ semitones, ideally a 4th or more in the low
  register). Two notes a second apart can snap onto the same chord tone and a voice disappears
  ("collapsed"). Example: E4 and G4 over F major become F4 and F4 (G ties between F and A and goes down).
- **Low register:** below E3 (-8) keep notes a 5th or more apart (or use a single note / octave).
- **A note keeps the chord it started on.** About 7-8% of bars change chord mid-bar (on beat 3). A
  whole-bar sustain then clashes for half a bar; prefer re-striking on beat 3 (beat 2 in 0-based) in
  long-note patterns, or accept it for pads. An anticipation (a note on the "and" of 4 tied over the
  bar line) plays the **old** chord: avoid long anticipations.
- **Velocity is not carried** (the engine adapter drops it for these events): accents must come from
  rhythm, register and note count.
- **Register** (the instrument's own octave correction is added on top, calibrated on legacy patterns,
  so stay where the legacy patterns are): keys -19 to +14 (left hand around -24 to -8, right hand -5 to
  +14), strings -17 to +16, synths and plucked synths around -8 to +19 (centre +4), brass -3 to +21
  (centre +11), pads around -5 to +12.
- **energy:** `"low"` patterns play in intros, verses, breaks and outros; `"high"` in choruses; no
  energy = any section (pre-choruses and bridges take any pattern). A proposal must have at least one
  pattern that is not `"high"` and one that is not `"low"`. Use this for a sparse verse part and a
  fuller chorus part of the same idea.

### Guitar picks (`guitarPicks`)

Each hit names strings of the chord's guitar shape (engine `GuitarChord`, lowest position of
`ChordData.json`), counted from its lowest note: 0 = the bass note (usually the root, sometimes the
5th), 1, 2 … upward. Shapes have 4-6 notes (a few have 3); indices 0-3 always exist, 4 and 5 wrap round
on small shapes (the checker flags it). One string = a picked note; several = a strum played in the
listed order, 0.02 beats apart (`[0,1,2,3,4,5]` down, `[5,4,3,2,1,0]` up). Velocity 1-127 is used
(legacy picking sits around 45-90). The same chord-at-start rule applies.

## Checking a proposal

```sh
pnpm -C packages/arrangement build
node packages/arrangement/scripts/proposal-report.mjs [id …] [--verbose]
```

The report plays every chord-tone and guitar pattern over progressions from real generated songs and
flags collapsed voices, muddy low intervals, notes out of range and wrapping guitar strings;
`--verbose` prints the resolved notes over the first progression. `loadPatternProposals()` (any test
or the brain) validates the files: schema, energy coverage, and that the family can play in each listed
genre (`familySoundPool`). Strings play only in ballad, edm, organicVibes, schlager, urban; brass only
in latin, organicVibes, schlager.

## Where approved patterns go

`apps/brain/scripts/export-approved-patterns.ts` writes approved proposals into the library: drums into
`data/patterns/drums/` styles, bass into `data/patterns/bass/` `authored`, everything else into
`data/patterns/authored/index.json` + `styles/<id>.json`. A lane with n approved styles for its family
and genre plays one of them n times in n + 1 (one style per song lane, one pattern per section type);
with none, songs are unchanged.
