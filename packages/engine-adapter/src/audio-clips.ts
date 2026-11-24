// Sung vocal takes → an `audioClips` engine instrument (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §4).
//
// An audioClips instrument is a general audio-clip lane: each clip names its own audio file and plays once from
// its section's start (sung vocals today; ACE-Step tracks later). With the song's vocals on, every `soulx-vocal`
// artifact attached to { segment, instrument: 'Vocal' } becomes one clip, read from the takes directory
// (CASPERAKI_VOCAL_TAKES_DIR, passed in as `vocalTakesDir`). Vocals off or absent: nothing (the Vocal track stays
// unlowered, silent). Whether each take is current is the brain's check before lowering, not the adapter's.

import type { Song } from '@casperaki/song-schema';

export const AUDIO_CLIPS_TYPE = 'audioClips';
const TAKE_URI = /^vocal-take:([0-9a-f]{64})\.wav$/u;

export interface AudioClip {
  readonly segment: string;
  /** The engine's sample key for this clip's audio. */
  readonly key: string;
  /** Absolute path of the audio file. */
  readonly sourcePath: string;
  readonly durationSec: number;
}

export function buildVocalClipsInst(
  song: Song,
  o: { vocalTakesDir: string | undefined; id: number; filenameIndex: number },
): { filename: string; json: Record<string, unknown> } | undefined {
  if (!song.vocals?.enabled) return undefined;
  const clips: AudioClip[] = [];
  for (const seg of song.songStructure) {
    const a = song.aiArtifacts.find(
      (x) => x.kind === 'soulx-vocal' && x.attachedTo.scope === 'segment' && x.attachedTo.segment === seg.name && x.attachedTo.instrument === 'Vocal',
    );
    if (!a) continue;
    const m = TAKE_URI.exec(a.output.uri);
    if (!m) throw new Error(`engine-adapter: the vocal take of ${seg.name} has an unknown uri "${a.output.uri}" (want vocal-take:<sha256>.wav)`);
    if (a.output.durationSeconds === undefined) throw new Error(`engine-adapter: the vocal take of ${seg.name} has no durationSeconds`);
    if (!o.vocalTakesDir) throw new Error('engine-adapter: the song has vocal takes but no takes directory was given (set CASPERAKI_VOCAL_TAKES_DIR)');
    clips.push({ segment: seg.name, key: `take-${m[1]}.wav`, sourcePath: `${o.vocalTakesDir.replace(/\/$/u, '')}/${m[1]}.wav`, durationSec: a.output.durationSeconds });
  }
  if (clips.length === 0) return undefined;
  return {
    filename: `inst-${o.filenameIndex}.json`,
    json: { id: o.id, name: 'Vocal', type: AUDIO_CLIPS_TYPE, lowLevelType: 'vocalsLaSinger', clips },
  };
}
