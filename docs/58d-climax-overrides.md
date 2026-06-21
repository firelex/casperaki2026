# 58d — Per-catalog-row transition climax overrides

Status: 5 cleanly-matched entries landed at
`packages/engine-adapter/data/transition-climax-overrides.json`; adapter
consults the override map at `index.ts` ahead of the
`defaultClimaxForTag` heuristic. 27/27 existing transition tests pass
unchanged. No engine binary change. Predecessor: 58a/58b (sound-parity
audits); successor: 58e (full legacy fx port — most of `effectsMetadata`
needs more than just climax overrides because the rebuild's xlsx
didn't migrate the underlying preset rows).

## Hypothesis

> Today's `defaultClimaxForTag(tag, durSec)` heuristic — attack-branch
> → 0, tail-branch → duration — silently overwrites hand-tuned climax
> values that the legacy stored per-sample in
> `Instruments.sampleDetails.climax`. Restoring those values gives the
> transition timing math the same per-sample peak the legacy used.

Confirmed. Out of the 2,979 legacy fx entries in
`casperaki1/api/v1.0/services/data/sounds/fx/effectsMetadata.json`, 49
carry an explicit `climax` field; the remaining 2,930 used the same
`climax || 0` / `climax || duration` defaults the rebuild already does.

## Coverage

| | Count | |
|---|---|---|
| Legacy explicit-climax entries | 49 | |
| Cleanly matched to today's xlsx catalog | **5** | bigZ only |
| Unmatched | 44 | Serum FX uplifters (8); `Type1_*` tonalReverses (36) — neither library is in today's xlsx fx sheet |

The 5 matched rows + their values:

| catalogId | legacy file | lowLevel | climaxSec |
|---|---|---|---|
| `4a9682b02067fa33` | `Big_Z_Uplifter_4.wav` | fxUplifter | 7.732 |
| `f5441b45a6961cc1` | `Big_Z_Low_Impact_1.wav` | fxLowImpact | 0.687 |
| `77d7f2815c7c5f14` | `Big_Z_Transition_1.wav` | fxTransition | 1.9 |
| `58e9ffaa10f27139` | `Big_Z_Transition_2.wav` | fxTransition | 0.986 |
| `783ff18ecde849e2` | `Big_Z_Transition_3.wav` | fxTransition | 0.5 |

## Wiring

`packages/engine-adapter/src/index.ts`:

```ts
// At module init — load once.
const TRANSITION_CLIMAX_OVERRIDES: ReadonlyMap<string, number> = (() => { ... })();

// In the transition lowering loop (line ~933):
const climaxSec = TRANSITION_CLIMAX_OVERRIDES.get(resolved.entry.id)
  ?? defaultClimaxForTag(tag, durSec);
```

Lookup is `O(1)` on a 5-entry map; no behavior change for any catalog
row not in the override file. 27/27 existing transition tests pass
unchanged.

## What's NOT in scope

The override map only handles **climax** for rows that already exist in
the catalog. Two larger gaps are 58e's job:

1. **2,974 legacy fx entries** that the xlsx didn't migrate (Serum FX,
   `Type1_*` tonalReverses, the bulk of edmFills/edmBuildups that got
   reclassified to percussionBreaks, drum-roll content, etc.). These
   need to be added to the catalog as new rows (or via an overlay the
   `validated-catalog` loader joins on load) so the resolver can find
   them at all. Once they're catalog rows, the same
   `transition-climax-overrides.json` mechanism extends trivially —
   add their catalogIds + climax values to the same file.
2. **Duration parity for the 2,974.** Today's `probe(entry)` reads
   duration from disk; the legacy carried it in the metadata too.
   Probe is fine as long as the disk file is reachable, so this isn't
   a regression — it's just redundancy in the legacy.

## Files touched

- `packages/engine-adapter/data/transition-climax-overrides.json` (new)
- `packages/engine-adapter/src/index.ts` (+~20 lines: module-init loader
  + 2-line lookup in the transition lowering loop)
- `docs/58d-climax-overrides.md` (this file)
