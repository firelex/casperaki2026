import { execFileSync } from 'node:child_process';
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
import { sectionScore, takeFingerprint } from '../src/vocals/score.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const song = (): Song => ({ ...SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8'))), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} } });

const tmp = mkdtempSync(join(tmpdir(), 'vocals-'));
afterAll(() => rmSync(tmp, { recursive: true }));

/** A fake singing service: sine-wave phrases as long as asked; counts /sing calls; can refuse. */
function fakeService() {
  const state = { sings: 0, refuse: undefined as string | undefined, down: false, shifts: [] as number[] };
  const impl = (async (url: string | URL, init?: RequestInit) => {
    if (state.down) throw new Error('connect ECONNREFUSED');
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (path === '/voices') return new Response(JSON.stringify({ voices: [{ id: 'en_prompt', label: 'Voice 1', low: 62, high: 68, median: 65 }, { id: 'en_target', label: 'Voice 2', low: 58, high: 70, median: 65 }, { id: 'zh_target', label: 'Voice 4', low: 50, high: 56, median: 53 }] }));
    if (path === '/sing') {
      state.sings++;
      state.shifts.push(body.shift);
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

  it('a fresh song: sections with vocal notes are unsung, the others none', async () => {
    const s = song();
    const { body } = await h.call('/api/vocals/status', { song: s });
    const states = Object.fromEntries(body.tracks.Vocal.map((x: { segment: string; state: string }) => [x.segment, x.state]));
    expect(states['verse1']).toBe('unsung');
    for (const seg of s.songStructure) {
      const hasVocal = (s.arrangement[seg.name]?.overrides?.['Vocal']?.bars ?? []).some((b) => Object.values(b.notes ?? {}).some((evs) => (evs as { type: string }[]).some((e) => e.type === 'vocalNote')));
      expect(states[seg.name]).toBe(hasVocal ? 'unsung' : 'none');
    }
  });

  it('sings a section into a stored take found by fingerprint: an OGG exactly as long as the section', async () => {
    const s = song();
    const r = await h.call('/api/vocals/sing', { song: s, segment: 'verse1', track: 'Vocal' });
    expect(r.status).toBe(200);
    expect(r.body.section).toEqual({ segment: 'verse1', state: 'sung' });
    const fp = takeFingerprint(sectionScore(s, 'verse1')!, 'en_prompt', 1);
    const file = join(takesDir, `${fp}.ogg`);
    expect(existsSync(file)).toBe(true);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=sample_rate,channels,duration_ts,codec_name', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
    expect([probe.codec_name, probe.sample_rate, probe.channels]).toEqual(['vorbis', '44100', 2]);
    const bars = s.songStructure.find((x) => x.name === 'verse1')!.bars.length;
    expect(Math.abs(probe.duration_ts - Math.round(((bars * 4 * 60) / s.bpm) * 44100))).toBeLessThanOrEqual(1);
    const info = JSON.parse(readFileSync(join(takesDir, `${fp}.json`), 'utf8'));
    expect(info.lufs).toBeGreaterThan(TAKE_LUFS - 8);
    expect(info.lufs).toBeLessThan(TAKE_LUFS + 1);
    // Nothing recorded on the song: the same song (even reloaded unsaved) now finds the take.
    const st = (await h.call('/api/vocals/status', { song: s })).body.tracks.Vocal.find((x: { segment: string }) => x.segment === 'verse1');
    expect(st.state).toBe('sung');
  });

  it('a section sung alike (verse2 = verse1) is sung already, without another service call', async () => {
    const before = svc.state.sings;
    const st = (await h.call('/api/vocals/status', { song: song() })).body.tracks.Vocal.find((x: { segment: string }) => x.segment === 'verse2');
    expect(st.state).toBe('sung');
    expect((await h.call('/api/vocals/sing', { song: song(), segment: 'verse2', track: 'Vocal' })).status).toBe(200);
    expect(svc.state.sings).toBe(before);
  });

  it('after a tempo change, a new take number or another voice the section is unsung again', async () => {
    const s = song();
    await h.call('/api/vocals/sing', { song: s, segment: 'verse1', track: 'Vocal' });
    const stateOf = async (x: Song) => (await h.call('/api/vocals/status', { song: x })).body.tracks.Vocal.find((y: { segment: string }) => y.segment === 'verse1').state;
    expect(await stateOf({ ...s, bpm: s.bpm + 4 })).toBe('unsung');
    expect(await stateOf({ ...s, vocals: { ...s.vocals!, takeNumbers: { verse1: 2 } } })).toBe('unsung');
    expect(await stateOf({ ...s, vocals: { ...s.vocals!, voice: 'zh_target' } })).toBe('unsung');
  });

  it('a backing vocal track is sung with its own setting, 6 dB under the lead, and listed by track', async () => {
    const s = { ...song(), backingVocals: { 'Backing vocals 1': { enabled: true, voice: 'en_target', takeNumbers: {} } } } as Song;
    const before = (await h.call('/api/vocals/status', { song: s })).body.tracks;
    expect(Object.keys(before).sort()).toEqual(['Backing vocals 1', 'Vocal']);
    expect(before['Backing vocals 1'].find((x: { segment: string }) => x.segment === 'chorus1').state).toBe('unsung');
    expect(before['Backing vocals 1'].find((x: { segment: string }) => x.segment === 'verse1').state).toBe('none');
    const r = await h.call('/api/vocals/sing', { song: s, segment: 'chorus1', track: 'Backing vocals 1' });
    expect(r.status).toBe(200);
    const fp = takeFingerprint(sectionScore(s, 'chorus1', 'Backing vocals 1')!, 'en_target', 1, 'backing');
    const info = JSON.parse(readFileSync(join(takesDir, `${fp}.json`), 'utf8'));
    expect(info.lufs).toBeLessThan(TAKE_LUFS - 4);
    const after = (await h.call('/api/vocals/status', { song: s })).body.tracks['Backing vocals 1'];
    expect(after.find((x: { segment: string }) => x.segment === 'chorus1').state).toBe('sung');
    // A backing track without a setting cannot be sung.
    expect((await h.call('/api/vocals/sing', { song: song(), segment: 'chorus1', track: 'Backing vocals 2' })).status).toBe(400);
  });

  it('sings each track at the octave its register needs for the voice', async () => {
    const at = async (x: Song, segment: string, track: string) => {
      await h.call('/api/vocals/sing', { song: x, segment, track });
      return svc.state.shifts[svc.state.shifts.length - 1];
    };
    const lead = { ...song(), bpm: 101 } as Song;
    expect(await at(lead, 'verse1', 'Vocal')).toBe(0); // female voice, lead line: as written
    const male = { ...lead, vocals: { ...lead.vocals!, voice: 'zh_target' } } as Song;
    expect(await at(male, 'verse1', 'Vocal')).toBe(-12); // male voice: an octave down
    const low = { ...lead, backingVocals: { 'Backing vocals 2': { enabled: true, voice: 'en_prompt', takeNumbers: {} } } } as Song;
    expect(await at(low, 'chorus1', 'Backing vocals 2')).toBe(12); // low backing line, female voice: an octave up
  });

  it('an unknown voice is refused before singing', async () => {
    const bad = { ...song(), bpm: 102, vocals: { enabled: true, voice: 'nobody', takeNumbers: {} } } as Song;
    const r = await h.call('/api/vocals/sing', { song: bad, segment: 'verse1', track: 'Vocal' });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/nobody/);
  });

  it('a refusal by the service is a 422 with its message; a service that is down is a 502', async () => {
    svc.state.refuse = "phrase 0: SoulX does not know the phone 'en_QQ1'.";
    const r = await h.call('/api/vocals/sing', { song: { ...song(), bpm: 97 }, segment: 'verse1', track: 'Vocal' });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/en_QQ1/);
    svc.state.refuse = undefined;
    svc.state.down = true;
    const d = await h.call('/api/vocals/sing', { song: { ...song(), bpm: 98 }, segment: 'verse1', track: 'Vocal' });
    expect(d.status).toBe(502);
    svc.state.down = false;
  });

  it('a section without vocal notes or an unknown section is a 400', async () => {
    const s = song();
    expect((await h.call('/api/vocals/sing', { song: s, segment: 'nope', track: 'Vocal' })).status).toBe(400);
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
