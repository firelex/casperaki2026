// Per-slot multisample staging — docs/54l.
//
// Generalises stage-bass.mjs / stage-tonal.mjs (54i / 54j). Instead of
// copying one source into all N vstsample-<id>.ogg slots (which
// destroys chord motion — see docs/54k Hypothesis 4 FFT evidence), this
// helper slices the catalog's canonical preset MP3 into per-slot pieces
// using the legacy mp3split timings (docs/54l), normalises each through
// ffmpeg, and stages one distinct slice per slot.
//
// Decision policy:
//   1. If the asset-manifest has a `resolved` family verdict + the
//      multisample resolver produced per-slot timings:
//        → slice + stage. Each slot gets its own audio.
//   2. If the resolver returns no timing for the family (e.g. the
//      family isn't in family-timing-map.json):
//        → fall back to fixture per-slot (bundled `bass-c2.ogg` for
//          basses, `tone.ogg` for keys/pad/etc). Logs say "fixture
//          fallback — family has no timing JSON".
//   3. If the manifest is unresolved (no library path / no env var):
//        → fixture fallback per-slot. Same as above.
//   4. If a slot's resolver verdict is `unresolved` (no timing entry
//      for its (note, type)):
//        → fixture fallback for THAT slot only.
//   5. If ffmpeg is missing AND a slice is needed:
//        → fixture fallback per-slot.
//
// NEVER copies the same real-catalog source into multiple slots — the
// brief is explicit: do not duplicate one file across all slots.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { prepareNormalizedSource, formatNormalizationLog } from './audio-normalize.mjs';
import { prepareNormalizedSlice, formatSliceLog } from './audio-slice.mjs';
import { resolveMultisampleSlots } from './multisample-resolver.mjs';

/**
 * @typedef {{
 *   slotId: number;
 *   slotNote: string;
 *   slotType: string;
 *   kind: 'real-slice' | 'fixture-fallback' | 'skip';
 *   sliceStart?: number;
 *   sliceEnd?: number;
 *   sourcePath?: string;
 *   stagedSourcePath?: string;
 *   fallbackReason?: string;
 * }} SlotStageRecord
 */

/**
 * @typedef {{
 *   family: string;
 *   timingName: string | null;
 *   staged: number;
 *   realSliceCount: number;
 *   fixtureFallbackCount: number;
 *   logs: string[];
 *   slots: SlotStageRecord[];
 * }} StageMultisampleResult
 */

/**
 * @param {{
 *   family: string;
 *   instPath: string;
 *   manifestPath: string;
 *   sampleLibraryRoot: string | undefined;
 *   fixtureSamplesDir: string;
 *   fixtureRel: string;
 *   tempDir: string;
 *   normalizeCacheDir: string;
 *   log?: (m: string) => void;
 *   prepareNormalized?: typeof prepareNormalizedSource;
 *   prepareSlice?: typeof prepareNormalizedSlice;
 *   resolveSlots?: typeof resolveMultisampleSlots;
 *   copyFile?: (src: string, dst: string) => void;
 *   fileExists?: (path: string) => boolean;
 *   readFile?: (path: string) => string;
 * }} opts
 * @returns {StageMultisampleResult}
 */
export function stageMultisampleFamily(opts) {
  const {
    family,
    instPath,
    manifestPath,
    sampleLibraryRoot,
    fixtureSamplesDir,
    fixtureRel,
    tempDir,
    normalizeCacheDir,
    log = (m) => console.error(m),
    prepareNormalized = prepareNormalizedSource,
    prepareSlice = prepareNormalizedSlice,
    resolveSlots = resolveMultisampleSlots,
    copyFile = copyFileSync,
    fileExists = existsSync,
    readFile = (p) => readFileSync(p, 'utf-8'),
  } = opts;

  /** @type {string[]} */
  const logs = [];
  const emit = (m) => { logs.push(m); log(m); };

  const tag = family.toLowerCase();
  /** @type {SlotStageRecord[]} */
  const slotRecords = [];

  if (!fileExists(instPath)) {
    emit(`[prestage] ${tag} inst missing at ${instPath} — skipping ${family}`);
    return {
      family, timingName: null,
      staged: 0, realSliceCount: 0, fixtureFallbackCount: 0,
      logs, slots: [],
    };
  }
  const inst = JSON.parse(readFile(instPath));
  const samples = Array.isArray(inst?.samples) ? inst.samples : [];

  // Read manifest once: we need `relativePath` for the canonical source
  // AND the catalog `family` (e.g. "basses" / "keys" / "popStrings") so
  // the resolver picks the right timing JSON. Display family (Bass /
  // Keys / Pad) doesn't match the catalog's lowercase family enum.
  const manifestEntry = readManifestEntry({
    manifestPath, family, fileExists, readFile, emit,
  });
  const catalogFamily = manifestEntry?.family ?? null;

  // ---- Decide the per-slot resolution shape -----------------------------
  // 1) Per-slot resolver (always runs — pure, no FS).
  let resolution;
  try {
    resolution = resolveSlots({
      family: catalogFamily ?? family,
      samples: samples.map((s) => ({ id: s.id, note: s.note, type: s.type })),
    });
  } catch (err) {
    // Fall back gracefully — treat as "no timing".
    resolution = {
      family,
      timingName: null,
      timingPath: null,
      resolvedCount: 0,
      unresolvedCount: samples.length,
      total: samples.length,
      slots: samples.map((s) => ({
        slot: { id: s.id, note: s.note, type: s.type },
        status: 'unresolved',
        reason: `resolver threw: ${err?.message ?? String(err)}`,
      })),
      reason: `resolver threw: ${err?.message ?? String(err)}`,
    };
  }

  // Canonical source path from the same manifest entry.
  const canonicalRel =
    manifestEntry?.status === 'resolved' && typeof manifestEntry.relativePath === 'string'
      ? manifestEntry.relativePath
      : undefined;
  const sampleLibraryAbs = sampleLibraryRoot
    ? (isAbsolute(sampleLibraryRoot) ? sampleLibraryRoot : resolvePath(sampleLibraryRoot))
    : undefined;
  const canonicalAbs =
    canonicalRel && sampleLibraryAbs ? resolvePath(sampleLibraryAbs, canonicalRel) : undefined;
  const canonicalAvailable = canonicalAbs ? fileExists(canonicalAbs) : false;

  emit(
    `[prestage] ${tag} multisample plan: timing=${resolution.timingName ?? '<none>'} ` +
    `slots=${resolution.total} (resolved=${resolution.resolvedCount} unresolved=${resolution.unresolvedCount}) ` +
    `canonical=${canonicalAvailable ? canonicalAbs : '<missing/unresolved>'}`,
  );
  if (resolution.reason) {
    emit(`[prestage]   ${tag} family-level reason: ${resolution.reason}`);
  }

  // Fixture fallback per slot — always available as a last resort.
  const fixturePath = resolvePath(fixtureSamplesDir, fixtureRel);
  const fixtureAvailable = fileExists(fixturePath);
  if (!fixtureAvailable) {
    emit(`[prestage]   ${tag} fixture-fallback file ${fixturePath} missing — slots without a real slice will be skipped`);
  }

  // Pre-normalise the fixture once (copy branch — it's already .ogg/.wav).
  let normalizedFixture;
  if (fixtureAvailable) {
    normalizedFixture = prepareNormalized({ sourcePath: fixturePath, cacheDir: normalizeCacheDir });
    if (normalizedFixture.kind === 'copy' || normalizedFixture.kind === 'transcoded') {
      emit(formatNormalizationLog(normalizedFixture, fixturePath));
    } else {
      emit(formatNormalizationLog(normalizedFixture, fixturePath));
      normalizedFixture = undefined;
    }
  }

  let staged = 0;
  let realSliceCount = 0;
  let fixtureFallbackCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const slotRes = resolution.slots[i];
    const dst = join(tempDir, `vstsample-${s.id}.ogg`);
    const slotMeta = { slotId: s.id, slotNote: s.note, slotType: s.type };

    // Path A: per-slot real slice.
    if (
      slotRes?.status === 'resolved' &&
      canonicalAvailable &&
      canonicalAbs
    ) {
      const slice = prepareSlice({
        sourcePath: canonicalAbs,
        sliceStart: slotRes.sliceStart,
        sliceEnd: slotRes.sliceEnd,
        cacheDir: normalizeCacheDir,
      });
      emit(formatSliceLog(slice, canonicalAbs, slotRes.sliceStart, slotRes.sliceEnd));
      if (slice.kind === 'transcoded') {
        copyFile(slice.preparedPath, dst);
        emit(
          `[prestage] ${tag}#${s.id} (${s.type} ${s.note}) ← real slice ` +
          `[${slotRes.sliceStart.toFixed(2)}-${slotRes.sliceEnd.toFixed(2)}]s of ${basenameOf(canonicalAbs)} → ${dst}`,
        );
        slotRecords.push({
          ...slotMeta,
          kind: 'real-slice',
          sliceStart: slotRes.sliceStart,
          sliceEnd: slotRes.sliceEnd,
          sourcePath: canonicalAbs,
          stagedSourcePath: slice.preparedPath,
        });
        realSliceCount++; staged++;
        continue;
      }
      // Slice failed (no-ffmpeg / error). Fall through to fixture fallback,
      // tagged with the slice failure reason for diagnostics.
      slotMeta.fallbackReason = `slice failed (${slice.kind}: ${'error' in slice ? slice.error : '<unknown>'})`;
    } else {
      // Determine the precise reason for the fixture fallback.
      if (!canonicalAvailable) {
        slotMeta.fallbackReason = canonicalAbs
          ? `canonical source missing on disk: ${canonicalAbs}`
          : (sampleLibraryAbs
              ? `${family} manifest entry unresolved (no relativePath)`
              : 'CASPERAKI_SAMPLE_LIBRARY_ROOT not set');
      } else if (slotRes?.status !== 'resolved') {
        slotMeta.fallbackReason = `slot unresolved: ${slotRes?.reason ?? 'unknown'}`;
      } else {
        slotMeta.fallbackReason = 'unknown';
      }
    }

    // Path B: fixture fallback per slot.
    if (normalizedFixture?.kind === 'copy' || normalizedFixture?.kind === 'transcoded') {
      copyFile(normalizedFixture.preparedPath, dst);
      emit(
        `[prestage] ${tag}#${s.id} (${s.type} ${s.note}) ← fixture (${fixtureRel}) → ${dst}` +
        ` — ${slotMeta.fallbackReason}`,
      );
      slotRecords.push({
        ...slotMeta,
        kind: 'fixture-fallback',
        sourcePath: fixturePath,
        stagedSourcePath: normalizedFixture.preparedPath,
      });
      fixtureFallbackCount++; staged++;
      continue;
    }

    // Path C: nothing to stage. Log + skip.
    emit(
      `[prestage] ${tag}#${s.id} (${s.type} ${s.note}) SKIP — ${slotMeta.fallbackReason}` +
      `; fixture also unavailable (${fixturePath})`,
    );
    slotRecords.push({ ...slotMeta, kind: 'skip' });
  }

  emit(
    `[prestage] ${tag} multisample summary: ` +
    `${realSliceCount}/${samples.length} slots from real slices, ` +
    `${fixtureFallbackCount}/${samples.length} slots from fixture fallback, ` +
    `${samples.length - realSliceCount - fixtureFallbackCount} skipped`,
  );

  return {
    family,
    timingName: resolution.timingName,
    staged,
    realSliceCount,
    fixtureFallbackCount,
    logs,
    slots: slotRecords,
  };
}

/**
 * Read the full `manifest[family]` entry — returns its `family`,
 * `relativePath`, `status`, `entryId`, etc. or undefined when missing
 * / unparseable.
 *
 * @param {{
 *   manifestPath: string;
 *   family: string;
 *   fileExists: (p: string) => boolean;
 *   readFile: (p: string) => string;
 *   emit: (m: string) => void;
 * }} args
 * @returns {Record<string, unknown> | undefined}
 */
function readManifestEntry({ manifestPath, family, fileExists, readFile, emit }) {
  if (!fileExists(manifestPath)) {
    emit(`[prestage]   ${family.toLowerCase()} manifest missing at ${manifestPath} — fixture fallback for all slots`);
    return undefined;
  }
  try {
    const manifest = JSON.parse(readFile(manifestPath));
    // docs/57e — prefer the generic per-lane block (`manifest.lanes[name]`),
    // which covers duplicate-family lanes (Synths 2 / Synths 3) and
    // add-ons the fixed top-level keys can't represent. Fall back to the
    // legacy top-level family key for back-compat (and the hermetic
    // stage-multisample specs, which write only `manifest[family]`).
    const lane = manifest?.lanes && typeof manifest.lanes === 'object'
      ? manifest.lanes[family]
      : undefined;
    const entry = lane ?? (manifest && typeof manifest === 'object' ? manifest[family] : undefined);
    if (!entry || typeof entry !== 'object') {
      emit(`[prestage]   ${family.toLowerCase()} manifest has no ${family} lane/entry`);
      return undefined;
    }
    return entry;
  } catch (err) {
    emit(`[prestage]   ${family.toLowerCase()} manifest parse failed: ${err?.message ?? String(err)}`);
    return undefined;
  }
}

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
