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

import { parseSong, type Song } from '@casperaki/song-schema';

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
}

export interface SongsStore {
  put(input: { id: string; song: Song; canonical: string; hash: string; createdAt: string }): void;
  get(id: string): StoredSong | undefined;
  /** Create or update the owner's project row for a song. */
  upsertProject(input: { ownerId: string; songId: string; title: string; createdAt: string; updatedAt: string }): void;
  getProject(ownerId: string, songId: string): ProjectRow | undefined;
  listProjects(ownerId: string): ProjectRow[];
  /** Replace the song a project points at (an edit saved under a new
   *  content id), keeping its title and created date. Returns false if
   *  the owner has no project for `fromSongId`. */
  moveProject(input: { ownerId: string; fromSongId: string; toSongId: string; updatedAt: string }): boolean;
  renameProject(input: { ownerId: string; songId: string; title: string; updatedAt: string }): boolean;
  deleteProject(ownerId: string, songId: string): boolean;
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
  const projectSelect = `SELECT p.owner_id, p.song_id, p.title, p.created_at, p.updated_at,
                                s.genre, s.key_text, s.bpm
                           FROM projects p JOIN songs s ON s.id = p.song_id`;
  const getProjectStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? AND p.song_id = ?`);
  const listProjectsStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? ORDER BY p.updated_at DESC`);
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE owner_id = ? AND song_id = ?`);
  const renameProjectStmt = db.prepare(
    `UPDATE projects SET title = ?, updated_at = ? WHERE owner_id = ? AND song_id = ?`,
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
    renameProject({ ownerId, songId, title, updatedAt }) {
      return renameProjectStmt.run(title, updatedAt, ownerId, songId).changes > 0;
    },
    deleteProject(ownerId, songId) {
      return deleteProjectStmt.run(ownerId, songId).changes > 0;
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
  };
}

export type { BetterSqliteDatabase };
