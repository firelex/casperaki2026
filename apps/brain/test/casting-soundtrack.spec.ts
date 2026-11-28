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
const singerVoice = { description: 'A young woman with a bright voice', seed: 33, referenceText: "Hi, I'm Kesha." };

describe('the voices', () => {
  it('gives every line its speaker\'s voice, in script order with unique ids', () => {
    const reqs = lineVoices(script, singerVoice);
    expect(reqs.map((r) => r.id)).toEqual(['backstage-1', 'backstage-2', 'banter-1', 'banter-2', 'banter-3', 'verdicts-1', 'verdicts-2', 'verdicts-3', 'verdicts-4']);
    const ice = JUDGES.find((j) => j.id === 'ice')!.voice;
    expect(reqs[0]).toMatchObject({ instruction: NARRATOR_VOICE.description, seed: NARRATOR_VOICE.seed, reference_text: NARRATOR_VOICE.referenceText, text: 'This is Kesha, and tonight is her night.' });
    expect(reqs[3]).toMatchObject({ instruction: singerVoice.description, seed: 33, reference_text: "Hi, I'm Kesha." });
    expect(reqs[4]).toMatchObject({ instruction: ice.description, seed: ice.seed, reference_text: ice.referenceText });
    // Every line is copied from its voice's reference, its delivery note steering the copy (the description stays the voice's).
    expect(reqs.every((r) => r.direction === 'zzz-delivery' && !r.instruction.includes('zzz-delivery'))).toBe(true);
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
    // A breath of 1.5 s before the song starts.
    expect(t.performance).toMatchObject({ songFromSeconds: 0, songToSeconds: 48, fadeSeconds: 3, videoStartSeconds: perf.startSeconds + 1.5 });
    expect(perf.endSeconds - perf.startSeconds).toBeCloseTo(52.5, 6);
  });
  it('places every line inside its segment, in order, never overlapping', () => {
    expect(t.lines).toHaveLength(9);
    const kinds = ['backstage', 'backstage', 'talk', 'talk', 'talk', 'verdicts', 'verdicts', 'verdicts', 'verdicts'];
    t.lines.forEach((l, i) => {
      const seg = t.segments.find((s) => s.kind === kinds[i])!;
      expect(l.startSeconds).toBeGreaterThanOrEqual(seg.startSeconds);
      expect(l.endSeconds).toBeLessThanOrEqual(seg.endSeconds);
      // Lines follow each other; a quick interjection may overlap the line before by a quarter of a second at most.
      if (i > 0 && kinds[i - 1] === kinds[i]) expect(l.startSeconds).toBeGreaterThanOrEqual(t.lines[i - 1]!.endSeconds - 0.25 - 1e-9);
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

// ---- the mix (real ffmpeg on short tones)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mixSoundtrack } from '../src/casting/mix.js';
import { wavLevels } from '../src/routes/renders.js';
import { toneWav } from './fakeVocalsService.js';

describe('the mix', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'casting-mix-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const tone = (name: string, seconds: number, hz: number) => {
    const p = join(dir, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, p]);
    return p;
  };
  it('measures a line\'s loudness per bin', () => {
    const p = join(dir, 'l.wav');
    writeFileSync(p, toneWav(1));
    const levels = wavLevels(p, 0.1);
    expect(levels).toHaveLength(10);
    expect(Math.min(...levels)).toBeGreaterThan(0);
  });
  it('makes one 48 kHz file as long as the timeline, with the lines, the music and the song in place', () => {
    const spoken = new Map(lineVoices(script, singerVoice).map((r) => [r.id, { seconds: 1, levels: [0.3] }]));
    const sections = [{ name: 'Verse', startSeconds: 0, endSeconds: 4 }, { name: 'Chorus', startSeconds: 4, endSeconds: 8 }];
    const t = layOut({ script, spoken, sections, exportSeconds: 12, entranceSeconds: 3, binSeconds: 0.05, scriptTaskId: 'x' });
    const lines = new Map([...spoken.keys()].map((id) => [id, tone(`${id}.wav`, 1, 440)]));
    const out = join(dir, 'casting.wav');
    mixSoundtrack(t, { gains: new Map([...spoken.keys()].map((id) => [id, 1])), lines, song: tone('song.mp3', 12, 220), poised: tone('poised.mp3', 30, 330), entrance: tone('entrance.mp3', 3, 550) }, out, 'ffmpeg');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate:format=duration', '-of', 'json', out]).toString();
    const info = JSON.parse(probe) as { streams: { sample_rate: string }[]; format: { duration: string } };
    expect(info.streams[0]!.sample_rate).toBe('48000');
    expect(Number(info.format.duration)).toBeCloseTo(t.durationSeconds, 1);
  });
  it('fails naming a missing music file', () => {
    const spoken = new Map(lineVoices(script, singerVoice).map((r) => [r.id, { seconds: 1, levels: [0.3] }]));
    const t = layOut({ script, spoken, sections: [{ name: 'Chorus', startSeconds: 0, endSeconds: 4 }], exportSeconds: 12, entranceSeconds: 3, binSeconds: 0.05, scriptTaskId: 'x' });
    const lines = new Map([...spoken.keys()].map((id) => [id, tone(`${id}.wav`, 1, 440)]));
    expect(() => mixSoundtrack(t, { gains: new Map([...spoken.keys()].map((id) => [id, 1])), lines, song: tone('song.mp3', 12, 220), poised: join(dir, 'Poised and Ready.mp3'), entrance: tone('e.mp3', 3, 550) }, join(dir, 'o.wav'), 'ffmpeg')).toThrow(/Poised and Ready\.mp3/);
  });
});

// ---- the castingSoundtrack task
import { mkdirSync } from 'node:fs';
import { orchestrate } from '@casperaki/arrangement';
import { canonicalStringifySong } from '@casperaki/song-schema';
import { UserAvatars } from '../src/avatars/userAvatars.js';
import { EventHub } from '../src/events.js';
import { hashCanonical } from '../src/routes/songs.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { BackgroundTasks, TaskError } from '../src/tasks/tasks.js';

describe('the castingSoundtrack task', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const songId = 'abcdef0123456789';
  let dir: string;
  let store: SongsStore;
  let speech: FakeSpeechService;
  let tasks: BackgroundTasks;
  let avatars: UserAvatars;
  let voiceOf: (singerId: string) => { description: string; seed: number } | undefined;
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'casting-3' });
  const tone = (p: string, seconds: number) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, p]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'casting-task-'));
    mkdirSync(join(dir, 'music'));
    tone(join(dir, 'music', 'Poised and Ready.mp3'), 60);
    tone(join(dir, 'music', 'The Grand Entrance.mp3'), 4);
    tone(join(dir, 'song.mp3'), 400);
    store = openSongsStore({ path: ':memory:' });
    const canonical = canonicalStringifySong(song, 2);
    store.put({ id: songId, song, canonical, hash: hashCanonical(canonical), createdAt: 't' });
    store.upsertProject({ ownerId: 'me', songId, title: 'Electric Daydream', createdAt: 't', updatedAt: 't' });
    avatars = new UserAvatars(join(dir, 'singers'));
    speech = await startFakeSpeechService();
    voiceOf = (id) => (id === 'kesha' ? { description: singerVoice.description, seed: singerVoice.seed, line: "Hi, I'm Kesha. Honestly, I'm a bit nervous." } : id === 'old' ? { description: 'x', seed: 1 } : undefined);
    tasks = new BackgroundTasks({
      store,
      events: new EventHub(),
      hash: hashCanonical,
      clock: () => new Date().toISOString(),
      castingSoundtrack: {
        client: new VocalsClient(speech.url, 'speech service'),
        filesDir: join(dir, 'files'),
        pollMs: 5,
        ffmpegBin: 'ffmpeg',
        musicDir: join(dir, 'music'),
        avatars,
        singerVoice: (_o, id) => voiceOf(id),
        exportSong: async () => ({ path: join(dir, 'song.mp3'), seconds: 400 }),
      },
    });
  });
  afterEach(async () => {
    await speech.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const written = (avatarId: string) => {
    store.insertTask({ id: 'script-1', ownerId: 'me', songId, kind: 'castingScript', input: '', startedAt: 't', options: { avatarId, outcome: 'threeOne', title: 'Electric Daydream', singerName: 'Kesha', singerDescription: null, avatarName: 'Mia' } });
    store.setTaskState('script-1', { state: 'done', result: script, message: null, finishedAt: 't' });
  };
  const refused = (f: () => unknown, status: number, code: string) => {
    try {
      f();
    } catch (err) {
      expect(err).toBeInstanceOf(TaskError);
      expect([(err as TaskError).status, (err as TaskError).code]).toEqual([status, code]);
      return;
    }
    throw new Error(`expected ${status} ${code}`);
  };
  const recipe = { pack: 'drophunter', parts: { body: '0' }, textures: {}, colors: {} };

  it('needs a written script and the singer\'s speaking voice', () => {
    refused(() => tasks.startCastingSoundtrack('me', songId), 400, 'no_script');
    const karla = avatars.save('me', { style: 'anime', name: 'Mia', recipe, singerId: 'karla' }, PNG, 't');
    written(karla.id);
    refused(() => tasks.startCastingSoundtrack('me', songId), 400, 'no_speaking_voice');
  });
  it('refuses a speaking voice that does not know its words, and copies the singer from those words', async () => {
    const old = avatars.save('me', { style: 'anime', name: 'Mia', recipe, singerId: 'old' }, PNG, 't');
    written(old.id);
    refused(() => tasks.startCastingSoundtrack('me', songId), 400, 'remake_speaking_voice');
  });
  it('fails naming a missing music file', () => {
    const mia = avatars.save('me', { style: 'anime', name: 'Mia', recipe, singerId: 'kesha' }, PNG, 't');
    written(mia.id);
    rmSync(join(dir, 'music', 'The Grand Entrance.mp3'));
    refused(() => tasks.startCastingSoundtrack('me', songId), 503, 'music_missing');
  });
  it('speaks the script, lays it out and mixes one file, recording which script it came from', async () => {
    const mia = avatars.save('me', { style: 'anime', name: 'Mia', recipe, singerId: 'kesha' }, PNG, 't');
    written(mia.id);
    const task = tasks.startCastingSoundtrack('me', songId);
    await tasks.idle();
    const done = store.getTask('me', task.id)!;
    expect(done.message ?? null).toBeNull();
    expect(done.state).toBe('done');
    const timeline = done.result as CastingTimeline;
    expect(timeline.scriptTaskId).toBe('script-1');
    expect(timeline.lines).toHaveLength(9);
    expect(timeline.lines[0]!.levels.length).toBeGreaterThan(0);
    const wav = tasks.stepFile('me', task.id, 'soundtrack', 'casting.wav');
    const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString());
    expect(seconds).toBeCloseTo(timeline.durationSeconds, 1);
    expect(speech.jobs[0]!.params['lines']).toHaveLength(9);
    const singerLine = (speech.jobs[0]!.params['lines'] as { id: string; reference_text: string }[]).find((l) => l.id === 'banter-2')!;
    expect(singerLine.reference_text).toBe("Hi, I'm Kesha. Honestly, I'm a bit nervous.");
  });
});

describe('the stage door music', () => {
  it('lasts as long as it is heard: the silence at its end is cut', async () => {
    const { audibleSeconds } = await import('../src/casting/mix.js');
    const dir = mkdtempSync(join(tmpdir(), 'casting-audible-'));
    try {
      const p = join(dir, 'entrance.mp3');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'apad=pad_dur=1.5', p]);
      expect(audibleSeconds('ffmpeg', p)).toBeCloseTo(3, 0);
      const q = join(dir, 'full.mp3');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', q]);
      expect(audibleSeconds('ffmpeg', q)).toBeCloseTo(3, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voices at one loudness', () => {
  it('measures each speaker over all their lines and evens them out', async () => {
    const { loudness, speakerGains } = await import('../src/casting/mix.js');
    const dir = mkdtempSync(join(tmpdir(), 'casting-lufs-'));
    try {
      const tone = (name: string, volume: number) => {
        const p = join(dir, name);
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', `volume=${volume}`, p]);
        return p;
      };
      const quiet = [tone('q1.wav', 0.05), tone('q2.wav', 0.05)];
      const loud = [tone('l1.wav', 0.4)];
      expect(loudness('ffmpeg', loud) - loudness('ffmpeg', quiet)).toBeCloseTo(18, 0);
      const gains = speakerGains('ffmpeg', new Map([['bob', quiet], ['ice', loud]]), -16);
      // After the gains both stand at -16 LUFS.
      expect(loudness('ffmpeg', quiet) + 20 * Math.log10(gains.get('bob')!)).toBeCloseTo(-16, 0);
      expect(loudness('ffmpeg', loud) + 20 * Math.log10(gains.get('ice')!)).toBeCloseTo(-16, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('natural timing', () => {
  const talk = (speaker: string, text: string) => line(speaker, text);
  const long = 'Well I have to say that was really something quite special for a first audition.';
  const chatty: CastingScript = {
    ...script,
    banter: [talk('ice', long), talk('nicky', 'Oh please.'), talk('ice', long), talk('bob', 'Ah, stop it.'), talk('love', long), talk('singer', long)],
  };
  const spoken = new Map(lineVoices(chatty, singerVoice).map((r) => [r.id, { seconds: 2.5, levels: [0.2] }]));
  const sections = [{ name: 'Chorus', startSeconds: 0, endSeconds: 8 }];
  const lay = (id: string) => layOut({ script: chatty, spoken, sections, exportSeconds: 20, entranceSeconds: 13, binSeconds: 0.05, scriptTaskId: id });
  const gaps = (t: CastingTimeline, kind: string) => t.lines.filter((_, i) => i > 0).map((l, i) => ({ l, prev: t.lines[i]! })).filter(({ l, prev }) => {
    const seg = t.segments.find((s) => s.kind === kind)!;
    return l.startSeconds >= seg.startSeconds && prev.startSeconds >= seg.startSeconds && l.endSeconds <= seg.endSeconds;
  }).map(({ l, prev }) => ({ gap: l.startSeconds - prev.endSeconds, text: l.text, speaker: l.speaker, prevSpeaker: prev.speaker }));
  it('varies the pauses between lines, the same way for the same script', () => {
    const g = gaps(lay('script-a'), 'talk');
    expect(new Set(g.map((x) => x.gap.toFixed(3))).size).toBeGreaterThan(2);
    expect(gaps(lay('script-a'), 'talk')).toEqual(g);
  });
  it('lets a short interjection by someone else almost overlap the line before, and only that', () => {
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((k) => gaps(lay(`script-${k}`), 'talk'));
    const overlaps = all.filter((x) => x.gap < 0);
    expect(overlaps.length).toBeGreaterThan(0);
    for (const o of overlaps) {
      expect(o.text.split(' ').length).toBeLessThanOrEqual(8);
      expect(o.speaker).not.toBe(o.prevSpeaker);
      expect(o.gap).toBeGreaterThanOrEqual(-0.25 - 1e-9);
    }
    for (const x of all) expect(x.gap).toBeLessThanOrEqual(0.75 + 1e-9);
  });
  it('never overlaps the narrator', () => {
    for (const k of ['a', 'b', 'c']) for (const x of gaps(lay(`script-${k}`), 'backstage')) expect(x.gap).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });
});
