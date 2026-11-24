// What the song assistant knows of the mix in Pro mode (sent with every
// message; the brain's assistant/mixTools.ts reads it): each track's level,
// sends and bus against the standard, the tracks it is linked to, and every
// bus's plugins with their settings in the plugins' own units.

import type { MixOverrides } from '@casperaki/song-schema/schemas';

import type { MixConfigJson, ResolvedMix } from '../audio/livePlayer';
import { linkedLanes } from '../audio/proMix';
import { describeParam, editableParams, pluginTitle } from './devices/ProParams';

export interface MixSnapshot {
  readonly tracks: readonly {
    readonly track: string;
    readonly types: readonly string[];
    readonly bus: string;
    readonly standardBus: string;
    /** The standard level (dB), or null when the track's parts have different ones (a drum kit). */
    readonly levelDb: number | null;
    /** The Pro change of the level (dB, 0 = standard). */
    readonly trimDb: number;
    /** Send levels in dB; null = off, or no single value. */
    readonly sends: { readonly reverb: number | null; readonly delay: number | null; readonly chorus: number | null };
    readonly linkedWith: readonly string[];
  }[];
  readonly buses: readonly {
    readonly bus: string;
    readonly kind: 'group' | 'return' | 'master';
    readonly plugins: readonly { readonly slot: number; readonly name: string; readonly params: readonly { readonly index: number; readonly name: string; readonly value: number; readonly shown: string; readonly standard: number; readonly readOnly?: true }[] }[];
  }[];
}

const RETURNS = new Set(['fxPlateReverb', 'fxStereoDelay', 'fxChorus']);
const same = <T,>(xs: readonly T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0]! : null);

export function mixSnapshot(mix: ResolvedMix, overrides: MixOverrides, standardChains: MixConfigJson['rackChains']): MixSnapshot {
  const routes = (mix.config as unknown as { typeToFxGroup?: Record<string, string> }).typeToFxGroup;
  if (!routes) throw new Error('The mix config has no typeToFxGroup.');
  const lanes = [...new Set(mix.lanes.map((p) => p.lane))];
  const tracks = lanes.map((lane) => {
    const parts = mix.lanes.filter((p) => p.lane === lane);
    const types = [...new Set(parts.map((p) => p.lowLevelType).filter(Boolean))];
    const o = overrides.lanes[lane];
    const bus = [...new Set(parts.map((p) => p.fxGroup))].join(' + ');
    const standardBus = o?.fxGroup ? [...new Set(types.map((t) => routes[t] ?? `no bus for ${t}`))].join(' + ') : bus;
    const send = (k: 'reverb' | 'delay' | 'chorus') => {
      const v = o?.[k] ?? same(parts.map((p) => p.sendsDb[k]));
      return v === null || v <= -100 ? null : v;
    };
    return {
      track: lane,
      types,
      bus,
      standardBus,
      levelDb: same(parts.map((p) => p.volumeDb)),
      trimDb: o?.volumeDb ?? 0,
      sends: { reverb: send('reverb'), delay: send('delay'), chorus: send('chorus') },
      linkedWith: linkedLanes(mix, lane).filter((l) => l !== lane),
    };
  });
  const buses = mix.config.rackChains.map((c) => {
    const std = standardChains.find((s) => s.bus === c.bus);
    return {
      bus: c.bus,
      kind: c.bus === 'master' ? ('master' as const) : RETURNS.has(c.bus) ? ('return' as const) : ('group' as const),
      plugins: c.plugins.map((p, slot) => {
        const current = overrides.buses[c.bus]?.[String(slot)] ?? p.params;
        return {
          slot,
          name: pluginTitle(p.factory),
          params: current.map((value, index) => {
            const d = describeParam(p.factory, index);
            const standard = std?.plugins[slot]?.params[index];
            if (standard === undefined) throw new Error(`The standard mix has no ${c.bus} slot ${slot} parameter ${index}.`);
            return { index, name: d.name, value: Math.round(value * 1000) / 1000, shown: d.display(value), standard: Math.round(standard * 1000) / 1000, ...(index >= editableParams(p.factory, current.length) ? { readOnly: true as const } : {}) };
          }),
        };
      }),
    };
  });
  return { tracks, buses };
}
