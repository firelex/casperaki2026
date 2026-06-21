// Drum-kit staging — docs/54j Stage 2.
//
// Bridges the catalog-driven drum kit assembly (from emit-brain-roundtrip's
// `Drums` asset-manifest block) to the engine's 17-id playsample-<id>.ogg
// slots in the JUCE temp dir. Each lane in `inst-1.json#ids` is resolved
// via:
//
//   1. `asset-manifest.json#Drums.lanes.<role>` → catalog-bridged path
//      (the resolver picked one validated row from the lane's component
//      family — kickDrums / snareDrums / hiHatsClosed / hiHatsOpen /
//      cymbals / toms / shakers / clapsSnaps).
//   2. Bundled fixture fallback per role (kick.ogg / snare.ogg / hat.ogg
//      / tone.ogg).
//
// Real-sample sources are normalised through ffmpeg first (docs/54i) so
// the engine's JUCE AudioFormatManager always sees a real Ogg-Vorbis
// file under the `playsample-<id>.ogg` slot. The bundled fixtures are
// already .ogg/wav so they normalise trivially (copy branch).
//
// Per-lane logging makes it obvious — at staging time — which lanes
// are real-catalog samples and which are fixture-fallback.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  formatNormalizationLog,
  prepareNormalizedSource,
} from './audio-normalize.mjs';

/**
 * @typedef {{
 *   role: string;
 *   id: number;
 *   kind: 'real-drum-sample' | 'fixture-drum-sample' | 'no-source';
 *   family?: string;
 *   sourcePath?: string;
 *   relativePath?: string;
 *   entryId?: string;
 *   fallbackReason?: string;
 *   normalizationKind?: 'copy' | 'transcoded' | 'no-ffmpeg' | 'error';
 *   stagedSourcePath?: string;
 * }} DrumLaneResult
 */

/**
 * @typedef {{
 *   staged: number;
 *   lanes: DrumLaneResult[];
 *   logs: string[];
 *   realLaneCount: number;
 *   fixtureLaneCount: number;
 * }} StageDrumKitResult
 */

/**
 * @param {{
 *   instPath: string;
 *   manifestPath: string;
 *   sampleLibraryRoot: string | undefined;
 *   fixtureSamplesDir: string;
 *   tempDir: string;
 *   normalizeCacheDir: string;
 *   roleToFixture: Record<string, string>;
 *   log?: (message: string) => void;
 *   prepareNormalized?: typeof prepareNormalizedSource;
 *   copyFile?: (src: string, dst: string) => void;
 *   fileExists?: (path: string) => boolean;
 *   readFile?: (path: string) => string;
 * }} opts
 * @returns {StageDrumKitResult}
 */
export function stageDrumKit(opts) {
  const {
    instPath,
    manifestPath,
    sampleLibraryRoot,
    fixtureSamplesDir,
    tempDir,
    normalizeCacheDir,
    roleToFixture,
    log = (m) => console.error(m),
    prepareNormalized = prepareNormalizedSource,
    copyFile = copyFileSync,
    fileExists = existsSync,
    readFile = (p) => readFileSync(p, 'utf-8'),
  } = opts;

  /** @type {string[]} */
  const logs = [];
  const emit = (m) => {
    logs.push(m);
    log(m);
  };

  if (!fileExists(instPath)) {
    emit('[prestage] drums inst-1.json missing — skipping drum kit staging');
    return { staged: 0, lanes: [], logs, realLaneCount: 0, fixtureLaneCount: 0 };
  }
  const inst = JSON.parse(readFile(instPath));
  const ids = /** @type {Record<string, number>} */ (inst.ids ?? {});

  // Try to load Drums.lanes block from manifest; absent/unparsable is fine
  // (we just use fixture fallbacks for every lane and log the reason).
  const drumsBlock = readDrumsManifestBlock({
    manifestPath,
    fileExists,
    readFile,
    emit,
  });

  const rootAbs = sampleLibraryRoot
    ? isAbsolute(sampleLibraryRoot)
      ? sampleLibraryRoot
      : resolvePath(sampleLibraryRoot)
    : undefined;

  /** @type {DrumLaneResult[]} */
  const lanes = [];
  let staged = 0;
  let realLaneCount = 0;
  let fixtureLaneCount = 0;

  for (const [role, id] of Object.entries(ids)) {
    const dst = join(tempDir, `playsample-${id}.ogg`);
    const laneVerdict = drumsBlock?.lanes?.[role];
    const fallbackFixtureRel = roleToFixture[role] ?? 'tone.ogg';
    const fixturePath = resolvePath(fixtureSamplesDir, fallbackFixtureRel);

    let chosenSource = undefined;
    let chosenKind = /** @type {DrumLaneResult['kind']} */ ('fixture-drum-sample');
    let fallbackReason;
    let resolvedRel;
    let resolvedEntryId;
    let family = laneVerdict?.family;

    if (
      laneVerdict?.status === 'resolved' &&
      rootAbs &&
      typeof laneVerdict.relativePath === 'string' &&
      laneVerdict.relativePath.length > 0
    ) {
      const realPath = resolvePath(rootAbs, laneVerdict.relativePath);
      if (fileExists(realPath)) {
        chosenSource = realPath;
        chosenKind = 'real-drum-sample';
        resolvedRel = laneVerdict.relativePath;
        resolvedEntryId = laneVerdict.entryId;
      } else {
        fallbackReason = `resolved ${role} sample not on disk: ${realPath}`;
      }
    } else if (laneVerdict?.status === 'unresolved') {
      fallbackReason = `${role} unresolved: ${laneVerdict.reason ?? 'no reason recorded'}`;
    } else if (!laneVerdict) {
      fallbackReason = `no manifest verdict for ${role}`;
    } else if (!rootAbs) {
      fallbackReason = 'CASPERAKI_SAMPLE_LIBRARY_ROOT not set';
    }

    if (!chosenSource) {
      if (fileExists(fixturePath)) {
        chosenSource = fixturePath;
        chosenKind = 'fixture-drum-sample';
      } else {
        emit(
          `[prestage] drums ${role}#${id}: no source available (fixture ${fixturePath} missing); skipping`,
        );
        lanes.push({
          role,
          id,
          kind: 'no-source',
          family,
          fallbackReason: `${fallbackReason ?? 'unknown'}; fixture ${fixturePath} also missing`,
        });
        continue;
      }
    }

    let normalized = prepareNormalized({
      sourcePath: chosenSource,
      cacheDir: normalizeCacheDir,
    });
    emit(formatNormalizationLog(normalized, chosenSource));

    if (normalized.kind === 'no-ffmpeg' || normalized.kind === 'error') {
      if (chosenKind === 'real-drum-sample' && fileExists(fixturePath)) {
        emit(
          `[prestage]   real-${role}-sample normalisation failed; falling back to fixture (${fixturePath})`,
        );
        normalized = prepareNormalized({
          sourcePath: fixturePath,
          cacheDir: normalizeCacheDir,
        });
        emit(formatNormalizationLog(normalized, fixturePath));
        chosenKind = 'fixture-drum-sample';
        chosenSource = fixturePath;
      }
    }
    if (normalized.kind === 'no-ffmpeg' || normalized.kind === 'error') {
      emit(
        `[prestage]   no decodable ${role} source after normalisation; skipping ${role}`,
      );
      lanes.push({
        role,
        id,
        kind: 'no-source',
        family,
        fallbackReason: `normalisation failed: ${normalized.error ?? '<no error>'}`,
      });
      continue;
    }

    copyFile(normalized.preparedPath, dst);
    const stagedDesc =
      chosenKind === 'real-drum-sample'
        ? `real catalog sample (${resolvedRel}${family ? `, family=${family}` : ''})`
        : `fixture (${fallbackFixtureRel})${fallbackReason ? ` — ${fallbackReason}` : ''}`;
    emit(
      `[prestage] drums ${role}#${id} ← ${stagedDesc} → ${dst}`,
    );

    if (chosenKind === 'real-drum-sample') realLaneCount++;
    else fixtureLaneCount++;
    staged++;
    lanes.push({
      role,
      id,
      kind: chosenKind,
      family,
      sourcePath: chosenSource,
      relativePath: resolvedRel,
      entryId: resolvedEntryId,
      fallbackReason: chosenKind === 'fixture-drum-sample' ? fallbackReason : undefined,
      normalizationKind: normalized.kind,
      stagedSourcePath: normalized.preparedPath,
    });
  }

  emit(
    `[prestage] drum kit summary: ${realLaneCount}/${realLaneCount + fixtureLaneCount} lanes from real catalog samples, ${fixtureLaneCount} lanes from bundled fixtures`,
  );
  return { staged, lanes, logs, realLaneCount, fixtureLaneCount };
}

/**
 * @param {{
 *   manifestPath: string;
 *   fileExists: (path: string) => boolean;
 *   readFile: (path: string) => string;
 *   emit: (message: string) => void;
 * }} opts
 */
function readDrumsManifestBlock({ manifestPath, fileExists, readFile, emit }) {
  if (!fileExists(manifestPath)) {
    emit(`[prestage] drums: asset-manifest.json missing at ${manifestPath}`);
    return undefined;
  }
  try {
    const manifest = JSON.parse(readFile(manifestPath));
    if (!manifest || typeof manifest !== 'object') return undefined;
    const drums = manifest.Drums;
    if (!drums || typeof drums !== 'object') {
      emit('[prestage] drums: asset-manifest.json has no Drums block');
      return undefined;
    }
    return drums;
  } catch (err) {
    emit(
      `[prestage] drums: asset-manifest.json failed to parse: ${err?.message ?? String(err)}`,
    );
    return undefined;
  }
}
