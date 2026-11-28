// The Video tab makes only the 3D avatar video: what it sends, and how it reads the jobs.
import { describe, expect, it } from 'vitest';

import { videoStartBody } from '../src/api/video';
import { jobFor } from '../src/editor/MusicVideoView';

const levels = { versionKey: '0123456789abcdef', binSeconds: 0.5, master: [0.5], tracks: [{ name: 'Vocal', role: 'leadVocal' as const, levels: [0.4] }] };

describe('the Video tab', () => {
  it('sends the measured levels and the avatars, and no style', () => {
    expect(videoStartBody({ orientation: 'landscape', quality: 'preview', artist: 'Me', levels, avatarIds: ['a-1'], storyboard: [{ scene: 'club', avatarIds: ['a-1'], camera: 'auto' }] })).toEqual({
      orientation: 'landscape',
      quality: 'preview',
      artist: 'Me',
      levels,
      avatars: { avatarIds: ['a-1'], storyboard: [{ scene: 'club', avatarIds: ['a-1'], camera: 'auto' }] },
    });
  });

  it('shows no video for a format with no job, without error', () => {
    expect(jobFor({ jobs: { avatars: {} } }, 'landscape')).toBeUndefined();
    expect(jobFor(undefined, 'portrait')).toBeUndefined();
    expect(jobFor({ jobs: { avatars: { portrait: { state: 'done', url: '/v.mp4' } } } }, 'portrait')).toMatchObject({ state: 'done' });
  });
});
