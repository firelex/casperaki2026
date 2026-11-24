#!/usr/bin/env node
// Lists the sung vocal takes (BRAIN_VOCAL_TAKES_DIR) with their size, voice and the saved songs that use them, and
// deletes only the takes named on the command line. Takes are never deleted otherwise.
//
//   node apps/brain/scripts/list-vocal-takes.mjs <takesDir> <songs.sqlite>            list
//   node apps/brain/scripts/list-vocal-takes.mjs <takesDir> <songs.sqlite> --delete <fingerprint> ...
//
// A take in use by a saved song is not deleted (the command stops and names the songs).

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [takesDir, dbPath, flag, ...ids] = process.argv.slice(2);
if (!takesDir || !dbPath) {
  console.error('usage: list-vocal-takes.mjs <takesDir> <songs.sqlite> [--delete <fingerprint> ...]');
  process.exit(2);
}
for (const p of [takesDir, dbPath]) if (!existsSync(p)) throw new Error(`${p} not found`);

// Which saved songs name which takes (aiArtifacts of kind soulx-vocal, uri vocal-take:<fp>.wav).
const db = new DatabaseSync(dbPath, { readOnly: true });
const users = new Map();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
for (const table of tables) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const songCol = cols.find((c) => /song/iu.test(c) && c !== 'song_id');
  if (!songCol || !cols.includes('id')) continue;
  for (const row of db.prepare(`SELECT id, ${songCol} AS song FROM ${table}`).all()) {
    if (typeof row.song !== 'string' || !row.song.includes('vocal-take:')) continue;
    for (const m of row.song.matchAll(/vocal-take:([0-9a-f]{64})\.wav/gu)) {
      if (!users.has(m[1])) users.set(m[1], new Set());
      users.get(m[1]).add(`${table}/${row.id}`);
    }
  }
}

const takes = readdirSync(takesDir).filter((n) => /^[0-9a-f]{64}\.wav$/u.test(n)).map((n) => n.slice(0, 64));
if (flag === '--delete') {
  if (ids.length === 0) throw new Error('--delete needs the fingerprints to delete');
  for (const id of ids) {
    if (!takes.includes(id)) throw new Error(`no take ${id} in ${takesDir}`);
    if (users.has(id)) throw new Error(`take ${id} is used by ${[...users.get(id)].join(', ')}; not deleted`);
  }
  for (const id of ids) {
    for (const ext of ['wav', 'json']) if (existsSync(join(takesDir, `${id}.${ext}`))) unlinkSync(join(takesDir, `${id}.${ext}`));
    console.log(`deleted ${id}`);
  }
} else if (flag !== undefined) {
  throw new Error(`unknown option ${flag}`);
} else {
  let total = 0;
  for (const id of takes) {
    const size = statSync(join(takesDir, `${id}.wav`)).size;
    total += size;
    const info = existsSync(join(takesDir, `${id}.json`)) ? JSON.parse(readFileSync(join(takesDir, `${id}.json`), 'utf8')) : {};
    console.log(`${id}  ${(size / 1e6).toFixed(1)} MB  ${info.voice ?? '?'}  ${info.durationSeconds ?? '?'} s  ${users.has(id) ? [...users.get(id)].join(', ') : '(no saved song)'}`);
  }
  console.log(`${takes.length} takes, ${(total / 1e6).toFixed(1)} MB`);
}
