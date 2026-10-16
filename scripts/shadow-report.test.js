import { describe, it, expect } from 'vitest';
import {
  averageRanks,
  buildReport,
  inputsOf,
  spearman,
  summarize,
  topOverlap
} from './shadow-report.js';
import { CONTRIBUTIONS_FIELD } from './measure/contributions.js';
import {
  FLAG_ORG,
  FLAG_OWNED,
  KIND_BOT,
  KIND_ORG,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  SHAPE_VERSION,
  encodeMeasurement,
  measurementWindow
} from '../src/model/measurement.js';

const W = measurementWindow(Date.parse('2026-10-14T09:30:00Z'));
const kgryte = { login: 'kgryte', kind: KIND_USER, created: '2012-01-01' };
const young = { login: 'young', kind: KIND_USER, created: '2026-09-01' };

function measurement(login, overrides = {}) {
  return {
    version: SHAPE_VERSION,
    measured_at: '2026-10-14T09:30:00Z',
    login,
    github_id: 1,
    window: { from: W.from, to: W.to },
    restricted: 0,
    commits: [
      { repo: `${login}/app`, flags: FLAG_OWNED, stars: 0, days: [{ day: 1, commits: 2 }] }
    ],
    pull_requests: [],
    issues: [],
    reviews: [],
    accepted: [],
    maintained: [],
    future_repos: [],
    integrity: [],
    cut: 0,
    ...overrides
  };
}

const row = (username, m) => ({
  username,
  ...(m ? { [CONTRIBUTIONS_FIELD]: encodeMeasurement(m) } : {})
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
});

describe('inputsOf', () => {
  it('tells apart who accepted a merge', () => {
    const m = measurement('ana', {
      accepted: [
        {
          repo: 'acme/lib',
          flags: FLAG_ORG,
          stars: 10,
          owner: { login: 'acme', kind: KIND_ORG, created: '2020-01-01' },
          items: [
            { day: 1, number: 1, merger: kgryte, lines: 50, files: 3 },
            { day: 2, number: 2, merger: young, lines: 2, files: 1 },
            {
              day: 3,
              number: 3,
              merger: { login: 'ana', kind: KIND_USER, created: '2015-01-01' },
              lines: 9,
              files: 2
            },
            {
              day: 4,
              number: 4,
              merger: { login: 'mergify', kind: KIND_BOT, created: null },
              lines: 9,
              files: 2
            },
            { day: 5, number: 5, merger: null, lines: 9, files: 2 }
          ]
        }
      ],
      pull_requests: [
        {
          repo: 'acme/lib',
          flags: FLAG_ORG,
          items: [
            { day: 1, number: 1, outcome: OUTCOME_MERGED },
            { day: 6, number: 6, outcome: OUTCOME_CLOSED }
          ]
        }
      ],
      reviews: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          stars: 0,
          items: [
            { day: 1, number: 7, author: { login: 'ANA', kind: KIND_USER, created: null } },
            { day: 1, number: 8, author: { login: 'dependabot', kind: KIND_BOT, created: null } }
          ]
        }
      ]
    });
    expect(inputsOf(m)).toMatchObject({
      accepted: 5,
      accepted_by_user: 2,
      accepted_young_merger: 1,
      accepted_by_self: 1,
      accepted_by_bot: 1,
      accepted_by_nobody: 1,
      accepted_owners: 1,
      accepted_tiny: 1,
      others_merged: 1,
      others_closed: 1,
      reviews: 2,
      reviews_self: 1,
      reviews_bot: 1
    });
  });

  it('flags commit-date evidence: dates ahead of their commits, past the measurement, or a bot', () => {
    const m = measurement('z', {
      integrity: [
        { repo: 'z/paint', sampled: 20, bot: 0, max_lead_hours: 21.8, max_ahead_hours: 8 },
        { repo: 'z/cron', sampled: 20, bot: 20, max_lead_hours: 0, max_ahead_hours: -7 },
        { repo: 'z/fine', sampled: 20, bot: 1, max_lead_hours: 0, max_ahead_hours: -3 },
        { repo: 'z/none', sampled: 0, bot: 0, max_lead_hours: null, max_ahead_hours: null }
      ]
    });
    expect(inputsOf(m).flagged.map((s) => s.repo)).toEqual(['z/paint', 'z/cron']);
  });
});

describe('buildReport', () => {
  const payload = {
    last_updated: '2026-10-14T10:30:00Z',
    leaderboard: [
      row('ana', measurement('ana', { restricted: 5 })),
      row('zed', measurement('zed', { future_repos: ['zed/paint'], cut: 1 })),
      { username: 'legacy', [CONTRIBUTIONS_FIELD]: { v: 1, at: '2026-10-13T00:00:00Z' } },
      row('none', null)
    ]
  };
  const report = buildReport(payload, { source: 'test' });

  it('states what it covers', () => {
    expect(report).toContain(
      'Rows: 4. Measured in shape 2: 2 (50.0%). In the previous shape, waiting for their batch: 1. Undecodable: 0. Without a block: 1.'
    );
    expect(report).toContain("Block age at the board's last update, hours: p50 1.0");
  });

  it('labels cut lists instead of filling them in', () => {
    expect(report).toContain('| commit repository list | 1 of 2 |');
  });

  it('lists commit-date evidence by developer and repository', () => {
    expect(report).toContain('| zed | zed/paint | future-dated commits |');
  });

  it('says so when no row carries a measurement of this shape', () => {
    expect(buildReport({ leaderboard: [row('a', null)] })).toContain(
      'No row carries a measurement of this shape yet'
    );
  });
});
