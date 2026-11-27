// Add a singer in the web app: the form's checks, the upload request, the Singers page's cards (own singers with
// their voice reference choice, test line and Delete; built-in ones without test line), and Add a singer tasks in the Tasks list.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { addSingerProblem, extensionOf, referenceText, singersApi, type AddSingerForm, type SingerInfo } from '../src/api/singers';
import { TASK_LABELS, type BackgroundTask } from '../src/api/tasks';
import { taskPage } from '../src/layout/TasksMenu';
import { AddSingerPanel, SingerCard } from '../src/pages/SingersPage';
import { mergeOp } from '../src/state/tasks';

const file = (name: string, type = 'audio/wav') => new File([new Uint8Array([1, 2, 3])], name, { type });
const form = (over: Partial<AddSingerForm> = {}): AddSingerForm => ({
  file: file('take.WAV'),
  name: 'My voice',
  description: 'Warm and low.',
  rightToUse: true,
  fullSong: false,
  reference: 'best',
  ...over,
});

const html = (node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));

describe('the Add a singer form', () => {
  it('says what is missing, the consent box last', () => {
    expect(addSingerProblem(form())).toBeUndefined();
    expect(addSingerProblem(form({ file: undefined }))).toBe('Choose a recording.');
    expect(addSingerProblem(form({ file: file('recording') }))).toMatch(/ends in its type/u);
    expect(addSingerProblem(form({ name: '  ' }))).toBe('Give the singer a name.');
    expect(addSingerProblem(form({ description: '' }))).toBe('Describe the voice.');
    expect(addSingerProblem(form({ reference: undefined }))).toBe('Choose how the voice reference is picked.');
    expect(addSingerProblem(form({ rightToUse: false }))).toBe('Tick "I have the right to use this voice".');
    expect(extensionOf('take.WAV')).toBe('wav');
  });

  it('preselects "The best stretch" and offers "The beginning", and has both boxes', () => {
    const out = html(createElement(AddSingerPanel));
    const radios = [...out.matchAll(/<input type="radio"[^>]*\/><span>([^<]*)/gu)].map((m) => [m[1]!.trim(), m[0].includes('checked=""')]);
    expect(radios).toEqual([['The best stretch', true], ['The beginning', false]]);
    expect(out).toMatch(/This is a full song: separate the vocals first/u);
    expect(out).toMatch(/I have the right to use this voice/u);
    expect(out).toMatch(/up to 5 minutes/u);
  });

  it('sends the recording as the body and the choices in the query; a refusal comes back as its message', async () => {
    const task = { id: 't1', kind: 'addSinger', songId: null, title: 'My voice', state: 'running', startedAt: 'x' };
    const fetchOk = vi.fn(async () => new Response(JSON.stringify({ task }), { status: 201 }));
    const f = form({ fullSong: true, reference: 'beginning' });
    expect(await singersApi.add(f, fetchOk as unknown as typeof fetch)).toEqual({ task });
    const [url, init] = fetchOk.mock.calls[0] as unknown as [string, RequestInit];
    const q = new URL(url, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({ name: 'My voice', description: 'Warm and low.', rightToUse: '1', fullSong: '1', reference: 'beginning', extension: 'wav' });
    expect(init.method).toBe('POST');
    expect(init.body).toBe(f.file);

    const long = vi.fn(async () => new Response(JSON.stringify({ error: 'recording_too_long', message: "The recording is 6 min long: a singer's recording can be at most 5 min." }), { status: 400 }));
    await expect(singersApi.add(form(), long as unknown as typeof fetch)).rejects.toThrow("The recording is 6 min long: a singer's recording can be at most 5 min.");
    await expect(singersApi.add(form({ rightToUse: false }), fetchOk as unknown as typeof fetch)).rejects.toThrow(/right to use/u);
    expect(fetchOk).toHaveBeenCalledTimes(1);
  });
});

const own: SingerInfo = {
  id: 'u-0123456789ab',
  name: 'My voice',
  description: 'Warm and low.',
  source: 'Made from an uploaded recording.',
  previewUrl: '/api/singers/u-0123456789ab/preview',
  own: true,
  testLineUrl: '/api/singers/u-0123456789ab/test-line',
  reference: { choice: 'best', startSeconds: 2.94, endSeconds: 11.94, recordingStartSeconds: 5.22, recordingEndSeconds: 14.22, seconds: 9.12 },
  transcription: 'la',
};

describe('the Singers page', () => {
  it("shows an own singer's voice reference with how it was chosen, its test line and Delete", () => {
    const out = html(createElement(SingerCard, { singer: own }));
    expect(out).toMatch(/The best stretch: 9.1 s, from 5.2 s to 14.2 s of the recording/u);
    expect(out).toMatch(/sung as &quot;la la la&quot;/u);
    expect(out).toMatch(/src="\/api\/singers\/u-0123456789ab\/test-line"/u);
    expect(out).toMatch(/>Delete</u);
    expect(out).toMatch(/yours/u);
    expect(referenceText({ ...own.reference!, choice: 'beginning' })).toMatch(/^The beginning:/u);
  });

  it('shows a built-in singer without test line, with Delete (for this user only)', () => {
    const out = html(createElement(SingerCard, { singer: { id: 'yue2_female_dry2', name: 'Singer 1', description: 'd', source: 's', previewUrl: '/p', own: false } }));
    expect(out).not.toMatch(/Test line|yours/u);
    expect(out).toMatch(/>Delete</u);
  });
});

describe('Add a singer tasks', () => {
  const t: BackgroundTask = { id: 't', kind: 'addSinger', songId: null, title: 'My voice', state: 'running', startedAt: 'x' };
  it('open the Singers page from the Tasks list, and have no result to put into a song', () => {
    expect(TASK_LABELS.addSinger).toBe('Add a singer');
    expect(taskPage(t)).toBe('/singers');
    expect(taskPage({ ...t, kind: 'sing', songId: 'abc' })).toBe('/editor/abc/timeline');
    expect(() => mergeOp('addSinger', {}, {} as never)).toThrow(/no result/u);
  });
});
