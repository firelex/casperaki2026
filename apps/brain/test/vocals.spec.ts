import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, type Song } from '@casperaki/song-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore } from '../src/store.js';
import { TAKE_LUFS, wav16Mono } from '../src/vocals/takes.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const song = (): Song => ({ ...SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8'))), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} } });

const tmp = mkdtempSync(join(tmpdir(), 'vocals-'));
afterAll(() => rmSync(tmp, { recursive: true }));

/** A fake singing service: sine-wave phrases as long as asked; counts /sing calls; can refuse. */
function fakeService() {
  const state = { sings: 0, refuse: undefined as string | undefined, down: false };
  const impl = (async (url: string | URL, init?: RequestInit) => {
    if (state.down) throw new Error('connect ECONNREFUSED');
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (path === '/voices') return new Response(JSON.stringify({ voices: [{ id: 'en_prompt', label: 'Voice 1', octave: 0, low: 62, high: 68, median: 65 }] }));
    if (path === '/sing') {
      state.sings++;
      if (state.refuse) return new Response(JSON.stringify({ error: state.refuse }), { status: 422 });
      const phrases = body.phrases.map((p: { duration: number[] }) => {
        const n = Math.round(p.duration.reduce((a, b) => a + b, 0) * 24000);
        const x = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 24000));
        return { wav: wav16Mono(x, 24000).toString('base64') };
      });
      return new Response(JSON.stringify({ sampleRate: 24000, phrases, tookMs: 1 }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { state, impl };
}

async function boot(env: Record<string, string>, fetchImpl?: typeof fetch) {
  const store = openSongsStore({ path: ':memory:' });
  const config = loadConfig({ BRAIN_MELODY_EDITS_PATH: join(tmp, 'edits.json'), ...env } as NodeJS.ProcessEnv);
  const app = createApp(config, { store, ...(fetchImpl ? { vocalsFetch: fetchImpl } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(url + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { call, stop: () => new Promise<void>((r) => server.close(() => { store.close(); r(); })) };
}

describe('sung vocals routes', () => {
  const takesDir = join(tmp, 'takes');
  const svc = fakeService();
  let h: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    h = await boot({ SOULX_SERVICE_URL: 'http://soulx.test', BRAIN_VOCAL_TAKES_DIR: takesDir }, svc.impl);
  });
  afterAll(() => h.stop());

  it('lists the voices', async () => {
    expect((await h.call('/api/vocals/voices')).body.voices[0].id).toBe('en_prompt');
  });

  it('a fresh song: sections with vocal notes are missing, the others none', async () => {
    const s = song();
    const { body } = await h.call('/api/vocals/status', { song: s });
    const states = Object.fromEntries(body.sections.map((x: { segment: string; state: string }) => [x.segment, x.state]));
    expect(states['verse1']).toBe('missing');
    for (const seg of s.songStructure) {
      const hasVocal = (s.arrangement[seg.name]?.overrides?.['Vocal']?.bars ?? []).some((b) => Object.values(b.notes ?? {}).some((evs) => (evs as { type: string }[]).some((e) => e.type === 'vocalNote')));
      expect(states[seg.name]).toBe(hasVocal ? 'missing' : 'none');
    }
  });

  it('sings a section into a take as long as the section, normalised, recorded as an artifact', async () => {
    const s = song();
    const r = await h.call('/api/vocals/sing', { song: s, segment: 'verse1' });
    expect(r.status).toBe(200);
    const a = r.body.artifact;
    const fp = a.conditioning.hashes[0];
    expect(a).toMatchObject({ kind: 'soulx-vocal', modelId: 'soulx-singer', seed: 1, prompt: 'en_prompt', attachedTo: { scope: 'segment', segment: 'verse1', instrument: 'Vocal' }, output: { uri: `vocal-take:${fp}.wav` } });
    const bars = s.songStructure.find((x) => x.name === 'verse1')!.bars.length;
    expect(a.output.durationSeconds).toBeCloseTo((bars * 4 * 60) / s.bpm, 3);
    // TAKE_LUFS, or quieter when the peak cap holds the gain back.
    expect(a.output.lufs).toBeGreaterThan(TAKE_LUFS - 8);
    expect(a.output.lufs).toBeLessThan(TAKE_LUFS + 1);
    const file = join(takesDir, `${fp}.wav`);
    expect(existsSync(file)).toBe(true);
    // 44.1 kHz stereo 16-bit, exactly the section's length.
    const wav = readFileSync(file);
    expect([wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual([2, 44100, 16]);
    // Exactly the section's length (to the sample), so phrases stay on the beat.
    const dataAt = wav.indexOf('data');
    const frames = wav.readUInt32LE(dataAt + 4) / 4;
    expect(Math.abs(frames - Math.round(((bars * 4 * 60) / s.bpm) * 44100))).toBeLessThanOrEqual(1);

    // Recorded on the song, the section is current.
    const sung = { ...s, aiArtifacts: [a] };
    const st = (await h.call('/api/vocals/status', { song: sung })).body.sections.find((x: { segment: string }) => x.segment === 'verse1');
    expect(st.state).toBe('current');
  });

  it('a section sung alike (verse2 = verse1) reuses the take without singing again', async () => {
    const before = svc.state.sings;
    const r = await h.call('/api/vocals/sing', { song: song(), segment: 'verse2' });
    expect(r.status).toBe(200);
    expect(svc.state.sings).toBe(before);
  });

  it('after a tempo change the take is stale', async () => {
    const s = song();
    const a = (await h.call('/api/vocals/sing', { song: s, segment: 'verse1' })).body.artifact;
    const faster = { ...s, bpm: s.bpm + 4, aiArtifacts: [a] };
    const st = (await h.call('/api/vocals/status', { song: faster })).body.sections.find((x: { segment: string }) => x.segment === 'verse1');
    expect(st.state).toBe('stale');
  });

  it('a take whose section no longer has vocal notes is unused (and playback must drop it)', async () => {
    const s = song();
    const a = (await h.call('/api/vocals/sing', { song: s, segment: 'verse1' })).body.artifact;
    const cleared = structuredClone({ ...s, aiArtifacts: [a] });
    delete cleared.arrangement['verse1']!.overrides!['Vocal'];
    const st = (await h.call('/api/vocals/status', { song: cleared })).body.sections.find((x: { segment: string }) => x.segment === 'verse1');
    expect(st.state).toBe('unused');
  });

  it('a refusal by the service is a 422 with its message; a service that is down is a 502', async () => {
    svc.state.refuse = "phrase 0: SoulX does not know the phone 'en_QQ1'.";
    const r = await h.call('/api/vocals/sing', { song: { ...song(), bpm: 97 }, segment: 'verse1' });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/en_QQ1/);
    svc.state.refuse = undefined;
    svc.state.down = true;
    const d = await h.call('/api/vocals/sing', { song: { ...song(), bpm: 98 }, segment: 'verse1' });
    expect(d.status).toBe(502);
    svc.state.down = false;
  });

  it('a section without vocal notes or an unknown section is a 400', async () => {
    const s = song();
    expect((await h.call('/api/vocals/sing', { song: s, segment: 'nope' })).status).toBe(400);
  });
});

describe('sung vocals not configured', () => {
  it('answers 503 naming the missing settings', async () => {
    const h = await boot({});
    const r = await h.call('/api/vocals/status', { song: song() });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/SOULX_SERVICE_URL and BRAIN_VOCAL_TAKES_DIR/);
    await h.stop();
  });
});
