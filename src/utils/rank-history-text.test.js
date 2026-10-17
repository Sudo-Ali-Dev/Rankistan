import { describe, it, expect } from 'vitest';
import {
  dayMonth,
  historySentences,
  moveMarker,
  moveSentences,
  shortDate
} from './rank-history-text';

const move = (p, own, others, before, after) => ({
  kind: 'move',
  since: '2026-10-20T12:00:00.000Z',
  places: p,
  own,
  others,
  score_then: before,
  score_now: after
});
const file = (movement, extra = {}) => ({
  generated: '2026-10-21T12:00:00.000Z',
  scoring: { version: '3.1', since: '2026-10-17' },
  movement,
  ...extra
});
const say = (m) => historySentences(file(m)).join(' ');

describe('moveMarker', () => {
  it('shows places moved, the same rank, a first day and a return, in words for a screen reader', () => {
    expect(moveMarker(12)).toEqual({
      text: '▲ 12',
      label: 'Up 12 places since this time yesterday'
    });
    expect(moveMarker(-1)).toEqual({
      text: '▼ 1',
      label: 'Down 1 place since this time yesterday'
    });
    expect(moveMarker(0)).toEqual({ text: '=', label: 'Same rank as this time yesterday' });
    expect(moveMarker('new').text).toBe('New');
    expect(moveMarker('back').text).toBe('Back');
    expect(moveMarker(undefined)).toBeNull();
  });
});

describe('the sentences', () => {
  it('say what the score explains and what other developers explain', () => {
    expect(say(move(12, 9, 3, 600, 603.4))).toBe(
      'Up 12 places since this time yesterday. The score rose 3.40 points, which accounts for 9 ' +
        "of them. The other 3 came from changes in other developers' scores."
    );
    expect(say(move(4, 4, 0, 600, 601))).toBe(
      'Up 4 places since this time yesterday. The score rose 1.00 points, which accounts for all of them.'
    );
  });

  it('say so when the score did not change', () => {
    expect(say(move(4, 0, 4, 600, 600))).toBe(
      'Up 4 places since this time yesterday. The score did not change. Some developers who were ' +
        'ahead now score lower, or left the board.'
    );
    expect(say(move(-6, 0, -6, 600, 600))).toBe(
      'Down 6 places since this time yesterday. The score did not change. Other developers moved ahead.'
    );
    expect(say(move(0, 0, 0, 600, 600))).toBe(
      'Same rank as this time yesterday. The score did not change.'
    );
  });

  it('explain a fall, and why a score can fall', () => {
    expect(say(move(-30, -26, -4, 600, 597.6))).toBe(
      'Down 30 places since this time yesterday. The score fell 2.40 points, which accounts for 26 ' +
        "of them. The other 4 came from changes in other developers' scores. A score covers the " +
        'last 30 days, so it can fall when older active days leave that window.'
    );
    expect(say(move(-2, 0, -2, 500, 501.1))).toBe(
      'Down 2 places since this time yesterday. The score rose 1.10 points, but other developers rose more.'
    );
  });

  it('say what each part did when they pulled opposite ways, so they visibly add up', () => {
    expect(say(move(6, 9, -3, 600, 603))).toBe(
      "Up 6 places since this time yesterday. On its own, the score's change would have moved it " +
        "up 9 places. Other developers' changes moved it down 3 places."
    );
  });

  it('cover a first day, a return, a scoring change and nothing to compare with', () => {
    expect(say({ kind: 'new' })).toBe('First day on the board. Places moved show from tomorrow.');
    expect(say({ kind: 'back', last: { d: '2026-10-09', rank: 943 }, away_days: 6 })).toBe(
      'Back on the board after 6 days away. Last here on 9 October at rank 943.'
    );
    expect(say({ kind: 'back', last: { d: '2026-10-20', rank: 999 }, away_days: 0 })).toBe(
      'Back on the board. Last here on 20 October at rank 999.'
    );
    expect(say({ kind: 'scoring' })).toBe(
      'Scoring changed on 17 October. Places moved show again once a day has passed under the new scoring.'
    );
    expect(say(null)).toBe('There is no board from this time yesterday to compare with.');
  });

  it('name the board compared with when it is much older than a day', () => {
    const old = { ...move(3, 3, 0, 600, 601), since: '2026-10-15T12:00:00.000Z' };
    expect(historySentences(file(old))[0]).toBe(
      'Compared with the board of 15 October, the last one before today.'
    );
  });

  it('never use a semicolon, an em dash or a colon', () => {
    const all = [
      move(12, 9, 3, 600, 603.4),
      move(-30, -26, -4, 600, 597.6),
      move(6, 9, -3, 600, 603),
      move(-6, -9, 3, 600, 597),
      move(3, -2, 5, 600, 599),
      move(0, 3, -3, 600, 601),
      move(0, -3, 3, 600, 599),
      { kind: 'new' },
      { kind: 'scoring' },
      null
    ].flatMap((m) => historySentences(file(m)));
    for (const sentence of all) expect(sentence).not.toMatch(/[;:—]/);
    expect(moveSentences(move(-6, -9, 3, 600, 597)).join(' ')).toContain('moved it down 9 places');
  });
});

describe('dates', () => {
  it('read as Pakistan dates, never converted', () => {
    expect(dayMonth('2026-10-17')).toBe('17 October');
    expect(shortDate('2026-11-03')).toBe('3 NOV');
  });
});
