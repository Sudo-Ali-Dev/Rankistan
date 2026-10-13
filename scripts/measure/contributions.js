/**
 * Shadow measurement: the inputs of the next activity model, recorded on every row and scored
 * by nothing.
 *
 * Today's activity term reads the public events feed, which GitHub caps by count: at most 300
 * events, of which the pipeline reads 200. The busier a developer, the less time that covers -
 * one top-30 developer's "30-day" window held 6 days. `contributionsCollection` is keyed on a
 * date range instead, so it sees every day however busy the account is. It is also easy to farm
 * if read naively: one account made 1,031,007 commits in 30 days to a zero-star repository of its
 * own, another opened 1,080 self-merged pull requests. The next model therefore needs limits per
 * repository and per day, and the right limits can only be read off the real distributions. This
 * module records the raw inputs every candidate rule needs, per row and dated, so the caps can be
 * chosen from data and the board can switch models in one run with every row already measured.
 *
 * Nothing here affects a score. The block is attached after scoring (scripts/run-all.js), the
 * model reads only MODEL_INPUT_FIELDS (src/model/score.js), and the block stays out of the files
 * the browser reads (src/utils/split-data.js).
 *
 * ## What is read, in one request per batch of developers
 *
 *   gap   contributionsCollection over 60 days: the calendar only. A 30-day calendar cannot hold
 *         a gap longer than 30 days, so a 30-day gap rule needs a 60-day calendar.
 *   w30   contributionsCollection over the last 30 of those days: the totals, and per repository
 *         the commits per day and the pull requests opened. Every per-repository figure comes
 *         from this one collection, the one its totals come from, so no figure sits beside a
 *         total measured over another window.
 *
 * ## Windows
 *
 * Both windows end at the most recent UTC midnight and are half-open, `[from, to)`, so every day
 * in them is complete and two batches measured on the same UTC day measure the same days. The API
 * is asked for `from`T00:00:00Z to the last second of the day before `to`: measured on 2026-10-13,
 * a `to` of exactly midnight adds that day to the calendar (61 days, not 60).
 *
 * Days are GitHub's, not UTC's. Measured on 2026-10-13, the calendar dates a pull request, issue
 * or review by the developer's own time zone, not the token's: Pakistani accounts fit UTC+5 with
 * 1 mismatch in 747 day cells, and an account outside Pakistan fit UTC+7 and no other offset. A
 * commit contribution's `occurredAt` is its date at midnight US Pacific (always `T07:00:00Z` in
 * October). So `cal60` and the per-day commits below share the developer's day boundaries, and a
 * per-day cap applied to them caps the developer's day. Pull request timestamps are exact
 * instants, and are used only for the gaps between them.
 *
 * The calendar counts restricted (private) contributions for anyone who chose to share them, so a
 * day can be active in `cal60` on private work alone. Measured on 50 board developers: a day's
 * commits never exceeded its calendar count (0 of 735 days), and the calendar's last 30 days never
 * fell below the w30 totals plus `restricted`; the remainder is repositories created.
 *
 * ## The stored block (SHAPE_VERSION 1)
 *
 * Compact, because data.json carries it for 1,000 rows. `decodeShadow` returns the readable form.
 *
 *   v        SHAPE_VERSION
 *   at       measured_at, ISO 8601 to the second
 *   w60      [from, to) of the gap window, UTC dates
 *   w30      [from, to) of the scoring window, UTC dates
 *   cal60    the calendar's count for each day of w60, oldest first (60 integers)
 *   t30      w30 totals, in TOTALS_30D order: commits, pull requests, issues, reviews, restricted,
 *            repositories with commits, repositories with pull requests
 *   cr30     commits per repository: [nameWithOwner, flags, stars, [day, commits, ...]], `day` the
 *            offset into w30 (0-29); the repositories GitHub returns, most commits first, at most
 *            MAX_REPOSITORIES. Fewer entries than t30's repository count means the list was cut.
 *   pr30     pull requests opened, per repository: [nameWithOwner, flags, opened, read, merged,
 *            merged_by_other]. `read` is how many were read (at most NODES_PER_REPOSITORY, the
 *            newest); merged and merged_by_other count those, as they stood at `at` - pull request
 *            fields are live, so this is the only time they can be read.
 *   gap30    [median seconds between consecutive pull request creations, pull requests it was
 *            computed from], or null under MIN_PRS_FOR_GAP. Context, never scored: a timing rule
 *            is evaded with `sleep 61`, and a 60-second rule missed a known farm whose median was
 *            182 s.
 *
 * `flags` is a bit field: FLAG_OWNED (the developer owns the repository) and FLAG_FORK.
 *
 * ## Failure
 *
 * Fail-soft for the run, strict per developer. A developer is either measured whole, from one
 * response, or not at all; a developer this run could not measure keeps the previous block, with
 * its own `at` (attachShadow). Within a request:
 *
 *   - 200 carrying `errors[]` is discarded whole and the batch split. The one exception is
 *     NOT_FOUND whose path is exactly one user's alias: that user does not exist, and nothing else
 *     in the response is in doubt. RESOURCE_LIMITS_EXCEEDED depends on content - one developer
 *     with 355 repositories trips it - which is why the batch is bisected, not fixed small.
 *   - 200 with an alias null and no error for it is an over-large query, not an absent user:
 *     discarded and split.
 *   - a 502, timeout or non-JSON body (read as text first: a 502 is HTML) is split, and a single
 *     developer retried; it is always retried, never taken as an answer.
 *   - secondary and primary rate limits are waited out by the client at the same size and never
 *     split (scripts/discovery/graphql.js). A wait longer than MAX_WAIT_MS stops the measurement
 *     instead: this is context, and must not hold the pipeline for an hourly reset.
 */
import { createSearchClient, describeErrors } from '../discovery/graphql.js';

export const SHADOW_FIELD = 'shadow_contributions';
export const SHAPE_VERSION = 1;

export const GAP_WINDOW_DAYS = 60;
export const SCORING_WINDOW_DAYS = 30;

/**
 * Developers per request. Measured for this document on 2026-10-13: 15 mid- and low-board
 * developers took 7-11 s and cost 1 point; 15 from the top of the board were rejected once with
 * RESOURCE_LIMITS_EXCEEDED, where 8 of them took 5 s. Bisection covers the difference.
 */
export const BATCH_SIZE = 15;

/**
 * Repositories read per developer, most commits first. Measured on 50 board developers on
 * 2026-10-13: a cap of 25 would have cut 2 of them, unlisting 51 repositories and 61 of 5,050
 * commits (1.2%) to save 8% of the block's bytes. The tail is where a farm spreading commits
 * across repositories would sit, and a per-repository cap cannot be applied to commits that are
 * not listed, so the cap is the API's own maximum.
 */
export const MAX_REPOSITORIES = 100;

/** Nodes read per repository connection. 30 days hold at most 30 commit days. */
export const NODES_PER_REPOSITORY = 100;

export const MIN_PRS_FOR_GAP = 5;

/** Retries of a single developer after a rejected response, before they count as failed. */
export const MAX_SINGLE_RETRIES = 2;
const RETRY_BASE_MS = 5000;

/** The longest wait the measurement accepts before it stops instead. */
export const MAX_WAIT_MS = 3 * 60 * 1000;

export const FLAG_OWNED = 1;
export const FLAG_FORK = 2;

export const TOTALS_30D = Object.freeze([
  'commits',
  'pull_requests',
  'issues',
  'reviews',
  'restricted',
  'commit_repositories',
  'pull_request_repositories'
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_DAY_MS = DAY_MS / 2;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isCount = (value) => Number.isInteger(value) && value >= 0;

/** Raised to stop measuring when a rate-limit wait would be longer than MAX_WAIT_MS. */
export class WaitTooLongError extends Error {
  constructor(ms) {
    super(`a rate-limit wait of ${Math.ceil(ms / 1000)}s is longer than this measurement waits`);
    this.name = 'WaitTooLongError';
  }
}

/**
 * The two windows for a measurement taken at `now`. Both end at the UTC midnight that began
 * `now`'s day, which they exclude.
 */
export function measurementWindows(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('measurementWindows needs `now` (a Date or epoch milliseconds)');
  }
  const end = Math.floor(ms / DAY_MS) * DAY_MS;
  const gapFrom = end - GAP_WINDOW_DAYS * DAY_MS;
  const scoringFrom = end - SCORING_WINDOW_DAYS * DAY_MS;
  const lastSecond = isoSecond(end - 1000);
  return {
    gap: { from: isoDate(gapFrom), to: isoDate(end) },
    scoring: { from: isoDate(scoringFrom), to: isoDate(end) },
    variables: {
      gapFrom: `${isoDate(gapFrom)}T00:00:00Z`,
      from: `${isoDate(scoringFrom)}T00:00:00Z`,
      to: lastSecond
    }
  };
}

function shadowFragment(maxRepositories) {
  return `fragment Shadow on User {
  login
  databaseId
  gap: contributionsCollection(from: $gapFrom, to: $to) {
    contributionCalendar { weeks { contributionDays { date contributionCount } } }
  }
  w30: contributionsCollection(from: $from, to: $to) {
    totalCommitContributions
    totalPullRequestContributions
    totalIssueContributions
    totalPullRequestReviewContributions
    restrictedContributionsCount
    totalRepositoriesWithContributedCommits
    totalRepositoriesWithContributedPullRequests
    commitContributionsByRepository(maxRepositories: ${maxRepositories}) {
      repository { nameWithOwner owner { login } isFork stargazerCount }
      contributions(first: ${NODES_PER_REPOSITORY}) { totalCount nodes { occurredAt commitCount } }
    }
    pullRequestContributionsByRepository(maxRepositories: ${maxRepositories}) {
      repository { nameWithOwner owner { login } isFork }
      contributions(first: ${NODES_PER_REPOSITORY}) {
        totalCount
        nodes { pullRequest { createdAt merged mergedBy { login } } }
      }
    }
  }
}`;
}

/** One request's document for `count` developers, aliased u0..u{count-1}. */
export function buildQuery(count, { maxRepositories = MAX_REPOSITORIES } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('buildQuery needs count >= 1');
  const params = ['$gapFrom: DateTime!', '$from: DateTime!', '$to: DateTime!'];
  const aliases = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`$l${i}: String!`);
    aliases.push(`u${i}: user(login: $l${i}) { ...Shadow }`);
  }
  return (
    `query(${params.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ` +
    `${aliases.join('\n  ')}\n}\n${shadowFragment(maxRepositories)}`
  );
}

export function buildVariables(slice, windows) {
  const variables = { ...windows.variables };
  slice.forEach((target, i) => {
    variables[`l${i}`] = target.login;
  });
  return variables;
}

class Malformed extends Error {}

function requireCount(value, what) {
  if (!isCount(value)) throw new Malformed(`${what} is ${JSON.stringify(value)}, not a count`);
  return value;
}

/** The calendar as one count per day of `window`, oldest first. Any other set of days rejects. */
export function calendarSeries(calendar, window) {
  const days = (calendar?.weeks || []).flatMap((week) => week?.contributionDays || []);
  const byDate = new Map();
  for (const day of days) {
    const date = day?.date;
    if (typeof date !== 'string' || byDate.has(date)) {
      throw new Malformed(`calendar day ${JSON.stringify(date)} is missing or repeated`);
    }
    byDate.set(date, requireCount(day.contributionCount, `calendar count for ${date}`));
  }
  const start = Date.parse(`${window.from}T00:00:00Z`);
  const length = Math.round((Date.parse(`${window.to}T00:00:00Z`) - start) / DAY_MS);
  const series = [];
  for (let i = 0; i < length; i += 1) {
    const date = isoDate(start + i * DAY_MS);
    if (!byDate.has(date)) throw new Malformed(`calendar has no ${date}`);
    series.push(byDate.get(date));
  }
  if (byDate.size !== length) {
    throw new Malformed(`calendar holds ${byDate.size} days, the window ${length}`);
  }
  return series;
}

/**
 * The day a commit contribution belongs to, as an offset into `window`. `occurredAt` is that
 * date at a local midnight (US Pacific, measured); half a day later is the same date for any
 * offset within twelve hours of UTC.
 */
export function commitDayOffset(occurredAt, window) {
  const ms = Date.parse(occurredAt);
  if (!Number.isFinite(ms)) throw new Malformed(`occurredAt ${JSON.stringify(occurredAt)}`);
  const date = isoDate(ms + HALF_DAY_MS);
  const offset = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / DAY_MS
  );
  const length = Math.round(
    (Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / DAY_MS
  );
  if (offset < 0 || offset >= length) {
    throw new Malformed(`a commit day ${date} outside ${window.from}..${window.to}`);
  }
  return offset;
}

function repositoryOf(entry, login) {
  const repository = entry?.repository;
  const name = repository?.nameWithOwner;
  if (typeof name !== 'string' || !name.includes('/')) {
    throw new Malformed(`repository name ${JSON.stringify(name)}`);
  }
  const owner = repository.owner?.login;
  if (typeof owner !== 'string') throw new Malformed(`${name} has no owner`);
  const flags =
    (owner.toLowerCase() === login.toLowerCase() ? FLAG_OWNED : 0) |
    (repository.isFork === true ? FLAG_FORK : 0);
  return { name, flags, repository };
}

/** Median of the gaps between consecutive instants, in whole seconds. */
export function medianGapSeconds(instants) {
  if (instants.length < 2) return null;
  const sorted = [...instants].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) gaps.push((sorted[i] - sorted[i - 1]) / 1000);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round(median);
}

/**
 * One developer's measurement, in readable form, from their alias in a response. Throws
 * Malformed for anything not in the expected shape: a response that does not look as measured is
 * not trusted for anyone in it.
 */
export function readMeasurement(node, { target, windows, measuredAt }) {
  if (!node || typeof node !== 'object') throw new Malformed('no user');
  const login = node.login;
  if (typeof login !== 'string' || login.toLowerCase() !== target.login.toLowerCase()) {
    throw new Malformed(`login ${JSON.stringify(login)} for ${target.login}`);
  }
  // A login can be released and claimed by another account between the REST fetch and now.
  if (target.githubId != null && node.databaseId !== target.githubId) {
    throw new Malformed(`${login} is account ${node.databaseId}, the row is ${target.githubId}`);
  }

  const calendar = calendarSeries(node.gap?.contributionCalendar, windows.gap);
  const w30 = node.w30;
  if (!w30 || typeof w30 !== 'object') throw new Malformed('no 30-day collection');
  const totals = {
    commits: requireCount(w30.totalCommitContributions, 'commits'),
    pull_requests: requireCount(w30.totalPullRequestContributions, 'pull requests'),
    issues: requireCount(w30.totalIssueContributions, 'issues'),
    reviews: requireCount(w30.totalPullRequestReviewContributions, 'reviews'),
    restricted: requireCount(w30.restrictedContributionsCount, 'restricted'),
    commit_repositories: requireCount(
      w30.totalRepositoriesWithContributedCommits,
      'repositories with commits'
    ),
    pull_request_repositories: requireCount(
      w30.totalRepositoriesWithContributedPullRequests,
      'repositories with pull requests'
    )
  };

  if (!Array.isArray(w30.commitContributionsByRepository)) {
    throw new Malformed('no commit repositories');
  }
  const commitRepositories = [];
  for (const entry of w30.commitContributionsByRepository) {
    const { name, flags, repository } = repositoryOf(entry, login);
    const stars = requireCount(repository.stargazerCount, `${name} stars`);
    const total = requireCount(entry.contributions?.totalCount, `${name} commits`);
    const nodes = entry.contributions?.nodes;
    if (!Array.isArray(nodes)) throw new Malformed(`${name} has no commit days`);
    const perDay = new Map();
    let sum = 0;
    for (const day of nodes) {
      const offset = commitDayOffset(day?.occurredAt, windows.scoring);
      const commits = requireCount(day.commitCount, `${name} commits on a day`);
      perDay.set(offset, (perDay.get(offset) || 0) + commits);
      sum += commits;
    }
    // Every day of the window fits in one page, so the days account for every commit.
    if (sum !== total) throw new Malformed(`${name}: ${sum} commits by day, ${total} in total`);
    if (total === 0) continue;
    const days = [...perDay]
      .sort((a, b) => a[0] - b[0])
      .map(([day, commits]) => ({ day, commits }));
    commitRepositories.push({ name, flags, stars, commits: total, days });
  }

  if (!Array.isArray(w30.pullRequestContributionsByRepository)) {
    throw new Malformed('no pull request repositories');
  }
  const pullRequestRepositories = [];
  const created = [];
  for (const entry of w30.pullRequestContributionsByRepository) {
    const { name, flags } = repositoryOf(entry, login);
    const opened = requireCount(entry.contributions?.totalCount, `${name} pull requests`);
    const nodes = entry.contributions?.nodes;
    if (!Array.isArray(nodes)) throw new Malformed(`${name} has no pull requests`);
    let merged = 0;
    let mergedByOther = 0;
    for (const item of nodes) {
      const pr = item?.pullRequest;
      const at = Date.parse(pr?.createdAt);
      if (!Number.isFinite(at)) throw new Malformed(`${name}: a pull request with no createdAt`);
      created.push(at);
      if (pr.merged === true) {
        merged += 1;
        const by = pr.mergedBy?.login;
        // Merged by an account that no longer exists is not shown to be someone else.
        if (typeof by === 'string' && by.toLowerCase() !== login.toLowerCase()) mergedByOther += 1;
      }
    }
    if (nodes.length > opened) throw new Malformed(`${name}: ${nodes.length} read of ${opened}`);
    pullRequestRepositories.push({
      name,
      flags,
      opened,
      read: nodes.length,
      merged,
      merged_by_other: mergedByOther
    });
  }

  const gap =
    created.length >= MIN_PRS_FOR_GAP
      ? { median_seconds: medianGapSeconds(created), from_pull_requests: created.length }
      : null;

  return {
    version: SHAPE_VERSION,
    measured_at: measuredAt,
    gap_window: { ...windows.gap },
    scoring_window: { ...windows.scoring },
    calendar_60d: calendar,
    totals_30d: totals,
    commit_repositories_30d: commitRepositories,
    pull_request_repositories_30d: pullRequestRepositories,
    pull_request_gap_30d: gap
  };
}

/** The stored, compact form of a measurement. */
export function encodeShadow(m) {
  return {
    v: m.version,
    at: m.measured_at,
    w60: [m.gap_window.from, m.gap_window.to],
    w30: [m.scoring_window.from, m.scoring_window.to],
    cal60: [...m.calendar_60d],
    t30: TOTALS_30D.map((key) => m.totals_30d[key]),
    cr30: m.commit_repositories_30d.map((r) => [
      r.name,
      r.flags,
      r.stars,
      r.days.flatMap(({ day, commits }) => [day, commits])
    ]),
    pr30: m.pull_request_repositories_30d.map((r) => [
      r.name,
      r.flags,
      r.opened,
      r.read,
      r.merged,
      r.merged_by_other
    ]),
    gap30: m.pull_request_gap_30d
      ? [m.pull_request_gap_30d.median_seconds, m.pull_request_gap_30d.from_pull_requests]
      : null
  };
}

/**
 * The readable form of a stored block, or null for anything that is not a block of this shape.
 * Derived per repository: `commits` and `owned`/`fork`.
 */
export function decodeShadow(block) {
  if (!block || typeof block !== 'object' || block.v !== SHAPE_VERSION) return null;
  try {
    const pairs = (days) => {
      const out = [];
      for (let i = 0; i < days.length; i += 2) out.push({ day: days[i], commits: days[i + 1] });
      return out;
    };
    return {
      version: block.v,
      measured_at: block.at,
      gap_window: { from: block.w60[0], to: block.w60[1] },
      scoring_window: { from: block.w30[0], to: block.w30[1] },
      calendar_60d: [...block.cal60],
      totals_30d: Object.fromEntries(TOTALS_30D.map((key, i) => [key, block.t30[i]])),
      commit_repositories_30d: block.cr30.map(([name, flags, stars, days]) => {
        const byDay = pairs(days);
        return {
          name,
          flags,
          stars,
          commits: byDay.reduce((sum, d) => sum + d.commits, 0),
          days: byDay
        };
      }),
      pull_request_repositories_30d: block.pr30.map(
        ([name, flags, opened, read, merged, mergedByOther]) => ({
          name,
          flags,
          opened,
          read,
          merged,
          merged_by_other: mergedByOther
        })
      ),
      pull_request_gap_30d: block.gap30
        ? { median_seconds: block.gap30[0], from_pull_requests: block.gap30[1] }
        : null
    };
  } catch {
    return null;
  }
}

/** Which parts of a decoded measurement are known to be incomplete. Nothing is extrapolated. */
export function truncation(m) {
  const t = m.totals_30d;
  const listed = m.commit_repositories_30d.reduce((sum, r) => sum + r.commits, 0);
  return {
    commit_repositories: m.commit_repositories_30d.length < t.commit_repositories,
    commits_unlisted: Math.max(0, t.commits - listed),
    pull_request_repositories: m.pull_request_repositories_30d.length < t.pull_request_repositories,
    pull_requests_unread: m.pull_request_repositories_30d.some((r) => r.read < r.opened)
  };
}

/**
 * Judge one response for `slice`. Returns the measurements and the developers GitHub says do not
 * exist, or `{ok: false, reason}` for a response that must be discarded whole.
 */
export function judgeResponse(outcome, slice, { windows, measuredAt }) {
  if (outcome.kind === 'gateway') return { ok: false, reason: outcome.reason };
  if (outcome.kind !== 'ok' && outcome.kind !== 'partial') {
    return { ok: false, reason: `unexpected ${outcome.kind} response` };
  }

  const notFound = new Set();
  const other = [];
  for (const error of outcome.errors || []) {
    const path = error?.path;
    const index =
      Array.isArray(path) && path.length === 1 && /^u\d+$/.test(path[0])
        ? Number(path[0].slice(1))
        : null;
    if (error?.type === 'NOT_FOUND' && index != null && index < slice.length) notFound.add(index);
    else other.push(error);
  }
  if (other.length > 0) return { ok: false, reason: describeErrors(other) };

  const data = outcome.data;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'no data' };
  if (slice.every((_, i) => data[`u${i}`] == null) && notFound.size < slice.length) {
    return { ok: false, reason: 'every alias null: an over-large query' };
  }

  const measured = [];
  const missing = [];
  for (let i = 0; i < slice.length; i += 1) {
    const node = data[`u${i}`];
    if (notFound.has(i)) {
      if (node != null) return { ok: false, reason: `u${i} both found and not found` };
      missing.push(slice[i]);
      continue;
    }
    if (node == null) return { ok: false, reason: `u${i} null with no error for it` };
    try {
      measured.push({
        target: slice[i],
        measurement: readMeasurement(node, { target: slice[i], windows, measuredAt })
      });
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      return { ok: false, reason: `${slice[i].login}: ${error.message}` };
    }
  }
  return { ok: true, measured, missing };
}

/** A GraphQL client for this measurement: the discovery client, with long waits refused. */
export function createShadowClient({ token, maxWaitMs = MAX_WAIT_MS, ...options }) {
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return createSearchClient({
    token,
    ...options,
    sleep: async (ms) => {
      if (ms > maxWaitMs) throw new WaitTooLongError(ms);
      return sleep(ms);
    }
  });
}

function batchLine(index, count, slice, result, points, requests) {
  const ok = slice.filter((t) => result.blocks.has(t.login.toLowerCase()));
  const sum = (key) =>
    ok.reduce((total, t) => {
      const block = result.blocks.get(t.login.toLowerCase());
      return total + block.t30[TOTALS_30D.indexOf(key)];
    }, 0);
  return (
    `Shadow contributions batch ${index}/${count}: ${slice.length} developers, ` +
    `${ok.length} measured, ${slice.length - ok.length} failed, ${points} points, ` +
    `${requests} requests, ${sum('commits')} commits_30d, ${sum('restricted')} restricted_30d.`
  );
}

/**
 * Measure `developers` (`{username, github_id}` rows) in batches of `batchSize`, sequentially.
 * Never throws for GitHub's behaviour: whatever cannot be measured is listed in `failed`.
 *
 * @returns {{ blocks: Map<string, object>, failed: Map<string, string>, stats: object }}
 *   `blocks` keyed by lowercased login, holding encoded blocks.
 */
export async function measureShadowContributions(
  developers,
  {
    client,
    now = Date.now(),
    batchSize = BATCH_SIZE,
    maxRepositories = MAX_REPOSITORIES,
    log = console
  }
) {
  const windows = measurementWindows(now);
  const measuredAt = isoSecond(now instanceof Date ? now.getTime() : now);
  const seen = new Set();
  const targets = [];
  for (const dev of developers || []) {
    const login = typeof dev?.username === 'string' ? dev.username : null;
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    targets.push({ login, githubId: Number.isInteger(dev.github_id) ? dev.github_id : null });
  }

  const result = { blocks: new Map(), failed: new Map() };
  const stats = {
    developers: targets.length,
    requests: 0,
    points: 0,
    rejected: 0,
    bisections: 0,
    retries: 0,
    notFound: 0,
    stopped: null
  };
  const start = client.usage();
  const document = (n) => buildQuery(n, { maxRepositories });

  async function measureSlice(slice, attempt = 0) {
    const outcome = await client.query(document(slice.length), buildVariables(slice, windows));
    const verdict = judgeResponse(outcome, slice, { windows, measuredAt });
    if (verdict.ok) {
      for (const { target, measurement } of verdict.measured) {
        result.blocks.set(target.login.toLowerCase(), encodeShadow(measurement));
      }
      for (const target of verdict.missing) {
        stats.notFound += 1;
        result.failed.set(target.login, 'not found');
      }
      return;
    }
    stats.rejected += 1;
    log.log(
      `Shadow contributions: discarded the response for ${slice.length} developer(s), ` +
        `${slice.length > 1 ? 'splitting' : `attempt ${attempt + 1}`}: ${verdict.reason}`
    );
    if (slice.length > 1) {
      stats.bisections += 1;
      const mid = Math.ceil(slice.length / 2);
      await measureSlice(slice.slice(0, mid));
      await measureSlice(slice.slice(mid));
      return;
    }
    if (attempt < MAX_SINGLE_RETRIES) {
      stats.retries += 1;
      await client.sleep(RETRY_BASE_MS * (attempt + 1));
      await measureSlice(slice, attempt + 1);
      return;
    }
    result.failed.set(slice[0].login, verdict.reason);
  }

  const count = Math.ceil(targets.length / batchSize);
  for (let i = 0; i < targets.length; i += batchSize) {
    const slice = targets.slice(i, i + batchSize);
    const before = client.usage();
    if (!stats.stopped) {
      try {
        await measureSlice(slice);
      } catch (error) {
        // A rate limit that outlasts its retries, a wait longer than MAX_WAIT_MS, a rejected
        // credential: nothing more is sent this run.
        stats.stopped = error.message;
        log.warn(
          `::warning title=SHADOW_CONTRIBUTIONS::Stopped measuring after ${i} of ` +
            `${targets.length} developers: ${error.message}. Rows keep their previous block.`
        );
      }
    }
    for (const target of slice) {
      const key = target.login.toLowerCase();
      if (!result.blocks.has(key) && !result.failed.has(target.login)) {
        result.failed.set(target.login, stats.stopped || 'not measured');
      }
    }
    const after = client.usage();
    log.log(
      batchLine(
        i / batchSize + 1,
        count,
        slice,
        result,
        after.points - before.points,
        after.requests - before.requests
      )
    );
  }

  const end = client.usage();
  stats.requests = end.requests - start.requests;
  stats.points = end.points - start.points;
  return { ...result, stats };
}

/** Previous blocks from board rows, keyed by account id and by login. */
export function previousBlocks(rows) {
  const byId = new Map();
  const byLogin = new Map();
  for (const row of rows || []) {
    const block = row?.[SHADOW_FIELD];
    if (!block) continue;
    if (Number.isInteger(row.github_id)) byId.set(row.github_id, { block, row });
    if (typeof row.username === 'string') byLogin.set(row.username.toLowerCase(), { block, row });
  }
  return { byId, byLogin };
}

/**
 * Each developer with this run's block, or failing that the previous one for the same account,
 * unchanged with its own `at`. A block is never assembled from parts: it is one measurement.
 *
 * @returns {{ developers: object[], fresh: number, kept: number, none: number }}
 */
export function attachShadow(developers, { blocks, previous = previousBlocks([]) }) {
  let fresh = 0;
  let kept = 0;
  let none = 0;
  const out = (developers || []).map((dev) => {
    const login = String(dev?.username || '').toLowerCase();
    const block = blocks.get(login);
    if (block) {
      fresh += 1;
      return { ...dev, [SHADOW_FIELD]: block };
    }
    const id = Number.isInteger(dev?.github_id) ? dev.github_id : null;
    let prior = id != null ? previous.byId.get(id) : undefined;
    if (!prior) {
      const candidate = previous.byLogin.get(login);
      // By login only when neither side has an id to contradict it.
      const otherId = candidate?.row?.github_id;
      if (candidate && (id == null || !Number.isInteger(otherId) || otherId === id)) {
        prior = candidate;
      }
    }
    if (prior) {
      kept += 1;
      return { ...dev, [SHADOW_FIELD]: prior.block };
    }
    none += 1;
    const rest = { ...dev };
    delete rest[SHADOW_FIELD];
    return rest;
  });
  return { developers: out, fresh, kept, none };
}

function describeFailures(failed, shown = 5) {
  const list = [...failed].slice(0, shown).map(([login, reason]) => `${login}: ${reason}`);
  const more = failed.size > shown ? `; +${failed.size - shown} more` : '';
  return list.length ? ` (${list.join('; ')}${more})` : '';
}

/**
 * The pipeline's step: measure `developers`, attach this run's blocks, keep the previous block
 * for anyone this run could not measure. Never throws: the shadow measurement is context, and a
 * batch must not fail for it.
 *
 * @param {object[]} developers  scored rows; the block is attached after scoring
 * @param {{existing: object[], client: object|null, now: number, log: object}} options
 *   `existing` is the board the run loaded, where previous blocks are found.
 */
export async function shadowContributionsStep(
  developers,
  { existing = [], client, now = Date.now(), log = console } = {}
) {
  const previous = previousBlocks(existing);
  let blocks = new Map();
  if (!client) {
    log.warn('::warning title=SHADOW_CONTRIBUTIONS::No GitHub token; nothing measured.');
  } else if (developers.length > 0) {
    try {
      const measured = await measureShadowContributions(developers, { client, now, log });
      blocks = measured.blocks;
      const s = measured.stats;
      log.log(
        `Shadow contributions: ${blocks.size} of ${s.developers} measured, ` +
          `${measured.failed.size} failed${describeFailures(measured.failed)}; ${s.requests} ` +
          `requests, ${s.points} points, ${s.rejected} rejected, ${s.bisections} bisections, ` +
          `${s.retries} retries.`
      );
      if (s.developers > 0 && blocks.size === 0) {
        log.warn(
          `::warning title=SHADOW_CONTRIBUTIONS::Measured none of ${s.developers} developers.`
        );
      }
    } catch (error) {
      log.warn(
        `::warning title=SHADOW_CONTRIBUTIONS::Shadow measurement failed: ${error.message}. ` +
          'Rows keep their previous block.'
      );
    }
  }
  const attached = attachShadow(developers, { blocks, previous });
  log.log(
    `Shadow contributions on this batch's rows: ${attached.fresh} measured this run, ` +
      `${attached.kept} kept from an earlier run, ${attached.none} without one.`
  );
  return attached;
}
