// Sequencer track edits: change a track's sound, give it a new pattern, add a
// track. (Removing a track is a client-side edit.)
//
// Edits are recorded in the song's generator block (`generator.params.params
// .trackEdits`) and applied by `orchestrate` right after instrument
// selection: a changed sound replaces the lane's catalog entry, a new
// pattern forks the lane's pattern stream as `lane/<name>#v<n>`, an added
// track appends a lane active in the listed sections. Every lane forks its
// own streams, so an edit never shifts another lane's draws, and replaying
// the generator block reproduces the edited song.
//
// The working song may carry client-side structure edits (sections renamed,
// duplicated, deleted, bar counts changed) that the generator knows nothing
// about. `editTrack` therefore regenerates the song with the edit and
// SPLICES only the edited track into the working song, section by section.

import { createRng } from '@casperaki/music-theory';
import { parseSong, type InstrumentDefinition, type SegmentPayload, type Song } from '@casperaki/song-schema';
import { z } from 'zod';

import { segmentType } from '../arrangement-polish/segment-type.js';
import { publicNameOf } from '../catalog/public-names.js';
import type { GenerateParams } from '../context.js';
import { orchestrate } from '../orchestrate/index.js';
import { familySoundPool, LANE_BASE_NAMES, laneFamilyOf, userSoundFor } from '../selection/index.js';
import { InstrumentFamilySchema, type InstrumentFamily } from '../selection/types.js';
import { recordedTrackEdits, TRACK_EDITS_PARAM, type RecordedTrackEdit } from './recorded.js';

/** Thrown for a request the song cannot take; `status` is the HTTP status to answer with. */
export class TrackEditError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TrackEditError';
  }
}

// ---- requests -------------------------------------------------------------------

export const TrackEditRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changeSound'), track: z.string().min(1), soundId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('newPattern'), track: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('addTrack'),
      family: InstrumentFamilySchema,
      segments: z.array(z.string().min(1)).min(1),
      soundId: z.string().min(1).optional(),
    })
    .strict(),
]);
export type TrackEditRequest = z.infer<typeof TrackEditRequestSchema>;

export const FAMILY_LABELS: Readonly<Record<InstrumentFamily, string>> = {
  drums: 'Drums',
  bass: 'Bass',
  keys: 'Keys',
  pad: 'Pads',
  guitar: 'Guitar',
  synths: 'Synths',
  pluckedSynths: 'Plucked synths',
  popStrings: 'Strings',
  popBrass: 'Brass',
};

export interface TrackOptions {
  readonly tracks: Record<string, { family: InstrumentFamily | null; soundId: string | null; editable: boolean }>;
  readonly families: { family: InstrumentFamily; label: string; sounds: { id: string; name: string }[] }[];
}

/** What the sequencer may offer for a song: each track's family and sound, and
 *  per family the sounds the song's genre allows (public names only). */
export function trackOptions(song: Song): TrackOptions {
  const params = generatorParams(song);
  const defs = new Map(song.instrumentDefinitions.map((d) => [d.name, d]));
  const tracks: TrackOptions['tracks'] = {};
  for (const name of trackNames(song)) {
    const family = laneFamilyOf(name) ?? null;
    const def = defs.get(name);
    tracks[name] = {
      family,
      soundId: family && def ? String(def.id) : null,
      editable: family !== null && def !== undefined,
    };
  }
  const families = InstrumentFamilySchema.options
    .map((family) => ({
      family,
      label: FAMILY_LABELS[family],
      // The drum kit follows the genre at lowering time (the engine assembles
      // it per component), so there is no kit to choose: drums list no sounds.
      sounds:
        family === 'drums'
          ? []
          : familySoundPool(family, params.genre).map((e) => ({ id: e.id, name: publicNameOf(e) })),
    }))
    .filter((f) => f.family === 'drums' || f.sounds.length > 0);
  return { tracks, families };
}

/** Every track name in the song: instrument definitions, then override keys. */
function trackNames(song: Song): string[] {
  const names = new Set(song.instrumentDefinitions.map((d) => d.name));
  for (const payload of Object.values(song.arrangement)) {
    for (const k of Object.keys(payload.instruments ?? {})) names.add(k);
    for (const k of Object.keys(payload.overrides ?? {})) names.add(k);
  }
  return [...names];
}

/** The generator parameters of a song (409 when it has no generator block). */
export function generatorParams(song: Song): GenerateParams {
  const g = song.generator;
  const block = g?.params as Record<string, unknown> | undefined;
  const seed = g?.seed;
  if (
    !block ||
    typeof block.genre !== 'string' ||
    typeof block.key !== 'string' ||
    typeof block.bpm !== 'number' ||
    (typeof seed !== 'string' && typeof seed !== 'number')
  ) {
    throw new TrackEditError(409, 'missing_generator', 'This song has no generator block, so its tracks cannot be regenerated.');
  }
  const inner = block.params;
  if (inner !== undefined && (typeof inner !== 'object' || inner === null || Array.isArray(inner))) {
    throw new TrackEditError(409, 'bad_generator', 'The song\'s generator params are not an object.');
  }
  return {
    genre: block.genre,
    key: block.key,
    bpm: block.bpm,
    seed,
    ...(inner !== undefined ? { params: inner as Record<string, unknown> } : {}),
  };
}

/**
 * Apply one track edit to the working song: regenerate the song with the edit
 * recorded in its generator block, then splice the edited track into the
 * working song. Returns the new working song and the edited track's name.
 */
export function editTrack(working: Song, op: TrackEditRequest): { song: Song; track: string } {
  const params = generatorParams(working);
  const existing = recordedTrackEdits(params.params);
  const names = new Set(trackNames(working));
  const sectionNames = working.songStructure.map((s) => s.name);

  let recorded: RecordedTrackEdit | undefined;
  let track: string;
  /** For addTrack: the working sections the track plays in. */
  let activation: Set<string> | undefined;

  if (op.kind === 'changeSound' || op.kind === 'newPattern') {
    track = op.track;
    if (!names.has(track)) throw new TrackEditError(400, 'unknown_track', `The song has no track "${track}".`);
    const family = laneFamilyOf(track);
    if (!family || !working.instrumentDefinitions.some((d) => d.name === track)) {
      throw new TrackEditError(400, 'not_editable', `Track "${track}" is not generated from a pattern, so it can only be removed.`);
    }
    if (op.kind === 'changeSound') {
      if (family === 'drums') throw drumKitFixed();
      const sound = soundIn(family, params.genre, op.soundId);
      recorded = { kind: 'changeSound', track, soundId: sound };
    } else {
      const variant = 1 + existing.filter((e) => e.kind === 'newPattern' && e.track === track).length;
      recorded = { kind: 'newPattern', track, variant };
    }
  } else {
    for (const s of op.segments) {
      if (!sectionNames.includes(s)) throw new TrackEditError(400, 'unknown_section', `The song has no section "${s}".`);
    }
    activation = new Set(op.segments);
    if (op.family === 'drums' && op.soundId) throw drumKitFixed();
    const pool = familySoundPool(op.family, params.genre);
    if (op.family !== 'drums' && pool.length === 0) {
      throw new TrackEditError(400, 'no_sounds', `There are no ${FAMILY_LABELS[op.family].toLowerCase()} sounds for this genre.`);
    }
    const base = orchestrate(withEdits(params, existing));
    const generated = new Set(base.instrumentDefinitions.map((d) => d.name));
    if (op.family === 'drums') {
      // The engine plays one drum kit, the "Drums" track. Adding drums to a
      // song whose drum track was removed brings that track back.
      track = LANE_BASE_NAMES.drums;
      if (names.has(track)) throw new TrackEditError(400, 'drums_exist', 'The song already has a drum track; the engine plays one drum kit.');
      if (!generated.has(track)) throw new Error('editTrack: the generator produced no Drums track');
      recorded = undefined;
    } else {
      track = freeLaneName(op.family, new Set([...names, ...generated]));
      const soundId = op.soundId
        ? soundIn(op.family, params.genre, op.soundId)
        : createRng(params.seed).fork(`trackEdit/add/${track}`).pick(pool).id;
      const baseSections = base.songStructure.map((s) => s.name);
      const segments = [
        ...new Set(
          op.segments.map((name) => {
            if (baseSections.includes(name)) return name;
            const sameType = baseSections.find((b) => segmentType(b) === segmentType(name));
            if (!sameType) {
              throw new TrackEditError(400, 'unknown_section_type', `Cannot generate a pattern for section "${name}": the song's generator has no section of that kind.`);
            }
            return sameType;
          }),
        ),
      ];
      recorded = { kind: 'addTrack', track, family: op.family, soundId, segments };
    }
  }

  const edits = recorded ? [...existing, recorded] : existing;
  const regenerated = orchestrate(withEdits(params, edits));
  const spliced = spliceTrack(working, regenerated, track, activation);
  const song = parseSong({
    ...spliced,
    generator: {
      ...working.generator,
      params: {
        ...(working.generator!.params as Record<string, unknown>),
        params: { ...(params.params ?? {}), [TRACK_EDITS_PARAM]: edits },
      },
    },
  });
  return { song, track };
}

function withEdits(params: GenerateParams, edits: readonly RecordedTrackEdit[]): GenerateParams {
  const inner = { ...(params.params ?? {}) };
  if (edits.length > 0) inner[TRACK_EDITS_PARAM] = edits;
  else delete inner[TRACK_EDITS_PARAM];
  const { params: _drop, ...rest } = params;
  return Object.keys(inner).length > 0 ? { ...rest, params: inner } : rest;
}

function drumKitFixed(): TrackEditError {
  return new TrackEditError(400, 'drum_kit_fixed', 'The drum kit follows the genre; choosing a different kit is not supported yet.');
}

function soundIn(family: InstrumentFamily, genre: string, soundId: string): string {
  if (userSoundFor(family, genre, soundId)) return soundId;
  throw new TrackEditError(400, 'sound_not_in_family', `Sound ${soundId} is not a ${FAMILY_LABELS[family].toLowerCase()} sound.`);
}

/** `Keys`, else `Keys 2`, `Keys 3`, … — the first name not taken. */
function freeLaneName(family: InstrumentFamily, taken: ReadonlySet<string>): string {
  const base = LANE_BASE_NAMES[family];
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

type Bars = NonNullable<SegmentPayload['overrides'][string]['bars']>;

/** `bars` cut or repeated to `count` bars. */
function fitBars(bars: Bars, count: number): Bars {
  if (bars.length === 0) throw new Error('fitBars: no bars to fit');
  return Array.from({ length: count }, (_, i) => structuredClone(bars[i % bars.length]!));
}

const SIDE_BLOCKS = ['fills', 'mutes', 'signalProcessors'] as const;

/**
 * Copy track `track` from `regenerated` into `working`, section by section.
 * A working section takes the track from the regenerated section of the same
 * name, else from the first regenerated section of the same kind that has it.
 * `activation` (addTrack) says which sections the track plays in; otherwise
 * the working song's own on/off flags stay.
 */
export function spliceTrack(working: Song, regenerated: Song, track: string, activation?: ReadonlySet<string>): Song {
  const regenDef = regenerated.instrumentDefinitions.find((d) => d.name === track);
  if (!regenDef) throw new Error(`spliceTrack: the regenerated song has no track "${track}"`);
  const hasDef = working.instrumentDefinitions.some((d) => d.name === track);
  const instrumentDefinitions: InstrumentDefinition[] = hasDef
    ? working.instrumentDefinitions.map((d) => (d.name === track ? regenDef : d))
    : insertInGeneratorOrder(working.instrumentDefinitions, regenDef, regenerated.instrumentDefinitions.map((d) => d.name));

  const regenSections = regenerated.songStructure.map((s) => s.name);
  const sourceFor = (name: string): string | undefined => {
    if (regenerated.arrangement[name]?.overrides[track]) return name;
    return regenSections.find((r) => segmentType(r) === segmentType(name) && regenerated.arrangement[r]?.overrides[track]);
  };

  const arrangement: Record<string, SegmentPayload> = {};
  for (const seg of working.songStructure) {
    const wa = working.arrangement[seg.name];
    if (!wa) throw new Error(`spliceTrack: working song has no arrangement for section "${seg.name}"`);
    const next: SegmentPayload = structuredClone(wa);
    const active = activation ? activation.has(seg.name) : wa.instruments[track] === true || wa.overrides[track] !== undefined;
    if (activation) next.instruments[track] = active;
    if (active) {
      const src = sourceFor(seg.name);
      if (src) {
        const ra = regenerated.arrangement[src]!;
        const ov = ra.overrides[track]!;
        next.overrides[track] = { ...structuredClone(ov), ...(ov.bars ? { bars: fitBars(ov.bars, seg.bars.length) } : {}) };
        for (const block of SIDE_BLOCKS) {
          const v = (ra[block] as Record<string, unknown>)[track];
          if (v !== undefined) (next[block] as Record<string, unknown>)[track] = structuredClone(v);
          else delete (next[block] as Record<string, unknown>)[track];
        }
      } else if (activation) {
        throw new TrackEditError(400, 'no_pattern', `No pattern could be generated for "${track}" in section "${seg.name}".`);
      }
    } else if (activation) {
      delete next.overrides[track];
      for (const block of SIDE_BLOCKS) delete (next[block] as Record<string, unknown>)[track];
    }
    arrangement[seg.name] = next;
  }
  return { ...working, instrumentDefinitions, arrangement };
}

/** Insert `def` before the first definition the generator orders after it
 *  (tonal lanes before vocals and the loop, as orchestrate emits them). */
function insertInGeneratorOrder(
  defs: readonly InstrumentDefinition[],
  def: InstrumentDefinition,
  order: readonly string[],
): InstrumentDefinition[] {
  const rank = (name: string) => order.indexOf(name);
  const at = defs.findIndex((d) => rank(d.name) > rank(def.name));
  return at < 0 ? [...defs, def] : [...defs.slice(0, at), def, ...defs.slice(at)];
}
