// Bass asset bridge — Phase 4 first real-sample slice (docs/54h).
//
// Picks the source file that prestage-samples.mjs should stage into the
// engine's `vstsample-<id>.ogg` slots for the Bass instrument:
//
//   * If `CASPERAKI_SAMPLE_LIBRARY_ROOT` is set, the round-trip
//     asset-manifest carries a resolved Bass `relativePath` (the
//     `@casperaki/arrangement` asset resolver's verdict for the
//     brain-selected Bass catalog row at the song's `(key, bpm)`),
//     AND the joined file exists on disk:
//        → use that file. Decision: 'real-bass-sample'.
//
//   * Otherwise:
//        → fall back to the bundled `apps/engine-spike/samples/bass-c2.ogg`
//          tunable. Decision: 'fixture-bass-sample'. The decision carries
//          a `fallbackReason` string covering which precondition failed
//          (no root / no manifest / manifest unresolved / file missing /
//          fixture itself missing).
//
// The Bass kit fixture (16 sample ids, longNote + shortNote, c2..a3)
// stays in place — we stage the chosen source under all 16
// `vstsample-<id>.ogg` filenames. Tracktion's sampler pitch-shifts the
// single source across the playable MIDI range; this is the same trick
// the existing fixture path uses (docs/53w §"Asset prestaging").
//
// This module is intentionally pure-ish: it reads inputs explicitly,
// touches the filesystem only for existence checks, and returns a
// decision record. The caller (prestage-samples.mjs) performs the copies.
// Tests construct synthetic input directories to exercise every branch.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * @typedef {object} BassAssetDecision
 * @property {'real-bass-sample' | 'fixture-bass-sample' | 'no-source'} kind
 * @property {string | undefined} sourcePath
 *   Absolute path that should be staged into every Bass vstsample-<id>.ogg.
 *   Undefined only when `kind === 'no-source'` (fixture missing AND
 *   no real sample available — the caller should skip Bass staging
 *   entirely and log loudly).
 * @property {string} description
 *   Short human-readable label used in stage log lines.
 * @property {string | undefined} catalogId
 *   The 16-hex catalog id from the manifest, when present.
 * @property {string | undefined} relativePath
 *   Sample-library-relative path from the resolver, when present.
 * @property {string | undefined} fallbackReason
 *   Set when `kind !== 'real-bass-sample'`. Explains which precondition
 *   forced the fallback (or no-source).
 */

const FIXTURE_REL = 'bass-c2.ogg';

/**
 * Decide which source file to stage for Bass.
 *
 * @param {{
 *   readonly sampleLibraryRoot?: string | undefined;
 *   readonly manifestPath: string;
 *   readonly fixtureSamplesDir: string;
 *   readonly fileExists?: (path: string) => boolean;
 *   readonly readFile?: (path: string) => string;
 * }} inputs
 * @returns {BassAssetDecision}
 */
export function decideBassSource({
  sampleLibraryRoot,
  manifestPath,
  fixtureSamplesDir,
  fileExists = existsSync,
  readFile = (p) => readFileSync(p, 'utf-8'),
}) {
  const fixturePath = resolvePath(fixtureSamplesDir, FIXTURE_REL);
  const fixtureAvailable = fileExists(fixturePath);

  const fallbackToFixture = (reason) => {
    if (fixtureAvailable) {
      return /** @type {BassAssetDecision} */ ({
        kind: 'fixture-bass-sample',
        sourcePath: fixturePath,
        description: `fixture (${FIXTURE_REL})`,
        catalogId: undefined,
        relativePath: undefined,
        fallbackReason: reason,
      });
    }
    return /** @type {BassAssetDecision} */ ({
      kind: 'no-source',
      sourcePath: undefined,
      description: 'no source available',
      catalogId: undefined,
      relativePath: undefined,
      fallbackReason: `${reason}; fixture ${fixturePath} also missing`,
    });
  };

  if (!sampleLibraryRoot || sampleLibraryRoot.trim().length === 0) {
    return fallbackToFixture('CASPERAKI_SAMPLE_LIBRARY_ROOT not set');
  }
  if (!fileExists(manifestPath)) {
    return fallbackToFixture(`asset-manifest.json missing at ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFile(manifestPath));
  } catch (err) {
    return fallbackToFixture(
      `asset-manifest.json failed to parse: ${err?.message ?? String(err)}`,
    );
  }

  const bass = manifest && typeof manifest === 'object' ? manifest.Bass : undefined;
  if (!bass || typeof bass !== 'object') {
    return fallbackToFixture('asset-manifest.json has no Bass entry');
  }
  if (bass.status !== 'resolved') {
    return fallbackToFixture(
      `Bass entry unresolved: ${bass.reason ?? 'no reason recorded'}`,
    );
  }
  const rel = typeof bass.relativePath === 'string' ? bass.relativePath : undefined;
  if (!rel || rel.length === 0) {
    return fallbackToFixture('Bass entry resolved but has no relativePath');
  }

  // Join root + relativePath. The resolver always returns POSIX-style
  // relative paths (53s); on Windows-style roots Node's `resolve`
  // handles the mix.
  const rootAbs = isAbsolute(sampleLibraryRoot)
    ? sampleLibraryRoot
    : resolvePath(sampleLibraryRoot);
  const realPath = resolvePath(rootAbs, rel);
  if (!fileExists(realPath)) {
    return fallbackToFixture(
      `resolved Bass sample not on disk: ${realPath} (root=${rootAbs}, rel=${rel})`,
    );
  }

  return /** @type {BassAssetDecision} */ ({
    kind: 'real-bass-sample',
    sourcePath: realPath,
    description: `real catalog sample (${rel})`,
    catalogId: typeof bass.entryId === 'string' ? bass.entryId : undefined,
    relativePath: rel,
    fallbackReason: undefined,
  });
}

/**
 * Return a short label suitable for a stage-log line — e.g.
 * "real-bass-sample (basses/.../BA Trancy Bass.mp3) ← /D/samples/…"
 * @param {BassAssetDecision} d
 */
export function formatStageDecisionLabel(d) {
  if (d.kind === 'real-bass-sample') {
    return `real-bass-sample (${d.relativePath ?? '?'})`;
  }
  if (d.kind === 'fixture-bass-sample') {
    return `fixture-bass-sample (${FIXTURE_REL})`;
  }
  return `no-source (${d.fallbackReason ?? 'unknown'})`;
}
