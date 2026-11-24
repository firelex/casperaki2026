import { describe, expect, it } from 'vitest';

import { parseHookText } from '../src/vocals/hook-text.js';

const ok = `
# a comment
hook: Test Anthem
type: Chorus
tempo: 90-130
feel: anthem
chords: C | G | Am F | G | C | G | Am F | G C
melody: e4:1 g4:1 c5:2 | b4:1 g4:1 d5:2 | c5:1 a4:1 c5:1 a4:1 | b4:4- | b4:2 r:2 |
        b4:1 g4:1 d5:2 | c5:1 a4:1 c5:1 a4:1 | b4:2 c5:2 |
`;

describe('parseHookText', () => {
  it('turns a hook into a bank entry in the banks register (sung C4 = bank midi 48, named "c4")', () => {
    const { hooks, errors } = parseHookText(ok, 'test');
    expect(errors).toEqual([]);
    expect(hooks).toHaveLength(1);
    const h = hooks[0]!;
    expect(h.id).toBe('test-01');
    expect(h.properties).toMatchObject({ name: 'Test Anthem', type: 'Chorus', kind: 'hook', tempoMin: 90, tempoMax: 130, feel: 'anthem', start: 0, end: 8, key: 'C', originalKey: 'C' });
    expect(h.melody['0.0']).toEqual([{ note: 'e4', midi: 52, duration: 1 }]);
    // b4:4- | b4:2 is one note of 6 beats from beat 12.
    expect(h.melody['12.0']).toEqual([{ note: 'b4', midi: 59, duration: 6 }]);
    expect(h.melody['16.0']).toBeUndefined();
    expect(Object.keys(h.chords)).toHaveLength(32);
    expect(h.chords['8.0']).toEqual({ chord: 'Am' });
    expect(h.chords['10.0']).toEqual({ chord: 'F' });
    expect(h.chords['31.0']).toEqual({ chord: 'C' });
    expect(h.properties.lowestNote).toBe(52);
    expect(h.properties.highestNote).toBe(62);
    expect(h.properties.busyness).toBeCloseTo(20 / 8);
  });

  it('names what is wrong: length, barlines, chords, register', () => {
    const bad = (body: string) => parseHookText(`hook: X\ntype: Verse\ntempo: 80-120\nfeel: tender\n${body}`, 'b').errors.join('\n');
    expect(bad('chords: C | C | C | C | C | C | C | C\nmelody: c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 |')).toMatch(/28 beats, not 32/);
    expect(bad('chords: C | C | C | C | C | C | C | C\nmelody: c4:3 | c4:5 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 |')).toMatch(/barline at beat 3/);
    expect(bad('chords: C | Cxyz | C | C | C | C | C | C\nmelody: c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 |')).toMatch(/Cxyz/);
    expect(bad('chords: C | C | C | C | C | C | C | C\nmelody: c3:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 | c4:4 |')).toMatch(/C3 is below/);
  });

  it('checks the music: chord tones on strong beats, notes in the key', () => {
    const r = parseHookText(
      `hook: Clash\ntype: Verse\ntempo: 80-120\nfeel: tender\nchords: C | C | C | C | C | C | C | C\nmelody: d4:2 f4:2 | d4:2 f4:2 | d4:2 f4:2 | d4:2 f4:2 | d4:2 f4:2 | d4:2 f4:2 | d4:2 f4:2 | d4:2 c#4:1 c4:1 |`,
      'm',
    );
    expect(r.errors.join('\n')).toMatch(/strong beats/);
    expect(r.errors.join('\n')).toMatch(/does not end on a chord tone|chord tone/);
  });

  it('a lead-in bar makes a 9-bar entry starting at bar 1', () => {
    const r = parseHookText(
      `hook: Pickup\ntype: Verse\ntempo: 80-120\nfeel: tender\nleadin: yes\nchords: C | C | F | G | C | C | F | G | C\nmelody: r:3 g3:1 | c4:2 e4:2 | f4:2 a4:2 | g4:2 d4:2 | e4:4 | c4:2 e4:2 | f4:2 a4:2 | g4:2 b3:2 | c4:4 |`,
      'p',
    );
    expect(r.errors).toEqual([]);
    expect(r.hooks[0]!.properties).toMatchObject({ start: 1, end: 9 });
    expect(Object.keys(r.hooks[0]!.chords)).toHaveLength(36);
  });

  it('a style tag is kept, checked, and tightens the range', () => {
    const styled = parseHookText(ok.replace('feel: anthem', 'feel: anthem\nstyle: edm'), 's');
    expect(styled.errors).toEqual([]);
    expect(styled.hooks[0]!.properties.style).toBe('edm');
    expect(parseHookText(ok, 's').hooks[0]!.properties.style).toBeUndefined();
    expect(parseHookText(ok.replace('feel: anthem', 'feel: anthem\nstyle: disco'), 's').errors.join('\n')).toMatch(/style "disco"/);
    const high = ok.replace('feel: anthem', 'feel: anthem\nstyle: rock').replace('b4:1 g4:1 d5:2 | c5', 'b4:1 g4:1 f5:2 | c5');
    expect(parseHookText(high, 's').errors.join('\n')).toMatch(/F5 is above E5/);
  });

  it('a substyle is kept and needs a style', () => {
    const r = parseHookText(ok.replace('feel: anthem', 'feel: anthem\nstyle: brightPop\nsubstyle: nu-disco'), 's');
    expect(r.errors).toEqual([]);
    expect(r.hooks[0]!.properties.substyle).toBe('nu-disco');
    expect(parseHookText(ok.replace('feel: anthem', 'feel: anthem\nsubstyle: disco'), 's').errors.join('\n')).toMatch(/needs a style/);
    expect(parseHookText(ok.replace('feel: anthem', 'feel: anthem\nstyle: edm\nsubstyle: Big Room'), 's').errors.join('\n')).toMatch(/short lowercase/);
  });

  it('refuses the same melody twice', () => {
    const r = parseHookText(ok + ok.replace('Test Anthem', 'Other'), 'd');
    expect(r.errors.join('\n')).toMatch(/same melody as/);
  });
});
