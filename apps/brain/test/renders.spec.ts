// Renders router — dev/local artifact endpoints.
//
// Tests both shapes the editor cares about:
//   - artifact missing → exists:false, 404 on /latest.wav
//   - artifact present → metadata is computed and the WAV streams back
//     with `audio/wav` so an <audio> element can play it.
//
// Fixture is a hand-crafted 16-bit PCM mono WAV written to a tmpdir;
// the analyzer is the same one the brain ships, so a passing test here
// pins the contract the UI consumes.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { resetRenderMetadataCache, resetRenderPeaksCache } from '../src/routes/renders.js';
import { openSongsStore, type SongsStore } from '../src/store.js';

interface Harness {
  url: string;
  tmp: string;
  artifactPath: string;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-renders-'));
  const artifactPath = join(tmp, 'out.wav');
  resetRenderMetadataCache();
  resetRenderPeaksCache();
  const store = openSongsStore({ path: ':memory:' });
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), renderArtifactPath: artifactPath };
  const app = createApp(config, { store });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    tmp,
    artifactPath,
    store,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Build a minimal but valid 16-bit PCM mono WAV at the given sample rate
 * and second-count. A 220Hz sine is used so peak/RMS are non-zero and
 * stable across runs.
 */
function makeSineWav(sampleRate: number, seconds: number, freq = 220): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.round(sampleRate * seconds);
  const dataSize = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // audioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frameCount; i++) {
    const sample = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

describe('GET /api/renders/latest', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('reports exists:false when the artifact is missing', async () => {
    const res = await fetch(`${h.url}/api/renders/latest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(false);
    expect(Object.keys(body)).toEqual(['exists']);
  });

  it('reports duration / format / level metrics for a real WAV', async () => {
    await writeFile(h.artifactPath, makeSineWav(8000, 0.5));
    const res = await fetch(`${h.url}/api/renders/latest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exists: boolean;
      durationSec: number;
      sampleRate: number;
      bitDepth: number;
      channels: number;
      peakDb: number;
      rmsDb: number;
      sizeBytes: number;
      updatedAt: string;
      url: string;
    };
    expect(body.exists).toBe(true);
    expect(body.sampleRate).toBe(8000);
    expect(body.bitDepth).toBe(16);
    expect(body.channels).toBe(1);
    expect(body.durationSec).toBeCloseTo(0.5, 2);
    // 0.5 amplitude sine → -6 dBFS peak, -9 dBFS RMS, roughly.
    expect(body.peakDb).toBeGreaterThan(-7);
    expect(body.peakDb).toBeLessThan(-5);
    expect(body.rmsDb).toBeLessThan(-7);
    expect(body.sizeBytes).toBeGreaterThan(0);
    expect(body.url).toBe('/api/renders/latest.wav');
    expect(() => new Date(body.updatedAt)).not.toThrow();
  });
});

describe('GET /api/renders/latest.wav', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns 404 when the artifact is missing', async () => {
    const res = await fetch(`${h.url}/api/renders/latest.wav`);
    expect(res.status).toBe(404);
  });

  it('streams the WAV bytes with audio/wav when present', async () => {
    const wav = makeSineWav(8000, 0.25);
    await writeFile(h.artifactPath, wav);
    const res = await fetch(`${h.url}/api/renders/latest.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/audio\/wav/u);
    expect(Number(res.headers.get('content-length'))).toBe(wav.length);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(wav.length);
    // RIFF/WAVE header round-trips.
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
  });
});

describe('GET /api/renders/latest/peaks', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('reports exists:false with empty arrays when no artifact', async () => {
    const res = await fetch(`${h.url}/api/renders/latest/peaks?bins=8`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; peaks: number[]; rms: number[] };
    expect(body.exists).toBe(false);
    expect(body.peaks).toEqual([]);
    expect(body.rms).toEqual([]);
  });

  it('returns N amplitude bins for a real WAV', async () => {
    await writeFile(h.artifactPath, makeSineWav(8000, 0.5));
    const res = await fetch(`${h.url}/api/renders/latest/peaks?bins=16`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exists: boolean;
      bins: number;
      sampleRate: number;
      channels: number;
      durationSec: number;
      peaks: number[];
      rms: number[];
    };
    expect(body.exists).toBe(true);
    expect(body.bins).toBe(16);
    expect(body.sampleRate).toBe(8000);
    expect(body.channels).toBe(1);
    expect(body.durationSec).toBeCloseTo(0.5, 2);
    expect(body.peaks).toHaveLength(16);
    expect(body.rms).toHaveLength(16);
    // 0.5-amplitude sine → peak around 0.5 (16-bit quantisation),
    // RMS around 0.5/sqrt(2) ≈ 0.35.
    for (const p of body.peaks) {
      expect(p).toBeGreaterThan(0.4);
      expect(p).toBeLessThanOrEqual(0.51);
    }
    for (const r of body.rms) {
      expect(r).toBeGreaterThan(0.25);
      expect(r).toBeLessThan(0.4);
    }
  });

  it('rejects an out-of-range bins query', async () => {
    const res = await fetch(`${h.url}/api/renders/latest/peaks?bins=99999`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_query');
  });

  it('uses the default bins when the query omits it', async () => {
    await writeFile(h.artifactPath, makeSineWav(8000, 0.25));
    const res = await fetch(`${h.url}/api/renders/latest/peaks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peaks: number[] };
    expect(body.peaks).toHaveLength(512);
  });
});
