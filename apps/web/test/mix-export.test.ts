import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plain JS modules the engine worker uses (public/engine).
// @ts-expect-error -- untyped ES module
import { encodeMp3, encodeWav24, instantiateLame } from '../public/engine/casperaki-audio-files.js';
// @ts-expect-error -- untyped ES module
import { instantiateEngine, masterSong, masteringProfile } from '../public/engine/casperaki-engine.js';
import { masteringLabel } from '../src/audio/masteringStatus';
import { mixExportStatus } from '../src/export/mixExportProgress';

const publicFile = (p: string) => readFileSync(fileURLToPath(new URL(`../public/${p}`, import.meta.url)));

function int24At(wav: Uint8Array, sample: number): number {
  const o = 44 + sample * 3;
  const v = wav[o]! | (wav[o + 1]! << 8) | (wav[o + 2]! << 16);
  return v & 0x800000 ? v - 0x1000000 : v;
}

describe('encodeWav24', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, 0.5 / 8388608]);
  const right = new Float32Array(left.length);

  it("rounds like casperaki_master's writer (x 2^23, clamped)", () => {
    const wav = encodeWav24(left, right, 44100, 'master');
    expect(wav.length).toBe(44 + left.length * 6);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    const l = (i: number) => int24At(wav, i * 2);
    expect([l(0), l(1), l(2), l(3), l(4), l(5), l(6)]).toEqual([0, 4194304, -4194304, 8388607, -8388608, 8388607, 1]);
  });

  it("rounds like casperaki_render's writer (clamp, x 8388607)", () => {
    const wav = encodeWav24(left, right, 44100, 'render');
    const l = (i: number) => int24At(wav, i * 2);
    expect([l(0), l(1), l(2), l(3), l(4), l(5)]).toEqual([0, 4194304, -4194304, 8388607, -8388607, 8388607]);
  });

  it('refuses an unknown rounding', () => {
    expect(() => encodeWav24(left, right, 44100, 'nearest')).toThrow(/unknown rounding/);
  });
});

describe('encodeMp3 (lame.wasm)', () => {
  it('encodes VBR -V2 with a LAME tag frame first', () => {
    const lame = instantiateLame(publicFile('wasm/lame.wasm'));
    const n = 44100 * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
      r[i] = 0.3 * Math.sin((2 * Math.PI * 660 * i) / 44100);
    }
    const mp3: Uint8Array = encodeMp3(lame, l, r, { sampleRate: 44100, vbrQuality: 2, rounding: 'master', gainDb: -2 });
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1]! & 0xe0).toBe(0xe0);
    const head = new TextDecoder('latin1').decode(mp3.subarray(0, 400));
    expect(head).toMatch(/Xing|Info/);
    expect(head).toContain('LAME3.100');
    // ~2 s at -V2 is tens of kB, far from silence or a raw dump.
    expect(mp3.length).toBeGreaterThan(10_000);
    expect(mp3.length).toBeLessThan(200_000);
    // Every exported MP3 states its level change (room for the codec's peak overshoot).
    expect(() => encodeMp3(lame, l, r, { sampleRate: 44100, vbrQuality: 2, rounding: 'master' } as never)).toThrow(/gainDb is required/);
  });
});

describe('matched mastering (engine-render.wasm)', () => {
  it('masters a short song to the 15 s minimum and serialises its profile', () => {
    const e = instantiateEngine(publicFile('wasm/engine-render.wasm'));
    const n = 44100 * 4;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      l[i] = ((seed / 2 ** 32) * 2 - 1) * 0.2 * Math.sin((2 * Math.PI * 2 * i) / 44100);
      r[i] = l[i]! * 0.8;
    }
    const m = masterSong(e, l, r, 'sergree');
    expect(m.left.length).toBe(15 * 44100);
    let peak = 0;
    for (let i = 0; i < m.left.length; i++) peak = Math.max(peak, Math.abs(m.left[i]), Math.abs(m.right[i]));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
    const bytes: Uint8Array = masteringProfile(e, l, r, 'sergree');
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('CMP1');
    expect(bytes).toEqual(m.profile);
  });
});

describe('status words', () => {
  it('names each mastering mode and shows the failure', () => {
    expect(masteringLabel('matched', undefined)).toEqual({ text: 'Mastered as exported', failed: false });
    expect(masteringLabel('failed', 'boom')).toEqual({ text: 'Matching the master failed: boom (quick master plays)', failed: true });
  });

  it('adds up the export phases', () => {
    expect(mixExportStatus({ phase: 'render', share: 0.5 }).share).toBeCloseTo(0.35);
    expect(mixExportStatus({ phase: 'mp3 mastered', share: 1 })).toEqual({ share: 1, label: 'Encoding the mastered MP3' });
  });
});
