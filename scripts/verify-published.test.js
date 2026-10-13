import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { verifyPublished } from './verify-published.js';
import { scoreModel, publishedScoreFields } from '../src/model/score.js';
import { compareRows } from '../src/model/order.js';
import { SCORE_CONFIG } from '../src/model/config.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 6, 0, 0, 0);

function stamped(username, stars, pushes) {
  const dev = {
    username,
    total_stars: stars,
    followers: 10,
    public_repos: 8,
    created_at: '2018-02-03T04:05:06Z',
    raw_events_60d: Array.from({ length: pushes }, (_, k) => ({
      type: 'PushEvent',
      created_at: new Date(NOW - k * DAY).toISOString()
    }))
  };
  const result = scoreModel(dev, { config: SCORE_CONFIG, now: NOW });
  return {
    username,
    total_stars: dev.total_stars,
    followers: dev.followers,
    public_repos: dev.public_repos,
    created_at: dev.created_at,
    ...publishedScoreFields(result, { config: SCORE_CONFIG, now: NOW })
  };
}

const legacy = (username, score) => ({ username, score });

function board(rows) {
  const ordered = [...rows].sort(compareRows).map((r, i) => ({ ...r, rank: i + 1 }));
  return { last_updated: 'x', total_devs: ordered.length, leaderboard: ordered };
}

describe('verifyPublished', () => {
  it('counts legacy rows without failing them, and reports the order it would impose', () => {
    // Rows the previous code ordered, in an order compareRows would change.
    const leaderboard = [legacy('b', 500), legacy('A', 500), legacy('c', 400)].map((r, i) => ({
      ...r,
      rank: i + 1
    }));
    const report = verifyPublished({ leaderboard });
    expect(report.errors).toEqual([]);
    expect(report.legacy).toBe(3);
    expect(report.stamped).toBe(0);
    expect(report.orderAsserted).toBe(false);
    expect(report.wouldMove).toBe(2);
  });

  it('passes a board of recomputable rows in order, legacy rows included', () => {
    const report = verifyPublished(
      board([stamped('one', 300, 12), stamped('two', 20, 3), legacy('old', 100)])
    );
    expect(report.errors).toEqual([]);
    expect(report.recomputed).toBe(2);
    expect(report.versions).toEqual([SCORE_CONFIG.MODEL_VERSION]);
  });

  it('fails a score that does not recompute, and names the row', () => {
    const data = board([stamped('one', 300, 12), stamped('two', 20, 3)]);
    data.leaderboard[1].score += 1;
    const { errors } = verifyPublished(data);
    expect(errors.some((e) => /"two": published score/.test(e))).toBe(true);
  });

  it('fails a stale score_exact even when the rounded score agrees', () => {
    const data = board([stamped('one', 300, 12)]);
    data.leaderboard[0].score_exact += 0.01;
    expect(verifyPublished(data).errors.join('\n')).toMatch(/score_exact/);
  });

  it('fails a board that mixes model versions', () => {
    const data = board([stamped('one', 300, 12), stamped('two', 20, 3)]);
    data.leaderboard[1].model_version = '2.0.1';
    expect(verifyPublished(data).errors.join('\n')).toMatch(/2 model versions/);
  });

  it('fails a stamped board that is out of order, or misranked', () => {
    const data = board([stamped('one', 300, 12), stamped('two', 20, 3)]);
    data.leaderboard.reverse();
    const { errors } = verifyPublished(data);
    expect(errors.join('\n')).toMatch(/not in compareRows order/);
    expect(errors.join('\n')).toMatch(/rank is 2, expected 1/);
  });

  it('fails a developer listed twice', () => {
    const data = board([stamped('one', 300, 12), stamped('two', 20, 3)]);
    data.leaderboard.push({ ...data.leaderboard[1], username: 'TWO', rank: 3 });
    expect(verifyPublished(data).errors.join('\n')).toMatch(/more than once/);
  });

  it('fails a file with no leaderboard', () => {
    expect(verifyPublished({}).errors).toEqual(['payload has no "leaderboard" array']);
  });

  describe('during a model migration (allowMixedVersions)', () => {
    // One batch re-scored under the new major, 23 still on the old one: mixed
    // by construction until every batch has run. Refusing that would refuse
    // every run of the migration, and the board would never converge.
    function migrating() {
      const data = board([stamped('new', 300, 12), stamped('old', 20, 3)]);
      const old = data.leaderboard.find((r) => r.username === 'old');
      old.model_version = '1.4.0';
      old.score += 7; // scored by a formula this code does not have
      return data;
    }

    it('is refused without the option', () => {
      const errors = verifyPublished(migrating()).errors.join('\n');
      expect(errors).toMatch(/2 model versions/);
      expect(errors).toMatch(/"old"/);
    });

    it('accepts both versions and skips recomputing the other major', () => {
      const report = verifyPublished(migrating(), { allowMixedVersions: true });
      expect(report.errors).toEqual([]);
      expect(report.foreign).toBe(1);
      expect(report.recomputed).toBe(1);
    });

    it('still recomputes rows on this major, and still checks the order', () => {
      const data = migrating();
      data.leaderboard.find((r) => r.username === 'new').score += 1;
      data.leaderboard.reverse();
      const errors = verifyPublished(data, { allowMixedVersions: true }).errors.join('\n');
      expect(errors).toMatch(/"new": published score/);
      expect(errors).toMatch(/not in compareRows order/);
    });
  });
});

describe('the committed sample board', () => {
  // CI builds, smoke-tests and dry-runs against this file instead of live data.
  it('is a board the pipeline would publish', () => {
    const sample = JSON.parse(
      fs.readFileSync(new URL('../fixtures/data.sample.json', import.meta.url), 'utf8')
    );
    const report = verifyPublished(sample);
    expect(report.errors).toEqual([]);
    expect(report.total).toBe(50);
    // Some rows must be versioned, or CI recomputes nothing and checks no order.
    expect(report.recomputed).toBeGreaterThan(0);
    expect(report.orderAsserted).toBe(true);
    expect(sample.total_devs).toBe(50);
    expect(sample.leaderboard.some((row) => row.batch_index === 0)).toBe(true);
  });
});
