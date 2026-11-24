// What the engine does with a sound in a song (Sounds page details panel):
// its volume, octave shift, loudness, the bus it goes through with that bus's
// insert chain, its reverb / delay / chorus sends, tempo and key, and plain
// facts about how it is played. Public information only.
//
// The mix values are read from the same mix-config.json the engine loads and
// looked up exactly as the engine does (apps/web/wasm/engine/src/audio/
// MixConfig.h + Mixer.h): target volume = ordered rules, first match wins,
// no match → 0 dB; fx group = map, unmapped → "drums"; sends = the group's
// sends, then the first by-type override (set or add), then by-group-genre.

import { normalizeLoopLowLevelType, drumRoleLowLevelType, octaveAdjustmentFor } from '@casperaki/engine-adapter';
import type { ValidatedCatalogEntry } from '@casperaki/arrangement';

import type { SamplePlan } from './enginePreview.js';

export interface MixConfigJson {
  constants: { transitionsTrimDb: number };
  typeToFxGroup: Record<string, string>;
  /** Rules without `genres` apply in every style. */
  instrumentTargetVolume: { type: string; genres?: string[]; db: number }[];
  instrumentFxSends: Record<string, { reverb: number; delay: number; chorus: number }>;
  laneSendOverrides: {
    byType: { types: string[]; op: 'set' | 'add'; reverb?: number; delay?: number; chorus?: number }[];
    byGroupGenre: { group: string; genre: string; reverb: number }[];
  };
  rackChains: { bus: string; plugins: { factory: string; params: number[] }[] }[];
}

export interface Sends {
  readonly reverb: number | null;
  readonly delay: number | null;
  readonly chorus: number | null;
}

export interface SoundDetails {
  /** The style the values are for (null: no style given; style-specific rules then do not apply). */
  readonly genre: string | null;
  /** The volume the engine sets for it, in dB. */
  readonly volumeDb: number | null;
  /** Octaves the engine shifts it by (tonal sounds). */
  readonly octaveShift: number | null;
  readonly loudness: string;
  /** The submix it goes through ("keys bus"). */
  readonly bus: string | null;
  /** That bus's insert chain, as the mixer names the plugins. */
  readonly inserts: readonly string[];
  /** Send levels in dB (≤ −100: off). */
  readonly sends: Sends;
  readonly bpm: number | null;
  readonly key: string | null;
  readonly notes: readonly string[];
}

const SEND_OFF = -100;

export class MixLookup {
  private readonly cfg: MixConfigJson;
  constructor(json: string) {
    this.cfg = JSON.parse(json) as MixConfigJson;
    for (const k of ['constants', 'typeToFxGroup', 'instrumentTargetVolume', 'instrumentFxSends', 'laneSendOverrides', 'rackChains'] as const) {
      if (this.cfg[k] === undefined) throw new Error(`mix config: missing "${k}"`);
    }
  }

  targetVolume(type: string, genre: string | null): number {
    for (const r of this.cfg.instrumentTargetVolume) {
      if (r.type !== type) continue;
      const gs = r.genres ?? [];
      if (gs.length === 0) return r.db;
      if (genre !== null && gs.includes(genre)) return r.db;
    }
    return 0;
  }

  /** Whether some rule for `type` only applies in certain styles. */
  hasStyleRules(type: string): boolean {
    return this.cfg.instrumentTargetVolume.some((r) => r.type === type && (r.genres ?? []).length > 0);
  }

  /** The group bus a type plays through. A type the mix config does not route is an error (as in the engines). */
  fxGroup(type: string): string {
    const bus = this.cfg.typeToFxGroup[type];
    if (bus === undefined) throw new Error(`The mix config (typeToFxGroup) has no group bus for the sound type "${type}".`);
    return bus;
  }

  laneSends(group: string, type: string, genre: string | null): Sends {
    const base = this.cfg.instrumentFxSends[group] ?? { reverb: -25, delay: -100, chorus: -100 };
    const s = { ...base };
    for (const o of this.cfg.laneSendOverrides.byType) {
      if (!o.types.includes(type)) continue;
      for (const k of ['reverb', 'delay', 'chorus'] as const) {
        const v = o[k];
        if (v === undefined) continue;
        s[k] = o.op === 'set' ? v : s[k] + v;
      }
      break; // first match, as the engine
    }
    for (const o of this.cfg.laneSendOverrides.byGroupGenre) if (o.group === group && o.genre === genre) s.reverb = o.reverb;
    const off = (v: number) => (v <= SEND_OFF ? null : v);
    return { reverb: off(s.reverb), delay: off(s.delay), chorus: off(s.chorus) };
  }

  inserts(bus: string): string[] {
    const rack = this.cfg.rackChains.find((r) => r.bus === bus);
    return rack ? rack.plugins.map((p) => pluginName(p.factory)) : [];
  }

  transitionsTrimDb(): number {
    return this.cfg.constants.transitionsTrimDb;
  }
}

/** Plugin display name, as the web mixer shows it ("makeKPlateD" → "kPlate D"). */
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

function loudnessOf(e: ValidatedCatalogEntry): string {
  const n = e.normalisation;
  if (!n) return 'Loudness not recorded in the catalog';
  if (/-24\s*LU[FV]S/iu.test(n)) return 'Normalised to −24 LUFS';
  const db = /(-?\d+)\s*dB/iu.exec(n);
  if (db) return `Recorded at ${db[1]!.replace('-', '−')} dB (drum hits are balanced by the kit’s volume per position)`;
  throw new Error(`soundDetails: unknown loudness "${n}" for ${e.id}`);
}

const busLabel = (group: string) => `${group.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase()} bus`;

export type DetailsKind =
  | { kind: 'tonal'; lane: string }
  | { kind: 'drum'; roles: readonly string[] }
  | { kind: 'sample'; plan: SamplePlan }
  | { kind: 'none'; reason: string };

export function soundDetails(mix: MixLookup, e: ValidatedCatalogEntry | undefined, k: DetailsKind, genre: string | null, info: { bpm: number | null; key: string | null }): SoundDetails {
  const notes: string[] = [];
  const base = { genre, bpm: info.bpm, key: info.key };
  if (!e || k.kind === 'none') {
    return {
      ...base,
      volumeDb: null,
      octaveShift: null,
      loudness: e ? loudnessOf(e) : 'Its file is missing from the library',
      bus: null,
      inserts: [],
      sends: { reverb: null, delay: null, chorus: null },
      notes: [`Cannot be played: ${k.kind === 'none' ? k.reason : 'its file is missing from the library'}.`],
    };
  }
  const styleNote = (type: string) => {
    if (genre === null && mix.hasStyleRules(type)) notes.push('Some styles set a different volume for this kind of sound.');
  };
  if (k.kind === 'tonal') {
    const type = e.lowLevel;
    const group = mix.fxGroup(type);
    styleNote(type);
    const oct = octaveAdjustmentFor(e.id);
    if (oct !== 0) notes.push(`Played ${Math.abs(oct)} octave${Math.abs(oct) === 1 ? '' : 's'} ${oct > 0 ? 'higher' : 'lower'} than recorded, to sit where this kind of part belongs.`);
    if (k.lane !== 'own') notes.push(`Previewed with a ${k.lane} part: no style writes parts for this exact kind of sound.`);
    return { ...base, volumeDb: mix.targetVolume(type, genre), octaveShift: oct, loudness: loudnessOf(e), bus: busLabel(group), inserts: mix.inserts(group), sends: mix.laneSends(group, type, genre), notes };
  }
  if (k.kind === 'drum') {
    // Each kit position keeps the volume of its own type (the kit's base inst-1.json), whichever sound plays in it.
    const positionTypes = [...new Set(k.roles.map((r) => drumRoleLowLevelType(r)))];
    const vols = [...new Set(positionTypes.map((t) => mix.targetVolume(t, genre)))];
    if (vols.length > 1) notes.push(`Its kit positions have different volumes (${vols.map((v) => `${v} dB`).join(', ')}); the first is shown.`);
    notes.push('In a drum kit the volume belongs to the kit position (e.g. Kick 1), not to the sound.');
    for (const t of positionTypes) styleNote(t);
    const group = e.family === 'kickDrums' ? 'kicks' : 'drums';
    return { ...base, volumeDb: vols[0]!, octaveShift: null, loudness: loudnessOf(e), bus: busLabel(group), inserts: mix.inserts(group), sends: mix.laneSends(group, 'drums', genre), notes };
  }
  const plan = k.plan;
  if (plan.kind === 'loop') {
    const type = normalizeLoopLowLevelType(e.lowLevel);
    const group = mix.fxGroup(type);
    styleNote(type);
    notes.push(e.family === 'percussionLoops' ? 'Songs pick the copy of a loop recorded for the song’s tempo; it is not time-stretched.' : 'A tempo loop: heard as a loop at its own tempo (songs do not use it yet).');
    return { ...base, bpm: plan.bpm, volumeDb: mix.targetVolume(type, genre), octaveShift: null, loudness: loudnessOf(e), bus: busLabel(group), inserts: mix.inserts(group), sends: mix.laneSends(group, type, genre), notes };
  }
  // A transition clip: unity gain under the transitions track's trim, on the fx submix; sends by the clip's own type.
  const clipType = plan.tag === 'fxNoiseRiseSample' ? 'fxNoiseRise' : plan.tag === 'fxOther' ? 'fxOther' : plan.tag;
  const sends = mix.laneSends(mix.fxGroup(clipType), clipType, genre);
  notes.push('Transitions play at one level, set by the transitions track.');
  if (plan.tag === 'fxTonalReverse') notes.push('Plays in the key of the section’s last chord (each pack has a recording in every key).');
  if (plan.tag === 'percussionBreaksFills' || plan.tag === 'percussionBreaksBuildups') notes.push('Songs pick the recording made at the song’s tempo (nearest when none matches); it is not time-stretched.');
  if (plan.tag === 'fxNoiseRiseSample') notes.push('Songs make their noise rises with a built-in noise generator; this recording is not used in songs yet.');
  if (e.family === 'percussionMisc' || plan.tag === 'fxAtmosphere' || plan.tag === 'fxFretNoise') notes.push('Not used in songs yet.');
  return { ...base, volumeDb: mix.transitionsTrimDb(), octaveShift: null, loudness: loudnessOf(e), bus: busLabel('fx'), inserts: mix.inserts('fx'), sends, notes };
}
