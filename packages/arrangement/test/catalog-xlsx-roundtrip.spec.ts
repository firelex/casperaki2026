// Two-way XLSX catalog import/export — round-trip + alias coverage.
//
// Proves the export ⇄ import is lossless at three layers:
//   1. pure model     — catalogToWorkbook → workbookToCatalog reproduces
//                        `entries` byte-for-byte and the contentHash.
//   2. sheetjs bytes   — the same through an actual .xlsx write/read.
//   3. drift detection — a tampered catalog cell flips the round-trip gate.
// Plus alias-layer guarantees: deterministic, globally unique, and never
// leaking the underlying library/plugin.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import {
  resolveAliases,
  deriveSoundIdentity,
  baseNameFor,
  nameSpaceSize,
  poolForFamily,
  familyClassWord,
} from '../src/catalog/alias.js';
import {
  catalogToWorkbook,
  workbookToCatalog,
  META_SHEET_NAME,
  type WorkbookModel,
} from '../src/catalog/xlsx-roundtrip.js';
import type { InstrumentCatalogSnapshot } from '../src/catalog/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data');

function loadCatalog(): InstrumentCatalogSnapshot {
  const path = resolve(DATA, 'instrument-catalog.union.json');
  return JSON.parse(readFileSync(path, 'utf8')) as InstrumentCatalogSnapshot;
}

function aliasMapFor(catalog: InstrumentCatalogSnapshot): Map<string, string> {
  return resolveAliases({ entries: catalog.entries }).byId;
}

/** Serialise a WorkbookModel to .xlsx bytes and read it back (sheetjs). */
function throughXlsxBytes(wb: WorkbookModel): WorkbookModel {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of wb) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const buf = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const reread = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const out: WorkbookModel = new Map();
  for (const name of reread.SheetNames) {
    out.set(name, XLSX.utils.sheet_to_json(reread.Sheets[name]!, {
      header: 1,
      defval: null,
      blankrows: false,
    }) as (string | number | null)[][]);
  }
  return out;
}

describe('catalog xlsx round-trip', () => {
  const catalog = loadCatalog();
  const aliasById = aliasMapFor(catalog);

  it('reproduces entries + contentHash through the pure model', () => {
    const wb = catalogToWorkbook(catalog, { aliasById });
    const back = workbookToCatalog(wb);
    expect(back.contentHashMatches).toBe(true);
    expect(back.recomputedContentHash).toBe(catalog.contentHash);
    expect(JSON.stringify(back.snapshot.entries)).toBe(JSON.stringify(catalog.entries));
  });

  it('survives an actual .xlsx write/read (sheetjs bytes)', () => {
    const wb = catalogToWorkbook(catalog, { aliasById });
    const back = workbookToCatalog(throughXlsxBytes(wb));
    expect(back.contentHashMatches).toBe(true);
    expect(JSON.stringify(back.snapshot.entries)).toBe(JSON.stringify(catalog.entries));
  });

  it('carries the names back out unchanged (keyed by sound identity)', () => {
    const resolved = resolveAliases({ entries: catalog.entries });
    const wb = catalogToWorkbook(catalog, { aliasById });
    const back = workbookToCatalog(wb);
    expect(back.aliasByIdentity.size).toBe(resolved.byIdentity.size);
    for (const [identity, name] of resolved.byIdentity) {
      expect(back.aliasByIdentity.get(identity)).toBe(name);
    }
  });

  it('preserves disk-path provenance as read-only columns', () => {
    const diskPathById = new Map([[catalog.entries[0]!.id, 'fx/some - file.wav']]);
    const wb = catalogToWorkbook(catalog, { aliasById, diskPathById });
    // Provenance columns must NOT perturb the reconstructed catalog.
    const back = workbookToCatalog(wb);
    expect(back.contentHashMatches).toBe(true);
  });

  it('detects drift when a catalog cell is edited', () => {
    const wb = catalogToWorkbook(catalog, { aliasById });
    // Find a family sheet and tamper the preset cell of its first data row.
    const sheetName = [...wb.keys()].find((n) => n !== META_SHEET_NAME)!;
    const rows = wb.get(sheetName)!;
    const header = rows[0]!.map((c) => String(c));
    const presetCol = header.indexOf('patch/preset name');
    rows[1]![presetCol] = 'TAMPERED VALUE';
    const back = workbookToCatalog(wb);
    expect(back.contentHashMatches).toBe(false);
  });
});

describe('artificial name (alias) layer', () => {
  const catalog = loadCatalog();

  it('is deterministic', () => {
    expect(baseNameFor('abc123')).toBe(baseNameFor('abc123'));
    const a = resolveAliases({ entries: catalog.entries }).byId;
    const b = resolveAliases({ entries: catalog.entries }).byId;
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('produces clean two-real-word names (no numeric suffixes)', () => {
    // Name space comfortably exceeds the identity count, so probing never
    // falls back to a numeric suffix.
    expect(nameSpaceSize()).toBeGreaterThan(catalog.entries.length);
    const r = resolveAliases({ entries: catalog.entries });
    for (const name of r.byIdentity.values()) {
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u); // "Adjective Noun"
    }
  });

  it('assigns a unique name per sound identity (every row covered)', () => {
    const { byId, byIdentity } = resolveAliases({ entries: catalog.entries });
    const ids = new Set(catalog.entries.map((e) => e.id));
    const identities = new Set(catalog.entries.map((e) => deriveSoundIdentity(e)));
    expect(byId.size).toBe(ids.size); // every catalog row gets a name
    expect(byIdentity.size).toBe(identities.size); // one name per identity
    expect(new Set(byIdentity.values()).size).toBe(byIdentity.size); // names unique
  });

  it('keys names on the style-free identity (re-tagging never renames)', () => {
    // Pick an entry and produce a style-retagged twin; identity + name hold.
    const e = catalog.entries.find((x) => x.mainStyle)!;
    const retagged = {
      ...e,
      mainStyle: (e.mainStyle === 'edm' ? 'latin' : 'edm') as typeof e.mainStyle,
      addStyles: [] as typeof e.addStyles,
    };
    expect(deriveSoundIdentity(retagged)).toBe(deriveSoundIdentity(e));
    const r = resolveAliases({ entries: [e, retagged] });
    expect(r.byIdentity.size).toBe(1); // same identity → one name
    expect(r.byId.get(e.id)).toBe(r.byId.get(retagged.id));
  });

  it('pins existing names and only generates the gaps', () => {
    const identity0 = deriveSoundIdentity(catalog.entries[0]!);
    const distinctIdentities = new Set(catalog.entries.map((e) => deriveSoundIdentity(e))).size;
    const r = resolveAliases({ entries: catalog.entries, existing: { [identity0]: 'My Custom Name' } });
    expect(r.byIdentity.get(identity0)).toBe('My Custom Name');
    expect(r.kept).toBe(1);
    expect(r.generated).toBe(distinctIdentities - 1);
  });

  it('never reveals the underlying library or plugin', () => {
    const { byId } = resolveAliases({ entries: catalog.entries });
    let checked = 0;
    for (const e of catalog.entries) {
      const name = byId.get(e.id)!.toLowerCase();
      for (const secret of [e.library, e.addPlugins]) {
        if (!secret) continue;
        for (const token of secret.toLowerCase().split(/[^a-z0-9]+/u)) {
          if (token.length >= 4) expect(name.includes(token)).toBe(false);
        }
      }
      if (++checked >= 500) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('draws names from the family-themed pool (drummy drums, deep bass…)', () => {
    const { byId } = resolveAliases({ entries: catalog.entries });
    // Bass + keys pools have huge headroom, so they never fall back to
    // generic — every name's words must come from the family's themed pool.
    for (const family of ['basses', 'keys'] as const) {
      const pool = poolForFamily(family);
      const adj = new Set(pool.adjectives);
      const noun = new Set(pool.nouns);
      const sample = catalog.entries.filter((e) => e.family === family);
      expect(sample.length).toBeGreaterThan(0);
      for (const e of sample) {
        const [a, n] = byId.get(e.id)!.split(' ');
        expect(adj.has(a!)).toBe(true);
        expect(noun.has(n!)).toBe(true);
      }
    }
  });

  it('uses a public role class word per family', () => {
    expect(familyClassWord('basses')).toBe('Bass');
    expect(familyClassWord('leadSynths')).toBe('Lead');
    expect(familyClassWord('kickDrums')).toBe('Kick');
  });
});
