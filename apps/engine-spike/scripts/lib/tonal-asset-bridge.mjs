// Tonal-family asset bridge — generalised from the Bass-only bridge
// (docs/54h) to cover Bass + Keys + Pad in docs/54j.
//
// Picks the source file that prestage-samples.mjs should stage into
// every `vstsample-<id>.ogg` slot for a tonal family (Bass / Keys / Pad).
// Each family carries its own:
//   - asset-manifest key (`Bass` / `Keys` / `Pad`)
//   - bundled fixture filename + short label
//   - resolver-verdict (`entryId`, `relativePath`)
//
// The decision logic is shared:
//   1. If CASPERAKI_SAMPLE_LIBRARY_ROOT is set, the manifest has a
//      resolved relativePath for this family, and the joined file
//      exists on disk → `real-tonal-sample`.
//   2. Otherwise → `fixture-tonal-sample` with the bundled per-family
//      fixture.
//   3. If neither path is available → `no-source` with a fallbackReason
//      describing both failure modes.
//
// The module is intentionally side-effect-free apart from existence
// checks and reading the manifest. The caller (prestage-samples.mjs)
// performs the actual byte copies via stage-tonal.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * @typedef {object} TonalAssetDecision
 * @property {'real-tonal-sample' | 'fixture-tonal-sample' | 'no-source'} kind
 * @property {string} family
 *   Display name (Bass / Keys / Pad). Echoed back so callers don't
 *   have to thread it through their own state.
 * @property {string | undefined} sourcePath
 *   Absolute path that should be staged into every vstsample-<id>.ogg.
 *   Undefined only when `kind === 'no-source'`.
 * @property {string} description
 *   Short human-readable label used in stage log lines.
 * @property {string | undefined} catalogId
 *   The 16-hex catalog id from the manifest, when present.
 * @property {string | undefined} relativePath
 *   Sample-library-relative path from the resolver, when present.
 * @property {string | undefined} fallbackReason
 *   Set when `kind !== 'real-tonal-sample'`.
 */

/**
 * Decide which source file to stage for a tonal family.
 *
 * @param {{
 *   readonly family: 'Bass' | 'Keys' | 'Pad' | string;
 *   readonly fixtureRel: string;
 *   readonly sampleLibraryRoot?: string | undefined;
 *   readonly manifestPath: string;
 *   readonly fixtureSamplesDir: string;
 *   readonly fileExists?: (path: string) => boolean;
 *   readonly readFile?: (path: string) => string;
 * }} inputs
 * @returns {TonalAssetDecision}
 */
export function decideTonalSource({
  family,
  fixtureRel,
  sampleLibraryRoot,
  manifestPath,
  fixtureSamplesDir,
  fileExists = existsSync,
  readFile = (p) => readFileSync(p, 'utf-8'),
}) {
  const fixturePath = resolvePath(fixtureSamplesDir, fixtureRel);
  const fixtureAvailable = fileExists(fixturePath);

  const fallbackToFixture = (reason) => {
    if (fixtureAvailable) {
      return /** @type {TonalAssetDecision} */ ({
        kind: 'fixture-tonal-sample',
        family,
        sourcePath: fixturePath,
        description: `fixture (${fixtureRel})`,
        catalogId: undefined,
        relativePath: undefined,
        fallbackReason: reason,
      });
    }
    return /** @type {TonalAssetDecision} */ ({
      kind: 'no-source',
      family,
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

  const entry =
    manifest && typeof manifest === 'object' ? manifest[family] : undefined;
  if (!entry || typeof entry !== 'object') {
    return fallbackToFixture(`asset-manifest.json has no ${family} entry`);
  }
  if (entry.status !== 'resolved') {
    return fallbackToFixture(
      `${family} entry unresolved: ${entry.reason ?? 'no reason recorded'}`,
    );
  }
  const rel = typeof entry.relativePath === 'string' ? entry.relativePath : undefined;
  if (!rel || rel.length === 0) {
    return fallbackToFixture(`${family} entry resolved but has no relativePath`);
  }

  const rootAbs = isAbsolute(sampleLibraryRoot)
    ? sampleLibraryRoot
    : resolvePath(sampleLibraryRoot);
  const realPath = resolvePath(rootAbs, rel);
  if (!fileExists(realPath)) {
    return fallbackToFixture(
      `resolved ${family} sample not on disk: ${realPath} (root=${rootAbs}, rel=${rel})`,
    );
  }

  return /** @type {TonalAssetDecision} */ ({
    kind: 'real-tonal-sample',
    family,
    sourcePath: realPath,
    description: `real catalog sample (${rel})`,
    catalogId: typeof entry.entryId === 'string' ? entry.entryId : undefined,
    relativePath: rel,
    fallbackReason: undefined,
  });
}

/**
 * Return a short label suitable for a stage-log line.
 * @param {TonalAssetDecision} d
 * @param {string} fixtureRel
 */
export function formatTonalStageDecisionLabel(d, fixtureRel) {
  if (d.kind === 'real-tonal-sample') {
    return `real-${d.family.toLowerCase()}-sample (${d.relativePath ?? '?'})`;
  }
  if (d.kind === 'fixture-tonal-sample') {
    return `fixture-${d.family.toLowerCase()}-sample (${fixtureRel})`;
  }
  return `no-source (${d.fallbackReason ?? 'unknown'})`;
}
