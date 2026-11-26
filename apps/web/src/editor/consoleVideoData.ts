import type { LaneMeters, ResolvedMixLane, SampledAutomation } from '../audio/livePlayer';
import { mixerStrips } from '../audio/vocalLanes';
import type { ConsoleBody, ConsoleBodyTrack } from '../api/video';
import { BEATS_PER_BAR, type SequencerModel } from './sequencerModel';

/** Levels are sent rounded to 4 digits: plenty for a meter, and a third of the size. */
const round = (v: number) => Number(v.toFixed(4));

/**
 * What the console music video needs from the editor: one strip per mixer strip (the mixer's own grouping: a vocal
 * track and its wet lane are one strip; a lane with no track row, such as a transition, is an effects strip), each
 * with its measured level per bin, its volume and low-pass automation by the mixer's rule, and its clips and notes in
 * seconds; the master's level; and the song version the levels were measured for.
 */
export function buildConsoleBody(args: {
  model: SequencerModel;
  meters: LaneMeters;
  secondsPerBar: number;
  /** The lead vocal track's name, when the song has one. */
  leadVocal: string | undefined;
  /** CSS colour → #rrggbb (throws when it does not resolve). */
  hex: (css: string) => string;
}): ConsoleBody {
  const { model, meters, secondsPerBar } = args;
  if (!meters.done) throw new Error(`The track levels are not finished measuring (${meters.doneBins} of ${meters.binCount}).`);
  const masterPeaks = meters.busPeaks[3];
  if (!masterPeaks) throw new Error('The track levels have no master level.');
  const byLane = new Map<string, ResolvedMixLane[]>();
  for (const l of meters.mix.lanes) byLane.set(l.lane, [...(byLane.get(l.lane) ?? []), l]);
  const peaksOf = (lane: string) => {
    const i = meters.names.indexOf(lane);
    if (i < 0) throw new Error(`No level was measured for the lane "${lane}".`);
    return meters.peaks[i]!;
  };
  const tracksByName = new Map(model.tracks.map((t) => [t.name, t]));
  const secPerBeat = secondsPerBar / BEATS_PER_BAR;

  const tracks = mixerStrips(
    model.tracks.map((t) => t.name),
    [...byLane.keys()],
  ).map((strip): ConsoleBodyTrack => {
    const parts = strip.lanes.flatMap((l) => byLane.get(l)!);
    const lanePeaks = strip.lanes.map(peaksOf);
    const levels = Array.from({ length: meters.binCount }, (_, b) => round(Math.max(...lanePeaks.map((p) => p[b]!))));
    const volumes = parts.map((p) => p.volumeDb);
    const volumeDb = volumes.every((v) => v !== null && v === volumes[0]) ? volumes[0]! : null;
    const automation = (pick: (p: ResolvedMixLane) => SampledAutomation | undefined) => {
      const a = parts.map(pick).find((x) => x !== undefined);
      return a ? { t0: a.t0, step: a.step, values: [...a.values] } : undefined;
    };
    const volumeAutomation = automation((p) => p.volume);
    const lowPassAutomation = automation((p) => p.lowPass);
    const row = tracksByName.get(strip.name);
    const common = {
      name: strip.name,
      bus: parts[0]!.fxGroup,
      volumeDb,
      levels,
      ...(volumeAutomation ? { volumeAutomation } : {}),
      ...(lowPassAutomation ? { lowPassAutomation } : {}),
    };
    if (!row) return { ...common, role: 'effects', clips: [] };
    return {
      ...common,
      role: strip.name === args.leadVocal ? 'leadVocal' : 'track',
      color: args.hex(row.color),
      clips: row.clips.map((c) => ({
        section: model.sections[c.section]!.name,
        startSeconds: c.startBar * secondsPerBar,
        endSeconds: (c.startBar + c.bars) * secondsPerBar,
        notes: c.notes.map((n) => ({
          startSeconds: n.start * secPerBeat,
          lengthSeconds: n.length * secPerBeat,
          pitch: n.pitch,
          velocity: n.velocity ?? null,
        })),
      })),
    };
  });

  return { versionKey: meters.versionKey, binSeconds: meters.binSec, tracks, master: Array.from(masterPeaks, round) };
}
