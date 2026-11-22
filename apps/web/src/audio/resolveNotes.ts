/**
 * The notes the playback engine actually plays, from its own resolver
 * (public/wasm/engine-resolve.{js,wasm}, built from the same Resolver as the
 * renderer): chord voicings, octaves and lengths exactly as heard. Used by
 * the detail view's piano roll instead of reading the song's events itself.
 */

import type { PlaybackPayload } from '../api/playback';

interface ResolveModule {
  StringList: new () => { push_back(s: string): void; delete(): void };
  resolveSong(song: string, insts: { push_back(s: string): void }): string;
}

declare global {
  // Defined by public/wasm/engine-resolve.js (an emscripten classic script).
  // eslint-disable-next-line no-var
  var createResolveEngine: ((opts: { locateFile(path: string): string }) => Promise<ResolveModule>) | undefined;
}

export interface EngineNote {
  /** MIDI pitch. */
  readonly pitch: number;
  /** Beats from the song start. */
  readonly start: number;
  readonly length: number;
  /** 0..127 */
  readonly velocity: number;
  /** The engine track it is on (e.g. "Keys", "Bass-long"). */
  readonly track: string;
}

interface ResolvedV1 {
  tracks: { name: string; clips: { type: string; notes?: { n: number; startBeat: number; lenBeats: number; vel: number }[] }[] }[];
}

let engine: Promise<ResolveModule> | undefined;

function loadEngine(): Promise<ResolveModule> {
  engine ??= new Promise<void>((resolve, reject) => {
    if (globalThis.createResolveEngine) return resolve();
    const s = document.createElement('script');
    s.src = `/wasm/engine-resolve.js?v=${__ENGINE_VERSION__}`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('The engine resolver (engine-resolve.js) could not be loaded.'));
    document.head.appendChild(s);
  }).then(() => {
    const create = globalThis.createResolveEngine;
    if (!create) throw new Error('engine-resolve.js loaded but defined no createResolveEngine.');
    return create({ locateFile: (path) => `/wasm/${path}?v=${__ENGINE_VERSION__}` });
  });
  engine.catch(() => (engine = undefined));
  return engine;
}

/** Every MIDI note the engine resolves for this lowered song (step-sequenced drums excluded). */
export async function resolveEngineNotes(payload: PlaybackPayload): Promise<EngineNote[]> {
  const m = await loadEngine();
  const insts = new m.StringList();
  try {
    for (const t of payload.insts) insts.push_back(t);
    const out = JSON.parse(m.resolveSong(payload.song, insts)) as ResolvedV1;
    return out.tracks.flatMap((t) =>
      t.clips.flatMap((c) =>
        c.type === 'midi' && c.notes
          ? c.notes.map((n) => ({ pitch: n.n, start: n.startBeat, length: n.lenBeats, velocity: n.vel, track: t.name }))
          : [],
      ),
    );
  } finally {
    insts.delete();
  }
}
