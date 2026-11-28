#!/usr/bin/env node
// Phase 3 step 10 + 12 — brain → engine round-trip CLI.
//
// Thin harness around @casperaki/engine-adapter: orchestrate a canonical brain
// Song, lower it into the legacy engine envelope via toEngineFixture(), and
// write the round-trip artefacts under out/brain-roundtrip/.
//
// All real lowering logic (Phase 2 base envelope + 17-id Drums kit graft,
// chord-progression carry, drum 32nd-note ASCII grids, post-step-12 Bass
// note lowering) lives in packages/engine-adapter — see
// docs/53t-step9-engine-adapter-package.md and
// docs/53w-step12-bass-adapter-render.md. This file is just CLI/FS
// plumbing + the asset-resolver lookup for the brain's selected Bass row.
//
// Output:
//   out/brain-roundtrip/song.json       — legacy engine-envelope shape
//   out/brain-roundtrip/inst-1.json     — full 17-id Drums kit
//   out/brain-roundtrip/inst-2.json     — 16-sample Bass VST kit (when brain emits Bass)
//   out/brain-roundtrip/inst-3.json     — 17-sample Keys VST kit (when brain emits Keys)
//   out/brain-roundtrip/inst-4.json     — 17-sample Pad VST kit  (when brain emits Pad)
//   out/brain-roundtrip/brain-song.json — the canonical Song the brain emitted
//   out/brain-roundtrip/brain-hash.txt  — sha256(canonicalStringifySong)
//
// Run from any cwd:  node apps/engine-spike/scripts/emit-brain-roundtrip.mjs

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRUM_ROLE_FAMILIES,
  drumKit,
  loadValidatedCatalog,
  orchestrate,
  resolveAssetPath,
  songDrumSounds,
} from '@casperaki/arrangement';
import { toEngineFixture } from '@casperaki/engine-adapter';
import { canonicalStringifySong, contentHash, parseSong } from '@casperaki/song-schema';

import { resolveMultisampleSlots } from './lib/multisample-resolver.mjs';
import { readFileSync as _readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// docs/56d — accept an `OUT_DIR` env var so the all-genre matrix
// driver (`scripts/render-all-genres.mjs`) can route each per-genre
// envelope into its own subdirectory under
// `out/all-genre-render-smoke/<genre>/` without trashing the canonical
// `out/brain-roundtrip/` artefacts the existing test suite reads.
// Default unchanged.
const OUT = process.env.OUT_DIR
  ? resolve(process.cwd(), process.env.OUT_DIR)
  : resolve(ROOT, 'out/brain-roundtrip');

// Deterministic case for the slice acceptance criteria in 53-….
// docs/56b — accept a `SEED` env var picking between vertical slices.
// docs/56d — extended to cover every canonical brain genre per
// docs/56c §"Default bpm picks" so the all-genre render smoke
// matrix (apps/engine-spike/scripts/render-all-genres.mjs) can drive
// this same emitter with `SEED=<genre>` and get a per-genre envelope
// pinned to its canonical seed.
//   SEED=brightPop     (or unset)  → brightPop @ C @ 120 bpm (default)
//   SEED=edm                       → edm       @ C @ 128 bpm
//   SEED=ballad                    → ballad    @ C @  75 bpm
//   SEED=latin                     → latin     @ C @ 100 bpm
//   SEED=organicVibes              → organicVibes @ C @ 90 bpm
//   SEED=rock                      → rock      @ C @ 120 bpm
//   SEED=schlager                  → schlager  @ C @ 120 bpm
//   SEED=urban                     → urban     @ C @  90 bpm
//
// The legacy `brightPop-vertical-slice` / `edm-vertical-slice` seeds
// are preserved for the existing 56a/56b artefacts to stay byte-stable.
// Every other genre uses the all-genre-coverage-spec seed
// `<genre>-coverage-smoke` (default per
// packages/arrangement/test/all-genre-coverage.spec.ts).
const SEED_PARAMS = Object.freeze({
  brightPop: Object.freeze({
    genre: 'brightPop',
    key: 'C',
    bpm: 120,
    seed: 'brightPop-vertical-slice',
  }),
  edm: Object.freeze({
    genre: 'edm',
    key: 'C',
    // 128 bpm — canonical EDM tempo. The percussionLoopsElectronic
    // 120-150bpm band has 66 edm-tagged catalog rows at this bpm.
    bpm: 128,
    seed: 'edm-vertical-slice',
  }),
  ballad: Object.freeze({
    genre: 'ballad',
    key: 'C',
    bpm: 75,
    seed: 'ballad-coverage-smoke',
  }),
  latin: Object.freeze({
    genre: 'latin',
    key: 'C',
    bpm: 100,
    seed: 'latin-coverage-smoke',
  }),
  organicVibes: Object.freeze({
    genre: 'organicVibes',
    key: 'C',
    bpm: 90,
    seed: 'organicVibes-coverage-smoke',
  }),
  rock: Object.freeze({
    genre: 'rock',
    key: 'C',
    bpm: 120,
    seed: 'rock-coverage-smoke',
  }),
  schlager: Object.freeze({
    genre: 'schlager',
    key: 'C',
    bpm: 120,
    seed: 'schlager-coverage-smoke',
  }),
  urban: Object.freeze({
    genre: 'urban',
    key: 'C',
    bpm: 90,
    seed: 'urban-coverage-smoke',
  }),
});
// `BRAIN_SONG_FILE` — lower an already-generated canonical Song (the brain's
// per-song render route writes the stored song there) instead of
// orchestrating one of the fixed SEED_PARAMS slices. Edited songs have no
// replayable params, so the file is the only faithful input.
const SONG_FILE = process.env.BRAIN_SONG_FILE;
const SEED_KEY = process.env.SEED && SEED_PARAMS[process.env.SEED] ? process.env.SEED : 'brightPop';
const PARAMS = SEED_PARAMS[SEED_KEY];

const song = SONG_FILE
  ? parseSong(JSON.parse(_readFileSync(resolve(process.cwd(), SONG_FILE), 'utf8')))
  : orchestrate(PARAMS);
const hash = contentHash(song);
console.error(
  SONG_FILE
    ? `[brain] loaded song from ${SONG_FILE} → hash=${hash}`
    : `[brain] orchestrate(${JSON.stringify(PARAMS)}) → hash=${hash}`,
);

// Asset-resolver lookup for the brain-selected Bass / Keys / Pad rows.
// The resolver answers "for the brain's chosen preset, which sample-
// library file should the renderer load at (key=song.key, bpm=song.bpm)?".
// The adapter records the verdict in diagnostics — informational today,
// per docs/53w + 53y (the bundled inst-N.json drives the engine sampler).
let catalog;
try {
  catalog = loadValidatedCatalog();
} catch (err) {
  console.error(`[round-trip] resolver: catalog load failed: ${err?.message ?? String(err)}`);
}

// Core resolver keyed by the brain def's 16-hex catalog id. Both the
// legacy per-family lookup (resolveFamily) and the generic per-lane
// staging path (the `lanes` block below) funnel through here so a
// duplicate-family lane (Synths 2 / Synths 3) and a per-segment add-on
// resolve exactly the way the primary family does — by id, not by a
// hardcoded family name.
function resolveEntryId(entryId, label) {
  try {
    if (!entryId) {
      return { status: 'unresolved', reason: `no catalog id for ${label}` };
    }
    if (!catalog) {
      return { status: 'unresolved', reason: 'validated catalog not loaded', entryId };
    }
    const entry = catalog.byId.get(entryId);
    if (!entry) {
      return {
        status: 'unresolved',
        reason: `brain ${label} id ${entryId} not present in validated catalog`,
        entryId,
      };
    }
    const res = resolveAssetPath({
      entry,
      target: { key: song.key, bpm: song.bpm },
    });
    return res.status === 'resolved'
      ? {
          status: 'resolved',
          relativePath: res.relativePath,
          matchKind: res.matchKind,
          entryId: entry.id,
          family: entry.family,
          lowLevel: entry.lowLevel,
        }
      : {
          status: 'unresolved',
          reason: res.diagnostics?.reason ?? 'unknown',
          entryId: entry.id,
          family: entry.family,
          lowLevel: entry.lowLevel,
        };
  } catch (err) {
    return {
      status: 'unresolved',
      reason: `resolver lookup threw: ${err?.message ?? String(err)}`,
    };
  }
}

function resolveFamily(familyName) {
  const def = (song.instrumentDefinitions ?? []).find((d) => d?.name === familyName);
  if (!def) return undefined;
  return resolveEntryId(def.id, familyName);
}

const bassAssetResolution = resolveFamily('Bass');
const keysAssetResolution = resolveFamily('Keys');
const padAssetResolution = resolveFamily('Pad');
const guitarAssetResolution = resolveFamily('Guitar');
// docs/54z — Synths asset resolution. Brain emits a Synths
// InstrumentDefinition when selection includes the synths role; we
// resolve its catalog row to a disk path the prestage script stages.
const synthsAssetResolution = resolveFamily('Synths');
// docs/55a — PluckedSynths (synths/synthsPlucked) lane.
const pluckedSynthsAssetResolution = resolveFamily('PluckedSynths');

// Drum kit assembly (docs/54j Stage 2). The catalog's `drumKits` sheet
// contributed zero audit-valid rows (53q §"Why drumKits couldn't be
// used"), so we assemble a kit from the per-component catalog families
// (kickDrums / snareDrums / hiHatsClosed / hiHatsOpen / cymbals / toms /
// shakers / clapsSnaps). Each engine `inst-1.json` drum role maps to
// exactly one component family; we pick one validated row per family
// deterministically (style-filtered to song.genre, sorted by id, first
// match wins) and resolve its asset path. Lanes without a family hit
// fall back to bundled fixtures at prestage time.
// The kit pick (role → family, genre default, the song's overrides in
// Drums details.drumSounds) lives in @casperaki/arrangement (drumKit), so
// the editor's drum kit view and this lowering agree.
const DRUM_LANE_FAMILIES = DRUM_ROLE_FAMILIES;

function resolveDrumLane(slot) {
  const { family, entry, overridden } = slot;
  if (!entry) {
    return {
      status: 'unresolved',
      reason: `no validated catalog row for family "${family}" (genre="${song.genre ?? PARAMS.genre}")`,
      family,
    };
  }
  let res;
  try {
    res = resolveAssetPath({ entry, target: { key: song.key, bpm: song.bpm } });
  } catch (err) {
    // A sound the user chose must play: fail the lowering, never swap it.
    if (overridden) throw new Error(`drum ${slot.role}: the chosen sound ${entry.id} could not be resolved: ${err?.message ?? String(err)}`);
    return { status: 'unresolved', family, reason: `resolver lookup threw: ${err?.message ?? String(err)}` };
  }
  if (res.status === 'resolved') {
    return {
      status: 'resolved',
      family,
      relativePath: res.relativePath,
      matchKind: res.matchKind,
      entryId: entry.id,
      lowLevel: entry.lowLevel,
      mainStyle: entry.mainStyle,
      ...(overridden ? { overridden: true } : {}),
    };
  }
  if (overridden) throw new Error(`drum ${slot.role}: the chosen sound ${entry.id} has no file: ${res.diagnostics?.reason ?? 'unknown'}`);
  return { status: 'unresolved', family, reason: res.diagnostics?.reason ?? 'unknown', entryId: entry.id };
}

const drumLanes = {};
for (const slot of drumKit(song.genre ?? PARAMS.genre, songDrumSounds(song))) {
  drumLanes[slot.role] = resolveDrumLane(slot);
}

// docs/54p — transition wiring. Load .env for the sample library root,
// build an ffprobe-backed duration cache, hand both to the adapter.
const ENV_FILE = resolve(__dirname, '../.env');
if (existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(ENV_FILE);
}
const SAMPLE_LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;

const _durationCache = new Map();
function probeDurationByPath(abs, label) {
  if (_durationCache.has(abs)) return _durationCache.get(abs);
  if (!existsSync(abs)) {
    console.error(`[round-trip] ${label}: sample missing on disk: ${abs}`);
    _durationCache.set(abs, null);
    return null;
  }
  try {
    const out = execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const sec = Number.parseFloat(out);
    if (!Number.isFinite(sec) || sec <= 0) {
      console.error(`[round-trip] ${label}: ffprobe gave non-finite duration for ${abs}: "${out}"`);
      _durationCache.set(abs, null);
      return null;
    }
    _durationCache.set(abs, sec);
    return sec;
  } catch (err) {
    console.error(`[round-trip] ${label}: ffprobe failed for ${abs}: ${err?.message ?? String(err)}`);
    _durationCache.set(abs, null);
    return null;
  }
}

// The sound library's fx sheet (fxMetadata.json, beside the instruments folder):
// per file its duration and, for reverses, risers and some hits, its climax
// (where it peaks, in seconds). Transitions take both from here, so a song uses
// what the library records; an fx sample the file does not list is an error.
const FX_METADATA_PATH = SAMPLE_LIBRARY_ROOT ? join(SAMPLE_LIBRARY_ROOT, '..', 'fxMetadata.json') : null;
let _fxMetadata = null;
function fxMetadata() {
  if (_fxMetadata) return _fxMetadata;
  if (!existsSync(FX_METADATA_PATH)) throw new Error(`The sound library has no fx sheet at ${FX_METADATA_PATH} (fxMetadata.json, beside the instruments folder).`);
  const raw = JSON.parse(_readFileSync(FX_METADATA_PATH, 'utf8'));
  _fxMetadata = new Map();
  for (const rows of Object.values(raw)) for (const r of rows) _fxMetadata.set(r.file, r);
  return _fxMetadata;
}

// The sound library's multisample sheet (multisampleMetadata.json, beside the instruments folder): per chromatic
// recording (its path under instruments/) what the slicing must know, e.g. "firstNote" for one that does not start on
// the timing table's first note ("BA Brooks 1" starts on F#: the player shifts its slices; owner 2026-11-28 "offset
// the notes in the player"). A recording it does not list starts where the table does.
const MULTISAMPLE_METADATA_PATH = SAMPLE_LIBRARY_ROOT ? join(SAMPLE_LIBRARY_ROOT, '..', 'multisampleMetadata.json') : null;
let _multisampleMetadata = null;
function multisampleMetadata() {
  if (_multisampleMetadata) return _multisampleMetadata;
  if (!MULTISAMPLE_METADATA_PATH) return (_multisampleMetadata = {});
  if (!existsSync(MULTISAMPLE_METADATA_PATH)) throw new Error(`The sound library has no multisample sheet at ${MULTISAMPLE_METADATA_PATH} (multisampleMetadata.json, beside the instruments folder).`);
  const raw = JSON.parse(_readFileSync(MULTISAMPLE_METADATA_PATH, 'utf8'));
  if (!raw || typeof raw.recordings !== 'object') throw new Error(`${MULTISAMPLE_METADATA_PATH} has no "recordings" object`);
  return (_multisampleMetadata = raw.recordings);
}

function getTransitionSampleDetails(entry) {
  if (!SAMPLE_LIBRARY_ROOT) return null;
  // Disk folder names can differ from the catalog's (e.g. the 8-bit arcade
  // rows live under fx/fxOther): translate like loops do.
  const diskPath = resolveDiskPath(entry.matchedPath);
  if (entry.family === 'fx') {
    const file = diskPath.split('/').pop();
    const row = fxMetadata().get(file);
    if (!row) throw new Error(`The sound library's fx sheet (${FX_METADATA_PATH}) has no row for "${file}" (catalog ${entry.id}).`);
    if (!(row.duration > 0)) throw new Error(`The sound library's fx sheet gives "${file}" no duration.`);
    return { durationSeconds: row.duration, climaxSeconds: typeof row.climax === 'number' ? row.climax : null };
  }
  // Crash cymbals and percussion breaks are not in the fx sheet: their length is the file's.
  const sec = probeDurationByPath(join(SAMPLE_LIBRARY_ROOT, diskPath), 'transition');
  return sec === null ? null : { durationSeconds: sec, climaxSeconds: null };
}

// docs/54r — Catalog-vs-disk lowLevel alias resolver.
//
// The validated catalog stores `matchedPath` using the catalog-
// canonical lowLevel (e.g. `percussionLoopsAcoustic_120-150bpm`).
// On disk, the percussionLoops bpm-bin folders are named differently
// (`_120-160bpm` instead of `_120-150bpm`, `_50-89bpm` instead of
// `_60-89bpm`). The audit's `aliasesApplied` provenance records each
// {catalogLowLevel, diskLowLevel} pair. We load it once at startup and
// apply the reverse-alias (catalog → disk) to both the directory AND
// the embedded basename substring when probing the disk file.
//
// This is a CLI-layer concern, not the brain/adapter contract: brain
// + adapter only ever speak the catalog-canonical name. The path
// translation is here so the engine's renderer can find the bytes.
const _aliasMap = (() => {
  try {
    const auditPath = resolve(__dirname, '../../../packages/arrangement/data/sample-library.audit.json');
    const audit = JSON.parse(_readFileSync(auditPath, 'utf8'));
    const map = new Map();
    for (const a of audit?.LEGACY_PROVENANCE?.aliasesApplied ?? []) {
      // Multiple aliases may share a catalogLowLevel — last write
      // wins, but in practice each pair is 1:1 (catalog vs disk).
      map.set(a.catalogLowLevel, a.diskLowLevel);
    }
    return map;
  } catch (err) {
    console.error(`[round-trip] alias map load failed: ${err?.message ?? String(err)}`);
    return new Map();
  }
})();

function resolveDiskPath(matchedPath) {
  // Translate `family/catalogLowLevel/<basename containing catalogLowLevel>`
  // to `family/diskLowLevel/<basename with diskLowLevel substituted>`.
  // Catalog rows whose lowLevel is NOT aliased return the input
  // unchanged — same code path as today's basses/keys/transitions.
  const parts = matchedPath.split('/');
  if (parts.length < 3) return matchedPath;
  const [family, lowLevel, ...rest] = parts;
  const diskLowLevel = _aliasMap.get(lowLevel);
  if (!diskLowLevel || diskLowLevel === lowLevel) return matchedPath;
  // Substitute the lowLevel token in the basename as well — the disk
  // file embeds the disk lowLevel literally (the legacy librarian
  // baked it into every filename).
  const basenameTranslated = rest.join('/').split(lowLevel).join(diskLowLevel);
  return `${family}/${diskLowLevel}/${basenameTranslated}`;
}

// docs/54r — Loop sample probe. Brain emits the loop pick as an
// InstrumentDefinition with `type: 'percussionLoops'` plus the catalog
// id. We look it up in the validated catalog → matchedPath under the
// sample library root → ffprobed duration. The adapter passes the
// returned `{durationSeconds, sourcePath, reason}` shape through to its
// inst-N.json + diagnostics. Caller-side cache shared with transitions
// (same abs-path key) so a loop and a transition that happen to share
// a source file only probe once.
function loopSampleProbe(def) {
  if (!SAMPLE_LIBRARY_ROOT) {
    return { durationSeconds: null, reason: 'CASPERAKI_SAMPLE_LIBRARY_ROOT not set' };
  }
  if (!catalog) {
    return { durationSeconds: null, reason: 'validated catalog not loaded' };
  }
  const entry = catalog.byId.get(def.id);
  if (!entry) {
    return { durationSeconds: null, reason: `brain Loop id ${def.id} not in validated catalog` };
  }
  // Translate the catalog's canonical path to the disk-truth path
  // using the audit's recorded percussionLoops aliases.
  const diskRelative = resolveDiskPath(entry.matchedPath);
  const abs = join(SAMPLE_LIBRARY_ROOT, diskRelative);
  const sec = probeDurationByPath(abs, 'loop');
  if (sec === null) {
    return {
      durationSeconds: null,
      reason: `ffprobe failed for ${diskRelative} (catalog: ${entry.matchedPath})`,
      sourcePath: diskRelative,
    };
  }
  return { durationSeconds: sec, sourcePath: diskRelative };
}

const fixture = toEngineFixture(song, {
  brainHash: hash,
  generatorParams: PARAMS,
  bassAssetResolution,
  keysAssetResolution,
  padAssetResolution,
  transitionCatalog: catalog,
  getTransitionSampleDetails,
  loopSampleProbe,
  // Sung vocal takes (audioClips lane): where the brain keeps them.
  ...(process.env.CASPERAKI_VOCAL_TAKES_DIR ? { vocalTakesDir: process.env.CASPERAKI_VOCAL_TAKES_DIR } : {}),
});

mkdirSync(OUT, { recursive: true });
// Clear stale inst-*.json from a previous (possibly different) brain run before
// writing the current set. Re-emit never used to clean OUT, so an instrument the
// current seed no longer selects (e.g. a second percussion loop) would orphan a
// file on disk. The engine renderers iterate ALL inst-*.json in the dir, so an
// orphan with a colliding playsample id silently doubled a sample (the ballad
// shaker click). The emit rewrites the full instrument set, so this is safe.
for (const f of readdirSync(OUT)) {
  if (/^inst-\d+\.json$/.test(f)) rmSync(resolve(OUT, f));
}
writeFileSync(resolve(OUT, 'song.json'), JSON.stringify(fixture.songJson, null, 2));
// Transition samples carry the catalog path; point them at the file on disk
// (same catalog → disk folder translation as the duration probe above).
for (const inst of fixture.instruments) {
  if (inst.json?.type === 'transitionSample' && typeof inst.json.sourcePath === 'string') {
    inst.json.sourcePath = resolveDiskPath(inst.json.sourcePath);
  }
}
for (const inst of fixture.instruments) {
  writeFileSync(resolve(OUT, inst.filename), JSON.stringify(inst.json, null, 2));
}
writeFileSync(resolve(OUT, 'brain-song.json'), `${canonicalStringifySong(song, 2)}\n`);
writeFileSync(resolve(OUT, 'brain-hash.txt'), `${hash}\n`);

// Asset manifest — the per-family resolver verdicts in a machine-
// readable form for the prestage script (and any other downstream
// tooling that wants to bridge from "resolver-resolved path" to
// "engine-staged sample"). docs/54h. The shape is stable across runs
// for a stable brain hash + catalog/audit pair, so it can be diffed
// directly. Bass is the first family the prestage script actually
// consumes from this manifest; Keys and Pad are informational only
// until the next slice.
// Per-slot multisample resolution per docs/54l. The resolver is pure
// (no FS) — we run it here so the manifest carries the exact per-slot
// timing the prestage script will use later. If a family's inst-N.json
// isn't emitted (e.g. brain didn't activate that family), the slot
// list is empty.
function attachMultisamplePlan(verdict, instJson) {
  if (!verdict || typeof verdict !== 'object') return verdict;
  const family = verdict.family;
  if (typeof family !== 'string') return verdict;
  const samples = Array.isArray(instJson?.samples) ? instJson.samples : [];
  if (samples.length === 0) return verdict;
  // Read outside the try below: a missing or broken sheet must fail the lowering, not quietly unresolve the slots.
  const firstNote = typeof verdict.relativePath === 'string' ? multisampleMetadata()[verdict.relativePath]?.firstNote : undefined;
  try {
    const res = resolveMultisampleSlots({
      family,
      samples: samples.map((s) => ({ id: s.id, note: s.note, type: s.type })),
      ...(firstNote ? { firstNote } : {}),
    });
    return {
      ...verdict,
      multisample: {
        timingName: res.timingName,
        resolvedCount: res.resolvedCount,
        unresolvedCount: res.unresolvedCount,
        total: res.total,
        reason: res.reason,
        slots: res.slots,
      },
    };
  } catch (err) {
    return {
      ...verdict,
      multisample: {
        timingName: null,
        resolvedCount: 0,
        unresolvedCount: samples.length,
        total: samples.length,
        reason: `multisample-resolver threw: ${err?.message ?? String(err)}`,
        slots: [],
      },
    };
  }
}

const instByFamily = {};
for (const inst of fixture.instruments ?? []) {
  if (inst?.json?.name) instByFamily[inst.json.name] = inst.json;
}
const bassAssetWithSlots = attachMultisamplePlan(bassAssetResolution, instByFamily.Bass);
const keysAssetWithSlots = attachMultisamplePlan(keysAssetResolution, instByFamily.Keys);
const padAssetWithSlots  = attachMultisamplePlan(padAssetResolution,  instByFamily.Pad);
// docs/54z — Synths uses the padAndSynthNotes timing (family-timing-map
// maps `leadSynths` → padAndSynthNotes). The adapter emits the
// dynamic 17-slot Synths inst (type=leadSynths); the resolver looks
// up the catalog row → padAndSynthNotes timing → per-note slots.
const synthsAssetWithSlots = attachMultisamplePlan(synthsAssetResolution, instByFamily.Synths);
// docs/55a — PluckedSynths uses padAndSynthNotes too (family-timing-map
// maps `synths` → padAndSynthNotes). Same shape as Synths.
const pluckedSynthsAssetWithSlots = attachMultisamplePlan(
  pluckedSynthsAssetResolution,
  instByFamily.PluckedSynths,
);
// docs/54s — Guitar uses the same multisample-resolver shape as
// Bass/Keys/Pad (guitarNotes.json maps the 30 slots to chromatic
// note positions). Adapter emits the inst (type=acousticGuitars)
// dynamically; resolver looks up the catalog row → guitarNotes timing.
const guitarAssetWithSlots = attachMultisamplePlan(guitarAssetResolution, instByFamily.Guitar);

// docs/54t — Locate the Default FX sibling row for the brain's
// chosen Guitar preset. The catalog ships four sibling rows per
// preset: Default Chords / Default FX / Default Notes / one
// signature-preset row. Brain selection picks `Default Notes`
// (sliceable via guitarNotes.json); the prestage script needs the
// `Default FX` sibling for the fret-noise pool (sliced equally into
// the adapter's fxFretNoise array).
function resolveGuitarFretNoiseSibling(guitarVerdict, cat) {
  if (!guitarVerdict || guitarVerdict.status !== 'resolved' || !cat) return undefined;
  // The `family` + `lowLevel` of the picked row are echoed on the
  // verdict via attachAssetResolverFamilyHints; fall back to the
  // catalog lookup if absent.
  const entryId = guitarVerdict.entryId;
  const guitarEntry = cat.byId.get(entryId);
  if (!guitarEntry) return undefined;
  const sibling = cat.entries.find(
    (e) =>
      e.family === guitarEntry.family &&
      e.lowLevel === guitarEntry.lowLevel &&
      e.preset === 'Default FX',
  );
  if (!sibling) return undefined;
  return {
    catalogId: sibling.id,
    family: sibling.family,
    lowLevel: sibling.lowLevel,
    relativePath: sibling.matchedPath,
  };
}
const guitarFretNoiseSibling = resolveGuitarFretNoiseSibling(guitarAssetResolution, catalog);

// docs/54v — Locate the picked Guitar preset's `chords/` subfolder
// (1727 pre-rendered `<chord>_Pos<N>_<Long|Short>Strum<Down|Up>.mp3`
// files per preset). The folder sits directly beside the preset's
// MP3 file under
// `<library>/<family>/<lowLevel>/chords/`. We compute the absolute
// path here so the prestage script can read it from the asset
// manifest without re-doing the catalog lookup.
function resolveGuitarChordsDir(guitarVerdict, libraryRoot) {
  if (!guitarVerdict || guitarVerdict.status !== 'resolved' || !libraryRoot) return undefined;
  const rel = guitarVerdict.relativePath;
  if (typeof rel !== 'string' || rel.length === 0) return undefined;
  // Preset MP3 path → preset MP3 directory → /chords subfolder.
  const presetDir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : rel;
  return join(libraryRoot, presetDir, 'chords');
}
// docs/54y — `<preset>/fx/<fx1..fx7>.mp3` sibling of `<preset>/chords/`.
function resolveGuitarFxDir(guitarVerdict, libraryRoot) {
  if (!guitarVerdict || guitarVerdict.status !== 'resolved' || !libraryRoot) return undefined;
  const rel = guitarVerdict.relativePath;
  if (typeof rel !== 'string' || rel.length === 0) return undefined;
  const presetDir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : rel;
  return join(libraryRoot, presetDir, 'fx');
}
const guitarChordsAbsDir = resolveGuitarChordsDir(guitarAssetResolution, SAMPLE_LIBRARY_ROOT);
const guitarFxAbsDir = resolveGuitarFxDir(guitarAssetResolution, SAMPLE_LIBRARY_ROOT);

// docs/57e — Generic per-lane resolution. The legacy top-level keys
// (Bass/Keys/Pad/Synths/PluckedSynths/Guitar) resolve exactly one lane
// per fixed family name, so duplicate-family lanes (Synths 2, Synths 3)
// and per-segment add-on lanes were never resolved and rendered silent.
// We now walk EVERY emitted tonal inst (anything carrying a `samples[]`
// multisample array) and resolve its catalog row by the inst's
// `catalogId` (the brain def's 16-hex id) — falling back to the brain
// def lookup by name for the legacy Bass/Keys/Pad wrappers, which reuse
// the Phase-2 envelope and carry no `catalogId`. Each lane block carries
// the same {verdict + multisample plan} shape the top-level keys do,
// keyed by the lane display name. The prestage script stages every lane
// from this map, so duplicates get their own sliced samples.
function laneCatalogId(instJson) {
  if (typeof instJson?.catalogId === 'string' && instJson.catalogId) {
    return instJson.catalogId;
  }
  const def = (song.instrumentDefinitions ?? []).find((d) => d?.name === instJson?.name);
  return def?.id;
}

const lanes = {};
for (const inst of fixture.instruments ?? []) {
  const j = inst?.json;
  // Tonal multisample lanes only — drums (ids/subInstruments, no
  // samples[]), transitions + loops (sourcePath, no samples[]) and the
  // un-lowered Vocal family are all excluded by this guard.
  if (!j || !Array.isArray(j.samples) || j.samples.length === 0) continue;
  const laneName = typeof j.name === 'string' ? j.name : undefined;
  if (!laneName) continue;
  const verdict = resolveEntryId(laneCatalogId(j), laneName) ?? {
    status: 'unresolved',
    reason: `no brain definition for lane ${laneName}`,
  };
  const withSlots = attachMultisamplePlan(verdict, j) ?? verdict;
  // Guitar's add-on pools (fret noise + chord strums) hang off the
  // guitar lane the same way they hang off the top-level Guitar key.
  if (laneName === 'Guitar') {
    withSlots.fretNoiseSibling = resolveGuitarFretNoiseSibling(verdict, catalog) ?? null;
    withSlots.chordsAbsDir = resolveGuitarChordsDir(verdict, SAMPLE_LIBRARY_ROOT) ?? null;
    withSlots.fxAbsDir = resolveGuitarFxDir(verdict, SAMPLE_LIBRARY_ROOT) ?? null;
  }
  lanes[laneName] = withSlots;
}

const assetManifest = {
  generatedBy: 'emit-brain-roundtrip.mjs',
  brainHash: hash,
  generatorParams: PARAMS,
  Bass: bassAssetWithSlots ?? { status: 'unresolved', reason: 'no brain Bass definition' },
  Keys: keysAssetWithSlots ?? { status: 'unresolved', reason: 'no brain Keys definition' },
  Pad:  padAssetWithSlots  ?? { status: 'unresolved', reason: 'no brain Pad definition' },
  Synths: synthsAssetWithSlots ?? { status: 'unresolved', reason: 'no brain Synths definition' },
  PluckedSynths: pluckedSynthsAssetWithSlots ?? { status: 'unresolved', reason: 'no brain PluckedSynths definition' },
  Guitar: guitarAssetWithSlots
    ? {
        ...guitarAssetWithSlots,
        fretNoiseSibling: guitarFretNoiseSibling ?? null,
        chordsAbsDir: guitarChordsAbsDir ?? null,
        fxAbsDir: guitarFxAbsDir ?? null,
      }
    : { status: 'unresolved', reason: 'no brain Guitar definition' },
  // Per-lane catalog-bridged kit assembly. The prestage script reads
  // this block lane-by-lane to bridge the engine's playsample-<id>.ogg
  // slots to the per-component family resolver verdicts.
  Drums: {
    laneFamilyMap: DRUM_LANE_FAMILIES,
    lanes: drumLanes,
  },
  // Generic per-lane resolution keyed by lane display name. Covers
  // every tonal lane the adapter emits — including duplicate-family
  // lanes (Synths 2, Synths 3) and per-segment add-ons the fixed
  // top-level keys above can't represent. The prestage script stages
  // from this map. docs/57e.
  lanes,
};
writeFileSync(
  resolve(OUT, 'asset-manifest.json'),
  `${JSON.stringify(assetManifest, null, 2)}\n`,
);

console.error(`[round-trip] wrote ${OUT}`);
console.error(`[round-trip] asset-manifest.json:`);
for (const family of ['Bass', 'Keys', 'Pad', 'Synths', 'PluckedSynths', 'Guitar']) {
  const v = assetManifest[family];
  if (v?.status === 'resolved') {
    console.error(
      `              ${family.padEnd(5)} resolved (${v.matchKind ?? '?'}) ${v.relativePath} (#${v.entryId ?? '?'})`,
    );
  } else {
    console.error(
      `              ${family.padEnd(5)} ${v?.status ?? '?'}: ${v?.reason ?? '—'}`,
    );
  }
}
// Per-lane summary — the load-bearing addition for 57e: duplicate and
// add-on lanes that the fixed top-level keys above can't show.
const laneNames = Object.keys(lanes);
const laneResolved = laneNames.filter((n) => lanes[n]?.status === 'resolved').length;
console.error(
  `              lanes ${laneResolved}/${laneNames.length} tonal lanes resolved`,
);
for (const name of laneNames) {
  const v = lanes[name];
  const slotInfo = v?.multisample
    ? ` [${v.multisample.timingName ?? '<none>'} ${v.multisample.resolvedCount}/${v.multisample.total}]`
    : '';
  if (v?.status === 'resolved') {
    console.error(
      `                ${name.padEnd(16)} resolved (${v.matchKind ?? '?'}) ${v.relativePath} (#${v.entryId ?? '?'})${slotInfo}`,
    );
  } else {
    console.error(
      `                ${name.padEnd(16)} ${v?.status ?? '?'}: ${v?.reason ?? '—'}${slotInfo}`,
    );
  }
}
let drumResolvedCount = 0;
let drumUnresolvedCount = 0;
for (const [role, v] of Object.entries(drumLanes)) {
  if (v?.status === 'resolved') drumResolvedCount++;
  else drumUnresolvedCount++;
}
console.error(
  `              Drums ${drumResolvedCount}/${drumResolvedCount + drumUnresolvedCount} lanes resolved`,
);
for (const [role, v] of Object.entries(drumLanes)) {
  if (v?.status === 'resolved') {
    console.error(
      `                ${role.padEnd(14)} resolved (${v.matchKind ?? '?'}) ${v.relativePath} (#${v.entryId ?? '?'} family=${v.family})`,
    );
  } else {
    console.error(
      `                ${role.padEnd(14)} ${v?.status ?? '?'} (family=${v?.family ?? '?'}): ${v?.reason ?? '—'}`,
    );
  }
}
const envelope = fixture.songJson;
const totalBars = envelope.structure.reduce((n, s) => n + (s.bars?.length ?? 0), 0);
console.error(
  `[round-trip] structure: ${envelope.structure.length} segments / ${totalBars} bars (≈${(
    (totalBars * 4 * 60) /
    envelope.tempo
  ).toFixed(1)}s @${envelope.tempo}bpm)`,
);
for (const segEntry of envelope.structure) {
  const ar = envelope.arrangement[segEntry.segment] ?? {};
  const active = Object.entries(ar.instruments ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.error(
    `              ${segEntry.segment.padEnd(11)} ${String(segEntry.bars?.length ?? 0).padStart(
      2,
    )}b  [${active.join('+') || 'silent'}]`,
  );
}
// Show one drum-pattern snapshot from the first segment that has Drums active.
const drumSeg = envelope.structure.find(
  (s) => envelope.arrangement[s.segment]?.overrides?.Drums,
);
if (drumSeg) {
  const drumOverride = envelope.arrangement[drumSeg.segment].overrides.Drums;
  console.error(`[round-trip] drum pattern (${drumSeg.segment}):`);
  for (const [k, v] of Object.entries(drumOverride.pattern ?? {})) {
    console.error(`              ${k.padEnd(14)} ${v}`);
  }
}
if (fixture.diagnostics.length > 0) {
  console.error(`[round-trip] adapter diagnostics:`);
  for (const d of fixture.diagnostics) {
    console.error(`              [${d.severity}] ${d.path}: ${d.message}`);
  }
}
