// The melody library (Melodies page), read-only, for any signed-in user.
//
//   GET /api/melody-library?kind=hooks|remix&bank&type&tempo&feel&q&offset&limit
//       → { total, items, facets, noHooksYet? }   a page of entries (see melodies/melodyLibrary.ts)
//   GET /api/melody-library/:bank/:id
//       → one entry as notes and half-bar chords in beats, at sung pitch (bank pitch + 12)

import { Router, type Response } from 'express';
import { z } from 'zod';

import { MelodyLibrary, MelodyLibraryError } from '../melodies/melodyLibrary.js';

const ListQuery = z
  .object({
    kind: z.enum(['hooks', 'remix']),
    bank: z.string().min(1).max(80).optional(),
    type: z.string().min(1).max(40).optional(),
    tempo: z.coerce.number().positive().max(400).optional(),
    feel: z.string().min(1).max(40).optional(),
    q: z.string().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export function createMelodyLibraryRouter(deps: { library: MelodyLibrary }): Router {
  const { library } = deps;
  const router = Router();

  router.get('/api/melody-library', (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      const issue = q.error.issues[0];
      return res.status(400).json({ error: 'invalid_query', message: issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'invalid query' });
    }
    const { offset, limit, ...filters } = q.data;
    return run(res, () => library.list({ ...filters, offset: offset ?? 0, limit: limit ?? 50 }));
  });

  router.get('/api/melody-library/:bank/:id', (req, res) => run(res, () => library.entry(req.params.bank, req.params.id)));

  return router;
}

function run(res: Response, fn: () => unknown) {
  try {
    return res.json(fn());
  } catch (err) {
    if (err instanceof MelodyLibraryError) return res.status(err.status).json({ error: err.code, message: err.message });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[melody-library] ${message}`);
    return res.status(500).json({ error: 'melody_library_failed', message });
  }
}
