// The suggestions page's Mix section (admins): every Pro-mode mix change users
// saved, grouped by genre and by what was changed, next to the standard value
// from the mix config. A change that many songs of a genre agree on is a
// candidate for the standard mix (casperaki_engine/config/mix-config.json).
//
//   GET /api/suggestions/mix -> { genres: [{ genre, songs, changes: [...] }] }
//
// A change is one of
//   volume: an instrument type's fader trim (dB, standard 0)
//   send:   an instrument type's reverb / delay / chorus send (dB)
//   plugin: one parameter (raw 0..1) of a plugin on an FX bus
// with every song's value (newest first) and their average.

import { Router, type Request } from 'express';

import { parseSong } from '@casperaki/song-schema';

import { MixLookup } from '../sounds/soundDetails.js';
import type { SongsStore } from '../store.js';

export interface SuggestionsRouterDeps {
  readonly store: SongsStore;
  /** The standard mix config text; without it the mix suggestions answer 503. */
  readonly mixConfig: string | undefined;
  readonly isAdminRequest: (req: Request) => boolean;
}

type ChangeKind = 'volume' | 'send' | 'plugin';

export interface MixChange {
  readonly kind: ChangeKind;
  /** volume / send: the instrument type (mix config lowLevelType); plugin: the FX bus. */
  readonly target: string;
  /** send: reverb | delay | chorus; plugin: the plugin's factory and parameter index. */
  readonly detail?: { readonly send?: 'reverb' | 'delay' | 'chorus'; readonly plugin?: string; readonly slot?: number; readonly param?: number };
  readonly standard: number;
  readonly average: number;
  readonly values: readonly { readonly value: number; readonly songId: string; readonly title: string; readonly lane?: string; readonly updatedAt: string }[];
}

const SENDS = ['reverb', 'delay', 'chorus'] as const;

export function createSuggestionsRouter({ store, mixConfig, isAdminRequest }: SuggestionsRouterDeps): Router {
  const router = Router();
  router.get('/api/suggestions/mix', (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
    const lookup = new MixLookup(mixConfig);
    const chains = (JSON.parse(mixConfig) as { rackChains: { bus: string; plugins: { factory: string; params: number[] }[] }[] }).rackChains;

    const byGenre = new Map<string, { songs: Set<string>; changes: Map<string, Omit<MixChange, 'average' | 'values'> & { values: MixChange['values'][number][] }> }>();
    for (const row of store.listProjectMixes()) {
      const genre = row.genre ?? 'unknown';
      const g = byGenre.get(genre) ?? { songs: new Set<string>(), changes: new Map() };
      byGenre.set(genre, g);
      g.songs.add(`${row.ownerId}/${row.songId}`);
      const song = parseSong(JSON.parse(row.canonical));
      const typeOf = (lane: string) => {
        if (lane === 'Sample Transitions FX') return 'fxTransitions';
        const def = song.instrumentDefinitions.find((d) => d.name === lane);
        if (!def) throw new Error(`song ${row.songId} has no instrument "${lane}" for its saved mix`);
        const t = def.lowLevelType ?? def.type;
        if (!t) throw new Error(`song ${row.songId}: instrument "${lane}" has no type`);
        return t;
      };
      const add = (key: string, base: Omit<MixChange, 'average' | 'values'>, value: MixChange['values'][number]) => {
        const c = g.changes.get(key) ?? { ...base, values: [] };
        c.values.push(value);
        g.changes.set(key, c);
      };
      const meta = { songId: row.songId, title: row.title, updatedAt: row.mixUpdatedAt };
      for (const [lane, o] of Object.entries(row.mixOverrides.lanes)) {
        const type = typeOf(lane);
        if (o.volumeDb !== undefined && o.volumeDb !== 0) add(`volume|${type}`, { kind: 'volume', target: type, standard: 0 }, { ...meta, lane, value: o.volumeDb });
        const standard = lookup.laneSends(lookup.fxGroup(type), type, row.genre);
        for (const k of SENDS) {
          const v = o[k];
          // The standard config spells "no send" as -100 (null after the lookup).
          const std = standard[k] ?? -100;
          if (v === undefined || v === std) continue;
          add(`send|${type}|${k}`, { kind: 'send', target: type, detail: { send: k }, standard: std }, { ...meta, lane, value: v });
        }
      }
      for (const [bus, slots] of Object.entries(row.mixOverrides.buses)) {
        const chain = chains.find((c) => c.bus === bus);
        if (!chain) throw new Error(`song ${row.songId}: its saved mix changes bus "${bus}", which the mix config has no longer`);
        for (const [slotKey, params] of Object.entries(slots)) {
          const plugin = chain.plugins[Number(slotKey)];
          if (!plugin) throw new Error(`song ${row.songId}: bus "${bus}" has no plugin at slot ${slotKey}`);
          params.forEach((v, i) => {
            const standard = plugin.params[i]!;
            if (Math.abs(v - standard) < 1e-6) return;
            add(
              `plugin|${bus}|${slotKey}|${i}`,
              { kind: 'plugin', target: bus, detail: { plugin: plugin.factory, slot: Number(slotKey), param: i }, standard },
              { ...meta, value: v },
            );
          });
        }
      }
    }

    const order: Record<ChangeKind, number> = { volume: 0, send: 1, plugin: 2 };
    const genres = [...byGenre.entries()]
      .map(([genre, g]) => ({
        genre,
        songs: g.songs.size,
        changes: [...g.changes.values()]
          .map((c) => ({ ...c, average: c.values.reduce((s, v) => s + v.value, 0) / c.values.length }))
          .sort((a, b) => b.values.length - a.values.length || order[a.kind] - order[b.kind] || a.target.localeCompare(b.target)),
      }))
      .sort((a, b) => a.genre.localeCompare(b.genre));
    return res.json({ genres });
  });
  return router;
}
