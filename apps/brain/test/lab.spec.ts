// Hum lab: recordings sent with a meant tempo (x-meant-bpm) are kept as test data.
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLabRouter } from '../src/routes/lab.js';

/** One second of silence as a 16-bit mono WAV at 22,050 Hz. */
function silentWav(): Buffer {
  const n = 22050;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24);
  b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

describe('POST /api/lab/beats', () => {
  let dir: string;
  let fakePython: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lab-spec-'));
    // Stands in for the Beat This! Python: prints fixed beats whatever it is given.
    fakePython = join(dir, 'fake-python.sh');
    await writeFile(fakePython, '#!/bin/sh\necho \'{"beats":[0.1,0.6,1.1],"downbeats":[0.1]}\'\n');
    await chmod(fakePython, 0o755);
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  async function post(humLabDir: string | undefined, headers: Record<string, string>) {
    const app = express().use(createLabRouter({ ffmpegBin: 'ffmpeg', beatThisPython: fakePython, humLabDir }));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      return await fetch(`http://127.0.0.1:${address.port}/api/lab/beats`, { method: 'POST', body: silentWav(), headers: { 'content-type': 'audio/wav', ...headers } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('keeps the recording and a JSON when x-meant-bpm is sent', async () => {
    const keep = join(dir, 'kept');
    const res = await post(keep, { 'x-meant-bpm': '100' });
    expect(res.status).toBe(200);
    const files = (await readdir(keep)).sort();
    expect(files).toHaveLength(2);
    const json = JSON.parse(await readFile(join(keep, files.find((f) => f.endsWith('.json'))!), 'utf8'));
    expect(json.meantBpm).toBe(100);
    expect(json.detectedBpm).toBeCloseTo(120);
    expect(json.beats).toEqual([0.1, 0.6, 1.1]);
    expect(files.some((f) => f.endsWith('.wav'))).toBe(true);
  });

  it('keeps nothing without x-meant-bpm', async () => {
    const keep = join(dir, 'not-kept');
    const res = await post(keep, {});
    expect(res.status).toBe(200);
    await expect(readdir(keep)).rejects.toThrow();
  });

  it('answers 503 naming the setting when x-meant-bpm is sent but no folder is set', async () => {
    const res = await post(undefined, { 'x-meant-bpm': '100' });
    expect(res.status).toBe(503);
    expect((await res.json()).message).toContain('BRAIN_HUM_LAB_DIR');
  });
});
