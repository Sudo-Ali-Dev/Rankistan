import { describe, it, expect } from 'vitest';
import { historyLines } from './rank-history-lines';

const file = (points, { gaps = [], today = points.at(-1)[0] } = {}) => ({
  today,
  gaps,
  points: points.map(([d, rank, score]) => [d, rank, 0, score, null])
});
const moves = (path) => path.split(' ').filter((step) => step.startsWith('M')).length;

describe('historyLines', () => {
  it('draws one unbroken line for days on the board in a row, best rank at the top', () => {
    const lines = historyLines(
      file([
        ['2026-10-17', 30, 600],
        ['2026-10-18', 10, 650],
        ['2026-10-19', 20, 620]
      ])
    );
    expect(moves(lines.rank)).toBe(1);
    const [first, best] = lines.dots;
    expect(best.rank).toBeLessThan(first.rank); // rank 10 sits above rank 30
    expect(best.score).toBeLessThan(first.score); // and the higher score above the lower
    expect(lines.rankDots).toBe('');
  });

  it('breaks across days off the board, but not across a day with no board at all', () => {
    const away = historyLines(
      file([
        ['2026-10-17', 30, 600],
        ['2026-10-18', 28, 610],
        ['2026-10-21', 25, 615],
        ['2026-10-22', 24, 616]
      ])
    );
    expect(moves(away.rank)).toBe(2);
    const noBoard = historyLines(
      file(
        [
          ['2026-10-17', 30, 600],
          ['2026-10-18', 28, 610],
          ['2026-10-20', 25, 615]
        ],
        { gaps: ['2026-10-19'] }
      )
    );
    expect(moves(noBoard.rank)).toBe(1);
  });

  it('draws a day alone on its spell, such as today after a return, as a dot', () => {
    const lines = historyLines(
      file([
        ['2026-10-17', 30, 600],
        ['2026-10-18', 28, 610],
        ['2026-10-25', 40, 560]
      ])
    );
    expect(moves(lines.rank)).toBe(1);
    expect(lines.rankDots).toMatch(/^M[\d.]+,[\d.]+ l0\.01,0$/);
    // Inside the plot, never on its edge.
    const x = Number(lines.rankDots.slice(1).split(',')[0]);
    expect(x).toBeLessThan(240);
    expect(lines.dots[0].x).toBeGreaterThan(0);
  });
});
