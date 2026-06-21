import type { SafeParseReturnType } from 'zod';
import { SchemaValidationError } from './errors.js';
import { SongSchema, type Song } from './schemas/song.js';
import { validateSemantics, type SemanticReport } from './semantic.js';

export interface ParseOptions {
  // When true, semantic warnings are promoted to errors.
  strict?: boolean;
}

export function parseSong(input: unknown, opts: ParseOptions = {}): Song {
  const result = SongSchema.safeParse(input);
  if (!result.success) throw SchemaValidationError.fromZod(result.error);
  const song = result.data;
  const report = validateSemantics(song);
  if (report.errors.length > 0 || (opts.strict && report.warnings.length > 0)) {
    throw new SchemaValidationError(
      `[song-schema] semantic validation failed: ${report.errors[0]?.message ?? report.warnings[0]?.message ?? 'unknown'}`,
      [],
    );
  }
  return song;
}

export function safeParseSong(
  input: unknown,
  opts: ParseOptions = {},
): { ok: true; song: Song; semantic: SemanticReport } | { ok: false; error: SchemaValidationError } {
  const result: SafeParseReturnType<unknown, Song> = SongSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: SchemaValidationError.fromZod(result.error) };
  }
  const song = result.data;
  const semantic = validateSemantics(song);
  if (semantic.errors.length > 0 || (opts.strict && semantic.warnings.length > 0)) {
    return {
      ok: false,
      error: new SchemaValidationError(
        `[song-schema] semantic validation failed: ${semantic.errors[0]?.message ?? semantic.warnings[0]?.message ?? 'unknown'}`,
        [],
      ),
    };
  }
  return { ok: true, song, semantic };
}
