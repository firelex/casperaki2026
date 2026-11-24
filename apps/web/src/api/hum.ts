import { BrainError, defaultBrainClient, type BrainErrorBody } from './client';

export interface BeatNote {
  readonly beat: number;
  readonly midi: number;
  readonly duration: number;
}

export interface HumAlternative {
  readonly label: string;
  /** 16 half-bar chords in the song's key. */
  readonly chords: readonly string[];
  /** The 8-bar melody: hummed bars, then the completion. */
  readonly melody: readonly BeatNote[];
  readonly completed: boolean;
}

export interface HumAnalysis {
  readonly id: string;
  readonly mode: 'click' | 'free';
  readonly bpm: number;
  readonly songKey: string;
  readonly bars: number;
  readonly hummedBars: number;
  readonly notesHeard: number;
  readonly hum: { readonly notesKept: number; readonly pickupDropped: number };
  readonly melody: readonly BeatNote[];
  readonly alternatives: readonly HumAlternative[];
  readonly timings: Readonly<Record<string, number>>;
}

/** A failed hum step, with the step named ("transcribing", "chords", "completing", "building the song"). */
export class HumError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function humError(err: unknown, fallbackStep: string): HumError {
  if (err instanceof BrainError) {
    const body = err.body as (BrainErrorBody & { step?: string }) | undefined;
    return new HumError(body?.step ?? fallbackStep, err.message);
  }
  return new HumError(fallbackStep, err instanceof Error ? err.message : String(err));
}

export const humApi = {
  async analyse(audio: Blob, opts: { mode: 'click'; bpm: number; firstBeatSec: number } | { mode: 'free' }): Promise<HumAnalysis> {
    const q = new URLSearchParams({ mode: opts.mode });
    if (opts.mode === 'click') {
      q.set('bpm', String(opts.bpm));
      q.set('firstBeatSec', opts.firstBeatSec.toFixed(4));
    }
    const res = await fetch(`/api/hum/analyse?${q}`, {
      method: 'POST',
      body: audio,
      headers: { 'content-type': audio.type || 'application/octet-stream' },
      credentials: 'include',
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HumError('transcribing', `The server answered ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const b = body as { step?: string; message?: string; error?: string };
      throw new HumError(b.step ?? 'transcribing', b.message ?? b.error ?? `Failed (${res.status})`);
    }
    return body as HumAnalysis;
  },
  /** Complete one alternative (or all); with an edit, only the bars not in keepBars are rewritten, over its chords. */
  async complete(
    analysisId: string,
    alternative?: number,
    edit?: { readonly melody: readonly BeatNote[]; readonly chords: readonly string[]; readonly keepBars: readonly number[] },
  ): Promise<HumAnalysis> {
    try {
      return await defaultBrainClient.post<HumAnalysis>('/api/hum/complete', { analysisId, ...(alternative === undefined ? {} : { alternative }), ...edit });
    } catch (err) {
      throw humError(err, 'completing');
    }
  },
  async song(
    analysisId: string,
    alternative: number,
    genre: string,
    edit?: { readonly melody: readonly BeatNote[]; readonly chords: readonly string[] },
  ): Promise<{ songId: string }> {
    try {
      return await defaultBrainClient.post<{ songId: string }>('/api/hum/song', { analysisId, alternative, genre, ...edit });
    } catch (err) {
      throw humError(err, 'building the song');
    }
  },
  /** The fitter's chords for an edited melody (16 half bars). */
  async refit(analysisId: string, melody: readonly BeatNote[]): Promise<string[]> {
    try {
      return (await defaultBrainClient.post<{ chords: string[] }>('/api/hum/refit', { analysisId, melody })).chords;
    } catch (err) {
      throw humError(err, 'chords');
    }
  },
  /** Every chord the fitter knows for one half bar, best fit to the melody first. */
  async chordOptions(analysisId: string, melody: readonly BeatNote[], slot: number): Promise<{ chord: string; fit: number }[]> {
    try {
      return (await defaultBrainClient.post<{ options: { chord: string; fit: number }[] }>('/api/hum/chord-options', { analysisId, melody, slot })).options;
    } catch (err) {
      throw humError(err, 'chords');
    }
  },
};
