/**
 * Auditioning library sounds that are single audio files (drum hits, loops,
 * FX) in the Sounds browser: a drum hit plays a typical groove for its kind,
 * a loop loops, an effect plays once. Tonal sounds are heard through the
 * pattern player instead (a generated pattern).
 */

const GROOVES: Readonly<Record<string, string>> = {
  // 16 steps per bar (16ths), 'x' a hit, 'a' an accented hit.
  kickDrums: 'a...x...a...x...',
  snareDrums: '....a.......a...',
  clapsSnaps: '....a.......a...',
  hiHatsClosed: 'a.x.a.x.a.x.a.x.',
  hiHatsOpen: '..x...x...x...x.',
  cymbals: 'a...............',
  toms: '........a..x.xxx',
  shakers: 'axxxaxxxaxxxaxxx',
  percussionMisc: 'a..x..x...x.a...',
};
const GROOVE_BPM = 112;

export type AuditionKind = 'groove' | 'loop' | 'once';

export function auditionKind(family: string): AuditionKind {
  if (family in GROOVES) return 'groove';
  if (family === 'percussionLoops' || family === 'percussionBreaks') return 'loop';
  return 'once';
}

class Audition {
  private ctx: AudioContext | undefined;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private stopCurrent: (() => void) | undefined;
  private listeners = new Set<(id: string | undefined, state: 'loading' | 'playing' | 'idle', error?: string) => void>();
  private currentId: string | undefined;

  onChange(fn: (id: string | undefined, state: 'loading' | 'playing' | 'idle', error?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string | undefined, state: 'loading' | 'playing' | 'idle', error?: string) {
    this.currentId = state === 'idle' ? undefined : id;
    for (const fn of this.listeners) fn(id, state, error);
  }

  get playingId(): string | undefined {
    return this.currentId;
  }

  stop(): void {
    this.stopCurrent?.();
    this.stopCurrent = undefined;
    if (this.currentId) this.emit(this.currentId, 'idle');
  }

  /** Play `url` (the sound's OGG) as its family suggests. Call from a click. */
  async play(id: string, url: string, family: string): Promise<void> {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    const resumed = ctx.resume();
    this.stop();
    this.emit(id, 'loading');
    try {
      let job = this.buffers.get(url);
      if (!job) {
        job = fetch(url)
          .then((r) => {
            if (!r.ok) throw new Error(`${url} answered ${r.status}`);
            return r.arrayBuffer();
          })
          .then((b) => ctx.decodeAudioData(b));
        job.catch(() => this.buffers.delete(url));
        this.buffers.set(url, job);
      }
      const buffer = await job;
      await resumed;
      if (this.currentId !== id) return; // another sound was started meanwhile
      const out = ctx.createGain();
      out.gain.value = 0.8;
      out.connect(ctx.destination);
      const kind = auditionKind(family);
      if (kind === 'loop' || kind === 'once') {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = kind === 'loop';
        src.connect(out);
        src.onended = () => {
          if (this.currentId === id) this.emit(id, 'idle');
        };
        src.start();
        this.stopCurrent = () => {
          src.onended = null;
          src.stop();
          out.disconnect();
        };
      } else {
        // A groove: schedule hits a little ahead, bar after bar.
        const steps = GROOVES[family]!;
        const stepSec = 60 / GROOVE_BPM / 4;
        let next = ctx.currentTime + 0.05;
        let step = 0;
        const sources: AudioBufferSourceNode[] = [];
        const tick = () => {
          while (next < ctx.currentTime + 0.2) {
            const c = steps[step % steps.length]!;
            if (c !== '.') {
              const src = ctx.createBufferSource();
              src.buffer = buffer;
              const g = ctx.createGain();
              g.gain.value = c === 'a' ? 1 : 0.6;
              src.connect(g).connect(out);
              src.start(next);
              sources.push(src);
              src.onended = () => sources.splice(sources.indexOf(src), 1);
            }
            next += stepSec;
            step++;
          }
        };
        tick();
        const timer = setInterval(tick, 50);
        this.stopCurrent = () => {
          clearInterval(timer);
          for (const s of sources) s.stop();
          out.disconnect();
        };
      }
      this.emit(id, 'playing');
    } catch (err) {
      this.emit(id, 'idle', err instanceof Error ? err.message : String(err));
    }
  }
}

export const audition = new Audition();
