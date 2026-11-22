import { describe, expect, it } from 'vitest';

import { auditionKind } from '../src/audio/audition';

describe('auditionKind', () => {
  it('plays drum hits as a groove, loops as loops and the rest once', () => {
    expect(auditionKind('kickDrums')).toBe('groove');
    expect(auditionKind('hiHatsClosed')).toBe('groove');
    expect(auditionKind('percussionLoops')).toBe('loop');
    expect(auditionKind('percussionBreaks')).toBe('loop');
    expect(auditionKind('basses')).toBe('loop');
    expect(auditionKind('fx')).toBe('once');
  });
});
