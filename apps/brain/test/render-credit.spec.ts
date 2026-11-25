import { describe, expect, it } from 'vitest';

import { readme } from '../src/export/dawExportService.js';
import { VOCALS_CREDIT } from '../src/export/vocalsCredit.js';
import { mp3EncodeArgs } from '../src/render/renderService.js';

const CREDIT = 'Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0';
const song = (kinds: string[]) => JSON.stringify({ aiArtifacts: kinds.map((kind, i) => ({ id: `a${i}`, kind })) });
const dawSong = (kinds: string[]) => ({ songId: 's', canonical: song(kinds), title: 'T', bpm: 100, sections: [] });

describe('YuE2 credit in exports', () => {
  it('uses the exact credit text', () => expect(VOCALS_CREDIT).toBe(CREDIT));

  it('adds -metadata comment to the MP3 encode only with a yue2 take', () => {
    const withTake = mp3EncodeArgs('in.wav', 'out.mp3', -1, song(['yue2-vocal']));
    const i = withTake.indexOf('-metadata');
    expect(i).toBeGreaterThan(-1);
    expect(withTake[i + 1]).toBe(`comment=${CREDIT}`);
    expect(mp3EncodeArgs('in.wav', 'out.mp3', -1, song(['soulx-vocal']))).not.toContain('-metadata');
    expect(mp3EncodeArgs('in.wav', 'out.mp3', -1, song([]))).not.toContain('-metadata');
  });

  it('puts the credit in the DAW README only with a yue2 take', () => {
    expect(readme(dawSong(['yue2-vocal']), 'reaper', ['Bass'], 10, [])).toContain(CREDIT);
    expect(readme(dawSong([]), 'reaper', ['Bass'], 10, [])).not.toContain('YuE2');
  });
});
