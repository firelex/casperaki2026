import type { MasteringMode } from './livePlayer';

/** The status bar's words for how the playing song is mastered. */
export function masteringLabel(mode: MasteringMode, error: string | undefined): { text: string; failed: boolean } {
  switch (mode) {
    case 'stand-in':
      return { text: 'Quick master', failed: false };
    case 'analysing':
      return { text: 'Quick master (matching the export master…)', failed: false };
    case 'matched':
      return { text: 'Mastered as exported', failed: false };
    case 'failed':
      return { text: `Matching the master failed: ${error ?? 'unknown error'} (quick master plays)`, failed: true };
  }
}
