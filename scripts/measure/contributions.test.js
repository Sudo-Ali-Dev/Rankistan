import { describe, it, expect } from 'vitest';
import {
  BATCH_SIZE,
  DEGRADED_MAX_REPOSITORIES,
  INTEGRITY_MAX_REPOSITORIES,
  MAX_PAGES,
  MAX_SINGLE_RETRIES,
  MAX_WAIT_MS,
  MERGES_BATCH_SIZE,
  buildMergesQuery,
  buildQuery,
  calendarActiveDays,
  createMeasurementClient,
  crossCheckMerges,
  decodeMeasurement,
  integrityTargets,
  judgeAliased,
  measureContributions,
  readIntegrity,
  isBotCommitter,
  readAcceptedPage,
  readMain,
  readRepositoriesPage,
  screenCalendars
} from './contributions.js';
import {
  CUT_ACCEPTED,
  CUT_DEGRADED,
  CUT_INTEGRITY,
  CUT_PULL_REQUESTS,
  FLAG_FORK,
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
  page,
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

  it('lists merges newest first, never by search, which the Actions token cannot use', () => {
    const accepted = buildMergesQuery('accepted', 2);
    expect(accepted).toContain('u1: user(login: $l1) { login a: pullRequests(states: MERGED');
    expect(accepted).toContain('first: 25, orderBy: { field: UPDATED_AT, direction: DESC }');
    expect(accepted).toContain('mergedBy { __typename login ... on User { createdAt } }');
    const repositories = buildMergesQuery('repositories', 1);
    expect(repositories).toContain(
      'repositories(ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC, first: 10'
    );
    expect(repositories).toContain('orderBy: { field: PUSHED_AT, direction: DESC }');
    // A developer refused at the usual size is listed again from a shorter first page.
    expect(buildMergesQuery('accepted', 1, { first: 5 })).toContain('first: 5,');
    for (const query of [accepted, repositories]) expect(query).not.toContain('search(');
    expect(() => buildMergesQuery('accepted', 0)).toThrow(RangeError);
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
    readAcceptedPage(
      {
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

describe('readAcceptedPage', () => {
  it('keeps merges into repositories the developer does not own, with merger and owner', () => {
    const into = new Map();
    readAcceptedPage(
      {
        pageInfo: { hasNextPage: false },
        nodes: [
          mergedNode(3, 'stdlib-js/stdlib', 'kgryte'),
          mergedNode(4, 'ana/own', 'kgryte'),
          mergedNode(5, 'x/y', null)
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
    readAcceptedPage({ pageInfo: {}, nodes: [node] }, { login: 'ana', window: W, into });
    expect(into.size).toBe(0);
  });

  it('reads on while a page can hold merges in the window, and stops at one updated before it', () => {
    const read = (nodes) =>
      readAcceptedPage(
        { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes },
        { login: 'ana', window: W, into: new Map() }
      );
    expect(read([mergedNode(3, 'a/b', 'k')])).toBe('c2');
    const old = { ...mergedNode(0, 'a/b', 'k', { number: 2 }), updatedAt: '2026-09-01T00:00:00Z' };
    expect(read([mergedNode(3, 'a/b', 'k'), old])).toBeNull();
  });
});

describe('readRepositoriesPage', () => {
  const walkOf = () => ({ listed: new Set(), maintained: new Map(), more: [], exhausted: false });
  const pull = (offset, author, number, updatedAt = at(offset)) => ({
    ...mergedNode(offset, 'unused/x', null, { number }),
    author: author && { __typename: 'User', login: author, createdAt: '2015-01-01T00:00:00Z' },
    updatedAt
  });
  const repository = (name, pushedAt, pulls, next = null) => ({
    ...repo(name, { stars: 40 }),
    pushedAt,
    pullRequests: page(pulls, next)
  });

  it("keeps other people's merges in repositories pushed in the window, and lists every repository", () => {
    const walk = walkOf();
    const next = readRepositoriesPage(
      page(
        [
          repository('ana/app', at(9), [pull(9, 'carl', 3), pull(8, 'ana', 2)], 'r2'),
          repository('ana/old', '2026-01-01T00:00:00Z', [pull(5, 'carl', 1)])
        ],
        'p2'
      ),
      { login: 'ana', window: W, walk }
    );
    expect(next).toBeNull(); // ana/old was last pushed before the window: nothing after it either
    expect([...walk.listed]).toEqual(['ana/app', 'ana/old']);
    const app = walk.maintained.get('ana/app');
    expect(app).toMatchObject({ stars: 40 });
    expect(app.items.map((i) => [i.number, i.author.login])).toEqual([[3, 'carl']]);
    expect(walk.maintained.has('ana/old')).toBe(false);
    // Its merges continue on another page, from the cursor its list ended on.
    expect(walk.more).toEqual([{ name: 'ana/app', flags: FLAG_OWNED, stars: 40, cursor: 'r2' }]);
    expect(walk.exhausted).toBe(false);
  });

  it('passes over a repository never pushed to', () => {
    const walk = walkOf();
    const next = readRepositoriesPage(
      page([{ ...repository('ana/empty', null, []) }, repository('ana/app', at(2), [])], 'p2'),
      { login: 'ana', window: W, walk }
    );
    expect(next).toBe('p2');
    expect([...walk.listed]).toEqual(['ana/empty', 'ana/app']);
  });

  it('marks a list read to its end as exhausted', () => {
    const walk = walkOf();
    readRepositoriesPage(page([repository('ana/app', at(2), [])]), {
      login: 'ana',
      window: W,
      walk
    });
    expect(walk.exhausted).toBe(true);
  });
});

describe('crossCheckMerges', () => {
  const main = (options) => ({
    cut: 0,
    merged: new Set(),
    commits: [{ repo: 'ana/app', flags: FLAG_OWNED, days: [{ day: 1, commits: 1 }] }],
    ...options
  });
  const lists = ({ accepted = [], listed = ['ana/app'], exhausted = true } = {}) => ({
    accepted: new Map(accepted.map(([repo, number]) => [repo, { repo, items: [{ number }] }])),
    walk: { listed: new Set(listed), exhausted }
  });

  it('accepts lists that hold what the contributions API reported', () => {
    const m = main({ merged: new Set(['acme/lib#5']) });
    expect(crossCheckMerges(m, lists({ accepted: [['acme/lib', 5]] }))).toBeNull();
  });

  it('refuses a merge list missing a pull request reported merged in the window', () => {
    const m = main({ merged: new Set(['acme/lib#5']) });
    expect(crossCheckMerges(m, lists())).toMatch(/1 merged pull request\(s\) missing.*acme\/lib#5/);
    // A list cut at its page cap may lack it: that is already recorded, and nothing is invented.
    expect(crossCheckMerges({ ...m, cut: CUT_ACCEPTED }, lists())).toBeNull();
  });

  it('refuses a repository list that lacks a repository they committed to', () => {
    expect(crossCheckMerges(main(), lists({ listed: [] }))).toMatch(/list is empty/);
    expect(crossCheckMerges(main(), lists({ listed: ['ana/other'] }))).toMatch(/lacks ana\/app/);
    // Stopped at the window's start, the list need not reach a repository pushed before it.
    expect(crossCheckMerges(main(), lists({ listed: ['ana/other'], exhausted: false }))).toBeNull();
    const fork = main({ commits: [{ repo: 'ana/fork', flags: FLAG_OWNED | FLAG_FORK, days: [] }] });
    expect(crossCheckMerges(fork, lists({ listed: [] }))).toBeNull();
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
  it(`measures ${BATCH_SIZE} developers per main request and ${MERGES_BATCH_SIZE} per merges request`, async () => {
    const rows = devs(7);
    const fake = fakeGitHub(peopleFor(rows));
    const { blocks, failed, stats } = await measure(rows, fake.fetchImpl);
    const count = (kind) => fake.calls.filter((c) => c.kind === kind).length;
    expect(count('main')).toBe(2);
    expect(count('merges')).toBe(6); // 3 requests for each of the two lists
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

  it('follows a further page of merged pull requests', async () => {
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

  it('fails a developer whose merge lists failed, never storing half a measurement', async () => {
    const rows = devs(1);
    const fake = fakeGitHub(peopleFor(rows), {
      onRequest: ({ kind }) => (kind === 'merges' ? respond(502, '<html>502</html>') : null)
    });
    const { blocks, failed } = await measure(rows, fake.fetchImpl);
    expect(blocks.size).toBe(0);
    expect(failed.get('dev0')).toMatch(/^merges: HTTP 502/);
  });

  it('lists a developer refused at the usual size again from a shorter first page', async () => {
    const rows = [{ username: 'ana', github_id: 7 }];
    const people = {
      ana: person('ana', { id: 7, accepted: [mergedNode(4, 'stdlib-js/stdlib', 'kgryte')] })
    };
    const fake = fakeGitHub(people, {
      onRequest: ({ kind, query }) =>
        kind === 'merges' && query.includes('a: pullRequests(states: MERGED, first: 25')
          ? respond(502, '<html>502</html>')
          : null
    });
    const { decoded, failed } = await measure(rows, fake.fetchImpl);
    expect(failed.size).toBe(0);
    expect(decoded('ana').accepted[0].items[0].merger.login).toBe('kgryte');
    expect(decoded('ana').cut).toBe(0); // nothing is lost: the rest of the list is paged
  });

  it('never stores empty merge lists a token could not see, as search once did', async () => {
    // GitHub answers in full and without an error, but the lists hold nothing: the contributions
    // API says ana's pull request was merged, and that she committed to her own repository.
    const rows = [{ username: 'ana', github_id: 7 }];
    const people = {
      ana: person('ana', {
        id: 7,
        prs: [prNode(3, 'acme/lib', { merged: true, state: 'MERGED', number: 5 })],
        repositories: page([])
      })
    };
    const { blocks, failed, stats, lines } = await measure(rows, fakeGitHub(people).fetchImpl);
    expect(blocks.size).toBe(0);
    expect(failed.get('ana')).toMatch(/^merges: 1 merged pull request\(s\) missing/);
    expect(stats.inconsistent).toBe(1);
    expect(lines.some((line) => line.includes('merge lists disagree'))).toBe(true);

    people.ana = person('ana', { id: 7, repositories: page([]) });
    const empty = await measure(rows, fakeGitHub(people).fetchImpl);
    expect(empty.failed.get('ana')).toMatch(/repository list is empty, though they committed/);
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
  it('skips the merge lists and samples for a developer who cannot pass the gate, and lists them', async () => {
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
    const listed = fake.calls
      .filter((c) => c.kind === 'merges')
      .flatMap((c) => Object.values(c.variables));
    expect(listed).not.toContain('dev1');
  });
});
