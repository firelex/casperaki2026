// A Casperaki song as the music-video engine (@casperaki/video) sees it: the
// engine never reads a Casperaki song; this adapter builds its AvatarVideoInput.

import { AvatarVideoInputSchema, type AvatarVideoInput } from '@casperaki/video';
import { z } from 'zod';
import type { Song } from '@casperaki/song-schema';

export class VideoInputError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BEATS_PER_BAR = 4;
/** The lead vocal track (backing vocals sing the same words). */
/** Bars per lyric line: the lyric bank writes one rhyme line per 4 bars (vocals/scaffolding.ts). */
const LINE_BARS = 4;
const LEAD_VOCAL = 'Vocal';

/** "verse1" → "Verse 1", "preChorus2" → "Pre-chorus 2", "intro" → "Intro". */
export function sectionDisplayName(name: string): string {
  const m = /^([A-Za-z]+?)(\d*)$/u.exec(name);
  if (!m) return name;
  const words = m[1]!.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return m[2] ? `${label} ${m[2]}` : label;
}

interface SungNote {
  readonly start: number; // seconds
  readonly end: number; // seconds
  readonly word: string;
  readonly endOfPhrase: boolean;
}

/**
 * The song's lyric lines with their times: the lead vocal's notes in order,
 * syllables joined into words ("Wal-" + "King" → "Walking"; the lyric bank
 * capitalises every syllable), one line per 4-bar block from each section's
 * start (the lyric bank's rhyme lines), so a banner carries a sentence.
 */
export function lyricLines(song: Song): AvatarVideoInput['lyrics'] {
  const secPerBeat = 60 / song.bpm;
  // Sung syllables in order, each tagged with its line: 4-bar blocks from each
  // section's start, the lyric bank's rhyme lines.
  const notes: (SungNote & { line: string })[] = [];
  let barStart = 0;
  for (const seg of song.songStructure) {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const part = song.arrangement[seg.name]?.overrides?.[LEAD_VOCAL];
    (part?.bars ?? []).slice(0, bars).forEach((bar, barIdx) => {
      const events = Object.entries(bar.notes ?? {})
        .flatMap(([beat, evs]) => (evs ?? []).map((e) => ({ beat: Number.parseFloat(beat), e: e as { type?: string; duration?: number; fullWord?: string } })))
        .filter(({ e }) => e.type === 'vocalNote' && typeof e.fullWord === 'string' && e.fullWord.length > 0)
        .sort((x, y) => x.beat - y.beat);
      for (const { beat, e } of events) {
        const startBeat = (barStart + barIdx) * BEATS_PER_BAR + beat;
        notes.push({
          start: startBeat * secPerBeat,
          end: (startBeat + (e.duration ?? 0)) * secPerBeat,
          word: e.fullWord!,
          endOfPhrase: false,
          line: `${seg.name}#${Math.floor(barIdx / LINE_BARS)}`,
        });
      }
    });
    barStart += bars;
  }

  const lines: AvatarVideoInput['lyrics'] = [];
  let words: string[] = [];
  let pending = ''; // a syllable ending in "-" waiting for the rest of its word
  let lineStart: number | undefined;
  let lineEnd = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    const next = notes[i + 1];
    lineStart ??= n.start;
    lineEnd = Math.max(lineEnd, n.end);
    // A syllable continuing a word keeps the word's capitalisation (the lyric
    // bank capitalises every syllable: "Wal-" + "King" → "Walking").
    const syllable = pending ? n.word.charAt(0).toLowerCase() + n.word.slice(1) : n.word;
    if (syllable.endsWith('-')) pending += syllable.slice(0, -1);
    else {
      words.push(pending + syllable);
      pending = '';
    }
    // A line ends with its block. A word whose last syllable is never sung
    // (the melody ran out of notes) shows as sung, without its hyphen.
    if (next === undefined || next.line !== n.line) {
      if (pending) {
        words.push(pending);
        pending = '';
      }
      if (words.length && lineEnd > lineStart) lines.push({ text: words.join(' '), startSeconds: round(lineStart), endSeconds: round(lineEnd) });
      words = [];
      lineStart = undefined;
      lineEnd = 0;
    }
  }
  return lines;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

export interface VideoAudio {
  /** Absolute path of the song's exported mix. */
  readonly path: string;
  readonly durationSeconds: number;
}

/** The song's timing as the video engines see it: tempo, bars and sections in seconds. */
export function songTiming(song: Song): Pick<AvatarVideoInput, 'bpm' | 'firstBeatSeconds' | 'beatsPerBar' | 'sections'> {
  const secPerBar = (BEATS_PER_BAR * 60) / song.bpm;
  let bar = 0;
  const sections = song.songStructure.map((seg) => {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const s = { name: sectionDisplayName(seg.name), startSeconds: round(bar * secPerBar), endSeconds: round((bar + bars) * secPerBar) };
    bar += bars;
    return s;
  });
  return { bpm: song.bpm, firstBeatSeconds: 0, beatsPerBar: BEATS_PER_BAR, sections };
}

/** The levels the browser measured for one version of the song (src/editor/trackLevels.ts): the master's and each
 *  track's peak level per bin of binSeconds, with the track's role (the lead vocal's drive the singer's mouth). */
const MeasuredLevelsSchema = z
  .object({
    versionKey: z.string().regex(/^[0-9a-f]{16}$/u, 'a version key is 16 hex digits'),
    binSeconds: z.number().positive(),
    master: z.array(z.number().min(0)).min(1),
    tracks: z.array(z.object({ name: z.string().min(1), role: z.enum(['track', 'leadVocal', 'effects']), levels: z.array(z.number().min(0)) }).strict()),
  })
  .strict();
export type MeasuredLevels = z.infer<typeof MeasuredLevelsSchema>;

/** Parses the browser's measured levels; throws VideoInputError(400) naming the first problem. */
export function parseMeasuredLevels(raw: unknown): MeasuredLevels {
  const parsed = MeasuredLevelsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new VideoInputError(400, 'invalid_body', `levels${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`);
  }
  const bins = parsed.data.master.length;
  const uneven = parsed.data.tracks.find((t) => t.levels.length !== bins);
  if (uneven) throw new VideoInputError(400, 'invalid_body', `levels: track "${uneven.name}" has ${uneven.levels.length} levels, the master ${bins}; every track is measured over the same bins`);
  return parsed.data;
}

/** How far the measured levels' length may differ from the exported audio's: the browser renders the song itself to
 *  measure it, and the export's MP3 is a little longer or shorter (encoder padding, effect tails). */
export const LEVELS_LENGTH_TOLERANCE_SECONDS = 2;

/** One section of a dance floor video's storyboard: where it happens, which of the video's avatars are in it (the
 *  user's avatar ids) and how it is filmed (the engine's AVATAR_SCENES and AVATAR_CAMERAS ids). */
export interface VideoStoryboardEntry {
  readonly scene: string;
  readonly avatarIds: readonly string[];
  readonly camera: string;
}

/** The engine's id for one of the user's avatars (letters and digits: it seeds the avatar's dance moves). */
export const engineAvatarId = (id: string): string => id.replace(/[^a-zA-Z0-9]/gu, '');

/** Throws VideoInputError(400) naming the problem unless the storyboard has one entry per section, each with a known
 *  scene and camera and at least one of the video's avatars (none twice). */
export function checkStoryboard(storyboard: readonly VideoStoryboardEntry[], sections: readonly { name: string }[], avatarIds: readonly string[], scenes: readonly string[], cameras: readonly string[]): void {
  if (storyboard.length !== sections.length) {
    throw new VideoInputError(400, 'invalid_storyboard', `The storyboard has ${storyboard.length} sections, the song ${sections.length}: open the Video tab again.`);
  }
  storyboard.forEach((e, i) => {
    const where = `Storyboard, ${sections[i]!.name}`;
    if (!scenes.includes(e.scene)) throw new VideoInputError(400, 'invalid_storyboard', `${where}: there is no scene "${e.scene}".`);
    if (!cameras.includes(e.camera)) throw new VideoInputError(400, 'invalid_storyboard', `${where}: there is no camera "${e.camera}".`);
    if (e.avatarIds.length === 0) throw new VideoInputError(400, 'invalid_storyboard', `${where}: choose at least one avatar.`);
    if (new Set(e.avatarIds).size !== e.avatarIds.length) throw new VideoInputError(400, 'invalid_storyboard', `${where}: an avatar is listed twice.`);
    const stranger = e.avatarIds.find((id) => !avatarIds.includes(id));
    if (stranger) throw new VideoInputError(400, 'invalid_storyboard', `${where}: the avatar "${stranger}" is not one of the video's avatars.`);
  });
}

/** One of the user's avatars in a video: its name, recipe, and whether it is the lead (sings the song). */
export interface VideoAvatar {
  readonly id: string;
  readonly name: string;
  readonly recipe: AvatarVideoInput['avatars'][number]['recipe'];
  readonly sings: boolean;
}

/** The engine's AvatarVideoInput: the song's timing and words, the master's level and the lead vocal's (the loudest
 *  lead-vocal strip per bin; silence when the song has none), both fitted to the audio (within LEVELS_LENGTH_TOLERANCE_SECONDS; a larger difference is
 *  left for the engine's check to refuse), and the
 *  avatars (ids made letters and digits: the engine seeds each one's dance moves with it). */
export function songToAvatarInput(args: {
  title: string;
  artist: string;
  song: Song;
  audio: VideoAudio;
  levels: Omit<MeasuredLevels, 'versionKey'>;
  avatars: readonly VideoAvatar[];
  /** Per section (checked with checkStoryboard); absent: every section in the club, everyone, automatic camera. */
  storyboard?: readonly VideoStoryboardEntry[];
}): AvatarVideoInput {
  const { binSeconds } = args.levels;
  const bins = Math.round(args.audio.durationSeconds / binSeconds);
  const measured = args.levels.master.length * binSeconds;
  const fit = Math.abs(measured - args.audio.durationSeconds) <= LEVELS_LENGTH_TOLERANCE_SECONDS;
  const fitted = (levels: readonly number[]) =>
    fit ? Array.from({ length: bins }, (_, i) => (i < levels.length ? levels[i]! : 0)) : [...levels];
  const leads = args.levels.tracks.filter((t) => t.role === 'leadVocal');
  const voice = args.levels.master.map((_, i) => leads.reduce((m, t) => Math.max(m, t.levels[i] ?? 0), 0));
  return AvatarVideoInputSchema.parse({
    title: args.title,
    artist: args.artist,
    audio: { path: args.audio.path, durationSeconds: args.audio.durationSeconds },
    ...songTiming(args.song),
    ...(args.song.genre ? { genre: args.song.genre } : {}),
    lyrics: lyricLines(args.song),
    binSeconds,
    master: fitted(args.levels.master),
    voice: fitted(voice),
    avatars: args.avatars.map((a) => ({ id: engineAvatarId(a.id), name: a.name, recipe: a.recipe, sings: a.sings })),
    ...(args.storyboard ? { storyboard: args.storyboard.map((e) => ({ scene: e.scene, avatars: e.avatarIds.map(engineAvatarId), camera: e.camera })) } : {}),
  });
}
