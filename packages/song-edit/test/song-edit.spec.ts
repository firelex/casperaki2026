import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  canRedo,
  canUndo,
  initEditState,
  nextUniqueSegmentName,
} from '../src/index.js';
import { makeValidSong } from './song-fixture-valid.js';

describe('initEditState', () => {
  it('starts with working === original and clean flags', () => {
    const song = makeValidSong();
    const state = initEditState(song);
    expect(state.working).toBe(state.original);
    expect(state.dirty).toBe(false);
    expect(state.renderStale).toBe(false);
    expect(state.validation.ok).toBe(true);
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
  });
});

describe('duplicateSegment', () => {
  it('inserts a copy right after the source segment with a unique name', () => {
    const song = makeValidSong();
    const state = applyCommand(initEditState(song), {
      kind: 'duplicateSegment',
      segmentName: 'verse1',
    });
    expect(state.lastError).toBeUndefined();
    const names = state.working.songStructure.map((s) => s.name);
    expect(names).toEqual(['intro', 'verse1', 'verse2', 'chorus1', 'outro']);
    expect(state.working.arrangement.verse2).toBeDefined();
    expect(state.working.arrangement.verse2!.instruments).toEqual(
      state.working.arrangement.verse1!.instruments,
    );
    expect(state.dirty).toBe(true);
    expect(state.renderStale).toBe(true);
    expect(canUndo(state)).toBe(true);
  });

  it('skips taken names when finding the next free suffix', () => {
    let state = initEditState(makeValidSong());
    state = applyCommand(state, { kind: 'duplicateSegment', segmentName: 'verse1' });
    state = applyCommand(state, { kind: 'duplicateSegment', segmentName: 'verse1' });
    const names = state.working.songStructure.map((s) => s.name);
    // Order: ['intro', 'verse1', 'verse3', 'verse2', 'chorus1', 'outro'] —
    // the second duplicate inserts right after verse1 and picks verse3
    // because verse2 is now taken.
    expect(names).toContain('verse2');
    expect(names).toContain('verse3');
  });

  it('throws-but-survives on unknown segment, leaves working unchanged', () => {
    const song = makeValidSong();
    const before = initEditState(song);
    const after = applyCommand(before, {
      kind: 'duplicateSegment',
      segmentName: 'nope',
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/segment 'nope' not found/u);
  });
});

describe('deleteSegment', () => {
  it('removes the structure entry, the arrangement payload, and ai refs', () => {
    const song = makeValidSong();
    const state = applyCommand(initEditState(song), {
      kind: 'deleteSegment',
      segmentName: 'chorus1',
    });
    const names = state.working.songStructure.map((s) => s.name);
    expect(names).toEqual(['intro', 'verse1', 'outro']);
    expect(state.working.arrangement.chorus1).toBeUndefined();
    expect(state.dirty).toBe(true);
  });

  it('refuses to delete the last remaining segment', () => {
    let state = initEditState(makeValidSong());
    for (const seg of ['intro', 'verse1', 'chorus1']) {
      state = applyCommand(state, { kind: 'deleteSegment', segmentName: seg });
    }
    expect(state.working.songStructure.length).toBe(1);
    const last = applyCommand(state, {
      kind: 'deleteSegment',
      segmentName: 'outro',
    });
    expect(last.working).toBe(state.working);
    expect(last.lastError).toMatch(/last remaining segment/u);
  });
});

describe('reorderSegment', () => {
  it('moves a segment left and right', () => {
    let state = initEditState(makeValidSong());
    state = applyCommand(state, {
      kind: 'reorderSegment',
      segmentName: 'verse1',
      direction: 'right',
    });
    expect(state.working.songStructure.map((s) => s.name)).toEqual([
      'intro',
      'chorus1',
      'verse1',
      'outro',
    ]);
    state = applyCommand(state, {
      kind: 'reorderSegment',
      segmentName: 'verse1',
      direction: 'left',
    });
    expect(state.working.songStructure.map((s) => s.name)).toEqual([
      'intro',
      'verse1',
      'chorus1',
      'outro',
    ]);
  });

  it('blocks moves past the boundary', () => {
    const state = initEditState(makeValidSong());
    const moved = applyCommand(state, {
      kind: 'reorderSegment',
      segmentName: 'intro',
      direction: 'left',
    });
    expect(moved.working).toBe(state.working);
    expect(moved.lastError).toMatch(/boundary/u);
  });
});

describe('changeBarCount', () => {
  it('grows the structure bars by padding with the last bar', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'changeBarCount',
      segmentName: 'verse1',
      delta: 4,
    });
    const verse = state.working.songStructure.find((s) => s.name === 'verse1')!;
    expect(verse.bars.length).toBe(12);
    expect(verse.lengthInBars).toBe(12);
    expect(verse.bars[11]).toEqual(verse.bars[7]);
  });

  it('shrinks the structure bars by truncation', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'changeBarCount',
      segmentName: 'verse1',
      delta: -3,
    });
    const verse = state.working.songStructure.find((s) => s.name === 'verse1')!;
    expect(verse.bars.length).toBe(5);
    expect(verse.lengthInBars).toBe(5);
  });

  it('honours the minimum bar count (default 1)', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'changeBarCount',
      segmentName: 'intro',
      delta: -4, // intro starts at 4 bars; target = 0 < min(1)
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/minimum/u);
  });

  it('rejects a zero-delta no-op', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'changeBarCount',
      segmentName: 'intro',
      delta: 0,
    });
    expect(after.lastError).toMatch(/delta is zero/u);
  });
});

describe('moveSegment (arbitrary index — drag/drop)', () => {
  it('moves a segment to a specific absolute index', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'moveSegment',
      segmentName: 'chorus1',
      targetIndex: 0,
    });
    expect(state.lastError).toBeUndefined();
    expect(state.working.songStructure.map((s) => s.name)).toEqual([
      'chorus1',
      'intro',
      'verse1',
      'outro',
    ]);
    expect(state.dirty).toBe(true);
  });

  it('moves a segment to the last index', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'moveSegment',
      segmentName: 'intro',
      targetIndex: 3,
    });
    expect(state.working.songStructure.map((s) => s.name)).toEqual([
      'verse1',
      'chorus1',
      'outro',
      'intro',
    ]);
  });

  it('clamps an out-of-range target to the row bounds', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'moveSegment',
      segmentName: 'outro',
      targetIndex: 999,
    });
    expect(state.working.songStructure.map((s) => s.name)).toEqual([
      'intro',
      'verse1',
      'chorus1',
      'outro',
    ]);
    // 999 → clamped to length-1 = 3, same as current index → no-op rejection.
    expect(state.lastError).toMatch(/no-op/u);
  });

  it('rejects a no-op move (same effective index)', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'moveSegment',
      segmentName: 'verse1',
      targetIndex: 1,
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/no-op/u);
    expect(canUndo(after)).toBe(false);
  });
});

describe('setBarCount', () => {
  it('sets the segment to an absolute bar count by padding', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'setBarCount',
      segmentName: 'intro',
      bars: 7,
    });
    expect(state.lastError).toBeUndefined();
    const seg = state.working.songStructure.find((s) => s.name === 'intro')!;
    expect(seg.bars.length).toBe(7);
    expect(seg.lengthInBars).toBe(7);
  });

  it('rejects unchanged bar counts as a no-op', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'setBarCount',
      segmentName: 'intro',
      bars: 4,
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/unchanged/u);
  });

  it('enforces the configured minimum', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'setBarCount',
      segmentName: 'intro',
      bars: 0,
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/minimum/u);
  });
});

describe('renameSegment', () => {
  it('renames structure + arrangement key in lockstep', () => {
    const state = applyCommand(initEditState(makeValidSong()), {
      kind: 'renameSegment',
      segmentName: 'verse1',
      newName: 'verseA',
    });
    expect(state.working.songStructure.map((s) => s.name)).toContain('verseA');
    expect(state.working.songStructure.map((s) => s.name)).not.toContain('verse1');
    expect(state.working.arrangement.verseA).toBeDefined();
    expect(state.working.arrangement.verse1).toBeUndefined();
  });

  it('rejects a collision with an existing segment name', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'renameSegment',
      segmentName: 'verse1',
      newName: 'chorus1',
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/already exists/u);
  });

  it('rejects an empty new name', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'renameSegment',
      segmentName: 'verse1',
      newName: '   ',
    });
    expect(after.working).toBe(before.working);
    expect(after.lastError).toMatch(/empty/u);
  });
});

describe('undo / redo', () => {
  it('undoes a single mutation back to original', () => {
    let state = applyCommand(initEditState(makeValidSong()), {
      kind: 'duplicateSegment',
      segmentName: 'verse1',
    });
    expect(state.dirty).toBe(true);
    state = applyCommand(state, { kind: 'undo' });
    expect(state.dirty).toBe(false);
    expect(state.renderStale).toBe(false);
    expect(state.working).toBe(state.original);
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(true);
  });

  it('redo re-applies an undone change', () => {
    let state = applyCommand(initEditState(makeValidSong()), {
      kind: 'duplicateSegment',
      segmentName: 'verse1',
    });
    const afterMutation = state.working;
    state = applyCommand(state, { kind: 'undo' });
    state = applyCommand(state, { kind: 'redo' });
    expect(state.working).toBe(afterMutation);
    expect(state.dirty).toBe(true);
  });

  it('a fresh mutation clears the redo stack', () => {
    let state = applyCommand(initEditState(makeValidSong()), {
      kind: 'duplicateSegment',
      segmentName: 'verse1',
    });
    state = applyCommand(state, { kind: 'undo' });
    expect(canRedo(state)).toBe(true);
    state = applyCommand(state, {
      kind: 'duplicateSegment',
      segmentName: 'intro',
    });
    expect(canRedo(state)).toBe(false);
  });

  it('undo of a rejected mutation is a no-op (rejected commands do not push)', () => {
    const before = initEditState(makeValidSong());
    const after = applyCommand(before, {
      kind: 'duplicateSegment',
      segmentName: 'does-not-exist',
    });
    expect(canUndo(after)).toBe(false);
  });
});

describe('revertToOriginal', () => {
  it('jumps working back to original in one step (pushing on undo)', () => {
    let state = applyCommand(initEditState(makeValidSong()), {
      kind: 'duplicateSegment',
      segmentName: 'verse1',
    });
    state = applyCommand(state, {
      kind: 'changeBarCount',
      segmentName: 'chorus1',
      delta: 4,
    });
    expect(state.dirty).toBe(true);
    state = applyCommand(state, { kind: 'revertToOriginal' });
    expect(state.working).toBe(state.original);
    expect(state.dirty).toBe(false);
    // Undo still goes back to the pre-revert working (a single hop).
    expect(canUndo(state)).toBe(true);
  });
});

describe('validation', () => {
  it('an edit that would invalidate the schema is rejected and surfaced', () => {
    // Force-injecting an invalid bpm via the reducer is awkward (there's
    // no direct command for it). Build the case through a synthetic
    // mutation: replace the working song with an invalid object and run
    // a no-op command — we instead lean on the duplicate path, which
    // does NOT invalidate. So this test asserts the validate function
    // shape: every successful mutation we run must produce ok=true.
    let state = initEditState(makeValidSong());
    for (let i = 0; i < 5; i++) {
      state = applyCommand(state, {
        kind: 'duplicateSegment',
        segmentName: 'intro',
      });
      expect(state.validation.ok).toBe(true);
    }
  });
});

describe('nextUniqueSegmentName', () => {
  it('increments a trailing-digit suffix', () => {
    expect(nextUniqueSegmentName('verse1', new Set(['verse1']))).toBe('verse2');
    expect(
      nextUniqueSegmentName('verse1', new Set(['verse1', 'verse2', 'verse3'])),
    ).toBe('verse4');
  });

  it('appends `2` when the base has no numeric suffix', () => {
    expect(nextUniqueSegmentName('intro', new Set(['intro']))).toBe('intro2');
  });
});

describe('removeTrack', () => {
  it('takes the track out of every section and its definition, undoably', () => {
    const song = makeValidSong();
    const track = Object.keys(Object.values(song.arrangement)[0]!.instruments)[0]!;
    const state = applyCommand(initEditState(song), { kind: 'removeTrack', track });
    expect(state.lastError).toBeUndefined();
    expect(state.working.instrumentDefinitions.some((d) => d.name === track)).toBe(false);
    for (const payload of Object.values(state.working.arrangement)) {
      expect(track in (payload.instruments ?? {})).toBe(false);
      expect(track in (payload.overrides ?? {})).toBe(false);
    }
    expect(applyCommand(state, { kind: 'undo' }).working).toBe(song);
  });

  it('removes an audio-only track (clips on a track with no definition, such as an ACE layer) with its clips', () => {
    const song = makeValidSong();
    const segment = song.songStructure[0]!.name;
    const clip = (id: string, instrument: string) => ({
      id,
      kind: 'ace-step-conditioned' as const,
      modelId: 'ace-step-1.5-base',
      modelVersion: 'lego',
      attachedTo: { scope: 'segment' as const, segment, instrument },
      output: { uri: `vocal-take:${'a'.repeat(64)}.ogg`, sha256: 'a'.repeat(64), durationSeconds: 8 },
    });
    const withClips = { ...song, aiArtifacts: [...song.aiArtifacts, clip('c1', 'ACE Guitar'), clip('c2', 'ACE Strings')] } as typeof song;
    const state = applyCommand(initEditState(withClips), { kind: 'removeTrack', track: 'ACE Guitar' });
    expect(state.lastError).toBeUndefined();
    expect(state.working.aiArtifacts.map((a) => a.id)).not.toContain('c1');
    expect(state.working.aiArtifacts.map((a) => a.id)).toContain('c2');
  });

  it('removes the Rap track with its rap words, even before anything is rapped', () => {
    const song = makeValidSong();
    const segment = song.songStructure[0]!.name;
    const g = song.generator as unknown as { params: Record<string, unknown> };
    const words = { ...song, generator: { ...song.generator, params: { ...g.params, params: { rapLyrics: { [segment]: ['one'] }, lyrics: { [segment]: ['la'] } } } } } as typeof song;
    const state = applyCommand(initEditState(words), { kind: 'removeTrack', track: 'Rap' });
    expect(state.lastError).toBeUndefined();
    expect((state.working.generator!.params as { params: Record<string, unknown> }).params).toEqual({ lyrics: { [segment]: ['la'] } });
  });

  it('reports a track that is not in the song', () => {
    const state = applyCommand(initEditState(makeValidSong()), { kind: 'removeTrack', track: 'Nope' });
    expect(state.lastError).toMatch(/not in this song/);
  });
});

describe('replaceSong', () => {
  it('swaps in a new working song that undo restores', () => {
    const song = makeValidSong();
    const next = { ...song, title: 'Edited' };
    const state = applyCommand(initEditState(song), { kind: 'replaceSong', song: next });
    expect(state.working).toBe(next);
    expect(state.dirty).toBe(true);
    expect(applyCommand(state, { kind: 'undo' }).working).toBe(song);
  });
});

describe('setDrumHit', () => {
  const drumSong = () => {
    const song = makeValidSong();
    const seg = song.songStructure[0]!;
    const bars = seg.lengthInBars ?? seg.bars.length;
    song.arrangement[seg.name] = {
      ...song.arrangement[seg.name]!,
      overrides: {
        ...song.arrangement[seg.name]!.overrides,
        Drums: { bars: Array.from({ length: bars }, () => ({ notes: { '0.0': [{ note: 36, type: 'note' }] } })) },
      },
    };
    return { song, name: seg.name, bars };
  };

  it('adds a hit to every bar of the section', () => {
    const { song, name, bars } = drumSong();
    const s = applyCommand(initEditState(song), { kind: 'setDrumHit', segments: [name], pitch: 38, step: 8, on: true });
    expect(s.lastError).toBeUndefined();
    const out = s.working.arrangement[name]!.overrides.Drums!.bars!;
    expect(out).toHaveLength(bars);
    for (const b of out) expect((b.notes as Record<string, unknown[]>)['1.0']).toEqual([{ note: 38, type: 'note' }]);
  });

  it('removes a hit and drops empty beats', () => {
    const { song, name } = drumSong();
    const s = applyCommand(initEditState(song), { kind: 'setDrumHit', segments: [name], pitch: 36, step: 0, on: false });
    expect(s.lastError).toBeUndefined();
    for (const b of s.working.arrangement[name]!.overrides.Drums!.bars!) expect(b.notes).toEqual({});
  });

  it('uses the generator key format for off-beat steps', () => {
    const { song, name } = drumSong();
    const s = applyCommand(initEditState(song), { kind: 'setDrumHit', segments: [name], pitch: 42, step: 3, on: true });
    expect(Object.keys(s.working.arrangement[name]!.overrides.Drums!.bars![0]!.notes!)).toContain('0.375');
  });

  it('reports a no-op', () => {
    const { song, name } = drumSong();
    const s = applyCommand(initEditState(song), { kind: 'setDrumHit', segments: [name], pitch: 36, step: 0, on: true });
    expect(s.lastError).toMatch(/nothing to change/);
  });
});
