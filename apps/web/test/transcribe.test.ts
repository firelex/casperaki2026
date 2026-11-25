// Transcribe melody in the web app: the Vocal track's menu item, the dialog (a section and a file per transcription),
// the upload body, and how a finished result goes into unsaved edits (only its section; other takes kept).

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { TASK_LABELS, type BackgroundTask } from '../src/api/tasks';
import { bytesToBase64, transcribeSections, vocalMenu, type VocalMenuInput } from '../src/editor/singing';
import { TranscribeForm } from '../src/editor/sequencer/TranscribeDialog';
import { mergeOp } from '../src/state/tasks';
import { makeFixtureSong } from './fixture';

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't1', kind: 'transcribe', songId: 'abc', title: 'Test', state: 'running', startedAt: '2026-11-25T10:00:00.000Z', ...over,
});
const base: VocalMenuInput = { melodyShown: true, lyricsWritten: false, hasSungTakes: false, singTask: undefined, lyricsTask: undefined, transcribeTask: undefined, sungSections: 2 };

describe('Transcribe melody on the Vocal track menu', () => {
  it('is offered once the melody is shown, with or without lyrics', () => {
    expect(vocalMenu(base).transcribe).toEqual({ disabled: false, hint: 'from a recording' });
    expect(vocalMenu({ ...base, lyricsWritten: true }).transcribe).toEqual({ disabled: false, hint: 'from a recording' });
    expect(vocalMenu({ ...base, melodyShown: false }).transcribe).toEqual({ disabled: true, hint: 'write a melody first' });
  });
  it('waits while singing, while one runs, and while one waits to go in', () => {
    expect(vocalMenu({ ...base, singTask: task({ kind: 'sing' }) }).transcribe).toEqual({ disabled: true, hint: 'Already singing' });
    expect(vocalMenu({ ...base, transcribeTask: task({}) }).transcribe).toEqual({ disabled: true, hint: 'Already transcribing' });
    expect(vocalMenu({ ...base, transcribeTask: task({ state: 'ready' }) }).transcribe).toEqual({ disabled: true, hint: 'ready · goes in when you stop' });
  });
  it('Sing waits while a transcription runs, with the same reason', () => {
    expect(vocalMenu({ ...base, lyricsWritten: true, transcribeTask: task({}) }).sing).toEqual({ label: 'Sing', disabled: true, hint: 'Already transcribing' });
    expect(vocalMenu({ ...base, lyricsWritten: true, transcribeTask: task({ state: 'ready' }) }).sing).toMatchObject({ disabled: false });
  });
  it('is off when no section has notes in the Vocal lane (nothing to transcribe into)', () => {
    expect(vocalMenu({ ...base, sungSections: 0 }).transcribe).toEqual({ disabled: true, hint: 'no sung sections' });
  });
  it('names the task', () => {
    expect(TASK_LABELS.transcribe).toBe('Transcribe melody');
  });
});

describe('the Transcribe melody dialog', () => {
  it('offers the sections that have Vocal notes, in song order', () => {
    const song = makeFixtureSong().song;
    const sung = transcribeSections(song);
    const withNotes = song.songStructure
      .map((s) => s.name)
      .filter((n) => (song.arrangement[n]?.overrides?.['Vocal']?.bars ?? []).some((b) => Object.values(b.notes ?? {}).some((evs) => (evs ?? []).some((e) => (e as { type?: string }).type === 'vocalNote'))));
    expect(sung).toEqual(withNotes);
  });
  it('asks for a section, a file and whether music plays behind the voice', () => {
    const html = renderToStaticMarkup(
      createElement(TranscribeForm, { sections: ['verse1', 'chorus1'], section: 'chorus1', onSection: () => {}, file: undefined, onFile: () => {}, hasBacking: false, onBacking: () => {} }),
    );
    expect(html).toContain('<option value="verse1">verse1</option>');
    expect(html).toMatch(/<option value="chorus1" selected="">chorus1<\/option>/u);
    expect(html).toMatch(/type="file"[^>]*accept="audio\/\*"/u);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Music plays behind the voice');
    expect(html).toContain('from the section&#x27;s first beat');
  });
  it('sends the recording as base64', () => {
    expect(bytesToBase64(new Uint8Array([82, 73, 70, 70, 0, 255]))).toBe(Buffer.from([82, 73, 70, 70, 0, 255]).toString('base64'));
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('a finished transcription merged into unsaved edits', () => {
  it('is the applySung edit for its section only (partial), so the other sections keep their takes', () => {
    const saved = { title: 'saved' } as unknown as Song;
    expect(mergeOp('transcribe', { melody: {}, takes: [] }, saved)).toEqual({ kind: 'applySung', result: { melody: {}, takes: [] }, sungOver: saved, partial: true });
    expect(mergeOp('sing', { melody: {}, takes: [] }, saved)).toEqual({ kind: 'applySung', result: { melody: {}, takes: [] }, sungOver: saved });
    expect(mergeOp('writeLyrics', { verse1: ['la'] }, saved)).toEqual({ kind: 'applyLyrics', lyrics: { verse1: ['la'] } });
    expect(mergeOp('aceLayer', { track: 'ACE Guitar' }, saved)).toEqual({ kind: 'applyAceLayer', result: { track: 'ACE Guitar' } });
  });
});
