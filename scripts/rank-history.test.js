import { describe, it, expect } from 'vitest';
import {
  FLAG_CARRIED,
  FLAG_MODERATION,
  HISTORY_START,
  OUT_COLUMNS,
  ROW_COLUMNS,
  appendRecords,
  dayRecord,
  gapRecord,
  parseMonth,
  previousRows,
  scrubRecord,
  serializeMonth
} from './rank-history.js';
import { measuredRow } from '../src/model/__fixtures__/measured.js';

// Rows as the board publishes them, scored from real measurements.
const dev = (name, id, days, extra = {}) =>
  measuredRow(name, { days, githubId: id }, { scored_at: '2026-10-17T03:00:00Z', ...extra });
const board = (rows, extra = {}) => {
  const sorted = [...rows].sort((a, b) => b.score_exact - a.score_exact);
  let rank = 0;
  sorted.forEach((row, i) => {
    if (i === 0 || row.score_exact !== sorted[i - 1].score_exact) rank = i + 1;
    row.rank = rank;
  });
  return { last_updated: '2026-10-17T18:50:00.000Z', leaderboard: sorted, ...extra };
};
const column = (record, name) => record.rows.map((r) => r[ROW_COLUMNS.indexOf(name)]);

describe('dayRecord', () => {
  it("records each developer's shared rank, score, parts, active days and age, by account id", () => {
    const close = board([dev('ana', 1, 20), dev('bob', 2, 10), dev('cy', 3, 10)]);
    const record = dayRecord({ date: '2026-10-17', close, state: 'state-1-1.json.gz' });
    expect(record).toMatchObject({
      v: 1,
      d: '2026-10-17',
      at: close.last_updated,
      state: 'state-1-1.json.gz',
      model: close.leaderboard[0].model_version,
      n: 3,
      cols: ROW_COLUMNS,
      out_cols: OUT_COLUMNS,
      out: []
    });
    expect(column(record, 'id')).toEqual([1, 2, 3]);
    expect(column(record, 'login')).toEqual(['ana', 'bob', 'cy']);
    // bob and cy share rank 2: the rank and how many share it, never the order inside the tie.
    expect(column(record, 'rank')).toEqual([1, 2, 2]);
    expect(column(record, 'tie')).toEqual([0, 2, 2]);
    expect(column(record, 'days')).toEqual([20, 10, 10]);
    expect(column(record, 'age')).toEqual([0, 0, 0]);
    const [first] = record.rows;
    const parts = ['work', 'collab', 'appr'].map((p) => first[ROW_COLUMNS.indexOf(p)]);
    // The parts in points add up to the score, to the rounding of each.
    expect(Math.abs(parts.reduce((a, b) => a + b, 0) - first[4])).toBeLessThan(0.16);
    expect(record.last_score).toBe(Math.min(...column(record, 'score')));
  });

  it('says which batches ran on the date', () => {
    const close = board([dev('ana', 1, 20)], {
      batch_runs: {
        0: { at: '2026-10-16T19:10:00Z' }, // 00:10 on 17 October in Pakistan
        5: { at: '2026-10-17T00:10:00Z' },
        6: { at: '2026-10-16T01:10:00Z' } // 16 October: not this date
      }
    });
    const { batches } = dayRecord({ date: '2026-10-17', close, state: 's' });
    expect(batches).toBe('100001000000000000000000');
  });

  it('flags a carried row, and a score that moved with no new measurement', () => {
    const day1 = dayRecord({
      date: '2026-10-17',
      close: board([dev('ana', 1, 20), dev('bob', 2, 12)]),
      state: 's1'
    });
    const ana = dev('ana', 1, 20);
    const bob = { ...dev('bob', 2, 12), missed_runs: 1 };
    // ana's measurement is a day old and her score moved: only the moderation list could do that.
    const close = board([{ ...ana, score_exact: ana.score_exact - 30 }, bob]);
    const day2 = dayRecord({ date: '2026-10-18', close, state: 's2', previous: day1 });
    expect(column(day2, 'age')).toEqual([1, 1]);
    expect(column(day2, 'flags')).toEqual([FLAG_MODERATION, FLAG_CARRIED]);
  });

  it('lists who left since the day before, with the reason and their last figures', () => {
    const day1 = dayRecord({
      date: '2026-10-17',
      close: board([dev('ana', 1, 20), dev('bob', 2, 12), dev('cy', 3, 9)]),
      state: 's1'
    });
    const close = board([dev('ana', 1, 20)], {
      departures: [
        { at: '2026-10-17T18:30:00.000Z', id: 2, reason: 'displaced' }, // late on the 17th
        { at: '2026-10-18T02:00:00.000Z', id: 2, reason: 'ineligible' },
        { at: '2026-10-18T03:00:00.000Z', id: 9, reason: 'missed' } // not on the 17th's board
      ]
    });
    const day2 = dayRecord({ date: '2026-10-18', close, state: 's2', previous: day1 });
    const was = previousRows(day1);
    expect(day2.out).toEqual([
      [2, 'bob', 'below_gate', was.get(2).rank, was.get(2).score, 12],
      [3, 'cy', 'unknown', was.get(3).rank, was.get(3).score, 9]
    ]);
  });

  it('records nothing of an opted-out account, on the board or leaving it', () => {
    const day1 = dayRecord({
      date: '2026-10-17',
      close: board([dev('ana', 1, 20), dev('bob', 2, 12)]),
      state: 's1'
    });
    const optedOut = new Set([2]);
    const same = dayRecord({
      date: '2026-10-18',
      close: board([dev('ana', 1, 20), dev('bob', 2, 12)]),
      state: 's2',
      previous: day1,
      optedOut
    });
    expect(column(same, 'id')).toEqual([1]);
    const gone = dayRecord({
      date: '2026-10-18',
      close: board([dev('ana', 1, 20)]),
      state: 's2',
      previous: day1,
      optedOut
    });
    expect(gone.out).toEqual([]);
  });

  it('starts on the first full date of scoring v3.1', () => {
    expect(HISTORY_START).toBe('2026-10-17');
  });
});

describe('month files', () => {
  const day = (d) => ({ v: 1, d, rows: [[1, 'ana', 1, 0, 700, 1, 1, 1, 20, 0, 0]], out: [] });

  it('read back what was written, oldest first', () => {
    const records = [day('2026-10-17'), gapRecord('2026-10-18'), day('2026-10-19')];
    expect(parseMonth(serializeMonth(records), '2026-10')).toEqual(records);
  });

  it('refuse a file out of order, of another month, or not JSON', () => {
    const two = serializeMonth([day('2026-10-18'), day('2026-10-17')]);
    expect(() => parseMonth(two, '2026-10')).toThrow(/out of order/);
    expect(() => parseMonth(serializeMonth([day('2026-11-01')]), '2026-10')).toThrow(/not a/);
    expect(() => parseMonth('{"v":1,', '2026-10')).toThrow(/not JSON/);
  });

  it('never rewrite a date already published', () => {
    const month = [day('2026-10-17')];
    expect(appendRecords(month, [day('2026-10-18')]).map((r) => r.d)).toEqual([
      '2026-10-17',
      '2026-10-18'
    ]);
    expect(() => appendRecords(month, [day('2026-10-17')])).toThrow(/refusing to rewrite/);
  });

  it('lose an opted-out account from every row and departure, and nothing else', () => {
    const record = {
      ...day('2026-10-17'),
      n: 2,
      rows: [
        [1, 'ana', 1, 0, 700, 1, 1, 1, 20, 0, 0],
        [2, 'bob', 2, 0, 600, 1, 1, 1, 12, 0, 0]
      ],
      out: [[3, 'cy', 'cut', 999, 250, 9]]
    };
    const { record: kept, changed } = scrubRecord(record, new Set([2, 3]));
    expect(changed).toBe(true);
    expect(kept.rows.map((r) => r[0])).toEqual([1]);
    expect(kept.out).toEqual([]);
    expect(kept.n).toBe(1);
    // ana's rank stands as published: nobody else's day is recomputed.
    expect(kept.rows[0][2]).toBe(1);
    expect(scrubRecord(record, new Set([7])).changed).toBe(false);
    expect(scrubRecord(gapRecord('2026-10-18'), new Set([1])).changed).toBe(false);
  });
});
