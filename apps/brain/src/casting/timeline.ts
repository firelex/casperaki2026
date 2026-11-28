// The casting video's timeline (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md, "The casting
// timeline"): the segments in video time, every spoken line with its start, end, mouth levels and gesture, and where
// the song's performance sits. Pure: the lines' lengths and levels come in measured.

import { isChorus } from './facts.js';
import { lineVoices } from './voices.js';
import { SCENES, type CastingScript, type Gesture, type SceneId, type Speaker } from './writer.js';

export type SegmentKind = 'backstage' | 'door' | 'talk' | 'performance' | 'verdicts';
export interface CastingTimeline {
  readonly binSeconds: number;
  readonly durationSeconds: number;
  readonly segments: readonly { readonly kind: SegmentKind; readonly startSeconds: number; readonly endSeconds: number }[];
  readonly lines: readonly {
    readonly id: string;
    readonly speaker: Speaker;
    readonly text: string;
    readonly gesture: Gesture;
    readonly startSeconds: number;
    readonly endSeconds: number;
    /** The line's loudness per bin of binSeconds from its start (the mouth). */
    readonly levels: readonly number[];
  }[];
  /** The song's part: from its start to the end of its first chorus, then a fade, placed at videoStartSeconds. */
  readonly performance: { readonly songFromSeconds: 0; readonly songToSeconds: number; readonly fadeSeconds: number; readonly videoStartSeconds: number };
  /** The castingScript task the lines come from. */
  readonly scriptTaskId: string;
  /** Where the applause starts: as the song begins to fade. */
  readonly applauseStartSeconds: number;
  /** The applause at the very end: from the end of the last line to the end of the video (FINAL_APPLAUSE seconds). */
  readonly finalApplauseStartSeconds: number;
  /** The fanfare: from half a second before the stage door (no gap after the backstage music), for its whole audible
   *  length (the first judge talks over its last FANFARE_OVERLAP seconds). */
  readonly doorMusic: { readonly startSeconds: number; readonly seconds: number };
}

/** Pauses between two lines of one segment, varied so the talk does not tick like a clock (the owner: "they speak
 *  robotically at fixed intervals"): the narrator 0.3-0.6 s; people 0.2-0.75 s, and a short interjection (8 words or
 *  fewer) by someone other than the last speaker sometimes cuts in, up to 0.25 s before the line before ends. */
const NARRATOR_GAP = [0.3, 0.6] as const;
const TALK_GAP = [0.2, 0.75] as const;
/** Right after the fanfare the exchange moves quickly (the owner: "the judges need to speak faster"). */
const MEETING_GAP = [0.1, 0.45] as const;
const OVERLAP = [-0.25, -0.05] as const;
/** The share of short interjections that cut in. */
const CUT_IN_CHANCE = 0.5;
const INTERJECTION_WORDS = 8;

/** A number from 0 to 1 fixed by `key` (the same script always gets the same timing). */
function unitHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h / 4294967296;
}
const between = ([lo, hi]: readonly [number, number], u: number) => lo + (hi - lo) * u;
/** The backstage music before the narrator starts. */
export const MUSIC_LEAD = 1.5;
/** Air at the start and end of a talking segment: the judges start talking soon after the singer reaches them. */
export const AIR = 0.4;
/** A second of silence before the song starts (the talk's music has faded to zero by then; the owner: "a second of
 *  silence, then we go"). */
export const PERFORMANCE_LEAD = 1;
/** The song fades out over this long after its first chorus. */
export const PERFORMANCE_FADE = 3;
/** The applause has this long on its own before the first verdict line comes in over it. */
export const APPLAUSE_LEAD = 2.5;
/** The fanfare starts this long before the stage door, over the backstage music's fade (no break between them). */
export const FANFARE_EARLY = 0.5;
/** The first judge starts talking this long before the fanfare ends (the owner: "the judges' intro could come earlier"). */
export const FANFARE_OVERLAP = 1.5;
/** The video ends with applause this long after the last line (the owner: "another applause at the very end"). */
export const FINAL_APPLAUSE = 5;

const SEGMENT_OF: Readonly<Record<SceneId, SegmentKind>> = { backstage: 'backstage', banter: 'talk', verdicts: 'verdicts' };

export function layOut(args: {
  script: CastingScript;
  spoken: ReadonlyMap<string, { seconds: number; levels: readonly number[] }>;
  sections: readonly { name: string; startSeconds: number; endSeconds: number }[];
  exportSeconds: number;
  entranceSeconds: number;
  binSeconds: number;
  scriptTaskId: string;
}): CastingTimeline {
  const chorus = args.sections.find((s) => isChorus(s.name));
  if (!chorus) throw new Error('casting: the song has no chorus, which the performance ends with');
  const songTo = chorus.endSeconds;
  if (songTo + PERFORMANCE_FADE > args.exportSeconds) {
    throw new Error(`casting: the song's first chorus ends at ${songTo.toFixed(1)} s (plus a ${PERFORMANCE_FADE} s fade), but its export is only ${args.exportSeconds.toFixed(1)} s long`);
  }
  const requests = lineVoices(args.script, { description: 'x', seed: 0, referenceText: 'x' }, '/');
  const segments: { kind: SegmentKind; startSeconds: number; endSeconds: number }[] = [];
  const lines: CastingTimeline['lines'][number][] = [];
  let t = 0;
  let k = 0;
  const speak = (scene: SceneId, lead: number, tail: number) => {
    const start = t;
    t += lead;
    args.script[scene].forEach((l, i) => {
      const id = requests[k++]!.id;
      const got = args.spoken.get(id);
      if (!got) throw new Error(`casting: the line ${id} was not spoken`);
      if (i > 0) {
        const prev = args.script[scene][i - 1]!;
        const u = unitHash(`${args.scriptTaskId}:${id}:gap`);
        const cutIn =
          l.speaker !== 'narrator' && l.speaker !== prev.speaker && l.text.split(/\s+/u).filter(Boolean).length <= INTERJECTION_WORDS && unitHash(`${args.scriptTaskId}:${id}:cut`) < CUT_IN_CHANCE;
        t += l.speaker === 'narrator' ? between(NARRATOR_GAP, u) : cutIn ? between(OVERLAP, u) : between(scene === 'banter' ? MEETING_GAP : TALK_GAP, u);
      }
      lines.push({ id, speaker: l.speaker, text: l.text, gesture: l.gesture, startSeconds: t, endSeconds: t + got.seconds, levels: got.levels });
      t += got.seconds;
    });
    t += tail;
    segments.push({ kind: SEGMENT_OF[scene], startSeconds: start, endSeconds: t });
  };
  let doorStart = 0;
  for (const scene of SCENES) {
    if (scene === 'backstage') {
      speak('backstage', MUSIC_LEAD, AIR);
      doorStart = t;
      segments.push({ kind: 'door', startSeconds: t, endSeconds: t + args.entranceSeconds - FANFARE_OVERLAP });
      t += args.entranceSeconds - FANFARE_OVERLAP;
    } else if (scene === 'banter') {
      // The judge speaks the moment the fanfare ends.
      speak('banter', 0, AIR);
      segments.push({ kind: 'performance', startSeconds: t, endSeconds: t + PERFORMANCE_LEAD + songTo + PERFORMANCE_FADE });
      t += PERFORMANCE_LEAD + songTo + PERFORMANCE_FADE;
    } else speak('verdicts', APPLAUSE_LEAD, FINAL_APPLAUSE);
  }
  const perf = segments.find((s) => s.kind === 'performance')!;
  return {
    binSeconds: args.binSeconds,
    durationSeconds: t,
    segments,
    lines,
    performance: { songFromSeconds: 0, songToSeconds: songTo, fadeSeconds: PERFORMANCE_FADE, videoStartSeconds: perf.startSeconds + PERFORMANCE_LEAD },
    scriptTaskId: args.scriptTaskId,
    applauseStartSeconds: perf.startSeconds + PERFORMANCE_LEAD + songTo,
    finalApplauseStartSeconds: t - FINAL_APPLAUSE,
    doorMusic: { startSeconds: doorStart - FANFARE_EARLY, seconds: args.entranceSeconds },
  };
}
