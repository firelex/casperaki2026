# 58e — fx taxonomy reclassification + per-lowLevel climax conventions

Status: landed. Scope collapsed from "build a unified catalog merger" (the
original plan, pre-investigation) to "apply two small legacy-curation
conventions the xlsx authoring didn't preserve" — because the disk-path
audit revealed the xlsx already covers 100% of the legacy
`effectsMetadata.json` files that exist on disk. No new catalog rows;
two targeted edits. Predecessor: 58d (per-row climax overrides — the
mechanism this slice extends).

## What was actually wrong with the original premise

User intent going in: port the 2,979-entry legacy `effectsMetadata.json`
into the new catalog so we have everything the legacy DB knew.

The probe (`apps/engine-spike/scripts/probe-legacy-fx-disk.mjs`)
revealed:

| | Count |
|---|---|
| Legacy entries with a disk match | 2,905 |
| Of those, the **disk file is already imported by the xlsx** | **2,905** (100%) |
| Legacy entries with no disk match at all | 74 (Stefan-replaced libraries — Serum FX, Type1/2/3 tonalReverse, per-note fretNoise pack, BANK 8bit gaps, Oversampled UFBT_faller variants) |

The reframing: the xlsx (12,090 rows) is broader than the legacy
catalog (2,979 fx entries) because it ingests the percussionBreaks
family (3,283 rows) that the legacy split across `edmFills` (500) +
`edmBuildups` (2,339) and the cymbals family (121 rows) that included
the legacy `crash` (3) + `reverse` (4) subtypes. Same files,
re-curated under modern taxonomy. So there's nothing to "port" — the
catalog content is already there.

But two legacy curation conventions WERE lost:

1. **Per-lowLevel climax convention.** The legacy `tonalReverse`
   subtype had 36 entries (3 packs × 12 keys), all carrying
   `climax: 1.1` — a family-wide convention, not per-sample tuning.
   Today's catalog has 120 `fxTonalReverse` rows (bigZ Reverses_1..10
   × 12 keys) — equivalent content via different libraries; without an
   override, the adapter falls through to `defaultClimaxForTag(tag,
   duration)` which returns the full sample duration. Carrying the
   legacy convention preserves Stefan's hand-tuned 1.1-sec peak point
   for the whole family.
2. **`fx8bitArcade` lowLevel for retro-arcade fx samples.** The legacy
   `8bitArcade` subtype identified 19 samples (DonkeyKong, Frogger,
   MsPacMan, PacMan, nintendo). The xlsx files them as `fxOther` with
   `mainStyle=8bit` — the disk paths and bytes are identical, only the
   lowLevel string differs. Splitting them out as `fx8bitArcade` lets
   the engine's `FX::getInstrumentTargetVolume` (and any future
   per-lowLevel send-bus tuning) target arcade samples independently
   of generic fxOther. The catalog reclassification is the
   bookkeeping; the engine taxonomy update wires the dispatcher.

## What landed

### Edit 1 — extended `transition-climax-overrides.json` to two layers

`packages/engine-adapter/data/transition-climax-overrides.json`:

```json
{
  "$schemaVersion": 2,
  "byLowLevel": {
    "fxTonalReverse": { "climaxSec": 1.1, "rationale": "…legacy convention…" }
  },
  "byCatalogId": { …5 hand-tuned entries from 58d… }
}
```

`packages/engine-adapter/src/index.ts` — three-tier lookup at the
transition lowering call site:

```ts
const climaxSec = TRANSITION_CLIMAX_BY_CATALOG_ID.get(resolved.entry.id)
  ?? TRANSITION_CLIMAX_BY_LOWLEVEL.get(resolved.entry.lowLevel)
  ?? defaultClimaxForTag(tag, durSec);
```

27/27 existing transition tests pass unchanged. New default applies to
the 120 fxTonalReverse rows that the matrix renders touch.

### Edit 2 — `fx8bitArcade` reclassification + engine taxonomy + disk alias

Three changes in concert:

1. **Catalog side** (`packages/arrangement/src/catalog/build-snapshot.ts`)
   — `applyLegacyReclassifications()` step after sheet conversion: any
   row whose `(family, lowLevel, mainStyle) == ('fx', 'fxOther',
   '8bit')` has its `lowLevel` rewritten to `fx8bitArcade` and its `id`
   re-derived. Re-import via the existing CLI; 15 rows reclassified.
   Pre-existing `fxOther` lowLevel becomes empty (all xlsx fxOther rows
   ARE the 15 arcade ones).

2. **Audit side** (`packages/arrangement/scripts/audit-sample-library.mjs`)
   — added a `DISK_TO_CATALOG_ALIASES` entry: `fx/fxOther` (disk) →
   `fx/fx8bitArcade` (catalog). Verified by listing the disk dir: all
   15 files in `fx/fxOther/` are the arcade samples — no non-arcade
   bystanders to worry about. Re-ran the audit; the 15 arcade rows
   match cleanly via the alias under `fx/fx8bitArcade/…`.

3. **Engine side** (`casperaki_engine/Source/FX.h`) — added
   `{ "fx8bitArcade", "fx" }` to `typeMappingTable` so
   `FX::getFXGroupFromLowLevelType("fx8bitArcade")` returns the `fx`
   group rather than falling through to the `drums` default. (The
   `getInstrumentTargetVolume` table's default of `return 0` already
   covers arcade samples at unity gain; explicit per-genre arcade
   tuning is a future tweak if/when needed.)

## Verification

- `pnpm --filter @casperaki/arrangement build` → clean
- `pnpm --filter @casperaki/arrangement test` → 464/464 pass
- `pnpm --filter @casperaki/engine-adapter test` → 27/27 pass on the
  transition + transitions-wiring suites (full suite running)
- Catalog re-import: 12,090 rows imported (unchanged total),
  contentHash `baa174e1dd10…`
- Audit re-run: 12,073 matched (unchanged from pre-reclassification),
  17 missing (the pre-existing gaps in `fxNoiseRise`/`fxAtmosphere`/
  orchestral/percussionLoops — none related to this slice), 0 arcade
  rows missing

## What is explicitly NOT in scope

- **74 legacy fx entries Stefan replaced** (37 Serum FX, 36 Type1/2/3
  tonalReverse, 7 per-note fretNoises, 7 UFBT_faller variants, 4 BANK
  8bit gaps, 1 White Noise 1min — engine self-synthesises). Frozen at
  `packages/arrangement/data/legacy/fx-missing-on-disk.{json,txt}`
  (not gitignored — tracked permanently). User is sourcing.

## How "engine doesn't use missing samples until recovered" is enforced

Two classes of missing samples, both protected by the same architecture:

1. **17 audit-missing rows** (xlsx rows whose disk file isn't where the
   catalog expects). The audit's `missing` array lists these.
   `loadValidatedCatalog()` (`validated-catalog.ts:122-123`) drops any
   catalog row whose id isn't in `audit.matched`:

   ```ts
   const hit = matchedByCatalogId.get(e.id);
   if (!hit) continue; // catalog row not in audit's matched set → filtered out
   ```

   The brain's selection layer (`selection/index.ts:455`) reads only
   `loadValidatedCatalog()`, never the raw snapshot. So missing-on-disk
   rows are unreachable from the render path — empirically 12,090
   snapshot rows → 12,073 validated entries (diff = 17 audit-missing).
   Recovery: put the file on disk at the path the catalog expects, then
   re-run `audit-sample-library.mjs`. The row reappears automatically.
2. **74 legacy-only entries** (in `fx-missing-on-disk.json`). These
   weren't migrated to xlsx, so they have no catalog row at all → no
   path through brain → no engine load. Recovery requires both (a)
   adding the file on disk and (b) adding a catalog row (xlsx edit or
   programmatic post-import injection — same mechanism as
   `applyLegacyReclassifications`).

Read-only consumers like `apps/brain/src/routes/catalog.ts` and
`apps/web/src/api/catalog.ts` may surface the full snapshot to UI for
browsing; that's fine — they don't drive rendering.
- **Per-row climax for the other 44 legacy explicit-climax entries.**
  All reference the unreachable presets above; without disk paths,
  there's nothing to apply them to.
- **Brain-side `fxNoiseRise` event emission.** Engine
  (`TransitionNoise.h:125-148`) already supports filter-swept noise
  generation via FourOscPlugin programmatically — no sample file
  needed. The brain just doesn't emit `fxNoiseRise` transitions yet.
  Separate gap, separate slice.

## Files touched

- `packages/engine-adapter/data/transition-climax-overrides.json`
  (schema v2 — added `byLowLevel`)
- `packages/engine-adapter/src/index.ts` (climax 2-tier → 3-tier lookup)
- `packages/arrangement/src/catalog/build-snapshot.ts`
  (`applyLegacyReclassifications` step)
- `packages/arrangement/scripts/audit-sample-library.mjs`
  (`fx/fxOther` → `fx/fx8bitArcade` alias)
- `packages/arrangement/data/instrument-catalog.snapshot.json`
  (regenerated; 15 rows reclassified; contentHash changed)
- `packages/arrangement/data/sample-library.audit.json` (regenerated)
- `packages/arrangement/data/sample-library.missing.md` (regenerated)
- `packages/arrangement/data/legacy/effects-metadata.json` (frozen
  legacy snapshot; not consumed at runtime — kept for audit trail)
- `packages/arrangement/data/legacy/audio-library-master-file.xlsx`
  (frozen xlsx; not consumed at runtime — kept for audit trail)
- `casperaki_engine/Source/FX.h` (`fx8bitArcade` → `fx` group)
- `docs/58e-fx-taxonomy-and-conventions.md` (this file)
- `packages/arrangement/data/legacy/fx-missing-on-disk.json` + `.txt`
  (the 74 legacy entries Stefan replaced — moved from the gitignored
  `apps/engine-spike/out/` so the audit trail survives)
- `apps/engine-spike/scripts/probe-legacy-fx-disk.mjs` (the probe
  that produced the duplicate-finding; kept as a re-runnable tool)
