import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlaybackService } from '../src/render/playbackService.js';

/** Stand-in playback: the "emit" writes a one-lane envelope (a bass
 *  multisample with two slots, one drum lane), the "ffmpeg" writes its
 *  arguments into the output file so slicing can be checked. */
export function fakePlayback(): PlaybackService {
  const dir = mkdtempSync(join(tmpdir(), 'casperaki-playback-test-'));
  const lib = join(dir, 'library');
  mkdirSync(join(lib, 'basses'), { recursive: true });
  mkdirSync(join(lib, 'kicks'), { recursive: true });
  writeFileSync(join(lib, 'basses', 'bass.mp3'), 'mp3');
  writeFileSync(join(lib, 'kicks', 'kick.mp3'), 'mp3');
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs);
  for (const n of ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg']) writeFileSync(join(stubs, n), 'ogg');
  const emit = join(dir, 'emit.mjs');
  writeFileSync(
    emit,
    `import { writeFileSync } from 'node:fs';
const o = process.env.OUT_DIR;
writeFileSync(o + '/song.json', JSON.stringify({ song: true }));
writeFileSync(o + '/inst-1.json', JSON.stringify({ id: 1, name: 'Bass', type: 'basses', samples: [{ id: 900 }] }));
writeFileSync(o + '/asset-manifest.json', JSON.stringify({
  Bass: { status: 'resolved', relativePath: 'basses/bass.mp3', multisample: { slots: [
    { status: 'resolved', slot: { id: 900 }, sliceStart: 0.5, sliceEnd: 4.5 },
    { status: 'resolved', slot: { id: 901 }, sliceStart: 4.5, sliceEnd: 8.5 },
  ] } },
  Drums: { lanes: { bassDrum1: { status: 'resolved', relativePath: 'kicks/kick.mp3' } } },
}));
`,
  );
  const ffmpeg = join(dir, 'ffmpeg.sh');
  writeFileSync(ffmpeg, '#!/bin/sh\nfor last; do :; done\necho "$@" > "$last"\n');
  chmodSync(ffmpeg, 0o755);
  return new PlaybackService({
    playbackDir: join(dir, 'playback'),
    sampleCacheDir: join(dir, 'cache'),
    emitScript: emit,
    nodeBin: process.execPath,
    sampleLibraryRoot: lib,
    ffmpegBin: ffmpeg,
    stubSamplesDir: stubs,
    mixConfigPath: (() => { const f = join(dir, 'mix-config.json'); writeFileSync(f, '{}'); return f; })(),
  });
}

