// A song's Pro-mode mix changes (the track view's Pro mixer), and how they turn
// the standard mix config (casperaki_engine/config/mix-config.json) into the one
// that song plays, exports and renders with. Shared by the brain (saving,
// server renders, the suggestions page) and the web app (live playback, export),
// so every path hears the same mix.
//
//   lanes: per instrument lane (its name, e.g. "Keys 2"): the fader trim in dB
//          (0 = the standard level), send levels in dB (replacing the standard
//          ones; -100 = off) and the group bus it is routed to (fxGroup, e.g.
//          "synths", replacing the routing by sound type; one of the config's
//          group buses). Written into the config's `laneOverrides`.
//   buses: per FX bus ("master", "fxPlateReverb", "bass", ...): the parameters
//          (raw 0..1) of the plugin at a slot of its rack chain, replacing them.
//
// An empty value (no lanes, no buses) is the standard mix.

import { z } from 'zod';

const Db = z.number().finite();

export const LaneMixOverrideSchema = z
  .object({
    volumeDb: Db.min(-100).max(24).optional(),
    reverb: Db.min(-100).max(12).optional(),
    delay: Db.min(-100).max(12).optional(),
    chorus: Db.min(-100).max(12).optional(),
    /** The group bus the lane's dry signal goes to instead of its standard one. */
    fxGroup: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'a lane override needs at least one value');

export const MixOverridesSchema = z
  .object({
    lanes: z.record(z.string().min(1), LaneMixOverrideSchema).default({}),
    /** bus -> slot (the plugin's index in the bus's rack chain, as a string) -> all its params. */
    buses: z.record(z.string().min(1), z.record(z.string().regex(/^\d+$/u), z.array(z.number().min(0).max(1)))).default({}),
  })
  .strict();

export type LaneMixOverride = z.infer<typeof LaneMixOverrideSchema>;
export type MixOverrides = z.infer<typeof MixOverridesSchema>;

export const EMPTY_MIX_OVERRIDES: MixOverrides = { lanes: {}, buses: {} };

export function isEmptyMixOverrides(o: MixOverrides): boolean {
  return Object.keys(o.lanes).length === 0 && Object.keys(o.buses).length === 0;
}

interface RackChain {
  bus: string;
  plugins: { factory: string; params: number[] }[];
}

/** The master and the three aux returns: rack chains no lane can be routed to. */
const NOT_GROUP_BUSES: ReadonlySet<string> = new Set(['master', 'fxPlateReverb', 'fxStereoDelay', 'fxChorus']);

/** The group buses of a mix config (mix-config.json text): what a lane can be routed to, in rack order. */
export function groupBusesOf(baseConfig: string): string[] {
  const cfg = JSON.parse(baseConfig) as { rackChains: RackChain[] };
  return cfg.rackChains.map((c) => c.bus).filter((b) => !NOT_GROUP_BUSES.has(b));
}

/**
 * The mix config a song plays with: `baseConfig` (mix-config.json text) with the
 * song's Pro changes applied. Throws when a bus, slot or parameter count does
 * not exist in the base config (a change for a mix this engine does not have),
 * or when a lane is routed to something that is not a group bus.
 * Lanes are not checked here: a lane the song does not have matches nothing.
 */
export function applyMixOverrides(baseConfig: string, overrides: MixOverrides): string {
  if (isEmptyMixOverrides(overrides)) return baseConfig;
  const cfg = JSON.parse(baseConfig) as { rackChains: RackChain[]; laneOverrides?: unknown };
  const groupBuses = new Set(cfg.rackChains.map((c) => c.bus).filter((b) => !NOT_GROUP_BUSES.has(b)));
  for (const [lane, o] of Object.entries(overrides.lanes)) {
    if (o.fxGroup !== undefined && !groupBuses.has(o.fxGroup)) {
      throw new Error(`mix overrides: "${lane}" is routed to "${o.fxGroup}", which is not a group bus of the mix`);
    }
  }
  if (Object.keys(overrides.lanes).length > 0) cfg.laneOverrides = overrides.lanes;
  for (const [bus, slots] of Object.entries(overrides.buses)) {
    const chain = cfg.rackChains.find((c) => c.bus === bus);
    if (!chain) throw new Error(`mix overrides: the mix has no bus "${bus}"`);
    for (const [slotKey, params] of Object.entries(slots)) {
      const plugin = chain.plugins[Number(slotKey)];
      if (!plugin) throw new Error(`mix overrides: bus "${bus}" has no plugin at slot ${slotKey}`);
      if (params.length !== plugin.params.length) {
        throw new Error(`mix overrides: ${plugin.factory} on "${bus}" has ${plugin.params.length} parameters, not ${params.length}`);
      }
      plugin.params = [...params];
    }
  }
  return JSON.stringify(cfg);
}

/** The Pro changes without lanes the song no longer has (after an edit removed a track). */
export function pruneMixOverrides(overrides: MixOverrides, laneNames: readonly string[]): MixOverrides {
  const keep = new Set(laneNames);
  return { lanes: Object.fromEntries(Object.entries(overrides.lanes).filter(([lane]) => keep.has(lane))), buses: overrides.buses };
}
