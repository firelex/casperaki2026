/**
 * Live player: plays a song in the browser in real time with the WASM engine
 * (public/wasm/engine-render.wasm, driven by the AudioWorklet in
 * public/worklets/casperaki-render-worklet.js). No server render involved:
 * the brain lowers the song (~1 s) and serves the sample slices it uses; the
 * engine mixes them live as the audio thread pulls blocks.
 *
 * One player for the whole page (songs list and editor share it). Decoded
 * samples are cached by URL, so replaying a song, or playing an edit of it,
 * only fetches what changed.
 */

import type { PlaybackPayload, PlaybackSample } from '../api/playback';

export type LiveStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface LiveState {
  readonly status: LiveStatus;
  /** Identifies what is loaded: a saved song id, or the working copy's id. */
  readonly key: string | undefined;
  readonly durationSec: number;
  /** What the loader is doing, for the UI ("Loading sounds 12/139"). */
  readonly step: string;
  readonly error: string | undefined;
}

interface Prepared {
  payload: PlaybackPayload;
  realSamples: RealSample[];
}

/** How many prepared songs to keep ready (current song, its last edits). */
const PREPARED_LIMIT = 4;

interface RealSample {
  key: string;
  ch0: Float32Array;
  ch1: Float32Array | null;
  sampleRate: number;
}

/** Fixed real-time master gain (the real-time path has no look-ahead
 *  normaliser; see docs/60). */
const MASTER_GAIN = 0.15;
const utf8 = new TextEncoder();

class LivePlayer {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private wasmBytes: Promise<ArrayBuffer> | undefined;
  private workletAdded: Promise<void> | undefined;
  private readonly decoded = new Map<string, Promise<AudioBuffer>>();
  private stubPcm: Promise<Float32Array[]> | undefined;
  private loadToken = 0;
  private readonly prepared = new Map<string, Promise<Prepared>>();
  /** ctx.currentTime when playback started at song position 0. */
  private startedAt = 0;
  private state: LiveState = { status: 'idle', key: undefined, durationSec: 0, step: '', error: undefined };
  private readonly listeners = new Set<(s: LiveState) => void>();

  getState(): LiveState {
    return this.state;
  }

  subscribe(fn: (s: LiveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Seconds into the song. Advances only while the audio is running. */
  position(): number {
    if (!this.ctx || this.state.status === 'idle' || this.state.status === 'loading') return 0;
    return Math.min(this.state.durationSec, Math.max(0, this.ctx.currentTime - this.startedAt));
  }

  /**
   * Load a song and start playing it. `fetchPayload` gets the lowered song
   * and its sample list from the brain. Call from a click handler: browsers
   * only allow audio to start from a user gesture.
   */
  async play(key: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): Promise<void> {
    const ctx = this.context();
    // Resume inside the gesture, before any await, so the browser allows audio.
    const resumed = ctx.resume();
    if (this.state.key === key && this.node && (this.state.status === 'paused' || this.state.status === 'playing')) {
      await resumed;
      this.set({ status: 'playing' });
      return;
    }
    const token = ++this.loadToken;
    this.teardown();
    this.set({ status: 'loading', key, durationSec: 0, step: 'Preparing the song…', error: undefined });
    try {
      const [{ payload, realSamples }, wasmBytes, stubs] = await Promise.all([
        this.ensurePrepared(key, fetchPayload, (done, total) => {
          if (token === this.loadToken) this.set({ step: `Loading sounds ${done}/${total}` });
        }),
        this.wasm(),
        this.stubs(ctx),
        this.worklet(ctx),
      ]);
      if (token !== this.loadToken) return;
      this.set({ step: 'Starting the engine…' });

      const node = new AudioWorkletNode(ctx, 'casperaki-render-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasmBytes: wasmBytes.slice(0),
          sampleRate: ctx.sampleRate,
          masterGain: MASTER_GAIN,
          // The worklet scope has no TextEncoder: hand it UTF-8 bytes.
          song: utf8.encode(payload.song),
          insts: payload.insts.map((t) => utf8.encode(t)),
          samples: stubs,
          realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
        },
      });
      const ready = new Promise<number>((resolve, reject) => {
        node.port.onmessage = (ev: MessageEvent) => {
          const d = ev.data as { type: string; totalFrames?: number; sampleRate?: number; message?: string };
          if (d.type === 'ready') resolve((d.totalFrames ?? 0) / (d.sampleRate ?? ctx.sampleRate));
          else if (d.type === 'error') reject(new Error(`The audio engine failed: ${d.message}`));
          else if (d.type === 'ended' && node === this.node) this.set({ status: 'ended' });
        };
      });
      this.node = node;
      const durationSec = await ready;
      if (token !== this.loadToken) {
        node.disconnect();
        return;
      }
      await resumed;
      node.connect(ctx.destination);
      this.startedAt = ctx.currentTime;
      this.set({ status: 'playing', durationSec, step: '' });
    } catch (err) {
      if (token !== this.loadToken) return;
      this.teardown();
      this.set({ status: 'error', step: '', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get a song ready in the background (lowered, samples fetched and
   * decoded) so a later play() only has to start the engine. Safe to call
   * often: an already prepared or preparing song is not fetched again.
   */
  prepare(key: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): void {
    this.ensurePrepared(key, fetchPayload, () => undefined).catch((err: unknown) => {
      // play() will retry and show the error; keep a trace for debugging.
      console.warn(`[live] preparing ${key} failed:`, err);
    });
  }

  async pause(): Promise<void> {
    if (!this.ctx || this.state.status !== 'playing') return;
    await this.ctx.suspend();
    this.set({ status: 'paused' });
  }

  /** Stop and forget the loaded song (e.g. when it was edited or deleted). */
  stop(): void {
    this.loadToken++;
    this.teardown();
    this.set({ status: 'idle', key: undefined, durationSec: 0, step: '', error: undefined });
  }

  private ensurePrepared(
    key: string,
    fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
    progress: (done: number, total: number) => void,
  ): Promise<Prepared> {
    const existing = this.prepared.get(key);
    if (existing) {
      // Most recently used goes last.
      this.prepared.delete(key);
      this.prepared.set(key, existing);
      return existing;
    }
    const ctx = this.context();
    const job = fetchPayload(new AbortController().signal).then(async (payload) => ({
      payload,
      realSamples: await this.loadSamples(ctx, payload.samples, progress),
    }));
    job.catch(() => this.prepared.delete(key));
    this.prepared.set(key, job);
    while (this.prepared.size > PREPARED_LIMIT) this.prepared.delete(this.prepared.keys().next().value!);
    return job;
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    return this.ctx;
  }

  private teardown(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = undefined;
    }
  }

  private wasm(): Promise<ArrayBuffer> {
    this.wasmBytes ??= fetchOk('/wasm/engine-render.wasm').then((r) => r.arrayBuffer());
    return this.wasmBytes;
  }

  private worklet(ctx: AudioContext): Promise<void> {
    this.workletAdded ??= ctx.audioWorklet.addModule('/worklets/casperaki-render-worklet.js');
    return this.workletAdded;
  }

  private stubs(ctx: AudioContext): Promise<Float32Array[]> {
    this.stubPcm ??= Promise.all(
      ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg'].map(async (n) => {
        const ab = await this.decode(ctx, `/api/playback/stubs/${n}`);
        return ab.getChannelData(0).slice();
      }),
    );
    return this.stubPcm;
  }

  private decode(ctx: AudioContext, url: string): Promise<AudioBuffer> {
    let p = this.decoded.get(url);
    if (!p) {
      p = fetchOk(url)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b));
      // A failed fetch must not stay cached.
      p.catch(() => this.decoded.delete(url));
      this.decoded.set(url, p);
    }
    return p;
  }

  private async loadSamples(
    ctx: AudioContext,
    plan: PlaybackSample[],
    progress: (done: number, total: number) => void,
  ): Promise<RealSample[]> {
    const urls = [...new Set(plan.map((s) => s.url))];
    let done = 0;
    progress(0, urls.length);
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      urls.map(async (u) => {
        buffers.set(u, await this.decode(ctx, u));
        progress(++done, urls.length);
      }),
    );
    return plan.map((s) => {
      const ab = buffers.get(s.url)!;
      if (s.kind === 'fret') {
        if (s.index === undefined || !s.count) throw new Error(`Fret sample ${s.key} has no slice index.`);
        const from = Math.round((s.index / s.count) * ab.length);
        const to = Math.round(((s.index + 1) / s.count) * ab.length);
        return samplerSample(s.key, ab, from, to);
      }
      // Loops and transitions play as recorded; sampler voices get the
      // Tracktion sampler's start fade (matches the native render).
      return s.kind === 'wave' ? waveSample(s.key, ab) : samplerSample(s.key, ab, 0, ab.length);
    });
  }

  private set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r;
}

function channels(ab: AudioBuffer, from: number, to: number): [Float32Array, Float32Array | null] {
  return [ab.getChannelData(0).slice(from, to), ab.numberOfChannels > 1 ? ab.getChannelData(1).slice(from, to) : null];
}

function waveSample(key: string, ab: AudioBuffer): RealSample {
  const [ch0, ch1] = channels(ab, 0, ab.length);
  return { key, ch0, ch1, sampleRate: ab.sampleRate };
}

function samplerSample(key: string, ab: AudioBuffer, from: number, to: number): RealSample {
  const [ch0, ch1] = channels(ab, from, to);
  // Tracktion's sampler fades a non-silent start in over 30 samples.
  if (ch0.length > 0 && (Math.abs(ch0[0]!) > 0.01 || (ch1 && Math.abs(ch1[0]!) > 0.01))) {
    const len = Math.min(30, ch0.length);
    const step = Math.PI / 2 / len;
    for (let i = 0; i < len; i++) {
      const g = 1 - Math.cos(i * step);
      ch0[i] = ch0[i]! * g;
      if (ch1) ch1[i] = ch1[i]! * g;
    }
  }
  return { key, ch0, ch1, sampleRate: ab.sampleRate };
}

export const livePlayer = new LivePlayer();
