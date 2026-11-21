import { HERO_LANES, HERO_SECTIONS, noteHeights } from './arrangement';

/**
 * The hero's arrangement: section strip on top, one row per instrument
 * with its public sound name, blocks where the instrument plays. On load
 * a red playhead sweeps once across and the blocks appear as it passes
 * (CSS only; skipped under prefers-reduced-motion).
 */
export function ArrangementHero() {
  return (
    <div className="landing-arrangement" aria-label="An arranged song: nine sections, five instruments, each a named sound you can swap">
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[168px_minmax(0,1fr)] gap-x-4">
        <div className="hidden md:block" />
        <SectionStrip />
        {HERO_LANES.map((lane, li) => (
          <LaneRow key={lane.role} laneIndex={li} />
        ))}
      </div>
      <div className="landing-playhead" aria-hidden="true" />
    </div>
  );
}

function SectionStrip() {
  return (
    <div className="flex gap-[3px] mb-2" aria-hidden="true">
      {HERO_SECTIONS.map((s, i) => (
        <div
          key={i}
          className="min-w-0 pt-2 border-t-[3px] text-[12px] text-white/60 truncate landing-reveal"
          style={{ flexGrow: s.bars, flexBasis: 0, borderColor: s.color, ['--i' as string]: i }}
        >
          {s.bars >= 8 || i === 0 ? s.name : ''}
        </div>
      ))}
    </div>
  );
}

function LaneRow({ laneIndex }: { laneIndex: number }) {
  const lane = HERO_LANES[laneIndex]!;
  return (
    <>
      <div className="flex md:flex-col justify-between md:justify-center gap-2 md:gap-0 pt-3 md:pt-0 md:h-[52px]">
        <span className="text-[15px] text-white leading-tight">{lane.sound}</span>
        <span className="landing-narrow text-[13px] text-white/45 leading-tight">{lane.role}</span>
      </div>
      <div className="flex gap-[3px] h-[34px] md:h-[52px] py-[5px]" aria-hidden="true">
        {HERO_SECTIONS.map((s, si) => {
          const plays = lane.plays.includes(si);
          return (
            <div
              key={si}
              className="min-w-0 rounded-[3px] landing-reveal"
              style={{
                flexGrow: s.bars,
                flexBasis: 0,
                ['--i' as string]: si,
                background: plays ? `color-mix(in srgb, ${lane.color} 16%, transparent)` : 'rgba(255,255,255,0.025)',
                boxShadow: plays ? `inset 2px 0 0 ${lane.color}` : undefined,
              }}
            >
              {plays ? <Notes laneIndex={laneIndex} sectionIndex={si} bars={s.bars} density={lane.density} color={lane.color} /> : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Notes({
  laneIndex,
  sectionIndex,
  bars,
  density,
  color,
}: {
  laneIndex: number;
  sectionIndex: number;
  bars: number;
  density: number;
  color: string;
}) {
  const count = bars * density;
  const heights = noteHeights(laneIndex, sectionIndex, count);
  return (
    <div className="flex items-end h-full gap-[2px] px-[4px] py-[4px]">
      {heights.map((h, i) => (
        <span
          key={i}
          className="flex-1 rounded-[1px]"
          style={{ height: `${Math.round(h * 100)}%`, background: color, opacity: 0.75 }}
        />
      ))}
    </div>
  );
}
