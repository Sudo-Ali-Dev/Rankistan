import { describe, it, expect } from 'vitest';
import { planBatches, periodsUntil, labelFor, BATCH_COUNT } from './rebalance.js';
import { BATCH_RANGES, SEARCH_BATCHES } from './batches.js';
import { parseShardQuery } from './partition.js';

describe('planBatches', () => {
  it('splits into contiguous groups that cover every period exactly once', () => {
    const sizes = Array.from({ length: 60 }, (_, i) => 10 + ((i * 37) % 23));
    const { groups } = planBatches(sizes, { k: 6 });
    expect(groups).toHaveLength(6);
    expect(groups[0][0]).toBe(0);
    expect(groups.at(-1)[1]).toBe(60);
    for (let g = 1; g < groups.length; g += 1) expect(groups[g][0]).toBe(groups[g - 1][1]);
  });

  it('keeps every group within the cap, and the newest within its share', () => {
    const sizes = Array.from({ length: 80 }, (_, i) => (i > 60 ? 40 : 15));
    const { groups, cap, newestCap } = planBatches(sizes, { k: 8, newestShare: 0.6 });
    const totals = groups.map(([i, j]) => sizes.slice(i, j).reduce((a, b) => a + b, 0));
    expect(Math.max(...totals.slice(0, -1))).toBeLessThanOrEqual(cap);
    expect(totals.at(-1)).toBeLessThanOrEqual(newestCap);
    expect(newestCap).toBeLessThan(cap);
  });

  it('balances a lopsided series far better than equal-width ranges', () => {
    // Few old accounts, many recent ones: the shape that made the newest batch 3,724.
    const sizes = Array.from({ length: 120 }, (_, i) => Math.round(2 + i ** 1.6 / 20));
    const { groups } = planBatches(sizes, { k: 12 });
    const totals = groups.map(([i, j]) => sizes.slice(i, j).reduce((a, b) => a + b, 0));
    const equal = Array.from({ length: 12 }, (_, g) =>
      sizes.slice(g * 10, g * 10 + 10).reduce((a, b) => a + b, 0)
    );
    expect(Math.max(...totals)).toBeLessThan(Math.max(...equal) / 2);
  });

  it('refuses more batches than periods', () => {
    expect(() => planBatches([1, 2, 3], { k: 4 })).toThrow(/Cannot split/);
  });
});

describe('periodsUntil', () => {
  it('runs gap-free from 2000 to an open end', () => {
    const periods = periodsUntil(new Date('2026-10-13T00:00:00Z'));
    expect(periods[0].from).toBe('2000-01-01');
    expect(periods.at(-1).to).toBe('2099-12-31');
    expect(periods.at(-1).from).toBe('2026-10-01');
    for (let i = 1; i < periods.length; i += 1) {
      const prev = Date.parse(`${periods[i - 1].to}T00:00:00Z`);
      expect(Date.parse(`${periods[i].from}T00:00:00Z`) - prev).toBe(86_400_000);
    }
  });
});

describe('the published table (batches.js)', () => {
  it('has one batch per hour, gap-free from 2000 to an open end', () => {
    expect(SEARCH_BATCHES).toHaveLength(BATCH_COUNT);
    const roots = SEARCH_BATCHES.map((b) => parseShardQuery(b.q).root);
    expect(new Date(roots[0].from * 1000).toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(new Date(roots.at(-1).to * 1000).toISOString().slice(0, 10)).toBe('2099-12-31');
    for (let i = 1; i < roots.length; i += 1) expect(roots[i].from).toBe(roots[i - 1].to + 1);
  });

  it('labels each range from its own dates', () => {
    BATCH_RANGES.forEach((range, index) => {
      expect(SEARCH_BATCHES[index].label).toBe(labelFor(range, index));
    });
  });

  it('was cut to an even size: no batch over 1,640 measured candidates', () => {
    const measured = BATCH_RANGES.map((r) => r.measured);
    expect(Math.max(...measured)).toBeLessThanOrEqual(1640);
    expect(measured.at(-1)).toBeLessThanOrEqual(Math.round(1640 * 0.6));
  });
});
