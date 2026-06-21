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

export interface SongsStore {
  put(input: { id: string; song: Song; canonical: string; hash: string; createdAt: string }): void;
  get(id: string): StoredSong | undefined;
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
    close() {
      db.close();
    },
  } satisfies SongsStore;
}

export type { BetterSqliteDatabase };
