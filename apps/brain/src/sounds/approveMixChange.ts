// Approving a mix suggestion: the change becomes part of the standard mix
// (mix-config.json, read by both engines). Mirrors the config's own model:
//   volume: an instrument type's level in one genre (instrumentTargetVolume,
//           ordered rules, first match wins). The Sample Transitions FX track's
//           level is one constant for every genre (constants.transitionsTrimDb).
//   send:   an instrument type's sends, the same in every genre (laneSendOverrides.byType)
//   route:  the group bus a type plays through, the same in every genre (typeToFxGroup)
//   plugin: one parameter of a bus plugin, the same in every genre (rackChains)
// The drum kit is one track in the mixer, but each kit position has the level
// of its own type: approving the kit's level moves every position type's level
// in the genre by the same amount.

import { DRUM_KIT_LANE, drumKitLowLevelTypes, normalizeLoopLowLevelType } from '@casperaki/engine-adapter';

import { MixLookup, type MixConfigJson } from './soundDetails.js';

export interface ApprovableChange {
  readonly kind: 'volume' | 'send' | 'route' | 'plugin';
  readonly target: string;
  readonly detail?: { readonly send?: 'reverb' | 'delay' | 'chorus'; readonly bus?: string; readonly slot?: number; readonly param?: number };
  readonly average: number;
}

export interface Approval {
  /** The new mix-config.json text. */
  readonly text: string;
  /** What the standard is now, for the record ("rock: −5 dB"). */
  readonly summary: string;
  /**
   * Volume approvals: Pro-mode trims are relative to the standard level, so the
   * songs' trims on these tracks must drop by `db` to keep sounding the same.
   */
  readonly trimShift?: { readonly type: string; readonly genre: string | null; readonly db: number };
}

/** The pseudo-type the suggestions use for the Sample Transitions FX track. */
export const TRANSITIONS_TYPE = 'fxTransitions';
/** The pseudo-type the suggestions use for the drum kit track. */
export const DRUM_KIT_TYPE = 'drumKit';

/**
 * The sound type a song's track has in the mix config, as the engine reads it
 * (loops without their tempo suffix); the transitions track is TRANSITIONS_TYPE and
 * the drum kit DRUM_KIT_TYPE.
 */
export function laneMixType(song: { readonly instrumentDefinitions: readonly { readonly name: string; readonly lowLevelType?: string | undefined }[] }, lane: string): string {
  if (lane === 'Sample Transitions FX') return TRANSITIONS_TYPE;
  if (lane === DRUM_KIT_LANE) return DRUM_KIT_TYPE;
  const def = song.instrumentDefinitions.find((d) => d.name === lane);
  if (!def) throw new Error(`The song has no track "${lane}" for its saved mix.`);
  if (!def.lowLevelType) throw new Error(`The song's track "${lane}" has no sound type.`);
  return normalizeLoopLowLevelType(def.lowLevelType);
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const db1 = (v: number) => Number(round(v, 0.1).toFixed(1));
const fmtDb = (v: number) => (v <= -100 ? 'off' : `${v > 0 ? '+' : ''}${v} dB`);

export class ApproveError extends Error {}

export function approveMixChange(configText: string, change: ApprovableChange, genre: string): Approval {
  const cfg = JSON.parse(configText) as MixConfigJson;
  const lookup = new MixLookup(configText);
  const done = (summary: string, trimShift?: Approval['trimShift']): Approval => ({ text: `${JSON.stringify(cfg, null, 2)}\n`, summary, ...(trimShift ? { trimShift } : {}) });
  const type = change.target;

  if (change.kind === 'volume' && type === TRANSITIONS_TYPE) {
    const now = cfg.constants.transitionsTrimDb;
    const next = db1(now + change.average);
    if (next === now) throw new ApproveError('The average rounds to no change.');
    cfg.constants.transitionsTrimDb = next;
    return done(`Transitions track level, every genre: ${fmtDb(next)} (was ${fmtDb(now)})`, { type, genre: null, db: db1(next - now) });
  }
  if (type === TRANSITIONS_TYPE) {
    throw new ApproveError('The transitions track plays each transition through its own type’s bus and sends, so there is no one standard to change. Set them per transition type in mix-config.json.');
  }

  if (type === DRUM_KIT_TYPE && change.kind !== 'volume') {
    throw new ApproveError('The engine routes a drum kit by position (kicks to the kicks bus, the rest to the drums bus) and gives it the drums group’s sends; neither is a setting in mix-config.json.');
  }

  if (change.kind === 'volume') {
    const delta = db1(change.average);
    if (delta === 0) throw new ApproveError('The average rounds to no change.');
    const rules = cfg.instrumentTargetVolume;
    const levels = (type === DRUM_KIT_TYPE ? drumKitLowLevelTypes() : [type]).map((t) => {
      const i = rules.findIndex((r) => r.type === t && (!(r.genres ?? []).length || r.genres!.includes(genre)));
      const now = i >= 0 ? rules[i]!.db : 0;
      const next = db1(now + delta);
      const own = i >= 0 && rules[i]!.genres?.length === 1 && rules[i]!.genres![0] === genre;
      if (own) rules[i]!.db = next;
      // A rule of the genre's own, before the one that matched (first match wins).
      else if (i >= 0) rules.splice(i, 0, { type: t, genres: [genre], db: next });
      else rules.push({ type: t, genres: [genre], db: next });
      return `${t} ${fmtDb(next)} (was ${fmtDb(now)})`;
    });
    const what = type === DRUM_KIT_TYPE ? `Drum kit levels in ${genre}` : `${type} level in ${genre}`;
    return done(`${what}: ${levels.join(', ')}`, { type, genre, db: delta });
  }

  if (change.kind === 'send') {
    const k = change.detail?.send;
    if (!k) throw new ApproveError('A send change without its send.');
    const group = lookup.fxGroup(type);
    const cur = lookup.laneSends(group, type, null);
    const sends = { reverb: cur.reverb ?? -100, delay: cur.delay ?? -100, chorus: cur.chorus ?? -100 };
    const was = sends[k];
    sends[k] = change.average <= -100 ? -100 : db1(change.average);
    if (sends[k] === was) throw new ApproveError('The average rounds to no change.');
    // The type gets one rule of its own that sets all three sends (it keeps the other two as they were).
    const byType = cfg.laneSendOverrides.byType;
    for (const r of byType) r.types = r.types.filter((t) => t !== type);
    cfg.laneSendOverrides.byType = [{ types: [type], op: 'set', ...sends }, ...byType.filter((r) => r.types.length > 0)];
    return done(`${type} ${k} send, every genre: ${fmtDb(sends[k])} (was ${fmtDb(was)})`);
  }

  if (change.kind === 'route') {
    const bus = change.detail?.bus;
    if (!bus) throw new ApproveError('A route change without its bus.');
    if (!cfg.rackChains.some((c) => c.bus === bus)) throw new ApproveError(`The mix config has no "${bus}" bus.`);
    const was = cfg.typeToFxGroup[type];
    cfg.typeToFxGroup[type] = bus;
    return done(`${type} plays through the ${bus} bus in every genre (was ${was ?? 'none'})`);
  }

  const { slot, param } = change.detail ?? {};
  const plugin = cfg.rackChains.find((c) => c.bus === type)?.plugins[slot!];
  if (!plugin || param === undefined || plugin.params[param] === undefined) throw new ApproveError(`The ${type} bus has no plugin parameter ${slot}/${param}.`);
  const was = plugin.params[param]!;
  plugin.params[param] = Number(change.average.toFixed(4));
  return done(`${type} bus, ${plugin.factory} parameter ${param + 1}, every genre: ${plugin.params[param]} (was ${was})`);
}
