import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlaybackService } from '../src/render/playbackService.js';

/** Stand-in playback: the "emit" writes a one-lane envelope (a bass
 *  multisample with two slots, one drum lane), the "ffmpeg" writes its
 *  arguments into the output file so slicing can be checked. */
export function fakePlayback(opts: { mixConfig?: string; /** What the fake ffprobe reports (duration and sample rate). */ probe?: string } = {}): PlaybackService {
  const dir = mkdtempSync(join(tmpdir(), 'casperaki-playback-test-'));
  const lib = join(dir, 'library');
  mkdirSync(join(lib, 'basses'), { recursive: true });
  mkdirSync(join(lib, 'kicks'), { recursive: true });
  writeFileSync(join(lib, 'basses', 'bass.mp3'), 'mp3');
  writeFileSync(join(lib, 'kicks', 'kick.mp3'), 'mp3');
  // The library's fx sheet, beside the instruments folder.
  writeFileSync(join(dir, 'fxMetadata.json'), '{}');
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs);
  for (const n of ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg']) writeFileSync(join(stubs, n), 'ogg');
  // Laid out like apps/engine-spike: scripts/<emit> beside node_modules/@casperaki/<pkg>/dist,
  // which the playback service fingerprints to version its lowering cache.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@casperaki', 'engine-adapter', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@casperaki', 'engine-adapter', 'dist', 'index.js'), 'export {};\n');
  const emit = join(dir, 'scripts', 'emit.mjs');
  writeFileSync(
    emit,
    `import { writeFileSync } from 'node:fs';
const o = process.env.OUT_DIR;
writeFileSync(o + '/song.json', JSON.stringify({ song: true }));
writeFileSync(o + '/inst-1.json', JSON.stringify({ id: 1, name: 'Bass', type: 'basses', samples: [{ id: 900 }] }));
writeFileSync(o + '/asset-manifest.json', JSON.stringify({
  Bass: { status: 'resolved', relativePath: 'basses/bass.mp3', multisample: { slots: [
    { status: 'resolved', slot: { id: 900, note: 'c2', type: 'longNote' }, sliceStart: 0.5, sliceEnd: 4.5 },
    { status: 'resolved', slot: { id: 901, note: 'd#2', type: 'longNote' }, sliceStart: 4.5, sliceEnd: 8.5 },
  ] } },
  Drums: { lanes: { bassDrum1: { status: 'resolved', relativePath: 'kicks/kick.mp3' } } },
}));
`,
  );
  const ffmpeg = join(dir, 'ffmpeg');
  writeFileSync(ffmpeg, '#!/bin/sh\nfor last; do :; done\necho "$@" > "$last"\n');
  chmodSync(ffmpeg, 0o755);
  // ffprobe (next to ffmpeg): every stand-in file is 100 s long (and at 100 Hz), unless told otherwise.
  const ffprobe = join(dir, 'ffprobe');
  writeFileSync(ffprobe, `#!/bin/sh\necho ${opts.probe ?? '100'}\n`);
  chmodSync(ffprobe, 0o755);
  return new PlaybackService({
    playbackDir: join(dir, 'playback'),
    sampleCacheDir: join(dir, 'cache'),
    emitScript: emit,
    nodeBin: process.execPath,
    sampleLibraryRoot: lib,
    ffmpegBin: ffmpeg,
    stubSamplesDir: stubs,
    // In a git repo with a remote, as the engine repo is: approvals commit and push it.
    mixConfigPath: (() => {
      const repo = join(dir, 'engine');
      const remote = join(dir, 'engine-remote.git');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
      mkdirSync(repo);
      git(dir, 'init', '-q', '--bare', remote);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      const f = join(repo, 'mix-config.json');
      writeFileSync(f, opts.mixConfig ?? '{}');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', '-q', '-u', 'origin', 'main');
      return f;
    })(),
  });
}

