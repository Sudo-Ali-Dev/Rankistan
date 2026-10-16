/**
 * Real measured rows for tests: a shape-2 measurement built from a few numbers, encoded as the
 * pipeline stores it, and scored by the model, so a test of the merge, the board check or the
 * state works on rows the pipeline could have published.
 */
import {
  FLAG_ORG,
  FLAG_OWNED,
  KIND_ORG,
  KIND_USER,
  SHAPE_VERSION,
  encodeMeasurement,
  measurementWindow
} from '../measurement.js';
import { scoreModel, publishedScoreFields } from '../score.js';

export const MEASURED_AT = '2026-10-14T09:30:00Z';
const WINDOW = measurementWindow(Date.parse(MEASURED_AT));

/**
 * A measurement with commits on the last `days` days of the window, and `merges` pull requests
 * merged into well-known projects by different people.
 */
export function measurement(
  login,
  { days = 10, merges = 0, stars = 0, githubId = 1, measuredAt = MEASURED_AT } = {}
) {
  const window = measuredAt === MEASURED_AT ? WINDOW : measurementWindow(Date.parse(measuredAt));
  const offsets = Array.from({ length: Math.min(30, days) }, (_, i) => 29 - i).sort(
    (a, b) => a - b
  );
  return {
    version: SHAPE_VERSION,
    measured_at: measuredAt,
    login,
    github_id: githubId,
    window: { from: window.from, to: window.to },
    restricted: 0,
    commits:
      days > 0
        ? [
            {
              repo: `${login}/app`,
              flags: FLAG_OWNED,
              stars,
              days: offsets.map((day) => ({ day, commits: 1 }))
            }
          ]
        : [],
    pull_requests: [],
    issues: [],
    reviews: [],
    accepted: Array.from({ length: merges }, (_, i) => ({
      repo: `org${i}/lib`,
      flags: FLAG_ORG,
      stars: 5000,
      owner: { login: `org${i}`, kind: KIND_ORG, created: '2016-01-01' },
      items: [
        {
          day: 29,
          number: 1,
          merger: { login: `maint${i}`, kind: KIND_USER, created: '2014-01-01' },
          lines: 40,
          files: 3
        }
      ]
    })),
    maintained: [],
    future_repos: [],
    integrity: [],
    cut: 0
  };
}

/** A board row: the measurement stored, and the fields the pipeline publishes from it. */
export function measuredRow(username, options = {}, extra = {}) {
  const block = encodeMeasurement(measurement(username, options));
  const result = scoreModel(block);
  return {
    username,
    github_id: options.githubId ?? 1,
    contributions: block,
    ...publishedScoreFields(result),
    ...extra
  };
}
