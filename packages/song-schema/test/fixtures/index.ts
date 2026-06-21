import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

export interface EngineFixture {
  id: string;
  envelope: 'engine';
  song: unknown;
  instruments: unknown[];
  source: string;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function loadEngineWebTesterFixture(): EngineFixture {
  const dir = join(FIXTURES_DIR, 'engine-web-tester-1');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'meta.json');
  const songFile = files.find((f) => f === 'song.json');
  if (!songFile) throw new Error(`web-tester fixture missing song.json in ${dir}`);
  const instFiles = files
    .filter((f) => f.startsWith('inst-'))
    .sort((a, b) => instOrder(a) - instOrder(b));
  return {
    id: 'engine-web-tester-1',
    envelope: 'engine',
    song: loadJson(join(dir, songFile)),
    instruments: instFiles.map((f) => loadJson(join(dir, f))),
    source: 'casperaki_engine/LibWASM/casperaki-web-tester/src/assets/songs/1',
  };
}

export function loadEngineE2eFixtures(): EngineFixture[] {
  const dir = join(FIXTURES_DIR, 'engine-e2etest');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'meta.json');
  return files.map((f) => ({
    id: `engine-e2etest:${f.replace(/\.json$/u, '')}`,
    envelope: 'engine' as const,
    song: loadJson(join(dir, f)),
    instruments: [],
    source: `casperaki_engine/Source/tests/e2etest/${f}`,
  }));
}

export function allEngineFixtures(): EngineFixture[] {
  return [loadEngineWebTesterFixture(), ...loadEngineE2eFixtures()];
}

function instOrder(name: string): number {
  const match = name.match(/^inst-(\d+)\.json$/u);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
