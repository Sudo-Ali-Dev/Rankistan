/**
 * The contributions measurement: what each developer did in public over the last 30 days, read
 * from GitHub's contributions API and pull request lists, and stored on their row in the compact form
 * defined in src/model/measurement.js. It is what the score is computed from (src/model/), and
 * what the eligibility gate reads (scripts/measure/gate.js).
 *
 * The events feed scoring v2 read was capped at 300 events, so the busier a developer the less
 * time it covered: one top-30 developer's "30 days" held 6. `contributionsCollection` is keyed on
 * dates instead and sees the whole window however busy the account is.
 *
 * ## What is read
 *
 * Four phases, each one request per batch of developers or repositories:
 *
 *   main       contributionsCollection over the window: commits per repository per day (with
 *              the repository's stars, owner and fork flag), the pull requests, issues and
 *              reviews opened (each with its instant and repository), the private count as
 *              context, and a future probe for commits dated after the measurement.
 *   pages      a further page for a developer with more than 100 pull requests, issues or
 *              reviews, up to MAX_PAGES in all.
 *   merges     two lists per developer, keyed on the merge instant: their merged pull requests,
 *              most recently updated first, kept when merged in the window into a repository they
 *              do not own; and their own public repositories, most recently pushed first, with
 *              each one's merged pull requests by other people. `pullRequestContributions` is
 *              keyed on when a pull request was opened and cannot see a merge (a repo-proven
 *              trap). A merge updates the pull request and pushes to its repository, so each list
 *              is read until it passes the window's start. Each item carries who merged or wrote
 *              it, with that account's kind and age, the target's stars and owner, and the size of
 *              the change.
 *
 *              Not search: from scoring v3.0's launch on 2026-10-16 until the fix on 2026-10-17,
 *              every merge search the pipeline sent came back empty with no error, so every
 *              block it measured held no merges, while the same searches with a personal token
 *              returned them. The Actions token appears to search only the repository it runs in.
 *              The lists read the same pull requests with any token (measured on
 *              56 developers, identical to search wherever neither was cut). They are also
 *              checked against each other: a pull request the contributions API lists as merged
 *              in the window must be in the first list, and a repository they committed to must
 *              be in the second. A developer whose lists fail that check is not measured.
 *   integrity  for each repository with commits on INTEGRITY_MIN_DAYS or more days, up to 20 of
 *              the developer's commits there with their author date, commit date and committer.
 *              Two things never happen in an honest history: an author date hours after its
 *              commit date, and a date after the moment it is read. Both were found on the
 *              board on 2026-10-16, made by a "paint your graph" service. A commit a bot
 *              committed in the developer's name is counted too.
 *
 * Measured on 2026-10-16: reviews on one's own pull requests are review contributions (state
 * COMMENTED), so each review records the pull request's author; the future probe is accepted for
 * a range a year long.
 *
 * ## Failure
 *
 * Fail-soft for the run, strict per developer: a developer is measured whole or not at all. One
 * this run could not measure was not evaluated: a row of theirs on the board is carried with its
 * previous block (scripts/run-all.js), and removed only after UNMEASURED_AFTER_DAYS.
 * Within a request:
 *
 *   - 200 carrying `errors[]` is discarded whole and the batch split. The one exception is
 *     NOT_FOUND whose path is exactly one alias: that one does not exist, and nothing else in
 *     the response is in doubt. RESOURCE_LIMITS_EXCEEDED depends on content - one developer with
 *     355 repositories trips it - which is why a batch is bisected, not fixed small.
 *   - 200 with an alias null and no error for it is an over-large query, not an absent user.
 *   - a 502, timeout or non-JSON body (read as text first: a 502 is HTML) is split, and a single
 *     item retried; it is always retried, never taken as an answer.
 *   - a developer still refused on their own is measured once more with a 25-repository list,
 *     and marked CUT_DEGRADED: a shorter list is a measurement, an empty one is not.
 *   - rate limits are waited out at the same size (scripts/discovery/graphql.js). A wait longer
 *     than MAX_WAIT_MS stops the measurement instead, so it never holds the pipeline for an
 *     hourly reset.
 *   - a commit-date sample that fails is recorded as not sampled (CUT_INTEGRITY): an exclusion
 *     needs evidence, and a failed request is none.
 */
import { createSearchClient, describeErrors } from '../discovery/graphql.js';
import {
  CUT_ACCEPTED,
  CUT_COMMIT_REPOS,
  CUT_DEGRADED,
  CUT_INTEGRITY,
  CUT_ISSUES,
  CUT_MAINTAINED,
  CUT_PULL_REQUESTS,
  CUT_REVIEWS,
  FLAG_FORK,
  FLAG_OWNED,
  FLAG_PROFILE,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN,
  SHAPE_VERSION,
  actorKind,
  commitDate,
  dayOffset,
  decodeMeasurement,
  encodeMeasurement,
  instantOffset,
  measurementWindow,
  pktDate,
  repositoryFlags
} from '../../src/model/measurement.js';

export { SHAPE_VERSION, decodeMeasurement, encodeMeasurement, measurementWindow };

/** The row field the measurement is stored in. */
export const CONTRIBUTIONS_FIELD = 'contributions';
/** Where the measurement was stored while nothing scored it (2026-10-16 to the switch). */
export const LEGACY_FIELD = 'shadow_contributions';

/**
 * Developers per main request. Shape 1 measured 15 per request (2026-10-13); with pull
 * requests, issues and reviews listed per node and the future probe, 12 and 6 top-board
 * developers came back as 502s (2026-10-16), the gateway's ~10 s limit. 5 rarely does, and
 * bisection covers the rest.
 */
export const BATCH_SIZE = 5;
/** Developers per merges request, one list each. Searches of 10 and 5 came back as 502s. */
export const MERGES_BATCH_SIZE = 3;
/** Repositories per commit-date sample request: 40 timed out on 2026-10-16. */
export const INTEGRITY_BATCH_SIZE = 15;
/**
 * Developers per calendar request (the pre-screen, logged only for now). Measured on 2026-10-16:
 * 50 calendars trip RESOURCE_LIMITS_EXCEEDED at about the 34th.
 */
export const CALENDAR_BATCH_SIZE = 25;

/**
 * Repositories read per developer, most commits first. Measured on 50 board developers on
 * 2026-10-13: a cap of 25 would have cut 2 of them, unlisting 51 repositories and 61 of 5,050
 * commits. The tail is where a farm spreading commits across repositories would sit, so the cap
 * is the API's own maximum, and the shorter list is only the fallback for a refused developer.
 */
export const MAX_REPOSITORIES = 100;
export const DEGRADED_MAX_REPOSITORIES = 25;
/** Nodes per connection page. A window holds at most 31 commit days per repository. */
export const PAGE_SIZE = 100;
/** Pages read per kind of contribution before the list is marked cut. */
export const MAX_PAGES = 5;
/**
 * The merge lists' pages, measured on 2026-10-17 on the slowest accounts on the board: 25 merged
 * pull requests with their approvals took 2 to 3 s, and 10 repositories with 10 merged pull
 * requests each 2 to 7 s, where 100, and 50 repositories with 25 each, took the gateway's 10 s and
 * failed. A developer refused on their own is listed once more from a first page of
 * DEGRADED_MERGES, then paged as usual, so a heavy account costs requests, never items.
 */
export const MERGED_PAGE_SIZE = 25;
export const REPOSITORIES_PAGE_SIZE = 10;
export const REPOSITORY_MERGES = 10;
export const REPOSITORY_MERGES_PAGE_SIZE = 50;
export const DEGRADED_MERGES = 5;
/**
 * Pages read before a merge list is marked cut: 400 of their merged pull requests updated since
 * the window began, 200 of their repositories pushed since then, and 310 merged pull requests of
 * each repository. Search read 400.
 */
export const MAX_MERGED_PAGES = 16;
export const MAX_REPOSITORY_PAGES = 20;
export const MAX_REPOSITORY_MERGE_PAGES = 7;

export const INTEGRITY_MIN_DAYS = 3;
export const INTEGRITY_MAX_REPOSITORIES = 30;
export const INTEGRITY_SAMPLE = 20;
/** Approving reviews read per merged pull request. */
export const APPROVALS_READ = 5;

/** Requests in flight at once, per phase. */
export const CONCURRENCY = 3;

/** Retries of a single item after a rejected response, before it counts as failed. */
export const MAX_SINGLE_RETRIES = 2;
const RETRY_BASE_MS = 5000;

/** The longest wait the measurement accepts before it stops instead. */
export const MAX_WAIT_MS = 3 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isCount = (value) => Number.isInteger(value) && value >= 0;
const createdDate = (actor) =>
  typeof actor?.createdAt === 'string' ? actor.createdAt.slice(0, 10) : null;

/** Raised to stop measuring when a rate-limit wait would be longer than MAX_WAIT_MS. */
export class WaitTooLongError extends Error {
  constructor(ms) {
    super(`a rate-limit wait of ${Math.ceil(ms / 1000)}s is longer than this measurement waits`);
    this.name = 'WaitTooLongError';
  }
}

class Malformed extends Error {}

function requireCount(value, what) {
  if (!isCount(value)) throw new Malformed(`${what} is ${JSON.stringify(value)}, not a count`);
  return value;
}

function requireList(value, what) {
  if (!Array.isArray(value)) throw new Malformed(`${what} is not a list`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Documents

// `mergedAt` is not stored: it checks the merge list (crossCheckMerges).
const PR_NODE = `occurredAt pullRequest { number state merged mergedAt
      repository { nameWithOwner isFork isPrivate owner { __typename login } } }`;
const ISSUE_NODE = `occurredAt issue { number
      repository { nameWithOwner isFork isPrivate owner { __typename login } } }`;
// The review's own author association: NONE when the reviewer has no role in the project.
const REVIEW_NODE = `occurredAt pullRequestReview { authorAssociation } pullRequest { number
      author { __typename login ... on User { createdAt } }
      repository { nameWithOwner isFork isPrivate stargazerCount owner { __typename login } } }`;

const connection = (field, node, after = '') =>
  `${field}(first: ${PAGE_SIZE}${after}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${node} } }`;

function mainFragment(maxRepositories) {
  return `fragment Measure on User {
  login
  databaseId
  id
  c: contributionsCollection(from: $from, to: $to) {
    restrictedContributionsCount
    totalRepositoriesWithContributedCommits
    commitContributionsByRepository(maxRepositories: ${maxRepositories}) {
      repository { nameWithOwner isFork isPrivate stargazerCount owner { __typename login } }
      contributions(first: ${PAGE_SIZE}) { totalCount nodes { occurredAt commitCount } }
    }
    ${connection('pullRequestContributions', PR_NODE)}
    ${connection('issueContributions', ISSUE_NODE)}
    ${connection('pullRequestReviewContributions', REVIEW_NODE)}
  }
  f: contributionsCollection(from: $futureFrom, to: $futureTo) {
    commitContributionsByRepository(maxRepositories: 25) { repository { nameWithOwner } }
  }
}`;
}

/** One main request's document for `count` developers, aliased u0..u{count-1}. */
export function buildQuery(count, { maxRepositories = MAX_REPOSITORIES } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('buildQuery needs count >= 1');
  const params = [
    '$from: DateTime!',
    '$to: DateTime!',
    '$futureFrom: DateTime!',
    '$futureTo: DateTime!'
  ];
  const aliases = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`$l${i}: String!`);
    aliases.push(`u${i}: user(login: $l${i}) { ...Measure }`);
  }
  return (
    `query(${params.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ` +
    `${aliases.join('\n  ')}\n}\n${mainFragment(maxRepositories)}`
  );
}

export function buildVariables(slice, window) {
  const variables = {
    from: window.query.from,
    to: window.query.to,
    futureFrom: window.future.from,
    futureTo: window.future.to
  };
  slice.forEach((target, i) => {
    variables[`l${i}`] = target.login;
  });
  return variables;
}

const PAGE_FIELDS = {
  pull_requests: { field: 'pullRequestContributions', node: PR_NODE, cut: CUT_PULL_REQUESTS },
  issues: { field: 'issueContributions', node: ISSUE_NODE, cut: CUT_ISSUES },
  reviews: { field: 'pullRequestReviewContributions', node: REVIEW_NODE, cut: CUT_REVIEWS }
};

/** A further page of one kind of contribution for one developer. */
export function buildPageQuery(kind) {
  const { field, node } = PAGE_FIELDS[kind];
  return `query($login: String!, $from: DateTime!, $to: DateTime!, $after: String!) {
  rateLimit { cost remaining resetAt }
  u0: user(login: $login) {
    login
    c: contributionsCollection(from: $from, to: $to) { ${connection(field, node, ', after: $after')} }
  }
}`;
}

// Approvals: a pull request its author merged after another user approved it was accepted by
// that user, and is credited to them as if they had merged it (src/model/evidence.js).
const ACCEPTED_NODE = `number mergedAt updatedAt additions deletions changedFiles
      mergedBy { __typename login ... on User { createdAt } }
      reviews(states: APPROVED, first: ${APPROVALS_READ}) {
        nodes { author { __typename login ... on User { createdAt } } } }
      repository { nameWithOwner isFork isPrivate stargazerCount
        owner { __typename login ... on User { createdAt } ... on Organization { createdAt } } }`;
const MAINTAINED_NODE = `number mergedAt updatedAt additions deletions changedFiles
      author { __typename login ... on User { createdAt } }`;

// Newest update first: a merge updates its pull request, so once a page reaches a pull request
// last updated before the window, no later one can have been merged in it.
const mergedPulls = (first, node, after = '') =>
  `pullRequests(states: MERGED, first: ${first}${after}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor } nodes { ${node} } }`;
// Newest push first: a merge pushes to its repository, so the same holds for repositories.
const ownRepositories = (first, merges, after = '') =>
  `repositories(ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC, first: ${first}${after},
      orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner isFork isPrivate stargazerCount pushedAt owner { __typename login }
        ${mergedPulls(merges, MAINTAINED_NODE)} } }`;

const mergeList = (kind, first, after = '') =>
  kind === 'accepted'
    ? `a: ${mergedPulls(first ?? MERGED_PAGE_SIZE, ACCEPTED_NODE, after)}`
    : `m: ${ownRepositories(first ?? REPOSITORIES_PAGE_SIZE, first ?? REPOSITORY_MERGES, after)}`;

/**
 * One merge list's first page for `count` developers, aliased u{i}: `accepted` (`a`), their
 * merged pull requests, or `repositories` (`m`), their own repositories with each one's merged
 * pull requests. `first` shortens the page for a developer refused at the usual size.
 */
export function buildMergesQuery(kind, count, { first } = {}) {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('buildMergesQuery needs count >= 1');
  const params = [];
  const fields = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`$l${i}: String!`);
    fields.push(`u${i}: user(login: $l${i}) { login ${mergeList(kind, first)} }`);
  }
  return `query(${params.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ${fields.join('\n  ')}\n}`;
}

/** A further page of one developer's merge list. */
export function buildMergesPageQuery(kind) {
  return `query($login: String!, $after: String!) {
  rateLimit { cost remaining resetAt }
  u0: user(login: $login) { login ${mergeList(kind, undefined, ', after: $after')} }
}`;
}

/** A further page of one repository's merged pull requests. */
export function buildRepositoryMergesQuery() {
  return `query($owner: String!, $name: String!, $after: String!) {
  rateLimit { cost remaining resetAt }
  r: repository(owner: $owner, name: $name) {
    ${mergedPulls(REPOSITORY_MERGES_PAGE_SIZE, MAINTAINED_NODE, ', after: $after')} }
}`;
}

const historyOf = (i) =>
  `history(first: ${INTEGRITY_SAMPLE}, since: $since, author: { id: $a${i} }) {
        nodes { oid authoredDate committedDate committer { name email user { login } } } }`;

/**
 * Commit-date samples for `count` repositories, aliased r{i}: the default branch and gh-pages,
 * the two branches whose commits GitHub counts as contributions.
 */
export function buildIntegrityQuery(count) {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('buildIntegrityQuery needs count >= 1');
  const params = ['$since: GitTimestamp!'];
  const fields = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`$o${i}: String!`, `$n${i}: String!`, `$a${i}: ID!`);
    fields.push(
      `r${i}: repository(owner: $o${i}, name: $n${i}) {
      defaultBranchRef { name target { ... on Commit { ${historyOf(i)} } } }
      gh: ref(qualifiedName: "refs/heads/gh-pages") { target { ... on Commit { ${historyOf(i)} } } } }`
    );
  }
  return `query(${params.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ${fields.join('\n  ')}\n}`;
}

/** The contribution calendar of `count` developers, for the pre-screen. */
export function buildCalendarQuery(count) {
  const params = ['$from: DateTime!', '$to: DateTime!'];
  const fields = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`$l${i}: String!`);
    fields.push(
      `u${i}: user(login: $l${i}) { login databaseId c: contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } } } }`
    );
  }
  return `query(${params.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ${fields.join('\n  ')}\n}`;
}

// ---------------------------------------------------------------------------------------------
// Reading responses

function repositoryOf(repository, login, what) {
  const name = repository?.nameWithOwner;
  if (typeof name !== 'string' || !name.includes('/')) {
    throw new Malformed(`${what}: repository name ${JSON.stringify(name)}`);
  }
  const ownerLogin = repository.owner?.login;
  if (typeof ownerLogin !== 'string') throw new Malformed(`${name} has no owner`);
  return {
    name,
    private: repository.isPrivate === true,
    flags: repositoryFlags(
      {
        nameWithOwner: name,
        ownerLogin,
        ownerType: repository.owner.__typename,
        isFork: repository.isFork
      },
      login
    )
  };
}

const person = (actor) =>
  actor && typeof actor.login === 'string'
    ? { login: actor.login, kind: actorKind(actor.__typename), created: createdDate(actor) }
    : null;

function groupInto(map, name, flags, extra, item) {
  if (!map.has(name)) map.set(name, { repo: name, flags, ...extra, items: [] });
  map.get(name).items.push(item);
}

const pullKey = (name, number) => `${name.toLowerCase()}#${number}`;

/**
 * Pull requests, issues or reviews from one page of a connection, into `into` (by repo). A pull
 * request of theirs merged in the window into a repository they do not own is also added to
 * `merged`, the keys the merge list must hold.
 */
function readContributionPage(kind, conn, { login, window, into, merged }) {
  if (!conn || typeof conn !== 'object') throw new Malformed(`no ${kind}`);
  requireCount(conn.totalCount, `${kind} total`);
  for (const node of requireList(conn.nodes, `${kind} nodes`)) {
    const day = instantOffset(node?.occurredAt, window);
    if (day === null) {
      if (!Number.isFinite(Date.parse(node?.occurredAt))) {
        throw new Malformed(`${kind}: occurredAt ${JSON.stringify(node?.occurredAt)}`);
      }
      continue; // an instant of a date outside the window: the query range is a day wider.
    }
    if (kind === 'issues') {
      const issue = node.issue;
      const { name, flags, private: hidden } = repositoryOf(issue?.repository, login, 'issue');
      if (hidden) continue; // private work is never scored
      groupInto(
        into,
        name,
        flags,
        {},
        { day, number: requireCount(issue.number, `${name} issue`) }
      );
      continue;
    }
    const pr = node.pullRequest;
    const number = requireCount(pr?.number, `${kind} number`);
    if (kind === 'pull_requests') {
      const { name, flags, private: hidden } = repositoryOf(pr.repository, login, 'pull request');
      if (hidden) continue;
      const outcome =
        pr.merged === true ? OUTCOME_MERGED : pr.state === 'CLOSED' ? OUTCOME_CLOSED : OUTCOME_OPEN;
      groupInto(into, name, flags, {}, { day, number, outcome });
      if (
        outcome === OUTCOME_MERGED &&
        !(flags & FLAG_OWNED) &&
        instantOffset(pr.mergedAt, window) !== null
      ) {
        merged.add(pullKey(name, number));
      }
    } else {
      const { name, flags, private: hidden } = repositoryOf(pr.repository, login, 'review');
      if (hidden) continue;
      const stars = requireCount(pr.repository.stargazerCount, `${name} stars`);
      const outsider = node.pullRequestReview?.authorAssociation === 'NONE';
      groupInto(into, name, flags, { stars }, { day, number, author: person(pr.author), outsider });
    }
  }
  return {
    next: conn.pageInfo?.hasNextPage === true ? conn.pageInfo.endCursor : null
  };
}

/**
 * One developer's main measurement from their alias. Throws Malformed for anything not in the
 * expected shape: a response that does not look as measured is not trusted for anyone in it.
 */
export function readMain(node, { target, window }) {
  if (!node || typeof node !== 'object') throw new Malformed('no user');
  const login = node.login;
  if (typeof login !== 'string' || login.toLowerCase() !== target.login.toLowerCase()) {
    throw new Malformed(`login ${JSON.stringify(login)} for ${target.login}`);
  }
  // A login can be released and claimed by another account between discovery and now.
  if (target.githubId != null && node.databaseId !== target.githubId) {
    throw new Malformed(`${login} is account ${node.databaseId}, the row is ${target.githubId}`);
  }
  if (typeof node.id !== 'string') throw new Malformed(`${login} has no node id`);
  const c = node.c;
  if (!c || typeof c !== 'object') throw new Malformed('no contributions collection');

  let cut = 0;
  const commits = [];
  const repositories = requireList(c.commitContributionsByRepository, 'commit repositories');
  for (const entry of repositories) {
    const { name, flags, private: hidden } = repositoryOf(entry?.repository, login, 'commits');
    if (hidden) continue;
    const stars = requireCount(entry.repository.stargazerCount, `${name} stars`);
    const total = requireCount(entry.contributions?.totalCount, `${name} commits`);
    const nodes = requireList(entry.contributions?.nodes, `${name} commit days`);
    const perDay = new Map();
    let sum = 0;
    for (const dayNode of nodes) {
      const n = requireCount(dayNode?.commitCount, `${name} commits on a day`);
      const date = commitDate(dayNode.occurredAt);
      if (date === null)
        throw new Malformed(`${name}: occurredAt ${JSON.stringify(dayNode.occurredAt)}`);
      sum += n;
      const day = dayOffset(date, window);
      if (day === null || n === 0) continue; // dated the day before the window: see measurement.js
      perDay.set(day, (perDay.get(day) || 0) + n);
    }
    // Every day of the range fits in one page, so the days account for every commit.
    if (sum !== total) throw new Malformed(`${name}: ${sum} commits by day, ${total} in total`);
    if (perDay.size === 0) continue;
    const days = [...perDay].sort((a, b) => a[0] - b[0]).map(([day, n]) => ({ day, commits: n }));
    commits.push({ repo: name, flags, stars, days });
  }
  const repositoryTotal = requireCount(
    c.totalRepositoriesWithContributedCommits,
    'commit repositories'
  );
  if (repositories.length < repositoryTotal) cut |= CUT_COMMIT_REPOS;

  const lists = {};
  const next = {};
  const merged = new Set();
  for (const [kind, { field }] of Object.entries(PAGE_FIELDS)) {
    lists[kind] = new Map();
    next[kind] = readContributionPage(kind, c[field], {
      login,
      window,
      into: lists[kind],
      merged
    }).next;
  }

  const future = node.f?.commitContributionsByRepository;
  const futureRepos = requireList(future, 'future probe').map((entry) => {
    const name = entry?.repository?.nameWithOwner;
    if (typeof name !== 'string') throw new Malformed('future probe repository');
    return name;
  });

  return {
    login,
    github_id: requireCount(node.databaseId, 'databaseId'),
    node_id: node.id,
    restricted: requireCount(c.restrictedContributionsCount, 'restricted'),
    commits,
    lists,
    next,
    merged,
    future_repos: futureRepos,
    cut
  };
}

/**
 * Of the users who approved a pull request, other than its author, the one whose account is
 * oldest (then by login): the approver most likely to meet the counterparty age rule.
 */
export function approverOf(pr, login) {
  const me = login.toLowerCase();
  const candidates = requireList(pr.reviews?.nodes ?? [], 'approvals')
    .map((review) => person(review?.author))
    .filter((p) => p !== null && p.kind === KIND_USER && p.login.toLowerCase() !== me);
  candidates.sort((a, b) =>
    (a.created ?? '9999') < (b.created ?? '9999')
      ? -1
      : (a.created ?? '9999') > (b.created ?? '9999')
        ? 1
        : a.login.toLowerCase() < b.login.toLowerCase()
          ? -1
          : 1
  );
  return candidates[0] ?? null;
}

/** A list read newest first: true once `at` is before the window, where it can stop. */
function beforeWindow(at, window, what) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Malformed(`${what}: ${JSON.stringify(at)}`);
  return ms < window.instants.from;
}

function changeSize(pr, name, number) {
  return {
    lines:
      requireCount(pr.additions, `${name}#${number} additions`) +
      requireCount(pr.deletions, `${name}#${number} deletions`),
    files: requireCount(pr.changedFiles, `${name}#${number} files`)
  };
}

/**
 * One page of a developer's merged pull requests, newest update first, into `into` (by repo):
 * those merged in the window into a repository they do not own. Returns the next cursor, or null
 * once the list is done or has reached a pull request last updated before the window.
 */
export function readAcceptedPage(conn, { login, window, into }) {
  if (!conn || typeof conn !== 'object') throw new Malformed('no merged pull requests');
  let passed = false;
  for (const pr of requireList(conn.nodes, 'merged pull requests')) {
    const number = requireCount(pr?.number, 'merged pull request number');
    if (beforeWindow(pr.updatedAt, window, `#${number} updatedAt`)) {
      passed = true;
      continue;
    }
    const day = instantOffset(pr.mergedAt, window);
    if (day === null) continue;
    const { name, flags, private: hidden } = repositoryOf(pr.repository, login, 'merged');
    if (hidden || flags & FLAG_OWNED) continue; // their own repository: nobody else accepted it
    const stars = requireCount(pr.repository.stargazerCount, `${name} stars`);
    const owner = person(pr.repository.owner);
    const merger = person(pr.mergedBy);
    const self = merger !== null && merger.login.toLowerCase() === login.toLowerCase();
    groupInto(
      into,
      name,
      flags,
      { stars, owner },
      {
        day,
        number,
        merger,
        ...changeSize(pr, name, number),
        approver: self ? approverOf(pr, login) : null
      }
    );
  }
  return !passed && conn.pageInfo?.hasNextPage === true ? conn.pageInfo.endCursor : null;
}

/**
 * One page of one of their repositories' merged pull requests, newest update first, into `into`:
 * other people's, merged in the window. Returns the next cursor or null, as readAcceptedPage.
 */
export function readRepositoryMerges(conn, { repo, login, window, into }) {
  if (!conn || typeof conn !== 'object')
    throw new Malformed(`${repo.name}: no merged pull requests`);
  const me = login.toLowerCase();
  let passed = false;
  for (const pr of requireList(conn.nodes, `${repo.name} merged pull requests`)) {
    const number = requireCount(pr?.number, `${repo.name} merged pull request number`);
    if (beforeWindow(pr.updatedAt, window, `${repo.name}#${number} updatedAt`)) {
      passed = true;
      continue;
    }
    const day = instantOffset(pr.mergedAt, window);
    if (day === null) continue;
    const author = person(pr.author);
    if (author !== null && author.login.toLowerCase() === me) continue;
    groupInto(
      into,
      repo.name,
      repo.flags,
      { stars: repo.stars },
      { day, number, author, ...changeSize(pr, repo.name, number) }
    );
  }
  return !passed && conn.pageInfo?.hasNextPage === true ? conn.pageInfo.endCursor : null;
}

/**
 * One page of a developer's own public repositories, newest push first, into `walk`: every
 * repository listed, the merges of each one pushed in the window, and the repositories whose
 * merges continue past the page. Returns the next cursor or null, as readAcceptedPage.
 */
export function readRepositoriesPage(conn, { login, window, walk }) {
  if (!conn || typeof conn !== 'object') throw new Malformed('no repositories');
  let passed = false;
  for (const node of requireList(conn.nodes, 'repositories')) {
    const { name, flags, private: hidden } = repositoryOf(node, login, 'repositories');
    walk.listed.add(name.toLowerCase());
    if (node.pushedAt === null) continue; // created and never pushed to: nothing was merged there
    if (beforeWindow(node.pushedAt, window, `${name} pushedAt`)) {
      passed = true;
      continue;
    }
    if (hidden || !(flags & FLAG_OWNED) || flags & FLAG_FORK) continue;
    const repo = { name, flags, stars: requireCount(node.stargazerCount, `${name} stars`) };
    const next = readRepositoryMerges(node.pullRequests, {
      repo,
      login,
      window,
      into: walk.maintained
    });
    if (next) walk.more.push({ ...repo, cursor: next });
  }
  walk.exhausted = conn.pageInfo?.hasNextPage !== true;
  return !passed && !walk.exhausted ? conn.pageInfo.endCursor : null;
}

/** One merge list's first page from one developer's alias. */
export function readMergesFirst(kind, node, { target, window }) {
  if (!node || typeof node !== 'object') throw new Malformed('no user');
  if (typeof node.login !== 'string' || node.login.toLowerCase() !== target.login.toLowerCase()) {
    throw new Malformed(`login ${JSON.stringify(node.login)} for ${target.login}`);
  }
  const login = node.login;
  if (kind === 'accepted') {
    const accepted = new Map();
    return { accepted, next: readAcceptedPage(node.a, { login, window, into: accepted }) };
  }
  const walk = { listed: new Set(), maintained: new Map(), more: [], exhausted: false };
  return { walk, next: readRepositoriesPage(node.m, { login, window, walk }) };
}

/**
 * Why a developer's merge lists cannot be trusted, or null. Two facts the main phase already
 * established must hold in them: every pull request of theirs the contributions API lists as
 * merged in the window into someone else's repository is in their merged pull requests, and the
 * repositories they own and committed to are in their repository list. A token that cannot see
 * the lists, or a list GitHub returned short, fails here instead of storing no merges.
 */
export function crossCheckMerges(m, s) {
  if (!(m.cut & CUT_ACCEPTED)) {
    const read = new Set();
    for (const r of s.accepted.values())
      for (const i of r.items) read.add(pullKey(r.repo, i.number));
    const missing = [...m.merged].filter((key) => !read.has(key)).sort();
    if (missing.length > 0) {
      return `${missing.length} merged pull request(s) missing from their merge list, ${missing[0]} first`;
    }
  }
  const own = m.commits
    .filter((r) => r.flags & FLAG_OWNED && !(r.flags & FLAG_FORK))
    .map((r) => r.repo.toLowerCase())
    .sort();
  if (own.length > 0 && s.walk.listed.size === 0) {
    return `their repository list is empty, though they committed to ${own[0]}`;
  }
  // Read to its end, the list holds every repository they own, pushed in the window or not.
  const absent = s.walk.exhausted ? own.filter((r) => !s.walk.listed.has(r)) : [];
  if (absent.length > 0) return `their repository list lacks ${absent[0]}, which they committed to`;
  return null;
}

/**
 * A committer that is automation: a GitHub App (`…[bot]`) or a committer named as a bot ("Repo
 * Health Bot", "Job Finder Bot", "scraping-bot"). Not the Actions user by itself: companies that
 * sync their engineers' commits into a public repository commit them as "Github Actions"
 * (`actions-user`), with the engineer as author (measured on 2026-10-16, plasmicapp/plasmic). Not
 * the web editor's committer either, GitHub (`web-flow`), which is a person's own edit.
 */
export function isBotCommitter(committer) {
  const login = committer?.user?.login;
  const name = committer?.name;
  if (typeof login === 'string' && /\[bot\]$/i.test(login)) return true;
  return typeof name === 'string' && (/\[bot\]$/i.test(name) || /\bbot\b/i.test(name));
}

/**
 * A commit-date sample of one repository, relative to the measurement instant: the developer's
 * commits since the window began on the default branch and on gh-pages, one commit once.
 */
export function readIntegrity(node, { repo, measuredAtMs }) {
  const histories = [node?.defaultBranchRef?.target?.history, node?.gh?.target?.history].filter(
    Boolean
  );
  const seen = new Set();
  const commits = [];
  let truncated = false;
  for (const history of histories) {
    const nodes = requireList(history.nodes, `${repo} history`);
    if (nodes.length >= INTEGRITY_SAMPLE) truncated = true;
    for (const commit of nodes) {
      const key = typeof commit?.oid === 'string' ? commit.oid : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      commits.push(commit);
    }
  }
  let bot = 0;
  let lead = -Infinity;
  let ahead = -Infinity;
  const dates = new Set();
  for (const commit of commits) {
    const authored = Date.parse(commit?.authoredDate);
    const committed = Date.parse(commit?.committedDate);
    if (!Number.isFinite(authored) || !Number.isFinite(committed)) {
      throw new Malformed(`${repo}: a commit without its dates`);
    }
    lead = Math.max(lead, (authored - committed) / HOUR_MS);
    ahead = Math.max(ahead, (Math.max(authored, committed) - measuredAtMs) / HOUR_MS);
    if (isBotCommitter(commit.committer)) bot += 1;
    dates.add(pktDate(authored));
  }
  const round = (h) => (Number.isFinite(h) ? Math.round(h * 10) / 10 : null);
  return {
    repo,
    sampled: commits.length,
    bot,
    max_lead_hours: round(lead),
    max_ahead_hours: round(ahead),
    // Only a sample holding every commit since the window began says which days have none.
    days: truncated ? null : dates.size
  };
}

/** Active days in a calendar, for the pre-screen. */
export function calendarActiveDays(calendar) {
  const days = requireList(calendar?.weeks, 'calendar weeks').flatMap((week) =>
    requireList(week?.contributionDays, 'calendar days')
  );
  return days.filter((d) => requireCount(d?.contributionCount, 'calendar count') > 0).length;
}

// ---------------------------------------------------------------------------------------------
// Running requests

/**
 * Judge one aliased response for `slice`. `aliases(i)` names item i's aliases; `read(nodes, item)`
 * turns them into a value or throws Malformed. Returns `{ok, values, missing}` or
 * `{ok: false, reason}` for a response that must be discarded whole.
 */
export function judgeAliased(outcome, slice, { aliases, read }) {
  if (outcome.kind === 'gateway') return { ok: false, reason: outcome.reason };
  if (outcome.kind !== 'ok' && outcome.kind !== 'partial') {
    return { ok: false, reason: `unexpected ${outcome.kind} response` };
  }
  const owner = new Map();
  slice.forEach((_, i) => aliases(i).forEach((alias) => owner.set(alias, i)));
  const notFound = new Set();
  const other = [];
  for (const error of outcome.errors || []) {
    const path = error?.path;
    const index = Array.isArray(path) && path.length === 1 ? owner.get(path[0]) : undefined;
    if (error?.type === 'NOT_FOUND' && index !== undefined) notFound.add(index);
    else other.push(error);
  }
  if (other.length > 0) return { ok: false, reason: describeErrors(other) };

  const data = outcome.data;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'no data' };
  const allNull = slice.every((_, i) => aliases(i).every((alias) => data[alias] == null));
  if (allNull && notFound.size < slice.length) {
    return { ok: false, reason: 'every alias null: an over-large query' };
  }

  const values = [];
  const missing = [];
  for (let i = 0; i < slice.length; i += 1) {
    const nodes = aliases(i).map((alias) => data[alias]);
    if (notFound.has(i)) {
      missing.push(slice[i]);
      continue;
    }
    if (nodes.some((n) => n == null))
      return { ok: false, reason: `${aliases(i)[0]} null with no error for it` };
    try {
      values.push({ item: slice[i], value: read(nodes, slice[i]) });
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      return { ok: false, reason: `${slice[i].login ?? slice[i].repo}: ${error.message}` };
    }
  }
  return { ok: true, values, missing };
}

/**
 * Sends `items` in slices of `size`, bisecting a rejected slice and retrying a single item, and
 * stops (without throwing) on a rate limit it may not wait out. Returns values and failures
 * keyed by `key(item)`.
 */
async function runSlices(
  items,
  {
    size,
    document,
    variables,
    aliases,
    read,
    key,
    client,
    stats,
    label,
    log,
    concurrency = CONCURRENCY
  }
) {
  const values = new Map();
  const failed = new Map();

  async function slice(part, attempt = 0) {
    const outcome = await client.query(document(part.length), variables(part));
    const verdict = judgeAliased(outcome, part, { aliases, read });
    if (verdict.ok) {
      for (const { item, value } of verdict.values) values.set(key(item), value);
      for (const item of verdict.missing) {
        stats.notFound += 1;
        failed.set(key(item), 'not found');
      }
      return;
    }
    stats.rejected += 1;
    log.log(
      `Contributions ${label}: discarded the response for ${part.length} item(s), ` +
        `${part.length > 1 ? 'splitting' : `attempt ${attempt + 1}`}: ${verdict.reason}`
    );
    if (part.length > 1) {
      stats.bisections += 1;
      const mid = Math.ceil(part.length / 2);
      await slice(part.slice(0, mid));
      await slice(part.slice(mid));
      return;
    }
    if (attempt < MAX_SINGLE_RETRIES) {
      stats.retries += 1;
      await client.sleep(RETRY_BASE_MS * (attempt + 1));
      await slice(part, attempt + 1);
      return;
    }
    failed.set(key(part[0]), verdict.reason);
  }

  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  let next = 0;
  let done = 0;
  // `concurrency` slices in flight at once, each bisected and retried on its own. GitHub asks for
  // no more than 100 concurrent requests and 2,000 points a minute; this sends a handful.
  async function worker() {
    while (next < parts.length && !stats.stopped) {
      const part = parts[next];
      next += 1;
      try {
        await slice(part);
      } catch (error) {
        // A rate limit that outlasts its retries, a wait longer than MAX_WAIT_MS, a rejected
        // credential: nothing more is sent this run.
        if (!stats.stopped) {
          stats.stopped = error.message;
          log.warn(
            `::warning title=CONTRIBUTIONS::Stopped measuring (${label}) after ${done} of ` +
              `${parts.length} requests: ${error.message}. Rows keep their previous block.`
          );
        }
      }
      done += 1;
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, parts.length)) }, worker)
  );
  for (const item of items) {
    const k = key(item);
    if (!values.has(k) && !failed.has(k)) failed.set(k, stats.stopped || 'not measured');
  }
  return { values, failed };
}

/** A GraphQL client for this measurement: the discovery client, with long waits refused. */
export function createMeasurementClient({ token, maxWaitMs = MAX_WAIT_MS, ...options }) {
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

/** Further pages of one connection for one developer, until done or capped. */
async function readMorePages({ client, document, variables, read, first, maxPages }) {
  let cursor = first;
  let pages = 1;
  while (cursor && pages < maxPages) {
    const outcome = await client.query(document, { ...variables, after: cursor });
    if (outcome.kind !== 'ok') {
      const reason =
        outcome.kind === 'partial'
          ? describeErrors(outcome.errors)
          : outcome.reason || outcome.kind;
      throw new PageFailed(reason);
    }
    cursor = read(outcome.data);
    pages += 1;
  }
  return { complete: !cursor };
}

class PageFailed extends Error {}

function targetsOf(developers) {
  const seen = new Set();
  const targets = [];
  for (const dev of developers || []) {
    const login = typeof dev?.username === 'string' ? dev.username : null;
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    targets.push({ login, githubId: Number.isInteger(dev.github_id) ? dev.github_id : null });
  }
  return targets;
}

/** Repositories worth a commit-date sample: commits on enough days, most days first. */
export function integrityTargets(main) {
  const eligible = main.commits
    .filter((r) => !(r.flags & FLAG_FORK) && !(r.flags & FLAG_PROFILE))
    .filter((r) => r.days.length >= INTEGRITY_MIN_DAYS)
    .sort((a, b) => b.days.length - a.days.length || (a.repo < b.repo ? -1 : 1));
  return {
    repos: eligible.slice(0, INTEGRITY_MAX_REPOSITORIES).map((r) => r.repo),
    cut: eligible.length > INTEGRITY_MAX_REPOSITORIES
  };
}

/**
 * Measure `developers` (`{username, github_id}` rows). Never throws for GitHub's behaviour:
 * whatever cannot be measured is listed in `failed`.
 *
 * `prefilter(partial)`, when given, sees each developer's measurement after the main phase (no
 * merge lists or commit-date samples yet) and returns false for one who cannot pass the gate
 * whatever those add: the merge lists and samples are then skipped, and the developer is listed in
 * `ineligible` with that partial measurement, encoded. Working days come from the main phase
 * alone, and the later phases can only remove days, so this never turns away anyone the gate
 * would admit.
 *
 * @returns {{ blocks: Map<string, object>, ineligible: Map<string, object>,
 *             failed: Map<string, string>, stats: object }}
 *   `blocks` and `ineligible` keyed by lowercased login, holding encoded blocks.
 */
export async function measureContributions(
  developers,
  { client, now = Date.now(), batchSize = BATCH_SIZE, prefilter = null, log = console }
) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const window = measurementWindow(nowMs);
  const measuredAt = isoSecond(nowMs);
  const targets = targetsOf(developers);
  const stats = {
    developers: targets.length,
    requests: 0,
    points: 0,
    rejected: 0,
    bisections: 0,
    retries: 0,
    notFound: 0,
    degraded: 0,
    inconsistent: 0,
    stopped: null
  };
  const start = client.usage();
  const failed = new Map();
  const keyOf = (t) => t.login.toLowerCase();

  // Main.
  const runMain = (items, maxRepositories) =>
    runSlices(items, {
      size: batchSize,
      document: (n) => buildQuery(n, { maxRepositories }),
      variables: (part) => buildVariables(part, window),
      aliases: (i) => [`u${i}`],
      read: ([node], target) => readMain(node, { target, window }),
      key: keyOf,
      client,
      stats,
      label: 'main',
      log
    });
  const main = await runMain(targets, MAX_REPOSITORIES);
  // A developer refused on their own, with the full list, gets one try with a shorter one.
  const refused = targets.filter((t) => {
    const reason = main.failed.get(keyOf(t));
    return reason && reason !== 'not found' && !stats.stopped;
  });
  if (refused.length > 0) {
    const retry = await runSlices(refused, {
      size: 1,
      document: () => buildQuery(1, { maxRepositories: DEGRADED_MAX_REPOSITORIES }),
      variables: (part) => buildVariables(part, window),
      aliases: () => ['u0'],
      read: ([node], target) => readMain(node, { target, window }),
      key: keyOf,
      client,
      stats,
      label: 'main, shorter repository list',
      log
    });
    for (const [key, value] of retry.values) {
      value.cut |= CUT_DEGRADED;
      main.values.set(key, value);
      main.failed.delete(key);
      stats.degraded += 1;
    }
  }
  for (const [key, reason] of main.failed) failed.set(key, reason);
  const measured = targets.filter((t) => main.values.has(keyOf(t)));

  // Pages. A developer whose pages were not all read is not measured: a block is whole.
  const unfinished = (target) => {
    main.values.delete(keyOf(target));
    failed.set(keyOf(target), stats.stopped || 'not measured');
  };
  for (const target of measured) {
    const m = main.values.get(keyOf(target));
    if (stats.stopped) {
      if (Object.values(m.next).some(Boolean)) unfinished(target);
      continue;
    }
    try {
      for (const [kind, { field, cut }] of Object.entries(PAGE_FIELDS)) {
        if (!m.next[kind]) continue;
        const { complete } = await readMorePages({
          client,
          document: buildPageQuery(kind),
          variables: { login: target.login, from: window.query.from, to: window.query.to },
          first: m.next[kind],
          maxPages: MAX_PAGES,
          read: (data) => {
            try {
              return readContributionPage(kind, data?.u0?.c?.[field], {
                login: m.login,
                window,
                into: m.lists[kind],
                merged: m.merged
              }).next;
            } catch (error) {
              if (error instanceof Malformed) throw new PageFailed(error.message);
              throw error;
            }
          }
        });
        if (!complete) m.cut |= cut;
      }
    } catch (error) {
      if (!(error instanceof PageFailed)) {
        stats.stopped = error.message;
        unfinished(target);
        continue;
      }
      main.values.delete(keyOf(target));
      failed.set(keyOf(target), `a further page: ${error.message}`);
    }
  }

  const assemble = (m, s, sampled) => ({
    version: SHAPE_VERSION,
    measured_at: measuredAt,
    login: m.login,
    github_id: m.github_id,
    window: { from: window.from, to: window.to },
    restricted: m.restricted,
    commits: m.commits,
    pull_requests: [...m.lists.pull_requests.values()],
    issues: [...m.lists.issues.values()],
    reviews: [...m.lists.reviews.values()],
    accepted: s ? [...s.accepted.values()] : [],
    maintained: s ? [...s.walk.maintained.values()] : [],
    future_repos: m.future_repos,
    integrity: sampled,
    cut: m.cut
  });

  // The gate's early answer: no merge lists or samples for someone who cannot pass it.
  const ineligible = new Map();
  if (prefilter) {
    for (const target of targets) {
      const key = keyOf(target);
      const m = main.values.get(key);
      if (!m) continue;
      const partial = assemble(m, null, []);
      if (!prefilter(partial)) {
        ineligible.set(key, encodeMeasurement(partial));
        main.values.delete(key);
      }
    }
  }

  // Merges: each list's first page in batches, then each developer's further pages.
  let listable = targets.filter((t) => main.values.has(keyOf(t)));
  const firstPages = {};
  for (const kind of ['accepted', 'repositories']) {
    const list = (items, size, first) =>
      runSlices(items, {
        size,
        document: (n) => buildMergesQuery(kind, n, { first }),
        variables: (part) => Object.fromEntries(part.map((t, i) => [`l${i}`, t.login])),
        aliases: (i) => [`u${i}`],
        read: ([node], target) => readMergesFirst(kind, node, { target, window }),
        key: keyOf,
        client,
        stats,
        label: `merges (${kind})`,
        log
      });
    const result = await list(listable, MERGES_BATCH_SIZE);
    const refused = listable.filter((t) => {
      const reason = result.failed.get(keyOf(t));
      return reason && reason !== 'not found' && !stats.stopped;
    });
    if (refused.length > 0) {
      const retry = await list(refused, 1, DEGRADED_MERGES);
      for (const [key, value] of retry.values) {
        result.values.set(key, value);
        result.failed.delete(key);
      }
    }
    for (const [key, reason] of result.failed) {
      if (main.values.has(key)) failed.set(key, `merges: ${reason}`);
      main.values.delete(key);
    }
    listable = listable.filter((t) => main.values.has(keyOf(t)));
    firstPages[kind] = result.values;
  }
  const merges = new Map();
  for (const target of listable) {
    const key = keyOf(target);
    const accepted = firstPages.accepted.get(key);
    const repositories = firstPages.repositories.get(key);
    merges.set(key, {
      accepted: accepted.accepted,
      walk: repositories.walk,
      next: { accepted: accepted.next, repositories: repositories.next }
    });
  }
  const pageRead = (read) => (data) => {
    try {
      return read(data);
    } catch (error) {
      if (error instanceof Malformed) throw new PageFailed(error.message);
      throw error;
    }
  };
  for (const target of targets) {
    const key = keyOf(target);
    const s = merges.get(key);
    const m = main.values.get(key);
    if (!s || !m) continue;
    if (stats.stopped) {
      if (s.next.accepted || s.next.repositories || s.walk.more.length > 0) unfinished(target);
      continue;
    }
    try {
      if (s.next.accepted) {
        const { complete } = await readMorePages({
          client,
          document: buildMergesPageQuery('accepted'),
          variables: { login: target.login },
          first: s.next.accepted,
          maxPages: MAX_MERGED_PAGES,
          read: pageRead((data) =>
            readAcceptedPage(data?.u0?.a, { login: m.login, window, into: s.accepted })
          )
        });
        if (!complete) m.cut |= CUT_ACCEPTED;
      }
      if (s.next.repositories) {
        const { complete } = await readMorePages({
          client,
          document: buildMergesPageQuery('repositories'),
          variables: { login: target.login },
          first: s.next.repositories,
          maxPages: MAX_REPOSITORY_PAGES,
          read: pageRead((data) =>
            readRepositoriesPage(data?.u0?.m, { login: m.login, window, walk: s.walk })
          )
        });
        if (!complete) m.cut |= CUT_MAINTAINED;
      }
      for (const repo of s.walk.more) {
        const [owner, name] = repo.name.split('/');
        const { complete } = await readMorePages({
          client,
          document: buildRepositoryMergesQuery(),
          variables: { owner, name },
          first: repo.cursor,
          maxPages: MAX_REPOSITORY_MERGE_PAGES,
          read: pageRead((data) =>
            readRepositoryMerges(data?.r?.pullRequests, {
              repo,
              login: m.login,
              window,
              into: s.walk.maintained
            })
          )
        });
        if (!complete) m.cut |= CUT_MAINTAINED;
      }
    } catch (error) {
      if (!(error instanceof PageFailed)) {
        stats.stopped = error.message;
        unfinished(target);
        continue;
      }
      main.values.delete(key);
      failed.set(key, `a further merges page: ${error.message}`);
      continue;
    }
    const problem = crossCheckMerges(m, s);
    if (problem) {
      stats.inconsistent += 1;
      main.values.delete(key);
      failed.set(key, `merges: ${problem}`);
    }
  }
  if (stats.inconsistent > 0) {
    log.warn(
      `::warning title=CONTRIBUTIONS::${stats.inconsistent} developer(s) not measured: their ` +
        'merge lists disagree with the contributions API. Rows keep their previous block.'
    );
  }

  // Integrity.
  const samples = [];
  for (const target of targets) {
    const m = main.values.get(keyOf(target));
    if (!m) continue;
    const { repos, cut } = integrityTargets(m);
    if (cut) m.cut |= CUT_INTEGRITY;
    for (const repo of repos)
      samples.push({ login: target.login, key: keyOf(target), repo, nodeId: m.node_id });
  }
  const measuredAtMs = Date.parse(measuredAt);
  const integrityStats = {
    rejected: 0,
    bisections: 0,
    retries: 0,
    notFound: 0,
    stopped: stats.stopped
  };
  const integrity = await runSlices(samples, {
    size: INTEGRITY_BATCH_SIZE,
    document: buildIntegrityQuery,
    variables: (part) => {
      const variables = { since: window.query.from };
      part.forEach((s, i) => {
        const [owner, name] = s.repo.split('/');
        variables[`o${i}`] = owner;
        variables[`n${i}`] = name;
        variables[`a${i}`] = s.nodeId;
      });
      return variables;
    },
    aliases: (i) => [`r${i}`],
    read: ([node], s) => readIntegrity(node, { repo: s.repo, measuredAtMs }),
    key: (s) => `${s.key} ${s.repo}`,
    client,
    // Its own tally: a sample that fails costs the developer nothing (CUT_INTEGRITY), and a stop
    // here leaves the measurements already taken whole.
    stats: integrityStats,
    label: 'commit dates',
    log
  });
  stats.rejected += integrityStats.rejected;
  stats.bisections += integrityStats.bisections;
  stats.retries += integrityStats.retries;

  // Assemble.
  const blocks = new Map();
  for (const target of targets) {
    const key = keyOf(target);
    if (ineligible.has(key)) continue;
    const m = main.values.get(key);
    const s = merges.get(key);
    if (!m || !s) {
      if (!failed.has(key)) failed.set(key, stats.stopped || 'not measured');
      continue;
    }
    const sampled = [];
    for (const sample of samples.filter((x) => x.key === key)) {
      const value = integrity.values.get(`${key} ${sample.repo}`);
      if (value) sampled.push(value);
      else m.cut |= CUT_INTEGRITY;
    }
    blocks.set(key, encodeMeasurement(assemble(m, s, sampled)));
    failed.delete(key);
  }

  const end = client.usage();
  stats.requests = end.requests - start.requests;
  stats.points = end.points - start.points;
  log.log(
    `Contributions measured: ${blocks.size} of ${targets.length} in full, ` +
      `${ineligible.size} short of the gate on their working days alone, ${failed.size} failed ` +
      `(${stats.inconsistent} on the merge cross-check), ${stats.degraded} on a shorter ` +
      `repository list; ${stats.requests} requests, ` +
      `${stats.points} points, ${stats.rejected} rejected, ${stats.bisections} bisections, ` +
      `${stats.retries} retries.`
  );
  return { blocks, ineligible, failed, stats };
}

/**
 * Active calendar days of each candidate over the window and a day either side: the pre-screen
 * the next model gates with, logged only for now. The calendar counts every public contribution
 * and, for those who share it, private work, so it is an upper bound on public working days.
 *
 * @returns {Promise<{days: Map<string, number>, failed: Map<string, string>, stats: object}>}
 */
export async function screenCalendars(candidates, { client, now = Date.now(), log = console }) {
  const window = measurementWindow(now);
  const targets = targetsOf(candidates);
  const stats = { rejected: 0, bisections: 0, retries: 0, notFound: 0, stopped: null };
  const from = `${window.from}T00:00:00Z`;
  const fromDate = new Date(Date.parse(from) - 24 * HOUR_MS).toISOString().slice(0, 10);
  const { values, failed } = await runSlices(targets, {
    size: CALENDAR_BATCH_SIZE,
    document: buildCalendarQuery,
    variables: (part) => ({
      from: `${fromDate}T00:00:00Z`,
      to: `${window.to}T23:59:59Z`,
      ...Object.fromEntries(part.map((t, i) => [`l${i}`, t.login]))
    }),
    aliases: (i) => [`u${i}`],
    read: ([node], target) => {
      if (target.githubId != null && node.databaseId !== target.githubId) {
        throw new Malformed(`${target.login} is account ${node.databaseId}`);
      }
      return calendarActiveDays(node.c?.contributionCalendar);
    },
    key: (t) => t.login.toLowerCase(),
    client,
    stats,
    label: 'calendar',
    log
  });
  return { days: values, failed, stats };
}
