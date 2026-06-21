import type { ReactNode } from 'react';

/**
 * Workbench panel — a single dense card. Used as the structural unit of
 * the workbench grid so the same chrome (title bar, accent dot, footer
 * meta) reads identically across inspectors.
 */
export interface PanelProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly accent?: 'accent' | 'cyan' | 'lime' | 'magenta' | 'yellow' | 'dim';
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly dense?: boolean;
  readonly className?: string;
}

const ACCENT_COLOR: Record<NonNullable<PanelProps['accent']>, string> = {
  accent: 'bg-accent',
  cyan: 'bg-cyan',
  lime: 'bg-lime',
  magenta: 'bg-magenta',
  yellow: 'bg-yellow',
  dim: 'bg-dim',
};

export function Panel({
  title,
  subtitle,
  accent = 'dim',
  actions,
  footer,
  children,
  dense = false,
  className = '',
}: PanelProps) {
  return (
    <section
      className={`flex flex-col rounded-md border border-line bg-panel overflow-hidden ${className}`}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line bg-panel-2/60">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${ACCENT_COLOR[accent]}`}
            aria-hidden="true"
          />
          <h2 className="text-[13px] font-semibold tracking-wide uppercase text-fg/90 truncate">
            {title}
          </h2>
          {subtitle ? (
            <span className="text-[12px] text-muted truncate">{subtitle}</span>
          ) : null}
        </div>
        {actions ? <div className="shrink-0 flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={`flex-1 min-h-0 ${dense ? 'p-3' : 'p-4'} text-[13px]`}>{children}</div>
      {footer ? (
        <footer className="px-4 py-2 text-[12px] text-muted border-t border-line bg-panel-2/40">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
