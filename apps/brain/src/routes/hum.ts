// Hum to song (docs/superpowers/specs/2026-11-23-hum-to-song-design.md).
//
//   POST /api/hum/analyse?mode=click|free[&bpm=&firstBeatSec=]   body: the recording
//     → the hum on the beat grid, its key, and three alternatives (chords for 8 bars; the melody is the hum so far).
//       The recording and the result are kept in BRAIN_HUM_LAB_DIR as test data.
//   POST /api/hum/complete   { analysisId, alternative? }  → complete the melody of one alternative (or all) to 8
//       bars; again for "a different way". The page calls it once per alternative, to show progress (each call
//       takes several seconds: the model writes SAMPLES completions and the best is kept).
//       With an edit ({ melody, chords, keepBars }), only the bars not in keepBars are rewritten, over those chords.
//   POST /api/hum/song       { analysisId, alternative, genre, title?, melody?, chords? } → a new song with that melody
//       (or the edited one) as its chorus.
//   POST /api/hum/refit          { analysisId, melody }        → { chords }: the fitter's chords for an edited melody.
//   POST /api/hum/chord-options  { analysisId, melody, slot }  → { options: [{ chord, fit }] }, best fit first.
//
// Services (apps/models/services): HUM_SERVICE_URL ("hum", POST /transcribe: beats, key, notes) and AMT_SERVICE_URL
// ("amt", POST /complete: the Anticipatory Music Transformer). Not configured → 503 naming the setting; a service
// that fails → an error naming the step (transcribing / chords / completing / building the song).

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { hum } from '@casperaki/arrangement';
import { formatGenreTempoRange, genreLabel, isBpmInGenreTempoRange, SongGenreSchema } from '@casperaki/song-schema';

import {
  amtChords,
  chordAlternatives,
  chordOptions,
  keptBars,
  mergeCompletion,
  mergeKept,
  refitChords,
  slotsOfChords,
  PHRASE_BARS,
  quantizeHum,
  songKeyOf,
  type BeatNote,
  type ChordAlternative,
  type QuantizedHum,
  type Transcription,
} from '../hum/fit.js';
import type { SongsStore } from '../store.js';
import { generateProject, ownerOf, type SongsRouterDeps } from './songs.js';

export interface HumRouterDeps {
  readonly humServiceUrl: string | undefined;
  readonly amtServiceUrl: string | undefined;
  readonly humLabDir: string | undefined;
  readonly store: SongsStore;
  readonly now?: () => string;
  readonly onPlaceholderTitle?: SongsRouterDeps['onPlaceholderTitle'];
  /** Writes the new song's words (see routes/songs.ts generateProject). */
  readonly artwork?: SongsRouterDeps['artwork'];
  /** For tests: the services' fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Completions the model writes per alternative; the best is kept (about 1 s each on the RTX). */
const SAMPLES = 4;

type Step = 'transcribing' | 'chords' | 'completing' | 'building the song';

class StepError extends Error {
  constructor(
    readonly step: Step,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TranscriptionSchema = z.object({
  bpm: z.number().positive(),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  key: z.object({ tonic: z.number().int().min(0).max(11), scale: z.enum(['major', 'minor']) }),
  notes: z.array(z.object({ onsetSec: z.number(), offsetSec: z.number(), midi: z.number().int() })),
  tookMs: z.number(),
});

const CompletionSchema = z.object({
  completions: z
    .array(z.object({ notes: z.array(z.object({ beat: z.number(), midi: z.number().int(), duration: z.number().positive() })) }).passthrough())
    .min(1),
  tookMs: z.number(),
});

interface Alternative {
  readonly label: string;
  readonly slots: readonly string[];
  /** 16 half-bar chords in the song's key. */
  readonly chords: readonly string[];
  /** The full 8-bar melody: the hummed bars, then the completion. */
  readonly melody: readonly BeatNote[];
  /** True once the melody fills 8 bars (at once when the hum does). */
  readonly completed: boolean;
}

/** What is kept on disk per analysis (and answered to the page, less `owner`). */
interface Analysis {
  readonly id: string;
  readonly owner: string;
  readonly time: string;
  readonly audio: string;
  readonly mode: 'click' | 'free';
  readonly meantBpm: number | null;
  readonly firstBeatSec: number | null;
  readonly transcription: Transcription;
  readonly songKey: string;
  readonly bpm: number;
  readonly bars: number;
  readonly hummedBars: number;
  readonly hum: Omit<QuantizedHum, 'melody'>;
  readonly melody: readonly BeatNote[];
  alternatives: Alternative[];
  readonly timings: Record<string, number>;
}

const EXT: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-m4a': 'm4a',
};
const extensionFor = (type: string | undefined) => EXT[(type ?? '').split(';')[0]!.trim().toLowerCase()] ?? 'bin';

function publicJson(a: Analysis) {
  const { owner: _owner, transcription, ...rest } = a;
  return { ...rest, notesHeard: transcription.notes.length, key: transcription.key };
}

export function createHumRouter(deps: HumRouterDeps): Router {
  const router = Router();
  const clock = deps.now ?? (() => new Date().toISOString());
  const doFetch = deps.fetchImpl ?? fetch;

  const need = (res: Response, what: 'hum' | 'amt' | 'dir'): boolean => {
    const missing =
      what === 'hum' && !deps.humServiceUrl ? 'Set HUM_SERVICE_URL in brain.env to the hum transcription service.'
      : what === 'amt' && !deps.amtServiceUrl ? 'Set AMT_SERVICE_URL in brain.env to the melody completion service.'
      : what === 'dir' && !deps.humLabDir ? 'Set BRAIN_HUM_LAB_DIR in brain.env: hum to song keeps each recording there.'
      : undefined;
    if (missing) res.status(503).json({ error: 'hum_not_configured', message: missing });
    return missing === undefined;
  };

  async function callService(step: Step, url: string, init: RequestInit): Promise<unknown> {
    let res: globalThis.Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw new StepError(step, 502, `The ${step === 'transcribing' ? 'transcription' : 'melody completion'} service could not be reached (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StepError(step, 502, `The ${step} service answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (body as { error?: unknown; message?: unknown }).message ?? (body as { error?: unknown }).error ?? text.slice(0, 200);
      throw new StepError(step, res.status < 500 ? 422 : 502, String(msg));
    }
    return body;
  }

  /** The melody of each alternative completed to 8 bars, the best of SAMPLES each. */
  async function complete(a: Pick<Analysis, 'melody' | 'hummedBars' | 'bpm' | 'transcription'>, alts: readonly Pick<ChordAlternative, 'label' | 'slots' | 'chords'>[]): Promise<Alternative[]> {
    if (a.hummedBars >= PHRASE_BARS) return alts.map((c) => ({ label: c.label, slots: c.slots, chords: c.chords, melody: a.melody, completed: true }));
    const url = `${deps.amtServiceUrl!.replace(/\/$/u, '')}/complete`;
    const out: Alternative[] = [];
    for (const c of alts) {
      out.push(await (async () => {
        const body = await callService('completing', url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bpm: a.bpm,
            totalBars: PHRASE_BARS,
            prompt: a.melody,
            keepBars: keptBars(a.hummedBars),
            chords: amtChords(c.slots, a.transcription.key),
            samples: SAMPLES,
          }),
        });
        const parsed = CompletionSchema.safeParse(body);
        if (!parsed.success) throw new StepError('completing', 502, `The melody completion service answered in an unexpected shape: ${parsed.error.message}`);
        return { label: c.label, slots: c.slots, chords: c.chords, melody: mergeCompletion(a.melody, a.hummedBars, parsed.data.completions[0]!.notes), completed: true };
      })());
    }
    return out;
  }

  /** One completion of an edited melody: the bars not in keepBars rewritten over the given chords. */
  async function completeEdit(a: Pick<Analysis, 'bpm' | 'transcription'>, melody: readonly BeatNote[], slots: readonly string[], keepBars: readonly number[]): Promise<BeatNote[]> {
    const url = `${deps.amtServiceUrl!.replace(/\/$/u, '')}/complete`;
    const body = await callService('completing', url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpm: a.bpm, totalBars: PHRASE_BARS, prompt: melody, keepBars, chords: amtChords(slots, a.transcription.key), samples: SAMPLES }),
    });
    const parsed = CompletionSchema.safeParse(body);
    if (!parsed.success) throw new StepError('completing', 502, `The melody completion service answered in an unexpected shape: ${parsed.error.message}`);
    return mergeKept(melody, keepBars, parsed.data.completions[0]!.notes);
  }

  /** An edit sent by the page, checked: the melody and chords as a user chorus, the chords readable in the key. */
  function readEdit(res: Response, a: Analysis, melody: unknown, chords: unknown): { melody: BeatNote[]; chords: string[]; slots: string[] } | undefined {
    if (Array.isArray(melody) && melody.length === 0) {
      res.status(400).json({ error: 'empty_melody', message: 'The melody has no notes. Add some notes, or go back to the original.' });
      return undefined;
    }
    const parsed = hum.UserChorusSchema.safeParse({ melody, chords });
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_edit', message: `The edited melody or chords are not valid: ${parsed.error.message}` });
      return undefined;
    }
    let slots: string[];
    try {
      slots = slotsOfChords(parsed.data.chords, a.transcription.key);
    } catch (err) {
      res.status(400).json({ error: 'bad_edit', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
    return { melody: parsed.data.melody, chords: parsed.data.chords, slots };
  }

  const fail = (res: Response, err: unknown) => {
    if (err instanceof StepError) return res.status(err.status).json({ error: 'hum_failed', step: err.step, message: err.message });
    return res.status(500).json({ error: 'hum_failed', step: 'unknown', message: err instanceof Error ? err.message : String(err) });
  };

  const fileOf = (id: string) => join(deps.humLabDir!, `${id}.json`);

  async function load(req: Request, id: unknown): Promise<Analysis | undefined> {
    if (typeof id !== 'string' || !/^[\w-]+$/u.test(id)) return undefined;
    let a: Analysis;
    try {
      a = JSON.parse(await readFile(fileOf(id), 'utf8')) as Analysis;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return a.owner === ownerOf(req) ? a : undefined;
  }

  router.post('/api/hum/analyse', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    if (!need(res, 'hum') || !need(res, 'dir')) return;
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) return res.status(400).json({ error: 'no_audio', message: 'Send the recording as the request body.' });
    const mode = req.query['mode'];
    if (mode !== 'click' && mode !== 'free') return res.status(400).json({ error: 'bad_mode', message: 'mode must be "click" or "free".' });
    let meantBpm: number | null = null;
    let firstBeatSec: number | null = null;
    if (mode === 'click') {
      meantBpm = Number(req.query['bpm']);
      firstBeatSec = Number(req.query['firstBeatSec']);
      if (!Number.isFinite(meantBpm) || meantBpm <= 0) return res.status(400).json({ error: 'bad_bpm', message: 'Click mode needs bpm, a positive number.' });
      if (!Number.isFinite(firstBeatSec) || firstBeatSec < 0) return res.status(400).json({ error: 'bad_first_beat', message: 'Click mode needs firstBeatSec, the time of beat 1 in the recording (seconds, 0 or more).' });
    }
    const contentType = req.header('content-type') ?? 'application/octet-stream';
    const timings: Record<string, number> = {};
    try {
      // 1. Transcribe.
      let t0 = Date.now();
      const form = new FormData();
      form.append('audio', new Blob([audio], { type: contentType }), `hum.${extensionFor(contentType)}`);
      form.append('mode', mode);
      if (mode === 'click') {
        form.append('bpm', String(meantBpm));
        form.append('firstBeatSec', String(firstBeatSec));
      }
      const raw = await callService('transcribing', `${deps.humServiceUrl!.replace(/\/$/u, '')}/transcribe`, { method: 'POST', body: form });
      const parsed = TranscriptionSchema.safeParse(raw);
      if (!parsed.success) throw new StepError('transcribing', 502, `The transcription service answered in an unexpected shape: ${parsed.error.message}`);
      const transcription = parsed.data;
      timings['transcribeMs'] = Date.now() - t0;
      let q: QuantizedHum;
      try {
        q = quantizeHum(transcription);
      } catch (err) {
        throw new StepError('transcribing', 422, err instanceof Error ? err.message : String(err));
      }
      const bpm = Math.round(mode === 'click' ? meantBpm! : transcription.bpm);
      // 2. Chords.
      t0 = Date.now();
      let chords: ChordAlternative[];
      try {
        chords = chordAlternatives(q.melody, q.hummedBars, transcription.key);
      } catch (err) {
        throw new StepError('chords', 500, err instanceof Error ? err.message : String(err));
      }
      timings['chordsMs'] = Date.now() - t0;
      // The completion (hums shorter than 8 bars) comes next, one alternative per /api/hum/complete call.
      if (q.hummedBars < PHRASE_BARS && !need(res, 'amt')) return;
      const alternatives: Alternative[] = chords.map((c) => ({ ...c, melody: q.melody, completed: q.hummedBars >= PHRASE_BARS }));
      // Keep it all.
      const time = clock();
      const id = `${time.replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`;
      const audioName = `${id}.${extensionFor(contentType)}`;
      const { melody, ...humInfo } = q;
      const analysis: Analysis = {
        id, owner: ownerOf(req), time, audio: audioName, mode, meantBpm, firstBeatSec, transcription,
        songKey: songKeyOf(transcription.key), bpm, bars: PHRASE_BARS, hummedBars: q.hummedBars, hum: humInfo, melody,
        alternatives, timings,
      };
      await mkdir(deps.humLabDir!, { recursive: true });
      await writeFile(join(deps.humLabDir!, audioName), audio);
      await writeFile(fileOf(id), JSON.stringify(analysis, null, 1));
      return res.json(publicJson(analysis));
    } catch (err) {
      return fail(res, err);
    }
  });

  const CompleteBody = z
    .object({
      analysisId: z.string(),
      alternative: z.number().int().min(0).max(2).optional(),
      melody: z.array(z.unknown()).optional(),
      chords: z.array(z.string()).optional(),
      keepBars: z.array(z.number().int().min(0).max(PHRASE_BARS - 1)).optional(),
    })
    .strict()
    .refine((b) => [b.melody, b.chords, b.keepBars].every((x) => x === undefined) || ([b.melody, b.chords, b.keepBars].every((x) => x !== undefined) && b.alternative !== undefined), {
      message: 'An edit needs melody, chords, keepBars and the alternative, all together.',
    });
  router.post('/api/hum/complete', async (req, res) => {
    if (!need(res, 'dir') || !need(res, 'amt')) return;
    const body = CompleteBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.message });
    try {
      const a = await load(req, body.data.analysisId);
      if (!a) return res.status(404).json({ error: 'not_found', message: 'No such hum analysis.' });
      if (body.data.keepBars !== undefined) {
        const keepBars = [...new Set(body.data.keepBars)].sort((x, y) => x - y);
        if (keepBars.length >= PHRASE_BARS) return res.status(400).json({ error: 'nothing_to_complete', message: 'Every bar is yours (hummed or edited); there is nothing to complete.' });
        const edit = readEdit(res, a, body.data.melody, body.data.chords);
        if (!edit) return;
        if (!edit.melody.some((n) => keepBars.includes(Math.floor(n.beat / 4)))) {
          return res.status(400).json({ error: 'empty_melody', message: 'None of the kept bars has a note, so there is nothing to continue from.' });
        }
        const i = body.data.alternative!;
        const t0 = Date.now();
        const melody = await completeEdit(a, edit.melody, edit.slots, keepBars);
        // Answered, not stored: the stored version stays as Casperaki made it; the page keeps the user's edit.
        const answer = { ...a, alternatives: a.alternatives.map((x, j) => (j === i ? { label: x.label, slots: edit.slots, chords: edit.chords, melody, completed: true } : x)) };
        answer.timings = { ...a.timings, [`completeEditMs${i}`]: Date.now() - t0 };
        return res.json(publicJson(answer));
      }
      if (a.hummedBars >= PHRASE_BARS) return res.status(400).json({ error: 'nothing_to_complete', message: 'The hum fills all 8 bars; there is nothing to complete.' });
      const which = body.data.alternative === undefined ? [0, 1, 2] : [body.data.alternative];
      const t0 = Date.now();
      // One at a time: the service runs one model.
      for (const i of which) a.alternatives[i] = (await complete(a, [a.alternatives[i]!]))[0]!;
      a.timings[`completeMs${which.length === 1 ? which[0] : ''}`] = Date.now() - t0;
      await writeFile(fileOf(a.id), JSON.stringify(a, null, 1));
      return res.json(publicJson(a));
    } catch (err) {
      return fail(res, err);
    }
  });

  const SongBody = z
    .object({
      analysisId: z.string(),
      alternative: z.number().int().min(0).max(2),
      genre: SongGenreSchema,
      title: z.string().trim().min(1).max(120).optional(),
      melody: z.array(z.unknown()).optional(),
      chords: z.array(z.string()).optional(),
    })
    .strict()
    .refine((b) => (b.melody === undefined) === (b.chords === undefined), { message: 'An edited melody and its chords must be sent together.' });
  router.post('/api/hum/song', async (req, res) => {
    if (!need(res, 'dir')) return;
    const body = SongBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.message });
    try {
      const a = await load(req, body.data.analysisId);
      if (!a) return res.status(404).json({ error: 'not_found', message: 'No such hum analysis.' });
      const { genre, alternative } = body.data;
      if (!isBpmInGenreTempoRange(genre, a.bpm)) {
        return res.status(400).json({
          error: 'tempo_out_of_range',
          step: 'building the song',
          message: `The hum is at ${a.bpm} bpm; ${genreLabel(genre)} songs are ${formatGenreTempoRange(genre)}. Pick another style, or hum again with the click at a tempo in that range.`,
        });
      }
      let chorus: { melody: readonly BeatNote[]; chords: readonly string[] } = a.alternatives[alternative]!;
      if (body.data.melody !== undefined) {
        const edit = readEdit(res, a, body.data.melody, body.data.chords);
        if (!edit) return;
        chorus = edit;
      }
      let made;
      try {
        made = await generateProject(
          { store: deps.store, clock, ...(deps.onPlaceholderTitle ? { onPlaceholderTitle: deps.onPlaceholderTitle } : {}), ...(deps.artwork ? { artwork: deps.artwork } : {}) },
          ownerOf(req),
          { genre, key: a.songKey, bpm: a.bpm, seed: `hum-${a.id}-${alternative}`, params: { userChorus: { melody: chorus.melody, chords: chorus.chords } } },
          body.data.title,
        );
      } catch (err) {
        throw new StepError('building the song', 500, err instanceof Error ? err.message : String(err));
      }
      return res.status(201).json({ songId: made.id });
    } catch (err) {
      return fail(res, err);
    }
  });

  const MelodySchema = z.array(z.object({ beat: z.number().min(0).max(PHRASE_BARS * 4), midi: z.number().int().min(21).max(108), duration: z.number().positive() }).strict());
  const RefitBody = z.object({ analysisId: z.string(), melody: MelodySchema.min(1, 'The melody has no notes.') }).strict();
  router.post('/api/hum/refit', async (req, res) => {
    if (!need(res, 'dir')) return;
    const body = RefitBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.message });
    try {
      const a = await load(req, body.data.analysisId);
      if (!a) return res.status(404).json({ error: 'not_found', message: 'No such hum analysis.' });
      let chords: string[];
      try {
        chords = refitChords(body.data.melody, a.transcription.key).chords;
      } catch (err) {
        throw new StepError('chords', 500, err instanceof Error ? err.message : String(err));
      }
      return res.json({ chords });
    } catch (err) {
      return fail(res, err);
    }
  });

  const OptionsBody = z.object({ analysisId: z.string(), melody: MelodySchema, slot: z.number().int().min(0).max(PHRASE_BARS * 2 - 1) }).strict();
  router.post('/api/hum/chord-options', async (req, res) => {
    if (!need(res, 'dir')) return;
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.message });
    try {
      const a = await load(req, body.data.analysisId);
      if (!a) return res.status(404).json({ error: 'not_found', message: 'No such hum analysis.' });
      let options: { chord: string; fit: number }[];
      try {
        options = chordOptions(body.data.melody, body.data.slot, a.transcription.key);
      } catch (err) {
        throw new StepError('chords', 500, err instanceof Error ? err.message : String(err));
      }
      return res.json({ options });
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}
