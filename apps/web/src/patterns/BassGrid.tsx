import type { BassHit } from '../api/patterns';

const SLOTS_PER_BEAT = 4; // 16th notes
const INTERVAL_NAMES: Record<number, string> = {
  [-12]: 'Root −8va', [-7]: '4th below', [-5]: '5th below', 0: 'Root', 2: '2nd', 3: 'm3', 4: '3rd', 5: '4th', 7: '5th',
  9: '6th', 10: 'm7', 11: '7th', 12: 'Octave', 14: '9th', 17: '11th', 19: '5th +8va', 24: '2 octaves',
};

/**
 * A chord-relative bass pattern as a small piano roll: one row per interval
 * from the chord root (highest at the top), 16th-note columns, bar lines.
 */
export function BassGrid({ pattern }: { pattern: readonly BassHit[] }) {
  const end = Math.max(...pattern.map(([pos, len]) => pos + len));
  const beats = Math.max(8, Math.ceil(end / 4) * 4);
  const slots = beats * SLOTS_PER_BEAT;
  const intervals = [...new Set(pattern.map(([, , semi]) => semi))].sort((a, b) => b - a);
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid min-w-full gap-y-[3px]" style={{ gridTemplateColumns: '92px 1fr' }}>
        {intervals.map((semi) => (
          <div key={semi} className="contents">
            <span className="pr-3 text-right text-[12px] leading-[18px] text-white/60">
              {INTERVAL_NAMES[semi] ?? `${semi > 0 ? '+' : ''}${semi} st`}
            </span>
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
              {pattern
                .filter(([, , st]) => st === semi)
                .map(([pos, len], i) => (
                  <span
                    key={i}
                    className="absolute top-[2px] h-[14px] rounded-[3px]"
                    style={{
                      left: `${(pos / beats) * 100}%`,
                      width: `calc(${(len / beats) * 100}% - 2px)`,
                      background: 'var(--color-c1)',
                    }}
                    title={`${INTERVAL_NAMES[semi] ?? semi} at beat ${pos + 1}, ${len} beats`}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
