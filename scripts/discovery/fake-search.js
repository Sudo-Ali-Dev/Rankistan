/**
 * An in-memory stand-in for GitHub's GraphQL user search, for the discovery tests only.
 *
 * It answers the two documents graphql.js sends - aliased `userCount` counts and one-page
 * listings - from a fixed population, and it reproduces the qualifier semantics measured against
 * the live API: `created:` ranges are inclusive, two `created:` qualifiers drop the filter and
 * match everyone, and repeated `followers:` qualifiers OR together. Faults are injected per call
 * through `onCount` and `onList`, which may return a replacement response.
 */
import { isoSecond, parseCreated, parseFollowers } from './partition.js';

/** Deterministic PRNG, so a failing case reproduces. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function makePopulation({ n, from, to, seed = 1, followers = () => 2, idBase = 0 }) {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: idBase + seed * 100000 + i,
    login: `User${seed}x${i}`,
    created: from + Math.floor(rand() * (to - from + 1)),
    followers: followers(rand, i)
  }));
}

export function matcher(query) {
  const tokens = query.split(/\s+/);
  const created = tokens.filter((t) => t.startsWith('created:'));
  const followers = tokens.filter((t) => t.startsWith('followers:'));
  const range =
    created.length === 1
      ? parseCreated(created[0].slice('created:'.length))
      : { from: -Infinity, to: Infinity };
  const ranges = followers.map((t) => parseFollowers(t.slice('followers:'.length)));
  return (u) =>
    u.created >= range.from &&
    u.created <= range.to &&
    (ranges.length === 0 || ranges.some(([lo, hi]) => u.followers >= lo && u.followers <= hi));
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
