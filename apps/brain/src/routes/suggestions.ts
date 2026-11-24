// The suggestions page's Mix section (admins): every Pro-mode mix change users
// saved, grouped by genre and by what was changed, next to the standard value
// from the mix config. A change that many songs of a genre agree on is a
// candidate for the standard mix (casperaki_engine/config/mix-config.json).
//
//   GET    /api/suggestions/mix -> { genres: [{ genre, songs, changes: [...] }] }
//   POST   /api/suggestions/mix/comments { genre, key, body } -> 201 the comment (author, time)
//   DELETE /api/suggestions/mix?genre=&key= -> 204: hide that change (Delete
//          on the page). The songs keep their mixes; a value saved after the
//          deletion shows the change again.
//
// A change is one of
//   volume: an instrument type's fader trim (dB, standard 0)
//   send:   an instrument type's reverb / delay / chorus send (dB)
//   plugin: one parameter (raw 0..1) of a plugin on an FX bus
// with every song's value (newest first) and their average.

import { Router, json, type Request } from 'express';
import { z } from 'zod';

import { parseSong } from '@casperaki/song-schema';

import { MixLookup } from '../sounds/soundDetails.js';
import type { SongsStore, SuggestionComment } from '../store.js';

export interface SuggestionsRouterDeps {
  readonly store: SongsStore;
  /** The standard mix config text; without it the mix suggestions answer 503. */
  readonly mixConfig: string | undefined;
  readonly isAdminRequest: (req: Request) => boolean;
  /** Who leaves a comment (the signed-in email). */
  readonly authorOf: (req: Request) => string;
}

type ChangeKind = 'volume' | 'send' | 'route' | 'plugin';

export interface MixChange {
  /** Identifies the change within its genre (for Delete). */
  readonly key: string;
  readonly kind: ChangeKind;
  /** volume / send / route: the instrument type (mix config lowLevelType); plugin: the FX bus. */
  readonly target: string;
  /** send: reverb | delay | chorus; route: the group bus the type was sent to and its standard bus (values are 1); plugin: the plugin's factory and parameter index. */
  readonly detail?: { readonly send?: 'reverb' | 'delay' | 'chorus'; readonly bus?: string; readonly standardBus?: string; readonly plugin?: string; readonly slot?: number; readonly param?: number };
  readonly standard: number;
  readonly average: number;
  readonly values: readonly { readonly value: number; readonly songId: string; readonly title: string; readonly lane?: string; readonly updatedAt: string }[];
  /** Comments left on this change (oldest first). */
  readonly comments: readonly SuggestionComment[];
}

const SENDS = ['reverb', 'delay', 'chorus'] as const;
const CommentBody = z.object({ genre: z.string().min(1), key: z.string().min(1), body: z.string().trim().min(1).max(2000) }).strict();
const DismissQuery = z.object({ genre: z.string().min(1), key: z.string().min(1) }).strict();

export function createSuggestionsRouter({ store, mixConfig, isAdminRequest, authorOf }: SuggestionsRouterDeps): Router {
  const router = Router();
  router.get('/api/suggestions/mix', (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
    const lookup = new MixLookup(mixConfig);
    const chains = (JSON.parse(mixConfig) as { rackChains: { bus: string; plugins: { factory: string; params: number[] }[] }[] }).rackChains;

    const comments = new Map<string, SuggestionComment[]>();
    for (const c of store.listSuggestionComments('mix')) comments.set(c.target, [...(comments.get(c.target) ?? []), c]);
    const dismissed = new Map(store.listMixDismissals().map((d) => [`${d.genre}|${d.key}`, d.dismissedAt]));
    const byGenre = new Map<string, { changes: Map<string, Omit<MixChange, 'average' | 'values' | 'comments'> & { values: (MixChange['values'][number] & { owner: string; tracks?: number })[] }> }>();
    for (const row of store.listProjectMixes()) {
      const genre = row.genre ?? 'unknown';
      const g = byGenre.get(genre) ?? { changes: new Map() };
      byGenre.set(genre, g);
      const song = parseSong(JSON.parse(row.canonical));
      const typeOf = (lane: string) => {
        if (lane === 'Sample Transitions FX') return 'fxTransitions';
        const def = song.instrumentDefinitions.find((d) => d.name === lane);
        if (!def) throw new Error(`song ${row.songId} has no instrument "${lane}" for its saved mix`);
        const t = def.lowLevelType ?? def.type;
        if (!t) throw new Error(`song ${row.songId}: instrument "${lane}" has no type`);
        return t;
      };
      const add = (key: string, base: Omit<MixChange, 'key' | 'average' | 'values' | 'comments'>, value: MixChange['values'][number]) => {
        // Deleted on the page: only values saved since then count.
        const gone = dismissed.get(`${genre}|${key}`);
        if (gone !== undefined && value.updatedAt <= gone) return;
        const c = g.changes.get(key) ?? { key, ...base, values: [] };
        // Several tracks of one type in a song count as one value (their average), so a
        // song weighs the same however many tracks of the type it has.
        const i = c.values.findIndex((v) => v.owner === row.ownerId && v.songId === value.songId);
        const prev = c.values[i];
        if (prev) {
          const n = (prev.tracks ?? 1) + 1;
          c.values[i] = { ...prev, value: (prev.value * (n - 1) + value.value) / n, lane: [prev.lane, value.lane].filter(Boolean).join(', '), tracks: n };
        } else c.values.push({ ...value, owner: row.ownerId });
        g.changes.set(key, c);
      };
      const meta = { songId: row.songId, title: row.title, updatedAt: row.mixUpdatedAt };
      for (const [lane, o] of Object.entries(row.mixOverrides.lanes)) {
        const type = typeOf(lane);
        if (o.volumeDb !== undefined && o.volumeDb !== 0) add(`volume|${type}`, { kind: 'volume', target: type, standard: 0 }, { ...meta, lane, value: o.volumeDb });
        const standardBus = lookup.fxGroup(type);
        if (o.fxGroup !== undefined && o.fxGroup !== standardBus) {
          add(`route|${type}|${o.fxGroup}`, { kind: 'route', target: type, detail: { bus: o.fxGroup, standardBus }, standard: 0 }, { ...meta, lane, value: 1 });
        }
        const standard = lookup.laneSends(standardBus, type, row.genre);
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

    const order: Record<ChangeKind, number> = { volume: 0, send: 1, route: 2, plugin: 3 };
    const genres = [...byGenre.entries()]
      .filter(([, g]) => g.changes.size > 0)
      .map(([genre, g]) => ({
        genre,
        songs: new Set([...g.changes.values()].flatMap((c) => c.values.map((v) => `${v.owner}/${v.songId}`))).size,
        changes: [...g.changes.values()]
          .map((c) => ({ ...c, comments: comments.get(`${genre}|${c.key}`) ?? [], values: c.values.map(({ owner: _owner, tracks: _tracks, ...v }) => v), average: c.values.reduce((s, v) => s + v.value, 0) / c.values.length }))
          .sort((a, b) => b.values.length - a.values.length || order[a.kind] - order[b.kind] || a.target.localeCompare(b.target)),
      }))
      .sort((a, b) => a.genre.localeCompare(b.genre));
    return res.json({ genres });
  });
  router.post('/api/suggestions/mix/comments', json(), (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    const body = CommentBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'bad_request', message: body.error.message });
    const { genre, key } = body.data;
    const comment = store.addSuggestionComment({ kind: 'mix', target: `${genre}|${key}`, author: authorOf(req), body: body.data.body, createdAt: new Date().toISOString() });
    return res.status(201).json({ comment });
  });
  router.delete('/api/suggestions/mix', (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    const body = DismissQuery.safeParse(req.query);
    if (!body.success) return res.status(400).json({ error: 'bad_request', message: body.error.message });
    store.dismissMixSuggestion({ ...body.data, dismissedAt: new Date().toISOString() });
    return res.status(204).end();
  });
  return router;
}
