// Pattern template loader.
//
// Today: one JSON file `data/patterns/brightPop.json` with the
// `brightPop_default` templates for drums / bass / keys / pad. Later
// genres get sibling files (rock.json, edm.json, ...) and the picker
// resolves by genre.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

export interface DrumElementTemplate {
  readonly midi: number;
  readonly beats: readonly number[];
}

export interface DrumTemplate {
  readonly elements: Readonly<Record<string, DrumElementTemplate>>;
}

export interface BassTemplate {
  readonly rootMidiOctave: number;
  readonly beats: readonly number[];
  readonly noteDuration: number;
}

export interface KeysTemplate {
  readonly beats: readonly number[];
  readonly chordDurationBeats: number;
}

export interface PadTemplate {
  readonly beats: readonly number[];
  readonly chordDurationBeats: number;
}

export interface BrightPopPatternTemplates {
  readonly drums: DrumTemplate;
  readonly bass: BassTemplate;
  readonly keys: KeysTemplate;
  readonly pad: PadTemplate;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns');

const BRIGHTPOP_META: DataAssetMeta = {
  filename: 'brightPop.json',
  legacyPath: 'casperaki-backend/services/arrangements/* (slice-scoped fixture)',
  extractedAt: '2026-06-06',
};

let cached: BrightPopPatternTemplates | undefined;

export function loadBrightPopPatterns(): BrightPopPatternTemplates {
  if (cached) return cached;
  const path = resolve(DATA_DIR, BRIGHTPOP_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(BRIGHTPOP_META, `failed to load: ${(err as Error).message}`, err);
  }
  const root = (raw as { brightPop_default?: BrightPopPatternTemplates }).brightPop_default;
  if (!root || !root.drums || !root.bass || !root.keys || !root.pad)
    throw new DataAssetError(BRIGHTPOP_META, 'missing brightPop_default.{drums,bass,keys,pad}');
  cached = root;
  return root;
}
