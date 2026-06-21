# 58h — Union instrument catalog (xlsx ∪ on-disk presets)

Status: implemented. Union catalog built + committed
(`packages/arrangement/data/instrument-catalog.union.json`, 12 216 rows =
12 090 xlsx + 126 disk), audit re-run against it, `loadValidatedCatalog()`
wired to consume it, pad role repointed to the recovered synth pads,
brightPop render passes with the pad lane staging a `synthsSoftPad` sample
(no `popStrings`). All `@casperaki/arrangement` + `@casperaki/engine-adapter`
tests green.

## Problem

The frozen instrument-catalog snapshot
(`instrument-catalog.snapshot.json`, built by `build-snapshot.ts` from
`audio-library-master-file.xlsx`) catalogs only the rows the master
workbook authored. The sample library on disk holds **many** presets the
workbook never listed — whole subcategories like `synths/synthsSoftPad`
(54), `synths/synthsBrightPad` (19), extra `synths/synthsPlucked` (14),
plus stray `keys` / `orchestral` / `electricGuitars` / `popBrass` / `fx` /
`vocals` presets. With no catalog row pointing at them, they are invisible
to `selectInstruments`.

The most visible symptom: the **pad** role had no synth pads to draw from
(the xlsx has zero synth-pad rows), so it borrowed `popStrings` —
orchestral strings including *tremolo* — as a pad stand-in. Pads sounded
like tremolo strings.

## The union

The *effective* catalog is now the UNION of

- **(a)** every xlsx snapshot row — tagged `source: 'xlsx'`, and
- **(b)** one row per disk file no xlsx row claimed **and** that is a
  genuine new preset — tagged `source: 'disk'`.

The disk-only additions come from a sample-library **audit** report's
`unmatchedDiskFiles` (every disk file no catalog row matched). The builder
does **no disk walk** of its own — the audit already walked, and
re-deriving from its committed output keeps the build pure, fast, and
deterministic (the Dropbox mount is slow).

### What is excluded (and why)

Two classes of unmatched file are deliberately **not** promoted, so they
stay in the audit's `unmatchedDiskFiles` for the asset resolver's variant
pool (`asset-resolver.ts`):

- **variant renders** — pre-rendered per-key / per-bpm siblings of a
  catalogued preset: `… - C# 122bpm.mp3`, `… 75bpm_modified.mp3`,
  `Classic Wobble - 123.mp3`. These are not new presets.
- **`percussionLoops`** — the loop domain is bpm-binned and resolved by
  `engine-adapter/loops.ts`, not by the per-preset catalog.

Of 27 272 unmatched disk files: 27 145 are variants/loops, 1 is mis-filed
(below), **126 are genuine new presets** → the union additions.

### Reconstruction gate

Each surviving file is parsed back into catalog fields by **inverting the
audit's `RULE_SIMPLE` join** (`{family} - {lowLevel} - {mainStyle} -
[{library} - ]{preset}.mp3`; tokens after `mainStyle` are `library` first,
then `preset`). As a hard correctness gate, the parsed entry is fed through
`preferredExpectedPath` and the result **must reproduce the exact disk
path** — otherwise the file is mis-filed on disk (e.g. `…/synthsViolaLegato/
… - orchestralViolinLegato - …`, where the embedded lowLevel disagrees with
its directory) and could never be audited-matched, so it is skipped rather
than added as a permanently `missing` row. One file is skipped on this
gate.

`id` is the same 16-hex `deriveId` the xlsx builder uses (so disk ids are
deterministic and never collide with xlsx ids). `bpm`/`key`/`normalisation`
are `null`; disk `sourceRow`s are synthetic, offset by `1_000_000`, so on a
sort tie disk rows order after xlsx rows.

## Determinism & idempotency

`buildUnionCatalog(base, audit)` is a pure function: same inputs →
byte-identical `entries` and `contentHash` (hashed exactly as
`build-snapshot.ts`). It is also **order-independent**: it re-audits the
disk listing (reconstructed from the audit's own
matched ∪ ambiguous ∪ unmatched paths) against the **base** catalog, so
the additions are "files no xlsx row claims" regardless of whether the
input audit was computed against the base or against a prior union. This
means the steady-state operating chain is safe to re-run:

```
build-snapshot   →  instrument-catalog.snapshot.json   (xlsx, frozen)
build-union      →  instrument-catalog.union.json       (xlsx ∪ disk)
audit            →  sample-library.audit.json           (against the union)
```

`build-union-catalog.mjs` followed by `audit-sample-library.mjs`.

## Wiring

- `loadEffectiveCatalogSnapshot()` (new, in `snapshot.ts`) returns the
  union file when present, else the xlsx-only base snapshot. Both are
  Zod-validated and `contentHash`-verified on load.
- `loadValidatedCatalog()` and the audit CLI consume the effective
  catalog. `loadInstrumentCatalogSnapshot()` stays pure (base only) — the
  union builder reads it, and the snapshot-provenance tests pin its
  master-file identity.
- `source` is union provenance; it lives in `instrument-catalog.union.json`
  (per-entry) plus a `unionProvenance` summary block, and is intentionally
  **stripped** at the `ValidatedCatalogEntry` boundary so selection /
  engine-adapter output (and their goldens) stay byte-identical whether or
  not the union is live.

## Payoff — pad role

`ROLE_CONFIG.pad` is repointed from `popStrings` to
`family: 'synths', lowLevels: ['synthsSoftPad', 'synthsBrightPad']`.
`synthsSoftPad` is all brightPop-tagged (54), `synthsBrightPad` all
edm-tagged (19); other genres resolve via the role's any-genre fallback
(the selection default). The engine already keys both lowLevels in its
volume table (`synthsSoftPad` −17 dB / `synthsBrightPad` −21 dB) and family
map (the "synths" FX group); the pad inst's engine `type` is unchanged
(still routes to `Synths.h`), only `lowLevelType` follows the pick.

Verified end-to-end: the brightPop render stages
`synths/synthsSoftPad/synths - synthsSoftPad - brightPop - newLineWaves -
Good.mp3` for the pad lane (no `popStrings` refs), inst `type=synths`,
`lowLevelType=synthsSoftPad`, zero plugin errors, no unrecognised
`lowLevelType` adapter warnings.
