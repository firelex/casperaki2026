#!/usr/bin/env node
// One-shot importer: legacy `casperaki2-engine-js/api/v1.0/services/classes/
// chords/chords.json` (79-entry chord-progression bank) → arrangement
// package's `data/precedent-bank.json`, with every chord symbol mapped to
// a Step-1 roman-numeral vocabulary entry against its precedent's home key.
//
// Idempotent: re-running with the same legacy input + same vocabulary
// produces byte-identical bytes (no Date, no Math.random, sorted output).
//
// Run from anywhere:
//   node packages/arrangement/scripts/import-chord-bank.mjs
//
// Provenance + normalisation rules are documented in
// docs/53m-step3-chord-precedents.md.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const LEGACY_SRC = resolve(
  PKG_ROOT,
  '../../../casperaki2-engine-js/api/v1.0/services/classes/chords/chords.json',
);
const VOCAB_PATH = resolve(PKG_ROOT, 'data/chords.json');
const OUT_PATH = resolve(PKG_ROOT, 'data/precedent-bank.json');

// Sharps-only pitch-class map; aliases for flats normalise into the same
// pitch class. Mirrors arrangement/src/chords/index.ts PITCH_CLASS_NAMES.
const PC = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const DIATONIC_MAJOR = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const DIATONIC_MINOR = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

// Borrowed-degree preference table: chromatic semitones not in the major
// scale map to a (nearest diatonic, accidental) pair. Flat-side preferred
// for #1/b3/b6/b7; sharp-side for the lone tritone #4. Mirrors the table
// used in the Step-1 derivation in docs/53l-…
const BORROWED = {
  1:  { degree: 2, acc: -1, sym: 'b' }, // bII
  3:  { degree: 3, acc: -1, sym: 'b' }, // bIII
  6:  { degree: 4, acc:  1, sym: '#' }, // #IV
  8:  { degree: 6, acc: -1, sym: 'b' }, // bVI
  10: { degree: 7, acc: -1, sym: 'b' }, // bVII
};

// Legacy parser regex from casperaki2-engine-js/api/v1.0/services/tools.js
// line ~198. Capture groups: root (letter + optional #/b), optional 'm'
// (negative-lookahead for "maj"), and an open-ended tail.
const CHORD_RE = /^([A-G][#b]?)(m(?!aj))?(.*)$/u;

// Tail → internal qualityKey + numeralSuffix. qualityKey is the key Step 1
// added to data/chords.json's qualitySymbols block. numeralSuffix is what
// gets appended to the roman-numeral name (e.g. "vi" + "" = "vi"; "V" +
// "sus" = "Vsus"; "ii" + "7" = "ii7"). For plain minor triads the
// numeralSuffix is empty — the lowercase Roman case already encodes "min".
function classifyTail(tail, isMinor) {
  if (isMinor) {
    if (tail === '')      return { qualityKey: 'min',  numeralSuffix: '' };
    if (tail === '7')     return { qualityKey: 'min7', numeralSuffix: '7' };
    if (tail === '9')     return { qualityKey: 'min9', numeralSuffix: '9' };
    throw new Error(`unknown minor tail: "${tail}"`);
  }
  switch (tail) {
    case '':     return { qualityKey: 'maj',   numeralSuffix: '' };
    case '7':    return { qualityKey: 'dom7',  numeralSuffix: '7' };
    case '9':    return { qualityKey: 'dom9',  numeralSuffix: '9' };
    case 'maj7': return { qualityKey: 'maj7',  numeralSuffix: 'maj7' };
    case 'maj9': return { qualityKey: 'maj9',  numeralSuffix: 'maj9' };
    case 'sus':  return { qualityKey: 'sus',   numeralSuffix: 'sus' };
    case '6':    return { qualityKey: 'add6',  numeralSuffix: '6' };
    case '11':   return { qualityKey: 'dom11', numeralSuffix: '11' };
    case '5':    return { qualityKey: 'pow5',  numeralSuffix: '5' };
    default: throw new Error(`unknown major tail: "${tail}"`);
  }
}

// (precedentKey, rootName, isMinor, qualitySuffix) → numeralKey present in
// the Step-1 vocabulary file. Throws if the offset is borrowed but not in
// BORROWED — that signals a chord shape Step 1 didn't anticipate.
function deriveNumeral(precedentKey, root, isMinor, qualitySuffix) {
  const tonic = PC[precedentKey];
  if (tonic === undefined) throw new Error(`unknown precedent key: "${precedentKey}"`);
  const rootPc = PC[root];
  if (rootPc === undefined) throw new Error(`unknown chord root: "${root}"`);
  const offset = (rootPc - tonic + 12) % 12;
  const baseTable = isMinor ? DIATONIC_MINOR : DIATONIC_MAJOR;
  const diatonicIdx = MAJOR.indexOf(offset);
  if (diatonicIdx !== -1) return baseTable[diatonicIdx] + qualitySuffix;
  const b = BORROWED[offset];
  if (!b) throw new Error(`no numeral for chromatic offset ${offset}`);
  return b.sym + baseTable[b.degree - 1] + qualitySuffix;
}

function convertEntry(entry, vocab) {
  const { precedent, key: sourceKey, isLeadUpToChorus, isChorus, chords } = entry;
  const bars = chords.map((bar) =>
    bar.map((sym) => {
      const m = CHORD_RE.exec(sym);
      if (!m) throw new Error(`legacy chord did not match parser: "${sym}"`);
      const root = m[1];
      const isMinor = !!m[2];
      const tail = m[3] ?? '';
      const { qualityKey, numeralSuffix } = classifyTail(tail, isMinor);
      const numeral = deriveNumeral(sourceKey, root, isMinor, numeralSuffix);
      if (!vocab.romanNumerals[numeral]) {
        throw new Error(
          `legacy "${sym}" in key "${sourceKey}" → "${numeral}" — not in vocabulary; ` +
          `Step 1 missed this entry. Add it to data/chords.json.`,
        );
      }
      const entry = vocab.romanNumerals[numeral];
      if (entry.quality !== qualityKey) {
        throw new Error(
          `vocabulary mismatch for "${numeral}": expected quality "${qualityKey}", got "${entry.quality}"`,
        );
      }
      return numeral;
    }),
  );
  // Roles: legacy ChordsClass.addChordsToSong filters: verse=all, preChorus=
  // entries with isLeadUpToChorus, chorus=entries with isChorus. So every
  // entry is a verse candidate, with optional additional roles.
  const roles = ['verse'];
  if (isLeadUpToChorus) roles.push('preChorus');
  if (isChorus) roles.push('chorus');
  return { precedent, sourceKey, roles, bars };
}

// Deterministic JSON pretty-printer that matches the hand-written style of
// data/chords.json: 2-space indent, no trailing spaces, LF line endings,
// arrays on a single line for inner bar lists (4 numerals per bar).
function stringifyBank(bank) {
  const lines = [];
  const w = (s) => lines.push(s);
  w('{');
  w('  "$schemaVersion": 1,');
  w('  "$description": "Imported legacy chord-progression bank. Each entry is one 4-bar block of roman numerals in a key-agnostic representation; resolveBankEntry(entry, key) lowers it to ChordSymbol[][] against any target key. Roles mirror legacy filter semantics: `verse` applies to every entry; `preChorus`/`chorus` are present only for entries the legacy code filtered by `isLeadUpToChorus`/`isChorus`.",');
  w('  "LEGACY_PROVENANCE": {');
  w('    "source": "casperaki2-engine-js/api/v1.0/services/classes/chords/chords.json",');
  w(`    "extractedAt": "${bank.LEGACY_PROVENANCE.extractedAt}",`);
  w(`    "sourceEntryCount": ${bank.LEGACY_PROVENANCE.sourceEntryCount},`);
  w(`    "importedEntryCount": ${bank.LEGACY_PROVENANCE.importedEntryCount},`);
  w('    "transform": "Each legacy chord symbol parsed via the same regex `^([A-G][#b]?)(m(?!aj))?(.*)$` the legacy tools.js uses, then mapped against its precedent\\u0027s home key to a Step-1 roman-numeral vocabulary entry. No symbols dropped; failure during conversion is a hard error.",');
  w('    "ignoredFields": ["concrete chord-symbol strings — the roman-numeral representation is key-agnostic and any target key resolves via Step-1\\u0027s degreePitchClass + accidental shift"],');
  w('    "importer": "packages/arrangement/scripts/import-chord-bank.mjs"');
  w('  },');
  w('  "entries": [');
  for (let i = 0; i < bank.entries.length; i++) {
    const e = bank.entries[i];
    const trail = i === bank.entries.length - 1 ? '' : ',';
    w('    {');
    w(`      "precedent": ${JSON.stringify(e.precedent)},`);
    w(`      "sourceKey": ${JSON.stringify(e.sourceKey)},`);
    w(`      "roles": [${e.roles.map((r) => JSON.stringify(r)).join(', ')}],`);
    w('      "bars": [');
    for (let j = 0; j < e.bars.length; j++) {
      const bar = e.bars[j];
      const t = j === e.bars.length - 1 ? '' : ',';
      w(`        [${bar.map((n) => JSON.stringify(n)).join(', ')}]${t}`);
    }
    w('      ]');
    w(`    }${trail}`);
  }
  w('  ]');
  w('}');
  return lines.join('\n') + '\n';
}

async function main() {
  const [legacyJson, vocabJson] = await Promise.all([
    readFile(LEGACY_SRC, 'utf8'),
    readFile(VOCAB_PATH, 'utf8'),
  ]);
  const legacy = JSON.parse(legacyJson);
  const vocab = JSON.parse(vocabJson);

  if (!Array.isArray(legacy)) throw new Error('legacy chords.json is not an array');

  const entries = legacy.map((e, i) => {
    try { return convertEntry(e, vocab); }
    catch (err) {
      throw new Error(`entry #${i} (precedent="${e.precedent}", key="${e.key}"): ${err.message}`);
    }
  });

  // Stable ordering: by precedent name (ASCII), then by role priority
  // (verse-only < preChorus < chorus < both), then by original index. This
  // is the *only* re-ordering applied; within those groups the legacy
  // append order is preserved.
  const ROLE_KEY = (e) => {
    const r = new Set(e.roles);
    if (r.has('chorus') && r.has('preChorus')) return 3;
    if (r.has('chorus')) return 2;
    if (r.has('preChorus')) return 1;
    return 0;
  };
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    const cmp = a.e.precedent.localeCompare(b.e.precedent);
    if (cmp !== 0) return cmp;
    const rk = ROLE_KEY(a.e) - ROLE_KEY(b.e);
    if (rk !== 0) return rk;
    return a.i - b.i;
  });

  const sorted = indexed.map((x) => x.e);

  const bank = {
    LEGACY_PROVENANCE: {
      extractedAt: '2026-06-06',
      sourceEntryCount: legacy.length,
      importedEntryCount: sorted.length,
    },
    entries: sorted,
  };

  if (sorted.length !== legacy.length) {
    throw new Error(`entry count mismatch: legacy ${legacy.length} vs imported ${sorted.length}`);
  }

  const out = stringifyBank(bank);
  await writeFile(OUT_PATH, out, 'utf8');

  const numUnique = new Set(sorted.flatMap((e) => e.bars.flat())).size;
  const numPrecedents = new Set(sorted.map((e) => e.precedent)).size;
  process.stdout.write(
    `wrote ${OUT_PATH}\n` +
    `  ${sorted.length} entries / ${numPrecedents} distinct precedents / ${numUnique} distinct numerals used\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`import-chord-bank: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
