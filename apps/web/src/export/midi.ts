/**
 * The song as a Standard MIDI File (type 1): one track per instrument with
 * the notes the playback engine plays (its own resolver's output), drums on
 * channel 10 with General MIDI note numbers, plus tempo, 4/4, the key and
 * the sections as markers. Pure: tested without the engine.
 */

import { Midi } from '@tonejs/midi';
import { parseMidi, writeMidi } from 'midi-file';

import type { EngineEvents } from '../audio/resolveNotes';
import { parseKey } from '../editor/sequencer/notation';

/** Engine drum lanes → General MIDI percussion notes (as the engine adapter maps them). */
const DRUM_GM: Record<string, number> = {
  bassDrum1: 36, bassDrum2: 35, snareDrum1: 38, snareDrum2: 40, clap: 39, snap: 31,
  hiHatClosed1: 42, hiHatClosed2: 44, hiHatPedal: 44, hiHatOpen: 46,
  crash1: 49, crash2: 57, ride: 51, shaker: 70, tom1: 50, tom2: 47, tom3: 43,
};
const DRUM_CHANNEL = 9; // channel 10
const PPQ = 480;

/** A rough General MIDI program per instrument family, so a DAW previews something sensible. */
function gmProgram(name: string): number {
  const k = name.toLowerCase();
  if (k.startsWith('bass')) return 38; // synth bass 1
  if (k.startsWith('keys') || k.includes('piano')) return 0;
  if (k.startsWith('pad')) return 89; // warm pad
  if (k.includes('pluck')) return 45; // pizzicato
  if (k.includes('guitar')) return 25;
  if (k.includes('string')) return 48;
  if (k.includes('brass')) return 61;
  if (k.includes('synth')) return 81; // saw lead
  return 0;
}

export interface MidiSongInfo {
  readonly title: string;
  readonly key: string;
  /** Instruments in display order (song track names). */
  readonly instruments: readonly string[];
  readonly sections: readonly { readonly name: string; readonly startBar: number }[];
}

/** Which song instrument an engine track belongs to ("Drums-kicks" → Drums, "Bass(long notes)" → Bass). */
export function instrumentOf(engineTrack: string, instruments: readonly string[]): string | undefined {
  if (instruments.includes(engineTrack)) return engineTrack;
  const matches = instruments.filter((i) => engineTrack.startsWith(`${i}-`) || engineTrack.startsWith(`${i}(`));
  return matches.sort((a, b) => b.length - a.length)[0];
}

export function buildSongMidi(events: EngineEvents, info: MidiSongInfo): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(events.tempo);
  midi.header.name = info.title;
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  for (const s of info.sections) midi.header.meta.push({ type: 'marker', text: s.name, ticks: s.startBar * 4 * PPQ });
  midi.header.update();

  // Engine tracks grouped by instrument, in the song's order.
  const byInstrument = new Map<string, EngineEvents['tracks'][number][]>();
  for (const t of events.tracks) {
    if (t.notes.length === 0 && t.hits.length === 0) continue;
    const inst = instrumentOf(t.name, info.instruments);
    if (!inst) continue; // audio-only engine tracks (loops, transition effects)
    byInstrument.set(inst, [...(byInstrument.get(inst) ?? []), t]);
  }
  let nextChannel = 0;
  for (const inst of info.instruments) {
    const parts = byInstrument.get(inst);
    if (!parts) continue;
    const track = midi.addTrack();
    track.name = inst;
    const drums = parts.some((p) => p.hits.length > 0);
    if (drums) {
      track.channel = DRUM_CHANNEL;
      track.instrument.number = 0;
    } else {
      if (nextChannel === DRUM_CHANNEL) nextChannel++;
      if (nextChannel > 15) throw new Error('More pitched instruments than MIDI channels (15).');
      track.channel = nextChannel++;
      track.instrument.number = gmProgram(inst);
    }
    for (const p of parts) {
      for (const n of p.notes) {
        track.addNote({
          midi: n.pitch,
          ticks: Math.round(n.start * PPQ),
          durationTicks: Math.max(1, Math.round(n.length * PPQ)),
          velocity: Math.max(1, Math.min(127, n.velocity)) / 127,
        });
      }
      for (const h of p.hits) {
        const note = DRUM_GM[h.drum];
        if (note === undefined) throw new Error(`No General MIDI note for drum "${h.drum}"`);
        track.addNote({ midi: note, ticks: Math.round(h.start * PPQ), durationTicks: PPQ / 8, velocity: Math.max(1, Math.min(127, h.velocity)) / 127 });
      }
    }
  }
  return withKeySignature(midi.toArray(), info.key);
}

/**
 * Add the key signature meta event to the first track. (@tonejs/midi writes
 * key signatures with a wrong sharps/flats value, so it is added here.)
 */
function withKeySignature(bytes: Uint8Array, songKey: string): Uint8Array {
  const key = parseKey(songKey);
  const minor = key.abc.endsWith('m');
  const data = parseMidi(bytes);
  const first = data.tracks[0];
  if (!first) throw new Error('The MIDI file has no tracks.');
  first.unshift({ deltaTime: 0, meta: true, type: 'keySignature', key: key.fifths, scale: minor ? 1 : 0 });
  return new Uint8Array(writeMidi(data));
}
