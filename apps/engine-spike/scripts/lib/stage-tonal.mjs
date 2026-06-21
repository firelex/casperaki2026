// Tonal-family staging — generalised from stage-bass.mjs (docs/54i).
//
// Orchestrates per-family:
//   1. `decideTonalSource` (docs/54j) — pick real vs. fixture source
//   2. `prepareNormalizedSource` (docs/54i) — copy or ffmpeg-transcode
//   3. write the normalised bytes over every `vstsample-<id>.ogg`
//
// Each family supplies its own fixture filename and asset-manifest key
// via a small config object; the rest is shared with Bass.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  decideTonalSource,
  formatTonalStageDecisionLabel,
} from './tonal-asset-bridge.mjs';
import {
  formatNormalizationLog,
  prepareNormalizedSource,
} from './audio-normalize.mjs';

/**
 * @typedef {{
 *   staged: number;
 *   family: string;
 *   decisionKind: 'real-tonal-sample' | 'fixture-tonal-sample' | 'no-source' | 'no-inst';
 *   normalizationKind: 'copy' | 'transcoded' | 'no-ffmpeg' | 'error' | 'none';
 *   stagedSourcePath: string | undefined;
 *   transcodedReal: boolean;
 *   logs: string[];
 * }} StageTonalResult
 */

/**
 * @param {{
 *   family: 'Bass' | 'Keys' | 'Pad' | string;
 *   fixtureRel: string;
 *   instPath: string;
 *   manifestPath: string;
 *   sampleLibraryRoot: string | undefined;
 *   fixtureSamplesDir: string;
 *   tempDir: string;
 *   normalizeCacheDir: string;
 *   log?: (message: string) => void;
 *   prepareNormalized?: typeof prepareNormalizedSource;
 *   copyFile?: (src: string, dst: string) => void;
 *   fileExists?: (path: string) => boolean;
 *   readFile?: (path: string) => string;
 * }} opts
 * @returns {StageTonalResult}
 */
export function stageTonalFamilyWithBridge(opts) {
  const {
    family,
    fixtureRel,
    instPath,
    manifestPath,
    sampleLibraryRoot,
    fixtureSamplesDir,
    tempDir,
    normalizeCacheDir,
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

  const tag = family.toLowerCase();

  if (!fileExists(instPath)) {
    return {
      staged: 0,
      family,
      decisionKind: 'no-inst',
      normalizationKind: 'none',
      stagedSourcePath: undefined,
      transcodedReal: false,
      logs,
    };
  }
  const inst = JSON.parse(readFile(instPath));
  const decision = decideTonalSource({
    family,
    fixtureRel,
    sampleLibraryRoot,
    manifestPath,
    fixtureSamplesDir,
    fileExists,
    readFile,
  });

  emit(
    `[prestage] ${tag} source decision: ${formatTonalStageDecisionLabel(decision, fixtureRel)}`,
  );
  if (decision.fallbackReason) {
    emit(`[prestage]   fallback reason: ${decision.fallbackReason}`);
  }
  if (decision.kind === 'real-tonal-sample') {
    emit(
      `[prestage]   real sample: ${decision.sourcePath} (catalog #${decision.catalogId ?? '?'})`,
    );
  } else if (decision.kind === 'fixture-tonal-sample') {
    emit(
      `[prestage]   using fixture — set CASPERAKI_SAMPLE_LIBRARY_ROOT + run ` +
        `emit:brain-roundtrip to switch to the resolver-bridged ${family} sample.`,
    );
  }

  if (!decision.sourcePath) {
    emit(`[prestage]   no ${family} source available; skipping`);
    return {
      staged: 0,
      family,
      decisionKind: decision.kind,
      normalizationKind: 'none',
      stagedSourcePath: undefined,
      transcodedReal: false,
      logs,
    };
  }

  let normalized = prepareNormalized({
    sourcePath: decision.sourcePath,
    cacheDir: normalizeCacheDir,
  });
  emit(formatNormalizationLog(normalized, decision.sourcePath));

  let stageDescription = decision.description;
  if (normalized.kind === 'no-ffmpeg' || normalized.kind === 'error') {
    if (decision.kind === 'real-tonal-sample') {
      const fixturePath = resolve(fixtureSamplesDir, fixtureRel);
      if (fileExists(fixturePath)) {
        emit(
          `[prestage]   real-${tag}-sample normalisation failed; falling back to fixture (${fixturePath})`,
        );
        normalized = prepareNormalized({
          sourcePath: fixturePath,
          cacheDir: normalizeCacheDir,
        });
        emit(formatNormalizationLog(normalized, fixturePath));
        stageDescription = `fixture-fallback (${fixtureRel})`;
      }
    }
    if (normalized.kind === 'no-ffmpeg' || normalized.kind === 'error') {
      emit(
        `[prestage]   no decodable ${family} source after normalisation; skipping ${family} staging`,
      );
      return {
        staged: 0,
        family,
        decisionKind: decision.kind,
        normalizationKind: normalized.kind,
        stagedSourcePath: undefined,
        transcodedReal: false,
        logs,
      };
    }
  }

  const transcodedReal =
    decision.kind === 'real-tonal-sample' && normalized.kind === 'transcoded';
  const stagedSource = normalized.preparedPath;
  let staged = 0;
  for (const sample of inst.samples ?? []) {
    const dst = join(tempDir, `vstsample-${sample.id}.ogg`);
    copyFile(stagedSource, dst);
    emit(
      `[prestage] ${tag}#${sample.id} (${sample.type} ${sample.note}) ← ${stageDescription} → ${dst}`,
    );
    staged++;
  }
  if (transcodedReal) {
    emit(
      `[prestage]   real-${tag}-sample-transcoded: ${decision.relativePath ?? decision.sourcePath} → ${stagedSource}`,
    );
  }
  return {
    staged,
    family,
    decisionKind: decision.kind,
    normalizationKind: normalized.kind,
    stagedSourcePath: stagedSource,
    transcodedReal,
    logs,
  };
}
