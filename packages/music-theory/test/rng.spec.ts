import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  it('is deterministic for the same numeric seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('is deterministic for the same string seed', () => {
    const a = createRng('hello-world');
    const b = createRng('hello-world');
    expect(Array.from({ length: 5 }, () => a.int(0, 1000)))
      .toEqual(Array.from({ length: 5 }, () => b.int(0, 1000)));
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('next() returns floats in [0, 1)', () => {
    const r = createRng('uniform');
    for (let i = 0; i < 100; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(min, max) is inclusive on both ends', () => {
    const r = createRng('int-range');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(3, 5));
    expect(seen).toEqual(new Set([3, 4, 5]));
  });

  it('int rejects max<min', () => {
    const r = createRng('bad');
    expect(() => r.int(5, 3)).toThrow();
  });

  it('pick rejects empty arrays', () => {
    const r = createRng('empty');
    expect(() => r.pick([])).toThrow();
  });

  it('pickWeighted matches weights over many draws', () => {
    const r = createRng('weights');
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10000; i++)
      counts[r.pickWeighted(['a', 'b', 'c'], [1, 3, 6])]!++;
    // c should be ~60%, b ~30%, a ~10% — give a generous margin.
    expect(counts.a! / 10000).toBeCloseTo(0.1, 1);
    expect(counts.b! / 10000).toBeCloseTo(0.3, 1);
    expect(counts.c! / 10000).toBeCloseTo(0.6, 1);
  });

  it('fork produces a different stream that is itself deterministic', () => {
    const root = createRng(7);
    const child1 = root.fork('drums');
    const child2 = createRng(7).fork('drums');
    expect(child1.next()).toBe(child2.next());
    expect(createRng(7).fork('bass').next()).not.toBe(child1.next());
  });
});
