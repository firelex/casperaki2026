// docs/54l multisample-resolver specs.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMultisampleResolverCache,
  loadFamilyTimingMap,
  loadTiming,
  resolveMultisampleSlots,
} from '../scripts/lib/multisample-resolver.mjs';

interface H {
  dir: string;
}

async function setupHarness(content: {
  familyMap?: Record<string, string>;
  timings?: Record<string, Array<{ start: string; end: string; type: string; note: string }>>;
}): Promise<H> {
  const dir = await mkdtemp(join(tmpdir(), 'casperaki-multisample-'));
  await mkdir(dir, { recursive: true });
  if (content.familyMap !== undefined) {
    await writeFile(
      join(dir, 'family-timing-map.json'),
      JSON.stringify({ $schemaVersion: 1, families: content.familyMap }),
    );
  }
  for (const [name, timing] of Object.entries(content.timings ?? {})) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify(timing));
  }
  _resetMultisampleResolverCache();
  return { dir };
}

afterEach(() => _resetMultisampleResolverCache());

describe('loadFamilyTimingMap + loadTiming (synthetic data dir)', () => {
  it('reads families from family-timing-map.json', async () => {
    const h = await setupHarness({
      familyMap: { basses: 'bassNotes', keys: 'pianoNotes' },
      timings: { bassNotes: [], pianoNotes: [] },
    });
    try {
      const map = loadFamilyTimingMap({ dataDir: h.dir });
      expect(map.basses).toBe('bassNotes');
      expect(map.keys).toBe('pianoNotes');
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('throws when timing JSON is not an array', async () => {
    const h = await setupHarness({});
    await writeFile(join(h.dir, 'broken.json'), JSON.stringify({ not: 'array' }));
    try {
      expect(() => loadTiming('broken', { dataDir: h.dir })).toThrow();
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMultisampleSlots — happy path (piano 17-note timing)', () => {
  let h: H;
  beforeEach(async () => {
    h = await setupHarness({
      familyMap: { keys: 'pianoNotes' },
      timings: {
        pianoNotes: [
          { start: '00.00',    end: '00.04.80', type: 'longNote', note: 'c2' },
          { start: '00.04.80', end: '00.09.60', type: 'longNote', note: 'd#2' },
          { start: '00.09.60', end: '00.14.40', type: 'longNote', note: 'f#2' },
        ],
      },
    });
  });
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true });
  });

  it('maps every slot to its matching (note, type) timing', () => {
    const res = resolveMultisampleSlots({
      family: 'keys',
      samples: [
        { id: 100, note: 'c2',  type: 'longNote' },
        { id: 101, note: 'd#2', type: 'longNote' },
        { id: 102, note: 'f#2', type: 'longNote' },
      ],
      dataDir: h.dir,
    });
    expect(res.timingName).toBe('pianoNotes');
    expect(res.resolvedCount).toBe(3);
    expect(res.unresolvedCount).toBe(0);
    expect(res.slots.map((s) => s.status)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(res.slots[0]).toMatchObject({
      slot: { id: 100, note: 'c2', type: 'longNote' },
      status: 'resolved',
      sliceStart: 0,
      sliceEnd: 4.8,
    });
    expect(res.slots[1]).toMatchObject({ sliceStart: 4.8, sliceEnd: 9.6 });
  });

  it('reports unresolved for a slot whose (note, type) is absent', () => {
    const res = resolveMultisampleSlots({
      family: 'keys',
      samples: [
        { id: 100, note: 'c2',  type: 'longNote' },
        { id: 101, note: 'c7',  type: 'longNote' },   // out of timing range
        { id: 102, note: 'd#2', type: 'shortNote' },  // type mismatch
      ],
      dataDir: h.dir,
    });
    expect(res.resolvedCount).toBe(1);
    expect(res.unresolvedCount).toBe(2);
    expect(res.slots[1].status).toBe('unresolved');
    expect(res.slots[2].status).toBe('unresolved');
  });

  it('returns family-level reason when family has no timing JSON', () => {
    const res = resolveMultisampleSlots({
      family: 'drumKits',
      samples: [{ id: 1, note: 'c4', type: 'longNote' }],
      dataDir: h.dir,
    });
    expect(res.timingName).toBeNull();
    expect(res.resolvedCount).toBe(0);
    expect(res.unresolvedCount).toBe(1);
    expect(res.reason).toMatch(/not in the timing map/u);
  });
});

describe('resolveMultisampleSlots — bass 8 longNote + 8 shortNote (duplicate notes by type)', () => {
  let h: H;
  beforeEach(async () => {
    h = await setupHarness({
      familyMap: { basses: 'bassNotes' },
      timings: {
        bassNotes: [
          { start: '00.00.50', end: '00.04.50', type: 'longNote',  note: 'c2' },
          { start: '00.04.50', end: '00.08.50', type: 'longNote',  note: 'd#2' },
          { start: '00.30.50', end: '00.30.75', type: 'shortNote', note: 'c2' },
          { start: '00.30.75', end: '00.31.00', type: 'shortNote', note: 'd#2' },
        ],
      },
    });
  });
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true });
  });

  it('matches per (note, type) — long slots get long timings, short slots get short', () => {
    const res = resolveMultisampleSlots({
      family: 'basses',
      samples: [
        { id: 945, note: 'c2',  type: 'longNote' },
        { id: 946, note: 'd#2', type: 'longNote' },
        { id: 953, note: 'c2',  type: 'shortNote' },
        { id: 954, note: 'd#2', type: 'shortNote' },
      ],
      dataDir: h.dir,
    });
    expect(res.resolvedCount).toBe(4);
    expect(res.slots[0]).toMatchObject({ sliceStart: 0.5, sliceEnd: 4.5 });
    expect(res.slots[2]).toMatchObject({ sliceStart: 30.5, sliceEnd: 30.75 });
    // Slot 0 and slot 2 share note "c2" but have different types — they
    // resolve to DIFFERENT slices.
    expect(res.slots[0].status === 'resolved' && res.slots[2].status === 'resolved').toBe(true);
    if (res.slots[0].status === 'resolved' && res.slots[2].status === 'resolved') {
      expect(res.slots[0].sliceStart).not.toBe(res.slots[2].sliceStart);
    }
  });

  it('exhausts the timing queue per (note, type) — a second long-c2 slot is unresolved', () => {
    const res = resolveMultisampleSlots({
      family: 'basses',
      samples: [
        { id: 945, note: 'c2', type: 'longNote' },
        { id: 999, note: 'c2', type: 'longNote' }, // second long-c2 — no second timing entry exists
      ],
      dataDir: h.dir,
    });
    expect(res.slots[0].status).toBe('resolved');
    expect(res.slots[1].status).toBe('unresolved');
  });
});

describe('resolveMultisampleSlots — guitarNotes IGNORE filter', () => {
  let h: H;
  beforeEach(async () => {
    h = await setupHarness({
      familyMap: { electricGuitars: 'guitarNotes' },
      timings: {
        guitarNotes: [
          { start: '00.01.20', end: '00.06',     type: 'longNote',  note: 'e2' },
          { start: '00.42',    end: '00.45',     type: 'IGNORE',    note: 'IGNORE' },
          { start: '00.45',    end: '00.48',     type: 'shortNote', note: 'e2' },
        ],
      },
    });
  });
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true });
  });

  it('skips IGNORE entries (mirrors legacy mp3split filter)', () => {
    const res = resolveMultisampleSlots({
      family: 'electricGuitars',
      samples: [
        { id: 1, note: 'e2', type: 'longNote' },
        { id: 2, note: 'e2', type: 'shortNote' },
      ],
      dataDir: h.dir,
    });
    expect(res.resolvedCount).toBe(2);
    expect(res.slots[0]).toMatchObject({ sliceStart: 1.2, sliceEnd: 6 });
    expect(res.slots[1]).toMatchObject({ sliceStart: 45, sliceEnd: 48 });
  });
});

describe('resolveMultisampleSlots — production data sanity (real timing JSONs)', () => {
  it('pianoNotes covers the 17 inst-3.json slots c2..c6 with longNote', () => {
    const samples = [
      { id: 2048, note: 'c2',  type: 'longNote' },
      { id: 2049, note: 'd#2', type: 'longNote' },
      { id: 2050, note: 'f#2', type: 'longNote' },
      { id: 2051, note: 'a2',  type: 'longNote' },
      { id: 2052, note: 'c3',  type: 'longNote' },
      { id: 2053, note: 'd#3', type: 'longNote' },
      { id: 2054, note: 'f#3', type: 'longNote' },
      { id: 2055, note: 'a3',  type: 'longNote' },
      { id: 2056, note: 'c4',  type: 'longNote' },
      { id: 2057, note: 'd#4', type: 'longNote' },
      { id: 2058, note: 'f#4', type: 'longNote' },
      { id: 2059, note: 'a4',  type: 'longNote' },
      { id: 2060, note: 'c5',  type: 'longNote' },
      { id: 2061, note: 'd#5', type: 'longNote' },
      { id: 2062, note: 'f#5', type: 'longNote' },
      { id: 2063, note: 'a5',  type: 'longNote' },
      { id: 2064, note: 'c6',  type: 'longNote' },
    ];
    const res = resolveMultisampleSlots({ family: 'keys', samples });
    expect(res.timingName).toBe('pianoNotes');
    expect(res.resolvedCount).toBe(17);
    expect(res.unresolvedCount).toBe(0);
  });

  it('bassNotes covers the 16 inst-2.json slots (8 long + 8 short, c2..a3)', () => {
    const noteRow = ['c2','d#2','f#2','a2','c3','d#3','f#3','a3'] as const;
    const samples = [
      ...noteRow.map((n, i) => ({ id: 945 + i, note: n, type: 'longNote' })),
      ...noteRow.map((n, i) => ({ id: 953 + i, note: n, type: 'shortNote' })),
    ];
    const res = resolveMultisampleSlots({ family: 'basses', samples });
    expect(res.timingName).toBe('bassNotes');
    expect(res.resolvedCount).toBe(16);
    expect(res.unresolvedCount).toBe(0);
  });

  it('popStrings maps to padAndSynthNotes (musical convention)', () => {
    const res = resolveMultisampleSlots({
      family: 'popStrings',
      samples: [{ id: 3153, note: 'c2', type: 'longNote' }],
    });
    expect(res.timingName).toBe('padAndSynthNotes');
    expect(res.resolvedCount).toBe(1);
  });

  it('drum families are intentionally absent from the timing map', () => {
    const res = resolveMultisampleSlots({
      family: 'kickDrums',
      samples: [{ id: 1, note: 'c2', type: 'longNote' }],
    });
    expect(res.timingName).toBeNull();
    expect(res.reason).toMatch(/not in the timing map/u);
  });
});

describe('a recording that does not start on the timing table first note (owner 2026-11-28: "offset the notes in the player")', () => {
  const timing = ['c2', 'd#2', 'f#2', 'a2', 'c3', 'd#3'].map((note, i) => ({ start: `00.${String(i * 4).padStart(2, '0')}.50`, end: `00.${String(i * 4 + 4).padStart(2, '0')}.50`, type: 'longNote', note }));
  const samples = [{ id: 1, note: 'c2', type: 'longNote' }, { id: 2, note: 'd#2', type: 'longNote' }, { id: 3, note: 'c3', type: 'longNote' }, { id: 4, note: 'd#3', type: 'longNote' }];

  it('starting on F# (two slices of three semitones before C): every slot takes the slice two further on', () => {
    const res = resolveMultisampleSlots({ family: 'basses', samples, familyTimingMap: { basses: 'bassNotes' }, loadTimingForName: () => timing, firstNote: 'F#' });
    // the slots past the recording's top stay empty: no note is re-pitched to stand in (owner 2026-11-28)
    expect(res.slots.map((s) => (s.status === 'resolved' ? s.sliceStart : s.status))).toEqual([8.5, 12.5, 'unresolved', 'unresolved']);
    // ... and are marked as past the recording, so the lowering drops them and the sampler stretches its top real note
    // over them (owner 2026-11-28 "for the missing note, yes, stretch"), never the placeholder sound
    expect(res.slots.map((s) => Boolean(s.pastRecording))).toEqual([false, false, true, true]);
  });

  it('a recording measured out of tune carries its correction on every resolved slot (tuneCents, owner 2026-11-28)', () => {
    const res = resolveMultisampleSlots({ family: 'basses', samples, familyTimingMap: { basses: 'bassNotes' }, loadTimingForName: () => timing, firstNote: 'F#', tuneCents: 13 });
    expect(res.slots.map((s) => (s.status === 'resolved' ? s.tuneCents : null))).toEqual([13, 13, null, null]);
  });

  it('a first note off the three-semitone grid is refused, naming it', () => {
    expect(() => resolveMultisampleSlots({ family: 'basses', samples, familyTimingMap: { basses: 'bassNotes' }, loadTimingForName: () => timing, firstNote: 'D' })).toThrow(/D/u);
  });

  it('starting on C (or no first note given): as before', () => {
    const res = resolveMultisampleSlots({ family: 'basses', samples, familyTimingMap: { basses: 'bassNotes' }, loadTimingForName: () => timing, firstNote: 'C' });
    expect(res.slots.map((s) => (s.status === 'resolved' ? s.sliceStart : s.status))).toEqual([0.5, 4.5, 16.5, 20.5]);
  });
});
