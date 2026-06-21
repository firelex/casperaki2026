// Typed loaders for the chord generator's data assets.
//
// JSON lives at `<package>/data/` (sibling of `src` and `dist`) so the same
// relative path resolves from both `src/chords/data.ts` (tsx runs) and
// `dist/chords/data.js` (built consumers like @casperaki/brain).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

export type ChordQualityKey =
  | 'maj' | 'min' | 'dim' | 'aug'
  | 'maj7' | 'min7' | 'dom7'
  | 'maj9' | 'min9' | 'dom9'
  | 'sus' | 'add6' | 'dom11' | 'pow5';

export interface RomanNumeralEntry {
  readonly degree: number;
  /** Semitone offset applied to the root after major-scale degree lookup.
   *  -1 = flat (e.g., bVII), +1 = sharp (e.g., #IV). Omitted = natural. */
  readonly accidental?: -1 | 1;
  readonly quality: ChordQualityKey;
}

export interface ChordsVocab {
  readonly romanNumerals: Readonly<Record<string, RomanNumeralEntry>>;
  readonly qualitySymbols: Readonly<Record<ChordQualityKey, string>>;
}

export interface Precedent {
  readonly name: string;
  readonly description?: string;
  /** Segment TYPE (intro / verse / preChorus / chorus / bridge / break /
   *  outro) → list of roman numerals. The chord generator cycles the
   *  template with `i % template.length` to fill any bar count. */
  readonly byType: Readonly<Record<string, readonly string[]>>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data');

const CHORDS_META: DataAssetMeta = {
  filename: 'chords.json',
  legacyPath: 'casperaki-backend/services/classes/chords/chords.json',
  extractedAt: '2026-06-06',
};

const PRECEDENTS_META: DataAssetMeta = {
  filename: 'precedents.json',
  legacyPath: 'casperaki-backend/services/classes/chords/precedents.json',
  extractedAt: '2026-06-06',
};

function loadJson(meta: DataAssetMeta): unknown {
  const path = resolve(DATA_DIR, meta.filename);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
}

let cachedVocab: ChordsVocab | undefined;
let cachedPrecedents: Readonly<Record<string, Precedent>> | undefined;

export function loadChordsVocab(): ChordsVocab {
  if (cachedVocab) return cachedVocab;
  const raw = loadJson(CHORDS_META) as Partial<ChordsVocab>;
  if (!raw.romanNumerals || !raw.qualitySymbols)
    throw new DataAssetError(CHORDS_META, 'missing romanNumerals or qualitySymbols');
  cachedVocab = { romanNumerals: raw.romanNumerals, qualitySymbols: raw.qualitySymbols };
  return cachedVocab;
}

export function loadPrecedents(): Readonly<Record<string, Precedent>> {
  if (cachedPrecedents) return cachedPrecedents;
  const raw = loadJson(PRECEDENTS_META) as Record<string, unknown>;
  const out: Record<string, Precedent> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    const p = value as Partial<Precedent>;
    if (!p.name || !p.byType)
      throw new DataAssetError(PRECEDENTS_META, `precedent "${key}" missing name or byType`);
    out[key] = { name: p.name, description: p.description, byType: p.byType };
  }
  cachedPrecedents = out;
  return out;
}
