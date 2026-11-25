// The vocal level that follows the backing (src/sing/vocalLevel.ts): the fader maths, the song's mix settings, and the
// loudness measurement of the vocals and the backing (full minus vocals).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMixOverrides } from '@casperaki/song-schema';

import { FADER_TO_VOCALS, faderFor, faderParam, MAX_FADER_DB, measureBalance, VOCALS_OVER_BACKING_DB, vocalFader, withoutVocalFader, withVocalFader } from '../src/sing/vocalLevel.js';

const BASE = readFileSync('/home/roli79/apps/casperaki_engine/config/mix-config.json', 'utf8');

/** 16-bit stereo WAV, 44.1 kHz: a sine of `hz` at `amp`, `seconds` long. */
function wav(path: string, hz: number, amp: number, seconds = 4) {
  const rate = 44100, n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
  writeFileSync(path, buf);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vocal-level-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the vocal level', () => {
  it('moves the fader so the vocals sit VOCALS_OVER_BACKING_DB over the backing, within its limits', () => {
    expect(faderFor(-12 + VOCALS_OVER_BACKING_DB, -12)).toBeCloseTo(0, 9);
    // Marigold Static: vocals 4.2 dB over the backing, 2.2 dB too loud.
    expect(faderFor(-10.2, -14.4)).toBeCloseTo(-2.2 / FADER_TO_VOCALS, 6);
    expect(faderFor(-40, -10)).toBe(MAX_FADER_DB);
    expect(faderFor(0, -40)).toBe(-MAX_FADER_DB);
  });

  it('writes the vocals fader into the song mix, relative to the standard, and leaves other settings alone', () => {
    const { slot, standard } = vocalFader(BASE);
    expect(faderParam(standard, 0)).toBeCloseTo(standard, 9);
    const bassSlot1 = (JSON.parse(BASE) as { rackChains: { bus: string; plugins: { params: number[] }[] }[] }).rackChains.find((c) => c.bus === 'bass')!.plugins[1]!.params.map(() => 0.3);
    const mine = { lanes: { Keys: { volumeDb: -2 } }, buses: { bass: { '1': bassSlot1 } } };
    const set = withVocalFader(mine as never, BASE, -3.3);
    expect(set.lanes).toEqual(mine.lanes);
    expect(set.buses['bass']).toEqual({ '1': bassSlot1 });
    expect(set.buses['vocals']![String(slot)]![0]).toBeCloseTo(standard * 10 ** (-3.3 / 40), 9);
    JSON.parse(applyMixOverrides(BASE, set)); // a valid mix
    expect(withoutVocalFader(set, slot)).toEqual({ lanes: mine.lanes, buses: { bass: { '1': bassSlot1 } } });
  });

  it('measures the vocals and the backing (full minus vocals)', async () => {
    // The backing: a 220 Hz tone at 0.2; the vocals: a 660 Hz tone at 0.1 (6 dB under, a little more by the meter's
    // weighting); the full mix is both.
    const rate = 44100, n = 4 * rate;
    wav(join(dir, 'vocals.wav'), 660, 0.1);
    wav(join(dir, 'backing.wav'), 220, 0.2);
    const full = Buffer.from(readFileSync(join(dir, 'backing.wav')));
    const v = readFileSync(join(dir, 'vocals.wav'));
    for (let i = 0; i < n * 2; i++) full.writeInt16LE(full.readInt16LE(44 + i * 2) + v.readInt16LE(44 + i * 2), 44 + i * 2);
    writeFileSync(join(dir, 'full.wav'), full);
    const m = await measureBalance('ffmpeg', join(dir, 'full.wav'), join(dir, 'vocals.wav'));
    const alone = await measureBalance('ffmpeg', join(dir, 'backing.wav'), join(dir, 'silent-not-used.wav')).catch((e: Error) => e);
    expect(alone).toBeInstanceOf(Error);
    expect(m.vocalsLufs).toBeLessThan(m.backingLufs);
    expect(m.backingLufs - m.vocalsLufs).toBeGreaterThan(4);
    expect(m.backingLufs - m.vocalsLufs).toBeLessThan(9);
  });
});
