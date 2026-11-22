# Guitar pattern bank — legacy provenance

## `guitarPatterns.json`

- **Source**: `casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/guitarPatterns.json`
- **Copied verbatim** (no shape modification).
- 702 named patterns total; each value is a 1-bar (some 2-bar) pattern array.
- Each bar carries `notes: { "<beat>": [event, ...] }`. Lane A consumes
  only the `type: 'strum'` events (per-string single-note hits).
- Pattern names follow the legacy convention `<preset> - <bpm>-<subdiv>-<sig>-<style>-<variant>`.
  The "Pop" substring marker is what the legacy `GuitarPatternGeneratorClass.js`
  matches when `style === 'pop'` (33 entries).
- The legacy generator's `position` field (0..3) — randomly chosen at
  emit-time and written into the first bar — is vestigial: the engine's
  `getStrumNotes` resolves per-string MIDI through
  `GuitarChord{currentChord}.getLowestPosition()` which always returns
  `positions[0].midi` (Chord.h:537-554 — the lowest-position search loop
  is commented out with the explanatory note "the legacy app is always
  picking the first position now"). Lane A therefore drops `position`
  from the emitted pattern.

## Lane scope

- **Lane A (docs/54x)**: filter to "Pop"-name patterns; pick one per
  segment via `ctx.rng.fork('patterns/guitar')`; emit each bar's `type:
  'strum'` events verbatim, with the bar's `chord` rewritten to the
  current chord at the event's beat position.
- **Lane B (docs/54y)**: the larger `virtualGuitaristPatterns.json` +
  `virtualGuitaristStefanPatterns.json` + `virtualGuitaristStyleMap.json`
  triple. Shares the same selection contract but adds multi-event-per-bar
  `virtualGuitarist` emissions (chord-strum types + fx1..fx7) plus the
  per-genre BPM-aware style map.

## `virtualGuitaristPatterns.json` (Lane B main bank)

- **Source**: `casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/virtualGuitaristPatterns.json`
- **Copied verbatim** (no shape modification).
- 702 named patterns total; bars per pattern vary (predominantly 1).
- Each bar's `notes` map carries a MIX of `type: 'strum'` (per-string,
  Lane A's territory), `type: 'virtualGuitarist'` (chord-strum +
  fx1..fx7 articulation; Lane B's territory), and `type: 'fretNoise'`.

## `virtualGuitaristStefanPatterns.json` (Lane B Stefan bank)

- **Source**: same legacy dir as above.
- 9 patterns. Lane B picks from this bank ~40% of the time for
  brightPop (per `VirtualGuitaristPatternGeneratorClass.js:41`'s
  `Tools.selectRandomly([false, false, true, true, true])` 3/5 vs
  2/5 main/Stefan split).

## `virtualGuitaristStyleMap.json` (Lane B style map)

- **Source**: same legacy dir as above.
- 701 entries shaped `{ name, genres: [...], bpmMin: "<int>", bpmMax: "<int>" }`.
  Note: `bpmMin` / `bpmMax` are JSON strings in the source; the loader
  coerces them to numbers.
- The main-bank picker filters style-map entries by
  `genres.includes(<genre>) && bpmMin <= bpm <= bpmMax` and picks one
  random entry, then resolves `virtualGuitaristPatterns[entry.name]`.

## Legacy post-processing rules ported by Lane B

`VirtualGuitaristPatternGeneratorClass.js:99-163` post-processes the
picked pattern in-place:

1. **fx filter:** events with `type==='virtualGuitarist' && event.startsWith('fx')`
   are dropped if `event` is NOT in `['fx1','fx2','fx4','fx6']`; count
   the drops as `numberOfRequiredSubstitutionFX`.
2. **Strum durations clamped at min 1.0:** events with `type==='strum'`
   have `note.durations = note.durations.map(e => Math.max(e, 1))`.
3. **fx substitution:** for each dropped fx, append a random pick from
   `['fx1','fx2','fx4']` (note: NOT `fx6` — the pool the legacy uses
   for substitutions is intentionally narrower than the keep-list).
   Picks are without replacement within the same beat.
4. **Empty-beat cleanup:** if a beat's note array is empty after the
   above, the key is deleted.

## Data fix (2026-11-22)

`virtualGuitaristStyleMap.json` named two patterns that are not in the main
bank: "Ample Guitar - 110-16-44-Folk-Chord CMaj-009-bak" and "…-010-bak"
(organicVibes, 95-130 bpm). They are stray backup duplicates of "…-009" and
"…-010", which are mapped with the same genre and tempo range. Picking one
crashed song generation (the legacy would crash too). Removed.
