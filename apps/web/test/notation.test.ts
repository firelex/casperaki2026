import { describe, expect, it } from 'vitest';

import { notesToAbc, parseKey } from '../src/editor/sequencer/notation';

const n = (pitch: number, start: number, length: number) => ({ pitch, start, length });
const body = (abc: string, voice: 1 | 2) => abc.split('\n').find((l) => l.startsWith(`[V:${voice}]`))!.slice(6);

describe('notesToAbc', () => {
  it('writes a held chord as one whole-bar chord, on one staff when the part sits on one side', () => {
    const abc = notesToAbc([n(60, 0, 4), n(64, 0, 4), n(67, 0, 4)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('[CEG]16 |]');
    expect(abc).toContain('V:1 clef=treble');
    expect(abc).not.toContain('[V:2]');
    const low = notesToAbc([n(48, 0, 4), n(52, 0, 4)], { beats: 4, key: 'C' });
    expect(low).toContain('V:1 clef=bass');
    expect(body(low, 1)).toBe('[C,E,]16 |]');
  });

  it('splits at middle C onto the grand staff and uses octave marks', () => {
    const abc = notesToAbc([n(48, 0, 4), n(55, 0, 4), n(72, 0, 4)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('c16 |]');
    expect(body(abc, 2)).toBe('[C,G,]16 |]');
  });

  it('fills gaps with rests and ties notes across the barline', () => {
    const abc = notesToAbc([n(62, 1, 1), n(64, 3, 2)], { beats: 8, key: 'C' });
    expect(body(abc, 1)).toBe('z4 D4 z4 E4- | E4 z12 |]');
  });

  it('writes chord symbols above the top staff, splitting a held note where the chord changes', () => {
    const chords = new Map([[0, 'C'], [8, 'Am'], [16, 'F']]);
    const abc = notesToAbc([n(64, 0, 3), n(67, 3, 3)], { beats: 8, key: 'C', chords });
    expect(body(abc, 1)).toBe('"C"E8- "Am"E4 G4- | "F"G8 z8 |]');
  });

  it('quantises slightly early or late onsets to 16ths', () => {
    const abc = notesToAbc([n(60, 0.02, 0.98), n(62, 0.99, 1)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('C4 D4 z8 |]');
  });

  it('spells for the key and only marks accidentals that differ', () => {
    // Eb major: Eb and Bb come from the signature; E natural needs =, and stays natural in the bar.
    const abc = notesToAbc([n(63, 0, 1), n(64, 1, 1), n(64, 2, 1), n(70, 3, 1)], { beats: 4, key: 'Eb' });
    expect(abc).toContain('K:Eb');
    expect(body(abc, 1)).toBe('E4 =E4 E4 B4 |]');
  });

  it('names a note outside the key after the chord sounding with it', () => {
    // Borrowed chords in C: Eb, Ab, Bb over Ab and Bb chords are flats, not D#, G#, A#.
    const borrowed = notesToAbc([n(68, 0, 2), n(72, 2, 2), n(70, 4, 2), n(74, 6, 2)], { beats: 8, key: 'C', chords: new Map([[0, 'Ab'], [16, 'Bb']]) });
    expect(body(borrowed, 1)).toBe('"Ab"_A8 c8 | "Bb"_B8 d8 |]');
    // The leading tone of A minor over E7 is G#; over Fm the same key is Ab.
    const minor = notesToAbc([n(68, 0, 4), n(68, 4, 4)], { beats: 8, key: 'Am', chords: new Map([[0, 'E7'], [16, 'Fm']]) });
    expect(body(minor, 1)).toBe('"E7"^G16 | "Fm"_A16 |]');
  });

  it('without a chord: flats for b3, b6, b7, a sharp for #4, the raised 7th in minor, naturals when they fit', () => {
    expect(body(notesToAbc([n(63, 0, 1), n(66, 1, 1), n(68, 2, 1), n(70, 3, 1)], { beats: 4, key: 'C' }), 1)).toBe('_E4 ^F4 _A4 _B4 |]');
    expect(body(notesToAbc([n(68, 0, 4)], { beats: 4, key: 'Am' }), 1)).toBe('^G16 |]');
    expect(body(notesToAbc([n(65, 0, 4)], { beats: 4, key: 'G' }), 1)).toBe('=F16 |]');
  });

  it('resets accidentals at the barline', () => {
    const abc = notesToAbc([n(66, 0, 4), n(66, 4, 4)], { beats: 8, key: 'C' });
    expect(body(abc, 1)).toBe('^F16 | ^F16 |]');
  });

  it('reads minor and long-form keys', () => {
    expect(parseKey('Am')).toEqual({ abc: 'Am', fifths: 0, minor: true });
    expect(parseKey('F#m').fifths).toBe(3);
    expect(parseKey('Bb major')).toEqual({ abc: 'Bb', fifths: -2, minor: false });
    expect(parseKey('C minor')).toEqual({ abc: 'Cm', fifths: -3, minor: true });
    expect(() => parseKey('H')).toThrow();
  });
});

describe('notesToAbc labels and title', () => {
  it('puts section labels above the first note or rest of their bar', () => {
    const abc = notesToAbc([n(60, 4, 4)], { beats: 8, key: 'C', marks: new Map([[0, 'intro'], [1, 'verse1']]), title: 'Song: Keys' });
    expect(abc).toContain('T:Song: Keys');
    expect(body(abc, 1)).toBe('"^intro"z16 | "^verse1"C16 |]');
  });
});

describe('notesToAbc multi-bar rests', () => {
  it('merges empty bars into multi-bar rests, broken at labelled bars', () => {
    const abc = notesToAbc([n(60, 20, 4)], { beats: 24, key: 'C', marks: new Map([[0, 'intro'], [3, 'verse']]) });
    expect(body(abc, 1)).toBe('"^intro"Z3 | "^verse"Z2 | C16 |]');
  });
});

describe('notesToAbc labels after a rest', () => {
  it('labels a bar that starts with the end of a longer rest', () => {
    const abc = notesToAbc([n(60, 4.5, 3.5)], { beats: 8, key: 'C', marks: new Map([[0, 'a'], [1, 'b']]) });
    expect(body(abc, 1).startsWith('"^a"z16 | "^b"z2 ')).toBe(true);
  });
});

describe('notesToAbc bar numbers', () => {
  it('numbers every bar when asked', () => {
    expect(notesToAbc([n(60, 0, 4)], { beats: 4, key: 'C', barNumbers: true })).toContain('%%barnumbers 1');
    expect(notesToAbc([n(60, 0, 4)], { beats: 4, key: 'C' })).not.toContain('%%barnumbers');
  });
});

describe('notesToAbc lines', () => {
  it('breaks lines every four measures (both staves of a grand staff together)', () => {
    const abc = notesToAbc([n(48, 0, 4), n(72, 0, 4)], { beats: 24, key: 'C' });
    const lines = abc.split('\n').filter((l) => l.startsWith('[V:'));
    expect(lines.map((l) => l.slice(0, 5))).toEqual(['[V:1]', '[V:2]', '[V:1]', '[V:2]']);
    expect(lines[0]!.endsWith(' |')).toBe(true);
    expect(lines[3]!.endsWith(' |]')).toBe(true);
  });
});

describe('notesToAbc: lyrics of a sung part', () => {
  const sung = (pitch: number, start: number, length: number, lyric?: string) => ({ pitch, start, length, ...(lyric !== undefined ? { lyric } : {}) });
  // A phrase across middle C (55..64): one staff, the syllables under it.
  const phrase = [
    sung(60, 0, 0.5, 'Drea-'), sung(57, 0.5, 0.5, 'Ming'), sung(55, 1, 0.5, 'Of'), sung(60, 1.5, 0.5, 'A'),
    sung(64, 2, 3, 'Brand'), // three beats from beat 3: tied across the barline
    sung(62, 5, 1, "I'm"), sung(60, 6, 1),
  ];

  it('keeps the part on one staff and writes a w: line under it', () => {
    const abc = notesToAbc(phrase, { beats: 8, key: 'C' });
    expect(abc).not.toContain('V:2');
    const lines = abc.split('\n');
    const music = lines.findIndex((l) => l.startsWith('[V:1]'));
    expect(lines[music]).toBe("[V:1] C2 A,2 G,2 C2 E8- | E4 D4 C4 z4 |]");
    expect(lines[music + 1]).toBe("w: drea-ming of a brand _ I'm *");
  });

  it('puts each syllable under its note, holds it over tied notes and skips notes without one', async () => {
    const abcjs = (await import('abcjs')).default;
    const [tune] = abcjs.parseOnly(notesToAbc(phrase, { beats: 8, key: 'C' }));
    const sungNotes: { pitch: string; lyric: string | undefined }[] = [];
    for (const line of tune!.lines) for (const staff of line.staff ?? []) for (const voice of staff.voices ?? []) for (const el of voice) {
      const e = el as { el_type: string; rest?: unknown; pitches?: { name: string }[]; lyric?: { syllable: string }[] };
      if (e.el_type === 'note' && !e.rest) sungNotes.push({ pitch: e.pitches![0]!.name, lyric: e.lyric?.[0]?.syllable });
    }
    expect(sungNotes.map((x) => x.lyric ?? '')).toEqual(['drea', 'ming', 'of', 'a', 'brand', '', "I'm", '']);
  });

  it('leaves parts without lyrics as they were', () => {
    expect(notesToAbc([n(60, 0, 4)], { beats: 4, key: 'C' })).not.toContain('w:');
  });
});
