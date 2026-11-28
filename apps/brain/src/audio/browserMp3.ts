// What the browser gets for a WAV a task step made (owner 2026-11-28: "We should only send mp3 to the browser"): an
// MP3 made from it the first time it is asked for, kept beside it in a ".mp3" folder and made again when the WAV is
// newer. Steps write 32-bit float WAVs for the next step, which some players refuse, and WAVs are large.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The MP3 for `wav` (made when missing or older than the WAV): its path. */
export async function browserMp3(ffmpegBin: string, wav: string): Promise<string> {
  const dir = join(dirname(wav), '.mp3');
  const mp3 = join(dir, `${basename(wav).replace(/\.wav$/iu, '')}.mp3`);
  if (existsSync(mp3) && statSync(mp3).mtimeMs >= statSync(wav).mtimeMs) return mp3;
  mkdirSync(dir, { recursive: true });
  // Written under a name of its own, then moved into place: two requests at once never read half a file.
  const part = `${mp3}.${process.pid}.${Date.now()}.part.mp3`;
  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegBin, ['-v', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '2', part], (err, _out, stderr) => {
      if (err) reject(new Error(`making an MP3 of ${basename(wav)} failed: ${String(stderr).trim() || err.message}`));
      else resolve();
    });
  });
  renameSync(part, mp3);
  return mp3;
}
