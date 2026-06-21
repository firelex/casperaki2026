// Bass staging — docs/54i (extracted from prestage-samples.mjs so the
// real-sample bridge + format normalisation pipeline is unit-testable
// without running the top-level prestage script).
//
// Orchestrates:
//   1. `decideBassSource` (docs/54h)  — pick real vs. fixture source
//   2. `prepareNormalizedSource` (docs/54i) — copy or ffmpeg-transcode
//   3. write the normalised bytes over every `vstsample-<id>.ogg`
//
// All log output goes through the injected `log` callback so the
// prestage script can route it to stderr and tests can capture it
// inline. The function returns a record of the actions taken so callers
// (script or test) can assert on the outcome.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  decideBassSource,
  formatStageDecisionLabel,
} from './bass-asset-bridge.mjs';
import {
  formatNormalizationLog,
  prepareNormalizedSource,
} from './audio-normalize.mjs';

/**
 * @typedef {{
 *   staged: number;
 *   decisionKind: 'real-bass-sample' | 'fixture-bass-sample' | 'no-source' | 'no-inst';
 *   normalizationKind: 'copy' | 'transcoded' | 'no-ffmpeg' | 'error' | 'none';
 *   stagedSourcePath: string | undefined;
 *   transcodedReal: boolean;
 *   logs: string[];
 * }} StageBassResult
 */

/**
 * @param {{
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
 * @returns {StageBassResult}
 */
export function stageBassWithBridge(opts) {
  const {
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

  if (!fileExists(instPath)) {
    return {
      staged: 0,
      decisionKind: 'no-inst',
      normalizationKind: 'none',
      stagedSourcePath: undefined,
      transcodedReal: false,
      logs,
    };
  }
  const inst = JSON.parse(readFile(instPath));
  const decision = decideBassSource({
    sampleLibraryRoot,
    manifestPath,
    fixtureSamplesDir,
    fileExists,
    readFile,
  });

  emit(`[prestage] bass source decision: ${formatStageDecisionLabel(decision)}`);
  if (decision.fallbackReason) {
    emit(`[prestage]   fallback reason: ${decision.fallbackReason}`);
  }
  if (decision.kind === 'real-bass-sample') {
    emit(
      `[prestage]   real sample: ${decision.sourcePath} (catalog #${decision.catalogId ?? '?'})`,
    );
  } else if (decision.kind === 'fixture-bass-sample') {
    emit(
      `[prestage]   using fixture — set CASPERAKI_SAMPLE_LIBRARY_ROOT + run ` +
        `emit:brain-roundtrip to switch to the resolver-bridged Bass sample.`,
    );
  }

  if (!decision.sourcePath) {
    emit('[prestage]   no Bass source available; skipping');
    return {
      staged: 0,
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
    if (decision.kind === 'real-bass-sample') {
      const fixturePath = resolve(fixtureSamplesDir, 'bass-c2.ogg');
      if (fileExists(fixturePath)) {
        emit(
          `[prestage]   real-bass-sample normalisation failed; falling back to fixture (${fixturePath})`,
        );
        normalized = prepareNormalized({
          sourcePath: fixturePath,
          cacheDir: normalizeCacheDir,
        });
        emit(formatNormalizationLog(normalized, fixturePath));
        stageDescription = `fixture-fallback (bass-c2.ogg)`;
      }
    }
    if (normalized.kind === 'no-ffmpeg' || normalized.kind === 'error') {
      emit(
        `[prestage]   no decodable Bass source after normalisation; skipping Bass staging`,
      );
      return {
        staged: 0,
        decisionKind: decision.kind,
        normalizationKind: normalized.kind,
        stagedSourcePath: undefined,
        transcodedReal: false,
        logs,
      };
    }
  }

  const transcodedReal =
    decision.kind === 'real-bass-sample' && normalized.kind === 'transcoded';
  const stagedSource = normalized.preparedPath;
  let staged = 0;
  for (const sample of inst.samples ?? []) {
    const dst = join(tempDir, `vstsample-${sample.id}.ogg`);
    copyFile(stagedSource, dst);
    emit(
      `[prestage] bass#${sample.id} (${sample.type} ${sample.note}) ← ${stageDescription} → ${dst}`,
    );
    staged++;
  }
  if (transcodedReal) {
    emit(
      `[prestage]   real-bass-sample-transcoded: ${decision.relativePath ?? decision.sourcePath} → ${stagedSource}`,
    );
  }
  return {
    staged,
    decisionKind: decision.kind,
    normalizationKind: normalized.kind,
    stagedSourcePath: stagedSource,
    transcodedReal,
    logs,
  };
}
