import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreDevelopers } from './score.js';
import { stripInternalFields } from './write-leaderboard.js';
import { mergeBatchIntoLeaderboard } from './run-all.js';
import { verifyPublished } from './verify-published.js';
import { scoreFromPublished, recomputePublished } from '../src/model/score.js';
import { compareRows } from '../src/model/order.js';
import { SCORE_CONFIG, MODEL_VERSION } from '../src/model/config.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 9, 15, 30, 123);

const TYPES = ['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'ReleaseEvent', 'WatchEvent'];

// Shaped like fetch-devs.js output, internal fields included.
function developer(i) {
  const events = Array.from({ length: 30 + (i % 50) }, (_, k) => ({
    type: TYPES[(i + k) % TYPES.length],
    created_at: new Date(NOW - ((k * 37 + i) % 59) * DAY - k * 1000).toISOString(),
    repo: { name: `dev-${i}/r` }
  }));
  return {
    username: `Dev-${i}`,
    name: '',
    avatar_url: '',
    bio: '',
    location: 'Lahore, Pakistan',
    followers: (i * 13) % 700,
    following: 3,
    public_repos: (i * 7) % 260,
    total_stars: (i * 31) % 400,
    top_repos: [],
    top_languages: [],
    linkedin_url: '',
    created_at: new Date(NOW - ((i * 11) % 400) * DAY).toISOString(),
    events_30d: events.length,
    event_counts_30d: { pushes: 1, prs: 0, issues: 0, releases: 0 },
    total_contributions_60d: events.length,
    longest_gap_days: 2,
    repos_active_7d: [],
    digest_repos: [],
    raw_events_60d: events,
    tags: []
  };
}

// The pipeline path: score, strip to the published shape, through JSON.
function publishBatch(devs, batchIndex) {
  const scored = scoreDevelopers(devs, { now: NOW });
  const rows = scored.map((d) => ({ ...stripInternalFields(d), batch_index: batchIndex }));
  return JSON.parse(JSON.stringify(rows));
}

describe('scoreDevelopers', () => {
  it('publishes the fields a score is recomputed from, and drops the raw events', () => {
    const [row] = publishBatch([developer(1)], 0);
    expect(row.model_version).toBe(MODEL_VERSION);
    expect(row.scored_at).toBe(new Date(NOW).toISOString());
    expect(typeof row.score_exact).toBe('number');
    expect(typeof row.activity_score).toBe('number');
    expect(row.score).toBe(Math.round(row.score_exact));
    expect(row).not.toHaveProperty('raw_events_60d');
    expect(row).not.toHaveProperty('event_counts_30d');
    expect(row).not.toHaveProperty('age_penalty_applied');
  });

  it('round-trips: every published score recomputes from its own row', () => {
    const rows = publishBatch(
      Array.from({ length: 500 }, (_, i) => developer(i)),
      3
    );
    for (const row of rows) {
      expect(scoreFromPublished(row)).toBe(row.score);
      expect(recomputePublished(row, { config: SCORE_CONFIG }).score_exact).toBe(row.score_exact);
    }
  });

  it('ranks the batch in compareRows order', () => {
    const rows = publishBatch(
      Array.from({ length: 200 }, (_, i) => developer(i)),
      3
    );
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
    for (let i = 1; i < rows.length; i += 1) {
      expect(compareRows(rows[i - 1], rows[i])).toBeLessThan(0);
    }
  });

  it('refuses to score a developer without raw events instead of estimating', () => {
    const { raw_events_60d: _drop, ...dev } = developer(2);
    expect(() => scoreDevelopers([dev], { now: NOW })).toThrow(/raw_events_60d.*Dev-2/s);
  });
});

describe('the merged board', () => {
  let tmp;
  beforeEach(() => {
    tmp = path.join(
      os.tmpdir(),
      `rankistan-model-${process.pid}-${Math.random().toString(16).slice(2)}.json`
    );
  });
  afterEach(() => {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  it('verifies when fresh rows land on a board of legacy rows', () => {
    // A board as published before this change: rounded scores only.
    const legacy = Array.from({ length: 60 }, (_, i) => ({
      username: `legacy-${i}`,
      score: 400 + (i % 7),
      batch_index: 5,
      rank: i + 1
    }));
    fs.writeFileSync(
      tmp,
      JSON.stringify({ last_updated: 'x', total_devs: 60, leaderboard: legacy })
    );

    const fresh = publishBatch(
      Array.from({ length: 40 }, (_, i) => developer(i)),
      0
    );
    const output = mergeBatchIntoLeaderboard({
      batchIndex: 0,
      newEntries: fresh,
      evaluated: fresh.map((r) => r.username),
      targetPath: tmp
    });

    const report = verifyPublished(JSON.parse(fs.readFileSync(tmp, 'utf8')));
    expect(report.errors).toEqual([]);
    expect(report.stamped).toBe(40);
    expect(report.legacy).toBe(60);
    expect(report.recomputed).toBe(40);
    expect(report.orderAsserted).toBe(true);
    expect(output.leaderboard).toHaveLength(100);
  });
});
