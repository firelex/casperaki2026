// Vertical-slice songs store backed by better-sqlite3.
//
// Persists canonical Song bytes (the same `canonicalStringifySong(_, 2)`
// form the brain replay endpoint will hash for integrity checks). One
// table, one CREATE-IF-NOT-EXISTS migration. CLEARLY TEMPORARY: this
// gets swapped for @teamsuzie/db-sqlite once that package lands. The
// schema columns are deliberately close to what we'd want there so the
// swap is mechanical.

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';

import { MixOverridesSchema, parseSong, type MixOverrides, type Song } from '@casperaki/song-schema';

export interface StoredSong {
  readonly id: string;
  readonly song: Song;
  readonly canonical: string;
  readonly hash: string;
  readonly createdAt: string;
}

/** One row of a user's project list: a song the user owns, with the
 *  display metadata the projects page shows. Songs themselves are
 *  content-addressed and shared; ownership lives here. */
export interface ProjectRow {
  readonly ownerId: string;
  readonly songId: string;
  readonly title: string;
  readonly genre: string | null;
  readonly key: string;
  readonly bpm: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The song's sections in order (name, brain type tag, length in bars),
   *  for an outline of the song without loading it whole. */
  readonly sections: readonly ProjectSection[];
  /** The owner's Pro-mode mix changes for this song (null = the standard mix). */
  readonly mixOverrides: MixOverrides | null;
  readonly mixUpdatedAt: string | null;
  /** The song's lyrics while they are being written in the background, or why writing them failed (null = written). */
  readonly lyrics: ProjectLyrics | null;
}

/** Lyrics being written for a project in the background (see lyrics/tasks.ts). */
export type ProjectLyrics =
  | { readonly state: 'writing'; readonly task: string }
  | { readonly state: 'failed'; readonly task: string; readonly message: string };

/** A project's Pro-mode mix, with what the suggestions page needs about its song. */
export interface ProjectMixRow {
  readonly ownerId: string;
  readonly songId: string;
  readonly title: string;
  readonly genre: string | null;
  readonly canonical: string;
  readonly mixOverrides: MixOverrides;
  readonly mixUpdatedAt: string;
}

export interface ProjectSection {
  readonly name: string;
  readonly type: string | null;
  readonly bars: number;
}

export interface PatternReview {
  readonly proposalId: string;
  readonly status: 'approved' | 'rejected';
  readonly note: string;
  readonly reviewer: string;
  readonly decidedAt: string;
}

/** A comment on a suggestion (Suggestions page): a pattern proposal or a mix change. */
export interface SuggestionComment {
  readonly id: number;
  /** 'pattern': target = proposal id; 'mix': target = "<genre>|<change key>". */
  readonly kind: 'pattern' | 'mix';
  readonly target: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface MixDismissal {
  readonly genre: string;
  readonly key: string;
  readonly dismissedAt: string;
}

export interface SongsStore {
  put(input: { id: string; song: Song; canonical: string; hash: string; createdAt: string }): void;
  get(id: string): StoredSong | undefined;
  /** Create or update the owner's project row for a song. */
  upsertProject(input: { ownerId: string; songId: string; title: string; createdAt: string; updatedAt: string }): void;
  getProject(ownerId: string, songId: string): ProjectRow | undefined;
  listProjects(ownerId: string): ProjectRow[];
  /** The song ids every project (of every owner) points at: the saved songs. */
  listProjectSongIds(): string[];
  /** Replace the song a project points at (an edit saved under a new
   *  content id), keeping its title and created date. Returns false if
   *  the owner has no project for `fromSongId`. */
  moveProject(input: { ownerId: string; fromSongId: string; toSongId: string; updatedAt: string }): boolean;
  renameProject(input: { ownerId: string; songId: string; title: string; updatedAt: string }): boolean;
  deleteProject(ownerId: string, songId: string): boolean;
  /** Sets (or clears, with null) the project's background lyrics state. False when there is no such project. */
  setProjectLyrics(input: { ownerId: string; songId: string; lyrics: ProjectLyrics | null }): boolean;
  /** The project a lyrics task writes for, wherever saves have moved it since. */
  projectOfLyricsTask(ownerId: string, task: string): ProjectRow | undefined;
  /** Every project whose lyrics are still being written (resumed when the brain starts). */
  listWritingLyrics(): ProjectRow[];
  /** Save (or with null clear) a project's Pro-mode mix. Returns false if the owner has no such project. */
  setProjectMix(input: { ownerId: string; songId: string; mixOverrides: MixOverrides | null; updatedAt: string }): boolean;
  /** Every project with a Pro-mode mix, newest first (the suggestions page). */
  listProjectMixes(): ProjectMixRow[];
  /** Hide a mix suggestion (a genre's change key) from the suggestions page; changes saved later show again. */
  dismissMixSuggestion(input: { genre: string; key: string; dismissedAt: string }): void;
  listMixDismissals(): MixDismissal[];
  addSuggestionComment(input: Omit<SuggestionComment, 'id'>): SuggestionComment;
  /** Comments of one kind, oldest first. */
  listSuggestionComments(kind: SuggestionComment['kind']): SuggestionComment[];
  /** Pattern-lab decisions, keyed by proposal id. */
  listPatternReviews(): PatternReview[];
  setPatternReview(review: PatternReview): void;
  clearPatternReview(proposalId: string): void;
  close(): void;
}

const SONGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS songs (
    id            TEXT PRIMARY KEY,
    content_hash  TEXT NOT NULL,
    canonical     TEXT NOT NULL,
    genre         TEXT,
    key_text      TEXT NOT NULL,
    bpm           INTEGER NOT NULL,
    generator_seed TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    owner_id    TEXT NOT NULL,
    song_id     TEXT NOT NULL REFERENCES songs(id),
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, song_id)
  );
  CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS suggestion_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('pattern', 'mix')),
    target     TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS suggestion_comments_kind ON suggestion_comments(kind, target);
  CREATE TABLE IF NOT EXISTS mix_suggestion_dismissals (
    genre        TEXT NOT NULL,
    change_key   TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (genre, change_key)
  );
  CREATE TABLE IF NOT EXISTS pattern_reviews (
    proposal_id TEXT PRIMARY KEY,
    status      TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
    note        TEXT NOT NULL DEFAULT '',
    reviewer    TEXT NOT NULL,
    decided_at  TEXT NOT NULL
  );
`;

export interface OpenStoreOptions {
  /** ":memory:" or filesystem path. Relative paths resolve against process.cwd(). */
  path: string;
}

export function openSongsStore({ path }: OpenStoreOptions): SongsStore {
  const dbPath = path === ':memory:' ? ':memory:' : isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SONGS_SCHEMA);
  // Pro-mode mix per project (added 2026-11-23; older databases get the columns here).
  const projectCols = new Set((db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!projectCols.has('mix_overrides')) db.exec(`ALTER TABLE projects ADD COLUMN mix_overrides TEXT`);
  if (!projectCols.has('mix_updated_at')) db.exec(`ALTER TABLE projects ADD COLUMN mix_updated_at TEXT`);
  // Lyrics written in the background (added 2026-11-24).
  if (!projectCols.has('lyrics_state')) db.exec(`ALTER TABLE projects ADD COLUMN lyrics_state TEXT`);
  if (!projectCols.has('lyrics_task')) db.exec(`ALTER TABLE projects ADD COLUMN lyrics_task TEXT`);
  if (!projectCols.has('lyrics_message')) db.exec(`ALTER TABLE projects ADD COLUMN lyrics_message TEXT`);

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO songs
       (id, content_hash, canonical, genre, key_text, bpm, generator_seed, created_at)
     VALUES (@id, @hash, @canonical, @genre, @key_text, @bpm, @seed, @createdAt)`,
  );
  const selectStmt = db.prepare(`SELECT * FROM songs WHERE id = ?`);
  const upsertProjectStmt = db.prepare(
    `INSERT INTO projects (owner_id, song_id, title, created_at, updated_at)
     VALUES (@ownerId, @songId, @title, @createdAt, @updatedAt)
     ON CONFLICT(owner_id, song_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
  );
  const projectSelect = `SELECT p.owner_id, p.song_id, p.title, p.created_at, p.updated_at, p.mix_overrides, p.mix_updated_at,
                                p.lyrics_state, p.lyrics_task, p.lyrics_message,
                                s.genre, s.key_text, s.bpm,
                                json_extract(s.canonical, '$.songStructure') AS structure
                           FROM projects p JOIN songs s ON s.id = p.song_id`;
  const getProjectStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? AND p.song_id = ?`);
  const listProjectsStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? ORDER BY p.updated_at DESC`);
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE owner_id = ? AND song_id = ?`);
  const renameProjectStmt = db.prepare(
    `UPDATE projects SET title = ?, updated_at = ? WHERE owner_id = ? AND song_id = ?`,
  );
  const setLyricsStmt = db.prepare(
    `UPDATE projects SET lyrics_state = ?, lyrics_task = ?, lyrics_message = ? WHERE owner_id = ? AND song_id = ?`,
  );
  const lyricsTaskStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? AND p.lyrics_task = ?`);
  const writingLyricsStmt = db.prepare(`${projectSelect} WHERE p.lyrics_state = 'writing'`);
  const setMixStmt = db.prepare(`UPDATE projects SET mix_overrides = ?, mix_updated_at = ? WHERE owner_id = ? AND song_id = ?`);
  const listMixesStmt = db.prepare(
    `SELECT p.owner_id, p.song_id, p.title, p.mix_overrides, p.mix_updated_at, s.genre, s.canonical
       FROM projects p JOIN songs s ON s.id = p.song_id
      WHERE p.mix_overrides IS NOT NULL ORDER BY p.mix_updated_at DESC`,
  );
  const moveProject = db.transaction(
    (input: { ownerId: string; fromSongId: string; toSongId: string; updatedAt: string }): boolean => {
      const from = getProjectStmt.get(input.ownerId, input.fromSongId) as ProjectDbRow | undefined;
      if (!from) return false;
      if (input.fromSongId === input.toSongId) {
        renameProjectStmt.run(from.title, input.updatedAt, input.ownerId, input.fromSongId);
        return true;
      }
      deleteProjectStmt.run(input.ownerId, input.fromSongId);
      upsertProjectStmt.run({
        ownerId: input.ownerId,
        songId: input.toSongId,
        title: from.title,
        createdAt: from.created_at,
        updatedAt: input.updatedAt,
      });
      // The Pro-mode mix moves with the project.
      setMixStmt.run(from.mix_overrides, from.mix_updated_at, input.ownerId, input.toSongId);
      // So do lyrics still being written for it.
      setLyricsStmt.run(from.lyrics_state, from.lyrics_task, from.lyrics_message, input.ownerId, input.toSongId);
      return true;
    },
  );

  return {
    put({ id, song, canonical, hash, createdAt }) {
      insertStmt.run({
        id,
        hash,
        canonical,
        genre: song.genre ?? null,
        key_text: song.key,
        bpm: Math.round(song.bpm),
        seed: String(song.generator?.seed ?? ''),
        createdAt,
      });
    },
    get(id) {
      const row = selectStmt.get(id) as
        | {
            id: string;
            content_hash: string;
            canonical: string;
            created_at: string;
          }
        | undefined;
      if (!row) return undefined;
      // Re-validate the stored canonical through parseSong so any drift
      // (manual edits to the DB, schema changes between writes and reads,
      // bit-rot) surfaces at retrieval time rather than at the
      // first downstream consumer that tries to use a branded field.
      const song = parseSong(JSON.parse(row.canonical));
      return {
        id: row.id,
        song,
        canonical: row.canonical,
        hash: row.content_hash,
        createdAt: row.created_at,
      };
    },
    upsertProject(input) {
      upsertProjectStmt.run(input);
    },
    getProject(ownerId, songId) {
      const row = getProjectStmt.get(ownerId, songId) as ProjectDbRow | undefined;
      return row ? toProjectRow(row) : undefined;
    },
    listProjects(ownerId) {
      return (listProjectsStmt.all(ownerId) as ProjectDbRow[]).map(toProjectRow);
    },
    moveProject(input) {
      return moveProject(input);
    },
    setProjectMix({ ownerId, songId, mixOverrides, updatedAt }) {
      const json = mixOverrides === null ? null : JSON.stringify(MixOverridesSchema.parse(mixOverrides));
      return setMixStmt.run(json, mixOverrides === null ? null : updatedAt, ownerId, songId).changes > 0;
    },
    listProjectSongIds() {
      return (db.prepare('SELECT DISTINCT song_id FROM projects').all() as { song_id: string }[]).map((r) => r.song_id);
    },
    listProjectMixes() {
      return (listMixesStmt.all() as Array<{
        owner_id: string; song_id: string; title: string; mix_overrides: string; mix_updated_at: string; genre: string | null; canonical: string;
      }>).map((r) => ({
        ownerId: r.owner_id,
        songId: r.song_id,
        title: r.title,
        genre: r.genre,
        canonical: r.canonical,
        mixOverrides: MixOverridesSchema.parse(JSON.parse(r.mix_overrides)),
        mixUpdatedAt: r.mix_updated_at,
      }));
    },
    addSuggestionComment({ kind, target, author, body, createdAt }) {
      const r = db
        .prepare('INSERT INTO suggestion_comments (kind, target, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(kind, target, author, body, createdAt);
      return { id: Number(r.lastInsertRowid), kind, target, author, body, createdAt };
    },
    listSuggestionComments(kind) {
      return (db.prepare('SELECT * FROM suggestion_comments WHERE kind = ? ORDER BY id').all(kind) as Array<{
        id: number; kind: 'pattern' | 'mix'; target: string; author: string; body: string; created_at: string;
      }>).map((r) => ({ id: r.id, kind: r.kind, target: r.target, author: r.author, body: r.body, createdAt: r.created_at }));
    },
    dismissMixSuggestion({ genre, key, dismissedAt }) {
      db.prepare(
        `INSERT INTO mix_suggestion_dismissals (genre, change_key, dismissed_at) VALUES (?, ?, ?)
         ON CONFLICT (genre, change_key) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
      ).run(genre, key, dismissedAt);
    },
    listMixDismissals() {
      return (db.prepare('SELECT genre, change_key, dismissed_at FROM mix_suggestion_dismissals').all() as Array<{ genre: string; change_key: string; dismissed_at: string }>).map(
        (r) => ({ genre: r.genre, key: r.change_key, dismissedAt: r.dismissed_at }),
      );
    },
    renameProject({ ownerId, songId, title, updatedAt }) {
      return renameProjectStmt.run(title, updatedAt, ownerId, songId).changes > 0;
    },
    listPatternReviews() {
      return (db.prepare('SELECT * FROM pattern_reviews ORDER BY proposal_id').all() as Array<{
        proposal_id: string; status: 'approved' | 'rejected'; note: string; reviewer: string; decided_at: string;
      }>).map((r) => ({ proposalId: r.proposal_id, status: r.status, note: r.note, reviewer: r.reviewer, decidedAt: r.decided_at }));
    },
    setPatternReview(r) {
      db.prepare(
        `INSERT INTO pattern_reviews (proposal_id, status, note, reviewer, decided_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id) DO UPDATE SET status = excluded.status, note = excluded.note,
           reviewer = excluded.reviewer, decided_at = excluded.decided_at`,
      ).run(r.proposalId, r.status, r.note, r.reviewer, r.decidedAt);
    },
    clearPatternReview(proposalId) {
      db.prepare('DELETE FROM pattern_reviews WHERE proposal_id = ?').run(proposalId);
    },
    deleteProject(ownerId, songId) {
      return deleteProjectStmt.run(ownerId, songId).changes > 0;
    },
    setProjectLyrics({ ownerId, songId, lyrics }) {
      return (
        setLyricsStmt.run(lyrics?.state ?? null, lyrics?.task ?? null, lyrics?.state === 'failed' ? lyrics.message : null, ownerId, songId).changes > 0
      );
    },
    projectOfLyricsTask(ownerId, task) {
      const row = lyricsTaskStmt.get(ownerId, task) as ProjectDbRow | undefined;
      return row ? toProjectRow(row) : undefined;
    },
    listWritingLyrics() {
      return (writingLyricsStmt.all() as ProjectDbRow[]).map(toProjectRow);
    },
    close() {
      db.close();
    },
  } satisfies SongsStore;
}

interface ProjectDbRow {
  owner_id: string;
  song_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  genre: string | null;
  key_text: string;
  bpm: number;
  structure: string | null;
  mix_overrides: string | null;
  mix_updated_at: string | null;
  lyrics_state: string | null;
  lyrics_task: string | null;
  lyrics_message: string | null;
}

function toProjectRow(row: ProjectDbRow): ProjectRow {
  return {
    ownerId: row.owner_id,
    songId: row.song_id,
    title: row.title,
    genre: row.genre,
    key: row.key_text,
    bpm: row.bpm,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sections: sectionsOf(row.song_id, row.structure),
    mixOverrides: row.mix_overrides === null ? null : MixOverridesSchema.parse(JSON.parse(row.mix_overrides)),
    mixUpdatedAt: row.mix_updated_at,
    lyrics: lyricsOf(row),
  };
}

function lyricsOf(row: ProjectDbRow): ProjectLyrics | null {
  if (row.lyrics_state === null) return null;
  if (row.lyrics_task === null) throw new Error(`Project ${row.song_id}: lyrics state "${row.lyrics_state}" without a task.`);
  if (row.lyrics_state === 'writing') return { state: 'writing', task: row.lyrics_task };
  if (row.lyrics_state === 'failed') return { state: 'failed', task: row.lyrics_task, message: row.lyrics_message ?? '' };
  throw new Error(`Project ${row.song_id}: unknown lyrics state "${row.lyrics_state}".`);
}

function sectionsOf(songId: string, structure: string | null): ProjectSection[] {
  if (structure === null) throw new Error(`Stored song ${songId} has no songStructure.`);
  const segments = JSON.parse(structure) as Array<{
    name: string;
    type?: string;
    bars?: unknown[];
    lengthInBars?: number;
  }>;
  return segments.map((seg) => {
    const bars = seg.lengthInBars ?? seg.bars?.length;
    if (typeof bars !== 'number') throw new Error(`Stored song ${songId}: section ${seg.name} has no length.`);
    return { name: seg.name, type: seg.type ?? null, bars };
  });
}

export type { BetterSqliteDatabase };
