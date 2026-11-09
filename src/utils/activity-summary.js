/**
 * What a developer did in the window, in counts: the activity behind the score.
 *
 * The measurement itself is the pipeline's own (src/model/measurement.js) and never leaves it.
 * scripts/build-split-data.js publishes this summary in the developer's own file instead, so a
 * profile page can show what happened without publishing a day-by-day trace of someone's work.
 *
 * The counts follow the same rules as the evidence (src/model/evidence.js), so the two agree:
 * a fork, a profile README repository and a repository under moderation are not work, and a pull
 * request or an issue counts only when it was opened in a repository the developer does not own.
 *
 * The figures the evidence already carries - the merged and closed pull requests, the reviews,
 * the accepted work - are read from the evidence rather than counted again, so this can never
 * disagree with the score. Only what the evidence does not hold - the commits, the pull requests
 * opened, the issues opened - is counted here.
 *
 * Pure: no clock, no I/O. Releases are not measured at all, so they are not counted here either.
 */
import { FLAG_FORK, FLAG_OWNED, FLAG_PROFILE } from '../model/measurement.js';

const lower = (s) => String(s).toLowerCase();

/** A repository the developer does not own: their flags are clear of owned, fork and profile. */
const theirs = (flags) => (flags & (FLAG_OWNED | FLAG_FORK | FLAG_PROFILE)) === 0;

/**
 * The activity summary of one measurement.
 *
 * @param {object} measurement  a decoded measurement (src/model/measurement.js)
 * @param {object} evidence     the evidence derived from that same measurement
 * @returns {object} counts, all of them numbers
 */
export function activitySummary(measurement, evidence) {
  const excluded = new Set(
    (Array.isArray(evidence?.excluded) ? evidence.excluded : []).map((entry) => lower(entry?.repo))
  );

  let commits = 0;
  let repositories = 0;
  const days = new Set();
  for (const repo of measurement?.commits || []) {
    if (repo.flags & (FLAG_FORK | FLAG_PROFILE)) continue;
    if (excluded.has(lower(repo.repo))) continue;
    repositories += 1;
    for (const day of repo.days || []) {
      commits += Number(day.commits) || 0;
      days.add(day.day);
    }
  }
  const commitDays = days.size;

  let pullRequests = 0;
  for (const repo of measurement?.pull_requests || []) {
    if (!theirs(repo.flags)) continue;
    pullRequests += (repo.items || []).length;
  }

  let issues = 0;
  for (const repo of measurement?.issues || []) {
    if (!theirs(repo.flags)) continue;
    issues += (repo.items || []).length;
  }

  // From the evidence, so these are the numbers the score was computed from.
  const accepted = Array.isArray(evidence?.accepted) ? evidence.accepted.length : 0;
  const reviews = Array.isArray(evidence?.reviews) ? evidence.reviews.length : 0;
  const maintained = Array.isArray(evidence?.maintained) ? evidence.maintained.length : 0;
  const merged = Number(evidence?.pull_requests_to_others?.merged) || 0;
  const closed = Number(evidence?.pull_requests_to_others?.closed) || 0;
  const activeDays = Array.isArray(evidence?.working_days) ? evidence.working_days.length : 0;

  return {
    commits,
    commit_days: commitDays,
    repositories,
    active_days: activeDays,
    pull_requests: pullRequests,
    pull_requests_merged: merged,
    pull_requests_closed: closed,
    issues,
    reviews,
    accepted,
    maintained
  };
}

/** The activity summary in the order the page shows it. */
export const ACTIVITY_ROWS = Object.freeze([
  { key: 'commits', label: 'Commits', hint: 'in the last 30 days, in repositories that count' },
  { key: 'active_days', label: 'Active days', hint: 'days with any counted activity' },
  { key: 'pull_requests', label: 'Pull requests', hint: 'opened in repositories they do not own' },
  {
    key: 'pull_requests_merged',
    label: 'Merged',
    hint: 'of those, merged in repositories they do not own'
  },
  { key: 'issues', label: 'Issues', hint: 'opened in repositories they do not own' },
  { key: 'reviews', label: 'Reviews', hint: 'of other developers’ pull requests' }
]);
