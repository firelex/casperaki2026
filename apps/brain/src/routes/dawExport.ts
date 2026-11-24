// DAW exports of a saved song (stems, REAPER project, Logic bundle).
//
//   POST /api/songs/:id/daw-export   { format, tracks, midi?, colors? } -> job status (202)
//   GET  /api/daw-exports/:jobId      -> job status
//   GET  /api/daw-exports/:jobId/download -> the zip
//
// The song must be one of the caller's projects; jobs are visible to their owner only.

import { Router, type Request } from 'express';
import { z } from 'zod';

import type { DawExportService } from '../export/dawExportService.js';
import { parseSong, type Song } from '@casperaki/song-schema';

import type { SongsStore } from '../store.js';
import { canonicalStringifySong } from '@casperaki/song-schema';

const Body = z
  .object({
    format: z.enum(['stems', 'reaper', 'logic']),
    tracks: z.array(z.string().min(1).max(120)).max(64),
    midi: z
      .object({
        song: z.string().max(4_000_000).optional(),
        tracks: z.record(z.string().max(120), z.string().max(4_000_000)).optional(),
      })
      .strict()
      .optional(),
    colors: z.record(z.string().max(120), z.string().regex(/^#[0-9a-f]{6}$/iu)).optional(),
  })
  .strict();

export function createDawExportRouter(deps: {
  store: SongsStore;
  exports: DawExportService | undefined;
  ownerOf: (req: Request) => string;
}): Router {
  const { store, exports, ownerOf } = deps;
  const router = Router();
  const notConfigured = { error: 'export_not_configured', message: 'CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.' };

  router.post('/api/songs/:id/daw-export', (req, res) => {
    if (!exports) return res.status(503).json(notConfigured);
    const body = Body.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body' });
    }
    const owner = ownerOf(req);
    const project = store.getProject(owner, req.params.id);
    const stored = project ? store.get(req.params.id) : undefined;
    if (!project || !stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const canonical = stored.canonical;
    const status = exports.start(
      owner,
      {
        songId: stored.id,
        canonical,
        title: project.title,
        bpm: stored.song.bpm,
        sections: stored.song.songStructure.map((s) => ({ name: s.name, bars: s.lengthInBars ?? s.bars.length })),
      },
      body.data,
    );
    return res.status(202).json(publicStatus(status));
  });

  router.get('/api/daw-exports/:jobId', (req, res) => {
    if (!exports) return res.status(503).json(notConfigured);
    const s = exports.status(req.params.jobId);
    if (!s || s.owner !== ownerOf(req)) return res.status(404).json({ error: 'not_found' });
    return res.json(publicStatus(s));
  });

  router.get('/api/daw-exports/:jobId/download', (req, res) => {
    if (!exports) return res.status(503).json(notConfigured);
    const s = exports.status(req.params.jobId);
    if (!s || s.owner !== ownerOf(req)) return res.status(404).json({ error: 'not_found' });
    if (s.state !== 'done' || !s.fileName) return res.status(409).json({ error: 'not_ready', state: s.state });
    return res.download(exports.zipPath(s.id), s.fileName);
  });

  return router;
}

function publicStatus(s: ReturnType<DawExportService['status']> & object) {
  const { owner: _owner, ...rest } = s;
  return { ...rest, ...(s.state === 'done' ? { downloadUrl: `/api/daw-exports/${s.id}/download` } : {}) };
}
