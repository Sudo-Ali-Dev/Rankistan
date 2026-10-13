import { describe, it, expect } from 'vitest';
import {
  MAX_RESPLIT_DEPTH,
  MAX_RESPLITS_PER_BATCH,
  describeDiscovery,
  discoverBatch,
  measureListing
} from './discover.js';
import { MAX_DISCARD_RETRIES, createSearchClient } from './graphql.js';
import { PACK_TO, parseShardQuery } from './partition.js';
import { RATE_LIMIT, fakeGraphql, makePopulation, matcher, respond } from './fake-search.js';
import { SEARCH_BATCHES } from '../fetch-devs.js';

const BASE_QUERY =
  'location:pakistan type:user repos:>3 followers:>1 created:2022-12-01..2023-02-28';
const { base, root } = parseShardQuery(BASE_QUERY);
const quiet = { warn() {} };

const population = (n, seed = 13, extra = {}) =>
  makePopulation({
    n,
    from: root.from,
    to: root.to,
    seed,
    followers: (r) => 2 + Math.floor(r() * 10),
    ...extra
  });

async function run(people, { queries = [BASE_QUERY], ...hooks } = {}) {
  const fake = fakeGraphql(people, hooks);
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const search = createSearchClient({
    token: 't',
    fetchImpl: fake.fetchImpl,
    sleep,
    minIntervalMs: 0,
    log: quiet
  });
  const report = await discoverBatch({ label: 'PK test', queries }, search, { sleep });
  return { report, fake, waits, search };
}

const ids = (report) => new Set(report.candidates.map((c) => c.id));
const earliest = (people) => people.reduce((a, b) => (b.created < a.created ? b : a));
const latest = (people) => people.reduce((a, b) => (b.created > a.created ? b : a));

/** A fault that follows one developer into every listing that includes them. */
const everyTime =
  (id, fault) =>
  ({ body }) => {
    const nodes = body.data.search.nodes;
    body.data.search.nodes = nodes.flatMap((n) => (n?.databaseId === id ? fault(n) : [n]));
    return null;
  };

describe('discoverBatch', () => {
  it('lists everyone in a range far over the 1,000 cap, one request per leaf', async () => {
    const people = population(3333);
    const { report, fake } = await run(people);

    expect(report.rootCount).toBe(3333);
    expect(report.candidates).toHaveLength(3333);
    expect(ids(report)).toEqual(new Set(people.map((u) => u.id)));
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(report.leaves.every((l) => l.count <= PACK_TO)).toBe(true);
    expect(fake.calls.list).toBe(report.leaves.length);
    expect(report.sum).toEqual({
      root: 3333,
      leaves: 3333,
      listed: 3333,
      notFound: 0,
      valid: true
    });
    expect(report.problems).toEqual([]);
    expect(report.stats.points).toBe(fake.calls.count + fake.calls.list);
  });

  it('partitions a multi-range batch together and sums its ranges', async () => {
    const ranges = SEARCH_BATCHES[23].queries.map((q) => parseShardQuery(q).root);
    const people = ranges.flatMap((r, i) =>
      makePopulation({ n: 300 + i * 100, from: r.from, to: r.from + 150 * 86400, seed: 40 + i })
    );
    const { report } = await run(people, { queries: SEARCH_BATCHES[23].queries });
    expect(report.ranges.map((r) => r.count)).toEqual([300, 400, 500]);
    expect(report.rootCount).toBe(1200);
    expect(report.candidates).toHaveLength(1200);
    expect(report.sum.valid).toBe(true);
  });

  // Defect 4: there was no record of whether a leaf was listed completely.
  it('records complete, count, listedIds and reason on every leaf', async () => {
    const { report } = await run(population(500));
    for (const leaf of report.leaves) {
      expect(leaf).toMatchObject({
        complete: true,
        reason: null,
        count: expect.any(Number),
        listedIds: expect.any(Array)
      });
      expect(leaf.listedIds).toHaveLength(leaf.count);
      expect(leaf.query.startsWith(`${base} `)).toBe(true);
    }
  });

  // Defect 3: listLeaf keyed on login.
  it('keys developers on databaseId and keeps login as data', async () => {
    const people = population(60);
    // A renamed account whose old login was claimed by someone else, in the other half.
    people[0] = { ...people[0], login: 'ali', created: root.from };
    people[1] = { ...people[1], login: 'Ali', created: root.to };
    const { report } = await run(people);
    expect(report.candidates).toHaveLength(60);
    expect(report.candidates.filter((c) => c.login.toLowerCase() === 'ali')).toHaveLength(2);
  });

  // Defect 1: NOT_FOUND on one node is evidence about that node only.
  it('drops a node a NOT_FOUND error is scoped to and keeps the rest of the leaf', async () => {
    const people = population(300);
    let gone = null;
    const { report } = await run(people, {
      onList: ({ body, call }) => {
        if (call !== 1) return null;
        gone = body.data.search.nodes[3].databaseId;
        body.data.search.nodes[3] = null;
        body.errors = [{ type: 'NOT_FOUND', path: ['search', 'nodes', 3], message: 'gone' }];
        return null;
      }
    });
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(report.leaves[0].notFound).toBe(1);
    expect(report.candidates).toHaveLength(299);
    expect(ids(report).has(gone)).toBe(false);
    expect(report.sum).toMatchObject({ root: 300, leaves: 300, listed: 299, notFound: 1 });
    expect(report.sum.valid).toBe(true);
  });

  // Defect 1: a 200 carrying errors[] passed straight through the pager.
  it('discards a page carrying any other error, splits the leaf, and trusts none of it', async () => {
    const people = population(300);
    const { report } = await run(people, {
      onList: ({ body, call }) => {
        if (call !== 1) return null;
        body.data.search.nodes[0] = { databaseId: 999999, login: 'ghost', createdAt: null };
        body.errors = [
          { type: 'INTERNAL', path: ['search', 'nodes', 0, 'location'], message: 'x' }
        ];
        return null;
      }
    });
    expect(report.stats.resplits).toHaveLength(1);
    expect(report.stats.resplits[0].reason).toMatch(/INTERNAL/);
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(ids(report)).toEqual(new Set(people.map((u) => u.id)));
    expect(ids(report).has(999999)).toBe(false);
  });

  it('treats a null node or a null field as unmeasured, never as a fact', async () => {
    const people = population(300);
    const [a, b] = [earliest(people), latest(people)];
    const nullNode = everyTime(a.id, () => [null]);
    const nullId = everyTime(b.id, (n) => [{ ...n, databaseId: null }]);
    const { report } = await run(people, {
      onList: (call) => nullId(call) ?? nullNode(call)
    });
    const failed = report.leaves.filter((l) => !l.complete);
    expect(failed.map((l) => l.reason)).toEqual([
      expect.stringMatching(/node \d+ is null with no error/),
      expect.stringMatching(/without a databaseId/)
    ]);
    // Nobody from an incomplete leaf becomes a candidate, not even the nodes that looked fine.
    const excluded = people.filter((u) => failed.some((l) => matcher(l.query)(u)));
    expect(excluded.length).toBe(failed[0].count + failed[1].count);
    expect(excluded.some((u) => ids(report).has(u.id))).toBe(false);
    expect(report.candidates).toHaveLength(300 - excluded.length);
    expect(report.sum.valid).toBe(true);
  });

  it('corners a developer the listing never returns, so the rest of their leaf still counts', async () => {
    const people = population(300);
    const phantom = people[150];
    const { report } = await run(people, { onList: everyTime(phantom.id, () => []) });
    const failed = report.leaves.filter((l) => !l.complete);
    expect(failed).toHaveLength(1);
    expect(matcher(failed[0].query)(phantom)).toBe(true);
    expect(failed[0].reason).toMatch(/listed \d+ of \d+/);
    expect(report.stats.resplits).toHaveLength(MAX_RESPLIT_DEPTH);
    // Four halvings take a leaf of up to 95 down to a handful.
    expect(failed[0].count).toBeLessThanOrEqual(15);
    expect(report.candidates).toHaveLength(300 - failed[0].count);
  });

  it('recovers from a page that came back short once', async () => {
    const people = population(300);
    const { report } = await run(people, {
      onList: ({ body, call }) => {
        if (call === 1) body.data.search.nodes.pop();
        return null;
      }
    });
    expect(report.stats.resplits).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/^listed \d+ of \d+$/), parts: 2 })
    ]);
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(report.candidates).toHaveLength(300);
  });

  it('rejects a leaf whose nodes fall outside its created range', async () => {
    const people = population(300);
    const odd = people[42];
    const { report } = await run(people, {
      onList: everyTime(odd.id, (n) => [{ ...n, createdAt: '2019-01-01T00:00:00Z' }])
    });
    const failed = report.leaves.filter((l) => !l.complete);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatch(/created 2019-01-01T00:00:00Z, outside this leaf/);
  });

  // Defect 2: a 502 was retried at the same size and then thrown.
  it('splits a leaf that comes back 502 rather than retrying it at the same size', async () => {
    const people = population(300);
    const { report, waits } = await run(people, {
      onList: ({ call }) => (call === 1 ? respond(502, '<html>Bad Gateway</html>') : null)
    });
    expect(report.stats.resplits).toEqual([
      expect.objectContaining({ reason: 'HTTP 502', parts: 2 })
    ]);
    expect(waits).toEqual([]);
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(report.candidates).toHaveLength(300);
    expect(report.sum.valid).toBe(true);
  });

  it('stops splitting at the batch budget and records what still fails', async () => {
    const people = population(5);
    const { report, fake } = await run(people, {
      onList: () => respond(502, '<html></html>')
    });
    // Every split adds one leaf; depth-first, the first branch reaches MAX_RESPLIT_DEPTH first.
    expect(report.stats.resplits).toHaveLength(MAX_RESPLITS_PER_BATCH);
    expect(report.leaves).toHaveLength(MAX_RESPLITS_PER_BATCH + 1);
    expect(report.leaves.every((l) => !l.complete && l.reason === 'HTTP 502')).toBe(true);
    expect(fake.calls.list).toBe(
      MAX_RESPLITS_PER_BATCH + (MAX_RESPLITS_PER_BATCH + 1) * (MAX_DISCARD_RETRIES + 1)
    );
    expect(report.candidates).toEqual([]);
    // The halves were counted, so the leaves still account for everyone.
    expect(report.sum.leaves).toBe(5);
  });

  it('re-partitions a leaf that outgrew a page between counting and listing', async () => {
    const before = population(400);
    // 200 accounts appear in the first second after the partition was counted.
    const late = makePopulation({
      n: 200,
      from: root.from,
      to: root.from,
      seed: 77,
      followers: (r) => 2 + Math.floor(r() * 50)
    });
    const after = [...before, ...late];
    let listing = false;
    const { report } = await run(after, {
      onCount: ({ queries }) => {
        if (listing) return null;
        const data = { rateLimit: RATE_LIMIT };
        queries.forEach(
          (q, i) => (data[`c${i}`] = { userCount: before.filter(matcher(q)).length })
        );
        return respond(200, { data });
      },
      onList: () => {
        listing = true;
        return null;
      }
    });
    expect(report.stats.resplits[0].reason).toMatch(/now match, more than one page/);
    expect(report.leaves.every((l) => l.complete)).toBe(true);
    expect(report.candidates).toHaveLength(600);
    // The range was counted at 400. The leaves now hold 600, and the report says so.
    expect(report.sum).toMatchObject({ root: 400, leaves: 600, valid: false });
    expect(report.problems.join()).toMatch(/leaves sum to 600 but the range counts 400/);
  });

  it('fails the sum check when the range does not add up to its leaves', async () => {
    let first = true;
    const { report } = await run(population(300), {
      // The first count is the range itself, and it reads four high.
      onCount: () => {
        if (!first) return null;
        first = false;
        return respond(200, { data: { rateLimit: RATE_LIMIT, c0: { userCount: 304 } } });
      }
    });
    expect(report.sum).toMatchObject({ root: 304, leaves: 300, valid: false });
    expect(report.problems[0]).toMatch(/did not add up/);
    expect(report.problems[1]).toMatch(/leaves sum to 300 but the range counts 304/);
    // The leaves themselves are sound, so their developers are still candidates.
    expect(report.candidates).toHaveLength(300);
  });

  it('stops listing on a persistent rate limit and records the rest as unlisted', async () => {
    const limited = respond(403, '{"message":"You have exceeded a secondary rate limit"}');
    const { report } = await run(population(400), {
      onList: ({ call }) => (call >= 2 ? limited : null)
    });
    const [first, ...rest] = report.leaves;
    expect(first.complete).toBe(true);
    expect(rest.length).toBeGreaterThan(1);
    expect(
      rest.every((l) => !l.complete && /^not listed: .*secondary rate limit/.test(l.reason))
    ).toBe(true);
    expect(report.candidates).toHaveLength(first.count);
    expect(report.sum.valid).toBe(true);
  });

  it('throws on a fatal response, which no other leaf would survive either', async () => {
    await expect(
      run(population(100), { onList: () => respond(401, '{"message":"Bad credentials"}') })
    ).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the range cannot be counted at all', async () => {
    await expect(run(population(100), { onCount: () => respond(502, '') })).rejects.toThrow(
      /Could not count/
    );
  });

  it('refuses a batch query that repeats created:, which would match everyone', async () => {
    await expect(
      run([], { queries: [`${BASE_QUERY} created:2023-01-01..2023-01-31`] })
    ).rejects.toThrow(/repeats created/);
  });
});

describe('measureListing', () => {
  const leaf = { slice: { from: 0, to: 1000, followers: [2, Infinity] }, count: 2 };
  const node = (id, at = 10) => ({
    databaseId: id,
    login: `u${id}`,
    createdAt: new Date(at * 1000).toISOString()
  });

  it('counts a databaseId once however often a page repeats it, and the page is then short', () => {
    const result = measureListing(leaf, 'q', {
      userCount: 2,
      nodes: [node(7), { ...node(7), login: 'renamed' }]
    });
    expect(result).toMatchObject({ complete: false, duplicates: 1, listedIds: [7] });
    expect(result.reason).toMatch(/listed 1 of 2/);
  });

  it('keeps two accounts that share a login apart, because their ids differ', () => {
    const result = measureListing(leaf, 'q', {
      userCount: 2,
      nodes: [
        { ...node(1), login: 'ali' },
        { ...node(2), login: 'Ali' }
      ]
    });
    expect(result).toMatchObject({ complete: true, listedIds: [1, 2] });
  });

  it('is complete when distinct ids plus not-found nodes equal userCount', () => {
    const result = measureListing(leaf, 'q', {
      userCount: 3,
      nodes: [node(1), null, node(2)],
      notFound: [1]
    });
    expect(result).toMatchObject({ complete: true, count: 3, listedIds: [1, 2], notFound: 1 });
  });

  it('flags a NOT_FOUND index the page does not have', () => {
    const result = measureListing(leaf, 'q', { userCount: 1, nodes: [node(1)], notFound: [4] });
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/node 4, which the page does not have/);
  });

  it('summarises many problems instead of printing all of them', () => {
    const result = measureListing(leaf, 'q', {
      userCount: 5,
      nodes: [null, null, null, null, null]
    });
    expect(result.reason).toMatch(/\(\+3 more\)$/);
  });
});

describe('describeDiscovery', () => {
  it('reports the batch figures and names each incomplete leaf in an Actions warning', async () => {
    const people = population(300);
    const { report } = await run(people, { onList: everyTime(people[7].id, () => [null]) });
    const { info, warnings } = describeDiscovery(report);
    expect(info[0]).toMatch(
      /^ {2}300 match across 1 range\(s\): \d+ leaves, \d+ complete, \d+ candidates\.$/
    );
    expect(info[2]).toMatch(/GraphQL: \d+ points over \d+ requests \(4000 left this hour\)\./);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^::warning title=Discovery::PK test: leaf followers:>1 created:\S+\.\.\S+ is incomplete \(node \d+ is null/
    );
    expect(warnings[0]).toMatch(/Its \d+ developer\(s\) were not listed this run\.$/);
  });

  it('escapes a reason so it cannot break out of the annotation', () => {
    const report = {
      label: 'PK test',
      base,
      rootCount: 1,
      ranges: [{}],
      candidates: [],
      sum: { notFound: 0 },
      problems: ['line one\nline two 100%'],
      leaves: [],
      stats: { fineLeaves: 1, slicesCounted: 1, levels: 0, resplits: [], points: 1, requests: 1 }
    };
    expect(describeDiscovery(report).warnings).toEqual([
      '::warning title=Discovery::PK test: line one%0Aline two 100%25.'
    ]);
  });
});
