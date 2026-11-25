// A vocal track with sung takes plays on up to two engine lanes (packages/engine-adapter/src/audio-clips.ts): the
// track's own name (dry, its YuE2 takes) and "<track> wet" (its SoulX takes, with reverb and delay). The user sees
// one track: one mixer strip, one mute and solo for both lanes.

/** The suffix of a vocal track's wet lane. */
export const WET_SUFFIX = ' wet';

/** The track a lane belongs to: "<track> wet" is its track's; any other lane is its own. */
export function trackOfLane(lane: string): string {
  return lane.endsWith(WET_SUFFIX) ? lane.slice(0, -WET_SUFFIX.length) : lane;
}

/**
 * The mixer's strips: one per track, with the engine lanes it stands for (a track's own lane first, then its wet
 * lane), tracks in `tracks` order, then lanes of no track (e.g. transitions) each on its own. A wet lane whose track
 * is not a track row stays a strip of its own.
 */
export function mixerStrips(tracks: readonly string[], lanes: readonly string[]): { name: string; lanes: string[] }[] {
  const strips: { name: string; lanes: string[] }[] = [];
  const taken = new Set<string>();
  for (const track of tracks) {
    const own = [track, `${track}${WET_SUFFIX}`].filter((l) => lanes.includes(l));
    if (own.length === 0) continue;
    strips.push({ name: track, lanes: own });
    for (const l of own) taken.add(l);
  }
  for (const lane of lanes) if (!taken.has(lane)) strips.push({ name: lane, lanes: [lane] });
  return strips;
}

/** Each lane's gain (1 audible, 0 silent) from the muted and soloed tracks: a wet lane follows its track. With any
 *  track soloed only soloed tracks play. */
export function laneGains(lanes: readonly string[], muted: readonly string[], solo: readonly string[]): Record<string, number> {
  const gains: Record<string, number> = {};
  for (const lane of lanes) {
    const names = [lane, trackOfLane(lane)];
    const audible = solo.length > 0 ? names.some((n) => solo.includes(n)) : !names.some((n) => muted.includes(n));
    gains[lane] = audible ? 1 : 0;
  }
  return gains;
}
