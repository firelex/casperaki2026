// The vocal level follows the song's backing (owner, 2026-11-25): after Sing, the sung song is rendered in full and
// with the vocals alone, the vocals' loudness is compared with the backing's (full minus vocals), and the song's own
// vocals-bus output fader (a Pro-mode bus setting, after the bus compressor so the reverb balance is unchanged) is set
// so the vocals sit VOCALS_OVER_BACKING_DB above the backing, as in Tangerine Sidewalk at the level the owner approved
// (vocals -10.1 LUFS over a -12.1 LUFS backing). Measured with the standard vocals-bus level, so the setting is
// relative to the standard mix.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { applyMixOverrides, type MixOverrides } from '@casperaki/song-schema';

/** Vocals over backing, integrated loudness (dB), as approved on Tangerine Sidewalk. */
export const VOCALS_OVER_BACKING_DB = 2.0;
/** A change of the vocals bus output fader shows in the vocals' loudness at about this share (measured on Tangerine:
 *  +3.5 dB on the fader, +2.3 dB in the vocals; the Console8 stage after the gain saturates a little). */
export const FADER_TO_VOCALS = 0.66;
/** The fader never moves further than this from the standard (dB). */
export const MAX_FADER_DB = 9;
export const VOCALS_BUS = 'vocals';
const FADER = 'makeConsole8SubOut';

export interface VocalLevel {
  /** Loudness measured with the standard vocals-bus level (LUFS). */
  readonly vocalsLufs: number;
  readonly backingLufs: number;
  /** The vocals-bus fader setting for the song, relative to the standard (dB). */
  readonly faderDb: number;
}

/** The vocals bus's output fader: its slot in the rack chain and its standard parameter (a mix-config.json text). */
export function vocalFader(baseConfig: string): { slot: number; standard: number } {
  const cfg = JSON.parse(baseConfig) as { rackChains: { bus: string; plugins: { factory: string; params: number[] }[] }[] };
  const chain = cfg.rackChains.find((c) => c.bus === VOCALS_BUS);
  if (!chain) throw new Error(`the mix has no "${VOCALS_BUS}" bus`);
  const slot = chain.plugins.findIndex((p) => p.factory === FADER);
  if (slot < 0) throw new Error(`the "${VOCALS_BUS}" bus has no ${FADER}`);
  const params = chain.plugins[slot]!.params;
  if (params.length !== 1) throw new Error(`${FADER} on "${VOCALS_BUS}" has ${params.length} parameters, not 1`);
  return { slot, standard: params[0]! };
}

/** The fader parameter for `faderDb` relative to the standard: its gain is (2 x param), applied twice (Console8SubOut),
 *  so dB = 40 log10(param / standard). */
export function faderParam(standard: number, faderDb: number): number {
  const p = standard * 10 ** (faderDb / 40);
  if (!(p > 0 && p <= 1)) throw new Error(`a vocals fader of ${faderDb.toFixed(1)} dB is outside the plugin's range`);
  return p;
}

/** The song's mix overrides without a vocals-fader setting (so a measurement hears the standard vocal level). */
export function withoutVocalFader(overrides: MixOverrides | null, slot: number): MixOverrides | null {
  if (!overrides) return null;
  const vocals = { ...(overrides.buses[VOCALS_BUS] ?? {}) };
  delete vocals[String(slot)];
  const buses = { ...overrides.buses };
  if (Object.keys(vocals).length > 0) buses[VOCALS_BUS] = vocals;
  else delete buses[VOCALS_BUS];
  return { lanes: overrides.lanes, buses };
}

/** The song's mix overrides with the vocals fader set to `faderDb` (relative to the standard). */
export function withVocalFader(overrides: MixOverrides | null, baseConfig: string, faderDb: number): MixOverrides {
  const { slot, standard } = vocalFader(baseConfig);
  const base = overrides ?? { lanes: {}, buses: {} };
  return { lanes: base.lanes, buses: { ...base.buses, [VOCALS_BUS]: { ...(base.buses[VOCALS_BUS] ?? {}), [String(slot)]: [faderParam(standard, faderDb)] } } };
}

/** The fader setting that puts the vocals VOCALS_OVER_BACKING_DB over the backing, within MAX_FADER_DB. */
export function faderFor(vocalsLufs: number, backingLufs: number): number {
  const off = VOCALS_OVER_BACKING_DB - (vocalsLufs - backingLufs);
  return Math.max(-MAX_FADER_DB, Math.min(MAX_FADER_DB, off / FADER_TO_VOCALS));
}

/** Integrated loudness (LUFS) of `full` minus `vocals` (the backing) and of `vocals`, by ffmpeg's EBU R128 meter. */
export async function measureBalance(ffmpegBin: string, full: string, vocals: string): Promise<{ vocalsLufs: number; backingLufs: number }> {
  const lufs = (args: string[], what: string) =>
    new Promise<number>((resolve, reject) => {
      execFile(ffmpegBin, ['-hide_banner', '-nostats', ...args, '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 }, (err, _o, stderr) => {
        if (err) return reject(new Error(`ffmpeg could not measure ${what}: ${stderr.trim().split('\n').slice(-3).join(' ') || err.message}`));
        const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf) LUFS/u.exec(stderr);
        const v = m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN;
        if (!(v > -70)) return reject(new Error(`${what} is silent or unmeasurable (${m?.[1] ?? 'no reading'})`));
        resolve(v);
      });
    });
  const vocalsLufs = await lufs(['-i', vocals, '-af', 'ebur128'], 'the vocals');
  const backingLufs = await lufs(
    ['-i', full, '-i', vocals, '-filter_complex', '[1:a]volume=-1[neg];[0:a][neg]amix=inputs=2:normalize=0:duration=first,ebur128'],
    'the backing',
  );
  return { vocalsLufs, backingLufs };
}

/** Renders the sung song in full and with the vocals alone (standard vocal level), and works out its vocal level. */
export async function levelVocals(o: {
  dir: string;
  canonical: string;
  baseConfig: string;
  overrides: MixOverrides | null;
  ffmpegBin: string;
  renderMix: (dir: string, canonical: string, mixConfig: string, solo?: 'vocals') => Promise<string>;
}): Promise<VocalLevel> {
  const { slot } = vocalFader(o.baseConfig);
  const without = withoutVocalFader(o.overrides, slot);
  const mixConfig = without ? applyMixOverrides(o.baseConfig, without) : o.baseConfig;
  const full = await o.renderMix(join(o.dir, 'full'), o.canonical, mixConfig);
  const vocals = await o.renderMix(join(o.dir, 'vocals'), o.canonical, mixConfig, 'vocals');
  const { vocalsLufs, backingLufs } = await measureBalance(o.ffmpegBin, full, vocals);
  return { vocalsLufs, backingLufs, faderDb: faderFor(vocalsLufs, backingLufs) };
}
