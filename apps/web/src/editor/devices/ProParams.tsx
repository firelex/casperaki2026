import { logical4Settings } from './Logical4Panel';
import { DEVICES } from './deviceDefs';

/** Logical4's controls in its own units (Logical4Panel shows them as a device). */
const LOGICAL4 = [
  { name: 'Threshold', display: (p: readonly number[]) => `${logical4Settings(p).thresholdDb.toFixed(1)} dB` },
  { name: 'Ratio', display: (p: readonly number[]) => `${logical4Settings(p).ratio.toFixed(1)}:1` },
  { name: 'Speed', display: (p: readonly number[]) => `${logical4Settings(p).speedMs.toFixed(0)} ms` },
  { name: 'Makeup gain', display: (p: readonly number[]) => `${logical4Settings(p).makeupDb.toFixed(1)} dB` },
  { name: 'Dry / wet', display: (p: readonly number[]) => logical4Settings(p).dryWet.toFixed(2) },
] as const;

/** A plugin parameter's name and how one value of it reads, in the plugin's units. */
export function describeParam(factory: string, index: number): { name: string; display: (v: number) => string } {
  if (factory === 'makeLogical4') {
    const c = LOGICAL4[index];
    if (!c) throw new Error(`Logical4 has no parameter ${index}`);
    return { name: c.name, display: (v) => c.display(Array.from({ length: 5 }, (_, i) => (i === index ? v : 0))) };
  }
  const d = DEVICES[factory]?.params[index];
  if (!d) throw new Error(`${factory} has no described parameter ${index}`);
  return { name: d.name, display: (v) => d.display(v) };
}

/** A plugin's display name ("makeKPlateD" -> its device title). */
export function pluginTitle(factory: string): string {
  return factory === 'makeLogical4' ? 'Logical4' : (DEVICES[factory]?.title ?? factory.replace(/^make/u, ''));
}

/**
 * Pro mode: a slider per parameter of a bus plugin, labelled in the plugin's own
 * units. Changes play at once and are saved with the song.
 */
export function ProParams({
  factory,
  params,
  standard,
  onChange,
}: {
  factory: string;
  /** The current values (raw 0..1). */
  params: readonly number[];
  /** The standard mix's values, to mark what changed. */
  standard: readonly number[];
  onChange: (index: number, value: number) => void;
}) {
  const names =
    factory === 'makeLogical4'
      ? LOGICAL4.map((c) => ({ name: c.name, show: () => c.display(params) }))
      : (DEVICES[factory]?.params ?? []).map((d, i) => ({ name: d.name, show: () => d.display(params[i] ?? 0) }));
  if (params.length === 0) return <p className="border-t border-black/70 px-4 py-3 text-[12px] text-[#9a9ba3]">This plugin has no settings to change.</p>;
  if (names.length !== params.length) {
    throw new Error(`ProParams: ${factory} has ${params.length} parameters but ${names.length} are described`);
  }
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-black/70 bg-[#1c1d21] px-4 py-3">
      <div className="col-span-2 text-[11px] font-semibold text-[#ffb347]">Pro settings</div>
      {names.map((n, i) => {
        const changed = Math.abs((params[i] ?? 0) - (standard[i] ?? 0)) > 1e-6;
        return (
          <label key={n.name} className="flex items-center gap-2 text-[11px]">
            <span className={`w-[92px] shrink-0 truncate ${changed ? 'text-[#ffb347]' : 'text-[#c4c5cb]'}`} title={n.name}>
              {n.name}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={params[i] ?? 0}
              onChange={(e) => onChange(i, Number(e.target.value))}
              onDoubleClick={() => onChange(i, standard[i] ?? 0)}
              className="min-w-0 flex-1 accent-[#ffb347]"
              aria-label={n.name}
              title="Double-click for the standard value"
            />
            <span className={`w-[64px] shrink-0 text-right font-mono ${changed ? 'text-[#ffb347]' : 'text-[#dfe0e4]'}`}>{n.show()}</span>
          </label>
        );
      })}
    </div>
  );
}
