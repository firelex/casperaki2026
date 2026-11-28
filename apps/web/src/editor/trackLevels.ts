import type { LaneMeters, LivePlayer } from '../audio/livePlayer';
import type { PlaybackPayload } from '../api/playback';
import { mixerStrips } from '../audio/vocalLanes';
import type { MeasuredLevels } from '../api/video';
import type { SequencerModel } from './sequencerModel';

/** Levels are sent rounded to 4 digits: plenty for a meter, and a third of the size. */
const round = (v: number) => Number(v.toFixed(4));

/**
 * What the avatar video needs from the editor: one strip per mixer strip (the mixer's own grouping: a vocal track and
 * its wet lane are one strip; a lane with no track row, such as a transition, is an effects strip), each with its
 * measured level per bin (the louder of its lanes) and its role; the master's level; and the song version the levels
 * were measured for.
 */
export function buildMeasuredLevels(args: {
  model: SequencerModel;
  meters: LaneMeters;
  /** The lead vocal track's name, when the song has one. */
  leadVocal: string | undefined;
}): MeasuredLevels {
  const { model, meters } = args;
  if (!meters.done) throw new Error(`The track levels are not finished measuring (${meters.doneBins} of ${meters.binCount}).`);
  const masterPeaks = meters.busPeaks[3];
  if (!masterPeaks) throw new Error('The track levels have no master level.');
  const lanes = [...new Set(meters.mix.lanes.map((l) => l.lane))];
  const peaksOf = (lane: string) => {
    const i = meters.names.indexOf(lane);
    if (i < 0) throw new Error(`No level was measured for the lane "${lane}".`);
    return meters.peaks[i]!;
  };
  const rows = new Set(model.tracks.map((t) => t.name));
  const tracks = mixerStrips(
    model.tracks.map((t) => t.name),
    lanes,
  ).map((strip) => {
    const lanePeaks = strip.lanes.map(peaksOf);
    const levels = Array.from({ length: meters.binCount }, (_, b) => round(Math.max(...lanePeaks.map((p) => p[b]!))));
    const role = !rows.has(strip.name) ? ('effects' as const) : strip.name === args.leadVocal ? ('leadVocal' as const) : ('track' as const);
    return { name: strip.name, role, levels };
  });
  return { versionKey: meters.versionKey, binSeconds: meters.binSec, tracks, master: Array.from(masterPeaks, round) };
}

/**
 * Measures every track's level for the saved song through the in-browser engine, reporting the share done. It forgets
 * cached levels and payloads first: they are kept per song id, and the song's mix may have been changed elsewhere
 * since (another tab or device), which would send levels of an older version.
 */
export function measureTracks(
  player: Pick<LivePlayer, 'forgetMixes' | 'meters'>,
  songId: string,
  fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
  onProgress: (share: number) => void,
): Promise<LaneMeters> {
  player.forgetMixes();
  return new Promise((resolve, reject) => {
    player.meters(
      songId,
      fetchPayload,
      (m) => {
        onProgress(m.binCount > 0 ? m.doneBins / m.binCount : 0);
        if (m.done) resolve(m);
      },
      (message) => reject(new Error(message)),
    );
  });
}
