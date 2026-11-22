// A REAPER project (.RPP, plain text) for a Casperaki song: one track per
// instrument with its rendered stem from bar 1, the sections as regions, the
// tempo, and (in a muted folder) each instrument's MIDI. Pure: tested.

export interface RppInput {
  readonly title: string;
  readonly bpm: number;
  /** Stem length in seconds (all stems are the same length, from 0). */
  readonly lengthSec: number;
  readonly sections: readonly { readonly name: string; readonly startSec: number; readonly endSec: number }[];
  /** Audio tracks: name, stem file (relative to the project), colour "#rrggbb" if known. */
  readonly stems: readonly { readonly name: string; readonly file: string; readonly color?: string }[];
  /** MIDI tracks (muted, in a folder): name and .mid file (relative). */
  readonly midi: readonly { readonly name: string; readonly file: string; readonly color?: string }[];
}

/** REAPER custom colour: 0x01000000 | B<<16 | G<<8 | R (as REAPER writes it on Windows). */
function peakColor(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!m) throw new Error(`Not a colour: ${hex}`);
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => Number.parseInt(x, 16));
  return String(0x01000000 + (b! << 16) + (g! << 8) + r!);
}

function q(s: string): string {
  if (s.includes('"')) throw new Error(`Quotes are not allowed in REAPER names: ${s}`);
  return `"${s}"`;
}

const n = (x: number) => x.toFixed(6).replace(/\.?0+$/u, '') || '0';

export function buildRpp(input: RppInput): string {
  const out: string[] = [];
  out.push('<REAPER_PROJECT 0.1 "7.0" 0');
  out.push(`  TITLE ${q(input.title)}`);
  out.push(`  TEMPO ${n(input.bpm)} 4 4`);
  out.push('  SAMPLERATE 44100 0 0');
  // Sections as regions: start and end lines share the region's number.
  input.sections.forEach((s, i) => {
    out.push(`  MARKER ${i + 1} ${n(s.startSec)} ${q(s.name)} 1`);
    out.push(`  MARKER ${i + 1} ${n(s.endSec)} "" 1`);
  });
  const track = (name: string, color: string | undefined, body: string[], extra: string[] = []) => {
    out.push('  <TRACK');
    out.push(`    NAME ${q(name)}`);
    const pc = peakColor(color);
    if (pc) out.push(`    PEAKCOL ${pc}`);
    for (const e of extra) out.push(`    ${e}`);
    for (const b of body) out.push(`    ${b}`);
    out.push('  >');
  };
  const item = (name: string, kind: 'WAVE' | 'MIDI', file: string) => [
    '<ITEM',
    '  POSITION 0',
    `  LENGTH ${n(input.lengthSec)}`,
    `  NAME ${q(name)}`,
    `  <SOURCE ${kind}`,
    `    FILE ${q(file)}`,
    '  >',
    '>',
  ];
  for (const s of input.stems) track(s.name, s.color, item(s.name, 'WAVE', s.file));
  if (input.midi.length > 0) {
    // A muted folder of MIDI tracks: ISBUS 1 1 opens the folder, the last child closes it (ISBUS 2 -1).
    track('MIDI (muted)', undefined, [], ['ISBUS 1 1', 'MUTESOLO 1 0 0']);
    input.midi.forEach((m, i) => {
      const last = i === input.midi.length - 1;
      track(`${m.name} (MIDI)`, m.color, item(m.name, 'MIDI', m.file), last ? ['ISBUS 2 -1'] : []);
    });
  }
  out.push('>');
  return `${out.join('\n')}\n`;
}
