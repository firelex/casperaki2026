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
  /** The loaded song's mixer lanes (one per instrument name). */
  readonly laneNames: readonly string[];
  /** Lanes muted / soloed by the user (kept across songs, by lane name). */
  readonly muted: readonly string[];
  readonly solo: readonly string[];
  /** The loop range in seconds (kept across songs), or undefined. */
  readonly loopRange: LoopRange | undefined;
  /** Whether playback repeats the loop range. */
  readonly looping: boolean;
  /** How the loaded song is mastered while it plays (see MasteringMode). */
  readonly mastering: MasteringMode;
  /** Why matching the master failed (mastering === 'failed'). */
  readonly masteringError: string | undefined;
  /** How the loaded song's start went, e.g. "Loaded in 3.1 s: song 0.9 s · 12 of 136 sounds fetched 1.8 s · engine 0.4 s". */
  readonly loadReport: string | undefined;
}

/**
 * Live mastering: 'stand-in' = +5 dB into NC-17 (the engine's quick stage; the
 * pattern player always, the song player until its profile is ready);
 * 'analysing' = the stand-in plays while a worker renders the song unmastered and
 * matches it to the reference (the server's `casperaki_master sergree`);
 * 'matched' = that matched master plays; 'failed' = matching failed (the
 * stand-in keeps playing and the error is shown).
 */
export type MasteringMode = 'stand-in' | 'analysing' | 'matched' | 'failed';

export interface LoopRange {
  readonly start: number;
  readonly end: number;
}

/** One reading of a device probe: levels in and out of the probed plugin since the last reading. */
export interface ProbeReading {
  readonly inPeak: number;
  readonly inRms: number;
  readonly outPeak: number;
  readonly outRms: number;
  readonly frames: number;
}

/** Per-track levels of one song version, filled in as the meter worker runs. */
export interface LaneMeters {
  readonly names: readonly string[];
  /** Seconds per bin. */
  readonly binSec: number;
  readonly binCount: number;
  /** Bins measured so far (== binCount when done). */
  readonly doneBins: number;
  /** Peak level per bin, one array per lane (length doneBins). */
  readonly peaks: readonly Float32Array[];
  /** Peak level per bin of the reverb, delay and chorus returns and the master (in that order). */
  readonly busPeaks: readonly Float32Array[];
  readonly done: boolean;
  /** The mix as the engine resolved it for this version. */
  readonly mix: ResolvedMix;
}

/** One IR track's mix as resolved by the engine (Mixer::laneInfoJson). */
export interface ResolvedMixLane {
  /** The instrument lane (sequencer row / mixer strip) it belongs to. */
  readonly lane: string;
  readonly track: string;
  readonly lowLevelType: string;
  /** The FX submix bus it is routed to (a rack chain in mix-config.json). */
  readonly fxGroup: string;
  /** Target volume, dB (null when the engine resolved none). */
  readonly volumeDb: number | null;
  readonly sendsDb: { readonly reverb: number | null; readonly delay: number | null; readonly chorus: number | null };
  /** Low-pass cutoff automation (Hz), sampled by the engine. */
  readonly lowPass?: SampledAutomation;
  /** Volume automation (dB, on top of the target volume), sampled by the engine. */
  readonly volume?: SampledAutomation;
}

/** An automation curve sampled every `step` seconds from `t0`. */
export interface SampledAutomation {
  readonly t0: number;
  readonly step: number;
  readonly values: readonly number[];
}

/** The automation's value at `t` (seconds), or undefined outside its range. */
export function automationAt(a: SampledAutomation | undefined, t: number): number | undefined {
  if (!a || a.values.length === 0) return undefined;
  const i = (t - a.t0) / a.step;
  if (i < 0 || i > a.values.length - 1) return undefined;
  const k = Math.floor(i);
  const f = i - k;
  const v0 = a.values[k]!;
  const v1 = a.values[Math.min(a.values.length - 1, k + 1)]!;
  return v0 + (v1 - v0) * f;
}

export interface ResolvedMix {
  readonly mixEnabled: boolean;
  readonly genre: string;
  readonly lanes: readonly ResolvedMixLane[];
  /** mix-config.json as the engine got it (rack chains, constants). */
  readonly config: MixConfigJson;
}

export interface MixConfigJson {
  readonly constants: { readonly masterVolumeDb: number };
  readonly rackChains: readonly { readonly bus: string; readonly plugins: readonly { readonly factory: string; readonly params: readonly number[] }[] }[];
}

/** Meter resolution: 1024 frames ≈ 23 ms at 44.1 kHz. */
const METER_BIN_FRAMES = 1024;
const METERS_CACHED = 4;

/** What the mix export is doing (worker phases, in order). */
export type MixExportPhase = 'render' | 'master' | 'mp3 unmastered' | 'mp3 mastered';
export interface MixExportProgress {
  readonly phase: MixExportPhase;
  /** 0..1 of this phase. */
  readonly share: number;
}
export interface MixExportFiles {
  readonly masteredMp3: Uint8Array;
  readonly masteredWav: Uint8Array;
  readonly unmasteredMp3: Uint8Array;
  readonly unmasteredWav: Uint8Array;
}
const MIX_EXPORT_FILES = ['mastered.mp3', 'mastered.wav', 'unmastered.mp3', 'unmastered.wav'] as const;

/** Mastering profiles cached (one per song version, like the meters). */
const PROFILES_CACHED = 4;

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

/** Real-time master gain. Neither the server render nor legacy normalise a
 *  mix-on song, so unity matches the server. */
const MASTER_GAIN = 1.0;
/** After a seek the engine renders this much silently so reverb and delay
 *  tails are back (the mix's effects carry state). */
const SEEK_PREROLL_SEC = 1.5;
/** The server renders at 44.1 kHz; the engine runs at the context's rate. */
const SAMPLE_RATE = 44100;
const utf8 = new TextEncoder();

/** Shared by every player: the engine binary and decoded samples (by URL). */
let sharedWasm: Promise<ArrayBuffer> | undefined;
const sharedDecoded = new Map<string, Promise<AudioBuffer>>();

export class LivePlayer {
  /**
   * `matchedMastering`: master like the server's export once the song's profile is
   * ready (the song player). Off, the player keeps the stand-in (the pattern
   * player: a lone pattern is not a song to match).
   */
  constructor(private readonly opts: { readonly matchedMastering: boolean }) {}

  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private workletAdded: Promise<void> | undefined;
  private stubPcm: Promise<Float32Array[]> | undefined;
  private loadToken = 0;
  private readonly prepared = new Map<string, Promise<Prepared>>();
  private readonly payloads = new Map<string, Promise<PlaybackPayload>>();
  private readonly mixes = new Map<string, Promise<ResolvedMix>>();
  /** Matched-mastering profiles by key (serialised MasteringProfile bytes). */
  private readonly profiles = new Map<string, Promise<Uint8Array>>();
  /** The worker computing a profile, and how to cancel it. */
  private profileJob: { key: string; worker: Worker; cancel: () => void } | undefined;
  /** The clock: the song was at `anchorPos` seconds when the context time was
   *  `anchorTime`. Re-anchored on every seek and loop change. */
  private anchorTime = 0;
  private anchorPos = 0;
  /** Where the last Play started, for Stop (which returns there). */
  private playStartPos = 0;
  private state: LiveState = {
    status: 'idle', key: undefined, durationSec: 0, step: '', error: undefined, laneNames: [], muted: [], solo: [],
    loopRange: undefined, looping: false, mastering: 'stand-in', masteringError: undefined, loadReport: undefined,
  };
  private meterWorker: Worker | undefined;
  private readonly meterCache = new Map<string, LaneMeters>();
  private readonly listeners = new Set<(s: LiveState) => void>();
  private readonly positionListeners = new Set<() => void>();
  /** Device views: the probed plugin (bus + slot) and who listens to its readings. */
  private probe: { bus: string; slot: number } | undefined;
  private readonly probeListeners = new Set<(r: ProbeReading | { error: string }) => void>();

  /** Probe one rack plugin (bus, slot in its chain) while playing; undefined stops. */
  setProbe(probe: { bus: string; slot: number } | undefined): void {
    this.probe = probe;
    this.postProbe();
  }

  private readonly ringListeners = new Set<(r: { input: Float32Array; output: Float32Array }) => void>();
  /** The probe's last 4096 samples in and out (about 15 a second while playing), for spectra. */
  onProbeRings(fn: (r: { input: Float32Array; output: Float32Array }) => void): () => void {
    this.ringListeners.add(fn);
    return () => this.ringListeners.delete(fn);
  }

  /** Readings of the probe (about 30 a second while playing). */
  onProbe(fn: (r: ProbeReading | { error: string }) => void): () => void {
    this.probeListeners.add(fn);
    return () => this.probeListeners.delete(fn);
  }

  private postProbe(): void {
    if (!this.node) return;
    const p = this.probe;
    this.node.port.postMessage({ type: 'probe', bus: utf8.encode(p?.bus ?? ''), slot: p ? p.slot : -1 });
  }

  /** Called when the position jumps (seek), so paused displays redraw. */
  onPositionJump(fn: () => void): () => void {
    this.positionListeners.add(fn);
    return () => this.positionListeners.delete(fn);
  }

  getState(): LiveState {
    return this.state;
  }

  subscribe(fn: (s: LiveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Seconds into the song as heard now. Advances only while the audio is running. */
  position(): number {
    // The context clock runs ahead of the speakers by the output latency
    // (often 0.1–0.2 s with 'playback' buffering, more than a 16th note), so
    // what is heard lags what the engine renders.
    if (!this.ctx) return 0;
    const latency = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return this.songTime(latency);
  }

  /** Where the engine is rendering (no latency): for re-anchoring the clock. */
  private enginePosition(): number {
    return this.songTime(0);
  }

  private songTime(latency: number): number {
    if (!this.ctx || this.state.status === 'idle' || this.state.status === 'loading') return 0;
    let pos = this.anchorPos + Math.max(0, this.ctx.currentTime - this.anchorTime - latency);
    // Same rule as the worklet: crossing the loop end from inside jumps back.
    const loop = this.activeLoop();
    if (loop && this.anchorPos < loop.end && pos >= loop.end) {
      pos = loop.start + ((pos - loop.end) % (loop.end - loop.start));
    }
    return Math.min(this.state.durationSec, Math.max(0, pos));
  }

  /** Set (or clear) the loop range. Applies live; kept across songs. */
  setLoopRange(range: LoopRange | undefined): void {
    if (range && !(range.start >= 0 && range.end > range.start)) {
      throw new Error(`Bad loop range ${range.start}..${range.end}`);
    }
    this.reanchor();
    this.set({ loopRange: range, looping: range ? this.state.looping : false });
    this.postLoop();
  }

  /** Turn looping of the loop range on or off. */
  setLooping(on: boolean): void {
    if (on && !this.state.loopRange) throw new Error('Select a range to loop first.');
    this.reanchor();
    this.set({ looping: on });
    this.postLoop();
    // Turning the loop on outside the range starts it from the range.
    const loop = this.activeLoop();
    if (loop && this.node) {
      const pos = this.enginePosition();
      if (pos < loop.start || pos >= loop.end) this.seek(loop.start);
    }
  }

  /**
   * Stop: pause and go back to where the last Play started (or to the start
   * of the song with `toStart`, the double-click on Stop).
   */
  async stopAndReturn(toStart: boolean): Promise<void> {
    if (!this.node) return;
    if (this.state.status === 'playing') await this.pause();
    this.seek(toStart ? 0 : this.playStartPos);
  }

  private activeLoop(): LoopRange | undefined {
    const { loopRange, looping, durationSec } = this.state;
    if (!looping || !loopRange || durationSec <= 0) return undefined;
    return loopRange.end <= durationSec ? loopRange : undefined;
  }

  private reanchor(): void {
    if (!this.ctx) return;
    this.anchorPos = this.enginePosition();
    this.anchorTime = this.ctx.currentTime;
  }

  private postLoop(): void {
    if (!this.node || !this.ctx) return;
    const loop = this.activeLoop();
    const sr = this.ctx.sampleRate;
    this.node.port.postMessage(
      loop ? { type: 'loop', start: Math.round(loop.start * sr), end: Math.round(loop.end * sr) } : { type: 'loop', start: null },
    );
  }

  /** Before (re)starting: with the loop on, play from its start when outside it. */
  private enterLoopIfOutside(): void {
    const loop = this.activeLoop();
    if (!loop) return;
    const pos = this.enginePosition();
    if (pos < loop.start || pos >= loop.end) this.seek(loop.start);
  }

  /**
   * Load a song and start playing it. `fetchPayload` gets the lowered song
   * and its sample list from the brain. Call from a click handler: browsers
   * only allow audio to start from a user gesture.
   */
  async play(
    key: string,
    fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
    /** seamless: keep playing while the new version loads, then switch at the same position.
     *  reload: build `key` again even when it is the one loaded (its mix changed). */
    opts: { seamless?: boolean; reload?: boolean } = {},
  ): Promise<void> {
    const ctx = this.context();
    // Resume inside the gesture, before any await, so the browser allows audio.
    const resumed = ctx.resume();
    if (!opts.reload && this.state.key === key && this.node && ['paused', 'playing', 'ended'].includes(this.state.status)) {
      if (this.state.status === 'ended') this.seek(0);
      this.enterLoopIfOutside();
      if (this.state.status !== 'playing') this.playStartPos = this.enginePosition();
      await resumed;
      this.assertRunning(ctx);
      this.set({ status: 'playing' });
      return;
    }
    const token = ++this.loadToken;
    const playT0 = performance.now();
    const wasPrepared = this.prepared.has(key);
    // Seamless: keep the current version playing while the new one loads,
    // then switch at the same position (an edit while listening).
    const seamless = Boolean(opts.seamless) && this.node !== undefined && this.state.status === 'playing';
    if (!seamless) {
      this.teardown();
      this.set({ status: 'loading', key, durationSec: 0, step: 'Preparing the song…', error: undefined });
    }
    try {
      const [{ payload, realSamples }, wasmBytes, stubs] = await Promise.all([
        this.ensurePrepared(key, fetchPayload, (done, total) => {
          if (token === this.loadToken && !seamless) this.set({ step: `Loading sounds ${done}/${total}` });
        }),
        this.wasm(),
        this.stubs(ctx),
        this.worklet(ctx),
      ]);
      if (token !== this.loadToken) return;
      const preparedAt = performance.now();
      if (!seamless) this.set({ step: 'Starting the engine…' });

      const node = new AudioWorkletNode(ctx, 'casperaki-render-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasmBytes: wasmBytes.slice(0),
          sampleRate: ctx.sampleRate,
          masterGain: MASTER_GAIN,
          mixConfig: utf8.encode(payload.mixConfig),
          // Matched mastering: the live layer plays the +5 dB NC-17 stand-in until
          // the profile arrives, then the matched master. Without it, the stand-in
          // in the engine's mix (docs/67 #1). Both bound the peaks.
          ...(this.opts.matchedMastering ? { liveMastering: true } : { mastered: true }),
          seekPrerollFrames: Math.round(SEEK_PREROLL_SEC * ctx.sampleRate),
          laneGains: {},
          // The worklet scope has no TextEncoder: hand it UTF-8 bytes.
          song: utf8.encode(payload.song),
          insts: payload.insts.map((t) => utf8.encode(t)),
          samples: stubs,
          realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
        },
      });
      let laneNames: string[] = [];
      const ready = new Promise<number>((resolve, reject) => {
        node.port.onmessage = (ev: MessageEvent) => {
          const d = ev.data as { type: string; totalFrames?: number; sampleRate?: number; message?: string; laneNames?: string[] };
          if (d.type === 'ready') {
            laneNames = d.laneNames ?? [];
            resolve((d.totalFrames ?? 0) / (d.sampleRate ?? ctx.sampleRate));
          } else if (d.type === 'error' && node === this.node) this.set({ status: 'error', error: `The audio engine failed: ${d.message}` });
          else if (d.type === 'error') reject(new Error(`The audio engine failed: ${d.message}`));
          else if (d.type === 'ended' && node === this.node) this.set({ status: 'ended' });
          else if (d.type === 'probe' && node === this.node) {
            const r = d as unknown as ProbeReading;
            for (const fn of this.probeListeners) fn(r);
          } else if (d.type === 'probeRings' && node === this.node) {
            const r = d as unknown as { input: Float32Array; output: Float32Array };
            for (const fn of this.ringListeners) fn(r);
          } else if (d.type === 'probeError' && node === this.node) {
            for (const fn of this.probeListeners) fn({ error: d.message ?? 'probe failed' });
          } else if (d.type === 'mastered' && node === this.node) {
            this.set({ mastering: 'matched', masteringError: undefined });
          } else if (d.type === 'masterError' && node === this.node) {
            console.error(`[live] the matched master could not start: ${d.message}`);
            this.set({ mastering: 'failed', masteringError: d.message ?? 'unknown error' });
          }
        };
      });
      const durationSec = await ready;
      if (token !== this.loadToken) {
        node.port.onmessage = null;
        node.disconnect();
        return;
      }
      await resumed;
      this.assertRunning(ctx);
      // Where the new version starts: the current position when swapping in
      // an edit, else the start (or the loop's start).
      const swapAt = seamless ? Math.min(this.enginePosition(), durationSec) : undefined;
      this.teardown();
      this.node = node;
      this.set({ key, laneNames, durationSec, mastering: this.opts.matchedMastering ? 'analysing' : 'stand-in', masteringError: undefined });
      if (this.opts.matchedMastering) this.startMatchedMaster(key, node, fetchPayload);
      // A loop past the end of this (shorter) version can't play: drop it, visibly.
      const range = this.state.loopRange;
      if (range && range.end > durationSec) this.set({ loopRange: undefined, looping: false });
      this.postLaneGains();
      this.postLoop();
      if (this.probe) this.postProbe();
      const loop = this.activeLoop();
      // Position the new engine before it is heard (messages run before its first pull).
      let startAt = 0;
      if (swapAt !== undefined) {
        // Instant jump: no pre-roll render on the audio thread mid-playback.
        node.port.postMessage({ type: 'seek', frame: Math.round(swapAt * ctx.sampleRate), preroll: 0 });
        startAt = swapAt;
      } else if (loop) {
        node.port.postMessage({ type: 'seek', frame: Math.round(loop.start * ctx.sampleRate) });
        startAt = loop.start;
        this.playStartPos = loop.start;
      } else this.playStartPos = 0;
      // An exception on the audio thread stops the node silently: say so, and start fresh next time.
      node.onprocessorerror = () => {
        if (node !== this.node) return;
        console.error(`[live] the audio engine stopped while playing ${key} (processor error)`);
        this.teardown();
        this.set({ status: 'error', error: 'The audio engine stopped while playing (an error on the audio thread). Press Play to start it again.' });
      };
      node.connect(this.output(ctx));
      this.anchorTime = ctx.currentTime;
      this.anchorPos = startAt;
      const t = this.loadTimes.get(key);
      const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      const loadReport =
        `Loaded in ${sec(performance.now() - playT0)}: ` +
        (wasPrepared || !t
          ? 'song and sounds were ready'
          : `song ${sec(t.songMs)} · ${t.fetched} of ${t.total} sounds fetched ${sec(t.soundsMs)}`) +
        ` · engine ${sec(performance.now() - preparedAt)}`;
      console.info(`[live] ${key}: ${loadReport}`);
      this.set({ status: 'playing', step: '', loadReport });
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

  /**
   * Pro mode, live: a track's fader trim (dB, 0 = standard), one of its sends
   * (bus 0 reverb, 1 delay, 2 chorus; dB), or a parameter (raw 0..1) of the
   * plugin at `slot` of an FX bus. Goes to the engine playing `key` only (a no-op
   * when another song or nothing is loaded: the saved mix reaches the next load).
   */
  proMix(
    key: string,
    change:
      | { laneTrim: { lane: string; db: number } }
      | { laneSend: { lane: string; bus: 0 | 1 | 2; db: number } }
      | { busParam: { bus: string; slot: number; index: number; value: number } },
  ): void {
    if (!this.node || this.state.key !== key) return;
    if ('busParam' in change) {
      this.node.port.postMessage({ type: 'proMix', busParam: { ...change.busParam, bus: utf8.encode(change.busParam.bus) } });
    } else this.node.port.postMessage({ type: 'proMix', ...change });
  }

  /**
   * Forget every fetched song, prepared song, resolved mix and meter reading
   * (their mix config is out of date after a Pro-mode save). What is loaded keeps
   * playing; the next load, meter run or export fetches again.
   */
  forgetMixes(): void {
    this.payloads.clear();
    this.prepared.clear();
    this.mixes.clear();
    this.meterCache.clear();
  }

  /** Mute or unmute a track (by lane name). Applies live. */
  setMuted(lane: string, on: boolean): void {
    const muted = new Set(this.state.muted);
    if (on) muted.add(lane);
    else muted.delete(lane);
    this.set({ muted: [...muted] });
    this.postLaneGains();
  }

  /** Solo or unsolo a track. With any track soloed, only soloed tracks play. */
  setSolo(lane: string, on: boolean): void {
    const solo = new Set(this.state.solo);
    if (on) solo.add(lane);
    else solo.delete(lane);
    this.set({ solo: [...solo] });
    this.postLaneGains();
  }

  /** Replace the whole solo set (empty = nothing soloed). Applies live. */
  setSoloLanes(lanes: readonly string[]): void {
    this.set({ solo: [...lanes] });
    this.postLaneGains();
  }

  private postLaneGains(): void {
    if (!this.node) return;
    const { laneNames, muted, solo } = this.state;
    const gains: Record<string, number> = {};
    for (const lane of laneNames) {
      const audible = solo.length > 0 ? solo.includes(lane) : !muted.includes(lane);
      gains[lane] = audible ? 1 : 0;
    }
    this.node.port.postMessage({ type: 'laneGains', gains });
  }

  /**
   * Measure every track's level for one song version in a background worker
   * (the engine renders it as fast as it can, silently). `onUpdate` gets the
   * levels as they fill in. Returns a function that cancels the run. Results
   * are cached per key.
   */
  meters(
    key: string,
    fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
    onUpdate: (m: LaneMeters) => void,
    onError: (message: string) => void,
  ): () => void {
    const cached = this.meterCache.get(key);
    if (cached) {
      onUpdate(cached);
      return () => undefined;
    }
    this.meterWorker?.terminate();
    let cancelled = false;
    const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
    this.meterWorker = worker;
    worker.onerror = (ev) => {
      if (!cancelled) onError(`The engine worker failed: ${ev.message || 'it could not start'}`);
    };
    const ctx = this.context();
    void Promise.all([this.ensurePrepared(key, fetchPayload, () => undefined), this.wasm(), this.stubs(ctx)])
      .then(([{ payload, realSamples }, wasmBytes, stubs]) => {
        if (cancelled) return;
        let names: string[] = [];
        let binSec = 0;
        let binCount = 0;
        let mix: ResolvedMix | undefined;
        worker.onmessage = (ev: MessageEvent) => {
          const d = ev.data as {
            type: string; names?: string[]; binSec?: number; binCount?: number; doneBins?: number; peaks?: Float32Array[]; message?: string;
            mix?: Omit<ResolvedMix, 'config'>;
            busPeaks?: Float32Array[];
          };
          if (d.type === 'lanes') {
            names = d.names!;
            binSec = d.binSec!;
            binCount = d.binCount!;
            if (!d.mix) throw new Error('The meter worker sent no mix.');
            mix = { ...d.mix, config: JSON.parse(payload.mixConfig) as MixConfigJson };
          } else if (d.type === 'progress' || d.type === 'done') {
            if (!mix) throw new Error('Track levels arrived before the lanes.');
            if (!d.busPeaks) throw new Error('The meter worker sent no bus levels.');
            const m: LaneMeters = { names, binSec, binCount, doneBins: d.doneBins!, peaks: d.peaks!, busPeaks: d.busPeaks, done: d.type === 'done', mix };
            if (m.done) {
              this.meterCache.set(key, m);
              while (this.meterCache.size > METERS_CACHED) this.meterCache.delete(this.meterCache.keys().next().value!);
              worker.terminate();
            }
            if (!cancelled) onUpdate(m);
          } else if (d.type === 'error') {
            worker.terminate();
            console.error(`[live] measuring track levels failed: ${d.message}`);
            if (!cancelled) onError(`The engine could not measure this version: ${d.message}`);
          }
        };
        worker.postMessage({
          type: 'meter',
          wasmBytes: wasmBytes.slice(0),
          sampleRate: ctx.sampleRate,
          meterBinFrames: METER_BIN_FRAMES,
          song: utf8.encode(payload.song),
          insts: payload.insts.map((t) => utf8.encode(t)),
          samples: stubs,
          realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
          mixConfig: utf8.encode(payload.mixConfig),
        });
      })
      .catch((err: unknown) => {
        console.error('[live] preparing track levels failed:', err);
        if (!cancelled) onError(`Preparing this version for the engine failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
      if (this.meterWorker === worker) {
        worker.terminate();
        this.meterWorker = undefined;
      }
    };
  }

  /**
   * The matched-mastering profile of one song version: rendered unmastered in a
   * worker and analysed (the same analysis as the server's casperaki_master).
   * Cached per key; a profile still being computed for another key is cancelled.
   */
  profileOf(key: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): Promise<Uint8Array> {
    const cached = this.profiles.get(key);
    if (cached) return cached;
    if (this.profileJob && this.profileJob.key !== key) this.profileJob.cancel();
    const ctx = this.context();
    const job = Promise.all([this.ensurePrepared(key, fetchPayload, () => undefined), this.wasm(), this.stubs(ctx)]).then(
      ([{ payload, realSamples }, wasmBytes, stubs]) =>
        new Promise<Uint8Array>((resolve, reject) => {
          if (this.profiles.get(key) !== job) {
            reject(new ProfileCancelled(key));
            return;
          }
          const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
          const done = () => {
            worker.terminate();
            if (this.profileJob?.worker === worker) this.profileJob = undefined;
          };
          this.profileJob = { key, worker, cancel: () => { done(); this.profiles.delete(key); reject(new ProfileCancelled(key)); } };
          worker.onerror = (ev) => {
            done();
            reject(new Error(`The engine worker failed: ${ev.message || 'it could not start'}`));
          };
          worker.onmessage = (ev: MessageEvent) => {
            const d = ev.data as { type: string; bytes?: Uint8Array; message?: string };
            done();
            if (d.type === 'profile' && d.bytes) resolve(d.bytes);
            else reject(new Error(`Matching the master failed: ${d.message ?? d.type}`));
          };
          worker.postMessage({
            type: 'profile',
            wasmBytes: wasmBytes.slice(0),
            sampleRate: ctx.sampleRate,
            song: utf8.encode(payload.song),
            insts: payload.insts.map((t) => utf8.encode(t)),
            samples: stubs,
            realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
            mixConfig: utf8.encode(payload.mixConfig),
          });
        }),
    );
    job.catch(() => {
      if (this.profiles.get(key) === job) this.profiles.delete(key);
    });
    this.profiles.set(key, job);
    while (this.profiles.size > PROFILES_CACHED) this.profiles.delete(this.profiles.keys().next().value!);
    return job;
  }

  /** Compute (or reuse) the profile for the playing node and hand it over. */
  private startMatchedMaster(key: string, node: AudioWorkletNode, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): void {
    this.profileOf(key, fetchPayload).then(
      (bytes) => {
        if (node !== this.node) return;
        node.port.postMessage({ type: 'profile', bytes: bytes.slice() });
      },
      (err: unknown) => {
        if (node !== this.node || err instanceof ProfileCancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[live] matching the master for ${key} failed:`, err);
        this.set({ mastering: 'failed', masteringError: message });
      },
    );
  }

  /** Jump to `seconds` into the loaded song (playing or paused). */
  seek(seconds: number): void {
    if (!this.node || !this.ctx) return;
    const target = Math.min(Math.max(0, seconds), this.state.durationSec);
    this.node.port.postMessage({ type: 'seek', frame: Math.round(target * this.ctx.sampleRate) });
    this.anchorPos = target;
    this.anchorTime = this.ctx.currentTime;
    // A seek while stopped moves where Stop returns to (as in a DAW).
    if (this.state.status !== 'playing') this.playStartPos = target;
    this.positionListeners.forEach((fn) => fn());
    if (this.state.status === 'ended') this.set({ status: 'paused' });
  }

  /** Whether `key` is loaded and can be sought without reloading. */
  isLoaded(key: string): boolean {
    return this.state.key === key && this.node !== undefined && this.state.status !== 'loading';
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

  /** The lowered song for `key` (fetched once; kept while it is prepared or recent). */
  payloadOf(key: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): Promise<PlaybackPayload> {
    let p = this.payloads.get(key);
    if (!p) {
      p = fetchPayload(new AbortController().signal);
      p.catch(() => this.payloads.delete(key));
      this.payloads.set(key, p);
      while (this.payloads.size > PREPARED_LIMIT * 2) this.payloads.delete(this.payloads.keys().next().value!);
    }
    return p;
  }

  /**
   * The mix the engine resolves for `key` (buses, sends, volumes), quickly:
   * built from the lowered song alone in a short-lived worker, without
   * fetching or decoding any sample. Cached per key.
   */
  mixOf(key: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>): Promise<ResolvedMix> {
    let job = this.mixes.get(key);
    if (job) return job;
    const ctx = this.context();
    job = Promise.all([this.payloadOf(key, fetchPayload), this.wasm(), this.stubs(ctx)]).then(
      ([payload, wasmBytes, stubs]) =>
        new Promise<ResolvedMix>((resolve, reject) => {
          const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
          worker.onerror = (ev) => {
            worker.terminate();
            reject(new Error(`The engine worker failed: ${ev.message || 'it could not start'}`));
          };
          worker.onmessage = (ev: MessageEvent) => {
            const d = ev.data as { type: string; mix?: Omit<ResolvedMix, 'config'>; message?: string };
            worker.terminate();
            if (d.type === 'mix' && d.mix) resolve({ ...d.mix, config: JSON.parse(payload.mixConfig) as MixConfigJson });
            else reject(new Error(`The engine could not resolve the mix: ${d.message ?? d.type}`));
          };
          worker.postMessage({
            type: 'mix',
            wasmBytes: wasmBytes.slice(0),
            sampleRate: ctx.sampleRate,
            song: utf8.encode(payload.song),
            insts: payload.insts.map((t) => utf8.encode(t)),
            samples: stubs,
            realSamples: [],
            mixConfig: utf8.encode(payload.mixConfig),
          });
        }),
    );
    job.catch(() => this.mixes.delete(key));
    this.mixes.set(key, job);
    while (this.mixes.size > METERS_CACHED) this.mixes.delete(this.mixes.keys().next().value!);
    return job;
  }

  /** One plugin's impulse response (a fresh instance with these settings), rendered in a worker. */
  async impulse(factory: string, params: readonly number[], seconds: number): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
    const ctx = this.context();
    const wasmBytes = await this.wasm();
    return new Promise((resolve, reject) => {
      const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
      worker.onerror = (ev) => {
        worker.terminate();
        reject(new Error(`The engine worker failed: ${ev.message || 'it could not start'}`));
      };
      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { type: string; left?: Float32Array; right?: Float32Array; sampleRate?: number; message?: string };
        worker.terminate();
        if (d.type === 'impulse') resolve({ left: d.left!, right: d.right!, sampleRate: d.sampleRate! });
        else reject(new Error(`The engine could not measure the impulse response: ${d.message ?? d.type}`));
      };
      worker.postMessage({ type: 'impulse', wasmBytes: wasmBytes.slice(0), sampleRate: ctx.sampleRate, factory, params: [...params], seconds });
    });
  }

  /**
   * Render a song offline in a worker (the full mix, with effects), for a
   * WAV download. `onProgress` gets the share done (0..1).
   */
  async renderAudio(
    key: string,
    fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
    onProgress: (share: number) => void,
  ): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
    const ctx = this.context();
    const [{ payload, realSamples }, wasmBytes, stubs] = await Promise.all([
      this.ensurePrepared(key, fetchPayload, () => undefined),
      this.wasm(),
      this.stubs(ctx),
    ]);
    return new Promise((resolve, reject) => {
      const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
      worker.onerror = (ev) => {
        worker.terminate();
        reject(new Error(`The engine worker failed: ${ev.message || 'it could not start'}`));
      };
      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { type: string; done?: number; total?: number; left?: Float32Array; right?: Float32Array; sampleRate?: number; message?: string };
        if (d.type === 'progress') onProgress(d.total ? d.done! / d.total : 0);
        else if (d.type === 'rendered') {
          worker.terminate();
          resolve({ left: d.left!, right: d.right!, sampleRate: d.sampleRate! });
        } else if (d.type === 'error') {
          worker.terminate();
          reject(new Error(`The engine could not render: ${d.message}`));
        }
      };
      worker.postMessage({
        type: 'render',
        wasmBytes: wasmBytes.slice(0),
        sampleRate: ctx.sampleRate,
        song: utf8.encode(payload.song),
        insts: payload.insts.map((t) => utf8.encode(t)),
        samples: stubs,
        realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
        mixConfig: utf8.encode(payload.mixConfig),
      });
    });
  }

  /**
   * The song's mix downloads, made in the browser like the server's render: the
   * full song rendered unmastered in a worker (24-bit WAV), mastered from frame 0
   * with the same code as `casperaki_master sergree` (24-bit WAV), and both
   * encoded with LAME VBR -V2 (lame.wasm, a separate module). `onProgress` gets
   * what is being done and the share of it done.
   */
  async mixExport(
    key: string,
    fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
    onProgress: (p: MixExportProgress) => void,
    /** Only these tracks heard (the pattern lab's solo download). */
    soloLanes?: readonly string[],
  ): Promise<MixExportFiles> {
    const ctx = this.context();
    const [{ payload, realSamples }, wasmBytes, stubs, lameBytes] = await Promise.all([
      this.ensurePrepared(key, fetchPayload, () => undefined),
      this.wasm(),
      this.stubs(ctx),
      fetchOk(`/wasm/lame.wasm?v=${__ENGINE_VERSION__}`).then((r) => r.arrayBuffer()),
    ]);
    return new Promise((resolve, reject) => {
      const worker = new Worker(`/workers/casperaki-meter-worker.js?v=${__ENGINE_VERSION__}`, { type: 'module' });
      worker.onerror = (ev) => {
        worker.terminate();
        reject(new Error(`The engine worker failed: ${ev.message || 'it could not start'}`));
      };
      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { type: string; phase?: MixExportPhase; share?: number; files?: Record<string, Uint8Array>; message?: string };
        if (d.type === 'exportProgress') onProgress({ phase: d.phase!, share: d.share! });
        else if (d.type === 'mixExport') {
          worker.terminate();
          const f = d.files!;
          const missing = MIX_EXPORT_FILES.filter((name) => !f[name]);
          if (missing.length) {
            reject(new Error(`The engine worker made no ${missing.join(', ')}.`));
            return;
          }
          resolve({ masteredMp3: f['mastered.mp3']!, masteredWav: f['mastered.wav']!, unmasteredMp3: f['unmastered.mp3']!, unmasteredWav: f['unmastered.wav']! });
        } else if (d.type === 'error') {
          worker.terminate();
          reject(new Error(`The engine could not make the mix: ${d.message}`));
        }
      };
      worker.postMessage({
        type: 'mixExport',
        wasmBytes: wasmBytes.slice(0),
        lameBytes,
        sampleRate: ctx.sampleRate,
        song: utf8.encode(payload.song),
        insts: payload.insts.map((t) => utf8.encode(t)),
        samples: stubs,
        realSamples: realSamples.map((r) => ({ ...r, key: utf8.encode(r.key) })),
        mixConfig: utf8.encode(payload.mixConfig),
        ...(soloLanes ? { soloLanes: [...soloLanes] } : {}),
      }, [lameBytes]);
    });
  }

  /** Per prepared song: how long its parts took (for the load report). */
  private readonly loadTimes = new Map<string, { songMs: number; soundsMs: number; fetched: number; total: number }>();

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
    const t0 = performance.now();
    const timing = { songMs: 0, soundsMs: 0, fetched: 0, total: 0 };
    this.loadTimes.set(key, timing);
    const job = this.payloadOf(key, fetchPayload).then(async (payload) => {
      const t1 = performance.now();
      timing.songMs = t1 - t0;
      timing.total = new Set(payload.samples.map((x) => x.url)).size;
      const realSamples = await this.loadSamples(ctx, payload.samples, (done, total) => {
        timing.fetched = total;
        progress(done, total);
      });
      timing.soundsMs = performance.now() - t1;
      return { payload, realSamples };
    });
    job.catch(() => this.prepared.delete(key));
    this.prepared.set(key, job);
    while (this.prepared.size > PREPARED_LIMIT) this.prepared.delete(this.prepared.keys().next().value!);
    return job;
  }

  private context(): AudioContext {
    // A closed context (the browser can close it) is replaced, with its worklet module and level tap.
    if (this.ctx?.state === 'closed') {
      this.ctx = undefined;
      this.workletAdded = undefined;
      this.tap = undefined;
    }
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback', sampleRate: SAMPLE_RATE });
    return this.ctx;
  }

  /** After resume(): the browser must really be playing audio, else say so (never play silence). */
  private assertRunning(ctx: AudioContext): void {
    if (ctx.state !== 'running') {
      throw new Error(`The browser's audio is ${ctx.state}, not running. Click Play again (browsers start audio only after a click).`);
    }
  }

  private tap: AnalyserNode | undefined;
  private tapBuf: Float32Array | undefined;

  /** The loudest sample of the output just now, in dBFS (−Infinity when silent or nothing plays). */
  outputPeakDb(): number {
    if (!this.tap || !this.node || this.state.status !== 'playing') return -Infinity;
    this.tapBuf ??= new Float32Array(this.tap.fftSize);
    this.tap.getFloatTimeDomainData(this.tapBuf);
    let peak = 0;
    for (const v of this.tapBuf) peak = Math.max(peak, Math.abs(v));
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  /** Clear what one song's view left on the player: solo, mutes and the loop (a new card starts clean). */
  clearMixState(): void {
    this.set({ solo: [], muted: [], loopRange: undefined, looping: false });
    this.postLaneGains();
    this.postLoop();
  }

  /** The engine output goes straight to the speakers: the engine's mastering
   *  stage (NC-17) already limits the peaks, so no browser compressor colours
   *  the sound (it used to, unlike the server export). */
  private output(ctx: AudioContext): AudioNode {
    // A pass-through level tap (for "playing, but nothing is audible" checks).
    if (!this.tap) {
      this.tap = ctx.createAnalyser();
      this.tap.fftSize = 2048;
      this.tap.connect(ctx.destination);
    }
    return this.tap;
  }

  private teardown(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = undefined;
    }
  }

  private wasm(): Promise<ArrayBuffer> {
    sharedWasm ??= fetchOk(`/wasm/engine-render.wasm?v=${__ENGINE_VERSION__}`).then((r) => r.arrayBuffer());
    return sharedWasm;
  }

  private worklet(ctx: AudioContext): Promise<void> {
    this.workletAdded ??= ctx.audioWorklet.addModule(`/worklets/casperaki-render-worklet.js?v=${__ENGINE_VERSION__}`);
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
    let p = sharedDecoded.get(url);
    if (!p) {
      p = fetchOk(url)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b));
      // A failed fetch must not stay cached.
      p.catch(() => sharedDecoded.delete(url));
      sharedDecoded.set(url, p);
    }
    return p;
  }

  private async loadSamples(
    ctx: AudioContext,
    plan: PlaybackSample[],
    progress: (done: number, total: number) => void,
  ): Promise<RealSample[]> {
    const urls = [...new Set(plan.map((s) => s.url))];
    // Count only what still has to be fetched: sounds another song (or version) already
    // loaded are shared by URL (a sample's URL names its file and slice).
    const toFetch = new Set(urls.filter((u) => !sharedDecoded.has(u)));
    let done = 0;
    if (toFetch.size) progress(0, toFetch.size);
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      urls.map(async (u) => {
        try {
          buffers.set(u, await this.decode(ctx, u));
        } catch (err) {
          const keys = plan.filter((x) => x.url === u).map((x) => `${x.kind} ${x.key}`).join(', ');
          throw new Error(`The sample for ${keys} (${u}) could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (toFetch.has(u)) progress(++done, toFetch.size);
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

/** A profile computation dropped because another song's started (not an error). */
class ProfileCancelled extends Error {
  constructor(key: string) {
    super(`mastering profile for ${key} cancelled`);
  }
}

/** The song's player: the play bar, songs list and sequencer. */
export const livePlayer = new LivePlayer({ matchedMastering: true });
/**
 * The detail window's own player: plays the open pattern on its own, with
 * its own loop and playhead, independent of the song's transport.
 */
export const patternPlayer = new LivePlayer({ matchedMastering: false });
// For debugging from the browser console and automated browser tests.
Object.assign(globalThis, { __casperakiLive: livePlayer, __casperakiPattern: patternPlayer });
