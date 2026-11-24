# Thin Sections Get a Partner Track — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After patterns are written and clashes resolved, sections whose harmony or rhythm is thin get a partner
track of the same kind as the thin part (Pad 2, Synths 2, …), then clashes and thinness are checked again.

**Architecture:** A pure measuring module (`arrangement-polish/thin-sections.ts`) says whether a section is thin and
which part to pair. A loop in the same module adds a lane to the selection (new sound, active in every section of the
thin section's type), writes up to four pattern options for it through `generatePatterns` with their own rng forks,
resolves clashes for each, keeps the best, and repeats until nothing is thin or two tracks were added. `orchestrate`
runs it on the song without track edits, then applies the edits on top of the enlarged selection.

**Tech Stack:** TypeScript, vitest, `@casperaki/music-theory` (`parseChord`, `chordNotes`, `parseBarBeat`), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-24-thin-sections-design.md`

## Global Constraints

- Deterministic: no draw from any existing rng stream; every new draw forks a new name (`thin/<lane>/sound`,
  `thin/<lane>#<k>`). Songs whose sections are never thin come out byte-identical to today.
- At most 2 added tracks per song (`THIN_RULES.maxAddedTracks = 2`).
- Tracks the user edited are laid in as written; the thin pass runs on the song without edits.
- Lane names recorded by `addTrack` edits are never taken by an added track.
- Measured parts: every lane except Drums, Bass, vocals (`/vocal/i`) and Loop.
- No fallbacks (owner's rule): an impossible state throws with a clear message; "no candidate" is a normal outcome
  (the section stays as it is), not an error.
- Thresholds live in one exported `THIN_RULES` object.
- After `src` changes run `pnpm -C packages/arrangement build` before downstream tests (dist is what they import).
- Arrangement suite takes 4-6 min: targeted specs while working, full run once before the final commit.

## Review Focus

- A song with recorded `addTrack` edits named `Pad 2` from before this change: the thin pass must not also create
  `Pad 2` (test in Task 3).
- A user "new pattern" on an added track must give a pattern different from the one the thin pass chose (fork names
  never coincide: `thin/<lane>#<k>#v<n>` vs `thin/<lane>#<k>`) (test in Task 2).
- A genre whose thin part's family has no unused sound: no track added, no throw (test in Task 3).
- Events without a numeric `duration` (strum, virtualGuitarist): treated as sounding until the lane's next onset, so
  guitar sections do not read as empty (test in Task 1).
- A song that is not thin anywhere: identical output to before (test in Task 3).

---

### Task 1: Measure thinness and pick the part to pair

**Files:**
- Create: `packages/arrangement/src/arrangement-polish/thin-sections.ts`
- Test: `packages/arrangement/test/thin-sections.spec.ts`

**Interfaces:**
- Produces:
  - `export const THIN_RULES = { minVoices: 3, gapBeats: 2, maxGapBarShare: 0.25, variants: 4, maxAddedTracks: 2 } as const`
  - `export interface SectionThinness { harmony: boolean; rhythm: boolean; medianVoices: number; gapBars: number }`
  - `export function measureSection(lanes: Readonly<Record<string, FamilyPattern>>): SectionThinness`
  - `export function partnerLane(lanes: Readonly<Record<string, FamilyPattern>>, kind: 'harmony' | 'rhythm'): string | undefined`
  - `export function fillScore(before: SectionThinness, after: SectionThinness): readonly [number, number, number]` —
    (thin kinds cleared, gap bars removed, median voices gained); compared lexicographically.

Definitions (the algorithm the tests pin):
- Voices on a beat (each quarter of each bar): over measured lanes, the set of pitch classes sounding at that beat's
  start, plus one per sounding `noteRelative` event (its pitch is resolved by the engine). `note` → `note % 12`;
  `chord`, `strum`, `virtualGuitarist`, `arpeggio`, `EDMArpeggiator` → the pitch classes of `chordNotes(parseChord(ev.chord))`.
  An event sounds from its onset for its numeric `duration`; without one, until the lane's next onset (or bar end).
- `harmony` thin: median voices over the section's beats `< minVoices`.
- Gap bar: a bar holding a stretch of `>= gapBeats` beats in which no measured lane starts an event (bar end counts as a
  boundary). `rhythm` thin: `gapBars / bars > maxGapBarShare`.
- `partnerLane('harmony')`: the `Pad`-family lane playing in the section with the most sounding beats; else the
  measured lane with the longest total sounding time. `partnerLane('rhythm')`: among measured lanes that are not
  sustained (reuse the clash pass's definition: mean duration ≥ 2 beats and < 3 onsets a bar), the one with the most
  gap bars of its own; undefined when every measured lane is sustained.

- [ ] **Step 1: Write the failing tests** (fixture helpers in the style of `test/clashes.spec.ts`)

```ts
it('a one-note pad under a one-note lead is harmony-thin', () => {
  const m = measureSection({ Pad: lane([0], 4, padNote(69)), Synths: lane(EIGHTHS, 4, note(72)) });
  expect(m.harmony).toBe(true);
  expect(m.medianVoices).toBe(2);
});
it('a pad playing chords is not harmony-thin', () => {
  expect(measureSection({ Pad: lane([0], 4, chord('Am')) }).harmony).toBe(false);
});
it('a two-bar lead whose second bar has two notes is rhythm-thin; the lead is the partner', () => {
  const synths = { bars: [bar(EIGHTHS), bar([0, 3.5]), bar(EIGHTHS), bar([0, 3.5])] };
  const lanes = { Pad: lane([0], 4, padNote(69)), Synths: synths };
  expect(measureSection(lanes)).toMatchObject({ rhythm: true, gapBars: 2 });
  expect(partnerLane(lanes, 'rhythm')).toBe('Synths');
  expect(partnerLane(lanes, 'harmony')).toBe('Pad');
});
it('strums without a duration ring to the next strum, so a strummed section is not thin', () => {
  const m = measureSection({ Guitar: lane(EIGHTHS, 4, (_b) => ({ type: 'strum', chord: 'C', durations: [1], offset: [0], strings: [3], velocities: [70] })) });
  expect(m).toMatchObject({ harmony: false, rhythm: false });
});
it('drums, bass, vocals and the loop are not measured', () => {
  expect(measureSection({ Drums: lane(SIXTEENTHS), Bass: lane(SIXTEENTHS), Vocal: lane(SIXTEENTHS) })).toMatchObject({ harmony: true, rhythm: true });
});
it('only sustained parts: no rhythm partner', () => {
  expect(partnerLane({ Pad: lane([0], 4, chord('C')) }, 'rhythm')).toBeUndefined();
});
it('fillScore ranks clearing a thin kind above anything else', () => {
  const thin = { harmony: true, rhythm: true, medianVoices: 2, gapBars: 2 };
  expect(fillScore(thin, { ...thin, harmony: false, medianVoices: 4 })).toEqual([1, 0, 2]);
});
it('the thresholds live in one place', () => {
  expect(THIN_RULES).toMatchObject({ minVoices: 3, gapBeats: 2, maxGapBarShare: 0.25, variants: 4, maxAddedTracks: 2 });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C packages/arrangement exec vitest run test/thin-sections.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the four exports in `thin-sections.ts`** with a header comment in the style of
  `clashes.ts` (what is measured, why, the thresholds). Export the clash pass's `describe`-based sustained test by
  moving a small `isSustained(pattern: FamilyPattern): boolean` into `clashes.ts` as an export and using it in both.

- [ ] **Step 4: Run** `pnpm -C packages/arrangement exec vitest run test/thin-sections.spec.ts test/clashes.spec.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(arrangement): measure thin sections (harmony voices, gap bars) and pick the part to pair`

---

### Task 2: Named pattern forks per lane

**Files:**
- Modify: `packages/arrangement/src/patterns/index.ts` (`generatePatterns`, `laneFork`)
- Test: `packages/arrangement/test/patterns.spec.ts`

**Interfaces:**
- Produces: `generatePatterns(ctx, structure, selection, laneVariants = new Map(), laneForks: ReadonlyMap<string, string> = new Map())`.
  A lane's base fork is `laneForks.get(lane) ?? 'lane/<lane>'`; a variant n > 0 forks `<base>#v<n>`.

- [ ] **Step 1: Failing tests:** (a) with `laneForks` empty, output equals today's for a fixture song
  (existing goldens cover this — assert one lane deep-equal to a call without the argument); (b) `laneForks.set('Synths', 'thin/Synths#2')`
  changes only `Synths`; (c) the same lane with `laneVariants` 1 differs from both the base and from `thin/Synths#1`
  — i.e. a user "new pattern" on an added track never reproduces a variant the thin pass tried.
- [ ] **Step 2: Run** `pnpm -C packages/arrangement exec vitest run test/patterns.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the extra parameter in `generatePatterns`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(arrangement): a lane's pattern stream can be named (laneForks), variants fork from it`

---

### Task 3: The partner loop and orchestrate wiring

**Files:**
- Modify: `packages/arrangement/src/arrangement-polish/thin-sections.ts`
- Modify: `packages/arrangement/src/orchestrate/index.ts:150-185`
- Modify: `packages/arrangement/src/edits/recorded.ts` (`applyTrackEditsToSelection` takes the enlarged selection unchanged; no API change expected — verify)
- Test: `packages/arrangement/test/thin-sections.spec.ts`, `packages/arrangement/test/orchestrate.spec.ts`, `packages/arrangement/test/track-edits.spec.ts`

**Interfaces:**
- Consumes: Task 1 exports; Task 2 `generatePatterns(..., laneForks)`; `familySoundPool(family, genre)` and
  `LANE_BASE_NAMES` (selection); `segmentType` (`arrangement-polish/segment-type.js`); `resolveArrangementClashes`.
- Produces:
  ```ts
  export interface AddedPartner { lane: string; family: InstrumentFamily; soundId: string; sectionType: string; kind: 'harmony' | 'rhythm'; fork: string }
  export function addThinPartners(input: {
    ctx: GeneratorContext;
    selection: SelectionResult;
    /** Writes and clash-resolves the whole song for a selection and lane forks. */
    write: (selection: SelectionResult, laneForks: ReadonlyMap<string, string>) => PatternResult;
    reservedNames: ReadonlySet<string>;
  }): { selection: SelectionResult; laneForks: Map<string, string>; patterns: PatternResult; added: AddedPartner[] };
  ```

Loop (the part the signature does not determine):
1. `patterns = write(selection, forks)`. Walk sections in song order; first section with `harmony` or `rhythm` thin
   whose (section type, kind) was not tried yet. Harmony first when both. None → stop.
2. `partner = partnerLane(lanes, kind)`; its family from the selection. No partner, or `familySoundPool(family, genre)`
   minus every `entry.id` in the selection is empty → mark tried, continue.
3. Lane name: `LANE_BASE_NAMES[family]` + first free ` n` not in selection lanes ∪ `reservedNames`. Sound:
   `ctx.rng.fork('thin/<lane>/sound').pick(unused)`. Lane `{ essential: false, perSegment: true, pickSource: 'genre' }`,
   added to `activeLanes` of every section whose `segmentType` equals the thin section's.
4. For k in 1..`THIN_RULES.variants`: forks + `<lane> → thin/<lane>#<k>`, `write`, `fillScore(before, measureSection(after))`
   on the thin section. Keep the best (first on ties). If its score is `[0, 0, 0]` or below, drop the lane, mark tried.
5. Stop after `maxAddedTracks` added.

Orchestrate order becomes: base selection → `addThinPartners` with `write = (sel, forks) => resolveArrangementClashes(written(sel, new Map(), forks))` and
`reservedNames` = tracks of recorded `addTrack` edits → `applyTrackEditsToSelection(enlarged, …)` → no edits: the
partner result's patterns; with edits: `withEditedTracks(partnerPatterns, written(edited, variants, forks), editedTracks)`.

- [ ] **Step 1: Failing tests**
  - `orchestrate({ seed: 'seed-19ptbn', genre: 'brightPop', key: 'C', bpm: 120 })` (Sunlit Sidewalk): verse sections
    gain a `Pad 2` and/or `Synths 2` in `instruments` and `overrides`; no chorus has any added lane switched on.
  - Same seed twice → `toEqual`.
  - A song not thin anywhere is unchanged: unit test `addThinPartners` with a `write` returning full fixture
    sections → `added` empty and `patterns` equal to `write(selection, new Map())`.
  - `reservedNames` containing `Pad 2` → added pad lane is `Pad 3`.
  - Unit: a selection whose partner family has every pool sound already used → `added` empty, no throw.
  - track-edits: an `addTrack` edit on a song with an added `Synths 2` records `Synths 3`; `changeSound` on `Synths 2` works and
    leaves other tracks equal.
- [ ] **Step 2: Run** `pnpm -C packages/arrangement exec vitest run test/thin-sections.spec.ts test/orchestrate.spec.ts test/track-edits.spec.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `addThinPartners` and the orchestrate wiring.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `pnpm -C packages/arrangement test:goldens:update`,
  inspect the golden diff (only thin songs change), and run the full arrangement suite once: `pnpm -C packages/arrangement test`.
- [ ] **Step 5: Commit** `feat(arrangement): thin sections get a partner track of the same kind, then clashes and thinness are checked again`

---

### Task 4: Measure on 200 songs, tune, ship

**Files:**
- Create: `packages/arrangement/scripts/measure-thin-sections.mjs` (imports built `dist/`; seeds `measure-0..199`,
  genres round-robin over the supported genres; key C, bpm 120)

- [ ] **Step 1:** Script prints, before (pass disabled via `THIN_RULES`-independent path: measure the clash-resolved
  patterns before `addThinPartners`) and after: share of sections harmony-thin, rhythm-thin; songs with 0/1/2 added
  tracks; clash rates as the clash commit counted them (sections with two busy parts; same-register unison clashes).
- [ ] **Step 2:** `pnpm -C packages/arrangement build && node packages/arrangement/scripts/measure-thin-sections.mjs`.
  Pass: thin shares drop sharply, clash rates do not rise, and fewer than half the songs get 2 tracks (else raise the
  bar: tune `THIN_RULES`, re-run Task 1/3 specs).
- [ ] **Step 3:** Commit with the numbers in the message: `feat(arrangement): measure thin sections on 200 songs (…before → after…)`.
- [ ] **Step 4:** Push, deploy with `deploy/datigator/deploy.sh` (never a local `vite build`), generate Sunlit Sidewalk's
  seed in the app or via the brain, and report to the owner which tracks were added where.
