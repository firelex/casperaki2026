// Engine previews for the sounds that are not tonal patterns (those are in
// previewSong.ts): every sound on the Sounds page plays through the playback
// engine, as a song would play it, never as its raw file.
//
//   drum hits    the hit on its own, once: the Drums track (with the style's
//                drum processing) plays it in its first kit position (a snare
//                as Snare 1) on the first beat of a two-bar section.
//   loops        the Loop track (as songs play percussion loops) at the loop's
//                own tempo, for the loop's whole length; looped. Wobble basses
//                (tempo loops, not playable notes) play the same way.
//   one-shots    a transition carrying this sound in a section long enough
//                for its tail: effects and transition sounds once; percussion
//                breaks at their own tempo, looped; tonal reverses in their
//                own key (the section's final chord); single percussion hits
//                (never used in songs yet) once per bar, looped.

import { drumRolesForFamily, editTrack, orchestrate, PREVIEW_ONLY_TRANSITION_TAGS, TRANSITION_SOUND_LANES, type DrumRole, type ValidatedCatalogEntry } from '@casperaki/arrangement';
import { DEFAULT_BPM_BY_GENRE, GenreSchema, parseSong, type Song } from '@casperaki/song-schema';

/** Drum note per kit position, as the engine adapter maps them (the pedal hi-hat is not played). */
const DRUM_PITCH: Readonly<Partial<Record<DrumRole, number>>> = {
  bassDrum1: 36, bassDrum2: 35, snareDrum1: 38, snareDrum2: 40, hiHatClosed1: 42, hiHatClosed2: 44,
  hiHatOpen: 46, ride: 51, crash1: 49, crash2: 57, clap: 39, snap: 31, shaker: 70, tom1: 50, tom2: 47, tom3: 43,
};

export const DRUM_PREVIEW_SECTION = 'chorus1';
/** The generator writes this many bars; the hit preview keeps the first DRUM_HIT_PREVIEW_BARS. */
const DRUM_PREVIEW_BARS = 4;
/** The carrier song's style for one-shot / loop previews (it only chooses the unused drum kit). */
export const SAMPLE_PREVIEW_GENRE = 'brightPop';

/** The kit positions a drum hit fills in its preview (pedal hi-hat excluded: the engine does not play it). */
export function drumPreviewRoles(family: string): DrumRole[] {
  return drumRolesForFamily(family).filter((r) => DRUM_PITCH[r] !== undefined);
}

/** Styles a drum hit can be heard in (every genre), the sound's own first: the first sets the drum processing. */
export function drumPreviewGenres(mainStyle: string | null): string[] {
  const all = [...GenreSchema.options];
  return mainStyle && all.includes(mainStyle as (typeof all)[number]) ? [mainStyle, ...all.filter((g) => g !== mainStyle)] : all;
}

export const DRUM_HIT_PREVIEW_BARS = 2;
const DRUM_HIT_PREVIEW_BPM = 120;

/** A drum hit on its own: one hit in its first kit position, on beat 1 of a two-bar section (room for a cymbal's ring). */
export function drumHitPreviewSong(entry: ValidatedCatalogEntry, roles: readonly DrumRole[], genre: string): { song: Song; bpm: number } {
  const role = roles[0];
  if (!role) throw new Error(`drum preview: ${entry.family} fills no kit position`);
  const g = GenreSchema.parse(genre);
  let song = orchestrate({ genre: g, key: 'C', bpm: DRUM_HIT_PREVIEW_BPM, seed: 'drum-hit-preview', params: { structure: [{ name: DRUM_PREVIEW_SECTION, bars: DRUM_PREVIEW_BARS }] } });
  song = editTrack(song, { kind: 'setDrumSound', role, soundId: entry.id }).song;
  const payload = song.arrangement[DRUM_PREVIEW_SECTION];
  const override = payload?.overrides?.['Drums'];
  const def = song.instrumentDefinitions.find((d) => d.name === 'Drums');
  const seg = song.songStructure[0];
  if (!payload || !override?.bars?.length || !def || !seg) throw new Error(`drum preview: the ${g} generator wrote no drum part`);
  const bars = override.bars.slice(0, DRUM_HIT_PREVIEW_BARS).map((b, i) => ({ ...b, notes: i === 0 ? { '0.0': [{ type: 'note', note: DRUM_PITCH[role]! }] } : {} }) as typeof b);
  const processors = payload.signalProcessors?.['Drums'];
  const only = parseSong({
    ...song,
    songStructure: [{ ...seg, lengthInBars: DRUM_HIT_PREVIEW_BARS, bars: seg.bars.slice(0, DRUM_HIT_PREVIEW_BARS) }],
    arrangement: {
      [DRUM_PREVIEW_SECTION]: {
        ...payload,
        instruments: { Drums: true },
        overrides: { Drums: { ...override, bars } },
        fills: {},
        mutes: {},
        transitions: {},
        signalProcessors: processors ? { Drums: processors } : {},
      },
    },
    instrumentDefinitions: [def],
    aiArtifacts: [],
  });
  return { song: only, bpm: DRUM_HIT_PREVIEW_BPM };
}

/** How a non-pattern sound is previewed. */
export type SamplePlan =
  | { readonly kind: 'loop'; readonly bpm: number }
  | {
      readonly kind: 'oneShot';
      readonly tag: string;
      readonly placement: 'beginningOfSegment' | 'endOfSegment';
      /** Song tempo: the row's own (bpm-matched breaks) or 120. */
      readonly bpm: number;
      readonly loop: boolean;
      /** Tonal reverses: the key the section must end on. */
      readonly key?: string;
    };

const TAIL_TAGS: ReadonlySet<string> = new Set(['fxReverse', 'fxTonalReverse', 'fxUplifter', 'percussionBreaksBuildups', 'percussionBreaksFills', 'fxNoiseRiseSample']);
const ONE_SHOT_BPM = 120;

/** The transition tag that plays rows of this family / lowLevel (crash hits are drum hits, not here). */
function tagFor(e: Pick<ValidatedCatalogEntry, 'family' | 'lowLevel'>): string | undefined {
  for (const [tag, lane] of Object.entries(TRANSITION_SOUND_LANES)) {
    if (lane.family === e.family && lane.lowLevel === e.lowLevel) return tag;
  }
  return undefined;
}

/** Tempo of a tempo loop: the catalog's, else the one in its file name ("… - 120.mp3"). */
function loopBpm(e: ValidatedCatalogEntry): number | undefined {
  if (typeof e.bpm === 'number' && e.bpm > 0) return e.bpm;
  const m = /- (\d{2,3})\.(mp3|wav|ogg)$/iu.exec(e.matchedPath);
  return m ? Number(m[1]) : undefined;
}

/**
 * The sample plan for a validated sound that is not a tonal or drum pattern,
 * or why it cannot be previewed (a reason string).
 */
export function samplePlanFor(e: ValidatedCatalogEntry): SamplePlan | string {
  if (e.family === 'percussionLoops' || (e.family === 'basses' && e.lowLevel === 'bassesSynthWobble')) {
    const bpm = loopBpm(e);
    return bpm ? { kind: 'loop', bpm } : 'its tempo is unknown';
  }
  const tag = tagFor(e);
  if (!tag) return `no engine lane plays ${e.lowLevel}`;
  const placement = TAIL_TAGS.has(tag) ? 'endOfSegment' : 'beginningOfSegment';
  if (e.family === 'percussionBreaks') {
    if (typeof e.bpm !== 'number') return 'its tempo is unknown';
    return { kind: 'oneShot', tag, placement, bpm: e.bpm, loop: true };
  }
  if (tag === 'fxTonalReverse') {
    if (!e.key) return 'its key is unknown';
    return { kind: 'oneShot', tag, placement, bpm: ONE_SHOT_BPM, loop: false, key: e.key };
  }
  const isPerc = PREVIEW_ONLY_TRANSITION_TAGS.has(tag) && e.family === 'percussionMisc';
  return { kind: 'oneShot', tag, placement, bpm: ONE_SHOT_BPM, loop: isPerc };
}

/** Bars that hold `seconds` at `bpm` (4/4), at least `min`. */
export function barsFor(seconds: number, bpm: number, min: number): number {
  if (!(seconds > 0)) throw new Error(`sample preview: bad duration ${seconds}`);
  return Math.max(min, Math.ceil((seconds * bpm) / 240 - 1e-6));
}

const SECTION = 'verse1';
const CARRIER_BARS = 8;

/** The carrier song for a loop or one-shot preview: nothing but that sound. */
export function samplePreviewSong(e: ValidatedCatalogEntry, plan: SamplePlan, bars: number, publicName: string): Song {
  const base = orchestrate({
    genre: SAMPLE_PREVIEW_GENRE,
    key: 'C',
    bpm: plan.bpm,
    seed: 'sample-preview',
    // The generator needs a regular length; the section is then set to `bars`
    // (it carries no parts, only this sound, so nothing else depends on its length).
    params: { structure: [{ name: SECTION, bars: CARRIER_BARS }] },
  });
  const payload = base.arrangement[SECTION];
  const seg = base.songStructure[0];
  if (!payload || !seg?.bars[0]) throw new Error('sample preview: the generator wrote no section');
  // Tonal reverses play the recording in the section's final-chord key.
  const chords = plan.kind === 'oneShot' && plan.key ? [plan.key] : seg.bars[0].chords;
  const songStructure: unknown = [{ ...seg, lengthInBars: bars, bars: Array.from({ length: bars }, () => ({ ...seg.bars[0], chords })) }]; // validated by parseSong below
  const instrumentDefinitions =
    plan.kind === 'loop'
      ? [
          {
            id: e.id,
            name: 'Loop',
            shortName: publicName,
            type: 'percussionLoops',
            lowLevelType: e.lowLevel,
            instrumentGroup: 'percussion',
            isSample: true,
            isVst: false,
            details: { bpm: plan.bpm },
          },
        ]
      : [];
  return parseSong({
    ...base,
    songStructure,
    instrumentDefinitions,
    arrangement: {
      [SECTION]: {
        ...payload,
        instruments: plan.kind === 'loop' ? { Loop: true } : {},
        overrides: {},
        fills: {},
        mutes: {},
        transitions: plan.kind === 'oneShot' ? { [plan.tag]: { type: plan.tag, placement: plan.placement, soundId: e.id } } : {},
        signalProcessors: {},
      },
    },
    aiArtifacts: [],
  });
}
