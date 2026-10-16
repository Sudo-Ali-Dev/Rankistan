import { describe, it, expect } from 'vitest';
import {
  BATCH_SIZE,
  DEGRADED_MAX_REPOSITORIES,
  INTEGRITY_MAX_REPOSITORIES,
  MAX_PAGES,
  MAX_SINGLE_RETRIES,
  MAX_WAIT_MS,
  SEARCH_BATCH_SIZE,
  buildQuery,
  buildSearchQuery,
  calendarActiveDays,
  createMeasurementClient,
  decodeMeasurement,
  integrityTargets,
  judgeAliased,
  measureContributions,
  readIntegrity,
  isBotCommitter,
  readMain,
  readSearchPage,
  screenCalendars,
  searchQueries
} from './contributions.js';
import {
  CUT_DEGRADED,
  CUT_INTEGRITY,
  CUT_PULL_REQUESTS,
  FLAG_OWNED,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN
} from '../../src/model/measurement.js';
import { RATE_LIMIT, respond } from '../discovery/fake-search.js';
import {
  NOW,
  W,
  at,
  fakeGitHub,
  mergedNode,
  person,
  prNode,
  repo,
  reviewNode
} from './fake-contributions.js';

const quiet = { log() {}, warn() {} };

function client(fetchImpl, extra = {}) {
  const waits = [];
  return {
    waits,
    client: createMeasurementClient({
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
  const result = await measureContributions(rows, {
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

describe('what v3.1 reads', () => {
  const read = (node, target = { login: 'ana', githubId: 7 }) =>
    readMain(node, { target, window: W });

  it('flags a review by someone with no role in the project, and skips private repositories', () => {
    const m = read(
      person('ana', {
        id: 7,
        commits: { 'ana/app': { 1: 1 }, 'ana/secret': { 2: 1 } },
        reviews: [
          reviewNode(6, 'big/lib', 'carl', 3, 'NONE'),
          reviewNode(6, 'big/lib', 'carl', 4, 'MEMBER')
        ]
      }).main
    );
    const reviews = [...m.lists.reviews.values()][0];
    expect(reviews.items.map((i) => i.outsider)).toEqual([true, false]);
    expect(m.commits.map((r) => r.repo)).toEqual(['ana/app', 'ana/secret']);
    const hidden = read({
      ...person('ana', { id: 7 }).main,
      c: {
        ...person('ana', { id: 7 }).main.c,
        commitContributionsByRepository: [
          {
            repository: repo('ana/secret', { hidden: true }),
            contributions: { totalCount: 1, nodes: [{ occurredAt: at(2), commitCount: 1 }] }
          }
        ],
        totalRepositoriesWithContributedCommits: 1
      }
    });
    expect(hidden.commits).toEqual([]);
  });

  it('records who approved a pull request its author merged, the oldest account first', () => {
    const into = new Map();
    readSearchPage(
      'accepted',
      {
        issueCount: 2,
        pageInfo: { hasNextPage: false },
        nodes: [
          mergedNode(3, 'acme/app', 'ana', {
            number: 1,
            approvers: [
              ['ana', '2010-01-01T00:00:00Z'],
              ['zed', '2019-01-01T00:00:00Z'],
              ['bea', '2015-01-01T00:00:00Z']
            ]
          }),
          mergedNode(4, 'acme/app', 'kgryte', {
            number: 2,
            approvers: [['bea', '2015-01-01T00:00:00Z']]
          })
        ]
      },
      { login: 'ana', window: W, into }
    );
    const [self, other] = into.get('acme/app').items;
    expect(self.approver).toEqual({ login: 'bea', kind: 'U', created: '2015-01-01' });
    // Only a pull request its author merged needs an approver to stand for the merger.
    expect(other.approver).toBeNull();
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
        files: 2,
        approver: null
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
      max_ahead_hours: 3.5,
      days: 2
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

  it('samples gh-pages too, counting a commit on both branches once', () => {
    const c = commit('2026-10-13T07:00:00Z', '2026-10-13T07:00:00Z');
    const r = readIntegrity(
      {
        defaultBranchRef: { target: { history: { nodes: [{ ...c, oid: 'a' }] } } },
        gh: {
          target: {
            history: {
              nodes: [
                { ...c, oid: 'a' },
                { ...commit('2026-10-14T07:00:00Z', '2026-10-14T07:00:00Z'), oid: 'b' }
              ]
            }
          }
        }
      },
      { repo: 'p/site', measuredAtMs }
    );
    expect(r.sampled).toBe(2);
    expect(r.days).toBe(2);
  });

  it('says nothing about uncovered days when a branch filled the sample', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      ...commit('2026-10-13T07:00:00Z', '2026-10-13T07:00:00Z'),
      oid: `c${i}`
    }));
    const r = readIntegrity(
      { defaultBranchRef: { target: { history: { nodes } } } },
      { repo: 'p/busy', measuredAtMs }
    );
    expect(r.days).toBeNull();
  });

  it('treats Apps and committers named as bots as bots, and a sync or the web editor as a person', () => {
    expect(isBotCommitter({ name: 'Repo Health Bot' })).toBe(true);
    expect(isBotCommitter({ name: 'Job Finder Bot', user: { login: 'actions-user' } })).toBe(true);
    expect(isBotCommitter({ name: 'scraping-bot' })).toBe(true);
    expect(isBotCommitter({ name: 'github-actions[bot]' })).toBe(true);
    // A company syncing its engineers' commits commits them as the Actions user.
    expect(
      isBotCommitter({
        name: 'Github Actions',
        email: 'actions@github.com',
        user: { login: 'actions-user' }
      })
    ).toBe(false);
    expect(isBotCommitter({ name: 'GitHub', user: { login: 'web-flow' } })).toBe(false);
    expect(isBotCommitter({ name: 'Abbot Khan', user: { login: 'abbot' } })).toBe(false);
  });

  it('reports an empty repository as not sampled', () => {
    expect(readIntegrity({ defaultBranchRef: null }, { repo: 'a/b', measuredAtMs })).toEqual({
      repo: 'a/b',
      sampled: 0,
      bot: 0,
      max_lead_hours: null,
      max_ahead_hours: null,
      days: 0
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

describe('measureContributions', () => {
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
        max_ahead_hours: expect.any(Number),
        days: 1
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
    expect(lines.some((line) => line.startsWith('::warning title=CONTRIBUTIONS::'))).toBe(true);
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

describe('the prefilter', () => {
  it('skips the searches and samples for a developer who cannot pass the gate, and lists them', async () => {
    const rows = devs(3);
    const people = peopleFor(rows);
    people.dev1 = person('dev1', { id: 1001, commits: { 'dev1/app': { 0: 1 } } });
    const fake = fakeGitHub(people);
    const { blocks, ineligible } = await measure(rows, fake.fetchImpl, {
      run: { prefilter: (m) => m.commits.reduce((n, r) => n + r.days.length, 0) >= 2 }
    });
    expect([...blocks.keys()].sort()).toEqual(['dev0', 'dev2']);
    expect([...ineligible.keys()]).toEqual(['dev1']);
    expect(decodeMeasurement(ineligible.get('dev1')).accepted).toEqual([]);
    const searched = fake.calls
      .filter((c) => c.kind === 'search')
      .flatMap((c) => Object.values(c.variables));
    expect(searched.some((q) => q.includes('dev1'))).toBe(false);
  });
});
