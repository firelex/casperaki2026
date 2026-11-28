/**
 * Matched-mastering profiles kept in the browser (IndexedDB), so a page reload plays a song with its matched master
 * at once instead of the louder stand-in master while the whole song is analysed again.
 *
 * A profile is stored under a hash of exactly what was analysed: the engine version, the sample rate, the lowered
 * song, its instrument files and the mix config (Pro-mode changes included). Anything that changes the analysis
 * changes the key, so a stored profile is never used for audio it was not measured on.
 */

import type { PlaybackPayload } from '../api/playback';

const DB_NAME = 'casperaki-mastering';
const STORE = 'profiles';

/** The key a profile is stored under (hex SHA-256 of what the analysis depends on). */
export async function profileStoreKey(payload: Pick<PlaybackPayload, 'song' | 'insts' | 'mixConfig' | 'masteringReference'>, engineVersion: string, sampleRate: number): Promise<string> {
  // The reference a genre recipe masters towards is part of what is analysed (none: Atemlos, the key as before).
  const text = JSON.stringify([engineVersion, sampleRate, payload.song, payload.insts, payload.mixConfig, ...(payload.masteringReference ? [payload.masteringReference] : [])]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function request<T>(r: IDBRequest<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Mastering profile store: ${what} failed: ${r.error?.message ?? 'unknown error'}`));
  });
}

let opened: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!opened) {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    opened = request(r, 'opening the database');
  }
  return opened;
}

/** The stored profile for `key`, or undefined when none was stored yet. */
export async function loadProfile(key: string): Promise<Uint8Array | undefined> {
  const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
  const value = await request(store.get(key) as IDBRequest<Uint8Array | undefined>, 'reading a profile');
  return value === undefined ? undefined : new Uint8Array(value);
}

export async function saveProfile(key: string, bytes: Uint8Array): Promise<void> {
  const store = (await db()).transaction(STORE, 'readwrite').objectStore(STORE);
  await request(store.put(bytes.slice(), key), 'saving a profile');
}
