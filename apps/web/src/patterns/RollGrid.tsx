const SLOTS_PER_BEAT = 4; // 16th notes

export interface RollRow {
  readonly key: string | number;
  readonly label: string;
  readonly notes: ReadonlyArray<{ readonly pos: number; readonly len: number; readonly title: string }>;
}

/**
 * A small piano roll: labelled rows (top row first), 16th-note columns, beat
 * and bar lines, each note a bar from its start for its length.
 */
export function RollGrid({ rows, beats }: { rows: readonly RollRow[]; beats: number }) {
  const slots = beats * SLOTS_PER_BEAT;
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid min-w-full gap-y-[3px]" style={{ gridTemplateColumns: '92px 1fr' }}>
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <span className="pr-3 text-right text-[12px] leading-[18px] text-white/60">{row.label}</span>
            <div className="relative h-[18px] min-w-[520px]">
              {Array.from({ length: slots }, (_, s) => (
                <span
                  key={s}
                  className={`absolute top-0 h-full ${s % (4 * SLOTS_PER_BEAT) === 0 ? 'border-l border-white/40' : s % SLOTS_PER_BEAT === 0 ? 'border-l border-white/15' : ''}`}
                  style={{
                    left: `${(s / slots) * 100}%`,
                    width: `${100 / slots}%`,
                    background: Math.floor(s / SLOTS_PER_BEAT) % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                  }}
                />
              ))}
              {row.notes.map((n, i) => (
                <span
                  key={i}
                  className="absolute top-[2px] h-[14px] rounded-[3px]"
                  style={{
                    left: `${(n.pos / beats) * 100}%`,
                    width: `calc(${(Math.min(n.len, beats - n.pos) / beats) * 100}% - 2px)`,
                    background: 'var(--color-c1)',
                  }}
                  title={n.title}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
