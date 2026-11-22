import { defaultBrainClient } from './client';

export type DawFormat = 'stems' | 'reaper' | 'logic';

export interface DawExportStatus {
  readonly id: string;
  readonly songId: string;
  readonly format: DawFormat;
  readonly state: 'queued' | 'lowering' | 'mixing' | 'stems' | 'packaging' | 'done' | 'failed';
  readonly stemsDone: number;
  readonly stemsTotal: number;
  readonly fileName?: string;
  readonly error?: string;
  readonly downloadUrl?: string;
}

export interface DawExportRequest {
  readonly format: DawFormat;
  /** Instrument lanes to include (empty: all). */
  readonly tracks: readonly string[];
  readonly midi?: { readonly song?: string; readonly tracks?: Readonly<Record<string, string>> };
  readonly colors?: Readonly<Record<string, string>>;
}

export const dawExportApi = {
  start: (songId: string, body: DawExportRequest) =>
    defaultBrainClient.post<DawExportStatus>(`/api/songs/${encodeURIComponent(songId)}/daw-export`, body),
  status: (jobId: string, signal?: AbortSignal) =>
    defaultBrainClient.get<DawExportStatus>(`/api/daw-exports/${encodeURIComponent(jobId)}`, { signal }),
};

/** Human description of a job's progress. */
export function dawExportLabel(s: DawExportStatus): string {
  switch (s.state) {
    case 'queued':
      return 'Starting…';
    case 'lowering':
      return 'Preparing the song…';
    case 'mixing':
      return 'Rendering the reference mix…';
    case 'stems':
      return `Rendering tracks ${s.stemsDone}/${s.stemsTotal}…`;
    case 'packaging':
      return 'Packing the zip…';
    case 'done':
      return 'Ready';
    case 'failed':
      return `Failed: ${s.error ?? 'unknown error'}`;
  }
}
