import { useEffect, useRef, useState, type ReactNode } from 'react';

import { automationAt, livePlayer, type LaneMeters, type MixConfigJson, type ResolvedMix, type ResolvedMixLane } from '../../audio/livePlayer';
import { changeLane, changeLaneRoute, linkedLanes, setPro, type ProMixState } from '../../audio/proMix';
import type { LaneMixOverride } from '@casperaki/song-schema/schemas';

import type { PlaybackPayload } from '../../api/playback';
import type { SeqTrack } from '../sequencerModel';
import { DEVICES } from '../devices/deviceDefs';

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

/** Readable names of the group (submix) buses in mix-config rackChains. Unknown ids show as they are. */
const BUS_NAMES: Readonly<Record<string, string>> = {
  fx: 'FX',
  kicks: 'Kicks',
  drums: 'Drums',
  percussion: 'Percussion',
  bass: 'Bass',
  keys: 'Keys',
  synths: 'Synths',
  leadSynths: 'Lead synths',
  acousticGuitars: 'Acoustic guitars',
  electricGuitars: 'Electric guitars',
  orchestral: 'Orchestral',
};
function busName(bus: string): string {
  return BUS_NAMES[bus] ?? bus;
}
/** One colour per group bus (in the order the buses appear), shown as a band on the bus and its tracks. */
const BUS_COLORS = ['#e8a33d', '#4fb3a9', '#a77ee0', '#e0647a', '#6fa8e8', '#9cc95a', '#d98ad0', '#c9b458', '#5fc7e0', '#e07f4f', '#8f9be8'];

/**
 * The mixer, as in a DAW's mixer window: a channel strip per track (grouped by
 * the bus it feeds), then the group buses (each bus's shared plugin chain and
 * the tracks feeding it), the reverb / delay / chorus returns and the master. Read-only: every value is
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
  pro,
  liveKey,
  fetchPayload,
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
  /** Pro mode (editable mix) and the song's changes. */
  pro: ProMixState;
  /** What the player plays (live changes go there). */
  liveKey: string | undefined;
  /** Loads the song the player plays (a route change swaps in a new version of it). */
  fetchPayload: ((signal: AbortSignal) => Promise<PlaybackPayload>) | undefined;
}) {
  const [routeError, setRouteError] = useState<string | undefined>(undefined);
  // "Out → bus" on a track scrolls to that bus's strip and highlights it briefly.
  const busRefs = useRef(new Map<string, HTMLDivElement>());
  const [flash, setFlash] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), 1400);
    return () => clearTimeout(t);
  }, [flash]);
  const showBus = (bus: string) => {
    const el = busRefs.current.get(bus);
    if (!el) throw new Error(`Mixer: no strip for the ${bus} bus`);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    setFlash(bus);
  };
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
  const trackOrder = [...tracks.map((t) => t.name).filter((n) => byLane.has(n)), ...[...byLane.keys()].filter((n) => !tracks.some((t) => t.name === n))];
  // The group buses, in the order their first track appears; each with the tracks feeding it.
  const groupBuses: string[] = [];
  const feeders = new Map<string, string[]>();
  for (const lane of trackOrder) {
    for (const bus of new Set(byLane.get(lane)!.map((p) => p.fxGroup))) {
      if (!feeders.has(bus)) {
        groupBuses.push(bus);
        feeders.set(bus, []);
      }
      feeders.get(bus)!.push(lane);
    }
  }
  // Tracks of the same instrument type(s) share one fader, one set of sends and one bus in Pro mode.
  const linked = (lane: string) => linkedLanes(mix, lane);
  const busColor = (bus: string) => BUS_COLORS[groupBuses.indexOf(bus) % BUS_COLORS.length]!;
  // Every group bus of the mix (what a track can be routed to in Pro mode), in rack order.
  const routable = mix.config.rackChains.map((c) => c.bus).filter((b) => b !== 'master' && !RETURNS.some((r) => r.bus === b));
  // Tracks grouped by the (first) bus they feed, in bus order; track order within a bus.
  const laneOrder = groupBuses.flatMap((bus) => trackOrder.filter((lane) => byLane.get(lane)![0]!.fxGroup === bus));
  // A bus's meter: the loudest of its tracks at the playhead (before the bus's own plugins).
  const busTrackPeak = (bus: string) => {
    const levels = feeders.get(bus)!.map(levelOf).filter((v): v is number => v !== undefined);
    return levels.length ? Math.max(...levels) : undefined;
  };

  return (
    // Strips keep their natural height (every insert listed); a lower mixer
    // scrolls instead of squashing them, a taller one adds room above the faders.
    <div className="flex h-full min-h-0 flex-col bg-[#202124]">
    {routeError ? (
      <p className="shrink-0 border-b border-black/60 bg-err/10 px-3 py-1 text-[11px] text-red-200" role="alert">
        {routeError}
      </p>
    ) : null}
    <div className="min-h-0 flex-1 overflow-auto">
      {/* All strips as tall as the tallest, so their faders line up. */}
      <div className="flex min-h-full w-max items-stretch">
      {laneOrder.map((lane) => (
        <ChannelStrip
          key={lane}
          name={lane}
          color={tracks.find((t) => t.name === lane)?.color ?? '#8a8b93'}
          parts={byLane.get(lane)!}
          soundName={soundNames[lane]}
          seconds={seconds}
          busColor={busColor}
          onShowBus={showBus}
          level={levelOf(lane)}
          muted={muted.includes(lane)}
          soloed={solo.includes(lane)}
          anySolo={solo.length > 0}
          pro={pro.pro}
          override={pro.mix.lanes[lane]}
          linkedWith={linked(lane).filter((l) => l !== lane)}
          onChange={(patch) => changeLane(liveKey, linked(lane), patch)}
          routable={routable}
          onRoute={(bus) => {
            setRouteError(undefined);
            changeLaneRoute(liveKey, fetchPayload, linked(lane), bus).catch((err: unknown) =>
              setRouteError(`Routing ${lane} failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          }}
        />
      ))}
      <div className="w-2 shrink-0 bg-black/40" aria-hidden="true" />
      {groupBuses.map((bus) => (
        <div
          key={bus}
          ref={(el) => {
            if (el) busRefs.current.set(bus, el);
            else busRefs.current.delete(bus);
          }}
          className={`flex shrink-0 transition-shadow ${flash === bus ? 'shadow-[inset_0_0_0_2px_#ffffff]' : ''}`}
        >
          <BusStrip
            name={busName(bus)}
            bus={bus}
            subtitle="Group bus"
            plugins={chains.get(bus)}
            color={busColor(bus)}
            band={busColor(bus)}
            from={feeders.get(bus)!}
            level={busTrackPeak(bus)}
            levelNote="track peak"
            onOpenDevice={onOpenDevice}
          />
        </div>
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
    </div>
  );
}

/** The save state, the Pro mode switch and Reset (mix and tracks/mixer split; the transport bar's right end). */
export function ProBar({
  pro,
  layoutChanged,
  onReset,
}: {
  pro: ProMixState;
  /** The tracks / mixer split differs from the standard one (Reset puts it back too). */
  layoutChanged: boolean;
  onReset: (mixChanged: boolean) => void;
}) {
  const changed = Object.keys(pro.mix.lanes).length + Object.keys(pro.mix.buses).length > 0;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-[11px] text-[#9a9ba3]">
        {pro.error ? (
          <span className="text-err">{pro.error}</span>
        ) : pro.saving ? (
          'Saving…'
        ) : changed ? (
          'Your mix (saved with the song)'
        ) : pro.pro ? (
          'Standard mix: drag a fader or send, or open a plugin to change it'
        ) : (
          'Standard mix'
        )}
      </span>
      <button
        type="button"
        onClick={() => setPro(!pro.pro)}
        aria-pressed={pro.pro}
        disabled={!pro.songId}
        title={pro.songId ? 'Pro mode: change faders, sends and plugin settings' : 'Save the song first to change its mix'}
        className={`h-7 rounded-[4px] border px-3 text-[11px] font-bold tracking-wide disabled:opacity-40 ${
          pro.pro ? 'border-[#ffb347] bg-[#ffb347] text-black' : 'border-white/20 bg-[#3a3c42] text-[#d9dade] hover:border-white/40'
        }`}
      >
        PRO
      </button>
      <button
        type="button"
        onClick={() => onReset(changed)}
        disabled={(!changed && !layoutChanged) || pro.saving}
        title="Put every fader, send and plugin back to the standard mix, and the mixer back to its standard size"
        className="h-7 rounded-[4px] border border-white/20 bg-[#3a3c42] px-3 text-[11px] text-[#d9dade] hover:border-white/40 disabled:opacity-40"
      >
        Reset
      </button>
    </div>
  );
}

function ChannelStrip({
  name,
  color,
  parts,
  soundName,
  seconds,
  busColor,
  onShowBus,
  level,
  muted,
  soloed,
  anySolo,
  pro,
  override,
  linkedWith,
  onChange,
  routable,
  onRoute,
}: {
  name: string;
  color: string;
  parts: readonly ResolvedMixLane[];
  soundName: string | undefined;
  /** The song position, for automation. */
  seconds: number;
  /** The colour band of a group bus. */
  busColor: (bus: string) => string;
  /** Scroll to (and highlight) a group bus's strip. */
  onShowBus: (bus: string) => void;
  level: number | undefined;
  muted: boolean;
  soloed: boolean;
  anySolo: boolean;
  /** Pro mode: the fader and sends can be changed. */
  pro: boolean;
  /** This track's Pro-mode changes. */
  override: LaneMixOverride | undefined;
  /** Other tracks of the same instrument type: Pro-mode fader and sends move them too. */
  linkedWith: readonly string[];
  onChange: (patch: { volumeDb?: number; reverb?: number; delay?: number; chorus?: number }) => void;
  /** The group buses the track can be routed to (Pro mode). */
  routable: readonly string[];
  /** Pro mode: route the track to a group bus (undefined: its standard bus). */
  onRoute: (bus: string | undefined) => void;
}) {
  const buses = [...new Set(parts.map((p) => p.fxGroup))];
  const types = [...new Set(parts.map((p) => p.lowLevelType).filter(Boolean))];
  const volumes = parts.map((p) => p.volumeDb).filter((v): v is number => v !== null);
  const baseVolume = volumes.length && volumes.every((v) => v === volumes[0]) ? volumes[0] : undefined;
  // Automation at the playhead: volume moves the fader, low-pass shows its cutoff.
  const autoDb = automationAt(parts.find((p) => p.volume)?.volume, seconds);
  const cutoff = automationAt(parts.find((p) => p.lowPass)?.lowPass, seconds);
  const trim = override?.volumeDb ?? 0;
  const standard = baseVolume !== undefined ? baseVolume + (autoDb ?? 0) : undefined;
  const volume = standard !== undefined ? standard + trim : undefined;
  const tip = parts
    .map((p) => `${p.track}: ${p.lowLevelType || 'no type'} → ${busName(p.fxGroup)} bus, volume ${fmtDb(p.volumeDb)}, sends R ${fmtDb(p.sendsDb.reverb)} D ${fmtDb(p.sendsDb.delay)} C ${fmtDb(p.sendsDb.chorus)}`)
    .join('\n');
  return (
    <Strip
      color={color}
      band={busColor(buses[0]!)}
      name={name}
      subtitle={soundName ?? (types.length === 1 ? types[0]! : types.length ? `${types.length} sound types` : '—')}
      title={`${soundName ? `Sound: ${soundName}\n` : ''}${tip}`}
      bottom={
        <>
          {linkedWith.length ? (
            <div
              className="mb-1 truncate rounded-[3px] bg-[#6fa8e8]/15 px-1 text-center text-[9px] text-[#9cc3f0]"
              title={`Same instrument type as ${linkedWith.join(', ')}. In Pro mode the fader, sends and output bus are set for the type, so they change all of these tracks together.`}
            >
              ⛓ {linkedWith.join(', ')}
            </div>
          ) : null}
          <Section label="Sends">
            {RETURNS.map((r) => (
              <SendRow
                key={r.key}
                name={r.name}
                values={override?.[r.key] !== undefined ? [override[r.key]!] : parts.map((p) => p.sendsDb[r.key])}
                changed={override?.[r.key] !== undefined}
                onChange={pro ? (db) => onChange({ [r.key]: db }) : undefined}
              />
            ))}
          </Section>
          {cutoff !== undefined && cutoff < 19000 ? (
            <div className="mb-1 rounded-[3px] bg-[#ffb347]/20 px-1 text-center font-mono text-[9px] text-[#ffb347]" title="Low-pass filter sweep (automation)">
              LP {cutoff >= 1000 ? `${(cutoff / 1000).toFixed(1)} kHz` : `${Math.round(cutoff)} Hz`}
            </div>
          ) : null}
          {standard === undefined && pro && parts.length > 0 ? (
            // Parts at different standard levels (e.g. a drum kit): in Pro mode the fader is a
            // trim over all of them (0 dB = the standard levels).
            <FaderBlock
              volumeDb={trim}
              volumeNote="trim"
              level={level}
              changed={trim !== 0}
              onChange={(db) => onChange({ volumeDb: Math.round(db * 10) / 10 })}
              onReset={() => onChange({ volumeDb: 0 })}
            />
          ) : (
            <FaderBlock
              automated={autoDb !== undefined}
              volumeDb={volume}
              volumeNote={volumes.length > 1 && volume === undefined ? (trim !== 0 ? `per part, ${trim > 0 ? '+' : '−'}${Math.abs(trim)} Pro` : 'per part') : volumes.length === 0 ? 'none' : trim !== 0 ? `${trim > 0 ? '+' : '−'}${Math.abs(Math.round(trim * 10) / 10)} Pro` : undefined}
              level={level}
              changed={trim !== 0}
              onChange={pro && standard !== undefined ? (db) => onChange({ volumeDb: Math.round((db - standard) * 10) / 10 }) : undefined}
              onReset={pro ? () => onChange({ volumeDb: 0 }) : undefined}
            />
          )}
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
      <Section label="Output">
        {pro ? (
          <label className="mb-[2px] block" title="Pro mode: the group bus this track plays through. The engine rebuilds its buses, so a change swaps in a new version of the song at the same spot.">
            <span className="sr-only">{`Output bus of ${name}`}</span>
            <select
              value={override?.fxGroup ?? ''}
              onChange={(e) => onRoute(e.target.value === '' ? undefined : e.target.value)}
              className={`w-full rounded-[2px] border bg-[#1d1e21] px-0.5 text-[9.5px] leading-[15px] text-[#dfe0e4] ${override?.fxGroup ? 'border-[#ff8a3d]' : 'border-black/60'}`}
            >
              <option value="">{override?.fxGroup ? 'Standard bus' : `Standard: ${buses.map(busName).join(' + ')}`}</option>
              {routable.map((b) => (
                <option key={b} value={b}>
                  {`→ ${busName(b)}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {buses.map((bus) => (
          <button
            key={bus}
            type="button"
            onClick={() => onShowBus(bus)}
            className="mb-[2px] flex w-full items-center gap-1 truncate rounded-[2px] border border-black/60 bg-[#1d1e21] px-1 text-left text-[9.5px] leading-[15px] text-[#dfe0e4] hover:border-white/30"
            title={`This track plays through the ${busName(bus)} group bus, whose plugins it shares with the other tracks on it. Click to show the bus.`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: busColor(bus) }} aria-hidden="true" />
            <span className="truncate">Out → {busName(bus)}</span>
          </button>
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
  band,
  from,
  volumeDb,
  level,
  levelNote,
}: {
  name: string;
  /** The bus's name in the mix config ("master", "fxPlateReverb", …). */
  bus: string;
  onOpenDevice: (d: OpenDevice) => void;
  subtitle: string;
  plugins: MixConfigJson['rackChains'][number]['plugins'] | undefined;
  color: string;
  /** A group bus's colour band (also on the tracks feeding it). */
  band?: string;
  /** A group bus: the tracks feeding it (they share its plugins). */
  from?: readonly string[];
  volumeDb?: number;
  /** Peak at the playhead, while playing. */
  level: number | undefined;
  /** What the meter shows, when it is not the bus's own output. */
  levelNote?: string;
}) {
  return (
    <Strip
      color={color}
      band={band}
      name={name}
      subtitle={subtitle}
      bottom={
        <>
          <div className="mb-1.5 h-[52px]" aria-hidden="true" />
          {from ? (
            // A group bus has no fader of its own: the meter shows the loudest of its tracks.
            <FaderBlock volumeDb={undefined} volumeNote={levelNote ?? 'no fader'} level={level} />
          ) : (
            <FaderBlock volumeDb={volumeDb ?? 0} volumeNote={volumeDb === undefined ? 'unity' : undefined} level={level} />
          )}
          <div className="mt-1 h-5" />
        </>
      }
    >
      {from ? (
        <Section label="From">
          <div className="text-[9.5px] leading-[13px] text-[#dfe0e4]" title={`Shared by: ${from.join(', ')}`}>
            {from.join(', ')}
          </div>
        </Section>
      ) : null}
      <Section label={from ? 'Inserts (shared)' : 'Inserts'}>
        <Inserts plugins={plugins} bus={bus} sharedBy={from} onOpen={onOpenDevice} />
      </Section>
    </Strip>
  );
}

function Strip({
  color,
  band,
  name,
  subtitle,
  title,
  children,
  bottom,
}: {
  color: string;
  /** A group bus's colour, as a band across the top (the bus and the tracks feeding it). */
  band?: string;
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
      {band ? <div className="-mx-1.5 -mt-1.5 mb-1.5 h-[4px]" style={{ background: band }} aria-hidden="true" /> : null}
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
/** Plugins with a device view (all of them: Logical4 has its own panel, the rest the general one). */
const DEVICE_VIEWS = new Set(['makeLogical4', ...Object.keys(DEVICES)]);

export interface OpenDevice {
  readonly bus: string;
  readonly slot: number;
  readonly factory: string;
  readonly params: readonly number[];
  /** A group bus's plugin: the tracks sharing it (a change affects all of them). */
  readonly sharedBy?: readonly string[];
}

function Inserts({
  plugins,
  bus,
  sharedBy,
  onOpen,
}: {
  plugins: MixConfigJson['rackChains'][number]['plugins'] | undefined;
  bus: string;
  sharedBy?: readonly string[];
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
            onClick={() => onOpen({ bus, slot: i, factory: p.factory, params: p.params, ...(sharedBy ? { sharedBy } : {}) })}
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
function SendRow({
  name,
  values,
  changed,
  onChange,
}: {
  name: string;
  values: readonly (number | null)[];
  /** Set in Pro mode (differs from the standard mix). */
  changed?: boolean;
  /** Pro mode: the send can be changed (dB; −100 = off). */
  onChange?: (db: number) => void;
}) {
  const known = values.filter((v): v is number => v !== null);
  const same = known.length > 0 && known.every((v) => v === known[0]);
  const db = same ? known[0]! : undefined;
  const on = db !== undefined && db > SEND_OFF_DB;
  const frac = on ? Math.max(0, Math.min(1, (db + 40) / 46)) : 0;
  if (onChange) {
    // Drag along the bar (or arrow keys): −40 … +6 dB; the far left is off.
    const dbAtFrac = (f: number) => (f <= 0.02 ? -100 : Math.round((f * 46 - 40) * 2) / 2);
    const fromPointer = (el: HTMLElement, clientX: number) => {
      const r = el.getBoundingClientRect();
      onChange(dbAtFrac(Math.max(0, Math.min(1, (clientX - r.left) / r.width))));
    };
    const step = (d: number) => {
      const cur = on ? db! : -40.5;
      const next = cur + d;
      onChange(next < -40 ? -100 : Math.min(6, next));
    };
    return (
      <div className="mb-[3px] flex items-center gap-1" title={`${name} send: drag (far left = off), or use the arrow keys`}>
        <span className={`w-[26px] shrink-0 text-[9px] ${changed ? 'text-[#ffb347]' : 'text-[#a9aab1]'}`}>{name.slice(0, 3)}</span>
        <span
          role="slider"
          tabIndex={0}
          aria-label={`${name} send`}
          aria-valuemin={-40}
          aria-valuemax={6}
          aria-valuenow={on ? db : -40}
          aria-valuetext={db === undefined ? 'varies' : fmtDb(db)}
          className="relative h-[8px] flex-1 cursor-ew-resize touch-none overflow-hidden rounded-full bg-black/50 outline-none ring-[#ffb347] focus-visible:ring-1"
          onPointerDown={(e) => {
            e.preventDefault(); // no text selection while dragging
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            fromPointer(e.currentTarget, e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.currentTarget, e.clientX);
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(0.5);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-0.5);
            else return;
            e.preventDefault();
          }}
        >
          <span className={`absolute inset-y-0 left-0 rounded-full ${changed ? 'bg-[#ffb347]' : 'bg-[#6fb3ff]'}`} style={{ width: `${frac * 100}%` }} />
        </span>
        <span className={`w-[30px] shrink-0 text-right font-mono text-[9px] ${changed ? 'text-[#ffb347]' : on ? 'text-[#dfe9f5]' : 'text-[#6d6e75]'}`}>
          {db === undefined ? 'var' : fmtDb(db)}
        </span>
      </div>
    );
  }
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
function FaderBlock({
  volumeDb,
  volumeNote,
  level,
  automated,
  changed,
  onChange,
  onReset,
}: {
  volumeDb: number | undefined;
  volumeNote?: string;
  level: number | undefined;
  /** The fader is moving with volume automation. */
  automated?: boolean;
  /** Moved in Pro mode. */
  changed?: boolean;
  /** Pro mode: drag the fader (the new level, dB). */
  onChange?: (db: number) => void;
  /** Pro mode: double-click puts it back to the standard level. */
  onReset?: () => void;
}) {
  const y = (db: number) => (1 - (Math.max(BOTTOM_DB, Math.min(TOP_DB, db)) - BOTTOM_DB) / (TOP_DB - BOTTOM_DB)) * FADER_H;
  const dbAt = (py: number) => TOP_DB - (Math.max(0, Math.min(FADER_H, py)) / FADER_H) * (TOP_DB - BOTTOM_DB);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  const fromPointer = (clientY: number) => {
    const r = track.current?.getBoundingClientRect();
    if (r && onChange) onChange(dbAt(clientY - r.top));
  };
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
        {/* Fader track and cap (draggable in Pro mode). */}
        <div
          ref={track}
          className={`relative w-[14px] ${onChange ? 'cursor-ns-resize touch-none' : ''}`}
          onPointerDown={
            onChange
              ? (e) => {
                  e.preventDefault(); // no text selection while dragging
                  dragging.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  fromPointer(e.clientY);
                }
              : undefined
          }
          onPointerMove={onChange ? (e) => dragging.current && fromPointer(e.clientY) : undefined}
          onPointerUp={
            onChange
              ? (e) => {
                  dragging.current = false;
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
              : undefined
          }
          onDoubleClick={onReset}
          title={onChange ? 'Drag to change the level; double-click for the standard level' : undefined}
        >
          <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-black/70" />
          {volumeDb !== undefined ? (
            <span
              className={`absolute left-1/2 h-[18px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-[3px] border border-black/70 bg-gradient-to-b shadow-[0_2px_3px_rgba(0,0,0,0.5)] ${
                automated ? 'from-[#ffd28a] via-[#e09a3c] to-[#f0b860]' : changed ? 'from-[#ffe0b0] via-[#ffb347] to-[#ffd08a]' : 'from-[#d4d5da] via-[#9fa1a8] to-[#c9cad0]'
              }`}
              title={automated ? 'Moving with volume automation' : undefined}
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
      {/* Always two lines (level, then the note), so the strip never changes height while a fader moves. */}
      <div className="mt-1 flex h-[26px] flex-col items-center whitespace-nowrap font-mono text-[10px] leading-[13px] text-[#dfe0e4]">
        <span>{volumeDb !== undefined ? fmtDb(volumeDb) : volumeNote ?? '—'}</span>
        <span className="max-w-full truncate text-[#8f9098]">{volumeDb !== undefined && volumeNote ? volumeNote : '\u00a0'}</span>
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
