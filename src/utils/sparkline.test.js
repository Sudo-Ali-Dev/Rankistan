import { describe, it, expect } from 'vitest';
import { sparklinePath, SPARKLINE_DAYS } from './sparkline.js';

describe('sparkline has no way to invent a series', () => {
  // The regression that got the original removed in 5eae21d: it took a single
  // monthly total and produced 30 daily values from a seeded random walk. The
  // module no longer exports anything that can do that.
  it('exports only geometry, never a generator', async () => {
    const mod = await import('./sparkline.js');
    expect(Object.keys(mod).sort()).toEqual(['SPARKLINE_DAYS', 'sparklinePath']);
    expect(mod.generateDailyDistribution).toBeUndefined();
  });

  it('draws nothing when given nothing, rather than filling the gap', () => {
    for (const empty of [[], null, undefined]) {
      const out = sparklinePath(empty);
      expect(out.path).toBe('');
      expect(out.bars).toEqual([]);
      expect(out.days).toBe(0);
    }
  });
});

describe('sparklinePath', () => {
  const series = [0, 1, 2, 3, 4, 3, 2, 1, 0, 2];

  it('keeps one bar per day given', () => {
    expect(sparklinePath(series).bars).toHaveLength(series.length);
    expect(sparklinePath(series).days).toBe(series.length);
  });

  it('counts active days rather than summing intensity into a total', () => {
    // Summing 0-4 bands would read as a quantity of work, which it is not.
    expect(sparklinePath(series).activeDays).toBe(8);
    expect(sparklinePath([0, 0, 0]).activeDays).toBe(0);
  });

  it('never draws above the plot or below the baseline', () => {
    const height = 40;
    const { bars } = sparklinePath(series, 240, height);
    for (const bar of bars) {
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.height).toBeLessThanOrEqual(height);
      expect(bar.height).toBeGreaterThan(0);
    }
  });

  it('gives the tallest bar to the busiest day', () => {
    const { bars } = sparklinePath(series);
    const tallest = bars.indexOf([...bars].sort((a, b) => b.height - a.height)[0]);
    expect(series[tallest]).toBe(Math.max(...series));
  });

  it('holds control points level with the segment ends, so the curve cannot overshoot', () => {
    const { path } = sparklinePath(series);
    const ys = [...path.matchAll(/[MLC]([\d.-]+),([\d.-]+)/g)].map((m) => Number(m[2]));
    const curves = [
      ...path.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)
    ];
    expect(curves.length).toBeGreaterThan(0);

    // cp1 sits at the previous point's height and cp2 at this one's, so no part
    // of the curve can rise above the taller end or fall below the shorter.
    let previousY = ys[0];
    for (const c of curves) {
      const [cp1y, cp2y, endY] = [Number(c[2]), Number(c[4]), Number(c[6])];
      expect(cp1y).toBeCloseTo(previousY, 1);
      expect(cp2y).toBeCloseTo(endY, 1);
      previousY = endY;
    }
    expect(path.startsWith('M')).toBe(true);
    expect(path).not.toContain('L');
  });

  it('centres each bar on its own point in the line', () => {
    // #50 offset bars half a step right of the line, so the peak of the curve
    // sat between two bars instead of over the tall one.
    const width = 240;
    const { bars } = sparklinePath(series, width, 40);
    const stepX = width / (series.length - 1);
    for (const [index, bar] of bars.entries()) {
      expect(bar.x + bar.width / 2).toBeCloseTo(index * stepX, 5);
    }
  });

  it('puts the curve peak over the tallest bar, not beside it', () => {
    const { bars, path } = sparklinePath(series, 240, 40);
    const tallest = bars.reduce((best, bar, i) => (bar.height > bars[best].height ? i : best), 0);

    // Endpoint of each command: the single pair after M, the third pair after C.
    const ys = [Number(/^M[\d.-]+,([\d.-]+)/.exec(path)[1])];
    for (const m of path.matchAll(/C[\d.-]+,[\d.-]+ [\d.-]+,[\d.-]+ [\d.-]+,([\d.-]+)/g)) {
      ys.push(Number(m[1]));
    }

    expect(ys).toHaveLength(bars.length);
    // Smallest y is highest on screen.
    expect(ys.indexOf(Math.min(...ys))).toBe(tallest);
  });

  it('shows at most the window it declares', () => {
    const long = Array.from({ length: 200 }, (_, i) => i % 5);
    expect(sparklinePath(long).days).toBe(SPARKLINE_DAYS);
  });

  it('treats junk as absence rather than drawing it', () => {
    const { bars, activeDays } = sparklinePath([1, 'x', null, -4, 2]);
    expect(bars).toHaveLength(5);
    expect(activeDays).toBe(2);
  });
});
