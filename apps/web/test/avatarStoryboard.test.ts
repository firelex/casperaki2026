// The dance floor storyboard's editing (src/editor/avatarStoryboard.ts).
import { describe, expect, it } from 'vitest';

import { sectionLabel, setEntry, storyboardFor, toggleAvatar, useForAll } from '../src/editor/avatarStoryboard';

describe('avatar storyboard', () => {
  it('starts as today’s video: club, everyone, automatic camera', () => {
    expect(storyboardFor(undefined, 2, ['a', 'b'])).toEqual([
      { scene: 'club', avatarIds: ['a', 'b'], camera: 'auto' },
      { scene: 'club', avatarIds: ['a', 'b'], camera: 'auto' },
    ]);
  });
  it('keeps edits, follows the chosen avatars, and never leaves a section empty', () => {
    const edited = [{ scene: 'beach', avatarIds: ['a', 'c'], camera: 'orbit' }, { scene: 'stage', avatarIds: ['c'], camera: 'wide' }];
    expect(storyboardFor(edited, 3, ['a', 'b'])).toEqual([
      { scene: 'beach', avatarIds: ['a'], camera: 'orbit' },
      { scene: 'stage', avatarIds: ['a', 'b'], camera: 'wide' },
      { scene: 'club', avatarIds: ['a', 'b'], camera: 'auto' },
    ]);
  });
  it('toggles avatars (not the last one), sets choices and copies a section to all', () => {
    let b = storyboardFor(undefined, 2, ['a', 'b']);
    b = toggleAvatar(b, 0, 'a');
    expect(b[0]!.avatarIds).toEqual(['b']);
    expect(toggleAvatar(b, 0, 'b')[0]!.avatarIds).toEqual(['b']);
    b = setEntry(b, 0, { scene: 'rooftop', camera: 'low' });
    expect(useForAll(b, 0)).toEqual([
      { scene: 'rooftop', avatarIds: ['b'], camera: 'low' },
      { scene: 'rooftop', avatarIds: ['b'], camera: 'low' },
    ]);
  });
  it('names sections as the brain does', () => {
    expect(sectionLabel('preChorus2')).toBe('Pre-chorus 2');
    expect(sectionLabel('intro')).toBe('Intro');
  });
});
