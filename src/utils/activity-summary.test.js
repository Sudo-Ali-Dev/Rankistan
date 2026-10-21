import { describe, it, expect } from 'vitest';
import { activitySummary } from './activity-summary.js';
import { decodeMeasurement, encodeMeasurement, measurementWindow } from '../model/measurement.js';
import { deriveEvidence } from '../model/evidence.js';
import { SCORE_CONFIG } from '../model/config.js';
import {
  FLAG_FORK,
  FLAG_ORG,
  FLAG_OWNED,
  KIND_ORG,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED
} from '../model/measurement.js';

const MEASURED_AT = '2026-10-14T09:30:00Z';
const WINDOW = measurementWindow(Date.parse(MEASURED_AT));

/** A measurement with commits, pull requests and issues, encoded as the pipeline stores it. */
function measurement() {
  return {
    version: 3,
    measured_at: MEASURED_AT,
    login: 'ayesha',
    github_id: 1,
    window: { from: WINDOW.from, to: WINDOW.to },
    restricted: 0,
    commits: [
      // Their own repository: commits count.
      {
        repo: 'ayesha/app',
        flags: FLAG_OWNED,
        stars: 0,
        days: [
          { day: 28, commits: 3 },
          { day: 27, commits: 2 }
        ]
      },
      // A fork: commits do not count.
      {
        repo: 'ayesha/fork',
        flags: FLAG_FORK,
        stars: 0,
        days: [{ day: 26, commits: 9 }]
      }
    ],
    pull_requests: [
      // A repository they do not own: the pull request counts as opened.
      {
        repo: 'org1/lib',
        flags: FLAG_ORG,
        items: [
          { day: 29, number: 1, outcome: OUTCOME_MERGED },
          { day: 28, number: 2, outcome: OUTCOME_CLOSED }
        ]
      },
      // Their own repository: the pull request is not opened in someone else's project.
      {
        repo: 'ayesha/app',
        flags: FLAG_OWNED,
        items: [{ day: 27, number: 3, outcome: OUTCOME_MERGED }]
      }
    ],
    issues: [
      {
        repo: 'org1/lib',
        flags: FLAG_ORG,
        items: [
          { day: 28, number: 10 },
          { day: 27, number: 11 }
        ]
      }
    ],
    reviews: [],
    accepted: [],
    maintained: [],
    future_repos: [],
    integrity: [],
    cut: 0
  };
}

function summaryOf(m) {
  const decoded = decodeMeasurement(encodeMeasurement(m));
  const evidence = deriveEvidence(decoded, { config: SCORE_CONFIG, moderation: [] });
  return { decoded, evidence, activity: activitySummary(decoded, evidence) };
}

describe('activitySummary', () => {
  it('counts the commits in repositories that count, and no fork', () => {
    const { activity } = summaryOf(measurement());
    expect(activity.commits).toBe(5);
    expect(activity.commit_days).toBe(2);
    expect(activity.repositories).toBe(1);
  });

  it('counts the pull requests and issues opened in repositories they do not own', () => {
    const { activity } = summaryOf(measurement());
    expect(activity.pull_requests).toBe(2);
    expect(activity.issues).toBe(2);
  });

  it('takes the merged and closed pull requests from the evidence, so the two agree', () => {
    const { evidence, activity } = summaryOf(measurement());
    expect(activity.pull_requests_merged).toBe(evidence.pull_requests_to_others.merged);
    expect(activity.pull_requests_closed).toBe(evidence.pull_requests_to_others.closed);
    expect(activity.active_days).toBe(evidence.working_days.length);
  });

  it('counts nothing when there is no measurement', () => {
    const activity = activitySummary(null, null);
    expect(activity.commits).toBe(0);
    expect(activity.active_days).toBe(0);
  });
});
