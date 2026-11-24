// Lists the stored vocal takes (BRAIN_VOCAL_TAKES_DIR) with their size and voice, and which saved songs play them
// (found by fingerprint, as the brain does); with --delete-unused, deletes the takes no saved song plays.
// The brain already deletes a take when the last saved song using it is saved again or deleted; this catches takes
// sung for songs never saved.
//
//   npx tsx apps/brain/scripts/list-vocal-takes.ts <takesDir> <songs.sqlite> [--delete-unused]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseSong } from '@casperaki/song-schema';

import { openSongsStore } from '../src/store.js';
import { deleteUnusedTakes, songTakeFingerprints } from '../src/vocals/takes.js';

const [takesDir, dbPath, flag] = process.argv.slice(2);
if (!takesDir || !dbPath || (flag !== undefined && flag !== '--delete-unused')) {
  console.error('usage: list-vocal-takes.ts <takesDir> <songs.sqlite> [--delete-unused]');
  process.exit(2);
}
for (const p of [takesDir, dbPath]) if (!existsSync(p)) throw new Error(`${p} not found`);

const store = openSongsStore({ path: dbPath });
const users = new Map<string, string[]>();
for (const id of store.listProjectSongIds()) {
  const s = store.get(id);
  if (!s || !s.canonical.includes('"vocals"')) continue;
  for (const fp of songTakeFingerprints(parseSong(JSON.parse(s.canonical)))) users.set(fp, [...(users.get(fp) ?? []), id]);
}
store.close();

const takes = readdirSync(takesDir).filter((n) => /^[0-9a-f]{64}\.ogg$/u.test(n)).map((n) => n.slice(0, 64));
if (flag === '--delete-unused') {
  const deleted = deleteUnusedTakes(takesDir, takes, new Set(users.keys()));
  console.log(`deleted ${deleted.length} take(s) no saved song plays`);
} else {
  let total = 0;
  for (const id of takes) {
    const size = statSync(join(takesDir, `${id}.ogg`)).size;
    total += size;
    const info = existsSync(join(takesDir, `${id}.json`)) ? (JSON.parse(readFileSync(join(takesDir, `${id}.json`), 'utf8')) as { voice?: string; durationSeconds?: number }) : {};
    console.log(`${id}  ${(size / 1e6).toFixed(2)} MB  ${info.voice ?? '?'}  ${info.durationSeconds ?? '?'} s  ${users.get(id)?.join(', ') ?? '(no saved song)'}`);
  }
  console.log(`${takes.length} takes, ${(total / 1e6).toFixed(1)} MB`);
}
