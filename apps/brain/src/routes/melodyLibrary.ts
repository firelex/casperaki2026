// The melody library (Melodies page), for any signed-in user (permissions come later).
//
//   GET    /api/melody-library?kind=hooks|remix&source&range&type&tempo&feel&style&original&remix&q&offset&limit
//          → { total, items, facets, noHooksYet? }   a page of entries (see melodies/melodyLibrary.ts)
//   GET    /api/melody-library/:bank/:id            one entry as notes and half-bar chords in beats, at sung pitch
//   PUT    /api/melody-library/:bank/:id            save the whole edited entry { melody, chords, artist, useOriginal,
//                                                   useRemix } → the entry; 422 { problems } when the check refuses it
//   DELETE /api/melody-library/:bank/:id/edit       back to the stored version → the entry
//   POST   /api/melody-library/chord-options        { melody, bars, slot } → { options } every chord the fitter knows,
//                                                   ranked for that half bar of the melody (key C)

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { chordOptions } from '../hum/fit.js';
import { MelodyLibrary, MelodyLibraryError } from '../melodies/melodyLibrary.js';
import { DEV_OWNER_ID } from './songs.js';

const Flag = z.enum(['1', '0']).transform((v) => v === '1');
const ListQuery = z
  .object({
    kind: z.enum(['hooks', 'remix']),
    source: z.enum(['song', 'melodySauce', 'casperaki']).optional(),
    range: z.enum(['narrow', 'medium', 'wide']).optional(),
    type: z.string().min(1).max(40).optional(),
    tempo: z.coerce.number().positive().max(400).optional(),
    feel: z.string().min(1).max(40).optional(),
    style: z.string().min(1).max(40).optional(),
    original: Flag.optional(),
    remix: Flag.optional(),
    q: z.string().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const Note = z.object({ beat: z.number().min(0), midi: z.number().int().min(0).max(127), duration: z.number().positive() }).strict();
const SaveBody = z
  .object({
    melody: z.array(Note).max(400),
    chords: z.array(z.string().min(1).max(20)).max(64),
    artist: z.string().max(200),
    useOriginal: z.boolean(),
    useRemix: z.boolean(),
  })
  .strict();
const OptionsBody = z.object({ melody: z.array(Note).max(400), bars: z.number().int().min(1).max(16), slot: z.number().int().min(0) }).strict();
const KEY_C = { tonic: 0, scale: 'major' } as const;

/** Who saved an edit: the signed-in user's email (the dev mode without sign-in: its local owner). */
const editorOf = (req: Request) => req.user?.email ?? DEV_OWNER_ID;

export function createMelodyLibraryRouter(deps: { library: MelodyLibrary }): Router {
  const { library } = deps;
  const router = Router();

  router.get('/api/melody-library', (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return invalid(res, 'invalid_query', q.error);
    const { offset, limit, ...filters } = q.data;
    return run(res, () => library.list({ ...filters, offset: offset ?? 0, limit: limit ?? 50 }));
  });

  router.post('/api/melody-library/chord-options', (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return invalid(res, 'invalid_body', body.error);
    const { melody, bars, slot } = body.data;
    if (slot >= bars * 2) return res.status(400).json({ error: 'invalid_body', message: `slot: ${bars} bars have half bars 0..${bars * 2 - 1}, got ${slot}.` });
    return run(res, () => ({ options: chordOptions(melody, slot, KEY_C, bars) }));
  });

  router.get('/api/melody-library/:bank/:id', (req, res) => run(res, () => library.entry(req.params.bank, req.params.id)));

  router.put('/api/melody-library/:bank/:id', (req, res) => {
    const body = SaveBody.safeParse(req.body);
    if (!body.success) return invalid(res, 'invalid_body', body.error);
    return run(res, () => library.save(req.params.bank, req.params.id, body.data, editorOf(req)));
  });

  router.delete('/api/melody-library/:bank/:id/edit', (req, res) => run(res, () => library.revert(req.params.bank, req.params.id)));

  return router;
}

function invalid(res: Response, error: string, err: z.ZodError) {
  const issue = err.issues[0];
  return res.status(400).json({ error, message: issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'invalid request' });
}

function run(res: Response, fn: () => unknown) {
  try {
    return res.json(fn());
  } catch (err) {
    if (err instanceof MelodyLibraryError) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.problems ? { problems: err.problems } : {}) });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[melody-library] ${message}`);
    return res.status(500).json({ error: 'melody_library_failed', message });
  }
}
