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
//   POST   /api/suggestions/mix/approve-many { items: [{ genre, key }] } -> { summaries }: the same for
//          several changes, applied in order, in one commit (all or none: one that cannot be approved
//          refuses the lot)
//   POST   /api/suggestions/mix/dismiss-many { items: [{ genre, key }] } -> 204: Delete for several changes
//   POST   /api/suggestions/mix/approve { genre, key } -> { summary }: the change's
//          average becomes the standard (mix-config.json is rewritten, committed
//          in its repo and pushed; see sounds/approveMixChange.ts). Songs keep sounding as they did: their
//          level trims on that type are lowered by the same amount.
//
// A change is one of
//   volume: an instrument type's fader trim (dB, standard 0)
//   send:   an instrument type's reverb / delay / chorus send (dB)
//   route:  the group bus an instrument type plays through
//   plugin: one parameter (raw 0..1) of a plugin on an FX bus
// with every song's value (newest first) and their average.

import { Router, json, type Request, type Response } from 'express';
import { z } from 'zod';

import { parseSong } from '@casperaki/song-schema';

import { ApproveError, DRUM_KIT_TYPE, TRANSITIONS_TYPE, approveMixChange, laneMixType } from '../sounds/approveMixChange.js';
import { MixLookup } from '../sounds/soundDetails.js';
import type { SongsStore, SuggestionComment } from '../store.js';

export interface SuggestionsRouterDeps {
  readonly store: SongsStore;
  /** The standard mix config (text), replaced when a change is approved; without it the mix suggestions answer 503. */
  readonly mixConfig: { readonly mixConfig: string; replaceMixConfig(text: string, message: string): void } | undefined;
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
  /** The standard value; null where there is no single one (the transitions track's sends and bus). */
  readonly standard: number | null;
  /** What approving changes: this genre only, or every genre (the mix config sets it once for all). */
  readonly scope: 'genre' | 'all';
  /** Why it cannot be approved, if it cannot. */
  readonly blocked?: string;
  readonly average: number;
  readonly values: readonly { readonly value: number; readonly songId: string; readonly title: string; readonly lane?: string; readonly updatedAt: string }[];
  /** Comments left on this change (oldest first). */
  readonly comments: readonly SuggestionComment[];
}

const SENDS = ['reverb', 'delay', 'chorus'] as const;
const CommentBody = z.object({ genre: z.string().min(1), key: z.string().min(1), body: z.string().trim().min(1).max(2000) }).strict();
const DismissQuery = z.object({ genre: z.string().min(1), key: z.string().min(1) }).strict();
const ApproveBody = DismissQuery;
const ManyBody = z.object({ items: z.array(DismissQuery).min(1).max(500) }).strict();

/** A request that cannot be approved as asked (answered 404 / 409 with its message). */
class RefusedError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}
const TRANSITIONS_BLOCKED = 'The transitions track plays each transition through its own type’s bus and sends: there is no one standard to change.';
const KIT_BLOCKED = 'The engine routes a drum kit by position (kicks to the kicks bus, the rest to the drums bus) with the drums group’s sends: not a setting of the standard mix.';

export function createSuggestionsRouter({ store, mixConfig, isAdminRequest, authorOf }: SuggestionsRouterDeps): Router {
  const router = Router();
  const summarise = (configText: string): { genre: string; songs: number; changes: MixChange[] }[] => {
    const lookup = new MixLookup(configText);
    const chains = (JSON.parse(configText) as { rackChains: { bus: string; plugins: { factory: string; params: number[] }[] }[] }).rackChains;

    const comments = new Map<string, SuggestionComment[]>();
    for (const c of store.listSuggestionComments('mix')) comments.set(c.target, [...(comments.get(c.target) ?? []), c]);
    const dismissed = new Map(store.listMixDismissals().map((d) => [`${d.genre}|${d.key}`, d.dismissedAt]));
    type Pending = Omit<MixChange, 'average' | 'values' | 'comments'> & { values: (MixChange['values'][number] & { owner: string; tracks?: number })[] };
    const byGenre = new Map<string, { changes: Map<string, Pending> }>();
    for (const row of store.listProjectMixes()) {
      const genre = row.genre ?? 'unknown';
      const g = byGenre.get(genre) ?? { changes: new Map() };
      byGenre.set(genre, g);
      const song = parseSong(JSON.parse(row.canonical));
      const typeOf = (lane: string) => {
        try {
          return laneMixType(song, lane);
        } catch (err) {
          throw new Error(`song ${row.songId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      const add = (key: string, base: Omit<MixChange, 'key' | 'average' | 'values' | 'comments'>, value: MixChange['values'][number]) => {
        // Deleted on the page: only values saved since then count.
        const gone = dismissed.get(`${genre}|${key}`);
        if (gone !== undefined && value.updatedAt <= gone) return;
        const c: Pending = g.changes.get(key) ?? { key, ...base, values: [] };
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
        if (o.volumeDb !== undefined && o.volumeDb !== 0) {
          // The transitions track's level is one constant for every genre.
          add(`volume|${type}`, { kind: 'volume', target: type, standard: 0, scope: type === TRANSITIONS_TYPE ? 'all' : 'genre' }, { ...meta, lane, value: o.volumeDb });
        }
        if (type === TRANSITIONS_TYPE || type === DRUM_KIT_TYPE) {
          const blocked = type === TRANSITIONS_TYPE ? TRANSITIONS_BLOCKED : KIT_BLOCKED;
          if (o.fxGroup !== undefined) add(`route|${type}|${o.fxGroup}`, { kind: 'route', target: type, detail: { bus: o.fxGroup }, standard: null, scope: 'all', blocked }, { ...meta, lane, value: 1 });
          for (const k of SENDS) {
            const v = o[k];
            if (v !== undefined) add(`send|${type}|${k}`, { kind: 'send', target: type, detail: { send: k }, standard: null, scope: 'all', blocked }, { ...meta, lane, value: v });
          }
          continue;
        }
        const standardBus = lookup.fxGroup(type);
        if (o.fxGroup !== undefined && o.fxGroup !== standardBus) {
          add(`route|${type}|${o.fxGroup}`, { kind: 'route', target: type, detail: { bus: o.fxGroup, standardBus }, standard: 0, scope: 'all' }, { ...meta, lane, value: 1 });
        }
        const standard = lookup.laneSends(standardBus, type, row.genre);
        for (const k of SENDS) {
          const v = o[k];
          // The standard config spells "no send" as -100 (null after the lookup).
          const std = standard[k] ?? -100;
          if (v === undefined || v === std) continue;
          add(`send|${type}|${k}`, { kind: 'send', target: type, detail: { send: k }, standard: std, scope: 'all' }, { ...meta, lane, value: v });
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
              { kind: 'plugin', target: bus, detail: { plugin: plugin.factory, slot: Number(slotKey), param: i }, standard, scope: 'all' },
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
    return genres;
  };
  router.get('/api/suggestions/mix', (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
    return res.json({ genres: summarise(mixConfig.mixConfig) });
  });
  /**
   * Approves changes in order into the standard mix, as one commit: each is found in the suggestions as the config
   * stands after the ones before it. Nothing is written unless every one can be approved. Then the level trims of
   * the songs are lowered by what each standard rose, and each change gets an "Approved" comment.
   */
  const approveAll = (req: Request, items: readonly { genre: string; key: string }[]): string[] => {
    const cfg = mixConfig!;
    let text = cfg.mixConfig;
    const done: { genre: string; key: string; kind: ChangeKind; approval: ReturnType<typeof approveMixChange> }[] = [];
    for (const { genre, key } of items) {
      const change = summarise(text).find((g) => g.genre === genre)?.changes.find((c) => c.key === key);
      if (!change) throw new RefusedError(404, 'not_found', `No ${key} change in ${genre}.`);
      if (change.blocked) throw new RefusedError(409, 'not_approvable', `${genre} ${key}: ${change.blocked}`);
      let approval;
      try {
        approval = approveMixChange(text, change, genre);
      } catch (err) {
        if (err instanceof ApproveError) throw new RefusedError(409, 'not_approvable', `${genre} ${key}: ${err.message}`);
        throw err;
      }
      const shift = approval.trimShift;
      // The trims are lowered after the config is written, from the songs as saved: two shifts of one type in an
      // overlapping set of genres would each be measured against trims the other already moved.
      const clash = shift && done.find((d) => d.approval.trimShift?.type === shift.type && (d.approval.trimShift.genre === null || shift.genre === null || d.approval.trimShift.genre === shift.genre));
      if (clash) throw new RefusedError(409, 'approve_separately', `${clash.genre} ${clash.key} and ${genre} ${key} both change the level of ${shift.type}: approve them one at a time.`);
      text = approval.text;
      done.push({ genre, key, kind: change.kind, approval });
    }
    const who = authorOf(req).split('@')[0];
    const message =
      done.length === 1
        ? `mix: approve ${done[0]!.genre} ${done[0]!.kind} change (${who})\n\n${done[0]!.approval.summary}.`
        : `mix: approve ${done.length} changes (${who})\n\n${done.map((d) => `${d.genre}: ${d.approval.summary}.`).join('\n')}`;
    cfg.replaceMixConfig(text, message);
    for (const { approval } of done) if (approval.trimShift) shiftTrims(approval.trimShift);
    const at = new Date().toISOString();
    for (const { genre, key, approval } of done) {
      store.addSuggestionComment({ kind: 'mix', target: `${genre}|${key}`, author: authorOf(req), body: `Approved: ${approval.summary}.`, createdAt: at });
    }
    return done.map((d) => d.approval.summary);
  };

  /** Level trims are relative to the standard: lower them by what the standard rose. */
  const shiftTrims = (shift: { readonly type: string; readonly genre: string | null; readonly db: number }) => {
    for (const row of store.listProjectMixes()) {
      if (shift.genre !== null && row.genre !== shift.genre) continue;
      const song = parseSong(JSON.parse(row.canonical));
      let changed = false;
      const lanes = Object.fromEntries(
        Object.entries(row.mixOverrides.lanes).flatMap(([lane, o]) => {
          const type = laneMixType(song, lane);
          if (type !== shift.type || o.volumeDb === undefined) return [[lane, o]];
          changed = true;
          const { volumeDb, ...rest } = o;
          const v = Math.round((volumeDb - shift.db) * 10) / 10;
          const next = v === 0 ? rest : { ...rest, volumeDb: v };
          return Object.keys(next).length ? [[lane, next]] : [];
        }),
      );
      if (!changed) continue;
      const mix = { ...row.mixOverrides, lanes };
      const empty = !Object.keys(mix.lanes).length && !Object.keys(mix.buses).length;
      store.setProjectMix({ ownerId: row.ownerId, songId: row.songId, mixOverrides: empty ? null : mix, updatedAt: row.mixUpdatedAt });
    }
  };

  const refused = (res: Response, err: unknown) => {
    if (err instanceof RefusedError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  };

  router.post('/api/suggestions/mix/approve', json(), (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
    const body = ApproveBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'bad_request', message: body.error.message });
    try {
      return res.json({ summary: approveAll(req, [body.data])[0] });
    } catch (err) {
      return refused(res, err);
    }
  });
  router.post('/api/suggestions/mix/approve-many', json(), (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
    const body = ManyBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'bad_request', message: body.error.message });
    try {
      return res.json({ summaries: approveAll(req, body.data.items) });
    } catch (err) {
      return refused(res, err);
    }
  });
  router.post('/api/suggestions/mix/dismiss-many', json(), (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin_only', message: 'Suggestions are limited to admins.' });
    const body = ManyBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'bad_request', message: body.error.message });
    const at = new Date().toISOString();
    for (const item of body.data.items) store.dismissMixSuggestion({ ...item, dismissedAt: at });
    return res.status(204).end();
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
