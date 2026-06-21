import type { Song } from '../schemas/song.js';
import { SongSchema } from '../schemas/song.js';
import { SchemaValidationError, type AdapterDiagnostics } from '../errors.js';
import { Diagnostics } from './diagnostics.js';

export interface BrainAdapterResult {
  song: Song;
  diagnostics: AdapterDiagnostics;
}

// The brain stores songs in Postgres `songs.details` as a JSONB blob. It uses
// the same musical core as the engine envelope but with a few differences:
//   - legacy `tempo` instead of canonical `bpm`
//   - `segment` instead of `name` inside structure
//   - instrumentDefinitions are stored elsewhere (Postgres Instruments table),
//     not inline — the adapter accepts whatever the brain hands us and leaves
//     the catalog hookup to Phase 3.
//
// Brain envelope round-trip is best-effort: brain-only fields (producer
// persona, generator params) flow through but extraneous fields are
// preserved on canonical via diagnostics rather than silently dropped.
export function fromBrainJsonb(details: unknown): BrainAdapterResult {
  const diag = new Diagnostics();
  if (!details || typeof details !== 'object') {
    throw new SchemaValidationError('brain JSONB must be an object', []);
  }
  const raw = details as Record<string, unknown>;

  const songStructure = pickBrainStructure(raw, diag);
  const bpm = pickBrainBpm(raw, diag);

  const canonical: Record<string, unknown> = {
    schemaVersion: '1',
    title: typeof raw.title === 'string' ? raw.title : undefined,
    key: raw.key,
    bpm,
    genre: typeof raw.genre === 'string' ? raw.genre : undefined,
    producer: typeof raw.producer === 'string' ? raw.producer : undefined,
    songStructure,
    arrangement: raw.arrangement,
    patterns: raw.patterns,
    instrumentDefinitions: Array.isArray(raw.instrumentDefinitions)
      ? raw.instrumentDefinitions
      : [],
    aiArtifacts: Array.isArray(raw.aiArtifacts) ? raw.aiArtifacts : [],
    generator: raw.generator,
  };

  for (const k of Object.keys(raw)) {
    if (KNOWN_BRAIN_KEYS.has(k)) continue;
    diag.warn(k, `unknown brain JSONB field '${k}' kept on canonical Song`, 'kept');
    canonical[k] = raw[k];
  }

  const parsed = SongSchema.safeParse(stripUndefined(canonical));
  if (!parsed.success) {
    throw SchemaValidationError.fromZod(parsed.error, 'brain JSONB → canonical');
  }
  return { song: parsed.data, diagnostics: diag.list() };
}

export function toBrainJsonb(song: Song): Record<string, unknown> {
  // New brain code persists canonical-shaped JSON directly. Legacy imports may
  // still read `tempo`, but new exports use `bpm` only.
  const out: Record<string, unknown> = {
    schemaVersion: song.schemaVersion,
    title: song.title,
    key: song.key,
    bpm: song.bpm,
    genre: song.genre,
    producer: song.producer,
    songStructure: song.songStructure.map(({ name, ...rest }) => ({
      segment: name,
      ...rest,
    })),
    arrangement: song.arrangement,
    patterns: song.patterns,
    instrumentDefinitions: song.instrumentDefinitions,
    aiArtifacts: song.aiArtifacts,
    generator: song.generator,
  };
  return stripUndefined(out);
}

const KNOWN_BRAIN_KEYS = new Set([
  'schemaVersion',
  'title',
  'key',
  'bpm',
  'tempo',
  'genre',
  'producer',
  'songStructure',
  'structure',
  'arrangement',
  'patterns',
  'instrumentDefinitions',
  'aiArtifacts',
  'generator',
]);

function pickBrainStructure(raw: Record<string, unknown>, diag: Diagnostics): unknown {
  for (const key of ['songStructure', 'structure'] as const) {
    const v = raw[key];
    if (!Array.isArray(v)) continue;
    if (key !== 'songStructure') {
      diag.info(key, `brain '${key}' renamed to canonical 'songStructure'`, 'normalized');
    }
    return v.map((seg) => {
      if (!seg || typeof seg !== 'object') return seg;
      const s = seg as Record<string, unknown>;
      if (typeof s.segment === 'string') {
        const { segment, ...rest } = s;
        return { name: segment, ...rest };
      }
      return s;
    });
  }
  throw new SchemaValidationError(
    'brain JSONB is missing both `songStructure` and `structure`',
    [],
  );
}

function pickBrainBpm(raw: Record<string, unknown>, diag: Diagnostics): number {
  const fromBpm = coerceNumber(raw.bpm);
  if (fromBpm !== null) return fromBpm;
  const fromTempo = coerceNumber(raw.tempo);
  if (fromTempo !== null) {
    diag.info('tempo', "brain 'tempo' normalized to canonical 'bpm'", 'normalized');
    return fromTempo;
  }
  throw new SchemaValidationError('brain JSONB has neither `bpm` nor `tempo`', []);
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
