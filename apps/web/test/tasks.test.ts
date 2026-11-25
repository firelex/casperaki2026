// Background tasks in the web app (src/state/tasks.tsx): results go in only while nothing plays, the editor switches to
// the saved version (unsaved edits keep, with the words put in), and an empty lead vocal track keeps its row.

import { describe, expect, it, vi } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import type { BackgroundTask } from '../src/api/tasks';
import type { GeneratedSong } from '../src/api/songs';
import { buildSequencerModel } from '../src/editor/sequencerModel';
import { applyReadyTask, shouldApply, type ApplyContext } from '../src/state/tasks';
import { makeFixtureSong } from './fixture';

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 't1',
  kind: 'writeLyrics',
  songId: 'old',
  title: 'Glass Daydream',
  state: 'ready',
  startedAt: '2026-11-25T10:00:00.000Z',
  ...over,
});

describe('applying finished tasks', () => {
  it('waits while anything plays or loads', () => {
    expect(shouldApply(task(), 'playing')).toBe(false);
    expect(shouldApply(task(), 'loading')).toBe(false);
    for (const s of ['idle', 'paused', 'ended', 'error'] as const) expect(shouldApply(task(), s)).toBe(true);
    expect(shouldApply(task({ state: 'running' }), 'idle')).toBe(false);
    expect(shouldApply(task({ state: 'done' }), 'idle')).toBe(false);
  });

  function context(over: Partial<ApplyContext>): ApplyContext & { calls: string[] } {
    const calls: string[] = [];
    const fixture = makeFixtureSong();
    const saved: GeneratedSong = { ...fixture, id: 'new' };
    return {
      calls,
      activeSong: { ...fixture, id: 'old' },
      editorDirty: false,
      viewSong: fixture.song,
      pathname: '/editor/old/timeline',
      apply: async () => ({ task: task({ state: 'done', songId: 'new' }), songId: 'new', result: { verse1: ['la la day'] } }),
      getSong: async (id) => (calls.push(`get ${id}`), saved),
      mergeLyrics: async (song, lyrics) => (calls.push(`merge ${Object.keys(lyrics).join(',')}`), { ...song, bpm: 99 } as Song),
      setActiveSong: (s) => calls.push(`active ${s.id}`),
      applyEdit: (c) => calls.push(`edit ${c.kind} ${c.song.bpm}`),
      cacheSong: (s, old) => calls.push(`cache ${s.id} ${old}`),
      navigate: (p) => calls.push(`go ${p}`),
      refresh: () => calls.push('refresh'),
      ...over,
    };
  }

  it('switches the open editor to the saved version', async () => {
    const c = context({});
    await applyReadyTask(task(), c);
    expect(c.calls).toEqual(['get new', 'active new', 'cache new old', 'go /editor/new/timeline', 'refresh']);
  });

  it('keeps unsaved edits, with the words put into them', async () => {
    const c = context({ editorDirty: true });
    await applyReadyTask(task(), c);
    expect(c.calls).toEqual(['get new', 'merge verse1', 'active new', 'edit replaceSong 99', 'cache new old', 'go /editor/new/timeline', 'refresh']);
  });

  it('only refreshes the lists when the song is not open', async () => {
    const c = context({ activeSong: undefined, pathname: '/' });
    await applyReadyTask(task(), c);
    expect(c.calls).toEqual(['refresh']);
  });

  it('lets a failure surface', async () => {
    const c = context({ apply: vi.fn(async () => Promise.reject(new Error('The song was deleted.'))) });
    await expect(applyReadyTask(task(), c)).rejects.toThrow('The song was deleted.');
    expect(c.calls).toEqual([]);
  });
});

describe('an empty lead vocal track', () => {
  it('keeps its row (with no clips) so its menu can write the melody', () => {
    const { song } = makeFixtureSong();
    // The fixture has no vocal track: add one, as the generator defines it.
    const vocalDef = { ...song.instrumentDefinitions[0]!, name: 'Vocal', instrumentGroup: 'Vocal' };
    const empty = {
      ...song,
      instrumentDefinitions: [...song.instrumentDefinitions, vocalDef],
      arrangement: Object.fromEntries(
        Object.entries(song.arrangement).map(([n, a]) => {
          const { Vocal: _v, ...overrides } = a.overrides;
          return [n, { ...a, instruments: { ...a.instruments, Vocal: false }, overrides }];
        }),
      ),
    } as Song;
    expect(empty.instrumentDefinitions.some((d) => d.name === 'Vocal')).toBe(true);
    const vocal = buildSequencerModel(empty).tracks.find((t) => t.name === 'Vocal');
    expect(vocal).toBeDefined();
    expect(vocal!.clips).toEqual([]);
  });
});
