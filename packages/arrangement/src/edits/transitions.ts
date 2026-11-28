// Section transitions (risers, impacts, reverses, crashes, percussion fills,
// snare rolls) switched on or off by the user, for one section or several.
// A section holds at most one transition of each type (keyed by type), at the
// start, in the middle or at the end of the section.

import { createRng } from '@casperaki/music-theory';
import { baseGenre, parseSong, type Song } from '@casperaki/song-schema';

import { buildEdmSnareRollPattern } from '../arrangement-polish/edm-snare-roll.js';
import { EDM_SNARE_DRUM_ROLL, EDM_SNARE_ROLL_MAX_BARS } from '../arrangement-polish/transitions.js';
import { TrackEditError } from './track-edits.js';
import { loadValidatedCatalog } from '../catalog/validated-catalog.js';
import {
  finalChordRootForSegment,
  isSwappableTransition,
  isTransitionSoundFor,
  pickTransitionSound,
  resolveTransitionSound,
} from '../transitions/sound.js';

export type TransitionPlacement = 'beginningOfSegment' | 'midSegment' | 'endOfSegment';

/** The transitions the engine plays, with where each can sit (as the generator places them). */
export const TRANSITION_TYPES: readonly { type: string; label: string; placements: readonly TransitionPlacement[] }[] = [
  { type: 'cymbalsCrashHit', label: 'Crash', placements: ['beginningOfSegment'] },
  { type: 'fxHighImpact', label: 'High impact', placements: ['beginningOfSegment'] },
  { type: 'fxLowImpact', label: 'Low impact', placements: ['beginningOfSegment'] },
  { type: 'fxDownlifter', label: 'Downlifter', placements: ['beginningOfSegment'] },
  { type: 'fxTransition', label: 'Transition sweep', placements: ['beginningOfSegment'] },
  { type: 'fxReverse', label: 'Reverse', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxTonalReverse', label: 'Tonal reverse', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxNoiseRise', label: 'Noise rise', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxUplifter', label: 'Uplifter', placements: ['endOfSegment'] },
  { type: 'percussionBreaksFills', label: 'Percussion fill', placements: ['midSegment'] },
  { type: 'percussionBreaksBuildups', label: 'Percussion build-up', placements: ['midSegment'] },
  { type: EDM_SNARE_DRUM_ROLL, label: 'Snare roll', placements: ['endOfSegment'] },
];

export interface SetTransitionRequest {
  readonly segments: readonly string[];
  readonly type: string;
  readonly placement: TransitionPlacement;
  /** true: add, or change the placement / sound of the one already there; false: remove. */
  readonly on: boolean;
  /**
   * The sound to play (library-sound transitions only; for tonal reverses and
   * percussion fills / build-ups it names the pack — see ../transitions/sound.ts).
   * Left out: the sound already there is kept, a new transition gets the
   * generator's pick.
   */
  readonly soundId?: string;
}

export function setTransition(working: Song, req: SetTransitionRequest): Song {
  const def = TRANSITION_TYPES.find((t) => t.type === req.type);
  if (!def) throw new TrackEditError(400, 'unknown_transition', `Unknown transition "${req.type}".`);
  if (!def.placements.includes(req.placement)) {
    throw new TrackEditError(400, 'bad_placement', `${def.label} cannot sit at ${req.placement} (only ${def.placements.join(', ')}).`);
  }
  if (req.segments.length === 0) throw new TrackEditError(400, 'no_sections', 'Name at least one section.');
  if (req.soundId !== undefined) {
    if (!req.on) throw new TrackEditError(400, 'bad_request', 'A sound can only be given when switching a transition on.');
    if (!isSwappableTransition(req.type)) throw new TrackEditError(400, 'not_swappable', `The ${def.label.toLowerCase()} has no sound to choose.`);
    if (!isTransitionSoundFor(loadValidatedCatalog(), req.type, req.soundId)) {
      throw new TrackEditError(400, 'sound_not_for_transition', `Sound ${req.soundId} is not a ${def.label.toLowerCase()} sound.`);
    }
  }
  const arrangement = { ...working.arrangement };
  for (const name of req.segments) {
    const seg = working.songStructure.find((s) => s.name === name);
    const payload = arrangement[name];
    if (!seg || !payload) throw new TrackEditError(400, 'unknown_section', `The song has no section "${name}".`);
    const transitions = { ...(payload.transitions ?? {}) } as Record<string, unknown>;
    if (!req.on) {
      delete transitions[req.type];
    } else {
      const existing = transitions[req.type] as Record<string, unknown> | undefined;
      const entry: Record<string, unknown> = { ...(existing ?? {}), type: req.type, placement: req.placement };
      if (isSwappableTransition(req.type)) {
        entry['soundId'] = soundFor(working, seg, req, existing);
      }
      if (req.type === EDM_SNARE_DRUM_ROLL && !existing) {
        const bars = Math.min(seg.bars.length, EDM_SNARE_ROLL_MAX_BARS);
        const seed = String((working.generator?.params as { seed?: unknown } | undefined)?.seed ?? working.title);
        const roll = buildEdmSnareRollPattern(createRng(`${seed}/userSnareRoll/${name}`), bars);
        entry['pattern'] = roll.pattern;
        entry['lengthInBars'] = roll.lengthInBars;
      }
      transitions[req.type] = entry;
    }
    arrangement[name] = { ...payload, transitions } as typeof payload;
  }
  return parseSong({ ...working, arrangement });
}

/** The sound a transition plays in a section: the one asked for, the one already there, or the generator's pick. */
function soundFor(
  working: Song,
  seg: Song['songStructure'][number],
  req: SetTransitionRequest,
  existing: Record<string, unknown> | undefined,
): string {
  const catalog = loadValidatedCatalog();
  const label = TRANSITION_TYPES.find((t) => t.type === req.type)!.label.toLowerCase();
  const ctx = { tempo: working.bpm, finalChordRoot: finalChordRootForSegment(seg.bars) };
  const wanted = req.soundId ?? (typeof existing?.['soundId'] === 'string' ? (existing['soundId'] as string) : undefined);
  if (wanted) {
    // A tonal pack must have a recording in this section's key.
    try {
      resolveTransitionSound(catalog, req.type, wanted, ctx);
    } catch (err) {
      throw new TrackEditError(400, 'sound_does_not_fit', `${seg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return wanted;
  }
  if (!working.genre) throw new TrackEditError(400, 'no_genre', 'The song has no genre to pick a transition sound for.');
  const seed = String((working.generator?.params as { seed?: unknown } | undefined)?.seed ?? working.title);
  const picked = pickTransitionSound(catalog, req.type, { genre: baseGenre(working.genre), ...ctx }, `${seed}/user`, seg.name);
  if (!picked) throw new TrackEditError(400, 'no_sound', `No ${label} recording fits ${seg.name}.`);
  return picked.entry.id;
}
