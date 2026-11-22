// Sequencer track editing (any signed-in user; the /api session gate applies).
//
//   POST /api/tracks/options  { song }      -> { tracks, families }
//     every track's family / sound / whether it can be regenerated, and per
//     instrument family the sounds the song's genre allows (public names).
//   POST /api/tracks/edit     { song, op }  -> { song, track }
//     op: { kind: 'changeSound', track, soundId }
//       | { kind: 'newPattern', track }
//       | { kind: 'addTrack', family, segments, soundId? }
//     The edit is recorded in the song's generator block and only the edited
//     track changes in the posted (working) song. Removing a track is a
//     client-side edit.
//
// See packages/arrangement/src/edits/track-edits.ts.

import { Router, type Response } from 'express';
import { z } from 'zod';

import { editTrack, TrackEditError, TrackEditRequestSchema, trackOptions } from '@casperaki/arrangement';
import { parseSong, type Song } from '@casperaki/song-schema';

const OptionsBody = z.object({ song: z.unknown() }).strict();
const EditBody = z.object({ song: z.unknown(), op: TrackEditRequestSchema }).strict();

export function createTracksRouter(): Router {
  const router = Router();

  router.post('/api/tracks/options', (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.issues[0]?.message });
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => trackOptions(song));
  });

  router.post('/api/tracks/edit', (req, res) => {
    const body = EditBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => editTrack(song, body.data.op));
  });

  return router;
}

function songOf(raw: unknown, res: Response): Song | undefined {
  try {
    return parseSong(raw);
  } catch (err) {
    res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function run(res: Response, fn: () => unknown) {
  try {
    return res.json(fn());
  } catch (err) {
    if (err instanceof TrackEditError) return res.status(err.status).json({ error: err.code, message: err.message });
    return res.status(500).json({ error: 'track_edit_failed', message: err instanceof Error ? err.message : String(err) });
  }
}
