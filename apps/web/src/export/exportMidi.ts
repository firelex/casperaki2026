import type { Song } from '@casperaki/song-schema';

import type { PlaybackPayload } from '../api/playback';
import { livePlayer } from '../audio/livePlayer';
import { resolveEngineEvents } from '../audio/resolveNotes';
import { buildSequencerModel } from '../editor/sequencerModel';
import { buildSongMidi } from './midi';

/** Build the MIDI file of the version on screen (lowered via the brain, resolved by the engine). */
export async function songMidi(
  song: Song,
  title: string,
  liveKey: string,
  fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
): Promise<Uint8Array> {
  const payload = await livePlayer.payloadOf(liveKey, fetchPayload);
  const events = await resolveEngineEvents(payload);
  const model = buildSequencerModel(song);
  return buildSongMidi(events, {
    title,
    key: song.key,
    instruments: model.tracks.map((t) => t.name),
    sections: model.sections.map((s) => ({ name: s.name, startBar: s.startBar })),
  });
}

/** Save bytes as a file download. */
export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from a song title ("Bright pop in C" → "Bright-pop-in-C"). */
export function fileStem(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '') || 'casperaki-song';
}
