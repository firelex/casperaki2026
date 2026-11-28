// Sung vocal takes → an `audioClips` engine instrument (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §4).
//
// An audioClips instrument is a general audio-clip lane: each clip names its own audio file and plays once from
// its section's start (sung vocals today; ACE-Step tracks later). Every sung-take artifact (`yue2-vocal` or `soulx-vocal`) attached to
// { segment, instrument: 'Vocal' } becomes one clip, read from the takes directory (CASPERAKI_VOCAL_TAKES_DIR,
// passed in as `vocalTakesDir`). The brain puts on the song exactly the stored takes that match its sections now
// (takes are found by fingerprint, not saved with the song). No takes: nothing (the Vocal track stays silent).

import { ACE_LAYER_KIND, ACE_MIX_TYPES, aceInstrumentOfTrack, isTakeFresh, SUNG_TAKE_KINDS, type Song } from '@casperaki/song-schema';

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

/** Effect sends (dB, -100 = no send) carried in the instrument JSON for the engine to honour. */
// Every vocal gets a light reverb and delay (owner, 2026-11-25: reverb -14 dB, delay -24 dB, no chorus). The two lanes
// stay separate so YuE2 and SoulX takes can be mixed apart again.
export const DRY_SENDS = { reverb: -14, delay: -24, chorus: -100 } as const;
export const WET_SENDS = { reverb: -14, delay: -24, chorus: -100 } as const;

/** Up to two audioClips instruments per vocal track that has fresh takes: `<track>` (dry, YuE2 takes) and
 *  `<track> wet` (SoulX takes, with reverb and delay). The lead "Vocal" comes first, then the other tracks in the
 *  order their takes appear; dry before wet. Muted takes are left out. The wet lane name has no parentheses because the mixer's baseName
 *  strips a trailing "(...)". Takes that no longer match the song's chords and words are left out. */
export function buildVocalClipsInsts(
  song: Song,
  o: { vocalTakesDir: string | undefined; firstId: number; firstFilenameIndex: number },
): { filename: string; json: Record<string, unknown> }[] {
  const takes = song.aiArtifacts.filter(
    (a) =>
      ((SUNG_TAKE_KINDS as readonly string[]).includes(a.kind) || a.kind === ACE_LAYER_KIND) &&
      a.attachedTo.scope === 'segment' &&
      a.attachedTo.instrument &&
      a.muted !== true &&
      isTakeFresh(song, a),
  );
  const trackOf = (a: (typeof takes)[number]) => (a.attachedTo as { instrument: string }).instrument;
  const tracks = [...new Set(takes.map(trackOf))].sort((a, b) => (a === 'Vocal' ? -1 : b === 'Vocal' ? 1 : 0));
  // An ACE layer (docs/superpowers/specs/2026-11-25-ace-layer-design.md) is one lane, mixed as its instrument.
  const aceType = (track: string) => {
    const instrument = aceInstrumentOfTrack(track);
    if (!instrument) throw new Error(`engine-adapter: ACE layer clips on "${track}", which is not an ACE layer track name`);
    return ACE_MIX_TYPES[instrument];
  };
  const lanes = tracks.flatMap((track) => [
    { track, name: track, kind: 'yue2-vocal', sends: DRY_SENDS as typeof DRY_SENDS | undefined, lowLevelType: 'vocalsLaSinger' },
    { track, name: `${track} wet`, kind: 'soulx-vocal', sends: WET_SENDS as typeof DRY_SENDS | typeof WET_SENDS | undefined, lowLevelType: 'vocalsLaSinger' },
    ...(takes.some((a) => trackOf(a) === track && a.kind === ACE_LAYER_KIND) ? [{ track, name: track, kind: ACE_LAYER_KIND, sends: undefined, lowLevelType: aceType(track) }] : []),
  ]).filter((l) => takes.some((a) => trackOf(a) === l.track && a.kind === l.kind));
  return lanes.map((lane, i) => {
    const clips: AudioClip[] = [];
    for (const seg of song.songStructure) {
      const a = takes.find((x) => x.attachedTo.scope === 'segment' && x.attachedTo.segment === seg.name && trackOf(x) === lane.track && x.kind === lane.kind);
      if (!a) continue;
      const m = TAKE_URI.exec(a.output.uri);
      if (!m) throw new Error(`engine-adapter: the ${lane.track} take of ${seg.name} has an unknown uri "${a.output.uri}" (want vocal-take:<sha256>.ogg)`);
      if (a.output.durationSeconds === undefined) throw new Error(`engine-adapter: the ${lane.track} take of ${seg.name} has no durationSeconds`);
      if (!o.vocalTakesDir) throw new Error('engine-adapter: the song has vocal takes but no takes directory was given (set CASPERAKI_VOCAL_TAKES_DIR)');
      clips.push({ segment: seg.name, key: `take-${m[1]}.ogg`, sourcePath: `${o.vocalTakesDir.replace(/\/$/u, '')}/${m[1]}.ogg`, durationSec: a.output.durationSeconds });
    }
    return {
      filename: `inst-${o.firstFilenameIndex + i}.json`,
      // ACE layers take their instrument type's own effect sends (no fxSends).
      json: { id: o.firstId + i, name: lane.name, type: AUDIO_CLIPS_TYPE, lowLevelType: lane.lowLevelType, ...(lane.sends ? { fxSends: lane.sends } : {}), clips },
    };
  });
}
