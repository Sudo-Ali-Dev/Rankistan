/**
 * The score's evidence: from one measurement (src/model/measurement.js), everything that counts
 * toward the score and nothing that does not, each item a public thing on GitHub anyone can open.
 *
 * Every rule about *what counts* lives here; src/model/score.js only does arithmetic on the
 * result. That split is what makes a published score checkable: the evidence is published with
 * it (dev/<login>.json), and the score is a pure function of the evidence.
 *
 * What counts:
 *
 *   working days   a day with a commit to a repository that is not a fork, not a profile README
 *                  repository (anyone's) and not excluded; a pull request or issue opened in
 *                  someone else's repository (a pull request closed unmerged does not count);
 *                  a review of a pull request another user wrote.
 *   accepted       a pull request of theirs merged into a repository they do not own, merged by
 *                  a user who is not them and whose account was a year old at the time.
 *   reviews        reviews of pull requests by another user whose account was a year old, each
 *                  pull request once.
 *   maintained     pull requests by another user, a year old, merged into their own repository.
 *   appreciation   their own repositories with commits this month and at least FROM_STARS stars.
 *
 * Excluded repositories (their commits never count):
 *
 *   future         commits dated after the measurement (the future probe).
 *   impossible     an author date hours after its commit date, or a date after it was read.
 *   bot            half or more of the sampled commits committed by a bot in their name.
 *   moderation     listed in public/moderation.json with public evidence.
 *
 * Pure: no clock, no I/O. Dates come from the measurement; ages are counted to the date of the
 * item, so a score never changes because time passed.
 */
import {
  FLAG_FORK,
  FLAG_OWNED,
  FLAG_PROFILE,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  addDays
} from './measurement.js';
import { assertValidatedConfig, SCORE_CONFIG } from './config.js';
import { compareCodePoints } from './order.js';

export const EVIDENCE_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const lower = (s) => String(s).toLowerCase();
const ownerOf = (repo) => lower(repo.split('/')[0]);
const daysBetween = (fromDate, toDate) =>
  Math.floor((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);

export const REASON_FUTURE = 'commits dated in the future';
export const REASON_LEAD = 'author dates hours after their commit dates';
export const REASON_AHEAD = 'commits dated after the moment they were read';
export const REASON_BOT = "commits a bot made in the developer's name";

/** Orders items by date, repository, number: a fixed order, so sums are bit-for-bit repeatable. */
function byDateRepoNumber(a, b) {
  return (
    compareCodePoints(a.date, b.date) ||
    compareCodePoints(lower(a.repo), lower(b.repo)) ||
    (a.number ?? 0) - (b.number ?? 0)
  );
}

/**
 * The repositories whose commits do not count, with why. A moderation entry is listed only for a
 * developer who committed to that repository in the window: the list is every developer's, and
 * naming its other entries in someone's evidence would read as work of theirs that was removed.
 * @param {object[]} moderation  `{repo, reason}` entries from public/moderation.json
 */
export function exclusions(m, { config, moderation = [] }) {
  const { MAX_LEAD_HOURS, MAX_AHEAD_HOURS, BOT_SHARE } = config.INTEGRITY;
  const out = new Map();
  const add = (repo, reason) => {
    if (!out.has(lower(repo))) out.set(lower(repo), { repo, reason });
  };
  for (const repo of m.future_repos) add(repo, REASON_FUTURE);
  for (const s of m.integrity) {
    if (s.sampled === 0) continue;
    if (s.max_lead_hours !== null && s.max_lead_hours > MAX_LEAD_HOURS) add(s.repo, REASON_LEAD);
    else if (s.max_ahead_hours !== null && s.max_ahead_hours > MAX_AHEAD_HOURS)
      add(s.repo, REASON_AHEAD);
    else if (s.bot / s.sampled >= BOT_SHARE) add(s.repo, REASON_BOT);
  }
  const committed = new Set(m.commits.map((r) => lower(r.repo)));
  for (const entry of moderation) {
    if (committed.has(lower(entry.repo))) add(entry.repo, `moderation: ${entry.reason}`);
  }
  return out;
}

/**
 * The evidence for one decoded measurement.
 *
 * @param {object} m  decodeMeasurement's result
 * @param {{config?: object, moderation?: object[]}} [options]
 */
export function deriveEvidence(m, { config = SCORE_CONFIG, moderation = [] } = {}) {
  assertValidatedConfig(config);
  const me = lower(m.login);
  const date = (day) => addDays(m.window.from, day);
  const { COUNTERPARTY_MIN_AGE_DAYS } = config.COLLABORATION;
  const someoneElse = (p) => p !== null && p.kind === KIND_USER && lower(p.login) !== me;
  const yearOld = (p, onDate) =>
    typeof p.created === 'string' && daysBetween(p.created, onDate) >= COUNTERPARTY_MIN_AGE_DAYS;
  const theirs = (flags) => (flags & (FLAG_OWNED | FLAG_FORK | FLAG_PROFILE)) === 0;

  const excluded = exclusions(m, { config, moderation });

  const days = new Set();
  for (const r of m.commits) {
    if (r.flags & (FLAG_FORK | FLAG_PROFILE) || excluded.has(lower(r.repo))) continue;
    for (const d of r.days) days.add(d.day);
  }
  let merged = 0;
  let closed = 0;
  for (const r of m.pull_requests) {
    if (!theirs(r.flags)) continue;
    for (const i of r.items) {
      if (i.outcome === OUTCOME_MERGED) merged += 1;
      if (i.outcome === OUTCOME_CLOSED) closed += 1;
      else days.add(i.day);
    }
  }
  for (const r of m.issues) {
    if (!theirs(r.flags)) continue;
    for (const i of r.items) days.add(i.day);
  }

  // Reviews: one per pull request, at its latest review day.
  const reviewed = new Map();
  for (const r of m.reviews) {
    if (r.flags & FLAG_FORK) continue;
    for (const i of r.items) {
      if (!someoneElse(i.author)) continue;
      days.add(i.day);
      const key = `${lower(r.repo)}#${i.number}`;
      const previous = reviewed.get(key);
      // The latest review of a pull request stands for it. Its author is the same on every review
      // of one pull request; the login breaks a tie anyway, so input order never decides.
      if (
        !previous ||
        i.day > previous.i.day ||
        (i.day === previous.i.day &&
          compareCodePoints(lower(i.author.login), lower(previous.i.author.login)) < 0)
      ) {
        reviewed.set(key, { r, i });
      }
    }
  }
  const reviews = [...reviewed.values()]
    .filter(({ i }) => yearOld(i.author, date(i.day)))
    .map(({ r, i }) => ({
      repo: r.repo,
      owner: ownerOf(r.repo),
      number: i.number,
      date: date(i.day),
      stars: r.stars,
      author: i.author.login,
      author_since: i.author.created
    }))
    .sort(byDateRepoNumber);

  const accepted = [];
  for (const r of m.accepted) {
    if (!theirs(r.flags)) continue;
    for (const i of r.items) {
      if (!someoneElse(i.merger) || !yearOld(i.merger, date(i.day))) continue;
      accepted.push({
        repo: r.repo,
        owner: lower(r.owner?.login ?? ownerOf(r.repo)),
        number: i.number,
        date: date(i.day),
        stars: r.stars,
        lines: i.lines,
        files: i.files,
        merger: i.merger.login,
        merger_since: i.merger.created
      });
    }
  }
  accepted.sort(byDateRepoNumber);

  const maintained = [];
  for (const r of m.maintained) {
    if (!(r.flags & FLAG_OWNED) || r.flags & FLAG_FORK) continue;
    for (const i of r.items) {
      if (!someoneElse(i.author) || !yearOld(i.author, date(i.day))) continue;
      maintained.push({
        repo: r.repo,
        number: i.number,
        date: date(i.day),
        stars: r.stars,
        lines: i.lines,
        files: i.files,
        author: i.author.login,
        author_since: i.author.created
      });
    }
  }
  maintained.sort(byDateRepoNumber);

  const appreciation = m.commits
    .filter(
      (r) =>
        r.flags & FLAG_OWNED &&
        !(r.flags & (FLAG_FORK | FLAG_PROFILE)) &&
        !excluded.has(lower(r.repo)) &&
        r.stars >= config.APPRECIATION.FROM_STARS
    )
    .map((r) => ({ repo: r.repo, stars: r.stars, days: r.days.length }))
    .sort((a, b) => compareCodePoints(lower(a.repo), lower(b.repo)));

  return {
    evidence_version: EVIDENCE_VERSION,
    login: m.login,
    github_id: m.github_id,
    measured_at: m.measured_at,
    window: { from: m.window.from, to: m.window.to },
    working_days: [...days].sort((a, b) => a - b).map(date),
    excluded: [...excluded.values()].sort((a, b) =>
      compareCodePoints(lower(a.repo), lower(b.repo))
    ),
    accepted,
    pull_requests_to_others: { merged, closed },
    reviews,
    maintained,
    appreciation,
    private_contributions: m.restricted,
    cut: m.cut
  };
}
