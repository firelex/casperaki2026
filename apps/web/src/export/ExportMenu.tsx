import { useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@teamsuzie/ui';

export interface ExportItem {
  readonly label: string;
  readonly hint?: string;
  /** Make and download the file; report progress (0..1) when it takes a while. */
  run(progress: (share: number) => void): Promise<void>;
}

/** "Export ▾" for a window (a pattern, a whole track): each item makes a file and downloads it. */
export function ExportMenu({ items }: { items: readonly ExportItem[] }) {
  const [state, setState] = useState<{ label: string; share: number } | { error: string } | undefined>(undefined);
  const busy = state !== undefined && 'label' in state;
  const run = async (item: ExportItem) => {
    setState({ label: item.label, share: 0 });
    try {
      await item.run((share) => setState({ label: item.label, share }));
      setState(undefined);
    } catch (err) {
      setState({ error: `${item.label} failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const cls = 'cursor-pointer rounded-[6px] px-3 py-2 text-[13px] outline-none data-[highlighted]:bg-white/10 data-[disabled]:opacity-40';
  return (
    <span className="flex items-center gap-2">
      {state && 'error' in state ? (
        <span className="max-w-[260px] truncate text-[12px] text-err" title={state.error}>
          {state.error}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className="h-8 rounded-full border border-white/25 px-3.5 text-[13px] font-semibold text-white outline-none hover:border-white/60 disabled:opacity-60"
        >
          {busy ? `${state.label}${state.share > 0 ? ` ${Math.round(state.share * 100)}%` : '…'}` : 'Export ▾'}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="z-[60] min-w-[240px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
          {items.map((it) => (
            <DropdownMenuItem key={it.label} className={cls} onSelect={() => void run(it)}>
              {it.label}
              {it.hint ? <span className="ml-auto pl-4 text-[11px] text-white/45">{it.hint}</span> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
