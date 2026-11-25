export { SCHEMA_VERSION, SCHEMA_ID, compareVersions, migrate } from './version.js';
export type { SchemaVersion } from './version.js';
export * from './schemas/index.js';
export { parseSong, safeParseSong } from './parse.js';
export type { ParseOptions } from './parse.js';
export { validateSemantics } from './semantic.js';
export type { SemanticIssue, SemanticReport } from './semantic.js';
export {
  canonicalStringifySong,
  stableStringify,
  normalizeSong,
  normalizeBarBeatKey,
  contentHash,
} from './canonical/index.js';
export { vocalTakeFingerprint, isTakeFresh, SUNG_TAKE_KINDS } from './vocal-takes.js';
export * from './ace-layer.js';
export { generateSongJsonSchema } from './json-schema/generate.js';
export * from './adapters/index.js';
export {
  SchemaValidationError,
  AdapterError,
  type AdapterDiagnostic,
  type AdapterDiagnostics,
  type DiagnosticSeverity,
  type DiagnosticAction,
} from './errors.js';
