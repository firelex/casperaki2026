export const SCHEMA_VERSION = '1' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const SCHEMA_ID = 'https://schema.casperaki.dev/song/v1.json' as const;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function migrate(input: unknown, fromVersion: string): unknown {
  if (compareVersions(fromVersion, SCHEMA_VERSION) === 0) return input;
  throw new Error(
    `[song-schema] no migration path from v${fromVersion} to v${SCHEMA_VERSION} (only v1 supported)`,
  );
}
