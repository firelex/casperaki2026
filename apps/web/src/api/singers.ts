/**
 * Brain `singers` API — matches `apps/brain/src/routes/singers.ts`: the singers Sing can sing with (the built-in
 * ones, then the user's own), adding a singer from a recording, and deleting one of the user's own.
 */
import type { BackgroundTask } from './tasks';
import { BrainError, defaultBrainClient, type BrainErrorBody } from './client';

/** How an added singer's voice reference was chosen. */
export type ReferenceChoice = 'beginning' | 'best';
export const REFERENCE_LABELS: Readonly<Record<ReferenceChoice, string>> = { beginning: 'The beginning', best: 'The best stretch' };
export const REFERENCE_HINTS: Readonly<Record<ReferenceChoice, string>> = {
  beginning: 'the first 8 to 12 seconds of singing, ending at a pause',
  best: 'the 8 to 12 seconds of the most continuous singing anywhere in the recording, ending at a pause',
};

export interface SingerReference {
  readonly choice: ReferenceChoice;
  /** In the voice once its silences are cut. */
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** In the recording as uploaded. */
  readonly recordingStartSeconds: number;
  readonly recordingEndSeconds: number;
  readonly seconds: number;
}

export interface SingerInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Where the voice came from (and its licence). */
  readonly source: string;
  /** The singer's voice reference, to listen to. */
  readonly previewUrl: string;
  /** One the user added from their own recording (only they see it). */
  readonly own: boolean;
  /** Own singers: a short line sung in the new voice. */
  readonly testLineUrl?: string;
  readonly reference?: SingerReference;
  /** Own singers: how the voice reference was transcribed (its words, or "la la la"). */
  readonly transcription?: 'words' | 'la';
}

/** What the Add a singer form sends. */
export interface AddSingerForm {
  readonly file: File | undefined;
  readonly name: string;
  readonly description: string;
  readonly rightToUse: boolean;
  /** The file is a full song: separate its vocals first. */
  readonly fullSong: boolean;
  readonly reference: ReferenceChoice | undefined;
}

export const MAX_RECORDING_MINUTES = 5;

/** The file's extension (lowercase), or undefined when its name has none. */
export function extensionOf(name: string): string | undefined {
  const m = /\.([a-z0-9]{1,8})$/iu.exec(name);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Why the form cannot be sent yet (in words for the user), or undefined when it can. */
export function addSingerProblem(f: AddSingerForm): string | undefined {
  if (!f.file) return 'Choose a recording.';
  if (!extensionOf(f.file.name)) return 'Choose a file whose name ends in its type (for example .wav or .mp3).';
  if (!f.name.trim()) return 'Give the singer a name.';
  if (!f.description.trim()) return 'Describe the voice.';
  if (!f.reference) return 'Choose how the voice reference is picked.';
  if (!f.rightToUse) return 'Tick "I have the right to use this voice".';
  return undefined;
}

/** Where an added singer's voice reference came from, in words. */
export function referenceText(r: SingerReference): string {
  const at = (s: number) => `${s.toFixed(1)} s`;
  return `${REFERENCE_LABELS[r.choice]}: ${r.seconds.toFixed(1)} s, from ${at(r.recordingStartSeconds)} to ${at(r.recordingEndSeconds)} of the recording`;
}

export const singersQueryKey = ['singers'] as const;

export const singersApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ singers: SingerInfo[] }>('/api/singers', { signal }),
  /** Starts Add a singer: the recording goes as the request body, the rest in the query. */
  add: async (f: AddSingerForm, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<{ task: BackgroundTask }> => {
    const problem = addSingerProblem(f);
    if (problem) throw new Error(problem);
    const q = new URLSearchParams({
      name: f.name.trim(),
      description: f.description.trim(),
      rightToUse: f.rightToUse ? '1' : '0',
      fullSong: f.fullSong ? '1' : '0',
      reference: f.reference!,
      extension: extensionOf(f.file!.name)!,
    });
    const res = await fetchImpl(`/api/singers?${q}`, { method: 'POST', headers: { 'content-type': f.file!.type || 'application/octet-stream', accept: 'application/json' }, body: f.file! });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new BrainError(res.status, undefined, `Adding the singer failed (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = body as BrainErrorBody | undefined;
      throw new BrainError(res.status, err, err?.message ?? err?.error ?? `Adding the singer failed (${res.status})`);
    }
    return body as { task: BackgroundTask };
  },
  remove: (id: string) => defaultBrainClient.delete<{ deleted: string }>(`/api/singers/${encodeURIComponent(id)}`),
};
