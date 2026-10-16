import { describe, expect, it } from 'vitest';
import { cadence, formatSuspects, moderationSuspects } from './moderation-suspects.js';
import {
  encodeMeasurement,
  FLAG_OWNED,
  measurementWindow,
  SHAPE_VERSION
} from '../src/model/measurement.js';

const W = measurementWindow(Date.parse('2026-10-14T09:30:00Z'));
const row = (login, commits, integrity = []) => ({
  username: login,
  contributions: encodeMeasurement({
    version: SHAPE_VERSION,
    measured_at: '2026-10-14T09:30:00Z',
    login,
    github_id: 1,
    window: { from: W.from, to: W.to },
    restricted: 0,
    commits,
    pull_requests: [],
    issues: [],
    reviews: [],
    accepted: [],
    maintained: [],
    future_repos: [],
    integrity,
    cut: 0
  })
});
const days = (n, perDay) =>
  Array.from({ length: n }, (_, i) => ({ day: 29 - i, commits: perDay(i) }));

describe('moderation suspects', () => {
  it('lists a repository with commits on many days at a near-constant rate', () => {
    const cron = row('cron', [
      { repo: 'cron/app', flags: FLAG_OWNED, stars: 0, days: days(25, () => 15) }
    ]);
    const person = row('ana', [
      { repo: 'ana/app', flags: FLAG_OWNED, stars: 0, days: days(25, (i) => 1 + ((i * 7) % 11)) }
    ]);
    const found = moderationSuspects([cron, person]);
    expect(found.map((s) => s.repo)).toEqual(['cron/app']);
    expect(cadence([{ commits: 5 }, { commits: 5 }])).toBe(0);
  });

  it('lists a repository whose history holds few of the days GitHub credits', () => {
    const r = row(
      'ana',
      [{ repo: 'ana/app', flags: FLAG_OWNED, stars: 0, days: days(12, (i) => 1 + (i % 4) * 3) }],
      [{ repo: 'ana/app', sampled: 4, bot: 0, max_lead_hours: 0, max_ahead_hours: -5, days: 4 }]
    );
    expect(moderationSuspects([r])).toMatchObject([{ login: 'ana', repo: 'ana/app' }]);
  });

  it('says so when there is nothing to read', () => {
    expect(formatSuspects([], { batchIndex: 3 }).log).toBe('Moderation suspects in batch 3: none.');
  });
});
