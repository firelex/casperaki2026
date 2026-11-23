// Minimal Standard MIDI File (format 1) writer for listening examples.

export interface MidiNote {
  readonly beat: number;
  readonly duration: number;
  readonly midi: number;
  readonly velocity: number;
}
export interface MidiTrack {
  readonly name: string;
  readonly channel: number;
  readonly program: number;
  readonly notes: readonly MidiNote[];
}

const PPQ = 480;

function vlq(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`vlq: bad value ${n}`);
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [...Buffer.from(type, 'ascii'), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

function trackBytes(events: { tick: number; bytes: number[] }[]): number[] {
  events.sort((a, b) => a.tick - b.tick);
  const out: number[] = [];
  let last = 0;
  for (const e of events) { out.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  out.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', out);
}

const text = (type: number, s: string) => { const b = [...Buffer.from(s, 'utf8')]; return [0xff, type, ...vlq(b.length), ...b]; };

export function writeMidi(tempoBpm: number, tracks: readonly MidiTrack[], markers: readonly { beat: number; text: string }[] = []): Buffer {
  if (!(tempoBpm > 0)) throw new Error(`writeMidi: bad tempo ${tempoBpm}`);
  const us = Math.round(60_000_000 / tempoBpm);
  const conductor = trackBytes([
    { tick: 0, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] },
    { tick: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] },
    ...markers.map((m) => ({ tick: Math.round(m.beat * PPQ), bytes: text(0x06, m.text) })),
  ]);
  const body = tracks.map((t) => {
    if (t.channel < 0 || t.channel > 15) throw new Error(`writeMidi: bad channel ${t.channel}`);
    const ev: { tick: number; bytes: number[] }[] = [
      { tick: 0, bytes: text(0x03, t.name) },
      { tick: 0, bytes: [0xc0 | t.channel, t.program] },
    ];
    for (const n of t.notes) {
      if (n.midi < 0 || n.midi > 127) throw new Error(`writeMidi: pitch ${n.midi} out of range`);
      const on = Math.round(n.beat * PPQ);
      const off = Math.max(on + 1, Math.round((n.beat + n.duration) * PPQ) - 1);
      ev.push({ tick: on, bytes: [0x90 | t.channel, n.midi, n.velocity] }, { tick: off, bytes: [0x80 | t.channel, n.midi, 0] });
    }
    return trackBytes(ev);
  });
  const header = chunk('MThd', [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 255, PPQ & 255]);
  return Buffer.from([...header, ...conductor, ...body.flat()]);
}
