// Sing in the web app: the Vocal track's menu, a sing task's steps in the Tasks list, audio-only tracks (ad-libs),
// stale takes, the credit.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';
import { vocalTakeFingerprint } from '@casperaki/song-schema';

import { tasksApi, type BackgroundTask, type TaskStep } from '../src/api/tasks';
import { audioOnlyTracks } from '../src/editor/audioOnlyTracks';
import { buildSequencerModel } from '../src/editor/sequencerModel';
import { laneGains, mixerStrips } from '../src/audio/vocalLanes';
import { hasNotes } from '../src/editor/audioOnlyTracks';
import { lyricsWritten, staleTakes, startOnSaved, vocalMenu, type VocalMenuInput } from '../src/editor/singing';
import { creditedMp3, withCommentTag } from '../src/export/vocalsCredit';
import { TaskSteps } from '../src/layout/TaskSteps';
import { VOCALS_CREDIT, VocalsCredit } from '../src/layout/VocalsCredit';
import { makeFixtureSong } from './fixture';

const CREDIT = 'Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0';

const singTask = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 's1',
  kind: 'sing',
  songId: 'abc123def4567890',
  title: 'Test Track',
  state: 'running',
  startedAt: '2026-11-25T10:00:00.000Z',
  ...over,
});

const base: VocalMenuInput = { melodyShown: true, lyricsWritten: true, hasSungTakes: false, singTask: undefined, lyricsTask: undefined, transcribeTask: undefined, sungSections: 3 };

describe('the Vocal track menu', () => {
  it('Sing waits for written lyrics', () => {
    const m = vocalMenu({ ...base, lyricsWritten: false });
    expect(m.sing).toEqual({ label: 'Sing', disabled: true, hint: 'Write lyrics first' });
    expect(vocalMenu(base).sing).toEqual({ label: 'Sing', disabled: false, hint: 'in the background' });
  });
  it('says Already singing while one runs, and turns Write melody and Write lyrics off', () => {
    const m = vocalMenu({ ...base, singTask: singTask() });
    expect(m.sing).toMatchObject({ disabled: true, hint: 'Already singing' });
    expect(m.writeMelody).toMatchObject({ disabled: true, hint: 'Already singing' });
    expect(m.writeLyrics).toMatchObject({ disabled: true, hint: 'Already singing' });
    const noMelody = vocalMenu({ ...base, melodyShown: false, singTask: singTask() });
    expect(noMelody.writeMelody).toMatchObject({ disabled: true, hint: 'Already singing' });
  });
  it('Sing waits while the lyrics are being written (running or waiting its turn)', () => {
    expect(vocalMenu({ ...base, lyricsTask: singTask({ kind: 'writeLyrics' }) }).sing).toEqual({ label: 'Sing', disabled: true, hint: 'Already writing lyrics' });
    // Lyrics written and waiting to go in: Sing waits for them (it would sing the old words).
    expect(vocalMenu({ ...base, lyricsTask: singTask({ kind: 'writeLyrics', state: 'ready' }) }).sing).toMatchObject({ disabled: true, hint: 'new lyrics go in when playback stops' });
  });
  it('says Sing again when the song has sung takes', () => {
    expect(vocalMenu({ ...base, hasSungTakes: true }).sing).toMatchObject({ label: 'Sing again', disabled: false });
  });
  it('keeps the earlier Write melody and Write lyrics rules without a sing', () => {
    expect(vocalMenu({ ...base, melodyShown: false }).writeMelody).toMatchObject({ disabled: false });
    // A melody shown: Write melody writes another (owner, 2026-11-27: always there; the words go).
    expect(vocalMenu({ ...base, lyricsWritten: false }).writeMelody).toEqual({ disabled: false, hint: 'a new one' });
    expect(vocalMenu({ ...base, lyricsWritten: true }).writeMelody).toEqual({ disabled: false, hint: 'a new one · the words go' });
    expect(vocalMenu({ ...base, lyricsTask: singTask({ kind: 'writeLyrics' }) }).writeMelody).toMatchObject({ disabled: true, hint: 'Already writing lyrics' });
    expect(vocalMenu({ ...base, melodyShown: false }).writeLyrics).toMatchObject({ disabled: true, hint: 'write a melody first' });
  });
  it('knows whether lyrics are written', () => {
    const song = makeFixtureSong().song;
    expect(lyricsWritten(song)).toBe(false);
    const withLyrics = { ...song, generator: { ...song.generator, params: { params: { lyrics: { verse1: ['la la'] } } } } } as unknown as Song;
    expect(lyricsWritten(withLyrics)).toBe(true);
  });
});

const steps: TaskStep[] = [
  { id: 'a', label: 'Planning who sings what', state: 'done', startedAt: '2026-11-25T10:00:00.000Z', finishedAt: '2026-11-25T10:00:03.000Z', text: '3 sections' },
  {
    id: 'b',
    label: 'Singing the chorus',
    state: 'running',
    startedAt: '2026-11-25T10:00:03.000Z',
    numbers: { seed: 2 },
    files: ['lead/chorus1_s1.wav', 'lead/chorus1.abc'],
  },
  { id: 'c', label: 'Levelling', state: 'waiting' },
];

describe('Sing and Transcribe start from the saved song', () => {
  const song = makeFixtureSong().song;
  const saved = { id: 'saved1', song: { ...song, bpm: 99 } as Song };
  it('unsaved edits are saved first, and the task starts on the saved version', async () => {
    const calls: string[] = [];
    const out = await startOnSaved({
      dirty: true,
      songId: 'old1',
      song,
      save: async () => {
        calls.push('save');
        return saved;
      },
      start: async (id, s) => {
        calls.push(`start ${id} ${s.bpm}`);
        return 'task';
      },
    });
    expect(out).toBe('task');
    expect(calls).toEqual(['save', 'start saved1 99']);
  });
  it('without unsaved edits nothing is saved', async () => {
    const calls: string[] = [];
    await startOnSaved({
      dirty: false,
      songId: 'old1',
      song,
      save: async () => {
        calls.push('save');
        return saved;
      },
      start: async (id, s) => {
        calls.push(`start ${id} ${s.bpm}`);
      },
    });
    expect(calls).toEqual([`start old1 ${song.bpm}`]);
  });
});

describe('a sing task in the Tasks list', () => {
  const html = renderToStaticMarkup(createElement(TaskSteps, { task: singTask({ steps }), now: Date.parse('2026-11-25T10:00:10.000Z'), onCancel: () => undefined }));
  it('lists the steps in order with label, state, running time and text', () => {
    const at = (s: string) => html.indexOf(s);
    expect(at('Planning who sings what')).toBeGreaterThan(-1);
    expect(at('Planning who sings what')).toBeLessThan(at('Singing the chorus'));
    expect(at('Singing the chorus')).toBeLessThan(at('Levelling'));
    expect(html).toContain('3 s'); // done step: finished - started
    expect(html).toContain('7 s'); // running step: now - started
    expect(html).toContain('3 sections');
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain('data-state="waiting"');
  });
  it('highlights the running step', () => {
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*data-state="running"|<li[^>]*data-state="running"[^>]*aria-current="step"/);
  });
  it('has a play button per audio file and a Cancel button while running', () => {
    expect(html).toContain('aria-label="Play chorus1_s1.wav"');
    expect(html).toContain('href="/api/tasks/s1/files/lead/chorus1.abc"');
    expect(html).toContain('Cancel');
    const done = renderToStaticMarkup(createElement(TaskSteps, { task: singTask({ steps, state: 'done' }), now: 0 }));
    expect(done).not.toContain('Cancel');
  });
  it('builds the file url and cancels through the brain', () => {
    expect(tasksApi.fileUrl('s1', 'lead/chorus1_s1.wav')).toBe('/api/tasks/s1/files/lead/chorus1_s1.wav');
    expect(typeof tasksApi.cancel).toBe('function');
  });
});

function withAdlibs(): Song {
  const song = makeFixtureSong().song;
  const art = (instrument: string, segment: string, kind: string, id: string) => ({
    id,
    kind,
    modelId: 'm',
    modelVersion: '1',
    output: { uri: `x/${id}.ogg`, sha256: 'a'.repeat(64) },
    attachedTo: { scope: 'segment', segment, instrument },
    conditioning: { hashes: [vocalTakeFingerprint(song, segment, instrument)] },
  });
  return {
    ...song,
    instrumentDefinitions: [{ name: 'Vocal' }],
    aiArtifacts: [art('Vocal', 'verse1', 'soulx-vocal', 'v1'), art('Ad-libs', 'verse1', 'yue2-vocal', 'ad1')],
  } as unknown as Song;
}

describe('audio-only tracks', () => {
  it('are artifact instruments without an instrument definition', () => {
    expect(audioOnlyTracks(withAdlibs())).toEqual(['Ad-libs']);
    expect(audioOnlyTracks(makeFixtureSong().song)).toEqual([]);
  });
  it('are drawn as rows with a clip per sung section and no notes', () => {
    const model = buildSequencerModel(withAdlibs());
    const row = model.tracks.find((t) => t.name === 'Ad-libs');
    expect(row).toBeDefined();
    expect(row!.audioOnly).toBe(true);
    expect(row!.clips).toEqual([expect.objectContaining({ section: 1, notes: [] })]);
  });
  it('have no notes to open: no piano roll, overview, sound or pattern for them', () => {
    const model = buildSequencerModel(withAdlibs());
    expect(hasNotes(model.tracks.find((t) => t.name === 'Ad-libs')!)).toBe(false);
    expect(hasNotes(model.tracks.find((t) => t.name === 'Vocal')!)).toBe(true);
  });
});

describe('a vocal track\'s two engine lanes (dry YuE2, wet SoulX) are one track', () => {
  it('one mixer strip per track, its own lane then its wet lane; other lanes alone', () => {
    expect(mixerStrips(['Drums', 'Vocal', 'Backing vocals 1', 'Ad-libs'], ['Drums', 'Vocal', 'Vocal wet', 'Backing vocals 1 wet', 'Ad-libs', 'Transitions'])).toEqual([
      { name: 'Drums', lanes: ['Drums'] },
      { name: 'Vocal', lanes: ['Vocal', 'Vocal wet'] },
      { name: 'Backing vocals 1', lanes: ['Backing vocals 1 wet'] },
      { name: 'Ad-libs', lanes: ['Ad-libs'] },
      { name: 'Transitions', lanes: ['Transitions'] },
    ]);
  });
  it('muting or soloing the track silences or keeps both lanes', () => {
    const lanes = ['Drums', 'Vocal', 'Vocal wet'];
    expect(laneGains(lanes, ['Vocal'], [])).toEqual({ Drums: 1, Vocal: 0, 'Vocal wet': 0 });
    expect(laneGains(lanes, [], ['Vocal'])).toEqual({ Drums: 0, Vocal: 1, 'Vocal wet': 1 });
    expect(laneGains(lanes, [], [])).toEqual({ Drums: 1, Vocal: 1, 'Vocal wet': 1 });
  });
});

describe('the browser export\'s MP3 credit', () => {
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  it('an ID3v2.3 comment frame with the credit, before the audio', () => {
    const tagged = withCommentTag(mp3, CREDIT);
    expect(String.fromCharCode(...tagged.subarray(0, 3))).toBe('ID3');
    expect([tagged[3], tagged[4], tagged[5]]).toEqual([3, 0, 0]);
    const size = (tagged[6]! << 21) | (tagged[7]! << 14) | (tagged[8]! << 7) | tagged[9]!;
    expect(tagged.length).toBe(10 + size + mp3.length);
    expect(String.fromCharCode(...tagged.subarray(10, 14))).toBe('COMM');
    const frameSize = new DataView(tagged.buffer, tagged.byteOffset + 14, 4).getUint32(0);
    const body = tagged.subarray(20, 20 + frameSize);
    expect(body[0]).toBe(0); // ISO-8859-1
    expect(String.fromCharCode(...body.subarray(1, 4))).toBe('eng');
    expect(body[4]).toBe(0); // empty description
    expect(String.fromCharCode(...body.subarray(5))).toBe(CREDIT);
    expect([...tagged.subarray(tagged.length - mp3.length)]).toEqual([...mp3]);
  });
  it('only when the song has a YuE2 take', () => {
    expect(creditedMp3(withAdlibs(), mp3)).not.toBe(mp3);
    expect(String.fromCharCode(...creditedMp3(withAdlibs(), mp3).subarray(0, 3))).toBe('ID3');
    expect(creditedMp3(makeFixtureSong().song, mp3)).toBe(mp3);
  });
  it('refuses an MP3 that has a tag already', () => {
    expect(() => withCommentTag(withCommentTag(mp3, CREDIT), CREDIT)).toThrow(/already/);
  });
});

describe('stale takes', () => {
  it('marks a section whose take is not fresh', async () => {
    const song = withAdlibs();
    expect([...(await staleTakes(song))]).toEqual([]);
    const changed = { ...song, bpm: 99 } as unknown as Song;
    expect([...(await staleTakes(changed))].sort()).toEqual(['Ad-libs\u0000verse1', 'Vocal\u0000verse1']);
    const model = buildSequencerModel(changed, await staleTakes(changed));
    const clip = model.tracks.find((t) => t.name === 'Ad-libs')!.clips[0]!;
    expect(clip.stale).toBe(true);
  });
});

describe('the credit', () => {
  it('is on the home page with the exact text', () => {
    expect(VOCALS_CREDIT).toBe(CREDIT);
    const html = renderToStaticMarkup(createElement(VocalsCredit));
    expect(html.replace(/<[^>]+>/g, '')).toBe(CREDIT);
    expect(html).toContain('href="https://huggingface.co/m-a-p/YuE2-3B"');
    expect(html).toContain('), CC BY-NC 4.0');
  });
});

describe('track edits', () => {
  it('send the project id with the edit, so the brain can refuse while singing', async () => {
    const { vi } = await import('vitest');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ song: {}, track: 'Vocal' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { tracksApi } = await import('../src/api/tracks');
    await tracksApi.edit(makeFixtureSong().song, { kind: 'writeMelody' }, undefined, 'proj1');
    await tracksApi.edit(makeFixtureSong().song, { kind: 'writeMelody' });
    vi.unstubAllGlobals();
    const body = (n: number) => JSON.parse((fetchMock.mock.calls[n] as unknown as [string, RequestInit])[1].body as string);
    expect(body(0)).toMatchObject({ songId: 'proj1', op: { kind: 'writeMelody' } });
    expect(body(1)).not.toHaveProperty('songId');
  });
});
