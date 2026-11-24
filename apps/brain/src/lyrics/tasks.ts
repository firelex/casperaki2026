// Lyrics written in the background. A new song comes back at once with its melody; its words are written by the
// lyricist afterwards (a minute or two). While they are, the project's lyrics state is "writing" (kept in the
// database, so a brain restart resumes the task); when they are done, they are spliced into the project's song as it
// is then (the user may have saved edits meanwhile: the task follows the project wherever saves moved it), saved as a
// new version, and announced to the owner's open pages. If writing fails, the state says why and the owner can start
// it again.

import { randomUUID } from 'node:crypto';

import { applyWrittenLyrics, generatorParams, orchestrate, sungSections, writtenLyricsOf } from '@casperaki/arrangement';
import { canonicalStringifySong } from '@casperaki/song-schema';

import type { EventHub } from '../events.js';
import type { SongsStore } from '../store.js';
import { writeLyrics, type LyricModel } from './lyricist.js';

export interface LyricsTasksDeps {
  readonly store: SongsStore;
  readonly lyricModel: LyricModel;
  readonly events: EventHub;
  readonly hash: (canonical: string) => string;
  readonly clock: () => string;
  /** A saved song was replaced by a new version (see routes/vocals.ts). */
  readonly onSongReplaced?: (oldSongId: string, how: 'saved' | 'deleted') => void;
}

export class LyricsTasks {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: LyricsTasksDeps) {}

  /** Starts writing the words of a project's song (its sung sections that have none yet). */
  start(ownerId: string, songId: string): void {
    const task = randomUUID();
    if (!this.deps.store.setProjectLyrics({ ownerId, songId, lyrics: { state: 'writing', task } })) {
      throw new Error(`LyricsTasks.start: no project ${songId} for this owner`);
    }
    this.launch(ownerId, task);
  }

  /** Resumes every task the database says is still writing (at start-up: a restart ended them). */
  resumeAll(): void {
    for (const p of this.deps.store.listWritingLyrics()) {
      if (p.lyrics?.state !== 'writing') throw new Error(`LyricsTasks.resumeAll: project ${p.songId} is not writing`);
      if (!this.running.has(p.lyrics.task)) this.launch(p.ownerId, p.lyrics.task);
    }
  }

  /** Resolves when every running task has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private launch(ownerId: string, task: string): void {
    const run = this.run(ownerId, task).finally(() => this.running.delete(task));
    this.running.set(task, run);
  }

  private async run(ownerId: string, task: string): Promise<void> {
    const { store, lyricModel, events } = this.deps;
    const at = store.projectOfLyricsTask(ownerId, task);
    if (!at) return; // deleted meanwhile
    try {
      const stored = store.get(at.songId);
      if (!stored) throw new Error(`song ${at.songId} is not stored`);
      const generated = orchestrate(generatorParams(stored.song));
      const recorded = writtenLyricsOf(generatorParams(stored.song).params);
      const sections = sungSections(generated)
        .map((s) => s.name)
        .filter((name) => !recorded[name]);
      const lyrics = sections.length > 0 ? await writeLyrics(generated, lyricModel, { sections, title: at.title }) : {};

      // The project as it is now (saves may have moved it, or it was deleted).
      const now = store.projectOfLyricsTask(ownerId, task);
      if (!now) return;
      const current = store.get(now.songId);
      if (!current) throw new Error(`song ${now.songId} is not stored`);
      const song = applyWrittenLyrics(current.song, lyrics);
      const canonical = canonicalStringifySong(song, 2);
      const hash = this.deps.hash(canonical);
      const id = hash.slice(0, 16);
      const savedAt = this.deps.clock();
      store.put({ id, song, canonical, hash, createdAt: savedAt });
      store.moveProject({ ownerId, fromSongId: now.songId, toSongId: id, updatedAt: savedAt });
      store.setProjectLyrics({ ownerId, songId: id, lyrics: null });
      if (id !== now.songId) this.deps.onSongReplaced?.(now.songId, 'saved');
      events.publish(ownerId, { type: 'lyrics', state: 'done', songId: now.songId, newSongId: id, lyrics });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lyrics] task ${task} failed: ${message}`);
      const now = store.projectOfLyricsTask(ownerId, task);
      if (!now) return;
      store.setProjectLyrics({ ownerId, songId: now.songId, lyrics: { state: 'failed', task, message } });
      events.publish(ownerId, { type: 'lyrics', state: 'failed', songId: now.songId, message });
    }
  }
}
