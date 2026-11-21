// Pattern proposals — Casperaki-written patterns waiting for review in the
// pattern lab (admin page). Each file in data/patterns/proposals/ holds a
// list of proposals. A proposal is either fixed blueprints (like a legacy
// bank file) or the name of a generator in drums-authored.ts.
//
// Review decisions live in the brain's database; approved proposals are
// exported into data/patterns/drums/ (authored-<genre>.json banks and
// bank-index.json styles) by apps/brain/scripts/export-approved-patterns.ts.
//
// Previews pass a proposal to the generators through GenerateParams.params
// (`drumPreview`), so the same orchestrator writes a full song around it.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { GenreSchema } from '@casperaki/song-schema';

import { drumLaneNames, type DrumPreview } from './drums-bank.js';
import { AUTHORED_DRUM_ALGOS } from './drums-authored.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROPOSALS_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'proposals');
/** The drum bank (bank-index.json + bank files) approved proposals are exported into. */
export const DRUM_BANK_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'drums');

/** bank-index.json style name of an exported proposal. */
export const authoredStyleName = (proposalId: string) => `authored-${proposalId}`;

const DrumBlueprintSchema = z.record(z.string().min(1), z.array(z.number().min(0)).min(1));

const ProposalBase = z.object({
  /** Stable id, kebab-case; the review decision is keyed on it. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u),
  family: z.literal('drums'),
  name: z.string().min(1),
  /** Genres this pattern is meant for; previews and export use them. */
  genres: z.array(GenreSchema).min(1),
  /** Why it fits the style, in plain words, for the reviewer. */
  rationale: z.string().min(1),
});

export const PatternProposalSchema = z.discriminatedUnion('kind', [
  ProposalBase.extend({ kind: z.literal('blueprints'), blueprints: z.array(DrumBlueprintSchema).min(1) }),
  ProposalBase.extend({ kind: z.literal('algo'), algo: z.string().min(1) }),
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
export function previewParamsFor(p: PatternProposal): Record<string, unknown> {
  const drumPreview: DrumPreview =
    p.kind === 'algo' ? { kind: 'algo', algo: p.algo } : { kind: 'blueprints', blueprints: p.blueprints };
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
