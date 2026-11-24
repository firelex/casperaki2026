// Rewrite the repeated second half of the Melody Sauce melodies (the "stefan" vocal precedent bank) with the melody
// completion model (AMT service, apps/models/services/_serving/adapters/amt.py). Melody Sauce wrote 4 bars and looped
// them: in 1004 of 1201 entries bars 5-8 are bars 1-4 exactly. Owner's idea (2026-11-24): let the model write the
// second half.
//
//   AMT_SERVICE_URL=http://127.0.0.1:16511 node packages/arrangement/scripts/complete-melody-sauce.mjs --pilot 20
//   AMT_SERVICE_URL=http://127.0.0.1:16511 node packages/arrangement/scripts/complete-melody-sauce.mjs --write
//
// The model writes 16 samples per entry. Per entry, a fixed rule (a hash of its id) picks the form:
//   AA'  (60%): bars 1-6 kept (bars 5-6 repeat bars 1-2 as before), the model writes bars 7-8: a new ending;
//   AB   (40%): bars 1-4 kept, the model writes bars 5-8.
// The model gets the kept bars at sung pitch (bank + 12) and the entry's own chords. Of its ranked samples the first
// that passes our checks is taken: every written bar has notes; whole span at most 19 semitones; no leap wider than a
// sixth into or inside the written bars (a written bar may be silent only where the source had a silent bar); at least 60% chord tones on beats 1 and 3 of the written bars; written bars
// not a near copy of the kept ones; the phrase ends in bar 8 on a chord tone started by beat 3 and held to beat 4
// (later notes dropped), leaving a breath. If none passes, the entry is kept as it is and the reason recorded.
// properties.secondHalf records what was done. --write saves the bank (resumable: entries with secondHalf are skipped).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents', 'mlDataRaw-stefan.json');
const URL_ = process.env.AMT_SERVICE_URL;
if (!URL_) throw new Error('complete-melody-sauce: set AMT_SERVICE_URL (the melody completion service, e.g. http://127.0.0.1:16511)');
const args = process.argv.slice(2);
const pilot = args.includes('--pilot') ? Number(args[args.indexOf('--pilot') + 1]) : undefined;
const write = args.includes('--write');
if (!pilot === !write) throw new Error('complete-melody-sauce: pass either --pilot <n> or --write');
const SAMPLES = 16;

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const ROOT = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus: [0, 5, 7],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], dim: [0, 3, 6], m9: [0, 3, 7, 10, 14], sus2: [0, 2, 7], 6: [0, 4, 7, 9],
};
function chordNotes(symbol) {
  const root = symbol.length > 1 && '#b'.includes(symbol[1]) ? symbol.slice(0, 2) : symbol.slice(0, 1);
  const q = QUAL[symbol.slice(root.length)];
  if (q === undefined || ROOT[root] === undefined) throw new Error(`complete-melody-sauce: cannot read chord "${symbol}"`);
  return q.map((i) => 48 + ROOT[root] + i);
}
const pc = (m) => ((m % 12) + 12) % 12;
const beatKey = (b) => (Number.isInteger(b) ? b.toFixed(1) : String(b));
const formOf = (id) => (createHash('sha1').update(String(id)).digest()[0] / 256 < 0.6 ? "AA'" : 'AB');

function chordsOf(x) {
  const out = [];
  for (let b = 0; b < 32; b++) {
    const c = x.chords[beatKey(b)];
    if (!c) throw new Error(`complete-melody-sauce: entry ${x.id} has no chord at beat ${b}`);
    const last = out[out.length - 1];
    if (last && last.symbol === c.chord) last.duration += 1;
    else out.push({ symbol: c.chord, beat: b, duration: 1 });
  }
  return out;
}

function check(notes, written, chords, emptyInSource) {
  const inW = (n) => written.includes(Math.floor(n.beat / 4));
  // A written bar may be silent only where the source melody had a silent bar (phrases with a bar of rest).
  for (const bar of written) if (!emptyInSource.has(bar) && !notes.some((n) => Math.floor(n.beat / 4) === bar)) return `bar ${bar + 1} is empty`;
  const ms = notes.map((n) => n.midi);
  if (Math.max(...ms) - Math.min(...ms) > 19) return `span ${Math.max(...ms) - Math.min(...ms)}`;
  for (let i = 1; i < notes.length; i++) {
    if ((inW(notes[i]) || inW(notes[i - 1])) && Math.abs(notes[i].midi - notes[i - 1].midi) > 9) return `leap of ${Math.abs(notes[i].midi - notes[i - 1].midi)} at beat ${notes[i].beat}`;
  }
  const strong = notes.filter((n) => inW(n) && (n.beat % 4 === 0 || n.beat % 4 === 2));
  const chordAt = (b) => chords.find((c) => c.beat <= b && b < c.beat + c.duration);
  const good = strong.filter((n) => chordNotes(chordAt(n.beat).symbol).map(pc).includes(pc(n.midi))).length;
  if (strong.length && good / strong.length < 0.6) return `strong-beat chord tones ${good}/${strong.length}`;
  // Near copy: a written bar sharing at least 75% of its notes (position in the bar and pitch) with the bar four
  // earlier, i.e. the loop came back.
  const cells = (bar) => new Set(notes.filter((n) => Math.floor(n.beat / 4) === bar).map((n) => `${Math.round((n.beat % 4) * 4)}:${n.midi}`));
  // Judged on the written bars where the source had notes: more than half of them coming back as copies fails.
  const sounding = written.filter((bar) => cells(bar).size > 0 && !emptyInSource.has(bar));
  const copied = sounding.filter((bar) => {
    const w = cells(bar);
    const k = cells(bar - 4);
    return [...w].filter((c) => k.has(c)).length / Math.max(w.size, k.size) >= 0.75;
  });
  if (sounding.length && copied.length > sounding.length / 2) return 'a near copy of the bars four earlier';
  return undefined;
}

// The 8-bar phrase lands in bar 8 and breathes: nothing starts after beat 3 of bar 8 (beat 30); notes the model wrote
// later are dropped, and the last note is held to at least beat 4 of bar 8 (beat 31).
const LAST_ONSET = 30;
const HOLD_TO = 31;
function endPhrase(notes) {
  const kept = notes.filter((n) => n.beat <= LAST_ONSET + 1e-9);
  const last = kept[kept.length - 1];
  if (last && last.beat + last.duration < HOLD_TO) last.duration = HOLD_TO - last.beat;
  if (last && last.beat + last.duration > 32) last.duration = 32 - last.beat;
  return kept;
}
function endingProblem(notes, chords) {
  const last = notes[notes.length - 1];
  if (last.beat < 28) return `the last note starts in bar ${Math.floor(last.beat / 4) + 1}, not bar 8`;
  const chord = chords.find((c) => c.beat <= last.beat && last.beat < c.beat + c.duration);
  if (!chordNotes(chord.symbol).map(pc).includes(pc(last.midi))) return `ends on a note outside its chord (${chord.symbol})`;
  return undefined;
}

async function complete(x) {
  const form = formOf(x.id);
  const keep = form === 'AB' ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5];
  const written = [0, 1, 2, 3, 4, 5, 6, 7].filter((b) => !keep.includes(b));
  const prompt = Object.entries(x.melody)
    .map(([b, v]) => ({ beat: Number(b), midi: v[0].midi + 12, duration: v[0].duration }))
    .filter((n) => keep.includes(Math.floor(n.beat / 4)))
    .sort((a, b) => a.beat - b.beat);
  const chords = chordsOf(x);
  const emptyInSource = new Set([0, 1, 2, 3, 4, 5, 6, 7].filter((b) => !Object.keys(x.melody).some((k) => Math.floor(Number(k) / 4) === b)));
  const res = await fetch(`${URL_.replace(/\/$/u, '')}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bpm: Number(x.properties.tempo), totalBars: 8, prompt, keepBars: keep, samples: SAMPLES,
      chords: chords.map((c) => ({ beat: c.beat, duration: c.duration, midi: chordNotes(c.symbol) })),
    }),
  });
  const body = await res.json();
  // One known per-entry limit: a dense melody plus its chords can exceed the model's context. That entry is kept as it
  // is, with the reason recorded; any other service error stops the run.
  // (The service's own length check misses some cases, which then fail inside the model as a 1024 vs 1025 tensor
  // size mismatch: the same limit.)
  if (res.status === 500 && /context window|tensor a \(1024\) must match the size of tensor b \(1025\)/u.test(String(body.error))) return { form: formOf(x.id), written: [], failed: [String(body.error)] };
  if (!res.ok) throw new Error(`complete-melody-sauce: entry ${x.id}: the service answered ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const reasons = [];
  for (const c of body.completions) {
    const notes = endPhrase(c.notes.map((n) => ({ beat: n.beat, midi: n.midi - 12, duration: n.duration })).sort((a, b) => a.beat - b.beat));
    const why = notes.length === 0 ? 'no notes' : endingProblem(notes, chords) ?? check(notes, written, chords, emptyInSource);
    if (!why) return { form, written, notes, tookMs: body.tookMs };
    reasons.push(why);
  }
  return { form, written, failed: reasons };
}

const bank = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = bank.filter((x) => !x.properties.secondHalf).slice(0, pilot ?? bank.length);
let done = 0, kept = 0;
const t0 = Date.now();
for (const x of todo) {
  const r = await complete(x);
  if (r.failed) {
    kept++;
    x.properties.secondHalf = { form: 'kept', reason: `no sample passed: ${r.failed.join('; ')}` };
  } else {
    done++;
    const melody = {};
    for (const n of r.notes) melody[beatKey(n.beat)] = [{ note: `${NAMES[pc(n.midi)]}${Math.floor(n.midi / 12)}`, midi: n.midi, duration: n.duration }];
    const sorted = r.notes.map((n) => n.midi).sort((a, b) => a - b);
    x.melody = melody;
    Object.assign(x.properties, {
      lowestNote: sorted[0], highestNote: sorted[sorted.length - 1], medianNote: sorted[Math.floor(sorted.length / 2)], busyness: r.notes.length / 8,
      secondHalf: { form: r.form, writtenBars: r.written.map((b) => b + 1), by: 'melody completion model (AMT music-medium-800k), scripts/complete-melody-sauce.mjs, 2026-11-24' },
    });
  }
  if (pilot) console.log(`${x.id} ${x.properties.secondHalf.form}${r.failed ? ` (${x.properties.secondHalf.reason})` : ''}`);
  if (write && (done + kept) % 50 === 0) {
    writeFileSync(FILE, `${JSON.stringify(bank, null, 1)}\n`);
    console.log(`${done + kept}/${todo.length} (${done} rewritten, ${kept} kept), ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}
if (write) writeFileSync(FILE, `${JSON.stringify(bank, null, 1)}\n`);
else writeFileSync(join(dirname(FILE), '..', '..', '..', '..', '..', '.superpowers', 'melody-sauce-pilot.json'), JSON.stringify(todo, null, 1));
console.log(`done: ${done} rewritten, ${kept} kept as they were, ${Math.round((Date.now() - t0) / 1000)} s`);
