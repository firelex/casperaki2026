import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { SoundFamily, soundsApi } from '../../api/sounds';

const GROUPS = ['Instruments', 'Drum hits', 'Loops & breaks', 'FX'] as const;

export type SoundFamilies = Awaited<ReturnType<typeof soundsApi.families>>;

/** The library's sidebar: sound families by group, then the transition types; `children` below them. */
export function SoundFamiliesNav({
  families,
  family,
  onFamily,
  children,
}: {
  families: UseQueryResult<SoundFamilies>;
  family: string;
  onFamily(id: string): void;
  children?: ReactNode;
}) {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/70 bg-[#202124]">
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Sound families">
        {families.isError ? <p className="p-2 text-[12px] text-err">{families.error.message}</p> : null}
        {GROUPS.map((g) => {
          const fams = (families.data?.families ?? []).filter((f) => f.group === g);
          if (fams.length === 0) return null;
          return (
            <div key={g} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">{g.toUpperCase()}</div>
              {fams.map((f) => (
                <FamilyButton key={f.id} f={f} active={f.id === family} onClick={() => onFamily(f.id)} />
              ))}
            </div>
          );
        })}
        {families.data?.transitions.length ? (
          <div className="mb-3">
            <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">TRANSITIONS</div>
            {families.data.transitions.map((t) => (
              <FamilyButton
                key={t.type}
                f={{ id: `transition:${t.type}`, label: t.label, group: 'FX', count: t.count }}
                active={family === `transition:${t.type}`}
                onClick={() => onFamily(`transition:${t.type}`)}
              />
            ))}
          </div>
        ) : null}
        {children}
      </nav>
    </aside>
  );
}

function FamilyButton({ f, active, onClick }: { f: SoundFamily; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active ? 'bg-[#3a3c43] text-white' : 'text-white/75 hover:bg-white/6 hover:text-white'}`}
    >
      <span className="truncate">{f.label}</span>
      <span className="ml-2 font-mono text-[11px] text-white/40">{f.count.toLocaleString('en-GB')}</span>
    </button>
  );
}
