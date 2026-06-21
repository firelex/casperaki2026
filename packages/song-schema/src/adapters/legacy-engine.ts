import type { Song } from '../schemas/song.js';
import type { InstrumentDefinition } from '../schemas/instrument-def.js';
import { SongSchema } from '../schemas/song.js';
import { InstrumentDefinitionSchema } from '../schemas/instrument-def.js';
import { SchemaValidationError, type AdapterDiagnostics } from '../errors.js';
import { Diagnostics } from './diagnostics.js';

export interface EngineEnvelope {
  song: Record<string, unknown>;
  instruments: Record<string, unknown>[];
}

export interface EngineAdapterResult {
  song: Song;
  diagnostics: AdapterDiagnostics;
}

// Legacy engine accepts both `structure` (web-tester fixture) and
// `songStructure` (e2etest fixtures) for the same field; segments use
// `segment` instead of canonical `name`; `tempo` is the legacy alias for
// `bpm`.
const LEGACY_STRUCTURE_KEYS = ['songStructure', 'structure'] as const;

export function fromEngineEnvelope(envelope: EngineEnvelope): EngineAdapterResult {
  const diag = new Diagnostics();
  const raw = envelope.song as Record<string, unknown>;

  const songStructure = pickLegacyStructure(raw, diag);
  const bpm = pickBpm(raw, diag);

  const canonical: Record<string, unknown> = {
    schemaVersion: '1',
    title: typeof raw.title === 'string' ? raw.title : undefined,
    key: raw.key,
    bpm,
    genre: typeof raw.genre === 'string' ? raw.genre : undefined,
    producer: typeof raw.producer === 'string' ? raw.producer : undefined,
    songStructure,
    arrangement: normalizeArrangement(raw.arrangement, diag),
    patterns: raw.patterns,
    instrumentDefinitions: envelope.instruments.map((inst, idx) =>
      parseInstrument(inst, idx, diag),
    ),
    aiArtifacts: [],
  };

  for (const key of Object.keys(raw)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue;
    diag.warn(key, `unknown top-level engine field '${key}' kept on canonical Song`, 'kept');
    canonical[key] = raw[key];
  }

  const parsed = SongSchema.safeParse(stripUndefined(canonical));
  if (!parsed.success) {
    throw SchemaValidationError.fromZod(parsed.error, 'engine envelope → canonical');
  }
  return { song: parsed.data, diagnostics: diag.list() };
}

export function toEngineEnvelope(song: Song): EngineEnvelope {
  // The legacy C++ engine's Sequencer::setSong reads songData["tempo"] and
  // songData["structure"] directly (Sequencer.cpp:374,377) with no
  // normalization. Emit the legacy field names here — this is the canonical
  // → legacy-engine adapter boundary, the only place outside fixtures where
  // we are permitted to write `tempo`/`structure`. New brain, frontend, and
  // model code must continue to use `bpm`/`songStructure`.
  const out: Record<string, unknown> = {};
  if (song.title !== undefined) out.title = song.title;
  out.key = song.key;
  out.tempo = song.bpm as unknown as number;
  if (song.genre !== undefined) out.genre = song.genre;
  if (song.producer !== undefined) out.producer = song.producer;
  out.structure = song.songStructure.map(({ name, ...rest }) => ({
    segment: name,
    ...rest,
  }));
  out.arrangement = denormalizeArrangement(song.arrangement);
  if (song.patterns !== undefined) out.patterns = song.patterns;

  return {
    song: out,
    instruments: song.instrumentDefinitions.map((i) => ({ ...i })),
  };
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
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
  'schemaVersion',
  // Brain-flavored extras that the engine ignores but fixtures sometimes carry:
  'relatedTransitionGroups',
]);

function pickLegacyStructure(raw: Record<string, unknown>, diag: Diagnostics): unknown {
  for (const key of LEGACY_STRUCTURE_KEYS) {
    const v = raw[key];
    if (!Array.isArray(v)) continue;
    if (key !== 'songStructure') {
      diag.info(key, `legacy '${key}' renamed to canonical 'songStructure'`, 'normalized');
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
    'engine envelope is missing both `songStructure` and `structure`',
    [],
  );
}

function pickBpm(raw: Record<string, unknown>, diag: Diagnostics): number {
  const fromBpm = coerceNumber(raw.bpm);
  if (fromBpm !== null) return fromBpm;
  const fromTempo = coerceNumber(raw.tempo);
  if (fromTempo !== null) {
    diag.info('tempo', "legacy 'tempo' normalized to canonical 'bpm'", 'normalized');
    if (typeof raw.tempo === 'string') {
      diag.info('tempo', "string-encoded tempo coerced to number", 'normalized');
    }
    return fromTempo;
  }
  throw new SchemaValidationError(
    'engine envelope has neither `bpm` nor `tempo`',
    [],
  );
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function normalizeArrangement(arr: unknown, _diag: Diagnostics): unknown {
  if (!arr || typeof arr !== 'object') return arr;
  return arr;
}

function denormalizeArrangement(arr: unknown): unknown {
  // Canonical and engine share the segment-payload shape; no structural change today.
  return arr;
}

function parseInstrument(
  raw: unknown,
  idx: number,
  diag: Diagnostics,
): InstrumentDefinition {
  const parsed = InstrumentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw SchemaValidationError.fromZod(
      parsed.error,
      `engine envelope inst-${idx} parse`,
    );
  }
  if (parsed.data.name === undefined) {
    diag.warn(`instruments[${idx}]`, 'instrument missing name', 'kept');
  }
  return parsed.data;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
