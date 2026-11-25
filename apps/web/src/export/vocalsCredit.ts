// The YuE2 credit (CC BY-NC 4.0) in the browser's MP3 export: the same comment tag the brain's server render writes
// (ffmpeg `-metadata comment=…`, apps/brain/src/render/renderService.ts), when the song has a YuE2 vocal take.

import type { Song } from '@casperaki/song-schema';

import { VOCALS_CREDIT } from '../layout/VocalsCredit';

const ascii = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new Error(`withCommentTag: "${s}" has a character ISO-8859-1 cannot hold`);
    out.push(c);
  }
  return out;
};

/** The MP3 with an ID3v2.3 tag in front holding one comment frame (COMM, language "eng", no description). An error
 *  when the MP3 starts with an ID3 tag already (it would not be merged). */
export function withCommentTag(mp3: Uint8Array, comment: string): Uint8Array {
  if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) throw new Error('withCommentTag: the MP3 has an ID3 tag already');
  const body = [0, ...ascii('eng'), 0, ...ascii(comment)];
  const frame = [...ascii('COMM'), (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, 0, 0, ...body];
  const size = frame.length;
  if (size >= 1 << 28) throw new Error('withCommentTag: the comment is too long for an ID3 tag');
  const header = [...ascii('ID3'), 3, 0, 0, (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
  const out = new Uint8Array(header.length + frame.length + mp3.length);
  out.set(header, 0);
  out.set(frame, header.length);
  out.set(mp3, header.length + frame.length);
  return out;
}

/** The export's MP3 as it is downloaded: with the YuE2 credit when the song has a YuE2 vocal take, else unchanged. */
export function creditedMp3(song: Pick<Song, 'aiArtifacts'>, mp3: Uint8Array): Uint8Array {
  return song.aiArtifacts.some((a) => a.kind === 'yue2-vocal') ? withCommentTag(mp3, VOCALS_CREDIT) : mp3;
}
