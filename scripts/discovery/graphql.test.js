import { describe, it, expect } from 'vitest';
import {
  MAX_RATE_LIMIT_RETRIES,
  RateLimitError,
  classifyResponse,
  createSearchClient,
  nodeIndex
} from './graphql.js';
import { RATE_LIMIT, fakeGraphql, makePopulation, respond } from './fake-search.js';

const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] ?? null });
const quiet = { warn() {} };

function client(fetchImpl, extra = {}) {
  const waits = [];
  const search = createSearchClient({
    token: 't',
    fetchImpl,
    sleep: async (ms) => waits.push(ms),
    minIntervalMs: 0,
    log: quiet,
    ...extra
  });
  return { search, waits };
}

/** A fetch that replays `replies` in order, then defers to `fallback`. */
function scripted(replies, fallback) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = replies.shift();
    if (typeof next === 'function') return next(url, init);
    return next ?? fallback(url, init);
  };
  return { fetchImpl, bodies };
}

const aliasCount = (body) => Object.keys(body.variables).length;

describe('classifyResponse', () => {
  it('treats a 200 with no errors as ok and one carrying errors as partial', () => {
    expect(classifyResponse(200, headers(), '{"data":{"x":1}}').kind).toBe('ok');
    const partial = classifyResponse(200, headers(), '{"data":{"x":1},"errors":[{"type":"X"}]}');
    expect(partial.kind).toBe('partial');
    expect(partial.errors).toHaveLength(1);
  });

  it('reads an HTML 502 and an unparseable 200 as gateway failures, not as data', () => {
    expect(classifyResponse(502, headers(), '<html>Bad Gateway</html>').kind).toBe('gateway');
    expect(classifyResponse(200, headers(), '<html>oops</html>').kind).toBe('gateway');
  });

  it('separates a secondary limit from the hourly budget', () => {
    const secondary = classifyResponse(
      403,
      headers(),
      '{"message":"You have exceeded a secondary rate limit"}'
    );
    expect(secondary.kind).toBe('secondary');
    expect(classifyResponse(403, headers({ 'retry-after': '30' }), '{}').retryAfterMs).toBe(30000);
    expect(
      classifyResponse(
        403,
        headers({ 'x-ratelimit-remaining': '0' }),
        '{"message":"API rate limit exceeded"}'
      ).kind
    ).toBe('primary');
    expect(classifyResponse(200, headers(), '{"errors":[{"type":"RATE_LIMITED"}]}').kind).toBe(
      'primary'
    );
  });

  it('calls a bad credential fatal, since no retry can fix it', () => {
    expect(classifyResponse(401, headers(), '{"message":"Bad credentials"}').kind).toBe('fatal');
    expect(classifyResponse(403, headers(), '{"message":"Resource not accessible"}').kind).toBe(
      'fatal'
    );
  });
});

describe('nodeIndex', () => {
  it('scopes an error to a node only when its path points into search.nodes[i]', () => {
    expect(nodeIndex({ path: ['search', 'nodes', 3] })).toBe(3);
    expect(nodeIndex({ path: ['search', 'nodes', 3, 'location'] })).toBe(3);
    expect(nodeIndex({ path: ['search'] })).toBeNull();
    expect(nodeIndex({ path: ['search', 'nodes'] })).toBeNull();
    expect(nodeIndex({ path: ['c3'] })).toBeNull();
    expect(nodeIndex({})).toBeNull();
  });
});

describe('count', () => {
  const population = makePopulation({ n: 40, from: 0, to: 1000 });
  const queries = Array.from({ length: 5 }, (_, i) => `type:user created:${2020 + i}-01-01`);

  it('batches up to maxAliases counts into one request, in order', async () => {
    const fake = fakeGraphql(population);
    const { search } = client(fake.fetchImpl, { maxAliases: 3 });
    const counts = await search.count(queries);
    expect(counts).toHaveLength(5);
    expect(fake.calls.aliases).toEqual([3, 2]);
  });

  it('splits an alias batch that comes back all-null, the over-large query', async () => {
    const fake = fakeGraphql(population, {
      onCount: ({ queries: qs }) =>
        qs.length > 2 ? respond(200, { data: { rateLimit: RATE_LIMIT } }) : null
    });
    const { search } = client(fake.fetchImpl);
    expect(await search.count(queries)).toHaveLength(5);
    // 5 fails, its first 3 fail, then 2 + 1 and the remaining 2 succeed.
    expect(fake.calls.aliases).toEqual([5, 3, 2, 1, 2]);
  });

  // Defect 2: a 502 was retried at the same size and then thrown.
  it('bisects the alias batch on a 502 instead of retrying it at the same size', async () => {
    const fake = fakeGraphql(population, {
      onCount: ({ call }) => (call === 1 ? respond(502, '<html>502 Bad Gateway</html>') : null)
    });
    const { search, waits } = client(fake.fetchImpl);
    expect(await search.count(queries)).toHaveLength(5);
    expect(fake.calls.aliases).toEqual([5, 3, 2]);
    expect(waits).toEqual([]);
  });

  // Defect 1, on the count path: a 200 carrying errors is not trusted alias by alias.
  it('discards a partial count whole, even the aliases that look fine, and splits', async () => {
    const fake = fakeGraphql(population, {
      onCount: ({ queries: qs, call }) => {
        if (call !== 1) return null;
        const data = { rateLimit: RATE_LIMIT };
        qs.forEach((_, i) => (data[`c${i}`] = { userCount: 999 }));
        data.c2 = null;
        return respond(200, { data, errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['c2'] }] });
      }
    });
    const { search } = client(fake.fetchImpl);
    const counts = await search.count(queries);
    expect(counts).not.toContain(999);
    expect(fake.calls.aliases.length).toBeGreaterThan(1);
    expect(search.usage().discarded).toBe(1);
  });

  it('retries a single alias a bounded number of times, then throws with the reason', async () => {
    const { fetchImpl } = scripted([], () => respond(502, '<html></html>'));
    const { search, waits } = client(fetchImpl);
    await expect(search.count(['type:user created:2020-01-01'])).rejects.toThrow(
      /Could not count .*HTTP 502/
    );
    expect(waits).toHaveLength(2);
  });

  it('sums points from each response rateLimit.cost, not from the shared remaining figure', async () => {
    const fake = fakeGraphql(population);
    const { search } = client(fake.fetchImpl, { maxAliases: 2 });
    await search.count(queries);
    expect(search.usage()).toMatchObject({ requests: 3, points: 3, remaining: 4000 });
  });
});

describe('rate limits', () => {
  // A count for every alias the request asked for.
  const ok = (_url, init) => {
    const data = { rateLimit: RATE_LIMIT };
    Object.keys(JSON.parse(init.body).variables).forEach(
      (_, i) => (data[`c${i}`] = { userCount: 7 })
    );
    return respond(200, { data });
  };

  it('backs off on a secondary-limit 403 and retries at the same size, never splitting', async () => {
    const limited = respond(403, '{"message":"You have exceeded a secondary rate limit."}');
    const { fetchImpl, bodies } = scripted([limited, limited], ok);
    const { search, waits } = client(fetchImpl);
    const qs = ['type:user created:2020-01-01', 'type:user created:2021-01-01'];
    await expect(search.count(qs)).resolves.toBeDefined();
    expect(bodies.map(aliasCount)).toEqual([2, 2, 2]);
    expect(waits[0]).toBeGreaterThanOrEqual(60000);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it('honours retry-after', async () => {
    const limited = respond(429, '{}', { 'retry-after': '17' });
    const { fetchImpl } = scripted([limited], ok);
    const { search, waits } = client(fetchImpl);
    await search.count(['type:user']);
    expect(waits).toEqual([18000]);
  });

  it('gives up with a RateLimitError once the retries are spent', async () => {
    const limited = () => respond(403, '{"message":"secondary rate limit"}');
    const { fetchImpl } = scripted([], limited);
    const { search, waits } = client(fetchImpl);
    await expect(search.count(['type:user'])).rejects.toBeInstanceOf(RateLimitError);
    expect(waits).toHaveLength(MAX_RATE_LIMIT_RETRIES);
  });

  it('waits for the reset when the hourly budget is nearly spent', async () => {
    const now = Date.parse('2026-10-13T13:00:00Z');
    const low = () =>
      respond(200, {
        data: {
          rateLimit: { cost: 1, remaining: 10, resetAt: '2026-10-13T13:10:00Z' },
          c0: { userCount: 1 }
        }
      });
    const { fetchImpl } = scripted([], low);
    const { search, waits } = client(fetchImpl, { now: () => now });
    await search.count(['type:user']);
    expect(waits).toEqual([]);
    await search.count(['type:user']);
    expect(waits).toEqual([10 * 60 * 1000 + 5000]);
  });
});

describe('list', () => {
  const node = (i) => ({
    databaseId: 500 + i,
    login: `dev${i}`,
    createdAt: '2023-01-01T00:00:00Z'
  });
  const page = (nodes, extra = {}) =>
    respond(200, {
      data: {
        rateLimit: RATE_LIMIT,
        search: { userCount: nodes.length, pageInfo: { hasNextPage: false }, nodes }
      },
      ...extra
    });

  it('returns the page with no node scoped as not found on a clean response', async () => {
    const { search } = client(async () => page([node(1), node(2)]));
    expect(await search.list('q', { first: 100 })).toMatchObject({
      ok: true,
      userCount: 2,
      hasNextPage: false,
      notFound: []
    });
  });

  // Defect 1: NOT_FOUND on one node is evidence about that node only.
  it('keeps the rest of a page when a NOT_FOUND error is scoped to one node', async () => {
    const nodes = [node(1), null, node(3)];
    const errors = [{ type: 'NOT_FOUND', path: ['search', 'nodes', 1], message: 'gone' }];
    const { search } = client(async () => page(nodes, { errors }));
    const result = await search.list('q', { first: 100 });
    expect(result.ok).toBe(true);
    expect(result.notFound).toEqual([1]);
    expect(result.nodes).toHaveLength(3);
  });

  // Defect 1: the observed case - a partial page with every location null - must not read as data.
  it('discards the whole page for any other error, however much data came with it', async () => {
    const nodes = Array.from({ length: 94 }, (_, i) => ({ ...node(i), location: null }));
    const errors = [
      { type: 'SERVICE_UNAVAILABLE', path: ['search', 'nodes', 0, 'location'], message: 'x' },
      { type: 'NOT_FOUND', path: ['search'], message: 'not scoped to a node' }
    ];
    const { search } = client(async () => page(nodes, { errors }));
    const result = await search.list('q', { first: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SERVICE_UNAVAILABLE/);
  });

  it('reports a 502 instead of retrying it, so the caller can split the leaf', async () => {
    const { fetchImpl, bodies } = scripted([], () => respond(502, '<html></html>'));
    const { search, waits } = client(fetchImpl);
    expect(await search.list('q', { first: 100 })).toEqual({ ok: false, reason: 'HTTP 502' });
    expect(bodies).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('reports a timeout as a gateway failure', async () => {
    const hang = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    const { search } = client(hang, { timeoutMs: 5 });
    expect(await search.list('q', { first: 100 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no response within/)
    });
  });
});
