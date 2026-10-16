import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { verifyPublished } from './verify-published.js';
import { assignRanks, boardOrder, boardSeed } from '../src/model/order.js';
import { measuredRow } from '../src/model/__fixtures__/measured.js';
import { buildPublicPayload } from '../src/utils/split-data.js';

const LAST_UPDATED = '2026-10-14T10:00:00.000Z';

function board(rows) {
  const ranked = assignRanks([...rows].sort(boardOrder(boardSeed(LAST_UPDATED))));
  return { last_updated: LAST_UPDATED, total_devs: ranked.length, leaderboard: ranked };
}

const rows = [
  measuredRow('ana', { days: 25, merges: 3, githubId: 1 }),
  measuredRow('bob', { days: 12, githubId: 2 }),
  measuredRow('cy', { days: 30, githubId: 3 }),
  measuredRow('dee', { days: 30, githubId: 4 }),
  measuredRow('eve', { days: 5, githubId: 5 })
];

describe('verifyPublished', () => {
  it('passes a board every score of which recomputes from its measurement', () => {
    const report = verifyPublished(board(rows));
    expect(report.errors).toEqual([]);
    expect(report.fromMeasurement).toBe(5);
  });

  it('recomputes the served board, which carries no measurement, from its parts', () => {
    const served = buildPublicPayload(board(rows));
    expect(served.leaderboard.some((r) => 'contributions' in r)).toBe(false);
    const report = verifyPublished(served);
    expect(report.errors).toEqual([]);
    expect(report.fromParts).toBe(5);
  });

  it('gives equal scores one rank, and checks it', () => {
    const b = board(rows);
    const tied = b.leaderboard.filter((r) => r.username === 'cy' || r.username === 'dee');
    expect(tied[0].rank).toBe(tied[1].rank);
    b.leaderboard[b.leaderboard.indexOf(tied[1])] = { ...tied[1], rank: tied[1].rank + 1 };
    expect(verifyPublished(b).errors.join()).toMatch(/rank is \d+, expected \d+/);
  });

  it('fails a score that does not come from its measurement, and names the row', () => {
    const b = board(rows);
    b.leaderboard[1] = { ...b.leaderboard[1], score_exact: b.leaderboard[1].score_exact + 1e-9 };
    expect(verifyPublished(b).errors.join()).toMatch(/its measurement scores/);
  });

  it('fails served parts that do not give the published score', () => {
    const served = buildPublicPayload(board(rows));
    served.leaderboard[0] = {
      ...served.leaderboard[0],
      score_parts: { ...served.leaderboard[0].score_parts, work: 0.1 }
    };
    expect(verifyPublished(served).errors.join()).toMatch(/its parts give/);
  });

  it('fails a board that lists one account twice, under two logins', () => {
    const b = board(rows);
    const twin = { ...b.leaderboard[1], github_id: b.leaderboard[0].github_id ?? 7 };
    b.leaderboard[0] = { ...b.leaderboard[0], github_id: twin.github_id };
    b.leaderboard[1] = twin;
    expect(verifyPublished(b).errors.join()).toMatch(/account \d+ appears more than once/);
  });

  it('fails a row scored by another model version', () => {
    const b = board(rows);
    b.leaderboard[0] = { ...b.leaderboard[0], model_version: '2.0.0' };
    expect(verifyPublished(b).errors.join()).toMatch(/scored by "2.0.0", not 3.1.0/);
  });

  it('fails a board out of order, a developer listed twice, and a file with no leaderboard', () => {
    const b = board(rows);
    const swapped = {
      ...b,
      leaderboard: [b.leaderboard[1], b.leaderboard[0], ...b.leaderboard.slice(2)]
    };
    expect(verifyPublished(swapped).errors.join()).toMatch(/not in board order/);
    const twice = board([...rows, { ...rows[0], username: 'ANA' }]);
    expect(verifyPublished(twice).errors.join()).toMatch(/more than once/);
    expect(verifyPublished({}).errors).toEqual(['payload has no "leaderboard" array']);
  });

  it('fails a measurement that no longer passes the gate, as after a moderation entry', () => {
    const b = board(rows);
    const moderation = [{ repo: 'eve/app', reason: 'a script commits here' }];
    expect(verifyPublished(b, { moderation }).errors.join()).toMatch(/eve/);
  });
});

describe('the committed sample board', () => {
  it('is a board the pipeline would publish', () => {
    const sample = JSON.parse(fs.readFileSync('fixtures/data.sample.json', 'utf8'));
    expect(verifyPublished(sample).errors).toEqual([]);
  });
});
