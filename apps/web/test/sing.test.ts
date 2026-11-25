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
import { lyricsWritten, staleTakes, vocalMenu, type VocalMenuInput } from '../src/editor/singing';
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

const base: VocalMenuInput = { melodyShown: true, lyricsWritten: true, hasSungTakes: false, singTask: undefined, lyricsTask: undefined };

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
  it('says Sing again when the song has sung takes', () => {
    expect(vocalMenu({ ...base, hasSungTakes: true }).sing).toMatchObject({ label: 'Sing again', disabled: false });
  });
  it('keeps the earlier Write melody and Write lyrics rules without a sing', () => {
    expect(vocalMenu({ ...base, melodyShown: false }).writeMelody).toMatchObject({ disabled: false });
    expect(vocalMenu(base).writeMelody).toMatchObject({ disabled: true, hint: 'written' });
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
