import { describe, it, expect } from 'vitest';
import {
  BATCH_SIZE,
  DEGRADED_MAX_REPOSITORIES,
  INTEGRITY_MAX_REPOSITORIES,
  MAX_PAGES,
  MAX_SINGLE_RETRIES,
  MAX_WAIT_MS,
  SEARCH_BATCH_SIZE,
  SHADOW_FIELD,
  attachShadow,
  buildQuery,
  buildSearchQuery,
  calendarActiveDays,
  createShadowClient,
  decodeMeasurement,
  integrityTargets,
  judgeAliased,
  measureShadowContributions,
  measurementWindow,
  previousBlocks,
  readIntegrity,
  readMain,
  readSearchPage,
  screenCalendars,
  searchQueries,
  shadowContributionsStep
} from './contributions.js';
import {
  CUT_DEGRADED,
  CUT_INTEGRITY,
  CUT_PULL_REQUESTS,
  FLAG_OWNED,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN,
  windowDate
} from '../../src/model/measurement.js';
import { RATE_LIMIT, respond } from '../discovery/fake-search.js';
import { verifyPublished } from '../verify-published.js';
import { scoreDevelopers } from '../score.js';
import { scoreFromPublished, scoreModel } from '../../src/model/score.js';
import { SCORE_CONFIG } from '../../src/model/config.js';
import fs from 'node:fs';
import path from 'node:path';

const NOW = Date.parse('2026-10-14T09:30:00Z');
const W = measurementWindow(NOW);
const quiet = { log() {}, warn() {} };

/** The instant of 10:00 Pakistan time on the window's day `offset`. */
const at = (offset) => `${windowDate(W, offset)}T05:00:00Z`;
const repo = (name, { fork = false, stars = 0, org = false } = {}) => ({
  nameWithOwner: name,
  isFork: fork,
  stargazerCount: stars,
  owner: { __typename: org ? 'Organization' : 'User', login: name.split('/')[0] }
});
const page = (nodes, next = null) => ({
  totalCount: nodes.length + (next ? 1 : 0),
  pageInfo: { hasNextPage: Boolean(next), endCursor: next },
  nodes
});

/**
 * One developer as GitHub would answer every document of the measurement. `commits` maps a
 * repository to commits by window day (day -1 is the date before the window, which the query
 * range also returns).
 */
function person(login, options = {}) {
  const {
    id = 1,
    commits = { [`${login}/app`]: { 0: 3, 4: 2 } },
    stars = {},
    prs = [],
    issues = [],
    reviews = [],
    accepted = [],
    maintained = [],
    future = [],
    history = {},
    restricted = 0,
    commitRepositories,
    prPages = [],
    acceptedPages = []
  } = options;
  const commitEntries = Object.entries(commits).map(([name, byDay]) => ({
    repository: repo(name, { stars: stars[name] ?? 0 }),
    contributions: {
      totalCount: Object.values(byDay).reduce((a, b) => a + b, 0),
      nodes: Object.entries(byDay).map(([offset, commitCount]) => ({
        occurredAt: `${windowDate(W, Number(offset))}T07:00:00Z`,
        commitCount
      }))
    }
  }));
  return {
    main: {
      login,
      databaseId: id,
      id: `U_${login}`,
      c: {
        restrictedContributionsCount: restricted,
        totalRepositoriesWithContributedCommits: commitRepositories ?? commitEntries.length,
        commitContributionsByRepository: commitEntries,
        pullRequestContributions: page(prs, prPages.length ? 'p1' : null),
        issueContributions: page(issues),
        pullRequestReviewContributions: page(reviews)
      },
      f: {
        commitContributionsByRepository: future.map((name) => ({
          repository: { nameWithOwner: name }
        }))
      }
    },
    prPages,
    accepted: {
      issueCount: accepted.length,
      pageInfo: { hasNextPage: acceptedPages.length > 0, endCursor: 'a1' },
      nodes: accepted
    },
    acceptedPages,
    maintained: {
      issueCount: maintained.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: maintained
    },
    history
  };
}

const prNode = (offset, name, { merged = false, state = 'OPEN', number = 1 } = {}) => ({
  occurredAt: at(offset),
  pullRequest: { number, state, merged, repository: repo(name) }
});
const reviewNode = (offset, name, author, number = 1) => ({
  occurredAt: at(offset),
  pullRequest: {
    number,
    author: author
      ? { __typename: 'User', login: author, createdAt: '2015-01-01T00:00:00Z' }
      : null,
    repository: repo(name, { stars: 10 })
  }
});
const mergedNode = (
  offset,
  name,
  merger,
  { number = 1, additions = 10, deletions = 2, files = 2, stars = 100 } = {}
) => ({
  number,
  mergedAt: at(offset),
  additions,
  deletions,
  changedFiles: files,
  mergedBy: merger
    ? { __typename: 'User', login: merger, createdAt: '2014-05-05T00:00:00Z' }
    : null,
  author: { __typename: 'User', login: merger || 'someone', createdAt: '2014-05-05T00:00:00Z' },
  repository: {
    ...repo(name, { stars }),
    owner: {
      __typename: 'Organization',
      login: name.split('/')[0],
      createdAt: '2016-01-01T00:00:00Z'
    }
  }
});

/** A fake GraphQL endpoint answering every document of the measurement from `people`. */
function fakeGitHub(people, { onRequest } = {}) {
  const calls = [];
  const byLogin = (login) => people[String(login).toLowerCase()];
  async function fetchImpl(_url, init) {
    const { query, variables } = JSON.parse(init.body);
    const kind = query.includes('fragment Measure')
      ? 'main'
      : query.includes('contributionCalendar')
        ? 'calendar'
        : query.includes('history(')
          ? 'integrity'
          : query.includes('$after') && query.includes('user(login: $login)')
            ? 'page'
            : query.includes('$after')
              ? 'search-page'
              : 'search';
    const call = { kind, variables, query };
    calls.push(call);
    const override = onRequest?.({ ...call, n: calls.length });
    if (override) return override;
    const data = { rateLimit: RATE_LIMIT };
    const errors = [];
    if (kind === 'main' || kind === 'calendar') {
      Object.keys(variables)
        .filter((k) => /^l\d+$/.test(k))
        .forEach((k) => {
          const alias = `u${k.slice(1)}`;
          const p = byLogin(variables[k]);
          if (!p) {
            data[alias] = null;
            errors.push({ type: 'NOT_FOUND', path: [alias] });
          } else if (kind === 'main') {
            data[alias] = p.main;
          } else {
            const days = (p.calendar || [1, 0, 2]).map((n, i) => ({
              date: `d${i}`,
              contributionCount: n
            }));
            data[alias] = {
              login: p.main.login,
              databaseId: p.main.databaseId,
              c: { contributionCalendar: { weeks: [{ contributionDays: days }] } }
            };
          }
        });
    } else if (kind === 'page') {
      const p = byLogin(variables.login);
      const next = p.prPages.shift();
      data.u0 = {
        login: p.main.login,
        c: {
          pullRequestContributions: page(
            next || [],
            p.prPages.length ? `p${p.prPages.length}` : null
          )
        }
      };
    } else if (kind === 'search') {
      Object.keys(variables).forEach((k) => {
        const login = variables[k]
          .match(/author:(\S+)|user:(\S+)/)
          .slice(1)
          .find(Boolean);
        const p = byLogin(login);
        data[k.slice(1)] = k.startsWith('qa') ? p.accepted : p.maintained;
      });
    } else if (kind === 'search-page') {
      const login = variables.q.match(/author:(\S+)/)[1];
      const p = byLogin(login);
      data.s = {
        issueCount: 0,
        pageInfo: { hasNextPage: p.acceptedPages.length > 1, endCursor: 'a2' },
        nodes: p.acceptedPages.shift() || []
      };
    } else {
      Object.keys(variables)
        .filter((k) => /^o\d+$/.test(k))
        .forEach((k) => {
          const i = k.slice(1);
          const name = `${variables[`o${i}`]}/${variables[`n${i}`]}`;
          const owner = Object.values(people).find((p) => p.main.id === variables[`a${i}`]);
          const nodes = owner?.history[name] || [];
          data[`r${i}`] = { defaultBranchRef: { target: { history: { nodes } } } };
        });
    }
    return respond(200, errors.length ? { data, errors } : { data });
  }
  return { fetchImpl, calls };
}

function client(fetchImpl, extra = {}) {
  const waits = [];
  return {
    waits,
    client: createShadowClient({
      token: 't',
      fetchImpl,
      sleep: async (ms) => waits.push(ms),
      minIntervalMs: 0,
      log: quiet,
      ...extra
    })
  };
}

const devs = (n, prefix = 'dev') =>
  Array.from({ length: n }, (_, i) => ({ username: `${prefix}${i}`, github_id: 1000 + i }));
const peopleFor = (rows, options = {}) =>
  Object.fromEntries(
    rows.map((r) => [r.username.toLowerCase(), person(r.username, { id: r.github_id, ...options })])
  );

async function measure(rows, fetchImpl, options = {}) {
  const { client: c, waits } = client(fetchImpl, options.client);
  const lines = [];
  const log = { log: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const result = await measureShadowContributions(rows, {
    client: c,
    now: NOW,
    log,
    ...options.run
  });
  return {
    ...result,
    waits,
    lines,
    decoded: (login) => decodeMeasurement(result.blocks.get(login))
  };
}

describe('documents', () => {
  it('aliases each developer and passes logins and ranges as variables', () => {
    const query = buildQuery(2);
    expect(query).toContain('u0: user(login: $l0) { ...Measure }');
    expect(query).toContain('u1: user(login: $l1) { ...Measure }');
    expect(query).toContain('commitContributionsByRepository(maxRepositories: 100)');
    expect(query).toContain('pullRequestReviewContributions(first: 100)');
    expect(query).toContain('author { __typename login ... on User { createdAt } }');
    expect(query).not.toContain('contributionCalendar');
    expect(buildQuery(1, { maxRepositories: DEGRADED_MAX_REPOSITORIES })).toContain(
      'maxRepositories: 25'
    );
    expect(() => buildQuery(0)).toThrow(RangeError);
  });

  it("searches merges by the instant they happened, excluding the developer's own repositories", () => {
    expect(searchQueries('ana', W)).toEqual({
      accepted:
        'is:pr is:merged author:ana -user:ana merged:2026-09-13T19:00:00+00:00..2026-10-13T18:59:59+00:00',
      maintained:
        'is:pr is:merged user:ana -author:ana merged:2026-09-13T19:00:00+00:00..2026-10-13T18:59:59+00:00'
    });
    const query = buildSearchQuery(2);
    expect(query).toContain('a1: search(type: ISSUE, query: $qa1');
    expect(query).toContain('mergedBy { __typename login ... on User { createdAt } }');
  });
});

describe('readMain', () => {
  const read = (node, target = { login: 'ana', githubId: 7 }) =>
    readMain(node, { target, window: W });

  it('keeps commit days in the window and drops the day before it', () => {
    const m = read(person('ana', { id: 7, commits: { 'ana/app': { '-1': 4, 0: 3, 29: 1 } } }).main);
    expect(m.commits).toEqual([
      {
        repo: 'ana/app',
        flags: FLAG_OWNED,
        stars: 0,
        days: [
          { day: 0, commits: 3 },
          { day: 29, commits: 1 }
        ]
      }
    ]);
  });

  it('rejects commit days that do not add up to the repository total', () => {
    const node = person('ana', { id: 7 }).main;
    node.c.commitContributionsByRepository[0].contributions.totalCount = 99;
    expect(() => read(node)).toThrow(/commits by day/);
  });

  it('rejects an account that is not the row it was asked for', () => {
    expect(() => read(person('ana', { id: 8 }).main)).toThrow(/is account 8/);
    expect(() => read(person('bob', { id: 7 }).main)).toThrow(/login/);
  });

  it('reads pull requests, issues and reviews by the Pakistan date of their instant', () => {
    const m = read(
      person('ana', {
        id: 7,
        prs: [
          prNode(2, 'acme/lib', { merged: true, state: 'MERGED', number: 5 }),
          prNode(3, 'acme/lib', { state: 'CLOSED', number: 6 }),
          prNode(4, 'acme/lib', { number: 7 }),
          { ...prNode(0, 'acme/lib', { number: 8 }), occurredAt: '2026-09-13T18:00:00Z' }
        ],
        issues: [{ occurredAt: at(5), issue: { number: 2, repository: repo('bob/x') } }],
        reviews: [reviewNode(6, 'ana/app', 'ana', 3), reviewNode(6, 'ana/app', 'carl', 4)]
      }).main
    );
    expect([...m.lists.pull_requests.values()][0].items).toEqual([
      { day: 2, number: 5, outcome: OUTCOME_MERGED },
      { day: 3, number: 6, outcome: OUTCOME_CLOSED },
      { day: 4, number: 7, outcome: OUTCOME_OPEN }
    ]);
    expect([...m.lists.issues.values()][0].items).toEqual([{ day: 5, number: 2 }]);
    const reviews = [...m.lists.reviews.values()][0];
    expect(reviews.stars).toBe(10);
    // The author is recorded, so a review of one's own pull request can be told apart.
    expect(reviews.items.map((i) => i.author.login)).toEqual(['ana', 'carl']);
  });

  it('marks a cut repository list and lists future-dated repositories', () => {
    const m = read(person('ana', { id: 7, commitRepositories: 3, future: ['ana/paint'] }).main);
    expect(m.cut).toBeGreaterThan(0);
    expect(m.future_repos).toEqual(['ana/paint']);
  });
});

describe('readSearchPage', () => {
  it('keeps merges into repositories the developer does not own, with merger and owner', () => {
    const into = new Map();
    readSearchPage(
      'accepted',
      {
        issueCount: 3,
        pageInfo: { hasNextPage: false },
        nodes: [
          mergedNode(3, 'stdlib-js/stdlib', 'kgryte'),
          mergedNode(4, 'ana/own', 'kgryte'),
          mergedNode(5, 'x/y', null),
          {}
        ]
      },
      { login: 'ana', window: W, into }
    );
    const [stdlib, xy] = [...into.values()];
    expect(stdlib).toMatchObject({
      repo: 'stdlib-js/stdlib',
      stars: 100,
      owner: { login: 'stdlib-js', kind: 'O', created: '2016-01-01' }
    });
    expect(stdlib.items).toEqual([
      {
        day: 3,
        number: 1,
        merger: { login: 'kgryte', kind: 'U', created: '2014-05-05' },
        lines: 12,
        files: 2
      }
    ]);
    expect(xy.items[0].merger).toBeNull();
    expect([...into.keys()]).not.toContain('ana/own');
  });

  it('drops merges outside the window', () => {
    const into = new Map();
    const node = { ...mergedNode(0, 'a/b', 'k'), mergedAt: '2026-09-13T18:00:00Z' };
    readSearchPage(
      'accepted',
      { issueCount: 1, pageInfo: {}, nodes: [node] },
      { login: 'ana', window: W, into }
    );
    expect(into.size).toBe(0);
  });
});

describe('readIntegrity', () => {
  const measuredAtMs = NOW;
  const commit = (authored, committed, committer = 'Ana') => ({
    authoredDate: authored,
    committedDate: committed,
    committer: { name: committer, user: null }
  });

  it('records how far author dates run ahead and how far any date runs past the measurement', () => {
    const r = readIntegrity(
      {
        defaultBranchRef: {
          target: {
            history: {
              nodes: [
                commit('2026-10-14T13:00:07Z', '2026-10-14T01:01:18Z', 'www-data'),
                commit('2026-10-13T08:00:00Z', '2026-10-13T08:00:00Z')
              ]
            }
          }
        }
      },
      { repo: 'z/paint', measuredAtMs }
    );
    expect(r).toEqual({
      repo: 'z/paint',
      sampled: 2,
      bot: 0,
      max_lead_hours: 12,
      max_ahead_hours: 3.5
    });
  });

  it("counts commits a bot committed in the developer's name", () => {
    const r = readIntegrity(
      {
        defaultBranchRef: {
          target: {
            history: {
              nodes: [commit('2026-10-13T07:00:00Z', '2026-10-13T07:00:00Z', 'github-actions[bot]')]
            }
          }
        }
      },
      { repo: 'h/x', measuredAtMs }
    );
    expect(r.bot).toBe(1);
  });

  it('reports an empty repository as not sampled', () => {
    expect(readIntegrity({ defaultBranchRef: null }, { repo: 'a/b', measuredAtMs })).toEqual({
      repo: 'a/b',
      sampled: 0,
      bot: 0,
      max_lead_hours: null,
      max_ahead_hours: null
    });
  });

  it('samples the repositories with commits on enough days, most days first', () => {
    const commits = Array.from({ length: INTEGRITY_MAX_REPOSITORIES + 2 }, (_, i) => ({
      repo: `ana/r${String(i).padStart(2, '0')}`,
      flags: FLAG_OWNED,
      days: Array.from({ length: 3 + (i % 5) }, (__, d) => ({ day: d, commits: 1 }))
    }));
    commits.push({ repo: 'ana/thin', flags: FLAG_OWNED, days: [{ day: 1, commits: 1 }] });
    const t = integrityTargets({ commits });
    expect(t.repos).toHaveLength(INTEGRITY_MAX_REPOSITORIES);
    expect(t.repos).not.toContain('ana/thin');
    expect(t.cut).toBe(true);
  });
});

describe('judgeAliased', () => {
  const slice = [{ login: 'a' }, { login: 'b' }];
  const read = ([n]) => n.v;
  const aliases = (i) => [`u${i}`];

  it('keeps the rest of a response when NOT_FOUND names exactly one alias', () => {
    const v = judgeAliased(
      {
        kind: 'partial',
        data: { u0: null, u1: { v: 2 } },
        errors: [{ type: 'NOT_FOUND', path: ['u0'] }]
      },
      slice,
      { aliases, read }
    );
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([slice[0]]);
    expect(v.values).toEqual([{ item: slice[1], value: 2 }]);
  });

  it('discards a response whole for any other error, or for an alias null with no error', () => {
    expect(
      judgeAliased(
        {
          kind: 'partial',
          data: { u0: { v: 1 }, u1: { v: 2 } },
          errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED', path: ['u1', 'c'] }]
        },
        slice,
        { aliases, read }
      ).ok
    ).toBe(false);
    expect(
      judgeAliased({ kind: 'ok', data: { u0: { v: 1 }, u1: null } }, slice, { aliases, read }).ok
    ).toBe(false);
    expect(judgeAliased({ kind: 'ok', data: {} }, slice, { aliases, read }).reason).toMatch(
      /over-large/
    );
    expect(judgeAliased({ kind: 'gateway', reason: 'HTTP 502' }, slice, { aliases, read }).ok).toBe(
      false
    );
  });
});

describe('measureShadowContributions', () => {
  it(`measures ${BATCH_SIZE} developers per main request and ${SEARCH_BATCH_SIZE} per search`, async () => {
    const rows = devs(7);
    const fake = fakeGitHub(peopleFor(rows));
    const { blocks, failed, stats } = await measure(rows, fake.fetchImpl);
    const count = (kind) => fake.calls.filter((c) => c.kind === kind).length;
    expect(count('main')).toBe(2);
    expect(count('search')).toBe(3);
    expect(blocks.size).toBe(7);
    expect(failed.size).toBe(0);
    expect(stats).toMatchObject({ rejected: 0, bisections: 0 });
  });

  it('assembles one whole block from every phase', async () => {
    const rows = [{ username: 'ana', github_id: 7 }];
    const people = {
      ana: person('ana', {
        id: 7,
        commits: { 'ana/app': { 0: 1, 1: 1, 2: 1 } },
        accepted: [mergedNode(4, 'stdlib-js/stdlib', 'kgryte')],
        maintained: [
          {
            ...mergedNode(5, 'ana/app', null),
            author: { __typename: 'User', login: 'carl', createdAt: '2019-01-01T00:00:00Z' },
            repository: repo('ana/app', { stars: 40 })
          }
        ],
        future: ['ana/paint'],
        history: {
          'ana/app': [
            { authoredDate: at(1), committedDate: at(1), committer: { name: 'Ana', user: null } }
          ]
        }
      })
    };
    const { decoded } = await measure(rows, fakeGitHub(people).fetchImpl);
    const m = decoded('ana');
    expect(m).toMatchObject({
      login: 'ana',
      github_id: 7,
      window: { from: W.from, to: W.to },
      cut: 0
    });
    expect(m.accepted[0].items[0].merger.login).toBe('kgryte');
    expect(m.maintained[0].items[0].author.login).toBe('carl');
    expect(m.future_repos).toEqual(['ana/paint']);
    expect(m.integrity).toEqual([
      {
        repo: 'ana/app',
        sampled: 1,
        bot: 0,
        max_lead_hours: 0,
        max_ahead_hours: expect.any(Number)
      }
    ]);
  });

  it('discards a partial response whole, even the aliases that look fine, and bisects', async () => {
    const rows = devs(4);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: ({ kind, n }) =>
        kind === 'main' && n === 1
          ? respond(200, {
              data: {
                rateLimit: RATE_LIMIT,
                u0: person('dev0', { id: 1000, commits: { 'dev0/app': { 0: 999 } } }).main
              },
              errors: [
                {
                  type: 'RESOURCE_LIMITS_EXCEEDED',
                  path: ['u3', 'c', 'commitContributionsByRepository']
                }
              ]
            })
          : null
    });
    const { blocks, stats, decoded } = await measure(rows, fake.fetchImpl);
    expect(
      fake.calls
        .filter((c) => c.kind === 'main')
        .map((c) => Object.keys(c.variables).filter((k) => /^l/.test(k)).length)
    ).toEqual([4, 2, 2]);
    expect(stats).toMatchObject({ rejected: 1, bisections: 1 });
    expect(blocks.size).toBe(4);
    expect(decoded('dev0').commits[0].days).toEqual([
      { day: 0, commits: 3 },
      { day: 4, commits: 2 }
    ]);
  });

  it('measures a developer refused on their own once more with a shorter repository list', async () => {
    const rows = devs(1);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: ({ kind, query }) =>
        kind === 'main' && query.includes('maxRepositories: 100')
          ? respond(502, '<html>502</html>')
          : null
    });
    const { decoded, stats } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.filter((c) => c.kind === 'main')).toHaveLength(MAX_SINGLE_RETRIES + 2);
    expect(decoded('dev0').cut & CUT_DEGRADED).toBe(CUT_DEGRADED);
    expect(stats.degraded).toBe(1);
  });

  it('follows further pages, and marks a list cut at the page cap', async () => {
    const rows = [{ username: 'ana', github_id: 7 }];
    const pages = Array.from({ length: MAX_PAGES + 1 }, (_, i) => [
      prNode(i, 'acme/lib', { number: 100 + i })
    ]);
    const people = { ana: person('ana', { id: 7, prs: [prNode(0, 'acme/lib')], prPages: pages }) };
    const fake = fakeGitHub(people);
    const { decoded } = await measure(rows, fake.fetchImpl);
    expect(fake.calls.filter((c) => c.kind === 'page')).toHaveLength(MAX_PAGES - 1);
    const m = decoded('ana');
    expect(m.pull_requests[0].items).toHaveLength(MAX_PAGES);
    expect(m.cut & CUT_PULL_REQUESTS).toBe(CUT_PULL_REQUESTS);
  });

  it('follows a further search page', async () => {
    const rows = [{ username: 'ana', github_id: 7 }];
    const people = {
      ana: person('ana', {
        id: 7,
        accepted: [mergedNode(1, 'a/b', 'k', { number: 1 })],
        acceptedPages: [[mergedNode(2, 'a/b', 'k', { number: 2 })]]
      })
    };
    const { decoded } = await measure(rows, fakeGitHub(people).fetchImpl);
    expect(decoded('ana').accepted[0].items.map((i) => i.number)).toEqual([1, 2]);
  });

  it('keeps a developer whose commit-date sample failed, marked CUT_INTEGRITY', async () => {
    const rows = [{ username: 'ana', github_id: 7 }];
    const people = { ana: person('ana', { id: 7, commits: { 'ana/app': { 0: 1, 1: 1, 2: 1 } } }) };
    const fake = fakeGitHub(people, {
      onRequest: ({ kind }) => (kind === 'integrity' ? respond(502, '<html>502</html>') : null)
    });
    const { decoded } = await measure(rows, fake.fetchImpl);
    const m = decoded('ana');
    expect(m.cut & CUT_INTEGRITY).toBe(CUT_INTEGRITY);
    expect(m.integrity).toEqual([]);
  });

  it('fails a developer whose searches failed, never storing half a measurement', async () => {
    const rows = devs(1);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: ({ kind }) => (kind === 'search' ? respond(502, '<html>502</html>') : null)
    });
    const { blocks, failed } = await measure(rows, fake.fetchImpl);
    expect(blocks.size).toBe(0);
    expect(failed.get('dev0')).toMatch(/^search: HTTP 502/);
  });

  it('lists a login GitHub does not know as not found', async () => {
    const rows = devs(3);
    const people = peopleFor(rows);
    delete people.dev1;
    const { blocks, failed } = await measure(rows, fakeGitHub(people).fetchImpl);
    expect([...blocks.keys()]).toEqual(['dev0', 'dev2']);
    expect(failed.get('dev1')).toBe('not found');
  });

  it('stops, without throwing, when a wait would outlast MAX_WAIT_MS', async () => {
    const rows = devs(8);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: ({ kind, n }) =>
        kind === 'main' && n === 2
          ? respond(429, '{}', { 'retry-after': String(MAX_WAIT_MS / 1000 + 60) })
          : null
    });
    const { blocks, failed, stats, lines } = await measure(rows, fake.fetchImpl);
    expect(stats.stopped).toMatch(/longer than this measurement waits/);
    // Nothing after the stop is sent, and nothing measured before it is stored half-done.
    expect(blocks.size).toBe(0);
    expect(failed.size).toBe(8);
    expect(lines.some((line) => line.startsWith('::warning title=SHADOW_CONTRIBUTIONS::'))).toBe(
      true
    );
  });

  it('is fail-soft on a rejected credential: every developer listed as failed', async () => {
    const rows = devs(3);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: () => respond(401, '{"message":"Bad credentials"}')
    });
    const { blocks, failed } = await measure(rows, fake.fetchImpl);
    expect(blocks.size).toBe(0);
    expect(failed.size).toBe(3);
  });

  it('measures each login once', async () => {
    const rows = [...devs(2), { username: 'DEV0', github_id: 1000 }];
    const fake = fakeGitHub(peopleFor(rows));
    await measure(rows, fake.fetchImpl);
    expect(fake.calls[0].variables).toMatchObject({ l0: 'dev0', l1: 'dev1' });
    expect(fake.calls[0].variables.l2).toBeUndefined();
  });
});

describe('screenCalendars', () => {
  it('counts active calendar days per developer', async () => {
    const rows = devs(2);
    const people = peopleFor(rows);
    people.dev1.calendar = [0, 0, 5, 1];
    const { client: c } = client(fakeGitHub(people).fetchImpl);
    const { days, failed } = await screenCalendars(rows, { client: c, now: NOW, log: quiet });
    expect(Object.fromEntries(days)).toEqual({ dev0: 2, dev1: 2 });
    expect(failed.size).toBe(0);
  });

  it('counts a calendar day only when it holds a contribution', () => {
    expect(
      calendarActiveDays({
        weeks: [{ contributionDays: [{ contributionCount: 0 }, { contributionCount: 3 }] }]
      })
    ).toBe(1);
  });
});

describe('attachShadow', () => {
  const block = (at) => ({ v: 2, at });
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
        { username: 'nobody', github_id: 9 }
      ],
      { blocks: new Map([['ana', fresh]]), previous }
    );
    expect(developers[0][SHADOW_FIELD]).toBe(fresh);
    expect(developers[1][SHADOW_FIELD].at).toBe('2026-10-12T09:00:00Z');
    expect(developers[2]).not.toHaveProperty(SHADOW_FIELD);
    expect(counts).toEqual({ fresh: 1, kept: 1, none: 1 });
  });

  it('never hands one account the block of another that held its login', () => {
    const { developers } = attachShadow([{ username: 'taken', github_id: 4 }], {
      blocks: new Map(),
      previous
    });
    expect(developers[0]).not.toHaveProperty(SHADOW_FIELD);
  });
});

describe('shadowContributionsStep', () => {
  it('attaches fresh blocks, keeps the previous one for a failure, and summarises', async () => {
    const rows = devs(2);
    const people = peopleFor(rows);
    delete people.dev1;
    const { client: c } = client(fakeGitHub(people).fetchImpl);
    const lines = [];
    const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l) };
    const existing = [
      { username: 'dev1', github_id: 1001, [SHADOW_FIELD]: { v: 2, at: 'earlier' } }
    ];
    const { developers, fresh, kept } = await shadowContributionsStep(rows, {
      existing,
      client: c,
      now: NOW,
      log
    });
    expect(fresh).toBe(1);
    expect(kept).toBe(1);
    expect(developers[1][SHADOW_FIELD].at).toBe('earlier');
    expect(lines.at(-1)).toBe(
      "Contributions on this batch's rows: 1 measured this run, 1 kept from an earlier run, 0 without one."
    );
  });

  it('never throws, whatever the measurement does', async () => {
    const broken = {
      query: async () => {
        throw new TypeError('boom');
      },
      usage: () => ({ requests: 0, points: 0 }),
      sleep: async () => {}
    };
    const result = await shadowContributionsStep(devs(1), { client: broken, now: NOW, log: quiet });
    expect(result.none).toBe(1);
  });
});

describe('the score does not see the block', () => {
  const sample = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', 'data.sample.json'), 'utf8')
  );
  const withBlocks = {
    ...sample,
    leaderboard: sample.leaderboard.map((row) => ({
      ...row,
      [SHADOW_FIELD]: { v: 2, at: 'x', cr: [['a/b', 1, 1, [0, 999999]]] }
    }))
  };

  it('recomputes every published score identically with and without one', () => {
    const stamped = withBlocks.leaderboard.filter((row) => row.model_version);
    for (const row of stamped)
      expect(scoreFromPublished(row)).toBe(
        scoreFromPublished({ ...row, [SHADOW_FIELD]: undefined })
      );
    expect(verifyPublished(withBlocks, { allowMixedVersions: true }).errors).toEqual([]);
  });

  it('scores a developer identically with and without one', () => {
    const dev = {
      total_stars: 3,
      followers: 4,
      public_repos: 5,
      created_at: '2020-01-01T00:00:00Z',
      raw_events_60d: []
    };
    const a = scoreModel(dev, { config: SCORE_CONFIG, now: NOW });
    const b = scoreModel({ ...dev, [SHADOW_FIELD]: { v: 2 } }, { config: SCORE_CONFIG, now: NOW });
    expect(b).toEqual(a);
    expect(scoreDevelopers([{ username: 'x', ...dev }], { now: NOW })[0].score).toBe(a.score);
  });
});
