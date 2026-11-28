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
