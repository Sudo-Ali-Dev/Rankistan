import { describe, it, expect } from 'vitest';
import {
  averageRanks,
  buildReport,
  candidateMeasures,
  longestCalendarGap,
  spearman,
  summarize,
  topOverlap
} from './shadow-report.js';
import { FLAG_OWNED, SHAPE_VERSION, SHADOW_FIELD } from './measure/contributions.js';

/** A stored block: `repos` as [name, flags, stars, {day: commits}]. */
function block({ repos = [], calendar = new Array(60).fill(1), restricted = 0, cut = false } = {}) {
  const commits = repos.reduce(
    (s, [, , , days]) => s + Object.values(days).reduce((a, b) => a + b, 0),
    0
  );
  return {
    v: SHAPE_VERSION,
    at: '2026-10-14T00:30:00Z',
    w60: ['2026-08-15', '2026-10-14'],
    w30: ['2026-09-14', '2026-10-14'],
    cal60: calendar,
    t30: [commits + (cut ? 50 : 0), 0, 0, 0, restricted, repos.length + (cut ? 1 : 0), 0],
    cr30: repos.map(([name, flags, stars, days]) => [
      name,
      flags,
      stars,
      Object.entries(days).flatMap(([d, n]) => [Number(d), n])
    ]),
    pr30: [],
    gap30: null
  };
}

const row = (username, rank, activity, shadow, extra = {}) => ({
  username,
  rank,
  batch_index: rank % 2,
  activity_score: activity,
  events_30d: activity,
  ...(shadow ? { [SHADOW_FIELD]: shadow } : {}),
  ...extra
});

describe('statistics', () => {
  it('ranks ties at their average', () => {
    expect(averageRanks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
  });

  it('computes Spearman with ties, and nothing for a constant or tiny series', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it('takes nearest-rank quantiles and ignores what is not a number', () => {
    expect(summarize([5, 1, null, 3, 2, 4])).toEqual({ n: 5, p50: 3, p90: 5, p99: 5, max: 5 });
    expect(summarize([]).p50).toBeNull();
  });

  it('counts the overlap of two top-k sets', () => {
    expect(topOverlap([9, 8, 1, 0], [9, 1, 8, 0], 2)).toBe(1);
  });

  it('finds the longest run of empty calendar days', () => {
    expect(longestCalendarGap([1, 0, 0, 2, 0, 0, 0])).toBe(3);
  });
});

describe('candidateMeasures', () => {
  it('caps each repository-day, and discounts owned zero-star repositories', () => {
    const m = {
      calendar_60d: [...new Array(30).fill(0), 3, 0, ...new Array(28).fill(1)],
      commit_repositories_30d: [
        {
          name: 'me/farm',
          flags: FLAG_OWNED,
          stars: 0,
          commits: 1000,
          days: [{ day: 0, commits: 1000 }]
        },
        {
          name: 'org/lib',
          flags: 0,
          stars: 0,
          commits: 6,
          days: [
            { day: 0, commits: 3 },
            { day: 2, commits: 3 }
          ]
        }
      ]
    };
    const c = candidateMeasures(m, { discount: 0.5 });
    expect(c).toMatchObject({
      calendar_days: 29,
      commit_days: 2,
      commits: 1006,
      cap5: 11,
      cap5_z: 8.5,
      cap10: 16,
      cap10_z: 11
    });
  });
});

describe('buildReport', () => {
  const owned = (login, stars, days) => [`${login}/app`, FLAG_OWNED, stars, days];
  const payload = {
    last_updated: '2026-10-14T01:00:00Z',
    leaderboard: [
      row('farm', 1, 300, block({ repos: [owned('farm', 0, { 0: 100000 })] })),
      row(
        'steady',
        2,
        200,
        block({ repos: [owned('steady', 4, { 0: 2, 1: 2, 2: 2 })], restricted: 9 })
      ),
      row('cut', 3, 100, block({ repos: [owned('cut', 1, { 3: 1 })], cut: true })),
      row('quiet', 4, 50, block({ repos: [['org/x', 0, 10, { 5: 1 }]] })),
      row('old', 5, 10, null),
      row('legacy', 6, undefined, block({ repos: [owned('legacy', 0, { 1: 3 })] }))
    ]
  };
  const report = buildReport(payload, { source: 'test' });

  it('states its sample sizes', () => {
    expect(report).toContain('5 rows carry a decodable block');
    expect(report).toContain('Rows with a block: 5 of 6 (83.3%)');
    // Compared with activity_score only where a row carries one.
    expect(report).toContain('over the 4 rows that carry both');
    expect(report).toContain('Rows sharing private counts (restricted > 0): 1 of 5');
  });

  it('never counts a row without a pull request median as a fast one', () => {
    expect(report).toContain('median under 61 s: 0; under 300 s: 0 (of 0 with a median)');
  });

  it('prints no rank correlation over too few rows', () => {
    expect(report).toContain('Only 4 rows carry both, under the 10 this report compares on');
    expect(report).toMatch(/\| cap10 \| - \| - \| /);
  });

  it('labels a cut repository list instead of filling it in', () => {
    expect(report).toContain(
      'Commit repository list cut by GitHub: 1 of 5 rows, 50 commits unlisted'
    );
    expect(report).toMatch(/\| cut \| 3 \| 51 \(1 listed\) \|/);
  });

  it('caps the farm and says where it lands', () => {
    expect(report).toMatch(/\| farm \| 1 \| 100000 \| 100000 \| 1\.00 \|/);
    expect(report).toContain(
      'Rows whose every listed commit is in an owned zero-star repository: 2 of 5'
    );
  });

  it('says so when no row carries a block', () => {
    expect(buildReport({ leaderboard: [row('a', 1, 1, null)] })).toContain(
      'No row carries a block yet'
    );
  });
});
