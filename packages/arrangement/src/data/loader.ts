// Typed loader stubs for migrated legacy data assets. Each asset gets:
//   - a Zod schema in @casperaki/song-schema (or here for arrangement-private blobs),
//   - a loader function with explicit return type,
//   - a provenance note (legacy path + dump date).
//
// Assets >5 MB do NOT live in this package — they live in object storage or
// a separate data package and the loader fetches by URL/path. Today this
// file only sketches the contract; concrete loaders land alongside each
// generator (e.g. chords/precedents.ts) so the wiring is local to its
// consumer.

export interface DataAssetMeta {
  /** Filename within the bundled data directory, e.g. "chords.json". */
  filename: string;
  /** Legacy source path the asset was extracted from. */
  legacyPath: string;
  /** ISO date string of the extraction. */
  extractedAt: string;
  /** Optional content-hash for the immutable bundle. */
  sha256?: string;
}

export class DataAssetError extends Error {
  constructor(
    public readonly meta: DataAssetMeta,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${meta.filename}] ${message}`);
    this.name = 'DataAssetError';
  }
}
