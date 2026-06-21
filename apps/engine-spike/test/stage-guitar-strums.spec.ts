// docs/54m — guitar chord-strum staging unit tests.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chordFileBasename,
  chordTypeToFileSuffix,
  stageGuitarStrums,
} from '../scripts/lib/stage-guitar-strums.mjs';

describe('chordTypeToFileSuffix', () => {
  it('decodes all four legacy strum types', () => {
    expect(chordTypeToFileSuffix('chordLongStrumDown')).toBe('Long Strum Down');
    expect(chordTypeToFileSuffix('chordLongStrumUp')).toBe('Long Strum Up');
    expect(chordTypeToFileSuffix('chordShortStrumDown')).toBe('Short Strum Down');
    expect(chordTypeToFileSuffix('chordShortStrumUp')).toBe('Short Strum Up');
  });
  it('returns undefined for unknown types', () => {
    expect(chordTypeToFileSuffix('fx')).toBeUndefined();
    expect(chordTypeToFileSuffix('chordMutedStrumDown')).toBeUndefined();
    expect(chordTypeToFileSuffix('garbage')).toBeUndefined();
  });
});

describe('chordFileBasename', () => {
  it('matches the legacy chords/ folder naming exactly', () => {
    expect(chordFileBasename({ chord: 'C',   chordPosition: '1', type: 'chordLongStrumDown'  })).toBe('C _ Pos 1 _ Long Strum Down.mp3');
    expect(chordFileBasename({ chord: 'Am',  chordPosition: '2', type: 'chordShortStrumUp'   })).toBe('Am _ Pos 2 _ Short Strum Up.mp3');
    expect(chordFileBasename({ chord: 'F#m7',chordPosition: '3', type: 'chordLongStrumUp'    })).toBe('F#m7 _ Pos 3 _ Long Strum Up.mp3');
    expect(chordFileBasename({ chord: 'Bb',  chordPosition: '4', type: 'chordShortStrumDown' })).toBe('Bb _ Pos 4 _ Short Strum Down.mp3');
  });
  it('accepts numeric chordPosition (engine sometimes sends int)', () => {
    expect(chordFileBasename({ chord: 'C', chordPosition: 1 as unknown as string, type: 'chordLongStrumDown' }))
      .toBe('C _ Pos 1 _ Long Strum Down.mp3');
  });
  it('returns undefined for fx / unknown types', () => {
    expect(chordFileBasename({ chord: 'C', chordPosition: '1', type: 'fx' })).toBeUndefined();
  });
});

interface H {
  tmp: string;
  chordsAbsDir: string;
  tempDir: string;
  cacheDir: string;
}
async function setup(): Promise<H> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-strums-'));
  const chordsAbsDir = join(tmp, 'lib/chords');
  const tempDir = join(tmp, 'juce-temp');
  const cacheDir = join(tmp, 'cache');
  await mkdir(chordsAbsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  return { tmp, chordsAbsDir, tempDir, cacheDir };
}
let h: H;
beforeEach(async () => { h = await setup(); });
afterEach(() => rm(h.tmp, { recursive: true, force: true }));

describe('stageGuitarStrums', () => {
  it('stages one playsample-<id>.ogg per entry from chords/ folder', async () => {
    // Create three chord files on disk.
    await writeFile(join(h.chordsAbsDir, 'C _ Pos 1 _ Long Strum Down.mp3'), 'C-long-down');
    await writeFile(join(h.chordsAbsDir, 'C _ Pos 1 _ Short Strum Up.mp3'),  'C-short-up');
    await writeFile(join(h.chordsAbsDir, 'Am _ Pos 2 _ Long Strum Up.mp3'),  'Am-long-up');

    const result = stageGuitarStrums({
      entries: [
        { id: 5200, chord: 'C',  chordPosition: '1', type: 'chordLongStrumDown' },
        { id: 5201, chord: 'C',  chordPosition: '1', type: 'chordShortStrumUp'  },
        { id: 5202, chord: 'Am', chordPosition: '2', type: 'chordLongStrumUp'   },
      ],
      chordsAbsDir: h.chordsAbsDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: ({ sourcePath, cacheDir }) => {
        // mock ffmpeg — produce a transcoded output with deterministic bytes per source
        const out = join(cacheDir, `cache-${Buffer.from(sourcePath).toString('hex').slice(-8)}.ogg`);
        writeFileSync(out, `transcoded:${sourcePath.split('/').pop()}`);
        return { kind: 'transcoded', preparedPath: out, sourceFormat: 'mp3', cached: false, byteSize: 32 };
      },
    });

    expect(result.realCount).toBe(3);
    expect(result.skipped).toBe(0);
    // Each slot must carry DIFFERENT bytes (no fanout).
    const bytes = await Promise.all([
      readFile(join(h.tempDir, 'playsample-5200.ogg'), 'utf-8'),
      readFile(join(h.tempDir, 'playsample-5201.ogg'), 'utf-8'),
      readFile(join(h.tempDir, 'playsample-5202.ogg'), 'utf-8'),
    ]);
    expect(new Set(bytes).size).toBe(3);
    expect(bytes[0]).toContain('Long Strum Down');
    expect(bytes[1]).toContain('Short Strum Up');
    expect(bytes[2]).toContain('Long Strum Up');
  });

  it('skips entries whose chord file is missing — with precise fallback reason', () => {
    const result = stageGuitarStrums({
      entries: [{ id: 5200, chord: 'C', chordPosition: '1', type: 'chordLongStrumDown' }],
      chordsAbsDir: h.chordsAbsDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
    });
    expect(result.realCount).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]?.kind).toBe('no-source');
    expect(result.entries[0]?.fallbackReason).toMatch(/not found/u);
  });

  it('skips entries with unsupported types (no silent fanout)', () => {
    const result = stageGuitarStrums({
      entries: [{ id: 5200, chord: 'C', chordPosition: '1', type: 'fx' }],
      chordsAbsDir: h.chordsAbsDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
    });
    expect(result.realCount).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]?.fallbackReason).toMatch(/unsupported type/u);
  });

  it('skips entries when normalisation fails (no-ffmpeg / error)', async () => {
    await writeFile(join(h.chordsAbsDir, 'C _ Pos 1 _ Long Strum Down.mp3'), 'bytes');
    const result = stageGuitarStrums({
      entries: [{ id: 5200, chord: 'C', chordPosition: '1', type: 'chordLongStrumDown' }],
      chordsAbsDir: h.chordsAbsDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: () => ({ kind: 'no-ffmpeg', sourceFormat: 'mp3', error: 'no ffmpeg' }),
    });
    expect(result.realCount).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]?.fallbackReason).toMatch(/normalisation failed/u);
  });
});
