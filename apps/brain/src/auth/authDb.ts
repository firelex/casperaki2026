// apps/brain/src/auth/authDb.ts
//
// Opens the brain's auth sqlite DB and ensures the user_sessions table.
// Separate file from the songs store so auth state is self-contained.
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const USER_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_sessions (
    session_id              TEXT PRIMARY KEY,
    sub                     TEXT NOT NULL,
    email                   TEXT NOT NULL,
    name                    TEXT NOT NULL,
    refresh_token_enc       TEXT NOT NULL,
    access_token            TEXT NOT NULL,
    access_token_expires_at TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    created_at              TEXT NOT NULL
  );
`;

export function openAuthDb(path: string): Database.Database {
  const dbPath = path === ':memory:' ? ':memory:' : isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(USER_SESSIONS_SCHEMA);
  return db;
}
