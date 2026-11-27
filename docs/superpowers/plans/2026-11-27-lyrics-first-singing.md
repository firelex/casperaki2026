# Lyrics first: words shape the rhythm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write lyrics first (chart-pop brief, a random artist style and situation), bend a randomly drawn rhythm
pattern to them, and lay a separately drawn melody's pitches and chords over that rhythm; New rhythm and Change melody
redraw each side alone.

**Architecture:** The arrangement already lays one precedent's pitches and chords over another precedent's rhythm
(`drapeAndPlace` in `packages/arrangement/src/vocals/precedents.ts`). A new pure step, the recut, turns a rhythm
precedent plus the written lines into a new rhythm whose notes pass the existing line check (`checkLyricLine`) and a
new length rule; that rhythm is stored in generator params and the melody is draped on it in `writeVocals`. Because
the recut notes pass `checkLyricLine`, the existing `attachWrittenLyrics` sings the words on them unchanged. The brain
gets a lyrics-first lyricist; the web gets a New rhythm menu item.

**Tech Stack:** TypeScript, vitest, zod; packages/arrangement, apps/brain, apps/web (pnpm workspace).

**Spec:** `docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md`

## Global Constraints

- No fallbacks: fail loud with an error naming what is wrong; no silent defaults, no catch-and-continue.
- Every prompt for the language model is plain English, understandable without this codebase.
- No real song lyrics are downloaded, stored or shown to the model; the artist is a style cue only.
- Songs whose generator params lack the new keys generate exactly as before (the arrangement goldens do not change).
- New randomness draws only from new named streams (`vocals/rhythm/<type>#v<n>`), so no other section moves.
- Length thresholds: short < 300 ms, short-to-medium < 500 ms, any length otherwise (tunable constants).
- Lyrics-first line rules: lines of 4 to 11 syllables, one line per 2 bars (`LINE_BARS`), ABCB rhyme
  (`rhymeScheme`), near rhymes as `wordsRhyme` allows.
- Rhyme-word repeats (owner's rule): a line-ending word may end two different lines only when it is a word of the
  song's title or the two lines are identical.
- Opening-line check against the first lines of the owner's 50 most recent songs.
- The recut always succeeds for any line the lyric checks accept; a recut that finds no way is a bug (an error naming
  the line).
- Ship the web only through `deploy/datigator/deploy.sh`, and only when the owner approves; no local `vite build`.
- Arrangement consumers read `dist/`: run `pnpm -C packages/arrangement build` after arrangement source changes,
  before brain tests.
- Targeted specs while working; the full arrangement suite (4–6 min) once before the final commit.

## Review Focus

1. Old songs (no `lyricRhythms`, no `rhythmVariants`, no `lyricsFirst`) generate byte-identical: Task 4 runs the
   arrangement goldens.
2. A section type with sections of different lengths (an 8-bar and a 16-bar chorus): the longer repeats the words
   and the rhythm (Task 5 test).
3. Tempo extremes (70 and 170 bpm): the length rule is in milliseconds, so at 170 bpm a quarter note is ~350 ms and
   most notes are "short"; the recut must still fit every line (Task 3 property test runs both tempos).
4. Pickups: `lyricLines` moves a short note at the end of a line into the next line; the recut's lines must come back
   as the same lines with the same syllable counts (Task 3 test with a line starting on a weak syllable).
5. The hummed chorus: recut with its pitches kept; Change melody still refuses it (Task 5 test).

---

### Task 1: The length rule

**Files:**
- Create: `packages/arrangement/src/vocals/syllable-length.ts`
- Modify: `packages/arrangement/src/vocals/index.ts` (export), `packages/arrangement/src/index.ts` if it re-exports
  vocals by name
- Test: `packages/arrangement/test/syllable-length.spec.ts`

**Interfaces:**
- Produces:
  - `type SyllableLength = 'short' | 'medium' | 'any'`
  - `syllableLength(phones: readonly string[], endsWord: boolean): SyllableLength`: phones are one sung syllable's
    ARPAbet (as `Pronunciation.phones[i]`, uppercase with stress digits).
  - `SHORT_MS = 300`, `MEDIUM_MS = 500`
  - `lengthFits(kind: SyllableLength, durationBeats: number, bpm: number): boolean`: short `< SHORT_MS`, medium
    `< MEDIUM_MS`, any always.
  - `lineLengthProblems(text: string, slots: LyricLine, bpm: number): string[]`: plain-English problems for a line
    sung one syllable per slot (empty when every syllable's note length fits).

Rule (spec, "The length rule"): not the word's last syllable → short. Last syllable whose vowel is a long vowel or
diphthong (IY EY AY OY OW UW AW AA AO ER) → any; a vowel followed (in that syllable) by L R M N NG → any; otherwise
(short vowel IH EH AE AH UH, closed by a stop or hiss, or open) → medium.

- [ ] **Step 1: Write the failing test**

```ts
import { pronounce, syllableLength, lengthFits } from '../src/vocals/index.js';
const sylls = (w: string) => pronounce(w)!.phones;
it('"You gotta feel it": you any, go short, tta short, feel any, it medium', () => {
  expect(syllableLength(sylls('you')[0]!, true)).toBe('any');
  expect(syllableLength(sylls('gotta')[0]!, false)).toBe('short');
  expect(syllableLength(sylls('gotta')[1]!, true)).toBe('medium');
  expect(syllableLength(sylls('feel')[0]!, true)).toBe('any');
  expect(syllableLength(sylls('it')[0]!, true)).toBe('medium');
});
it('long vowels and sonorant endings hold; stops on short vowels do not', () => {
  for (const w of ['night', 'home', 'mine', 'feel', 'sing']) expect(syllableLength(sylls(w).at(-1)!, true)).toBe('any');
  for (const w of ['get', 'up', 'back']) expect(syllableLength(sylls(w).at(-1)!, true)).toBe('medium');
});
it('thresholds are in milliseconds, whatever the tempo', () => {
  expect(lengthFits('short', 0.5, 120)).toBe(true);   // 250 ms
  expect(lengthFits('short', 1, 120)).toBe(false);    // 500 ms
  expect(lengthFits('medium', 1, 170)).toBe(true);    // 353 ms
  expect(lengthFits('medium', 1, 100)).toBe(false);   // 600 ms
  expect(lengthFits('any', 8, 60)).toBe(true);
});
```

Note: "gotta"'s second syllable `t ah0` ends the word on a short open vowel → medium, which the spec's example calls
short; medium (< 500 ms) is the rule as written and still forbids holding it. Ledger this if it surprises.

- [ ] **Step 2: Run — FAIL** `pnpm -C packages/arrangement exec vitest run test/syllable-length.spec.ts` (module not
  found).
- [ ] **Step 3: Implement** in `syllable-length.ts`. `lineLengthProblems` parses the line with the same parse
  `checkLyricLine` uses (export a small helper from written-lyrics.ts if needed, do not duplicate the dictionary) and
  requires `syllables === slots.length`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(vocals): the length rule — which syllables may be held`.

### Task 2: Rhythm pool, random draw, drape on a given rhythm

**Files:**
- Modify: `packages/arrangement/src/vocals/precedents.ts`
- Test: `packages/arrangement/test/precedent-rhythm-draw.spec.ts`

**Interfaces:**
- Produces:
  - `MergedPrecedent` gains `readonly rhythmic: Precedent` and `readonly melodic: Precedent` (the entries it was
    made from; for a whole hook both are the hook; `userChorusPrecedent` in `src/hum/user-chorus.ts` sets both to the
    hum as a `Precedent`).
  - `rhythmPool(inputs: Omit<MergeInputs, 'rng'>): readonly Precedent[]`: every rhythm the recipes draw rhythms from
    for that genre, section type and tempo (the rule's style rhythmic bank via `styleRhythms`, the remixable hooks via
    `remixableHooks`, the curated banks' entries via `tempoBank`), each shaped by `pickHelperPrecedent`'s length rule
    for `desiredPatternLength`. An error when empty.
  - `drawRhythm(inputs: MergeInputs): Precedent`: `inputs.rng.pick(rhythmPool(inputs))`, uniform.
  - `drapeOnRhythm(rhythm: Precedent, melodic: Precedent, maxNote: number): MergedPrecedent`: `drapeAndPlace(rhythm,
    melodic, maxNote, undefined)`; a failure throws naming both ids (no redraw).

- [ ] **Step 1: Failing tests**: `rhythmPool` for brightPop chorus at 120 bpm contains entries from the style bank and
  the hooks bank; `drawRhythm` over 2000 seeds reaches every pool entry (uniform, not fit-filtered);
  `drapeOnRhythm(r, m, maxNote)` keeps exactly `r`'s onsets (`Object.keys(merged.melody)` equal to the rhythm's
  beats that `getClosestNoteForBeat` resolves) and `m`'s chords; `selectMergedPrecedent(...)` results carry
  `rhythmic.id === rhythmicPrecedentId` and `melodic.id === melodicPrecedentId`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Adding the two fields must not change any draw.
- [ ] **Step 4: Run — PASS**, plus `test/precedent-flags-selection.spec.ts` and `test/vocals-hooks.spec.ts` unchanged.
- [ ] **Step 5: Commit** `feat(vocals): draw a rhythm on its own, drape a melody on a given rhythm`.

### Task 3: The recut

**Files:**
- Create: `packages/arrangement/src/vocals/recut.ts`
- Test: `packages/arrangement/test/vocals-recut.spec.ts`

**Interfaces:**
- Consumes: Task 1 `syllableLength`, `lengthFits`, `lineLengthProblems`; `checkLyricLine`, `lyricLines`,
  `pronounce` / `sungPronunciations`; `stress.ts` grades.
- Produces:
  - `interface RecutRhythm { readonly pattern: string; readonly bars: number; readonly notes: readonly { readonly start: number; readonly duration: number }[] }`
    (`pattern`: the source precedent's id as a string; `start`: beats from the section start; `bars`: its length).
  - `recutRhythm(rhythm: Precedent, lines: readonly string[], opts: { readonly bpm: number; readonly bars: number }): RecutRhythm`
  - `recutAsPrecedent(recut: RecutRhythm): Precedent`: a precedent (id `${pattern}~recut`, `start 0`, `end bars`) whose
    melody holds the recut notes (midi from the nearest source note; the drape replaces pitches), for
    `drapeOnRhythm`.
  - `RecutSchema` (zod) for storing.

Algorithm (the spec leaves moves and costs to the builder; this is the decision): the rhythm is laid over `bars`
(tiled as `expandMergedToSegment` tiles), cut into lines of `LINE_BARS` (2) bars, one per written line, in order.
Per line, a search over edits of that line's source notes: keep a note (cost 0), shorten or lengthen it into a
neighbouring gap (1), move its onset by a sixteenth or an eighth (2 per step; 3 on beats 1 and 3), merge two
neighbours (2), split a note in two (3), drop a note (3), add a note in a gap or as a pickup in the last beat before
the line (4). Notes stay on a sixteenth grid, never overlap, and stay inside the line's span (pickups may start up to
one beat before it). A candidate is accepted when, re-graded with `gradeBar` on the whole section, `lyricLines`
returns the line with exactly its syllables, `checkLyricLine` returns undefined, and `lineLengthProblems` is empty.
Take the cheapest accepted candidate (ties: earliest in a fixed move order, so it is deterministic). Search with a
best-first queue on cost; to guarantee success, the move set includes laying the line out afresh on the line's
sixteenth grid (stressed syllables on beats, others between) at a cost above any edit path. If the queue empties, throw
`recut: no rhythm for line N "<text>" on <pattern>` (a bug).

- [ ] **Step 1: Failing tests**:
  - `a line that already fits keeps the pattern's notes unchanged` (build the line from the pattern's own graded
    slots).
  - `"You gotta feel it" puts "go" and "tta" on short notes and may hold "feel"`, at 100 bpm.
  - `every syllable lands on a note it may be sung on`: for the result, `checkLyricLine(line, lyricLines(bars)[i])`
    is undefined and `lineLengthProblems` is empty for every line.
  - `property: every bank rhythm takes any accepted line` — every entry of every bank (`loadBankIndex().banks`),
    shaped to 8 bars, × 4 generated lines per entry (from a fixed list of 40 dictionary-valid pop lines of 4–11
    syllables, cycled), at 70 and 170 bpm: no throw, and the checks above pass. (Review Focus 3.)
  - `a line starting on a weak syllable keeps its pickup in its own line` ("And I know you", Review Focus 4).
  - `deterministic`: two calls give identical results.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `recut.ts`.
- [ ] **Step 4: Run — PASS.** Note the property test's time; keep it under 30 s (cap the bank sample if needed and
  ledger it).
- [ ] **Step 5: Commit** `feat(vocals): recut a rhythm pattern to written lines`.

### Task 4: The generator uses a stored recut

**Files:**
- Create: `packages/arrangement/src/vocals/lyric-rhythms.ts`
- Modify: `packages/arrangement/src/vocals/index.ts` (`writeVocals`)
- Test: `packages/arrangement/test/vocals-lyric-rhythms.spec.ts`

**Interfaces:**
- Produces:
  - `LYRIC_RHYTHMS_PARAM = 'lyricRhythms'`, `LyricRhythmsSchema = z.record(sectionType, RecutSchema)`,
    `lyricRhythmsOf(params): LyricRhythms` (as `melodyVariantsOf`: absent → `{}`, malformed → error).
  - `RHYTHM_VARIANTS_PARAM = 'rhythmVariants'`, `rhythmVariantsOf(params)` (type → positive int), same shape as
    melody variants.
- Behaviour in `writeVocals`: for a section type with a stored recut, after the usual selection (draws unchanged),
  `merged = drapeOnRhythm(recutAsPrecedent(recut), merged.melodic, merged.properties.maxNote)`; the section takes that
  merged's chords as today; everything after is unchanged (written lyrics attach as today).

- [ ] **Step 1: Failing tests**: a stored recut for `chorus` makes the chorus lead notes' starts and durations equal
  to the recut's (tiled over a 16-bar chorus: bars 8–15 repeat 0–7, Review Focus 2) and its pitches and chords those
  of the melody the song had; verses unchanged; a malformed `lyricRhythms` throws naming the param.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS**, then the goldens: `pnpm -C packages/arrangement exec vitest run test/goldens` (or the
  repo's golden spec names): unchanged (Review Focus 1).
- [ ] **Step 5: Commit** `feat(vocals): sing on a stored recut rhythm`.

### Task 5: Edits: apply lyrics first, New rhythm, Change melody keeps the rhythm

**Files:**
- Modify: `packages/arrangement/src/edits/vocal-edits.ts`
- Test: `packages/arrangement/test/track-edits.spec.ts` (new `describe('lyrics first')`)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `type LyricsByType = Readonly<Record<string, readonly string[]>>` (section type → lines for its shortest section).
  - `applyLyricsFirst(working: Song, lyrics: LyricsByType): Song`: per type, the current rhythm (the stored recut's
    source pattern, if any, else the current `merged.rhythmic`; for a hummed chorus the hum) recut to the lines; the
    recut stored in `lyricRhythms`, the lines stored in `lyrics` per section name (a longer section repeats them to
    its line count), the type's sung melody dropped (`paramsWithoutSung`), the vocal tracks spliced as
    `applyWrittenLyrics` does (showing the melody first when hidden).
  - `newRhythm(working: Song, type: string): Song`: `rhythmVariants[type] + 1`, `drawRhythm` with
    `ctx.rng.fork(\`vocals/rhythm/${type}#v${n}\`)`-equivalent stream (build it from the song's seed as `newMelody`
    builds melody variants), recut to the type's stored lines, stored; sung melody dropped. Errors:
    `TrackEditError(409, 'no_lyrics', 'Write lyrics first: a new rhythm is bent to the words.')` when the type has no
    lyrics-first words.
  - `newMelody` for a type with a stored recut: keeps its words and recut (only the melody variant changes); the
    hummed chorus still refused.
- [ ] **Step 1: Failing tests**: applyLyricsFirst on a generated brightPop song with chorus and verse lines → every
  lead note sings a syllable, `checkSectionLyrics` passes on the result, pitches and chords of the sections equal the
  song's before; a 16-bar chorus repeats the 8-bar chorus's words (Review Focus 2); a hummed chorus keeps its pitch
  sequence and gets the words (Review Focus 5); newRhythm changes the chorus onsets, keeps words and chords;
  newMelody on a lyrics-first chorus keeps onsets and words, changes pitches; newRhythm without words → 409
  `no_lyrics`; a sung take of the type is dropped by applyLyricsFirst and newRhythm.
- [ ] **Step 2: Run — FAIL.**  **Step 3: Implement.**  **Step 4: Run — PASS** (`test/track-edits.spec.ts`).
- [ ] **Step 5: Build and commit**: `pnpm -C packages/arrangement build`; commit
  `feat(edits): lyrics first, New rhythm, Change melody keeps the rhythm`.

### Task 6: Free-lyric checks (arrangement, pure)

**Files:**
- Create: `packages/arrangement/src/vocals/free-lyrics.ts`
- Test: `packages/arrangement/test/free-lyrics.spec.ts`

**Interfaces:**
- Produces:
  - `MIN_LINE_SYLLABLES = 4`, `MAX_LINE_SYLLABLES = 11`
  - `interface FreeLyricsProblem { readonly type: string; readonly line: number; readonly message: string }`
    (`line` 0-based, −1 for the whole part)
  - `checkFreeLyrics(parts: LyricsByType, lineCounts: Readonly<Record<string, number>>, title: string, recentOpenings: readonly string[]): FreeLyricsProblem[]`:
    line count per type; dictionary words; syllable count (counting a word's shortest sung form,
    `sungPronunciations`); ABCB rhymes (`rhymeScheme`, `wordsRhyme`) where the same word is accepted only when it is a
    title word or the lines are identical; across the song a line-ending word ends two different lines only when it
    is a title word or the lines are identical; the first line of the first part (the song's opening) rejected when
    its first three words equal those of any recent opening, or when 60% or more of its words appear in one.
    Messages are plain English for the model (as `checkSectionLyrics` messages are).
- [ ] **Step 1: Failing tests**: "Met you at the gas station" vs recent "Met you at the corner store" → opening
  problem; "Cinnamon Boulevard, that's where we are" ×2 identical lines → accepted; two different lines both ending
  "night" in a song not titled with "night" → problem; same with title "Tonight Tonight"… use title "Night Moves" →
  accepted; a 3-syllable line → problem naming 4–11; an unknown word → problem.
- [ ] **Step 2–4:** FAIL, implement, PASS.  **Step 5:** build, commit `feat(vocals): checks for lyrics written first`.

### Task 7: The lyrics-first lyricist and its inspiration (brain)

**Files:**
- Create: `apps/brain/src/lyrics/lyricsFirst.ts`, `apps/brain/src/lyrics/inspiration.ts`,
  `apps/brain/src/lyrics/situations.json`, `apps/brain/scripts/write-situations.ts`
- Test: `apps/brain/test/lyricsFirst.spec.ts` (fake model as in `test/fakeLyricModel.ts`)

**Interfaces:**
- Consumes: Task 6 `checkFreeLyrics`, `MIN/MAX_LINE_SYLLABLES`; `ChatModel`.
- Produces:
  - `ARTISTS: readonly string[]` (Katy Perry, Kesha, Olivia Rodrigo, Ed Sheeran, Dua Lipa, Taylor Swift, Sabrina
    Carpenter, Harry Styles, Charli XCX, Ariana Grande, Lizzo, The Weeknd), `situations(): readonly string[]` (the
    JSON file, zod-checked, at least 150 entries), `drawInspiration(random: () => number): { artist: string; situation: string }`.
  - `interface LyricsFirstRequest { readonly types: readonly { type: string; label: string; lines: number }[]; readonly title: string; readonly genre: string; readonly recentOpenings: readonly string[]; readonly inspiration: { artist: string; situation: string } }`
  - `writeLyricsFirst(model: ChatModel, request: LyricsFirstRequest): Promise<LyricsByType>`: one call, no reasoning,
    the round-2 pop brief of `apps/brain/scripts/try-lyrics-first.ts` (copy its wording; the line counts and syllable
    range from the request and Task 6), the artist sentence and the situation sentence, answer JSON
    `{"sections":[{"name": "<label>", "lines": [...]}]}`; `checkFreeLyrics`; problems go back in a repair message
    (the problems' messages, the last answer, "keep every other line") up to `MAX_ROUNDS` (8), all without reasoning;
    still failing → an error listing the lines and problems.
- `write-situations.ts`: asks the model (plain-English prompt) for 220 distinct one-line pop-song premises in the
  style of the list in the spike script, dedupes, writes `situations.json`. Run it once, read the file, commit it.
- [ ] **Step 1: Failing tests** with a fake model: the prompt contains the title, the artist, the situation and each
  part's line count; a first answer with a bad rhyme gets one repair whose message names the line; an answer still
  failing after 8 rounds throws naming the line; `drawInspiration` with a fixed random gives a fixed pair.
- [ ] **Step 2–4:** FAIL, implement, PASS (`pnpm -C apps/brain exec vitest run test/lyricsFirst.spec.ts`).
- [ ] **Step 5:** run the script with the brain env (`set -a; . ~/.config/casperaki/brain.env; set +a`), check
  `situations.json` has ≥ 150 distinct entries, commit `feat(lyrics): the lyrics-first lyricist, artist and situation`.

### Task 8: Write lyrics runs lyrics first; titles in pop style

**Files:**
- Modify: `apps/brain/src/tasks/tasks.ts` (the writeLyrics task: around lines 495–505 and 618),
  `apps/brain/src/titles/songTitler.ts` (`songPrompt`)
- Test: `apps/brain/test/tasks.spec.ts`, `apps/brain/test/titles.spec.ts`

**Interfaces:**
- Consumes: Task 7 `writeLyricsFirst`, `drawInspiration`; Task 5 `applyLyricsFirst`, `LyricsByType`.
- Behaviour: the writeLyrics task builds `types` from `sungSections(generated)` (per type: its label as
  `TYPE_LABELS`, lines = shortest section's bars / 2), `recentOpenings` from the owner's 50 most recently updated
  songs' stored `lyrics` param (first line of their first sung section, skipping songs without), the title (the real
  one; a placeholder title is still passed, as the hook must be built on something); the task result is the
  `LyricsByType`; applying it calls `applyLyricsFirst`. The task result schema changes from `WrittenLyricsSchema` to a
  `LyricsByTypeSchema`; an old stored task result (section-name keys) still applies through `applyWrittenLyrics`
  (tell them apart by the keys: section types vs section names; an unknown shape is an error).
- Titler: the prompt asks for a short chart-pop title, a phrase someone would say or sing ("Bad Idea", "Kiss Me
  Back", "Not Your Girl"), not a poetic image ("Cinnamon Boulevard"); existing titles untouched.
- [ ] **Step 1: Failing tests**: tasks.spec — a writeLyrics task on a stored song yields a lyrics-first song (every
  lead note has a syllable, `lyricRhythms` recorded), and the prompt the fake model saw contains a recent opening
  check's input (a stored song's first line in `recentOpenings` reaches `checkFreeLyrics`: give the fake model that
  opening first and see a repair); titles.spec — the prompt contains "chart-pop" wording and the examples.
- [ ] **Step 2–4:** FAIL, implement, PASS.  **Step 5:** commit `feat(lyrics): Write lyrics writes the words first; pop titles`.

### Task 9: New rhythm in the brain route and the Vocal menu

**Files:**
- Modify: `apps/brain/src/routes/tracks.ts` (op union near line 59, handler near 115), `apps/web/src/api/tracks.ts`,
  `apps/web/src/editor/TimelineView.tsx` (near `newMelody`, line 531, and the menu near 1290)
- Test: `apps/brain/test/` route spec for tracks (the one covering `newMelody`), `apps/web` spec covering the menu
  if one exists for Change melody

**Interfaces:**
- Consumes: Task 5 `newRhythm`.
- Produces: op `{ kind: 'newRhythm', section: string }` (refused while singing, as `newMelody`); web
  `newRhythm(section)` running it with the message `Bending a new rhythm to the words of all <plural>`; the menu item
  "New rhythm" under Change melody, shown only for a section type with lyrics-first words (the song's
  `lyricRhythms` has the type).
- [ ] **Step 1: Failing tests**: route — `newRhythm` on a lyrics-first song returns a song whose chorus onsets
  differ and words are kept; on a song without words → 409 `no_lyrics`; web — the item shows only for lyrics-first
  types.
- [ ] **Step 2–4:** FAIL, implement, PASS.  **Step 5:** commit `feat(vocals): New rhythm in the Vocal menu`.

### Task 10: Whole-suite run and a live-model check

- [ ] **Step 1:** `pnpm -C packages/arrangement test`, `pnpm -C apps/brain test`, `pnpm -C apps/web test`; record
  results in the ledger, naming the failures known before this work (brain lyricist, melodyLibrary, sounds,
  mix.spec; web mix-export) and any new one (a new one is not acceptable).
- [ ] **Step 2:** a script run (throwaway, not committed) writing lyrics first for the 6 spike songs with the live
  model and applying them in memory: every song fits, seconds per song printed, the lyrics and the chorus rhythm
  (onsets) written to `~/Downloads/lyrics-first-v3/` for the owner to read. Delete
  `apps/brain/scripts/try-lyrics-first.ts` (the spike).
- [ ] **Step 3:** commit; deployment only after the owner approves.
