// Measures thin sections and clashes over 200 generated songs, without and with the thin-section partner tracks
// (docs/superpowers/specs/2026-11-24-thin-sections-design.md). Imports the built dist/: run
// `pnpm -C packages/arrangement build` first.
//
//   node packages/arrangement/scripts/measure-thin-sections.mjs [songs=200]
//
// "Without" sets THIN_RULES.maxAddedTracks to 0 for the run (the same module instance orchestrate uses).

import { orchestrate } from '../dist/index.js';
import { isSustained } from '../dist/arrangement-polish/clashes.js';
import { isMeasured, measureSection, THIN_RULES } from '../dist/arrangement-polish/thin-sections.js';
import { parseBarBeat } from '@casperaki/music-theory';

const GENRES = ['ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban'];
const SONGS = Number(process.argv[2] ?? 200);
const SKIP = new Set(['intro', 'outro', 'break']);
const BAND = { Bass: 'low', Keys: 'mid', Pad: 'mid', Guitar: 'mid', PopStrings: 'mid', PopBrass: 'mid', Synths: 'high', PluckedSynths: 'high' };
const family = (lane) => lane.replace(/ \d+$/u, '');
const typeOf = (name) => (name.startsWith('preChorus') ? 'preChorus' : name.replace(/\d+$/u, ''));

/** Onset slots (16ths) of a lane, and its onsets a bar. */
function onsets(pattern) {
  const set = new Set();
  pattern.bars.forEach((bar, b) => {
    for (const [k, evs] of Object.entries(bar.notes ?? {})) if (evs?.length) set.add(b * 16 + Math.round(parseBarBeat(k) * 4));
  });
  return { set, perBar: set.size / Math.max(1, pattern.bars.length) };
}

function measureSong(song) {
  const out = { sections: 0, harmony: 0, rhythm: 0, busyPairs: 0, unison: 0 };
  for (const sec of song.songStructure) {
    const a = song.arrangement[sec.name];
    const lanes = Object.fromEntries(Object.entries(a.overrides).filter(([l]) => a.instruments[l]));
    if (!SKIP.has(typeOf(sec.name))) {
      const m = measureSection(lanes);
      out.sections++;
      if (m.harmony) out.harmony++;
      if (m.rhythm) out.rhythm++;
    }
    const parts = Object.entries(lanes)
      .filter(([l]) => family(l) !== 'Drums' && !/vocal/iu.test(l) && l !== 'Loop')
      .filter(([, p]) => !isSustained(p))
      .map(([l, p]) => ({ lane: l, fam: family(l), band: BAND[family(l)], ...onsets(p) }));
    const busy = parts.filter((p) => p.perBar >= 8);
    if (new Set(busy.map((p) => p.fam)).size >= 2) out.busyPairs++;
    let clash = false;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const [x, y] = [parts[i], parts[j]];
        if (x.fam === y.fam || !x.band || x.band !== y.band || x.perBar < 6 || y.perBar < 6) continue;
        const [few, many] = x.set.size <= y.set.size ? [x, y] : [y, x];
        if ([...few.set].filter((o) => many.set.has(o)).length / few.set.size >= 0.6) clash = true;
      }
    }
    if (clash) out.unison++;
  }
  return out;
}

function run(maxAdded) {
  THIN_RULES.maxAddedTracks = maxAdded;
  const total = { sections: 0, harmony: 0, rhythm: 0, busyPairs: 0, unison: 0, allSections: 0 };
  const addedPerSong = [0, 0, 0];
  const addedFamilies = {};
  for (let i = 0; i < SONGS; i++) {
    const genre = GENRES[i % GENRES.length];
    const song = orchestrate({ genre, key: 'C', bpm: 120, seed: `measure-${i}` });
    const m = measureSong(song);
    for (const k of Object.keys(m)) total[k] += m[k];
    total.allSections += song.songStructure.length;
    if (maxAdded > 0) {
      const base = orchestrateNames.get(i);
      const added = song.instrumentDefinitions.map((d) => d.name).filter((n) => !base.has(n));
      addedPerSong[added.length]++;
      for (const n of added) addedFamilies[`${genre}:${family(n)}`] = (addedFamilies[`${genre}:${family(n)}`] ?? 0) + 1;
    } else {
      orchestrateNames.set(i, new Set(song.instrumentDefinitions.map((d) => d.name)));
    }
  }
  return { total, addedPerSong, addedFamilies };
}

const orchestrateNames = new Map();
const pct = (n, d) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
const max = THIN_RULES.maxAddedTracks;
const before = run(0);
const after = run(max);
THIN_RULES.maxAddedTracks = max;
for (const [label, r] of [['without partners', before], ['with partners', after]]) {
  const t = r.total;
  console.log(
    `${label}: harmony-thin ${pct(t.harmony, t.sections)}, rhythm-thin ${pct(t.rhythm, t.sections)} of ${t.sections} sections ` +
      `(intros/outros/breaks excluded); two busy parts ${pct(t.busyPairs, t.allSections)}, unison clashes ${pct(t.unison, t.allSections)} of ${t.allSections}`,
  );
}
console.log(`songs with 0/1/2 partner tracks: ${after.addedPerSong.join('/')}`);
console.log('partners by genre:family:', JSON.stringify(after.addedFamilies));
