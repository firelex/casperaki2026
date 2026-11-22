// Hum lab (a test bench for "hum a song"): find the beat in a recording.
//
//   POST /api/lab/beats   body: the recording (any audio type ffmpeg reads)
//     → { beats: [s], downbeats: [s], bpm, beatsPerBar, seconds, tookMs }
//
// Beat This! (CPJKU, ISMIR 2024, MIT) runs as it is, in its own Python
// environment (BEAT_THIS_PYTHON in brain.env), via python/beat_track.py.
// Not configured → 503 naming the setting.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import express, { Router } from 'express';

const run = promisify(execFile);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../python/beat_track.py');

export interface LabRouterDeps {
  readonly ffmpegBin: string;
  /** Python of the Beat This! environment; undefined → the route answers 503. */
  readonly beatThisPython: string | undefined;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function createLabRouter({ ffmpegBin, beatThisPython }: LabRouterDeps): Router {
  const router = Router();
  router.post('/api/lab/beats', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    if (!beatThisPython) {
      return res.status(503).json({ error: 'beat_tracker_not_configured', message: 'Set BEAT_THIS_PYTHON in brain.env to the Python of the Beat This! environment.' });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'no_audio', message: 'Send the recording as the request body.' });
    const dir = await mkdtemp(join(tmpdir(), 'casperaki-lab-'));
    try {
      const input = join(dir, 'input');
      const wav = join(dir, 'hum.wav');
      await writeFile(input, body);
      await run(ffmpegBin, ['-loglevel', 'error', '-y', '-i', input, '-ac', '1', '-ar', '22050', wav]);
      const { stdout: dur } = await run(ffmpegBin.replace(/ffmpeg$/u, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]);
      const t0 = Date.now();
      const { stdout } = await run(beatThisPython, [SCRIPT, wav], { maxBuffer: 16 * 1024 * 1024 });
      const tookMs = Date.now() - t0;
      const { beats, downbeats } = JSON.parse(stdout) as { beats: number[]; downbeats: number[] };
      const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
      const bpm = gaps.length ? 60 / median(gaps) : null;
      const perBar = downbeats.slice(1).map((d, i) => beats.filter((b) => b >= downbeats[i]! - 0.02 && b < d - 0.02).length);
      return res.json({ beats, downbeats, bpm, beatsPerBar: perBar.length ? median(perBar) : null, seconds: Number(dur), tookMs });
    } catch (err) {
      return res.status(500).json({ error: 'beat_tracking_failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return router;
}
