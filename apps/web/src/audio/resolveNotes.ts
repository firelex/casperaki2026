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
  /** Beats from the song start (clip offset included). */
  readonly start: number;
  readonly length: number;
  /** 0..127 */
  readonly velocity: number;
  /** The engine track it is on (e.g. "Keys", "Bass-long"). */
  readonly track: string;
}

interface ResolvedV1 {
  tracks: {
    name: string;
    clips: {
      type: string;
      startSec: number;
      notes?: { n: number; startBeat: number; lenBeats: number; vel: number }[];
      channels?: { note: number; name: string }[];
      patterns?: { numSteps: number; hits: { ch: number; step: number; vel: number }[] }[];
    }[];
  }[];
}

/** One drum hit as the engine plays it. */
export interface EngineHit {
  /** The kit piece (engine drum lane, e.g. "bassDrum1", "hiHatOpen"). */
  readonly drum: string;
  /** Beats from the song start. */
  readonly start: number;
  /** 0..127 */
  readonly velocity: number;
}

/** Everything the engine plays, per engine track. */
export interface EngineEvents {
  readonly tempo: number;
  readonly tracks: readonly { readonly name: string; readonly notes: readonly EngineNote[]; readonly hits: readonly EngineHit[] }[];
}

/** Steps per beat in the engine's drum step clips (32nd notes). */
const DRUM_STEPS_PER_BEAT = 8;

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

/**
 * Everything the engine plays for this lowered song, per engine track:
 * pitched notes and drum hits (step clips), in beats from the song start.
 */
export async function resolveEngineEvents(payload: PlaybackPayload): Promise<EngineEvents> {
  const m = await loadEngine();
  const insts = new m.StringList();
  try {
    for (const t of payload.insts) insts.push_back(t);
    const out = JSON.parse(m.resolveSong(payload.song, insts)) as ResolvedV1;
    const tempo = (JSON.parse(payload.song) as { tempo?: number }).tempo;
    if (typeof tempo !== 'number' || !(tempo > 0)) throw new Error('The lowered song has no tempo.');
    const beatsPerSec = tempo / 60;
    return {
      tempo,
      tracks: out.tracks.map((t) => {
        const notes: EngineNote[] = [];
        const hits: EngineHit[] = [];
        for (const c of t.clips) {
          // Note beats and steps are relative to their clip (one per section): add the clip's start.
          const offset = c.startSec * beatsPerSec;
          if (c.type === 'midi' && c.notes) {
            for (const n of c.notes) notes.push({ pitch: n.n, start: offset + n.startBeat, length: n.lenBeats, velocity: n.vel, track: t.name });
          } else if (c.type === 'step' && c.channels && c.patterns) {
            for (const pat of c.patterns)
              for (const h of pat.hits) {
                const ch = c.channels[h.ch];
                if (!ch) throw new Error(`${t.name}: drum hit on unknown channel ${h.ch}`);
                hits.push({ drum: ch.name, start: offset + h.step / DRUM_STEPS_PER_BEAT, velocity: h.vel });
              }
          }
        }
        return { name: t.name, notes, hits };
      }),
    };
  } finally {
    insts.delete();
  }
}

/** Every MIDI note the engine resolves for this lowered song (step-sequenced drums excluded). */
export async function resolveEngineNotes(payload: PlaybackPayload): Promise<EngineNote[]> {
  return (await resolveEngineEvents(payload)).tracks.flatMap((t) => t.notes);
}
