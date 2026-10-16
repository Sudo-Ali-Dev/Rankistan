import { describe, it, expect } from 'vitest';
import { compareCodePoints } from './order.js';

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
