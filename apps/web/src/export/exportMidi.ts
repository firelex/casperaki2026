import type { Song } from '@casperaki/song-schema';

import type { PlaybackPayload } from '../api/playback';
import { livePlayer } from '../audio/livePlayer';
import { resolveEngineEvents } from '../audio/resolveNotes';
import { buildSequencerModel } from '../editor/sequencerModel';
import { buildSongMidi } from './midi';

/**
 * MIDI of the version on screen (lowered via the brain, resolved by the
 * engine): the whole song with the chosen instruments, and one file per
 * instrument. `only` limits the instruments (default: all).
 */
export async function songMidiParts(
  song: Song,
  title: string,
  liveKey: string,
  fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
  only?: readonly string[],
): Promise<{ song: Uint8Array; tracks: Record<string, Uint8Array> }> {
  const payload = await livePlayer.payloadOf(liveKey, fetchPayload);
  const events = await resolveEngineEvents(payload);
  const model = buildSequencerModel(song);
  const all = model.tracks.map((t) => t.name);
  const instruments = only ? all.filter((n) => only.includes(n)) : all;
  const info = { title, key: song.key, sections: model.sections.map((s) => ({ name: s.name, startBar: s.startBar })) };
  const tracks: Record<string, Uint8Array> = {};
  for (const name of instruments) {
    const hasEvents = events.tracks.some((t) => (t.notes.length || t.hits.length) && (t.name === name || t.name.startsWith(`${name}-`) || t.name.startsWith(`${name}(`)));
    if (hasEvents) tracks[name] = buildSongMidi(events, { ...info, instruments: [name] });
  }
  return { song: buildSongMidi(events, { ...info, instruments }), tracks };
}

/** The whole song's MIDI (all instruments). */
export async function songMidi(
  song: Song,
  title: string,
  liveKey: string,
  fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>,
): Promise<Uint8Array> {
  return (await songMidiParts(song, title, liveKey, fetchPayload)).song;
}

/** Bytes as base64 (for JSON request bodies). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
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
