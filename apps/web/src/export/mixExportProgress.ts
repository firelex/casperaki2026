import type { MixExportPhase, MixExportProgress } from '../audio/livePlayer';

/** Each phase's share of the whole job (rendering dominates). */
const PHASES: readonly { phase: MixExportPhase; weight: number; label: string }[] = [
  { phase: 'render', weight: 0.7, label: 'Rendering the song' },
  { phase: 'master', weight: 0.06, label: 'Mastering' },
  { phase: 'mp3 unmastered', weight: 0.12, label: 'Encoding the unmastered MP3' },
  { phase: 'mp3 mastered', weight: 0.12, label: 'Encoding the mastered MP3' },
];

/** The whole job's progress (0..1) and what to call the current step. */
export function mixExportStatus(p: MixExportProgress): { share: number; label: string } {
  let before = 0;
  for (const ph of PHASES) {
    if (ph.phase === p.phase) {
      const share = Math.min(1, Math.max(0, before + ph.weight * Math.min(1, Math.max(0, p.share))));
      return { share, label: ph.label };
    }
    before += ph.weight;
  }
  throw new Error(`unknown mix export phase ${p.phase}`);
}
