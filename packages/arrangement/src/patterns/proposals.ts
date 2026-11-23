// Pattern proposals — Casperaki-written patterns waiting for review in the
// pattern lab (admin page). Each file in data/patterns/proposals/ holds a
// list of proposals:
//   - drums: fixed blueprints (like a legacy bank file) or the name of a
//     generator in drums-authored.ts;
//   - bass: chord-relative lines (legacy SM format);
//   - keys, pad, strings, brass, synths, plucked synths: chord-tone patterns,
//     guitar: picked / strummed strings (chord-tones.ts).
//
// Review decisions live in the brain's database; approved proposals are
// exported into the library (drums/ and bass/ bank-index.json, and
// authored/index.json for the other families) by
// apps/brain/scripts/export-approved-patterns.ts.
//
// Previews pass a proposal to the generators through GenerateParams.params
// (`drumPreview`, `bassPreview`, `lanePreview`), so the same orchestrator
// writes a full song around it.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { GenreSchema } from '@casperaki/song-schema';

import {
  CHORD_TONE_FAMILIES,
  ChordTonePatternSchema,
  energyCoverageProblem,
  GuitarPickPatternSchema,
  type AuthoredPatterns,
} from './chord-tones.js';
import { drumLaneNames, type DrumPreview } from './drums-bank.js';
import { AUTHORED_DRUM_ALGOS } from './drums-authored.js';
import type { InstrumentFamily } from './types.js';
import { familySoundPool } from '../selection/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROPOSALS_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'proposals');
/** The drum bank (bank-index.json + bank files) approved proposals are exported into. */
export const DRUM_BANK_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'drums');
/** The bass bank approved bass proposals are exported into (bank-index.json `authored`). */
export const BASS_BANK_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'bass');

/** bank-index.json style name of an exported proposal. */
export const authoredStyleName = (proposalId: string) => `authored-${proposalId}`;

const DrumBlueprintSchema = z.record(z.string().min(1), z.array(z.number().min(0)).min(1));

/** A bass note relative to the chord: [beat position, length in beats,
 *  semitones from the chord root], over whole 4-beat bars (legacy SM format). */
export const BassHitSchema = z.tuple([z.number().min(0), z.number().positive(), z.number().int().min(-24).max(24)]);
export const BassPatternSchema = z.array(BassHitSchema).min(1);

const ProposalBase = z.object({
  /** Stable id, kebab-case; the review decision is keyed on it. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u),
  name: z.string().min(1),
  /** Genres this pattern is meant for; previews and export use them. */
  genres: z.array(GenreSchema).min(1),
  /** Why it fits the style, in plain words, for the reviewer. */
  rationale: z.string().min(1),
});

export const PatternProposalSchema = z.discriminatedUnion('kind', [
  ProposalBase.extend({ family: z.literal('drums'), kind: z.literal('blueprints'), blueprints: z.array(DrumBlueprintSchema).min(1) }),
  ProposalBase.extend({ family: z.literal('drums'), kind: z.literal('algo'), algo: z.string().min(1) }),
  ProposalBase.extend({ family: z.literal('bass'), kind: z.literal('bassPatterns'), patterns: z.array(BassPatternSchema).min(1) }),
  // Pitched families: fixed pitches that move to the nearest chord tone (chord-tones.ts).
  ProposalBase.extend({ family: z.enum(CHORD_TONE_FAMILIES), kind: z.literal('chordTones'), patterns: z.array(ChordTonePatternSchema).min(1) }),
  // Guitar: strings of the chord shape, picked or strummed (chord-tones.ts).
  ProposalBase.extend({ family: z.literal('guitar'), kind: z.literal('guitarPicks'), patterns: z.array(GuitarPickPatternSchema).min(1) }),
]);
export type PatternProposal = z.infer<typeof PatternProposalSchema>;

/** Every proposal on disk, validated (lanes, generator names, unique ids). */
export function loadPatternProposals(dir: string = PROPOSALS_DIR): PatternProposal[] {
  const lanes = new Set(drumLaneNames());
  const out: PatternProposal[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as unknown;
    const list = z.array(PatternProposalSchema).safeParse(raw);
    if (!list.success) {
      const issue = list.error.issues[0];
      throw new Error(`proposals/${file}: ${issue?.path.join('.')}: ${issue?.message}`);
    }
    for (const p of list.data) {
      if (seen.has(p.id)) throw new Error(`proposals/${file}: duplicate proposal id "${p.id}"`);
      seen.add(p.id);
      if (p.kind === 'algo' && !(p.algo in AUTHORED_DRUM_ALGOS)) {
        throw new Error(`proposals/${file}: "${p.id}" names unknown generator "${p.algo}"`);
      }
      if (p.kind === 'chordTones' || p.kind === 'guitarPicks') {
        const problem = energyCoverageProblem(p.patterns);
        if (problem) throw new Error(`proposals/${file}: "${p.id}": ${problem}`);
        // The family must be playable in each genre (sounds, and the orchestral gate).
        for (const genre of p.genres) {
          if (familySoundPool(p.family, genre).length === 0) {
            throw new Error(`proposals/${file}: "${p.id}": ${p.family} cannot play in ${genre} (no sounds or no lane for it there)`);
          }
        }
      }
      if (p.kind === 'blueprints') {
        p.blueprints.forEach((bp, i) => {
          for (const lane of Object.keys(bp)) {
            if (!lanes.has(lane)) throw new Error(`proposals/${file}: "${p.id}" blueprint ${i} uses unknown lane "${lane}"`);
          }
        });
      }
      out.push(p);
    }
  }
  return out;
}

/** The generator-params value that previews a proposal. */
/** Generator params that make a song play a proposal. With `take`, only that one pattern plays,
 *  in every section (its verse / chorus mark is dropped); without it the song picks among all the
 *  patterns section by section, as an approved style would. */
export function previewParamsFor(p: PatternProposal, take?: number): Record<string, unknown> {
  const count = p.kind === 'algo' ? 1 : p.kind === 'blueprints' ? p.blueprints.length : p.patterns.length;
  if (take !== undefined && !(Number.isInteger(take) && take >= 0 && take < count)) {
    throw new Error(`proposal "${p.id}" has ${count} pattern(s); there is no pattern ${take + 1}`);
  }
  const pick = <T,>(all: readonly T[]): T[] => (take === undefined ? [...all] : [all[take]!]);
  if (p.kind === 'bassPatterns') return { bassPreview: { patterns: pick(p.patterns) } };
  if (p.kind === 'chordTones') {
    const patterns = take === undefined ? p.patterns : pick(p.patterns).map(({ energy: _energy, ...rest }) => rest);
    return { lanePreview: { family: p.family, kind: p.kind, patterns } };
  }
  if (p.kind === 'guitarPicks') {
    const patterns = take === undefined ? p.patterns : pick(p.patterns).map(({ energy: _energy, ...rest }) => rest);
    return { lanePreview: { family: p.family, kind: p.kind, patterns } };
  }
  const drumPreview: DrumPreview =
    p.kind === 'algo' ? { kind: 'algo', algo: p.algo } : { kind: 'blueprints', blueprints: pick(p.blueprints) };
  return { drumPreview };
}

const DrumPreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blueprints'), blueprints: z.array(DrumBlueprintSchema).min(1) }),
  z.object({ kind: z.literal('algo'), algo: z.string().min(1) }),
]);

/** Read `drumPreview` from GenerateParams.params, if present. */
export function drumPreviewFromParams(params: Readonly<Record<string, unknown>> | undefined): DrumPreview | undefined {
  if (!params || params.drumPreview === undefined) return undefined;
  const parsed = DrumPreviewSchema.safeParse(params.drumPreview);
  if (!parsed.success) throw new Error(`invalid drumPreview: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

const BassPreviewSchema = z.object({ patterns: z.array(BassPatternSchema).min(1) });
export type BassPreview = z.infer<typeof BassPreviewSchema>;

/** Read `bassPreview` from GenerateParams.params, if present. */
export function bassPreviewFromParams(params: Readonly<Record<string, unknown>> | undefined): BassPreview | undefined {
  if (!params || params.bassPreview === undefined) return undefined;
  const parsed = BassPreviewSchema.safeParse(params.bassPreview);
  if (!parsed.success) throw new Error(`invalid bassPreview: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

const LanePreviewSchema = z.discriminatedUnion('kind', [
  z.object({ family: z.enum(CHORD_TONE_FAMILIES), kind: z.literal('chordTones'), patterns: z.array(ChordTonePatternSchema).min(1) }),
  z.object({ family: z.literal('guitar'), kind: z.literal('guitarPicks'), patterns: z.array(GuitarPickPatternSchema).min(1) }),
]);
export interface LanePreview {
  readonly family: InstrumentFamily;
  readonly patterns: AuthoredPatterns;
}

/** Read `lanePreview` (a proposed keys / pad / strings / brass / synths / guitar style) from GenerateParams.params, if present. */
export function lanePreviewFromParams(params: Readonly<Record<string, unknown>> | undefined): LanePreview | undefined {
  if (!params || params.lanePreview === undefined) return undefined;
  const parsed = LanePreviewSchema.safeParse(params.lanePreview);
  if (!parsed.success) throw new Error(`invalid lanePreview: ${parsed.error.issues[0]?.message}`);
  const { family, ...patterns } = parsed.data;
  return { family, patterns: patterns as AuthoredPatterns };
}
