// Loudness measurements with ffmpeg's EBU R128 meter (integrated loudness, LUFS).

import { execFile } from 'node:child_process';

/** The integrated loudness of several audio files played one after another (one measurement over all of them, so a
 *  gain from it keeps their levels to each other); an error when they are silent. */
export function integratedLoudnessOf(ffmpegBin: string, paths: readonly string[], what: string): Promise<number> {
  if (paths.length === 0) throw new Error(`integratedLoudnessOf: no files for ${what}`);
  const inputs = paths.flatMap((p) => ['-i', p]);
  const graph = `${paths.map((_, i) => `[${i}:a]`).join('')}concat=n=${paths.length}:v=0:a=1,ebur128`;
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, ['-hide_banner', '-nostats', ...inputs, '-filter_complex', graph, '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) return reject(new Error(`ffmpeg could not measure the loudness of ${what}: ${stderr.trim().split('\n').slice(-3).join(' ') || err.message}`));
      const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf) LUFS/u.exec(stderr);
      if (!m) return reject(new Error(`ffmpeg printed no integrated loudness for ${what}`));
      const lufs = m[1] === '-inf' ? -Infinity : Number(m[1]);
      if (!(lufs > -70)) return reject(new Error(`${what} is silent (${m[1]} LUFS)`));
      resolve(lufs);
    });
  });
}

/** The integrated loudness (LUFS) of one audio file; an error for a silent one. */
export function integratedLoudness(ffmpegBin: string, path: string): Promise<number> {
  return integratedLoudnessOf(ffmpegBin, [path], path);
}
