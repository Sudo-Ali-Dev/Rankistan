import { describe, it, expect } from 'vitest';
import {
  COMPARABLE_FROM,
  boardMoves,
  comparableThen,
  currentSegment,
  developerHistory,
  isHistoryFileFor,
  scoringOf,
  splitMove
} from './rank-history-view';

const COLS = [
  'id',
  'login',
  'rank',
  'tie',
  'score',
  'work',
  'collab',
  'appr',
  'days',
  'age',
  'flags'
];
const record = (d, rows, { model = '3.1.0', out = [] } = {}) => ({
  v: 1,
  d,
  model,
  cols: COLS,
  rows: rows.map(([id, login, rank, score, flags = 0]) => [
    id,
    login,
    rank,
    0,
    score,
    0,
    0,
    0,
    10,
    0,
    flags
  ]),
  out
});
const gap = (d) => ({ v: 1, d, gap: 'no_state' });
// 21 October 2026, 17:00 in Pakistan.
const board = (rows, last_updated = '2026-10-21T12:00:00.000Z') => ({
  last_updated,
  leaderboard: rows.map(([id, username, rank, score]) => ({
    github_id: id,
    username,
    rank,
    score_exact: score,
    model_version: '3.1.0'
  }))
});
const then = (rows, last_updated = '2026-10-20T12:00:00.000Z', model = '3.1.0') => ({
  last_updated,
  model,
  rows
});

describe('splitMove', () => {
  it("splits a move into the developer's own part and everyone else's, adding up exactly", () => {
    // Rank 50 yesterday at 600 points, rank 41 today at 610. Today 44 others score above 600, so
    // yesterday's score would rank 45th now: the developer's own rise explains 45 to 41, and
    // other developers' changes explain 50 to 45.
    const others = [...Array(40).fill(700), ...Array(4).fill(605), ...Array(100).fill(100)];
    const move = splitMove({
      rankThen: 50,
      scoreThen: 600,
      rankNow: 41,
      scoreNow: 610,
      othersNow: others
    });
    expect(move).toMatchObject({ places: 9, own: 4, others: 5 });
    expect(move.own + move.others).toBe(move.places);
  });

  it('can rise with a falling rank, when others rose more', () => {
    const move = splitMove({
      rankThen: 10,
      scoreThen: 500,
      rankNow: 12,
      scoreNow: 501,
      othersNow: [...Array(11).fill(600), ...Array(5).fill(100)]
    });
    expect(move.places).toBe(-2);
    expect(move.own).toBe(0);
    expect(move.others).toBe(-2);
  });
});

describe('the current scoring', () => {
  it('is the model major.minor, and nothing before a change of it is kept', () => {
    expect(scoringOf('3.1.0')).toBe('3.1');
    expect(scoringOf('3.1.4')).toBe('3.1');
    const records = [
      record('2026-10-17', [[1, 'ana', 1, 700]], { model: '3.1.0' }),
      record('2026-10-18', [[1, 'ana', 1, 690]], { model: '3.2.0' }),
      gap('2026-10-19'),
      record('2026-10-20', [[1, 'ana', 2, 650]], { model: '3.2.1' })
    ];
    const segment = currentSegment(records, '3.2');
    expect(segment.since).toBe('2026-10-18');
    expect(segment.records.map((r) => r.d)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
  });

  it('never compares with a board of another scoring, or one from before the restore', () => {
    const now = board([[1, 'ana', 1, 700]]);
    expect(comparableThen(then([[1, 1, 700]]), now)).not.toBeNull();
    expect(comparableThen(then([[1, 1, 700]], undefined, '3.0.0'), now)).toBeNull();
    expect(comparableThen(then([[1, 1, 700]], '2026-10-17T00:00:00.000Z'), now)).toBeNull();
    expect(Date.parse(COMPARABLE_FROM)).toBeGreaterThan(Date.parse('2026-10-16T21:47:00Z'));
  });
});

describe('boardMoves', () => {
  const records = [
    record('2026-10-19', [
      [1, 'ana', 1, 700],
      [3, 'cy', 2, 650]
    ]),
    record('2026-10-20', [[1, 'ana', 1, 700]])
  ];

  it('marks a move, the same rank, a first day and a return', () => {
    const now = board([
      [1, 'ana', 2, 690],
      [2, 'bob', 1, 720],
      [3, 'cy', 3, 600],
      [4, 'dee', 4, 500]
    ]);
    const moves = boardMoves({
      board: now,
      then: then([
        [1, 1, 700],
        [4, 4, 480]
      ]),
      records
    });
    expect(Object.fromEntries(moves)).toEqual({ 1: -1, 2: 'new', 3: 'back', 4: 0 });
  });

  it('marks nothing on the day after a scoring change', () => {
    const now = board([[1, 'ana', 1, 700]]);
    expect(
      boardMoves({ board: now, then: then([[1, 1, 700]], undefined, '3.0.0'), records }).size
    ).toBe(0);
  });
});

describe('developerHistory', () => {
  const records = [
    record('2026-10-17', [[1, 'ana', 30, 600]]),
    record('2026-10-18', [[1, 'ana', 25, 610]]),
    gap('2026-10-19'),
    record('2026-10-20', [[1, 'ana', 28, 605, 2]])
  ];
  const now = board([
    [2, 'bob', 1, 900],
    [1, 'ana', 20, 640]
  ]);

  it("holds the developer's daily closes under the current scoring, and today live", () => {
    const file = developerHistory({ records, board: now, row: now.leaderboard[1], then: null });
    expect(file.points).toEqual([
      ['2026-10-17', 30, 0, 600, 10],
      ['2026-10-18', 25, 0, 610, 10],
      ['2026-10-20', 28, 0, 605, 10],
      ['2026-10-21', 20, 0, 640, null]
    ]);
    // The best daily close, never today's live rank.
    expect(file.best).toEqual({ rank: 25, d: '2026-10-18' });
    expect(file.first).toBe('2026-10-17');
    expect(file.gaps).toEqual(['2026-10-19']);
    expect(file.moderation).toEqual(['2026-10-20']);
    // Five dates, one of which had no board: four on the board of four.
    expect([file.days_on, file.days_span]).toEqual([4, 4]);
    expect(isHistoryFileFor(file, 'ANA')).toBe(true);
  });

  it('explains a move since this time yesterday', () => {
    const file = developerHistory({
      records,
      board: now,
      row: now.leaderboard[1],
      then: then([
        [2, 1, 900],
        [1, 28, 605]
      ])
    });
    expect(file.movement).toMatchObject({ kind: 'move', rank_then: 28, rank_now: 20, places: 8 });
  });

  it('says how long a returning developer was away, and where they were last', () => {
    const later = board([[1, 'ana', 40, 560]], '2026-10-25T12:00:00.000Z');
    const file = developerHistory({
      records,
      board: later,
      row: later.leaderboard[0],
      then: then([[9, 1, 900]], '2026-10-24T12:00:00.000Z')
    });
    expect(file.movement).toEqual({
      kind: 'back',
      last: { d: '2026-10-20', rank: 28 },
      away_days: 4
    });
  });

  it('has no file for anyone not on the board', () => {
    expect(developerHistory({ records, board: now, row: { github_id: 5 } })).toBeNull();
  });
});
