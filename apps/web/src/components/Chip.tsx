import type { ReactNode } from 'react';

/**
 * Compact tag used for status, family labels, kit slots, etc.
 */
export interface ChipProps {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'accent' | 'cyan' | 'lime' | 'magenta' | 'yellow' | 'ok' | 'warn' | 'err';
  readonly mono?: boolean;
  readonly title?: string;
}

const TONES: Record<NonNullable<ChipProps['tone']>, string> = {
  neutral: 'bg-panel-2 text-muted border border-line',
  accent: 'bg-accent/15 text-accent border border-accent/40',
  cyan: 'bg-cyan/15 text-cyan border border-cyan/40',
  lime: 'bg-lime/15 text-lime border border-lime/40',
  magenta: 'bg-magenta/15 text-magenta border border-magenta/40',
  yellow: 'bg-yellow/15 text-yellow border border-yellow/40',
  ok: 'bg-ok/15 text-ok border border-ok/40',
  warn: 'bg-warn/15 text-warn border border-warn/40',
  err: 'bg-err/15 text-err border border-err/40',
};

export function Chip({ children, tone = 'neutral', mono = false, title }: ChipProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] uppercase tracking-wide ${
        mono ? 'font-mono' : 'font-semibold'
      } ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
