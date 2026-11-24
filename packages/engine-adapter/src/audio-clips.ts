// Sung vocal takes → an `audioClips` engine instrument (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §4).
//
// An audioClips instrument is a general audio-clip lane: each clip names its own audio file and plays once from
// its section's start (sung vocals today; ACE-Step tracks later). Every `soulx-vocal` artifact attached to
// { segment, instrument: 'Vocal' } becomes one clip, read from the takes directory (CASPERAKI_VOCAL_TAKES_DIR,
// passed in as `vocalTakesDir`). The brain puts on the song exactly the stored takes that match its sections now
// (takes are found by fingerprint, not saved with the song). No takes: nothing (the Vocal track stays silent).

import type { Song } from '@casperaki/song-schema';

export const AUDIO_CLIPS_TYPE = 'audioClips';
const TAKE_URI = /^vocal-take:([0-9a-f]{64})\.ogg$/u;

export interface AudioClip {
  readonly segment: string;
  /** The engine's sample key for this clip's audio. */
  readonly key: string;
  /** Absolute path of the audio file. */
  readonly sourcePath: string;
  readonly durationSec: number;
}

/** One audioClips instrument per vocal track that has takes (the lead "Vocal" first, then the backing tracks in the
 *  order their takes appear), each its own lane. */
export function buildVocalClipsInsts(
  song: Song,
  o: { vocalTakesDir: string | undefined; firstId: number; firstFilenameIndex: number },
): { filename: string; json: Record<string, unknown> }[] {
  const takes = song.aiArtifacts.filter((a) => a.kind === 'soulx-vocal' && a.attachedTo.scope === 'segment' && a.attachedTo.instrument);
  const tracks = [...new Set(takes.map((a) => (a.attachedTo as { instrument: string }).instrument))].sort((a, b) => (a === 'Vocal' ? -1 : b === 'Vocal' ? 1 : 0));
  return tracks.map((track, i) => {
    const clips: AudioClip[] = [];
    for (const seg of song.songStructure) {
      const a = takes.find((x) => x.attachedTo.scope === 'segment' && x.attachedTo.segment === seg.name && x.attachedTo.instrument === track);
      if (!a) continue;
      const m = TAKE_URI.exec(a.output.uri);
      if (!m) throw new Error(`engine-adapter: the ${track} take of ${seg.name} has an unknown uri "${a.output.uri}" (want vocal-take:<sha256>.ogg)`);
      if (a.output.durationSeconds === undefined) throw new Error(`engine-adapter: the ${track} take of ${seg.name} has no durationSeconds`);
      if (!o.vocalTakesDir) throw new Error('engine-adapter: the song has vocal takes but no takes directory was given (set CASPERAKI_VOCAL_TAKES_DIR)');
      clips.push({ segment: seg.name, key: `take-${m[1]}.ogg`, sourcePath: `${o.vocalTakesDir.replace(/\/$/u, '')}/${m[1]}.ogg`, durationSec: a.output.durationSeconds });
    }
    return {
      filename: `inst-${o.firstFilenameIndex + i}.json`,
      json: { id: o.firstId + i, name: track, type: AUDIO_CLIPS_TYPE, lowLevelType: 'vocalsLaSinger', clips },
    };
  });
}
