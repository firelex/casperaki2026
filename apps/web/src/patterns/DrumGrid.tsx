import type { DrumBlueprint } from '../api/patterns';

/** Kit order and what each lane is called. */
const LANES: ReadonlyArray<[string, string]> = [
  ['crash1', 'Crash'],
  ['crash2', 'Crash 2'],
  ['ride', 'Ride'],
  ['hiHatOpen', 'Open hat'],
  ['hiHatClosed1', 'Closed hat'],
  ['hiHatClosed2', 'Closed hat 2'],
  ['shaker', 'Shaker'],
  ['snap', 'Snap'],
  ['clap', 'Clap'],
  ['snareDrum1', 'Snare'],
  ['snareDrum2', 'Snare 2'],
  ['tom1', 'High tom'],
  ['tom2', 'Mid tom'],
  ['tom3', 'Low tom'],
  ['bassDrum1', 'Kick'],
  ['bassDrum2', 'Kick 2'],
];
const SLOTS_PER_BEAT = 8; // 32nd notes

/**
 * A drum pattern drawn as a step grid: one row per drum, columns in 32nd
 * notes, beat lines every 8 slots and a stronger line at each bar.
 */
export function DrumGrid({ blueprint }: { blueprint: DrumBlueprint }) {
  const lastBeat = Math.max(...Object.values(blueprint).flat());
  const beats = Math.max(8, Math.ceil((lastBeat + 0.01) / 4) * 4);
  const slots = beats * SLOTS_PER_BEAT;
  const rows = LANES.filter(([lane]) => blueprint[lane]?.length);
  const unknown = Object.keys(blueprint).filter((l) => !LANES.some(([k]) => k === l));
  if (unknown.length) throw new Error(`DrumGrid: no label for lane(s) ${unknown.join(', ')}`);

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid min-w-full gap-y-[3px]" style={{ gridTemplateColumns: '92px 1fr' }}>
        {rows.map(([lane, label]) => {
          const hits = new Set(blueprint[lane]!.map((b) => Math.round(b * SLOTS_PER_BEAT)));
          return (
            <div key={lane} className="contents">
              <span className="pr-3 text-right text-[12px] leading-[18px] text-white/60">{label}</span>
              <div className="flex h-[18px] min-w-[520px]">
                {Array.from({ length: slots }, (_, s) => {
                  const hit = hits.has(s);
                  const onSixteenth = s % 2 === 0;
                  const barLine = s % (4 * SLOTS_PER_BEAT) === 0;
                  const beatLine = s % SLOTS_PER_BEAT === 0;
                  return (
                    <span
                      key={s}
                      className={`flex-1 ${barLine ? 'border-l border-white/40' : beatLine ? 'border-l border-white/15' : ''}`}
                      style={{
                        background: hit
                          ? onSixteenth
                            ? 'var(--color-c0)'
                            : 'color-mix(in srgb, var(--color-c0) 60%, transparent)'
                          : onSixteenth && Math.floor(s / SLOTS_PER_BEAT) % 2 === 0
                            ? 'rgba(255,255,255,0.05)'
                            : 'rgba(255,255,255,0.025)',
                        margin: hit ? '0 1px' : undefined,
                        borderRadius: hit ? 2 : undefined,
                      }}
                      title={hit ? `${label} at beat ${(s / SLOTS_PER_BEAT + 1).toFixed(3).replace(/\.?0+$/u, '')}` : undefined}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
