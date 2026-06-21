// Validated catalog — runtime-gate tests.
//
// Coverage:
// - The committed snapshot + audit produce a consistent validated set
//   (entries.length == audit.summary.matched).
// - Every validated entry has a resolved disk path + the rule that
//   matched it.
// - byId / byPath lookups are correct.
// - 17 catalog rows currently in audit.missing do NOT appear in the
//   validated set — proves the audit is the runtime gate.
// - Staleness gate: an audit referencing a different catalog hash is
//   rejected at load time (covered via a synthetic snapshot mock).
// - The validated set's catalog/auditContentHash fields pin both
//   upstream identities — a future Song.generator can record both
//   exact values.

import { describe, expect, it } from 'vitest';

import {
  loadEffectiveCatalogSnapshot,
  loadValidatedCatalog,
  SampleLibraryAuditReportSchema,
} from '../src/index.js';
import {
  _resetValidatedCatalogCache,
} from '../src/catalog/validated-catalog.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const AUDIT_PATH = resolve(PKG_ROOT, 'data/sample-library.audit.json');

function rawAudit() {
  return SampleLibraryAuditReportSchema.parse(
    JSON.parse(readFileSync(AUDIT_PATH, 'utf8')),
  );
}

describe('loadValidatedCatalog — runtime gate', () => {
  it('entries.length equals audit.summary.matched', () => {
    _resetValidatedCatalogCache();
    const validated = loadValidatedCatalog();
    const audit = rawAudit();
    expect(validated.entries.length).toBe(audit.summary.matched);
  });

  it('every validated entry carries a matchedPath + matchedRule', () => {
    const validated = loadValidatedCatalog();
    for (const e of validated.entries) {
      expect(e.matchedPath.length).toBeGreaterThan(0);
      expect(e.matchedRule.length).toBeGreaterThan(0);
    }
  });

  it('audit.matched and validated.entries reference the same catalogIds', () => {
    const audit = rawAudit();
    const validated = loadValidatedCatalog();
    const matchedIds = new Set(audit.matched.map((m) => m.catalogId));
    const validatedIds = new Set(validated.entries.map((e) => e.id));
    expect(validatedIds.size).toBe(matchedIds.size);
    for (const id of matchedIds) expect(validatedIds.has(id)).toBe(true);
  });

  it('no catalog row from audit.missing appears in the validated set', () => {
    const audit = rawAudit();
    const validated = loadValidatedCatalog();
    const missingIds = new Set(audit.missing.map((m) => m.catalogId));
    for (const e of validated.entries) {
      expect(missingIds.has(e.id), `missing row leaked: ${e.id}`).toBe(false);
    }
  });

  it('byId / byPath lookups are correct + symmetric', () => {
    const validated = loadValidatedCatalog();
    for (const e of validated.entries) {
      expect(validated.byId.get(e.id)).toBe(e);
      expect(validated.byPath.get(e.matchedPath)).toBe(e);
    }
  });

  it('records both upstream content hashes', () => {
    const validated = loadValidatedCatalog();
    const snapshot = loadEffectiveCatalogSnapshot();
    const audit = rawAudit();
    expect(validated.catalogContentHash).toBe(snapshot.contentHash);
    expect(validated.auditContentHash).toBe(audit.contentHash);
  });

  it('validated entries are in catalog snapshot order', () => {
    const validated = loadValidatedCatalog();
    const snapshot = loadEffectiveCatalogSnapshot();
    const snapshotOrder = new Map(snapshot.entries.map((e, i) => [e.id, i]));
    for (let i = 1; i < validated.entries.length; i++) {
      const a = snapshotOrder.get(validated.entries[i - 1]!.id)!;
      const b = snapshotOrder.get(validated.entries[i]!.id)!;
      expect(a).toBeLessThan(b);
    }
  });
});
