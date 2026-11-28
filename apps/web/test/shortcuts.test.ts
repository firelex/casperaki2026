import { describe, expect, it } from 'vitest';

import { togglesFollow, type KeyPress } from '../src/editor/shortcuts';

const press = (over: Partial<KeyPress> = {}): KeyPress => ({ code: 'KeyF', ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tagName: 'DIV' }, ...over });

describe('the F key toggles Follow playhead', () => {
  it('F alone toggles', () => expect(togglesFollow(press())).toBe(true));
  it('another key does not', () => expect(togglesFollow(press({ code: 'KeyG' }))).toBe(false));
  it('with Ctrl, Cmd or Alt it is another shortcut', () => {
    expect(togglesFollow(press({ ctrlKey: true }))).toBe(false);
    expect(togglesFollow(press({ metaKey: true }))).toBe(false);
    expect(togglesFollow(press({ altKey: true }))).toBe(false);
  });
  it('typing an f in a field is typing', () => {
    expect(togglesFollow(press({ target: { tagName: 'INPUT' } }))).toBe(false);
    expect(togglesFollow(press({ target: { tagName: 'textarea' } }))).toBe(false);
    expect(togglesFollow(press({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
  });
  it('holding the key toggles once', () => expect(togglesFollow(press({ repeat: true }))).toBe(false));
});
