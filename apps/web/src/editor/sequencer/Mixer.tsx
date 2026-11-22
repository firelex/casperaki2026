import type { ReactNode } from 'react';

import { livePlayer, type LaneMeters, type MixConfigJson, type ResolvedMix, type ResolvedMixLane } from '../../audio/livePlayer';
import type { SeqTrack } from '../sequencerModel';

const STRIP_W = 104;
const FADER_H = 100;
/** Fader / meter scale, dB. */
const TOP_DB = 6;
const BOTTOM_DB = -60;
const SCALE_TICKS = [6, 0, -6, -12, -24, -40, -60];
/** Sends at or below this are off (the mix tables use -100 for "no send"). */
const SEND_OFF_DB = -90;

/** Return buses, in send order (reverb, delay, chorus), as named in mix-config rackChains. */
const RETURNS = [
  { key: 'reverb', bus: 'fxPlateReverb', name: 'Reverb' },
  { key: 'delay', bus: 'fxStereoDelay', name: 'Delay' },
  { key: 'chorus', bus: 'fxChorus', name: 'Chorus' },
] as const;

/**
 * The mixer, as in a DAW's mixer window: a channel strip per track, then the
 * reverb / delay / chorus returns and the master. Read-only: every value is
 * what the playback engine resolved for this version of the song (its FX
 * bus and that bus's plugin chain, send levels, target volume), so it also
 * shows how the brain's mix tables land. Meters show each track's level at
 * the playhead; M and S work live.
 */
export function Mixer({
  tracks,
  mix,
  meters,
  error,
  seconds,
  playing,
  muted,
  solo,
  soundNames,
  onOpenDevice,
}: {
  tracks: readonly SeqTrack[];
  /** The mix as the engine resolved it for this version. */
  mix: ResolvedMix | undefined;
  /** Per-track levels (for the meters), once measured. */
  meters: LaneMeters | undefined;
  /** Why the engine could not report the mix, if it failed. */
  error: string | undefined;
  seconds: number;
  playing: boolean;
  muted: readonly string[];
  solo: readonly string[];
  /** Public sound name per track. */
  soundNames: Readonly<Record<string, string>>;
  /** Open a plugin's device view. */
  onOpenDevice: (d: OpenDevice) => void;
}) {
  if (error) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-err">{error}</div>;
  }
  if (!mix) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[#9a9ba3]">Reading the mix from the engine…</div>;
  }
  if (!mix.mixEnabled) {
    return <div className="flex h-full items-center justify-center text-[12px] text-err">The engine ran without its mix: no buses or sends to show.</div>;
  }
  const chains = new Map(mix.config.rackChains.map((c) => [c.bus, c.plugins]));
  const byLane = new Map<string, ResolvedMixLane[]>();
  for (const l of mix.lanes) byLane.set(l.lane, [...(byLane.get(l.lane) ?? []), l]);
  const peakAt = (peaks: Float32Array | undefined): number | undefined => {
    if (!playing || !meters || !peaks || meters.binSec <= 0) return undefined;
    const bin = Math.floor(seconds / meters.binSec);
    let m = 0;
    for (let b = Math.max(0, bin - 3); b <= Math.min(peaks.length - 1, bin); b++) m = Math.max(m, peaks[b]!);
    return m;
  };
  const levelOf = (lane: string) => peakAt(meters?.peaks[meters.names.indexOf(lane)]);
  /** Bus meters: 0..2 the returns in RETURNS order, 3 the master. */
  const busLevel = (bus: number) => peakAt(meters?.busPeaks[bus]);
  // Strips in track order, then any engine lane without a track row (e.g. transitions).
  const laneOrder = [...tracks.map((t) => t.name).filter((n) => byLane.has(n)), ...[...byLane.keys()].filter((n) => !tracks.some((t) => t.name === n))];

  return (
    // Strips keep their natural height (every insert listed); a lower mixer
    // scrolls instead of squashing them, a taller one adds room above the faders.
    <div className="h-full min-h-0 overflow-auto bg-[#202124]">
      {/* All strips as tall as the tallest, so their faders line up. */}
      <div className="flex min-h-full w-max items-stretch">
      {laneOrder.map((lane) => (
        <ChannelStrip
          key={lane}
          name={lane}
          color={tracks.find((t) => t.name === lane)?.color ?? '#8a8b93'}
          parts={byLane.get(lane)!}
          soundName={soundNames[lane]}
          onOpenDevice={onOpenDevice}
          chains={chains}
          level={levelOf(lane)}
          muted={muted.includes(lane)}
          soloed={solo.includes(lane)}
          anySolo={solo.length > 0}
        />
      ))}
      <div className="w-2 shrink-0 bg-black/40" aria-hidden="true" />
      {RETURNS.map((r, k) => (
        <BusStrip key={r.bus} name={r.name} bus={r.bus} subtitle="Return" plugins={chains.get(r.bus)} color="#3d8bd0" level={busLevel(k)} onOpenDevice={onOpenDevice} />
      ))}
      <BusStrip
        name="Master"
        bus="master"
        onOpenDevice={onOpenDevice}
        subtitle="Stereo out"
        plugins={chains.get('master')}
        color="#e0322b"
        volumeDb={mix.config.constants.masterVolumeDb}
        level={busLevel(3)}
      />
      </div>
    </div>
  );
}

function ChannelStrip({
  name,
  color,
  parts,
  soundName,
  onOpenDevice,
  chains,
  level,
  muted,
  soloed,
  anySolo,
}: {
  name: string;
  color: string;
  parts: readonly ResolvedMixLane[];
  soundName: string | undefined;
  onOpenDevice: (d: OpenDevice) => void;
  chains: Map<string, MixConfigJson['rackChains'][number]['plugins']>;
  level: number | undefined;
  muted: boolean;
  soloed: boolean;
  anySolo: boolean;
}) {
  const buses = [...new Set(parts.map((p) => p.fxGroup))];
  const types = [...new Set(parts.map((p) => p.lowLevelType).filter(Boolean))];
  const volumes = parts.map((p) => p.volumeDb).filter((v): v is number => v !== null);
  const volume = volumes.length && volumes.every((v) => v === volumes[0]) ? volumes[0] : undefined;
  const tip = parts
    .map((p) => `${p.track}: ${p.lowLevelType || 'no type'} → ${p.fxGroup} bus, volume ${fmtDb(p.volumeDb)}, sends R ${fmtDb(p.sendsDb.reverb)} D ${fmtDb(p.sendsDb.delay)} C ${fmtDb(p.sendsDb.chorus)}`)
    .join('\n');
  return (
    <Strip
      color={color}
      name={name}
      subtitle={soundName ?? (types.length === 1 ? types[0]! : types.length ? `${types.length} sound types` : '—')}
      title={`${soundName ? `Sound: ${soundName}\n` : ''}${tip}`}
      bottom={
        <>
          <Section label="Sends">
            {RETURNS.map((r) => (
              <SendRow key={r.key} name={r.name} values={parts.map((p) => p.sendsDb[r.key])} />
            ))}
          </Section>
          <FaderBlock volumeDb={volume} volumeNote={volumes.length > 1 && volume === undefined ? 'per part' : volumes.length === 0 ? 'none' : undefined} level={level} />
          <div className="mt-1 flex justify-center gap-1">
            <button
              type="button"
              onClick={() => livePlayer.setMuted(name, !muted)}
              aria-pressed={muted}
              aria-label={`${muted ? 'Unmute' : 'Mute'} ${name}`}
              className={`h-5 w-7 rounded-[3px] border border-black/60 text-[10px] font-bold ${muted ? 'bg-yellow-400 text-black' : anySolo && !soloed ? 'bg-[#2b2c31] text-white/30' : 'bg-[#3a3c42] text-[#d9dade]'}`}
            >
              M
            </button>
            <button
              type="button"
              onClick={() => livePlayer.setSolo(name, !soloed)}
              aria-pressed={soloed}
              aria-label={`${soloed ? 'Unsolo' : 'Solo'} ${name}`}
              className={`h-5 w-7 rounded-[3px] border border-black/60 text-[10px] font-bold ${soloed ? 'bg-emerald-400 text-black' : 'bg-[#3a3c42] text-[#d9dade]'}`}
            >
              S
            </button>
          </div>
        </>
      }
    >
      <Section label="Inserts">
        {buses.map((bus) => (
          <div key={bus} className="mb-1">
            <div className="mb-0.5 truncate text-[9px] text-[#8f9098]">→ {bus} bus</div>
            <Inserts plugins={chains.get(bus)} bus={bus} onOpen={onOpenDevice} />
          </div>
        ))}
      </Section>
    </Strip>
  );
}

function BusStrip({
  name,
  bus,
  onOpenDevice,
  subtitle,
  plugins,
  color,
  volumeDb,
  level,
}: {
  name: string;
  /** The bus's name in the mix config ("master", "fxPlateReverb", …). */
  bus: string;
  onOpenDevice: (d: OpenDevice) => void;
  subtitle: string;
  plugins: MixConfigJson['rackChains'][number]['plugins'] | undefined;
  color: string;
  volumeDb?: number;
  /** Peak at the playhead (after the bus's rack), while playing. */
  level: number | undefined;
}) {
  return (
    <Strip
      color={color}
      name={name}
      subtitle={subtitle}
      bottom={
        <>
          <div className="mb-1.5 h-[52px]" aria-hidden="true" />
          <FaderBlock volumeDb={volumeDb ?? 0} volumeNote={volumeDb === undefined ? 'unity' : undefined} level={level} />
          <div className="mt-1 h-5" />
        </>
      }
    >
      <Section label="Inserts">
        <Inserts plugins={plugins} bus={bus} onOpen={onOpenDevice} />
      </Section>
    </Strip>
  );
}

function Strip({
  color,
  name,
  subtitle,
  title,
  children,
  bottom,
}: {
  color: string;
  name: string;
  subtitle: string;
  title?: string;
  /** Inserts and sends: scroll when they don't fit. */
  children: ReactNode;
  /** Fader section: fixed at the foot, level with the other strips. */
  bottom: ReactNode;
}) {
  return (
    <div
      className="flex min-h-full shrink-0 flex-col border-r border-black/60 bg-gradient-to-b from-[#2e2f34] to-[#26272b] px-1.5 pb-1 pt-1.5"
      style={{ width: STRIP_W }}
      title={title}
    >
      <div className="flex-1">{children}</div>
      <div className="shrink-0 border-t border-black/40 pt-1">{bottom}</div>
      {/* Name plate, as at the foot of a console strip. */}
      <div className="mt-1 rounded-[3px] border border-black/60 px-1 py-0.5" style={{ background: `color-mix(in srgb, ${color} 55%, #1d1e21)` }}>
        <div className="truncate text-center text-[11px] font-semibold text-white" title={name}>
          {name}
        </div>
        <div className="truncate text-center text-[9px] text-white/70" title={subtitle}>
          {subtitle}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="mb-0.5 text-[9px] font-semibold text-[#8f9098]">{label}</div>
      {children}
    </div>
  );
}

/** Insert slots: the bus's plugin chain, parameters on hover. */
/** Plugins that have a device view so far. */
const DEVICE_VIEWS = new Set(['makeLogical4']);

export interface OpenDevice {
  readonly bus: string;
  readonly slot: number;
  readonly factory: string;
  readonly params: readonly number[];
}

function Inserts({
  plugins,
  bus,
  onOpen,
}: {
  plugins: MixConfigJson['rackChains'][number]['plugins'] | undefined;
  bus: string;
  onOpen?: (d: OpenDevice) => void;
}) {
  if (!plugins) return <div className="text-[9px] text-err">No rack for {bus}</div>;
  return (
    <div className="flex flex-col gap-[2px]">
      {plugins.map((p, i) => {
        const openable = onOpen && DEVICE_VIEWS.has(p.factory);
        const tip = `${pluginName(p.factory)}${p.params.length ? `\nparameters: ${p.params.map((v) => v.toFixed(3)).join(', ')}` : ''}${openable ? '\nClick to open' : ''}`;
        const cls = 'truncate rounded-[2px] border border-black/60 bg-gradient-to-b px-1 text-left text-[9.5px] leading-[15px] text-[#dfe9f5]';
        return openable ? (
          <button
            key={i}
            type="button"
            onClick={() => onOpen({ bus, slot: i, factory: p.factory, params: p.params })}
            className={`${cls} from-[#4e7aa6] to-[#3a5e83] hover:from-[#5d8bb8] hover:text-white`}
            title={tip}
          >
            {pluginName(p.factory)} ↗
          </button>
        ) : (
          <div key={i} className={`${cls} from-[#3f5a78] to-[#30475f]`} title={tip}>
            {pluginName(p.factory)}
          </div>
        );
      })}
    </div>
  );
}

/** One send: level bar and dB. Several parts with different levels show "varies". */
function SendRow({ name, values }: { name: string; values: readonly (number | null)[] }) {
  const known = values.filter((v): v is number => v !== null);
  const same = known.length > 0 && known.every((v) => v === known[0]);
  const db = same ? known[0]! : undefined;
  const on = db !== undefined && db > SEND_OFF_DB;
  const frac = on ? Math.max(0, Math.min(1, (db + 40) / 46)) : 0;
  return (
    <div className="mb-[3px] flex items-center gap-1" title={`${name} send: ${known.length ? values.map(fmtDb).join(' / ') : 'not resolved'}`}>
      <span className="w-[26px] shrink-0 text-[9px] text-[#a9aab1]">{name.slice(0, 3)}</span>
      <span className="relative h-[6px] flex-1 overflow-hidden rounded-full bg-black/50">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[#6fb3ff]" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className={`w-[30px] shrink-0 text-right font-mono text-[9px] ${on ? 'text-[#dfe9f5]' : 'text-[#6d6e75]'}`}>
        {db === undefined ? (known.length ? 'var' : '—') : fmtDb(db)}
      </span>
    </div>
  );
}

/** Fader (at the resolved volume) beside a level meter, with the dB scale. */
function FaderBlock({ volumeDb, volumeNote, level }: { volumeDb: number | undefined; volumeNote?: string; level: number | undefined }) {
  const y = (db: number) => (1 - (Math.max(BOTTOM_DB, Math.min(TOP_DB, db)) - BOTTOM_DB) / (TOP_DB - BOTTOM_DB)) * FADER_H;
  const levelDb = level !== undefined && level > 0 ? 20 * Math.log10(level) : undefined;
  return (
    <div className="mt-1">
      <div className="relative mx-auto flex justify-center gap-2" style={{ height: FADER_H }}>
        {/* Scale. */}
        <div className="relative w-[18px]">
          {SCALE_TICKS.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 font-mono text-[8px] text-[#7d7e86]" style={{ top: y(t) }}>
              {t > 0 ? `+${t}` : t}
            </span>
          ))}
        </div>
        {/* Fader track and cap. */}
        <div className="relative w-[14px]">
          <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-black/70" />
          {volumeDb !== undefined ? (
            <span
              className="absolute left-1/2 h-[18px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-[3px] border border-black/70 bg-gradient-to-b from-[#d4d5da] via-[#9fa1a8] to-[#c9cad0] shadow-[0_2px_3px_rgba(0,0,0,0.5)]"
              style={{ top: y(volumeDb) }}
            >
              <span className="absolute inset-x-[3px] top-1/2 h-px bg-black/60" />
            </span>
          ) : null}
        </div>
        {/* Meter. */}
        <div className="relative w-[7px] overflow-hidden rounded-[2px] bg-black/70">
          {levelDb !== undefined ? (
            <span
              className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-emerald-500 via-yellow-300 to-red-500"
              style={{ top: y(levelDb), backgroundSize: `100% ${FADER_H}px`, backgroundPosition: 'bottom' }}
            />
          ) : null}
        </div>
      </div>
      <div className="mt-1 text-center font-mono text-[10px] text-[#dfe0e4]">
        {volumeDb !== undefined ? fmtDb(volumeDb) : volumeNote ?? '—'}
        {volumeDb !== undefined && volumeNote ? <span className="text-[#8f9098]"> ({volumeNote})</span> : null}
      </div>
    </div>
  );
}

function fmtDb(db: number | null): string {
  if (db === null) return '—';
  if (db <= SEND_OFF_DB) return '−∞';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}`;
}

/** Display name of an Airwindows plugin factory ("makeKPlateD" → "kPlate D"). */
function pluginName(factory: string): string {
  const n = factory.replace(/^make/u, '');
  const known: Record<string, string> = {
    Console8BussIn: 'Console8 Buss In',
    Console8BussOut: 'Console8 Buss Out',
    Console8SubIn: 'Console8 Sub In',
    Console8SubOut: 'Console8 Sub Out',
    KPlateA: 'kPlate A',
    KPlateD: 'kPlate D',
    ADClip7: 'ADClip7',
    TexturizeMS: 'TexturizeMS',
    FreqShiftEcho: 'Freq Shift Echo',
    StereoChorus: 'Stereo Chorus',
    SimpleSide: 'Simple Side',
  };
  return known[n] ?? n;
}
