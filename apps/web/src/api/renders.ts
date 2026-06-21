/**
 * Brain `renders` API.
 *
 * Wraps the dev/local render artifact endpoints exposed by
 * `apps/brain/src/routes/renders.ts`:
 *
 *   GET /api/renders/latest       → JSON metadata
 *   GET /api/renders/latest.wav   → WAV bytes
 *
 * This is a DEV/LOCAL bridge — the brain surfaces a single configurable
 * artifact path written out by the native engine-spike harness. No
 * render queue, no per-song mapping, no browser-triggered native render.
 * See docs/54c-ui-render-artifact.md for the contract and limits.
 */

import { BrainClient, defaultBrainClient } from './client';

export interface RenderMetadata {
  readonly exists: boolean;
  readonly durationSec?: number;
  readonly peakDb?: number;
  readonly rmsDb?: number;
  readonly sampleRate?: number;
  readonly bitDepth?: number;
  readonly channels?: number;
  readonly sizeBytes?: number;
  readonly updatedAt?: string;
  readonly url?: string;
}

/** Per-bin amplitude overview of the local render WAV (docs/54g). The
 *  brain computes these by binning the decoded PCM frames into `bins`
 *  buckets and returning the per-bin max-absolute amplitude (`peaks`)
 *  + per-bin RMS amplitude (`rms`). Empty arrays + `exists:false` when
 *  the artifact is missing; empty arrays + `exists:true` when the WAV
 *  is unreadable (the UI surfaces a fallback timeline). */
export interface RenderPeaks {
  readonly exists: boolean;
  readonly bins: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly durationSec?: number;
  readonly peaks: readonly number[];
  readonly rms: readonly number[];
  readonly updatedAt?: string;
}

export const LATEST_RENDER_WAV_URL = '/api/renders/latest.wav';

export class RendersApi {
  constructor(private readonly client: BrainClient = defaultBrainClient) {}

  /** Fetch the latest local render metadata. Returns `{ exists:false }`
   *  when the artifact is missing — never throws on a missing file. */
  latest(signal?: AbortSignal): Promise<RenderMetadata> {
    return this.client.get<RenderMetadata>('/api/renders/latest', { signal });
  }

  /** Lightweight peaks/rms overview of the latest render. `bins` is the
   *  number of buckets the WAV is downsampled into — 256–512 is the
   *  sweet spot for a 4000-pixel-wide editor timeline. */
  peaks(bins: number, signal?: AbortSignal): Promise<RenderPeaks> {
    const safe = Math.max(1, Math.min(4096, Math.floor(bins)));
    return this.client.get<RenderPeaks>(
      `/api/renders/latest/peaks?bins=${safe}`,
      { signal },
    );
  }

  /** Stable URL for the latest render WAV. Suitable for `<audio src>`. */
  latestWavUrl(): string {
    return LATEST_RENDER_WAV_URL;
  }
}

export const rendersApi = new RendersApi();

export const rendersQueryKeys = {
  latest: () => ['renders', 'latest'] as const,
  peaks: (bins: number) => ['renders', 'peaks', bins] as const,
};
