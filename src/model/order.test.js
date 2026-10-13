import { describe, it, expect, vi, afterEach } from 'vitest';
import { compareRows, compareCodePoints } from './order.js';

const row = (username, score_exact, score = Math.round(score_exact)) => ({
  username,
  score,
  score_exact
});

function shuffled(list, seed) {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const names = (rows) => rows.map((r) => r.username);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compareRows', () => {
  it('ranks on the exact score, not the rounded one', () => {
    // All three round to 500. The old order put them alphabetically.
    const board = [row('aaa', 499.6), row('bbb', 500.4), row('ccc', 500.1)];
    expect(names([...board].sort(compareRows))).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('breaks an exact tie on the username, case-folded, by code point', () => {
    const board = [row('zed', 300), row('Alpha', 300), row('beta', 300), row('alpha-2', 300)];
    expect(names([...board].sort(compareRows))).toEqual(['Alpha', 'alpha-2', 'beta', 'zed']);
  });

  it('falls back to the exact username only when the folded ones are equal', () => {
    expect(compareRows(row('ABC', 1), row('abc', 1))).toBeLessThan(0);
    expect(compareRows(row('abc', 1), row('ABC', 1))).toBeGreaterThan(0);
    expect(compareRows(row('abc', 1), row('abc', 1))).toBe(0);
  });

  it('ranks rows that predate score_exact on their rounded score', () => {
    const legacy = { username: 'old', score: 500 };
    expect(compareRows(legacy, row('new', 500.4))).toBeGreaterThan(0);
    expect(compareRows(legacy, row('new', 499.6))).toBeLessThan(0);
    expect(compareRows(legacy, { username: 'older', score: 500 })).toBeLessThan(0);
  });

  it('refuses a row it cannot place, rather than calling it zero', () => {
    expect(() => compareRows({ username: 'x' }, row('y', 1))).toThrow(/no finite/);
    expect(() => compareRows({ username: 'x', score: NaN }, row('y', 1))).toThrow(/no finite/);
    expect(() => compareRows({ score: 1 }, row('y', 1))).toThrow(/no username/);
  });

  describe('is a total order', () => {
    // Heavy ties on purpose: 400 rows, 12 distinct scores, mixed case and
    // punctuation, some legacy rows with no score_exact.
    const board = Array.from({ length: 400 }, (_, i) => {
      const exact = 100 + (i % 12) * 0.25;
      const name = `${i % 3 === 0 ? 'Dev' : 'dev'}-${(i * 7919) % 400}${i % 5 === 0 ? 'x' : ''}`;
      return i % 9 === 0 ? { username: name, score: Math.round(exact) } : row(name, exact);
    });

    it('is antisymmetric and transitive on every pair and triple sampled', () => {
      const sign = (n) => Math.sign(n);
      for (let i = 0; i < board.length; i += 1) {
        for (let j = 0; j < board.length; j += 7) {
          const ab = compareRows(board[i], board[j]);
          expect(sign(ab)).toBe(-sign(compareRows(board[j], board[i])) || 0);
          if (i !== j) expect(ab).not.toBe(0);
        }
      }
      const sorted = [...board].sort(compareRows);
      for (let i = 2; i < sorted.length; i += 1) {
        expect(compareRows(sorted[i - 2], sorted[i - 1])).toBeLessThan(0);
        expect(compareRows(sorted[i - 2], sorted[i])).toBeLessThan(0);
      }
    });

    it('sorts to the same board whatever order the rows arrive in', () => {
      const expected = names([...board].sort(compareRows));
      for (let seed = 1; seed <= 25; seed += 1) {
        expect(names(shuffled(board, seed).sort(compareRows))).toEqual(expected);
      }
    });

    it('does not consult the locale at all', () => {
      const expected = names([...board].sort(compareRows));
      // If anything locale-sensitive were on the path, this would throw.
      vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
        throw new Error('localeCompare called');
      });
      vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(() => {
        throw new Error('toLocaleLowerCase called');
      });
      vi.spyOn(Intl, 'Collator').mockImplementation(() => {
        throw new Error('Intl.Collator called');
      });
      expect(names([...board].sort(compareRows))).toEqual(expected);
    });
  });
});

describe('compareCodePoints', () => {
  it('orders by code point, which UTF-16 `<` does not', () => {
    const astral = '\u{1F600}'; // U+1F600, two UTF-16 code units starting 0xD83D
    const bmpHigh = '￿';
    expect(astral < bmpHigh).toBe(true); // code-unit order
    expect(compareCodePoints(astral, bmpHigh)).toBe(1); // code-point order
    expect(compareCodePoints(bmpHigh, astral)).toBe(-1);
  });

  it('puts a prefix first and treats equal strings as equal', () => {
    expect(compareCodePoints('ab', 'abc')).toBe(-1);
    expect(compareCodePoints('abc', 'ab')).toBe(1);
    expect(compareCodePoints('', '')).toBe(0);
    expect(compareCodePoints('a-b', 'ab')).toBe(-1);
  });
});
