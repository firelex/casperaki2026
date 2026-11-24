// The song assistant's Pro-mode tools: read and change the open song's mix, as
// the mixer does in Pro mode. Offered only while Pro is on; the page then sends
// a snapshot of the mix (MixSnapshot) with every message. Changes come back as
// page actions that run through the mixer's own code, so they follow its rules:
// the tracks of one instrument type share one level, one set of sends and one
// output bus, and every change is saved with the song.

import { z } from 'zod';

/** A track's mix as the page shows it. Levels and sends in dB; null = off (sends) or no single value. */
const TrackMixSchema = z.object({
  track: z.string(),
  types: z.array(z.string()),
  bus: z.string(),
  standardBus: z.string(),
  levelDb: z.number().nullable(),
  trimDb: z.number(),
  sends: z.object({ reverb: z.number().nullable(), delay: z.number().nullable(), chorus: z.number().nullable() }),
  linkedWith: z.array(z.string()),
});

const BusParamSchema = z.object({ index: z.number().int(), name: z.string(), value: z.number(), shown: z.string(), standard: z.number(), readOnly: z.literal(true).optional() });
const BusSchema = z.object({
  bus: z.string(),
  kind: z.enum(['group', 'return', 'master']),
  plugins: z.array(z.object({ slot: z.number().int(), name: z.string(), params: z.array(BusParamSchema) })),
});

export const MixSnapshotSchema = z.object({ tracks: z.array(TrackMixSchema), buses: z.array(BusSchema) });
export type MixSnapshot = z.infer<typeof MixSnapshotSchema>;

const fmtDb = (v: number | null) => (v === null ? 'off' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 10) / 10)} dB`);

/** One line per track, then the buses and their plugins: what get_mix answers. */
export function mixOverview(mix: MixSnapshot): string {
  const tracks = mix.tracks.map((t) => {
    const level = t.levelDb === null ? 'level per part' : `level ${fmtDb(t.levelDb + t.trimDb)}`;
    const trim = t.trimDb !== 0 ? ` (standard ${t.levelDb === null ? 'per part' : fmtDb(t.levelDb)}, Pro ${fmtDb(t.trimDb)})` : '';
    const bus = t.bus === t.standardBus ? `${t.bus} bus` : `${t.bus} bus (standard ${t.standardBus})`;
    const linked = t.linkedWith.length ? ` [same type as ${t.linkedWith.join(', ')}: changes apply to all]` : '';
    return `- ${t.track} (${t.types.join(', ') || 'no type'}) → ${bus}; ${level}${trim}; sends reverb ${fmtDb(t.sends.reverb)}, delay ${fmtDb(t.sends.delay)}, chorus ${fmtDb(t.sends.chorus)}${linked}`;
  });
  const buses = mix.buses.map((b) => `- ${b.bus} (${b.kind === 'group' ? 'group bus' : b.kind === 'return' ? 'effect return' : 'master'}): ${b.plugins.map((p) => `${p.slot} ${p.name}`).join(', ')}`);
  return ['Tracks:', ...tracks, 'Buses and their plugins (slot, name); use get_bus for a bus\'s settings:', ...buses].join('\n');
}

export function busDetail(mix: MixSnapshot, bus: string): string {
  const b = requireBus(mix, bus);
  return [
    `${b.bus}:`,
    ...b.plugins.map(
      (p) =>
        `- slot ${p.slot} ${p.name}: ${p.params.map((q) => `[${q.index}] ${q.name} ${q.shown} (${q.readOnly ? 'fixed' : `raw ${q.value}`}${Math.abs(q.value - q.standard) > 1e-6 ? `, standard ${q.standard}` : ''})`).join('; ') || 'no settings'}`,
    ),
  ].join('\n');
}

export function requireMixTrack(mix: MixSnapshot, track: string) {
  const t = mix.tracks.find((x) => x.track === track);
  if (!t) throw new MixToolError(`The mixer has no track "${track}". Tracks: ${mix.tracks.map((x) => x.track).join(', ')}.`);
  return t;
}

export function requireBus(mix: MixSnapshot, bus: string) {
  const b = mix.buses.find((x) => x.bus === bus);
  if (!b) throw new MixToolError(`There is no bus "${bus}". Buses: ${mix.buses.map((x) => x.bus).join(', ')}.`);
  return b;
}

export class MixToolError extends Error {}

export const SetTrackMixParams = z
  .object({
    track: z.string(),
    changeLevelDb: z.number().min(-48).max(24).optional().describe('How much to change the level from where it is now, in dB: -3 = 3 dB quieter, +2 = 2 dB louder. Give it once per instrument type: tracks of the same type change together.'),
    standardLevel: z.literal(true).optional().describe('Put the level back to the standard level.'),
    reverb: z.union([z.number().min(-60).max(12), z.literal('off')]).optional().describe('Reverb send level in dB, or "off".'),
    delay: z.union([z.number().min(-60).max(12), z.literal('off')]).optional().describe('Delay send level in dB, or "off".'),
    chorus: z.union([z.number().min(-60).max(12), z.literal('off')]).optional().describe('Chorus send level in dB, or "off".'),
    bus: z.string().optional().describe('A group bus to play through, or "standard" for the standard one.'),
  })
  .strict();

export const SetBusSettingParams = z
  .object({
    bus: z.string(),
    slot: z.number().int().min(0),
    param: z.number().int().min(0).describe('The setting\'s index, as get_bus lists it.'),
    value: z.number().min(0).max(1).describe('The raw value, 0 to 1, as get_bus lists it.'),
  })
  .strict();

/** The page action of a set_track_mix call, after checking it against the mix (and updating the snapshot). */
export function trackMixAction(mix: MixSnapshot, a: z.infer<typeof SetTrackMixParams>) {
  const t = requireMixTrack(mix, a.track);
  if (a.changeLevelDb === undefined && !a.standardLevel && a.reverb === undefined && a.delay === undefined && a.chorus === undefined && a.bus === undefined) {
    throw new MixToolError('Say what to change: changeLevelDb, standardLevel, reverb, delay, chorus or bus.');
  }
  if (a.changeLevelDb !== undefined && a.standardLevel) throw new MixToolError('Give changeLevelDb or standardLevel, not both.');
  // The Pro trim (against the standard) the page sets on every track of the type.
  const trim = a.standardLevel ? 0 : a.changeLevelDb !== undefined ? Math.round((t.trimDb + a.changeLevelDb) * 10) / 10 : undefined;
  if (trim !== undefined && (trim < -60 || trim > 12)) throw new MixToolError(`That would put ${a.track} ${fmtDb(trim)} from its standard level; Pro mode allows −60 to +12 dB.`);
  let bus: string | null | undefined;
  if (a.bus !== undefined) {
    if (a.bus === 'standard') bus = null;
    else {
      if (requireBus(mix, a.bus).kind !== 'group') throw new MixToolError(`"${a.bus}" is not a group bus; tracks play through group buses (${mix.buses.filter((b) => b.kind === 'group').map((b) => b.bus).join(', ')}).`);
      bus = a.bus;
    }
  }
  const send = (v: number | 'off' | undefined) => (v === undefined ? undefined : v === 'off' ? -100 : v);
  const action = {
    kind: 'mixTrack' as const,
    track: a.track,
    ...(trim !== undefined ? { levelDb: trim } : {}),
    ...(a.reverb !== undefined ? { reverb: send(a.reverb)! } : {}),
    ...(a.delay !== undefined ? { delay: send(a.delay)! } : {}),
    ...(a.chorus !== undefined ? { chorus: send(a.chorus)! } : {}),
    ...(bus !== undefined ? { bus } : {}),
  };
  // Later calls in this turn see the change (on every track of the type).
  for (const x of mix.tracks.filter((x) => x === t || t.linkedWith.includes(x.track))) {
    if (trim !== undefined) x.trimDb = trim;
    for (const k of ['reverb', 'delay', 'chorus'] as const) {
      const v = send(a[k]);
      if (v !== undefined) x.sends[k] = v <= -100 ? null : v;
    }
    if (bus !== undefined) x.bus = bus ?? x.standardBus;
  }
  const parts = [
    trim !== undefined ? `level now ${t.levelDb === null ? `${fmtDb(trim)} from standard` : `${fmtDb(t.levelDb + trim)} (standard ${fmtDb(t.levelDb)})`}` : '',
    ...(['reverb', 'delay', 'chorus'] as const).map((k) => (a[k] !== undefined ? `${k} ${a[k] === 'off' ? 'off' : fmtDb(a[k] as number)}` : '')),
    bus !== undefined ? `bus ${bus ?? `${t.standardBus} (standard)`}` : '',
  ].filter(Boolean);
  const who = t.linkedWith.length ? `${[t.track, ...t.linkedWith].join(', ')} (same type)` : t.track;
  return { summary: `${who}: ${parts.join(', ')}.`, action };
}

export function busSettingAction(mix: MixSnapshot, a: z.infer<typeof SetBusSettingParams>) {
  const b = requireBus(mix, a.bus);
  const plugin = b.plugins.find((p) => p.slot === a.slot);
  if (!plugin) throw new MixToolError(`The ${a.bus} bus has no plugin in slot ${a.slot}; see get_bus.`);
  const param = plugin.params.find((p) => p.index === a.param);
  if (!param) throw new MixToolError(`${plugin.name} on ${a.bus} has no setting ${a.param}; see get_bus.`);
  if (param.readOnly) throw new MixToolError(`${plugin.name}'s ${param.name} cannot be changed in Pro mode.`);
  param.value = a.value;
  return {
    summary: `${a.bus} bus, ${plugin.name}: ${param.name} set to ${a.value} (raw). This setting is shared by every track on the bus.`,
    action: { kind: 'busSetting' as const, bus: a.bus, slot: a.slot, param: a.param, value: a.value },
  };
}
