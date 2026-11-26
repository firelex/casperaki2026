// The singers list (src/routes/singers.ts): the real list in the vocals service loads, and its errors name the problem.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readSingers } from '../src/routes/singers.js';

describe('singers', () => {
  it('the vocals service lists Singer 1, its voice files present', () => {
    const singers = readSingers(join(__dirname, '../../models/services/vocals/voices'));
    expect(singers.map((s) => s.name)).toContain('Singer 1');
  });

  it('a singer whose voice file is missing is an error naming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singers-'));
    try {
      writeFileSync(join(dir, 'singers.json'), JSON.stringify([{ id: 'x', name: 'X', description: 'd', source: 's', audio: 'x.mp3', meta: 'x.json' }]));
      expect(() => readSingers(dir)).toThrow(/X \(x\) names x\.mp3, which is not in/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
