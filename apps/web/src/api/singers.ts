/** Brain `singers` API — matches `apps/brain/src/routes/singers.ts`: the singers Sing can sing with. */
import { defaultBrainClient } from './client';

export interface SingerInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Where the voice came from (and its licence). */
  readonly source: string;
  /** The singer's voice reference, to listen to. */
  readonly previewUrl: string;
}

export const singersQueryKey = ['singers'] as const;

export const singersApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ singers: SingerInfo[] }>('/api/singers', { signal }),
};
