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
}

/** Between two lines of one segment (natural turn-taking). */
export const LINE_GAP = 0.35;
/** The backstage music before the narrator starts. */
export const MUSIC_LEAD = 1.5;
/** Air at the start and end of a talking segment. */
export const AIR = 1;
/** The song fades out over this long after its first chorus. */
export const PERFORMANCE_FADE = 3;
/** The video ends this long after the last verdict. */
export const END_TAIL = 1.5;

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
  const requests = lineVoices(args.script, { description: '', seed: 0 });
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
      if (i > 0) t += LINE_GAP;
      lines.push({ id, speaker: l.speaker, text: l.text, gesture: l.gesture, startSeconds: t, endSeconds: t + got.seconds, levels: got.levels });
      t += got.seconds;
    });
    t += tail;
    segments.push({ kind: SEGMENT_OF[scene], startSeconds: start, endSeconds: t });
  };
  for (const scene of SCENES) {
    if (scene === 'backstage') {
      speak('backstage', MUSIC_LEAD, AIR);
      segments.push({ kind: 'door', startSeconds: t, endSeconds: t + args.entranceSeconds });
      t += args.entranceSeconds;
    } else if (scene === 'banter') {
      speak('banter', AIR, AIR);
      segments.push({ kind: 'performance', startSeconds: t, endSeconds: t + songTo + PERFORMANCE_FADE });
      t += songTo + PERFORMANCE_FADE;
    } else speak('verdicts', AIR, END_TAIL);
  }
  const perf = segments.find((s) => s.kind === 'performance')!;
  return {
    binSeconds: args.binSeconds,
    durationSeconds: t,
    segments,
    lines,
    performance: { songFromSeconds: 0, songToSeconds: songTo, fadeSeconds: PERFORMANCE_FADE, videoStartSeconds: perf.startSeconds },
    scriptTaskId: args.scriptTaskId,
  };
}
