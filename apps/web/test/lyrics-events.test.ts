// A new song's lyrics arrive on /api/events once the brain has written and saved them (apps/brain/src/lyrics/tasks.ts).
// The open editor switches to the saved version, keeping unsaved edits with the words put into them.

import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import type { GeneratedSong, ProjectLyrics } from '../src/api/songs';
import { handleLyricsEvent, type LyricsEventContext } from '../src/state/useLyricsEvents';
import { makeFixtureSong } from './fixture';

const LYRICS = { verse1: ['la la day', 'la la way'] };

function context(dirty: boolean) {
  const open = makeFixtureSong();
  const saved: GeneratedSong = { ...makeFixtureSong(), id: 'newid00000000000', project: { ...open.project, id: 'newid00000000000' } };
  const working = { ...open.song, title: 'edited' } as Song;
  const log: string[] = [];
  let active: GeneratedSong | undefined = open;
  let lyrics: ProjectLyrics | null | undefined;
  let edited: Song | undefined;
  const c: LyricsEventContext = {
    activeSong: open,
    editorDirty: dirty,
    viewSong: dirty ? working : open.song,
    pathname: `/editor/${open.id}/timeline`,
    setActiveSong: (s) => { active = s; log.push(`active ${s.id}`); },
    setActiveLyrics: (l) => { lyrics = l; },
    applyEdit: (cmd) => { edited = cmd.song; log.push('edit'); },
    navigate: (p) => log.push(`go ${p}`),
    getSong: async (id) => { expect(id).toBe(saved.id); return saved; },
    applyLyrics: async (song, l) => { expect(l).toEqual(LYRICS); return { ...song, title: 'edited + words' } as Song; },
    refreshList: () => log.push('list'),
    cacheSong: () => undefined,
  };
  return { c, open, saved, log, get active() { return active; }, get lyrics() { return lyrics; }, get edited() { return edited; } };
}

describe('lyrics events', () => {
  it('switches a clean editor to the saved version with the words', async () => {
    const t = context(false);
    await handleLyricsEvent({ type: 'lyrics', state: 'done', songId: t.open.id, newSongId: t.saved.id, lyrics: LYRICS }, t.c);
    expect(t.active).toBe(t.saved);
    expect(t.edited).toBeUndefined();
    expect(t.log).toEqual(['list', `active ${t.saved.id}`, `go /editor/${t.saved.id}/timeline`]);
  });

  it('keeps unsaved edits, with the words put into them, on top of the saved version', async () => {
    const t = context(true);
    await handleLyricsEvent({ type: 'lyrics', state: 'done', songId: t.open.id, newSongId: t.saved.id, lyrics: LYRICS }, t.c);
    expect(t.active).toBe(t.saved);
    expect((t.edited as { title?: string }).title).toBe('edited + words');
    expect(t.log).toEqual(['list', `active ${t.saved.id}`, 'edit', `go /editor/${t.saved.id}/timeline`]);
  });

  it('shows why writing failed', async () => {
    const t = context(false);
    await handleLyricsEvent({ type: 'lyrics', state: 'failed', songId: t.open.id, message: 'the model is down' }, t.c);
    expect(t.lyrics).toEqual({ state: 'failed', message: 'the model is down' });
    expect(t.active).toBe(t.open);
  });

  it('only refreshes the list for another song', async () => {
    const t = context(false);
    await handleLyricsEvent({ type: 'lyrics', state: 'done', songId: 'other', newSongId: 'x', lyrics: LYRICS }, t.c);
    expect(t.log).toEqual(['list']);
  });
});
