/**
 * An in-memory stand-in for GitHub's GraphQL user search, for the discovery tests only.
 *
 * It answers the two documents graphql.js sends - aliased `userCount` counts and one-page
 * listings - from a fixed population, and it reproduces the qualifier semantics measured against
 * the live API: `created:` ranges are inclusive, two `created:` qualifiers drop the filter and
 * match everyone, repeated `followers:` qualifiers OR together, `location:` matches a whole token
 * of the location, repeated `location:` qualifiers OR together and `-location:` negations AND.
 * Faults are injected per call through `onCount` and `onList`, which may return a replacement
 * response.
 */
import { locationTokens } from './locations.js';
import { isoSecond, parseCreated, parseFollowers } from './partition.js';

/** Deterministic PRNG, so a failing case reproduces. */
// One batch searched as several `created:` ranges, the shape the 2025+ batch had until the table
// was rebalanced on 2026-10-13. Kept as a fixture so the multi-range path stays tested even while no
// live batch uses it.
export const MULTI_RANGE_QUERIES = Object.freeze([
  'location:pakistan type:user repos:>3 followers:>1 created:2025-01-01..2025-06-30',
  'location:pakistan type:user repos:>3 followers:>1 created:2025-07-01..2025-12-31',
  'location:pakistan type:user repos:>3 followers:>1 created:2026-01-01..2099-12-31'
]);

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Everyone is in Pakistan unless `location` says otherwise: a function of (rand, i), or text. */
export function makePopulation({
  n,
  from,
  to,
  seed = 1,
  followers = () => 2,
  location = 'Pakistan',
  idBase = 0
}) {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: idBase + seed * 100000 + i,
    login: `User${seed}x${i}`,
    created: from + Math.floor(rand() * (to - from + 1)),
    followers: followers(rand, i),
    location: typeof location === 'function' ? location(rand, i) : location
  }));
}

export function matcher(query) {
  const tokens = query.split(/\s+/);
  const created = tokens.filter((t) => t.startsWith('created:'));
  const followers = tokens.filter((t) => t.startsWith('followers:'));
  const places = tokens.filter((t) => t.startsWith('location:')).map((t) => t.slice(9));
  const excluded = tokens.filter((t) => t.startsWith('-location:')).map((t) => t.slice(10));
  const range =
    created.length === 1
      ? parseCreated(created[0].slice('created:'.length))
      : { from: -Infinity, to: Infinity };
  const ranges = followers.map((t) => parseFollowers(t.slice('followers:'.length)));
  return (u) => {
    const where = new Set(locationTokens(u.location));
    return (
      u.created >= range.from &&
      u.created <= range.to &&
      (ranges.length === 0 || ranges.some(([lo, hi]) => u.followers >= lo && u.followers <= hi)) &&
      (places.length === 0 || places.some((place) => where.has(place))) &&
      !excluded.some((place) => where.has(place))
    );
  };
}

export function respond(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

export const RATE_LIMIT = { cost: 1, remaining: 4000, resetAt: '2026-10-13T14:00:00Z' };

export function fakeGraphql(population, { onCount, onList } = {}) {
  const calls = { count: 0, list: 0, aliases: [], listed: [] };

  async function fetchImpl(_url, init) {
    const { query, variables } = JSON.parse(init.body);

    if (/\bc0: search/.test(query)) {
      calls.count += 1;
      const queries = Object.keys(variables)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map((key) => variables[key]);
      calls.aliases.push(queries.length);
      const override = onCount?.({ queries, call: calls.count });
      if (override) return override;
      const data = { rateLimit: RATE_LIMIT };
      queries.forEach((q, i) => {
        data[`c${i}`] = { userCount: population.filter(matcher(q)).length };
      });
      return respond(200, { data });
    }

    calls.list += 1;
    calls.listed.push(variables.q);
    const hits = population.filter(matcher(variables.q)).sort((a, b) => a.created - b.created);
    const body = {
      data: {
        rateLimit: RATE_LIMIT,
        search: {
          userCount: hits.length,
          pageInfo: { hasNextPage: hits.length > variables.first },
          nodes: hits.slice(0, variables.first).map((u) => ({
            databaseId: u.id,
            login: u.login,
            createdAt: isoSecond(u.created)
          }))
        }
      }
    };
    const override = onList?.({ q: variables.q, body, hits, call: calls.list });
    return override || respond(200, body);
  }

  return { fetchImpl, calls };
}
