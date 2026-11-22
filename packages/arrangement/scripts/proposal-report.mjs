// Pattern lab check: how each keys / pad / strings / brass / synths / guitar
// proposal sounds over real chord progressions, as text.
//
//   pnpm -C packages/arrangement build
//   node packages/arrangement/scripts/proposal-report.mjs [proposal-id ...] [--verbose]
//
// Progressions come from songs the orchestrator writes (several seeds per
// genre of the proposal). Chord-tone notes are moved to the nearest chord tone
// exactly as the engine does (resolveChordTone); guitar hits are read off the
// engine's guitar chord shapes (wasm engine ChordData.h, lowest position).
//
// Flags, per pattern:
//   collapsed  two notes starting together land on the same pitch (a voice is lost)
//   muddy      two notes below E3 sounding together closer than a fourth
//   range      a note lands outside C2..C7
//   wraps      a guitar hit names a string the chord shape does not have
//              (the engine wraps it round to a lower one)
//   jump       the biggest move of one voice between two chords (information)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatternProposals, orchestrate, resolveChordTone } from '../dist/index.js';
import { parseChord } from '@casperaki/music-theory';
import { DEFAULT_BPM_BY_GENRE } from '@casperaki/song-schema';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = new Set(args.filter((a) => !a.startsWith('--')));

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const name = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

// ---- guitar shapes (engine data) ----
const chordDataSrc = readFileSync(resolve(HERE, '../../../apps/web/wasm/engine/src/music/ChordData.h'), 'utf8');
const chordData = JSON.parse(chordDataSrc.split('R"CHORDDATA(')[1].split(')CHORDDATA"')[0]);
const SHARP_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Chord quality (music-theory) -> ChordData suffix (engine Chord::chordTypeToString).
const SUFFIX = {
  maj: 'major', min: 'minor', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', 7: '7', maj7: 'maj7', min7: 'm7',
  dim7: 'dim7', m7b5: 'm7b5', 9: '9', maj9: 'maj9', min9: 'm9', 6: '6', min6: 'm6', add9: 'add9', minAdd9: 'madd9',
};
function guitarShape(symbol) {
  const c = parseChord(symbol);
  const suffix = SUFFIX[c.quality];
  if (!suffix) throw new Error(`no guitar suffix for chord quality "${c.quality}" (${symbol})`);
  const variant = (chordData[SHARP_ROOTS[c.root]] ?? []).find((v) => v.suffix === suffix);
  if (!variant) throw new Error(`no guitar shape for ${symbol} (${SHARP_ROOTS[c.root]} ${suffix})`);
  return variant.positions[0].midi;
}

// ---- progressions from real songs ----
function progressionsFor(genre) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const song = orchestrate({ genre, key: ['C', 'Am', 'E', 'Dm'][i], bpm: DEFAULT_BPM_BY_GENRE[genre], seed: `report-${genre}-${i}` });
    for (const seg of song.songStructure) {
      const type = seg.name.replace(/\d+$/u, '');
      if (!['verse', 'chorus'].includes(type)) continue;
      out.push({ label: `${genre}/${i} ${seg.name}`, bars: seg.bars.map((b) => b.chords) });
      break;
    }
  }
  return out;
}

// ---- analysis ----
function chordAt(prog, bar, beat) {
  const chords = prog.bars[bar % prog.bars.length];
  return chords[Math.min(chords.length - 1, Math.floor(beat))];
}

function analyseChordTones(pattern, progs) {
  const flags = { collapsed: 0, muddy: 0, range: 0, onsets: 0 };
  let jump = 0;
  const lines = [];
  for (const prog of progs) {
    const bars = Math.max(prog.bars.length, pattern.bars);
    let prevByVoice = new Map();
    for (let bar = 0; bar < bars; bar++) {
      const pBar = bar % pattern.bars;
      const notes = pattern.notes.filter(([at]) => Math.floor(at / 4) === pBar);
      const byOnset = new Map();
      for (const [at, semi, len] of notes) {
        const beat = at - pBar * 4;
        const chord = chordAt(prog, bar, beat);
        const pitch = resolveChordTone(semi, chord);
        if (!byOnset.has(beat)) byOnset.set(beat, []);
        byOnset.get(beat).push({ semi, pitch, len, chord });
        if (pitch < 36 || pitch > 96) flags.range++;
        const prev = prevByVoice.get(semi);
        if (prev !== undefined) jump = Math.max(jump, Math.abs(prev - pitch));
        prevByVoice.set(semi, pitch);
      }
      for (const [beat, group] of [...byOnset].sort((a, b) => a[0] - b[0])) {
        flags.onsets++;
        const pitches = group.map((g) => g.pitch);
        if (new Set(pitches).size < pitches.length) flags.collapsed++;
        const low = pitches.filter((p) => p < 52).sort((a, b) => a - b);
        for (let k = 1; k < low.length; k++) if (low[k] - low[k - 1] < 5) { flags.muddy++; break; }
        if (verbose && prog === progs[0]) lines.push(`    bar ${bar + 1} beat ${beat + 1} ${group[0].chord.padEnd(6)} ${pitches.sort((a, b) => a - b).map(name).join(' ')}`);
      }
    }
  }
  return { flags, jump, lines };
}

function analyseGuitar(pattern, progs) {
  const flags = { wraps: 0, hits: 0 };
  const lines = [];
  for (const prog of progs) {
    const bars = Math.max(prog.bars.length, pattern.bars);
    for (let bar = 0; bar < bars; bar++) {
      const pBar = bar % pattern.bars;
      for (const [at, strings] of pattern.hits.filter(([a]) => Math.floor(a / 4) === pBar)) {
        const beat = at - pBar * 4;
        const chord = chordAt(prog, bar, beat);
        const shape = guitarShape(chord);
        flags.hits++;
        if (strings.some((s) => s >= shape.length)) flags.wraps++;
        if (verbose && prog === progs[0]) lines.push(`    bar ${bar + 1} beat ${beat + 1} ${chord.padEnd(6)} ${strings.map((s) => name(shape[s % shape.length])).join(' ')}`);
      }
    }
  }
  return { flags, lines };
}

const proposals = loadPatternProposals().filter(
  (p) => (p.kind === 'chordTones' || p.kind === 'guitarPicks') && (only.size === 0 || only.has(p.id)),
);
const cache = new Map();
let problems = 0;
for (const p of proposals) {
  const progs = p.genres.flatMap((g) => {
    if (!cache.has(g)) cache.set(g, progressionsFor(g));
    return cache.get(g);
  });
  console.log(`\n${p.id}  [${p.family}] ${p.genres.join(', ')}  (${progs.length} progressions, e.g. ${progs[0].bars.map((b) => b.join(' ')).join(' | ')})`);
  p.patterns.forEach((pattern, i) => {
    const tag = `  pattern ${i + 1}${pattern.energy ? ` (${pattern.energy})` : ''}`;
    if (p.kind === 'chordTones') {
      const { flags, jump, lines } = analyseChordTones(pattern, progs);
      const bad = flags.collapsed + flags.muddy + flags.range;
      problems += bad ? 1 : 0;
      console.log(`${tag}: collapsed ${flags.collapsed}/${flags.onsets}, muddy ${flags.muddy}, range ${flags.range}, biggest voice jump ${jump} st${bad ? '  <-- check' : ''}`);
      for (const l of lines) console.log(l);
    } else {
      const { flags, lines } = analyseGuitar(pattern, progs);
      problems += flags.wraps ? 1 : 0;
      console.log(`${tag}: wraps ${flags.wraps}/${flags.hits}${flags.wraps ? '  <-- check' : ''}`);
      for (const l of lines) console.log(l);
    }
  });
}
console.log(`\n${proposals.length} proposals, ${problems} pattern(s) flagged`);
