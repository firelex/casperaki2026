# 62 — casperaki1 brain-parity audit (consolidated discrepancy table)

Date: 2026-06-16. Full cross-codebase comparison of the rebuild brain
(`packages/arrangement/src` + `packages/music-theory/src`) against the
**casperaki1** reference app (`/home/roli79/apps/casperaki1/api/v1.0/services`).

## How to read this

The rebuild was ported from **`casperaki2-engine-js`**, which the team treats as
canonical legacy — NOT casperaki1 (an older, diverging revision; e.g. the
`fxEdmFills`→`percussionBreaks` rename). Every discrepancy below is therefore
tagged by **"Regression against"**:

- **`both`** — the rebuild diverges from *both* casperaki1 AND casperaki2 (a true
  bug/gap; fix regardless of which legacy is canonical).
- **`c1 only`** — the rebuild matches casperaki2 but NOT casperaki1. This is an
  intentional *decision* under the "casperaki2 is canonical" policy; listed only
  because this audit was requested against casperaki1.
- **`absent`** — a whole casperaki1 subsystem with no rebuild equivalent (may be
  intentionally deferred to the AI path or out of brain scope).

Verification confirmed casperaki1 is **not richer** than casperaki2 for brass
(both ship the same 10-pattern bank) or strings (casperaki2's 231 patterns >>
casperaki1's 10 stabs) — so porting from casperaki2 was correct for data breadth.

Severity: **audible** = changes the rendered sound; **structural** = changes
song shape/section lengths; **completeness** = brain emits less data than legacy;
**cosmetic/scope** = minor or likely-out-of-scope.

The **Resolution** column is for you to fill in (port-to-c1 / keep-c2 / defer /
won't-fix / etc.).

---

## A. True shortfalls (regress vs both legacies, or whole gaps)

| ID  | Subsystem                        | Discrepancy (what the regression is)                                                                                                                                                                                                                                                                                                                                                                                                                                   | Regression against    | Severity         | Key files                                                                                                                                                                  | Resolution                                                                                                                 |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A1  | Drums — fill placement           | Genre-conditional fill placement (gated on `latin/organicVibes/rock`: intro end-fills, chorus `bigFill` end + `mediumFill\|bigFill` middle, break/bridge end-fills, by-next-segment dispatch) flattened to one rule per segment-type. latin/organicVibes/rock LOSE fill richness; edm/brightPop/schlager GAIN a verse/preChorus end-fill legacy never emits. Fill grids/composition themselves are faithful — only placement is wrong. Contradicts to-do "fills DONE". | both                  | audible          | rebuild `data/arrangement-polish/rules.json` (`fills`), `arrangement-polish/fills.ts:208-230` · legacy `arrangements/instruments/drums.js _getFill:78-200`                 | Fix                                                                                                                        |
| A2  | Bass — generator family          | casperaki1's only real bass generator is `LibraryBass` = **chord-relative** (chord root @ octave 2 + offset) for every genre. Rebuild routes latin/brightPop/organicVibes/rock through chord-INDEPENDENT absolute-MIDI banks and edm/schlager through edmSimple/edmComplex positional model (both from casperaki2). The faithful chord-relative SM banks ARE shipped but sit on a dead fallback path. Basslines no longer follow chords as in casperaki1.              | c1 only (high impact) | audible          | rebuild `patterns/bass.ts:57-77`, `bass-generators.ts:414-456`, `bass-bank.ts` · legacy `BassPatternGeneratorClass.js:62,93-106`, `LibraryBassPatternGeneratorClass.js:65` | More investigation needed - I doubt that casperaki1 had only bass generator.  It will have been genre specific.            |
| A3  | Pad — single-note octave         | Pad singleNoteHigh/Mid/Low render one octave too high: legacy = MIDI 60/48/36, rebuild = 72/60/48. Both legacies agree → genuine bug. Fix: store `rootMidiOctave: 4/3/2` not `5/4/3`. Chord-style pad + `chordType` voicing are correct.                                                                                                                                                                                                                               | both                  | audible          | rebuild `data/patterns/pad/bank-index.json`, `pad.ts:65` · legacy `ChordsAndNotesPadPatternGeneratorClass.js:59-73`, `notesDecMap.json`                                    | Fix                                                                                                                        |
| A4  | Guitar — genre→style map         | Legacy maps brightPop(popTight)→`[country,pop,rock]` and organicVibes(popLoose)→`[arpeggio,funk,jazz]`. Rebuild maps BOTH to `["pop"]` only (with a false "no legacy entry" comment). organicVibes loses arpeggio/funk/jazz fingerpicking; brightPop's pattern pool shrinks hard. Both legacies agree → genuine bug.                                                                                                                                                   | both                  | audible          | rebuild `data/patterns/guitar/bank-index.json:31,34` · legacy `config.json#defaultStyleMappings.guitarPatterns` (c1 `:534-543`)                                            | Fix                                                                                                                        |
| A5  | Orchestral — brass gate          | casperaki2 actively rosters+plays the (schlager) brass bank in latin and organicVibes; rebuild's `ORCHESTRAL_GENRE_SUPPORT.popBrass = {schlager}` drops every brass roster/add-one for those genres at add-time, even though `rollLatin`/`rollPopLoose` still push `BRASS` (now dead code). latin/organicVibes get no brass.                                                                                                                                           | both (vs c2 runtime)  | audible          | rebuild `selection/index.ts:112,401,449-461,565`, `data/patterns/brass/bank-index.json` · legacy `patterns.js:709-766,915`                                                 | Fix                                                                                                                        |
| A6  | Synths — leadSynthsAnalog        | Legacy force-maps `leadSynthsAnalog → keyboardMonophonicRhythmic` (and `synthsPlucked → EDMSynthsPlucked`), bypassing the genre random pick. Rebuild keys style on genre only and discards the per-lane lowLevel, so analog leads can render as arpeggiator/plucked/playful. Present vs casperaki2 too.                                                                                                                                                                | both                  | audible          | rebuild `patterns/synths.ts:127-162`, `selection/index.ts:234-238` · legacy `ArrangementsClass.js` (leadSynthsAnalog forcing)                                              | Fix                                                                                                                        |
| A7  | Effects — automation expansion   | Legacy `EffectsClass.getEffect` expands fadeIn/fadeOut/lowPassFilter*/fxNoiseRise into concrete volume/filter/ADSR automation-point arrays. Rebuild records a bare `{type}` tag and defers expansion to the engine. Brain output is less complete than legacy's. Known/documented deferral.                                                                                                                                                                            | both                  | completeness     | rebuild `arrangement-polish/signal-processors.ts:12-16,68-70,164` · legacy `EffectsClass.js:93-216`                                                                        | Fix                                                                                                                        |
| A8  | Synths — EDMArpeggiator seeding  | Legacy emits ONE seed event (bar 0/beat 0/`chords[0][0]`) and lets it unfold across the 2-bar array; rebuild re-seeds every bar with that bar's chord. If the engine treats each event as a fresh arpeggio start, multi-bar sweeps become per-bar restarts. Verify against engine adapter.                                                                                                                                                                             | both                  | audible (verify) | rebuild `patterns/synths.ts:196-214` · legacy `EDMArpeggiatorSynthPatternGeneratorClass.js:41-51`                                                                          | Fix                                                                                                                        |
| A9  | Guitar — fret-noise data         | Legacy ships author-positioned `fretNoise` events (1130 in c1) with multi-slice sounds + per-event offsets/durations/velocities that travel with the chosen strum. Rebuild ignores bank fretNoise and synthesizes one generic noise per bar (fixed beat 3.875, fixed dur/vel). Placeholder, not legacy data.                                                                                                                                                           | both                  | audible          | rebuild `patterns/guitar.ts:282-298` · legacy `guitarPatterns.json` (fretNoise events)                                                                                     | Fix                                                                                                                        |
| A10 | Guitar — strum position/voicing  | Legacy stamps a random `position ∈ {0,1,2,3}` (forced 0 for rock) per pattern = strum voicing/inversion; rebuild never emits it (always first position).                                                                                                                                                                                                                                                                                                               | both                  | audible (minor)  | rebuild `patterns/guitar.ts:36-38` · legacy `GuitarPatternGeneratorClass.js:44,81,88`                                                                                      | Verify conclusion (don't recall this feature), but subject to verification, fix since both casperaki 1 and 2 seem ot agree |
| A11 | Guitar — multi-bar patterns      | Rebuild reads only `pattern.bars[0]` and repeats it; legacy's 7 multi-bar patterns (5×8-bar, 6-bar, 2-bar) are flattened. Low impact for pop (all 1-bar); matters once A4 re-enables arpeggio/other styles.                                                                                                                                                                                                                                                            | both                  | audible (minor)  | rebuild `patterns/guitar.ts:158` · legacy guitar bank                                                                                                                      | Fix                                                                                                                        |
| A12 | Keys — library pool distribution | Legacy `pianoPatterns` for popTight/popLoose = `["library"]` only; rebuild `genreStyles.brightPop/organicVibes = ["library","altLibrary"]` (50/50) adds altLibrary legacy never picked.                                                                                                                                                                                                                                                                                | both                  | audible (minor)  | rebuild `data/patterns/keys/bank-index.json#genreStyles` · legacy `config.json#defaultStyleMappings.pianoPatterns`                                                         | Fix                                                                                                                        |

---

## B. casperaki1-only divergences (rebuild matches casperaki2; decision needed)

| ID  | Subsystem                                     | Discrepancy (what the regression is)                                                                                                                                                                                                                                                                                        | Regression against       | Severity        | Key files                                                                                                                                        | Resolution                                                                                                      |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| B1  | Structure — precedent pool                    | Song-structure precedent pool ported from casperaki2. casperaki1 has a 6-entry default pool (weight-doubling duplicate "Hot n cold") with much larger bar counts (16-bar choruses/verses); rebuild has 5 entries flattened to 8-bar sections. Every song's section lengths + precedent distribution differ from casperaki1. | c1 only                  | structural      | rebuild `data/structures/song-structures.json`, `structure/data.ts:28-32` · legacy `songStructures/{songStructures,schlagerSongStructures}.json` | Count how many structures casperaki1 and 2 have and list for human inspection, then decide.                     |
| B2  | Transitions — EDM coverage                    | casperaki1 gates EDM fills/buildups/snare-rolls/downlifters on `['edm','latin','popTight','schlager']`; rebuild `transitions.ts` only consults `brightPop*` rule keys, so real edm/latin/schlager songs emit only base `anyGenre` transitions — zero EDM transitions.                                                       | c1 only                  | audible         | rebuild `arrangement-polish/transitions.ts:65,133-204` · legacy `arrangements/instruments/transitions.js:120-229`                                | Explain to human in more detail.                                                                                |
| B3  | Transitions — EDM tag names                   | EDM fill/buildup tags renamed to casperaki2's `percussionBreaksFills`/`percussionBreaksBuildups`; casperaki1 uses `fxEdmFills`/`fxEdmBuildups`. A casperaki1-era renderer wouldn't recognize the rebuild tags.                                                                                                              | c1 only                  | audible         | rebuild `data/arrangement-polish/rules.json` · legacy `transitions.js:100,156,160,198,227`                                                       | If it's only names, it doens't matter since we'll only use our own brain/renderer.                              |
| B4  | Transitions — cross-segment post-passes       | Missing: `fxNoiseRise`-before-chorus injection (`transitions.js:256-288`), `cymbalsCrashHit`-after-`fxReverse` post-pass (`:292-315`), and the per-segment "50% second beginning transition" multi-pick/splice → lower transition density.                                                                                  | c1 only                  | audible         | rebuild `arrangement-polish/transitions.ts` (`pickBeginningEndPair`/`pickChorusTransitions`) · legacy `transitions.js:114-315`                   | Fix - c1 governs                                                                                                |
| B5  | Selection — discarded decision1 overrides     | casperaki1 hard-overrides roster: brightPop(popTight)→always guitar; edm/schlager→always focusOnBass. Rebuild treats these as "debug artifacts" and restores the full weighted tree.                                                                                                                                        | c1 only                  | audible         | rebuild `selection/index.ts:11-14,358-376,405-438` · legacy `patterns.js:647,866`                                                                | No need to fix, rebuild governs                                                                                 |
| B6  | Selection — strings rostering                 | Rebuild rolls/supports strings for ballad/organicVibes/urban (casperaki1 never does) and DROPS brightPop from string support (casperaki1 supports it via non-empty `stringPatterns:["stabs"]`).                                                                                                                             | c1 only                  | audible         | rebuild `selection/index.ts:111,338-351,385-402,490` · legacy `patterns.js` (no string branches for those genres), `config.json#stringPatterns`  | Explain to human in more detail.                                                                                |
| B7  | Selection — edm/schlager focusOnBass          | Rebuild forces strings for BOTH edm and schlager in focusOnBass; casperaki1 gives schlager BRASS (`decision2='brassSupport'`).                                                                                                                                                                                              | c1 only                  | audible         | rebuild `selection/index.ts:431-437` · legacy `patterns.js:736-768`                                                                              | Is brass an additional option in c1 schlager (in addition to strings)?  Or is c1 brass only?  Explain to human. |
| B8  | Selection — urban verse loops                 | Rebuild `LOOP_GENRES` includes urban → unconditional verse loop; casperaki1 never activates a loop on urban verses (gate list excludes urban; urban loop is a 1-in-3 roll, never verse-activated).                                                                                                                          | c1 only                  | audible         | rebuild `selection/index.ts:80-88,732` · legacy `ArrangementsClass.js:623,479-503`, `patterns.js:983-986`                                        | Rebuild governs since it sounds like it leads to more varied urban songs                                        |
| B9  | Pad — genre→style distribution                | Rebuild uses uniform 9-style distribution (matches casperaki2 `padPatterns` listing all 9 per genre). If casperaki1's per-genre subset differs, distribution diverges. (Verify casperaki1 `padPatterns`.)                                                                                                                   | c1 only (verify)         | audible (minor) | rebuild `data/patterns/pad/bank-index.json#genreStyles` · legacy `config.json#defaultStyleMappings.padPatterns`                                  | Verify as suggested.                                                                                            |
| B10 | Keys — arrangement-template piano             | Per-segment `playingStyle` table (intro→wholeNoteChords, verse→randomChordsShort, preChorus→buildUp sub-arrangement, chorus→randomChords; hipHop variants), the preChorus buildUp ramp, and `_getRiff` degree-walk riffs are unported. Depends on which legacy piano entry-path is canonical.                               | c1 only (path-dependent) | audible         | rebuild `patterns/keys.ts:43-68` · legacy `arrangements/piano/{upTempo,hipHop}/arrangement.js`, `arrangements/pianoPatterns.js`                  | Explain to human in more detail.                                                                                |
| B11 | Keys — kesha template silence                 | casperaki1's primary pipeline hardcodes `arrangementTemplate='kesha'`, under which the piano arrangement's per-segment branches are empty (piano silent). Rebuild always emits keys when the lane is active. Behavioral divergence dependent on canonical entry path.                                                       | c1 only (path-dependent) | audible         | rebuild `patterns/keys.ts` · legacy piano arrangement `case 'kesha':` branches                                                                   | Ignore c1                                                                                                       |
| B12 | keshaSynth — eighth-note template             | Legacy `arrangements/keshaSynth/uptempo/arrangement.js` adds `mode:'eighthNotes'` synth sections per segment under the kesha template. No arrangementTemplate concept exists in the rebuild.                                                                                                                                | c1 only (path-dependent) | audible (minor) | rebuild (no equivalent) · legacy `arrangements/keshaSynth/uptempo/arrangement.js`                                                                | Investigate more.  Is this a stylistic tool we should port somehow?                                             |
| B13 | Transitions — EDM fill/buildup gate condition | Legacy only adds the EDM fill/buildup when the segment's Drums override is NOT `hiHatOnly`/`percussionOnly`, and preChorus 50%-picks buildups else fills. Rebuild hardcodes the choice, reads no Drums override.                                                                                                            | c1 only                  | audible (minor) | rebuild `arrangement-polish/transitions.ts` rules · legacy `transitions.js:149-162`                                                              | Go with c1                                                                                                      |
| B14 | Transitions — outro pool                      | Legacy has no `case 'outro'` (outro gets transitions only via post-passes); rebuild gives outro `anyGenre:["fxReverse"]` = minor invented behavior.                                                                                                                                                                         | c1 only                  | cosmetic        | rebuild `data/arrangement-polish/rules.json` (outro) · legacy `transitions.js` (no outro case)                                                   | Outro shoudl not have fxReverse                                                                                 |
| B15 | Bass — genre→style probability                | Even on the SM fallback path, rebuild maps edm→`[edmSoftSM]` and organicVibes→`[brightPopSM]` (single), while casperaki1 randomizes edm→`[edmHard,edmSoft]` and popLoose→`[ballad,popTight]`. `edmHardSM` bank exists but is never selected. Reduced variety.                                                               | c1 only                  | audible (minor) | rebuild `data/patterns/bass/bank-index.json` · legacy `config.json` bass mappings                                                                | c1 makes sense, no?                                                                                             |

---

## C. Absent subsystems (whole casperaki1 features; likely deferred / out of scope)

| ID  | Subsystem                               | Discrepancy (what is absent)                                                                                                                                                                                                                                                                                                    | Regression against | Severity        | Key files                                                                                                                              | Resolution                                                                                                                                       |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Vocals — artificial-singer prep         | Entire note→phoneme→timing→pitch pipeline absent: phoneme-duration allocation, f0/pitch-contour, `.lab`/`.vpr`/`.s5p`/TextGrid emission, phoneme-pair duration rules. Brain emits raw notes + an unconsumed phoneme list only.                                                                                                  | absent             | completeness    | legacy `prepareSongForArtificialSinger.js:174-238`, `virtualSinger/virtualSingerDataPrep.js`, `vocaloid.js`, `synthesizerV.js:188-470` | Let's not port any artifical singer stuff for now - we'll use ACE Step 1.5 and SoulSinger, which work very differently                           |
| C2  | Vocals — phoneme alphabet               | `vocaloidPhonemes` field holds lowercase ARPAbet, not X-SAMPA; CMU→X-SAMPA map (`cmuToVocaloid.json`) and the `cmuPhonemes` field are missing entirely. Field misnamed + wrong alphabet for any real Vocaloid use; consumed by nothing in-repo.                                                                                 | absent             | completeness    | rebuild `vocals/syllabify.ts:96-124` · legacy `lyrics/assets/cmuToVocaloid.json`, `synthesizerV.js:188-200`                            | Same                                                                                                                                             |
| C3  | Lyrics — TemplatePoet engine            | Constraint-satisfaction poetry engine (457 blueprint grammar trees, mood/tense backtracking, filler-line corpora, theme coherence, prefix/postfix syllable adjustment, multi-MB word/syllable/rhyme corpora) replaced by a ~460-word, 2-phrases-per-(genre×segment) seed picker. Dirty-rhyme table itself IS ported faithfully. | absent             | audible/content | rebuild `vocals/lyrics-source/seed.ts`, `seed-phrases.json` · legacy `templatePoetClass.js:374-729`, `blueprints/*.json`, corpora      | This should be ported.                                                                                                                           |
| C4  | Vocals — schlager support lane / legato | Schlager support-vocal lane (`vocalsNaSinger`) + `_convertNotesToLegatoStyle` melisma glide + dynamic register lift (bars 8/16) + stacked chorus harmony declared in types but never emitted.                                                                                                                                   | absent             | audible         | rebuild `vocals/types.ts:51`, `backing.ts:21-24` · legacy `MelodyClass.js:653-683`, `MelodyNotesPatternsClass.js:498-563`              | This is about having a synth play along to the vocals for Schlager, which is a standard production technique.  Consider how to import.           |
| C5  | Vocals — stress classifier              | `classifyStress` is a "smallest faithful approximation" dropping the neighbour-note-dependent override (tie-to-long-note → `0`); rhyme tails reconstructed by flattening syllables (trimmed bank dropped the `phonemes` field). Currently low-impact: the flags are computed but unconsumed by the picker.                      | absent (approx)    | completeness    | rebuild `vocals/scaffolding.ts:84-94`, `rhyme.ts:97-105` · legacy `lyricist.js:62-217`                                                 | So if this is part of the lyrics pipeline int he legacy app, we should ultimately port it because it's improtant to the lyrics pipeline.  Check. |
| C6  | Notator — sheet-music export            | ABC-notation → vocal-sheet PDF generation (893-line NotatorClass) has no rebuild equivalent. Downstream consumer of song.json — almost certainly out of brain scope.                                                                                                                                                            | absent             | scope           | legacy `classes/notator/NotatorClass.js`, `services/notator.js`, `controllers/core.js:404-418`                                         | Research what's best way to generate vocal sheets these days - the ABC thing works quite well. I would port ujnless we have a better idea.       |
| C7  | Snippets — audio→MIDI extraction        | Melody/chord extraction from a Vamp/pYIN CSV (user-upload analysis endpoint). Input-side utility, not a generator — out of scope.                                                                                                                                                                                               | absent             | scope           | legacy `classes/snippets/SnippetsClass.js`, `controllers/snippets.js:313`                                                              | We both need to research what SOTA is for single-voice audio to MIDI these days                                                                  |

---

## D. Verified faithful (no discrepancy — for completeness, do not re-investigate)

EDM snare roll; drum override state machine + masks; bass overrides; fill
grids/composition mechanics; chord generation (pass-1/pass-2,
`normalizedLengthInBars`, `chordStructure` fingerprint, intro/outro `endOfChorus`
substring asymmetry); percussion-loop selection; strings generator
(octave-centering + bpm-band + genre dispatch); Library/EDMHouse/Arpeggio piano
generators; playful-synth quirks; pad chord styles + `chordType` voicing; backing
±4 vocal lanes; contour/range melody. **Mutes** are a no-op — faithful, because
legacy's mute branch is dead code too.

---

## Cross-cutting note

Several items in `docs/06-16-2026-to-dos.md` marked "DONE (06-16)" were done
**against casperaki2**, so they are correct under the casperaki2-canonical policy
but do NOT match casperaki1 (A2 bass, B1 structure, B2/B3 transitions; A1 fills
even slipped below casperaki2 fidelity). If casperaki1 parity is genuinely the
goal, the **canonical-legacy decision is the gating call** — it determines whether
the entire B bucket (and A2) is in scope before any individual fix.

---

## Progress & corrections log (06-20-2026)

Work started against the Resolution column. Each "Fix" item is re-verified
against **both** legacies before editing (the audit proved to have several
mis-tagged rows — see corrections below). All edits are pure brain-side; the
`arrangement` package is green (562/562 scoped). Pattern bank data files live
under `packages/arrangement/data/` (NOT `src/data/`, which only holds
`loader.ts`) and are read at runtime via `readFileSync` — so data edits need no
rebuild, but downstream packages (engine-adapter/brain) consume the built
`dist/` and their own goldens, which were NOT regenerated here.

### Done (verified vs c1 AND c2, committed to working tree)

- **A9 — guitar fret-noise data**: FIXED (brain-only — engine side already done).
  guitar.ts now emits the chosen bank pattern's OWN author-placed `fretNoise`
  events (multi-slice `sounds` indices + per-event offset/durations/velocities),
  wrapped per bar like the strums, replacing the synthesized one-generic-noise-
  per-bar placeholder (removed the FRET_NOISE_* constants). The WASM engine's
  `Guitar.h::getFretNoises` already iterates `sounds[]` as fxFretNoise indices, so
  no engine change was needed. Golden-neutral (no fixture rosters a guitar lane);
  covered by a new guitar-pattern.spec test that verifies emitted == bank events.
- **A1 — drum fill placement**: FIXED. `rules.json` `fills` now splits per genre
  into a `rich` branch (latin/organicVibes/rock — legacy `_getFill`'s
  `[latin,organicVibes,rock]` gate) and a `default` branch (edm/brightPop/
  schlager); intro uses the legacy coin logic (`$introSpecial`: rock always,
  latin/organicVibes 50%, edm/brightPop none). latin/organicVibes/rock regain
  intro end-fills, chorus mediumFill|bigFill middle + bigFill end, break/bridge
  by-next end-fills; edm/brightPop/schlager lose the spurious verse/preChorus
  end-fill (brightPop golden: −6 patternEndOfSegment). Slot values are constants
  (0 draws) or pools (1 `selectRandomly` draw, incl. length-1) — draw-count
  parity with legacy preserved. Grids/composition untouched. fills.ts +
  data.ts schema + rules.json.
- **A11 — guitar multi-bar patterns**: FIXED. `extractStrumEventsFromBankPattern`
  now returns events per pattern-bar and placement wraps `segBarIdx %
  patternBars.length` (mirrors the engine's `barIndex % bars.size()`). 1-bar
  patterns are byte-identical to before (no golden change); multi-bar bank rows
  (8/6/2-bar) now unfold across the segment. Matters once A4-enabled styles pick
  a multi-bar pattern. guitar.ts.
- **B4 — transition cross-segment post-passes** (c1 governs): FIXED. Added (a)
  `fxNoiseRise` injected before every chorus for {edm,latin,brightPop,
  organicVibes,rock,schlager}; (b) `cymbalsCrashHit` injected after any segment
  carrying `fxReverse`; (c) the per-segment "50% second beginning transition"
  with legacy splice (sample-without-replacement) semantics and the snare-coin-
  first draw order. Both post-passes are deterministic (0 RNG draws) and may
  write to non-anchor segments — safe because lowering reads bySegment per name
  with no inheritance. transitions.ts; the full per-segment logic
  (intro/break/verse/preChorus/chorus/bridge) was rewritten to mirror legacy
  exactly (incl. break's 50% gate, bridge's 50% snare + 2/3 buildup).
- **B13 — EDM fill/buildup gated on Drums override** (go with c1): FIXED. The
  EDM fill/buildup is suppressed when the segment's Drums override is
  hiHatOnly/percussionOnly, and preChorus 50%-picks buildups else fills (verse
  always fills). The per-segment Drums decision is computed once in orchestrate
  and threaded into both `applyArrangementOverrides` and `generateTransitions`
  (fork is name-keyed/order-independent, so output is unchanged). overrides.ts +
  orchestrate/index.ts + transitions.ts.
- **A5 — orchestral brass gate**: FIXED (regression vs **c2 only**; c1 was
  brass-schlager-only). casperaki2 actively rosters+plays brass in latin and
  organicVibes via the genre-independent StefanSchlagerPatterns bank (config
  brassPatterns latin=`[library,libraryStabs]`, organicVibes=`[libraryStabs]`;
  LibraryBrass loads the same bank for any genre). Fix = widen
  `ORCHESTRAL_GENRE_SUPPORT.popBrass` to `{schlager,latin,organicVibes}`
  (selection/index.ts) AND add `latin`/`organicVibes` → `["schlager"]` to the
  brass `bank-index.json` genreStyles (reusing existing data; no new bank). Did
  NOT reproduce c2's latin `library`-style ~50% throw bug. latin/organicVibes
  have no golden fixtures, so covered by bank-validation + 562 green tests.
- **A6 — leadSynthsAnalog forcing**: FIXED. Legacy ArrangementsClass FORCES
  `leadSynthsAnalog → keyboardMonophonicRhythmic` (its own `case`, no genre pick)
  — c1 `:259`, c2 `:159-160`. Rebuild picked style from genre only, discarding
  lane identity, so analog leads could render as arpeggiator/plucked/playful. Fix
  threads the lane `lowLevel` through patterns/index.ts dispatch and forces the
  style in synths.ts (skipping the genre draw, matching legacy). NOTE the audit
  over-stated the `synthsPlucked` half — that is ALREADY forced via its own
  `pluckedSynths` lane → `generatePluckedSynthsPattern`; no change needed there.
  edm golden: −133 noteRelative (analog lead restyle); brightPop: +70.
- **A8 — EDMArpeggiator seeding**: FIXED. Legacy emits ONE seed event in a fixed
  2-bar pattern (`new Array(2)`, bar 1 empty); the engine self-unfolds the 8-beat
  sweep across both bars, re-deriving each beat's chord from the chord track
  (`getChordAtTime`). Rebuild re-seeded every bar → per-bar arpeggio restarts in
  the legacy native engine. Fix = emit a 2-bar pattern, one seed in bar 0.
  Forward-compatible: the rebuild's WASM engine does not yet port EDMArpeggiator
  (`Resolver.h:30` — skipped), so no current render change, and the 2-bar shape
  matches the WASM `barIndex % numPatternBars` wrap for when it is ported.
- **A3 — pad singleNote octave**: FIXED. `rootMidiOctave` 5/4/3 → 4/3/2 in
  `data/patterns/pad/bank-index.json`. Root cause is an octave-*convention*
  mismatch: legacy emits note label `'5'/'4'/'3'` and converts via `notesDecMap`
  (`c5=60`, c0=0 convention) → MIDI 60/48/36; the rebuild's `pad.ts` uses
  `(rootMidiOctave+1)*12+root` (c-1=0 convention), so the matching octaves are
  4/3/2. Both legacies confirmed identical (60/48/36). Golden diffs show clean
  −12 shift on all pad notes (edm + brightPop vertical slices).
- **A4 — guitar genre→style map**: FIXED. `brightPop` → `[country,pop,rock]`,
  `organicVibes` → `[arpeggio,funk,jazz]` in `data/patterns/guitar/bank-index.json`.
  The audit's "both" tag is correct; the rebuild's "no legacy entry → [pop]" was a
  porting error that missed the `popTight→brightPop` / `popLoose→organicVibes`
  rename. Both legacies agree. Unit tests in `guitar-bank.spec.ts` updated
  (brightPop is now multi-style; union count 33→267).
- **B14 — outro fxReverse**: FIXED. `outro.anyGenre` `["fxReverse"]` → `[]` in
  `data/arrangement-polish/rules.json`. Legacy has no `case 'outro'`. Golden diffs
  confirm `transitions: {}` on outro.

### Corrections to this audit (verified — these rows need NO fix)

- **A2 — bass generator family**: AUDIT WRONG. The audit claims c1 has "only one
  bass generator, chord-relative for every genre". FALSE: c1 has 3 generator
  classes (LibraryBass active + HipHop dead + Override) and LibraryBass is
  genre-routed via a `style` switch. More importantly, the rebuild's routing is a
  faithful mirror of **casperaki2** (the canonical legacy): c2's same-named
  `LibraryBass` is a *different*, absolute-MIDI generator (c1's and c2's
  `LibraryBassPatternGeneratorClass.js` share only a filename). No rebuild change
  warranted; the audit conflated the two LibraryBass classes.
- **A10 — strum position/voicing**: AUDIT OVERSTATED. The legacy generator does
  pick a random `position∈{0,1,2,3}` (rock→0) and write it to bar 0, but the line
  that stamps it onto strum events is commented out AND the engine
  (`Chord.h::getLowestPosition`) hardcodes position 0 with an explicit comment
  "always picking the first position now". The field is dead in the legacy too —
  the rebuild's "always first position" is behaviourally equivalent. No fix.
  (User's recollection was correct.)
- **A12 — keys library pool**: AUDIT MIS-TAGGED ("both"). c1 popTight/popLoose
  pianoPatterns = `["library"]`, but **c2** brightPop/organicVibes =
  `["library","altLibrary"]` — the rebuild matches c2 exactly. This is a c1-only
  divergence; under the c2-canonical policy, no fix.
- **B9 — pad genre distribution**: NO FIX. Verified c1, c2 and rebuild all list
  the identical uniform 9 pad styles for every genre.
- **B15 — bass genre→style probability**: NO FIX (dead path). The SM bass bank
  (whose edm/organicVibes genreStyles the audit flags) is the FALLBACK path,
  reached only for `urban` without a drum pattern; every other genre (incl. edm
  and organicVibes) has a real generator (`selectRealBassPattern` non-null), so
  those SM entries are never selected. Editing them has zero audible effect.
  Consistent with the A2 finding (SM banks sit on a dead fallback path).

### Confirmed genuine — still TODO (need code work, not just data)

All audited brain-parity items are now resolved (fixed, or verified no-fix).

### Investigations delivered (for human decision — see chat)

- **B1 — structure precedent pool**: full c1/c2/rebuild comparison produced. The
  rebuild is a verbatim c2 port; c1's richer 6-entry/16-bar pool (weight-doubled
  "Hot n cold", irregular bar counts) is a data-only revert if desired.
  **DECISION 06-20: keep c2 pool — no change.**
- **C3/C5 — lyrics engine**: scoping + port plan produced. C3 (TemplatePoet) is a
  large port dominated by a ~1100-line backtracking verse engine + an
  RNG-determinism redesign; data = templates.json (445 trees) + metadata.json
  (2697 rows) + an expanded syllables dictionary. C5 stress classifier is only
  consumed by C3's phrase filter → **defer C5 until C3 is ported**. (Deferred by
  decision 06-20: finish brain parity first.)

### A7 — effects automation expansion (engine-adapter; fades DONE, fxNoiseRise deferred)

The brain correctly emits the bare `{type}` tag by design (docs/53k); the
`EffectsClass.getEffect` expansion lives **downstream** in the engine-adapter.
- **fadeIn / fadeOut**: FIXED (06-20). The adapter's `signal-processors.ts` now
  expands these to a 2-point `volume[]` dB ramp over the segment (added to
  `SUPPORTED_SP_TAGS`; `SignalProcessorBlock` gained an optional `volume[]`). The
  WASM engine ALREADY consumes `signalProcessors.<inst>.volume[]` end-to-end
  (`Resolver.h:181-186` → `Mixer.h:124,651-658` `applyLaneAutomation`, gated by
  the same `mixEnabled` flag as the lowpass automation), so NO engine change was
  needed. NOTE: WASM volume automation is a MULTIPLICATIVE dB offset held at the
  last point, so the legacy literal endpoints (-25/-10, which relied on JUCE's
  `nextDefaultVolume`-on-last-point trick, Instrument.cpp:94-101) were adapted to
  the WASM model: fadeIn ramps -25→0 dB (up to nominal, no bleed), fadeOut 0→-25
  dB. Already-done: the 10 `lowPassFilter*` tags. Unit-tested (signal-processors.spec).
- **fxNoiseRise**: DONE (06-20). Ported the legacy `transitionNoise`
  (TransitionNoise.h) to the WASM engine as a new synthesized audio source. Chain:
  (1) brain emits the transition (B4a); (2) the engine-adapter expands it into the
  `EffectsClass.getEffect('fxNoiseRise')` param object (`buildNoiseRiseBlock` in
  transitions.ts — start position via `_getStartPoint`, attack/decay durations,
  100→20000 Hz sweep, −30/−20/−50 dB envelope; deterministic start-type pick);
  (3) the WASM `Resolver::resolveNoiseRises` turns each into an absolute-time
  `NoiseRise`; (4) `Mixer::buildNoiseRiseLanes` builds a self-contained
  `NoiseSource` lane (deterministic white noise via `casperaki::Random` + an
  intrinsic LP cutoff sweep + a 3-segment dB envelope + the fxNoiseRise target
  gain), routed to the `"fx"` submix. No new RenderConfig flag — absence of a
  riser is the gate.

  EXACT port (06-20, after review — verified against the vendored Tracktion source):
  the `NoiseSource` faithfully transcribes the legacy 4OSC→track→mix chain.
  (a) Noise = Gaussian N(0, σ=0.1) DECORRELATED per channel (Box-Muller over the
  engine's deterministic `Random`), matching `tracktion_Oscillators`'
  `std::normal_distribution{0,0.1}` per-channel generators — the earlier uniform-
  mono noise was wrong (≈6× too loud, too bright). (b) Freq sweep = the EXACT
  `te::AutomationCurve` quadratic bezier for the stored curvature 0.5 (doubles to
  effective c=1.0, control (x2,y1)) → `cutoff = freqStart·(1−t²) + freqEnd·t²`,
  `t = 1−√(1−frac)` (was a linear ramp). (c) Track volume automation interpolates
  in FADER-POSITION space (`exp((dB−6)/20)` → `volumeFaderPositionToGain`), not dB.
  (d) 4OSC amp ExpEnvelope (analog ADSR 0.1/0.1/0.8) + exact `velocityToGain`
  (~0.40) + osc/master level 0 dB. (e) Sweep filter: `te::LowPassPlugin` is RBJ
  Butterworth Q=0.707 block-stepped = IDENTICAL to the engine's `LowPass.h`, so the
  stand-in IS the exact filter here. Two documented, justified approximations: the
  4OSC per-voice filter is omitted (opens to ~20 kHz in ~37 ms, in series with the
  strictly-more-closed LowPassPlugin sweep → masked for ~the whole riser); and the
  Gaussian sample SEQUENCE can't be bit-exact (the legacy `std::default_random_engine`
  is impl-defined) — only the distribution/level match. Tested: native
  `noise_source_test` (window / envelope / sweep / stereo-decorrelation / determinism
  + resolver parse) + adapter `buildNoiseRiseBlock` units; full ctest 6/6.

### B-bucket explanations delivered (06-20; decisions for human)

- **B2 — EDM transition coverage**: FIXED (06-20; it was a regression vs **c2
  too**, not c1-only as tagged). `transitions.ts` now gates the EDM extras on
  `EDM_TRANSITION_GENRES={edm,latin,brightPop,schlager}` and the chorus
  `cymbalsCrashHit` on the wider `CHORUS_CRASH_GENRES={…,rock}` (matching
  c2 transitions.js:190 vs :196). edm/latin/schlager now emit
  fills/buildups/snare-rolls/downlifters; rock gains the chorus crash. edm golden
  gains cymbalsCrashHit + percussionBreaksFills×2 + percussionBreaksBuildups +
  fxTransition.
- **B6 — strings rostering**: NO FIX. Rebuild matches c2 exactly genre-for-genre.
  The audit's "c1 supports brightPop strings via stringPatterns:['stabs']" is
  WRONG — `stringPatterns` is a style-name lookup consumed only *after* a string
  lane is rostered, not a roster trigger; c1's `popTight:["stabs"]` is dead config
  (c1 only ever rosters strings in the edm focusOnBass branch). c1 never rosters
  brightPop strings, so nothing was dropped.
- **B7 — schlager focusOnBass (answer to the human's question)**: c1 schlager
  focusOnBass is **brass-ONLY**, not a brass-or-strings choice (decision2 =
  `selectRandomly(['brassSupport'])`, a one-element array; the strings case is
  structurally unreachable for schlager). c2 changed both edm AND schlager to
  strings (brass branch = dead code); rebuild mirrors c2. **DECISION 06-20: keep
  c2 (strings) — no change.**
- **B10 — keys arrangement-template piano**: NO FIX (out of scope). The
  per-segment piano playingStyle table, preChorus buildUp ramp, and `_getRiff`
  live only in the **abandoned** legacy arrangement path (`services/arrangements.js`
  + `arrangements/piano/...`). The canonical legacy the rebuild ports from
  (`ArrangementsClass.js`) picks one genre-level piano style from config — exactly
  what `keys.ts` already does. No audible parity gap.
- **B12 — keshaSynth eighth-note template**: NO FIX (out of scope). The `kesha`
  `arrangementTemplate` is a hardcoded one-off (`services/arrangements.js:72`) in
  the abandoned path; the canonical `ArrangementsClass.js` has zero references to
  `arrangementTemplate`/`kesha`/`keshaSynth` and never produces a keshaSynth lane.
  A named "style preset" system could be a future *product* feature, but it is not
  a port and not in parity scope.
