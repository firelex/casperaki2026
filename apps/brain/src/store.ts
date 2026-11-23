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
}

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
  /** Save (or with null clear) a project's Pro-mode mix. Returns false if the owner has no such project. */
  setProjectMix(input: { ownerId: string; songId: string; mixOverrides: MixOverrides | null; updatedAt: string }): boolean;
  /** Every project with a Pro-mode mix, newest first (the suggestions page). */
  listProjectMixes(): ProjectMixRow[];
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
                                s.genre, s.key_text, s.bpm,
                                json_extract(s.canonical, '$.songStructure') AS structure
                           FROM projects p JOIN songs s ON s.id = p.song_id`;
  const getProjectStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? AND p.song_id = ?`);
  const listProjectsStmt = db.prepare(`${projectSelect} WHERE p.owner_id = ? ORDER BY p.updated_at DESC`);
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE owner_id = ? AND song_id = ?`);
  const renameProjectStmt = db.prepare(
    `UPDATE projects SET title = ?, updated_at = ? WHERE owner_id = ? AND song_id = ?`,
  );
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
  };
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
