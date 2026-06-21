import type { ReactNode } from 'react';

/**
 * Small label-over-value primitive used in forms and metadata grids.
 *
 * Uses uppercase labels in the muted-blue color from rory-fe, then puts
 * the value on a mono baseline so engineering data (ids, hashes, BPM)
 * stays readable.
 */
export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
        {label}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-dim leading-tight">{hint}</span> : null}
    </label>
  );
}

export function FieldDisplay({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
        {label}
      </span>
      <span className={mono ? 'font-mono text-[13px] text-fg' : 'text-[13px] text-fg'}>
        {value}
      </span>
    </div>
  );
}
