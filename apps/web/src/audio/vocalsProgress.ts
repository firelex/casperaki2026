import { useSyncExternalStore } from 'react';

/** What singing the vocals before Play is doing: a progress line, or the error that stopped it. */
export interface VocalsProgress {
  readonly text?: string;
  readonly error?: string;
}

let state: VocalsProgress = {};
const listeners = new Set<() => void>();

export const vocalsProgress = {
  set(next: VocalsProgress): void {
    state = next;
    for (const l of listeners) l();
  },
  get: (): VocalsProgress => state,
};

export function useVocalsProgress(): VocalsProgress {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
