// Casting plan 4 (docs/superpowers/plans/2026-11-28-casting-4-soundtrack.md): every line spoken in its character's
// voice, the timeline, the mix and the castingSoundtrack task.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JUDGES, NARRATOR_VOICE } from '../src/casting/cast.js';
import { lineVoices, speakLines } from '../src/casting/voices.js';
import type { CastingScript } from '../src/casting/writer.js';
import { VocalsClient } from '../src/sing/vocalsClient.js';
import { startFakeSpeechService, type FakeSpeechService } from './fakeSpeechService.js';

const line = (speaker: string, text: string) => ({ speaker, text, delivery: 'zzz-delivery', gesture: 'nod' }) as CastingScript['banter'][number];
export const script: CastingScript = {
  outcome: 'threeOne',
  votes: { ice: 'yes', nicky: 'yes', love: 'yes', bob: 'no' },
  backstage: [line('narrator', 'This is Kesha, and tonight is her night.'), line('narrator', 'Here she goes.')],
  banter: [line('bob', 'Come on in, love!'), line('singer', 'Hi, I am Kesha.'), line('ice', 'Let us hear it.')],
  verdicts: [line('bob', 'No from me, love.'), line('nicky', 'Yes, baby!'), line('love', 'A yes from me.'), line('ice', 'Yes. Well done.')],
};
const singerVoice = { description: 'A young woman with a bright voice', seed: 33 };

describe('the voices', () => {
  it('gives every line its speaker\'s voice, in script order with unique ids', () => {
    const reqs = lineVoices(script, singerVoice);
    expect(reqs.map((r) => r.id)).toEqual(['backstage-1', 'backstage-2', 'banter-1', 'banter-2', 'banter-3', 'verdicts-1', 'verdicts-2', 'verdicts-3', 'verdicts-4']);
    const ice = JUDGES.find((j) => j.id === 'ice')!.voice;
    expect(reqs[0]).toMatchObject({ instruction: NARRATOR_VOICE.description, seed: NARRATOR_VOICE.seed, text: 'This is Kesha, and tonight is her night.' });
    expect(reqs[3]).toMatchObject({ instruction: singerVoice.description, seed: 33 });
    expect(reqs[4]).toMatchObject({ instruction: ice.description, seed: ice.seed });
    // The voice is the description alone (the delivery note would change the person).
    expect(reqs.every((r) => !r.instruction.includes('zzz-delivery'))).toBe(true);
  });
});

describe('speaking the lines', () => {
  let speech: FakeSpeechService;
  let dir: string;
  beforeEach(async () => {
    speech = await startFakeSpeechService();
    dir = mkdtempSync(join(tmpdir(), 'casting-voices-'));
  });
  afterEach(async () => {
    await speech.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  it('has the speech service speak them and keeps each line\'s file and length', async () => {
    const client = new VocalsClient(speech.url, 'speech service');
    const spoken = await speakLines({ client, filesDir: dir, pollMs: 5, signal: new AbortController().signal, jobs: null, setJobs: () => undefined, setSteps: () => undefined }, lineVoices(script, singerVoice));
    expect(speech.jobs[0]!.params['stage']).toBe('lines');
    expect([...spoken.keys()]).toHaveLength(9);
    const first = spoken.get('backstage-1')!;
    expect(first.seconds).toBeGreaterThan(0);
    expect(existsSync(first.file)).toBe(true);
  });
  it('fails with the speech service\'s message', async () => {
    const client = new VocalsClient(speech.url, 'speech service');
    speech.fail('Breeze ran out of memory');
    await expect(speakLines({ client, filesDir: dir, pollMs: 5, signal: new AbortController().signal, jobs: null, setJobs: () => undefined, setSteps: () => undefined }, lineVoices(script, singerVoice))).rejects.toThrow(/out of memory/);
  });
});

// ---- the timeline
import { layOut, type CastingTimeline } from '../src/casting/timeline.js';

describe('the timeline', () => {
  const spoken = new Map(lineVoices(script, singerVoice).map((r, i) => [r.id, { seconds: 2 + (i % 3), levels: [0.1, 0.5, 0.2] }]));
  const sections = [
    { name: 'Intro', startSeconds: 0, endSeconds: 8 },
    { name: 'Verse 1', startSeconds: 8, endSeconds: 24 },
    { name: 'Pre-chorus', startSeconds: 24, endSeconds: 32 },
    { name: 'Chorus 1', startSeconds: 32, endSeconds: 48 },
    { name: 'Verse 2', startSeconds: 48, endSeconds: 64 },
  ];
  const t: CastingTimeline = layOut({ script, spoken, sections, exportSeconds: 120, entranceSeconds: 14.544, binSeconds: 0.05, scriptTaskId: 'task-1' });
  it('runs backstage, door, talk, performance, verdicts, end to end', () => {
    expect(t.segments.map((s) => s.kind)).toEqual(['backstage', 'door', 'talk', 'performance', 'verdicts']);
    for (let i = 1; i < t.segments.length; i++) expect(t.segments[i]!.startSeconds).toBeCloseTo(t.segments[i - 1]!.endSeconds, 6);
    expect(t.segments[0]!.startSeconds).toBe(0);
    expect(t.durationSeconds).toBeCloseTo(t.segments.at(-1)!.endSeconds, 6);
    expect(t.scriptTaskId).toBe('task-1');
  });
  it('gives the stage door the whole entrance music', () => {
    const door = t.segments[1]!;
    expect(door.endSeconds - door.startSeconds).toBeCloseTo(14.544, 6);
  });
  it('performs the song to the end of its first chorus (not the pre-chorus), then fades 3 s', () => {
    const perf = t.segments[3]!;
    expect(t.performance).toMatchObject({ songFromSeconds: 0, songToSeconds: 48, fadeSeconds: 3, videoStartSeconds: perf.startSeconds });
    expect(perf.endSeconds - perf.startSeconds).toBeCloseTo(51, 6);
  });
  it('places every line inside its segment, in order, never overlapping', () => {
    expect(t.lines).toHaveLength(9);
    const kinds = ['backstage', 'backstage', 'talk', 'talk', 'talk', 'verdicts', 'verdicts', 'verdicts', 'verdicts'];
    t.lines.forEach((l, i) => {
      const seg = t.segments.find((s) => s.kind === kinds[i])!;
      expect(l.startSeconds).toBeGreaterThanOrEqual(seg.startSeconds);
      expect(l.endSeconds).toBeLessThanOrEqual(seg.endSeconds);
      if (i > 0 && kinds[i - 1] === kinds[i]) expect(l.startSeconds).toBeGreaterThanOrEqual(t.lines[i - 1]!.endSeconds + 0.35 - 1e-9);
    });
    expect(t.lines[0]).toMatchObject({ speaker: 'narrator', gesture: 'nod', levels: [0.1, 0.5, 0.2], id: 'backstage-1' });
    // The backstage music plays a moment before the narrator starts.
    expect(t.lines[0]!.startSeconds).toBeCloseTo(1.5, 6);
  });
  it('refuses a song whose export ends before the first chorus does, naming both', () => {
    expect(() => layOut({ script, spoken, sections, exportSeconds: 40, entranceSeconds: 14.544, binSeconds: 0.05, scriptTaskId: 'x' })).toThrow(/48.*40/);
  });
  it('refuses a song without a chorus', () => {
    expect(() => layOut({ script, spoken, sections: sections.filter((s) => !s.name.startsWith('Chorus')), exportSeconds: 120, entranceSeconds: 14.544, binSeconds: 0.05, scriptTaskId: 'x' })).toThrow(/chorus/);
  });
});
