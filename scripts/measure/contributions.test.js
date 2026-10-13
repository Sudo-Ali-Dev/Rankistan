import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BATCH_SIZE,
  FLAG_FORK,
  FLAG_OWNED,
  MAX_SINGLE_RETRIES,
  MAX_WAIT_MS,
  SHADOW_FIELD,
  attachShadow,
  buildQuery,
  calendarSeries,
  commitDayOffset,
  createShadowClient,
  decodeShadow,
  encodeShadow,
  measureShadowContributions,
  measurementWindows,
  medianGapSeconds,
  previousBlocks,
  readMeasurement,
  shadowContributionsStep,
  truncation
} from './contributions.js';
import { RATE_LIMIT, respond } from '../discovery/fake-search.js';
import { verifyPublished } from '../verify-published.js';
import { scoreDevelopers } from '../score.js';
import { scoreFromPublished, scoreModel } from '../../src/model/score.js';
import { SCORE_CONFIG } from '../../src/model/config.js';

const NOW = Date.parse('2026-10-14T09:30:00Z');
const WINDOWS = measurementWindows(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const quiet = { log() {}, warn() {} };

/** The date `offset` days into the scoring window. */
const scoringDate = (offset) =>
  new Date(Date.parse(`${WINDOWS.scoring.from}T00:00:00Z`) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);

/**
 * A user node as GitHub returns it for the shadow document. `commits` maps a repository to its
 * commits by scoring-window day; `prs` lists pull requests per repository.
 */
function userNode(
  login,
  {
    id = 1,
    commits = { [`${login}/app`]: { 0: 3, 4: 2 } },
    stars = {},
    forks = [],
    prs = {},
    issues = 0,
    reviews = 0,
    restricted = 0,
    commitRepositories,
    gapExtra = {}
  } = {}
) {
  const commitEntries = Object.entries(commits).map(([name, byDay]) => ({
    repository: {
      nameWithOwner: name,
      owner: { login: name.split('/')[0] },
      isFork: forks.includes(name),
      stargazerCount: stars[name] ?? 0
    },
    contributions: {
      totalCount: Object.values(byDay).reduce((a, b) => a + b, 0),
      nodes: Object.entries(byDay).map(([offset, commitCount]) => ({
        occurredAt: `${scoringDate(Number(offset))}T07:00:00Z`,
        commitCount
      }))
    }
  }));
  const prEntries = Object.entries(prs).map(([name, list]) => ({
    repository: { nameWithOwner: name, owner: { login: name.split('/')[0] }, isFork: false },
    contributions: { totalCount: list.length, nodes: list.map((pullRequest) => ({ pullRequest })) }
  }));
  const totalCommits = commitEntries.reduce((s, e) => s + e.contributions.totalCount, 0);
  const totalPrs = prEntries.reduce((s, e) => s + e.contributions.totalCount, 0);
  const days = [];
  for (let i = 0; i < 60; i += 1) {
    const date = new Date(Date.parse(`${WINDOWS.gap.from}T00:00:00Z`) + i * DAY_MS)
      .toISOString()
      .slice(0, 10);
    days.push({ date, contributionCount: i % 7 });
  }
  return {
    login,
    databaseId: id,
    gap: { contributionCalendar: { weeks: [{ contributionDays: days }] }, ...gapExtra },
    w30: {
      totalCommitContributions: totalCommits,
      totalPullRequestContributions: totalPrs,
      totalIssueContributions: issues,
      totalPullRequestReviewContributions: reviews,
      restrictedContributionsCount: restricted,
      totalRepositoriesWithContributedCommits: commitRepositories ?? commitEntries.length,
      totalRepositoriesWithContributedPullRequests: prEntries.length,
      commitContributionsByRepository: commitEntries,
      pullRequestContributionsByRepository: prEntries
    }
  };
}

const target = (login, githubId = 1) => ({ login, githubId });
const pr = (createdAt, merged = false, by = null) => ({
  createdAt,
  merged,
  mergedBy: by ? { login: by } : null
});

/** A fake GraphQL endpoint answering the shadow document from `nodes` (login -> node). */
function fakeShadow(nodes, { onRequest } = {}) {
  const calls = [];
  async function fetchImpl(_url, init) {
    const { variables } = JSON.parse(init.body);
    const logins = Object.keys(variables)
      .filter((key) => /^l\d+$/.test(key))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((key) => variables[key]);
    calls.push({ logins, variables });
    const override = onRequest?.({ logins, call: calls.length, variables });
    if (override) return override;
    const data = { rateLimit: RATE_LIMIT };
    const errors = [];
    logins.forEach((login, i) => {
      const node = nodes[login.toLowerCase()];
      data[`u${i}`] = node ?? null;
      if (!node) errors.push({ type: 'NOT_FOUND', path: [`u${i}`], message: 'Could not resolve' });
    });
    return respond(200, errors.length ? { data, errors } : { data });
  }
  return { fetchImpl, calls };
}

function shadowClient(fetchImpl, extra = {}) {
  const waits = [];
  const client = createShadowClient({
    token: 't',
    fetchImpl,
    sleep: async (ms) => waits.push(ms),
    minIntervalMs: 0,
    log: quiet,
    ...extra
  });
  return { client, waits };
}

const devs = (n, prefix = 'dev') =>
  Array.from({ length: n }, (_, i) => ({ username: `${prefix}${i}`, github_id: 1000 + i }));
const nodesFor = (rows) =>
  Object.fromEntries(
    rows.map((r) => [r.username.toLowerCase(), userNode(r.username, { id: r.github_id })])
  );

async function measure(rows, fetchImpl, options = {}) {
  const { client, waits } = shadowClient(fetchImpl, options.client);
  const lines = [];
  const log = { log: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const result = await measureShadowContributions(rows, { client, now: NOW, log, ...options.run });
  return { ...result, waits, lines };
}

describe('measurementWindows', () => {
  it('ends both windows at the UTC midnight that began the day, half-open', () => {
    expect(WINDOWS.gap).toEqual({ from: '2026-08-15', to: '2026-10-14' });
    expect(WINDOWS.scoring).toEqual({ from: '2026-09-14', to: '2026-10-14' });
    // Asked to the last second of the previous day: a `to` at midnight adds that day.
    expect(WINDOWS.variables).toEqual({
      gapFrom: '2026-08-15T00:00:00Z',
      from: '2026-09-14T00:00:00Z',
      to: '2026-10-13T23:59:59Z'
    });
  });

  it('gives every run on one UTC day the same windows, and the next day the next ones', () => {
    const first = measurementWindows(Date.parse('2026-10-14T00:00:00.000Z'));
    const last = measurementWindows(Date.parse('2026-10-14T23:59:59.999Z'));
    expect(first).toEqual(last);
    expect(measurementWindows(Date.parse('2026-10-15T00:00:00Z')).scoring.from).toBe('2026-09-15');
    expect(() => measurementWindows(undefined)).toThrow(TypeError);
  });
});

describe('buildQuery', () => {
  it('aliases each developer by position and passes logins and windows as variables', () => {
    const document = buildQuery(3);
    expect(document).toMatch(/\$l0: String!, \$l1: String!, \$l2: String!/);
    expect(document).toMatch(/u2: user\(login: \$l2\)/);
    expect(document).not.toMatch(/u3:/);
    expect(document).toMatch(/rateLimit \{ cost/);
  });

  it('reads every per-repository figure from the 30-day collection, not the 60-day one', () => {
    const document = buildQuery(1);
    const gap = document.slice(document.indexOf('gap:'), document.indexOf('w30:'));
    const w30 = document.slice(document.indexOf('w30:'));
    expect(gap).toMatch(/contributionsCollection\(from: \$gapFrom, to: \$to\)/);
    expect(gap).not.toMatch(/ByRepository|total/);
    expect(w30).toMatch(/contributionsCollection\(from: \$from, to: \$to\)/);
    expect(w30).toMatch(/commitContributionsByRepository/);
    expect(w30).toMatch(/pullRequestContributionsByRepository/);
    expect(w30).toMatch(/totalCommitContributions/);
  });
});

describe('calendarSeries', () => {
  const days = (dates) => ({
    weeks: [{ contributionDays: dates.map((date) => ({ date, contributionCount: 1 })) }]
  });
  const windowDates = (window) => {
    const out = [];
    for (let t = Date.parse(window.from); t < Date.parse(window.to); t += DAY_MS) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  };

  it('returns one count per day of the window, oldest first', () => {
    const series = calendarSeries(days(windowDates(WINDOWS.gap)), WINDOWS.gap);
    expect(series).toHaveLength(60);
  });

  it('rejects a calendar that covers any other set of days', () => {
    const dates = windowDates(WINDOWS.gap);
    expect(() => calendarSeries(days([...dates, '2026-10-14']), WINDOWS.gap)).toThrow(/61 days/);
    expect(() => calendarSeries(days(dates.slice(1)), WINDOWS.gap)).toThrow(/no 2026-08-15/);
    expect(() => calendarSeries(days([...dates, dates[3]]), WINDOWS.gap)).toThrow(/repeated/);
  });
});

describe('commitDayOffset', () => {
  it('reads the date a local midnight stands for, whatever the offset', () => {
    for (const time of ['T07:00:00Z', 'T08:00:00Z', 'T00:00:00Z']) {
      expect(commitDayOffset(`2026-09-20${time}`, WINDOWS.scoring)).toBe(6);
    }
    // Midnight in Pakistan is 19:00 UTC the day before.
    expect(commitDayOffset('2026-09-19T19:00:00Z', WINDOWS.scoring)).toBe(6);
  });

  it('rejects a commit day outside the window', () => {
    expect(() => commitDayOffset('2026-10-14T07:00:00Z', WINDOWS.scoring)).toThrow(/outside/);
    expect(() => commitDayOffset('2026-09-13T07:00:00Z', WINDOWS.scoring)).toThrow(/outside/);
  });
});

describe('readMeasurement', () => {
  const read = (node, t = target(node.login, node.databaseId)) =>
    readMeasurement(node, { target: t, windows: WINDOWS, measuredAt: '2026-10-14T09:30:00Z' });

  it('takes the per-repository figures beside the totals they came with', () => {
    const node = userNode('ana', {
      commits: { 'ana/site': { 0: 4, 29: 1 }, 'org/lib': { 3: 2 } },
      stars: { 'org/lib': 120 },
      forks: ['org/lib'],
      // Repository lists inside the 60-day collection are never read.
      gapExtra: { commitContributionsByRepository: [{ repository: { nameWithOwner: 'x/y' } }] }
    });
    const m = read(node);
    expect(m.totals_30d.commits).toBe(7);
    expect(m.commit_repositories_30d).toEqual([
      {
        name: 'ana/site',
        flags: FLAG_OWNED,
        stars: 0,
        commits: 5,
        days: [
          { day: 0, commits: 4 },
          { day: 29, commits: 1 }
        ]
      },
      { name: 'org/lib', flags: FLAG_FORK, stars: 120, commits: 2, days: [{ day: 3, commits: 2 }] }
    ]);
    expect(m.gap_window).toEqual(WINDOWS.gap);
    expect(m.scoring_window).toEqual(WINDOWS.scoring);
    expect(m.calendar_60d).toHaveLength(60);
  });

  it('rejects commit days that do not add up to the repository total', () => {
    const node = userNode('ana');
    node.w30.commitContributionsByRepository[0].contributions.totalCount += 1;
    expect(() => read(node)).toThrow(/commits by day/);
  });

  it('rejects an account that is not the row it was asked for', () => {
    expect(() => read(userNode('ana', { id: 7 }), target('ana', 8))).toThrow(/account 7/);
  });

  it('counts merges by someone else, not self-merges or merges by a deleted account', () => {
    const node = userNode('ana', {
      prs: {
        'org/lib': [
          pr('2026-09-15T10:00:00Z', true, 'maintainer'),
          pr('2026-09-15T10:03:00Z', true, 'ANA'),
          pr('2026-09-15T10:06:00Z', true, null),
          pr('2026-09-15T10:09:00Z', false)
        ],
        'ana/site': [pr('2026-09-15T10:12:00Z', true, 'ana')]
      }
    });
    const m = read(node);
    expect(m.pull_request_repositories_30d).toEqual([
      { name: 'org/lib', flags: 0, opened: 4, read: 4, merged: 3, merged_by_other: 1 },
      { name: 'ana/site', flags: FLAG_OWNED, opened: 1, read: 1, merged: 1, merged_by_other: 0 }
    ]);
    expect(m.pull_request_gap_30d).toEqual({ median_seconds: 180, from_pull_requests: 5 });
  });

  it('publishes no timing signal under five pull requests', () => {
    const node = userNode('ana', { prs: { 'org/lib': [pr('2026-09-15T10:00:00Z')] } });
    expect(read(node).pull_request_gap_30d).toBeNull();
  });
});

describe('medianGapSeconds', () => {
  it('sorts the instants first, and takes the middle gap', () => {
    const t = (s) => Date.parse('2026-09-20T00:00:00Z') + s * 1000;
    expect(medianGapSeconds([t(300), t(0), t(61), t(122)])).toBe(61);
    expect(medianGapSeconds([t(0), t(10), t(30)])).toBe(15);
    expect(medianGapSeconds([t(0)])).toBeNull();
  });
});

describe('the stored block', () => {
  const m = readMeasurement(
    userNode('ana', {
      commits: { 'ana/site': { 0: 4, 29: 1 }, 'org/lib': { 3: 2 } },
      prs: {
        'org/lib': Array.from({ length: 6 }, (_, i) => pr(`2026-09-20T0${i}:00:00Z`, true, 'x'))
      },
      issues: 2,
      reviews: 3,
      restricted: 40
    }),
    { target: target('ana'), windows: WINDOWS, measuredAt: '2026-10-14T09:30:00Z' }
  );

  it('round-trips through its compact form and through JSON', () => {
    const block = JSON.parse(JSON.stringify(encodeShadow(m)));
    expect(decodeShadow(block)).toEqual(m);
  });

  it('is compact: positional totals and day/commit pairs', () => {
    const block = encodeShadow(m);
    expect(block.t30).toEqual([7, 6, 2, 3, 40, 2, 1]);
    expect(block.cr30[0]).toEqual(['ana/site', FLAG_OWNED, 0, [0, 4, 29, 1]]);
    expect(block.w30).toEqual(['2026-09-14', '2026-10-14']);
    expect(block.cal60).toHaveLength(60);
  });

  it('decodes anything else to null rather than guessing', () => {
    expect(decodeShadow(null)).toBeNull();
    expect(decodeShadow({ ...encodeShadow(m), v: 99 })).toBeNull();
    expect(decodeShadow({ v: 1 })).toBeNull();
  });

  it('reports a cut repository list as cut, without extrapolating it', () => {
    const cut = readMeasurement(userNode('ana', { commitRepositories: 3 }), {
      target: target('ana'),
      windows: WINDOWS,
      measuredAt: 'x'
    });
    expect(truncation(cut).commit_repositories).toBe(true);
    expect(truncation(m).commit_repositories).toBe(false);
  });
});

describe('measureShadowContributions', () => {
  it(`batches ${BATCH_SIZE} developers per request, sequentially`, async () => {
    const rows = devs(32);
    const fake = fakeShadow(nodesFor(rows));
    const { blocks, failed, stats } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.map((c) => c.logins.length)).toEqual([15, 15, 2]);
    expect(blocks.size).toBe(32);
    expect(failed.size).toBe(0);
    expect(stats).toMatchObject({ requests: 3, points: 3, rejected: 0, bisections: 0 });
  });

  it('prints one aggregate line per batch, for comparing a production run', async () => {
    const rows = devs(17);
    const { lines } = await measure(rows, fakeShadow(nodesFor(rows)).fetchImpl);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'Shadow contributions batch 1/2: 15 developers, 15 measured, 0 failed, 1 points, ' +
        '1 requests, 75 commits_30d, 0 restricted_30d.'
    );
  });

  it('discards a partial response whole, even the aliases that look fine, and bisects', async () => {
    const rows = devs(6);
    const good = nodesFor(rows);
    const fake = fakeShadow(good, {
      onRequest: ({ logins, call }) => {
        if (call !== 1) return null;
        // Plausible-looking data for everyone, plus one resource-limit error.
        const data = { rateLimit: RATE_LIMIT };
        logins.forEach((login, i) => {
          data[`u${i}`] = userNode(login, {
            id: 1000 + i,
            commits: { [`${login}/app`]: { 0: 999 } }
          });
        });
        const errors = [
          {
            type: 'RESOURCE_LIMITS_EXCEEDED',
            path: ['u5', 'w30', 'commitContributionsByRepository']
          }
        ];
        return respond(200, { data, errors });
      }
    });
    const { blocks, stats } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.map((c) => c.logins.length)).toEqual([6, 3, 3]);
    expect(stats).toMatchObject({ rejected: 1, bisections: 1 });
    // Nothing from the discarded response survived.
    expect(decodeShadow(blocks.get('dev0')).totals_30d.commits).toBe(5);
  });

  it('keeps the rest of a response when NOT_FOUND names exactly one user', async () => {
    const rows = devs(4);
    const nodes = nodesFor(rows);
    delete nodes.dev2;
    const fake = fakeShadow(nodes);
    const { blocks, failed, stats } = await measure(rows, fake.fetchImpl);
    expect(fake.calls).toHaveLength(1);
    expect([...blocks.keys()]).toEqual(['dev0', 'dev1', 'dev3']);
    expect(failed.get('dev2')).toBe('not found');
    expect(stats.notFound).toBe(1);
  });

  it('treats NOT_FOUND anywhere below a user as a reason to discard', async () => {
    const rows = devs(2);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ call }) =>
        call === 1
          ? respond(200, {
              data: { rateLimit: RATE_LIMIT, u0: null, u1: null },
              errors: [
                { type: 'NOT_FOUND', path: ['u0', 'w30', 'commitContributionsByRepository'] }
              ]
            })
          : null
    });
    const { blocks, stats } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.map((c) => c.logins.length)).toEqual([2, 1, 1]);
    expect(blocks.size).toBe(2);
    expect(stats.bisections).toBe(1);
  });

  it('splits an HTTP 200 whose aliases are all null: an over-large query, not absent users', async () => {
    const rows = devs(4);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ logins }) =>
        logins.length > 2 ? respond(200, { data: { rateLimit: RATE_LIMIT } }) : null
    });
    const { blocks } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.map((c) => c.logins.length)).toEqual([4, 2, 2]);
    expect(blocks.size).toBe(4);
  });

  it('reads a 502 as text, splits the batch, and retries a single developer', async () => {
    const rows = devs(2);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ call }) =>
        call <= 2 ? respond(502, '<html><body>502 Bad Gateway</body></html>') : null
    });
    const { blocks, failed, stats, waits } = await measure(rows, fake.fetchImpl);
    // [both] 502 -> [dev0] 502 -> [dev0] retried -> [dev1]
    expect(fake.calls.map((c) => c.logins)).toEqual([
      ['dev0', 'dev1'],
      ['dev0'],
      ['dev0'],
      ['dev1']
    ]);
    expect(blocks.size).toBe(2);
    expect(failed.size).toBe(0);
    expect(stats.retries).toBe(1);
    expect(waits).toContain(5000);
  });

  it('gives up on one developer after its retries, and measures the rest', async () => {
    const rows = devs(3);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ logins }) => (logins.includes('dev1') ? respond(502, '<html>502</html>') : null)
    });
    const { blocks, failed } = await measure(rows, fake.fetchImpl);
    expect([...blocks.keys()].sort()).toEqual(['dev0', 'dev2']);
    expect(failed.get('dev1')).toBe('HTTP 502');
    expect(fake.calls.filter((c) => c.logins.join() === 'dev1')).toHaveLength(
      MAX_SINGLE_RETRIES + 1
    );
  });

  it('backs off on a secondary limit at the same size, never bisecting', async () => {
    const rows = devs(3);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ call }) =>
        call === 1
          ? respond(403, '{"message":"You have exceeded a secondary rate limit."}', {
              'retry-after': '30'
            })
          : null
    });
    const { blocks, stats, waits } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.map((c) => c.logins.length)).toEqual([3, 3]);
    expect(waits).toContain(31000);
    expect(stats).toMatchObject({ rejected: 0, bisections: 0 });
    expect(blocks.size).toBe(3);
  });

  it('stops, without throwing, when a wait would outlast MAX_WAIT_MS', async () => {
    const rows = devs(20);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: ({ call }) =>
        call === 2 ? respond(429, '{}', { 'retry-after': String(MAX_WAIT_MS / 1000 + 60) }) : null
    });
    const { blocks, failed, stats, lines } = await measure(rows, fake.fetchImpl);
    expect(blocks.size).toBe(15);
    expect(failed.size).toBe(5);
    expect(stats.stopped).toMatch(/longer than this measurement waits/);
    expect(lines.some((line) => line.startsWith('::warning title=SHADOW_CONTRIBUTIONS::'))).toBe(
      true
    );
  });

  it('is fail-soft on a rejected credential: every developer listed as failed', async () => {
    const rows = devs(4);
    const fake = fakeShadow(nodesFor(rows), {
      onRequest: () => respond(401, '{"message":"Bad credentials"}')
    });
    const { blocks, failed } = await measure(rows, fake.fetchImpl);
    expect(blocks.size).toBe(0);
    expect(failed.size).toBe(4);
    expect(fake.calls).toHaveLength(1);
  });

  it('measures each login once', async () => {
    const rows = [...devs(2), { username: 'DEV0', github_id: 1000 }];
    const fake = fakeShadow(nodesFor(rows));
    await measure(rows, fake.fetchImpl);
    expect(fake.calls[0].logins).toEqual(['dev0', 'dev1']);
  });
});

describe('attachShadow', () => {
  const block = (at) => ({ v: 1, at });
  const previous = previousBlocks([
    { username: 'ana', github_id: 1, [SHADOW_FIELD]: block('2026-10-13T09:00:00Z') },
    { username: 'old-name', github_id: 2, [SHADOW_FIELD]: block('2026-10-12T09:00:00Z') },
    { username: 'taken', github_id: 3, [SHADOW_FIELD]: block('2026-10-11T09:00:00Z') }
  ]);

  it("uses this run's block, or else keeps the previous one with its own date", () => {
    const fresh = block('2026-10-14T09:30:00Z');
    const { developers, ...counts } = attachShadow(
      [
        { username: 'ana', github_id: 1 },
        { username: 'new-name', github_id: 2 },
        { username: 'bo', github_id: 4 }
      ],
      { blocks: new Map([['bo', fresh]]), previous }
    );
    expect(developers[0][SHADOW_FIELD]).toEqual(block('2026-10-13T09:00:00Z'));
    // Matched by account id across a rename.
    expect(developers[1][SHADOW_FIELD]).toEqual(block('2026-10-12T09:00:00Z'));
    expect(developers[2][SHADOW_FIELD]).toBe(fresh);
    expect(counts).toEqual({ fresh: 1, kept: 2, none: 0 });
  });

  it('never hands one account the block of another that held its login', () => {
    const { developers, none } = attachShadow([{ username: 'taken', github_id: 9 }], {
      blocks: new Map(),
      previous
    });
    expect(Object.hasOwn(developers[0], SHADOW_FIELD)).toBe(false);
    expect(none).toBe(1);
  });
});

describe('shadowContributionsStep', () => {
  const lines = [];
  const log = { log: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const earlier = { v: 1, at: '2026-10-13T09:00:00Z' };

  it('attaches fresh blocks, keeps the previous one for a failure, and summarises', async () => {
    const rows = devs(3);
    const nodes = nodesFor(rows);
    delete nodes.dev1;
    const { client } = shadowClient(fakeShadow(nodes).fetchImpl);
    lines.length = 0;
    const { developers, fresh, kept } = await shadowContributionsStep(rows, {
      existing: [{ username: 'dev1', github_id: 1001, [SHADOW_FIELD]: earlier }],
      client,
      now: NOW,
      log
    });
    expect(developers[1][SHADOW_FIELD]).toBe(earlier);
    expect(decodeShadow(developers[0][SHADOW_FIELD]).measured_at).toBe('2026-10-14T09:30:00Z');
    expect({ fresh, kept }).toEqual({ fresh: 2, kept: 1 });
    expect(lines).toContain(
      'Shadow contributions: 2 of 3 measured, 1 failed (dev1: not found); 1 requests, ' +
        '1 points, 0 rejected, 0 bisections, 0 retries.'
    );
  });

  it('never throws, whatever the measurement does', async () => {
    const client = {
      usage: () => {
        throw new Error('boom');
      }
    };
    const rows = [{ username: 'dev0', github_id: 1000 }];
    const { developers } = await shadowContributionsStep(rows, {
      existing: [{ username: 'dev0', github_id: 1000, [SHADOW_FIELD]: earlier }],
      client,
      now: NOW,
      log
    });
    expect(developers[0][SHADOW_FIELD]).toBe(earlier);
    const none = await shadowContributionsStep(rows, { client: null, now: NOW, log });
    expect(Object.hasOwn(none.developers[0], SHADOW_FIELD)).toBe(false);
  });
});

describe('the score does not see the block', () => {
  const SAMPLE = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', 'data.sample.json'), 'utf8')
  );
  const block = encodeShadow(
    readMeasurement(
      userNode('ana', { commits: { 'ana/app': { 0: 1_031_007 } }, restricted: 500 }),
      { target: target('ana'), windows: WINDOWS, measuredAt: '2026-10-14T09:30:00Z' }
    )
  );
  const withBlock = (row) => ({
    ...row,
    [SHADOW_FIELD]: block,
    events_window: { fetched: 200, truncated: true, days: 2.2 }
  });

  it('recomputes every published score identically with and without one', () => {
    const stamped = SAMPLE.leaderboard.filter((row) => typeof row.model_version === 'string');
    expect(stamped.length).toBeGreaterThan(0);
    for (const row of stamped) {
      expect(scoreFromPublished(withBlock(row))).toBe(scoreFromPublished(row));
    }
    const plain = verifyPublished(SAMPLE);
    const measured = verifyPublished({ ...SAMPLE, leaderboard: SAMPLE.leaderboard.map(withBlock) });
    expect(measured).toEqual(plain);
    expect(measured.errors).toEqual([]);
  });

  it('scores a developer identically with and without one', () => {
    const dev = {
      username: 'ana',
      total_stars: 40,
      followers: 12,
      public_repos: 9,
      created_at: '2020-01-01T00:00:00Z',
      raw_events_60d: [{ type: 'PushEvent', created_at: '2026-10-10T10:00:00Z' }]
    };
    const options = { config: SCORE_CONFIG, now: NOW };
    expect(scoreModel(withBlock(dev), options)).toEqual(scoreModel(dev, options));
    const [plain] = scoreDevelopers([dev], { now: NOW });
    const [measured] = scoreDevelopers([withBlock(dev)], { now: NOW });
    expect(measured.score_exact).toBe(plain.score_exact);
    expect(measured.activity_score).toBe(plain.activity_score);
  });
});
