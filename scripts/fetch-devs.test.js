import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rateLimitWaitMs,
  MAX_RATE_LIMIT_RETRIES,
  screenFirstPage,
  passesActivityGate,
  applyActivityFilter,
  fetchDeveloperActivity,
  fetchPakistaniDevelopers,
  SEARCH_BATCHES
} from './fetch-devs.js';
import { createSearchClient } from './discovery/graphql.js';
import { parseShardQuery } from './discovery/partition.js';
import { fakeGraphql, makePopulation, matcher, respond } from './discovery/fake-search.js';

describe('rateLimitWaitMs', () => {
  const headers = (map = {}) => ({ get: (k) => map[k.toLowerCase()] ?? null });
  const SECONDARY =
    '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}';

  it('honours retry-after when GitHub sends one', () => {
    expect(rateLimitWaitMs(SECONDARY, headers({ 'retry-after': '120' }))).toBe(125000);
  });

  // The regression: a secondary limit was waited out using the primary limit's
  // reset, which is in the past during a secondary block, so the wait collapsed
  // to the 5s floor and the retry walked straight back into the same block.
  it('waits at least a minute on a secondary limit, not five seconds', () => {
    const past = headers();
    expect(rateLimitWaitMs(SECONDARY, past, 0)).toBeGreaterThanOrEqual(60000);
  });

  it('backs off further on each successive attempt', () => {
    const a = rateLimitWaitMs(SECONDARY, headers(), 0);
    const b = rateLimitWaitMs(SECONDARY, headers(), 1);
    const c = rateLimitWaitMs(SECONDARY, headers(), 2);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('never waits less than a minute even when the primary reset is past', () => {
    const primary = '{"message":"API rate limit exceeded for user ID 1."}';
    expect(rateLimitWaitMs(primary, headers(), 0)).toBeGreaterThanOrEqual(60000);
  });

  it('gives more than one retry before giving up', () => {
    expect(MAX_RATE_LIMIT_RETRIES).toBeGreaterThan(1);
  });
});

const DAY = 86_400_000;
const pushEvent = (daysAgo) => ({
  type: 'PushEvent',
  created_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
  repo: { name: 'someone/project' },
  payload: {}
});
// 40 pushes, one a day: passes (>= 30 in 60 days, no gap over 30).
const activeFeed = () => Array.from({ length: 40 }, (_, i) => pushEvent(i + 0.5));
// 10 pushes: a complete feed that fails the contributions threshold.
const quietFeed = () => Array.from({ length: 10 }, (_, i) => pushEvent(i + 0.5));

describe('screenFirstPage', () => {
  it('rejects a complete feed that fails the gate', () => {
    expect(screenFirstPage(quietFeed())).toEqual({ complete: true, passes: false });
  });

  it('passes a complete feed that meets the gate', () => {
    expect(screenFirstPage(activeFeed())).toEqual({ complete: true, passes: true });
  });

  it('treats an empty feed as complete and failing', () => {
    expect(screenFirstPage([])).toEqual({ complete: true, passes: false });
  });

  it('never judges a full first page, which may continue on page 2', () => {
    const full = Array.from({ length: 100 }, (_, i) => pushEvent(i * 0.1));
    expect(screenFirstPage(full)).toEqual({ complete: false, passes: null });
  });

  it('applies the same gate as the activity filter', () => {
    const cases = [
      { total_contributions_60d: 30, longest_gap_days: 30 },
      { total_contributions_60d: 29, longest_gap_days: 1 },
      { total_contributions_60d: 90, longest_gap_days: 31 }
    ];
    for (const c of cases) {
      expect(applyActivityFilter([c]).length === 1).toBe(passesActivityGate(c));
    }
  });
});

describe('fetchDeveloperActivity', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A fake GitHub that records every request path.
  function stubGitHub({ pages, location = '' }) {
    const seen = [];
    vi.stubGlobal('fetch', async (url) => {
      const path = String(url).replace('https://api.github.com', '');
      seen.push(path);
      let body;
      let status = 200;
      const eventsPage = /\/events\?.*page=(\d+)/.exec(path);
      if (eventsPage) body = pages[Number(eventsPage[1]) - 1] ?? [];
      else if (path.includes('/repos?')) body = [];
      else if (path.includes('/social_accounts')) body = [];
      else if (/^\/users\/[^/?]+$/.test(path)) {
        body = {
          login: 'dev',
          created_at: '2020-01-01T00:00:00Z',
          public_repos: 10,
          followers: 5,
          following: 1,
          location
        };
      } else status = 404;
      return {
        ok: status === 200,
        status,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body ?? {})
      };
    });
    return seen;
  }

  it('rejects a quiet developer after one request instead of four', async () => {
    const seen = stubGitHub({ pages: [quietFeed()] });
    const result = await fetchDeveloperActivity('dev', 'token');
    expect(result).toEqual({ screenedOut: true, username: 'dev' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/events?');
  });

  it('fetches the full profile for an active developer, without a needless page 2', async () => {
    const seen = stubGitHub({ pages: [activeFeed()] });
    const result = await fetchDeveloperActivity('dev', 'token');
    expect(result.username).toBe('dev');
    expect(result.total_contributions_60d).toBe(40);
    expect(seen.some((p) => p.includes('page=2'))).toBe(false);
    expect(seen.some((p) => /^\/users\/dev$/.test(p))).toBe(true);
  });

  it('reaches the same verdict the full fetch would', async () => {
    // The screen reads exactly the events the full path would have read for a
    // short feed, so a passing developer's gate metrics are unchanged by it.
    stubGitHub({ pages: [activeFeed()] });
    const result = await fetchDeveloperActivity('dev', 'token');
    expect(passesActivityGate(result)).toBe(true);
  });

  it('still reads page 2 when page 1 is full', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pushEvent(i * 0.3));
    const seen = stubGitHub({ pages: [full, quietFeed()] });
    await fetchDeveloperActivity('dev', 'token');
    expect(seen.some((p) => p.includes('page=2'))).toBe(true);
  });

  it('does not count a city-sourced developer whose location names a place abroad', async () => {
    const seen = stubGitHub({ pages: [activeFeed()], location: 'Hyderabad, India' });
    const result = await fetchDeveloperActivity('dev', 'token', { source: 'city' });
    expect(result).toEqual({
      locationRejected: true,
      username: 'dev',
      location: 'Hyderabad, India',
      reason: 'found by a Pakistani city name, but the location also names "india"'
    });
    // Settled by the profile, before repos and social accounts are fetched.
    expect(seen.some((p) => p.includes('/repos?') || p.includes('/social_accounts'))).toBe(false);
  });

  it('keeps a city-sourced developer in Pakistan and records how they were found', async () => {
    stubGitHub({ pages: [activeFeed()], location: 'Lahore' });
    const result = await fetchDeveloperActivity('dev', 'token', { source: 'city' });
    expect(result.location).toBe('Lahore');
    expect(result.discovery_source).toBe('city');
  });

  it('never re-checks a developer location:pakistan found', async () => {
    stubGitHub({ pages: [activeFeed()], location: 'Pakistan · ex-India' });
    const result = await fetchDeveloperActivity('dev', 'token', { source: 'pakistan' });
    expect(result.discovery_source).toBe('pakistan');
    expect(result.locationRejected).toBeUndefined();
  });

  it('records no source when it was not told one', async () => {
    stubGitHub({ pages: [activeFeed()], location: 'Lahore' });
    const result = await fetchDeveloperActivity('dev', 'token');
    expect(Object.hasOwn(result, 'discovery_source')).toBe(false);
  });

  it('reports an unknown login as not found rather than ineligible', async () => {
    // By login, a 404 may be a rename: the merge's two-miss rule decides.
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '{}'
    }));
    expect(await fetchDeveloperActivity('gone', 'token')).toBeNull();
  });
});

describe('fetchPakistaniDevelopers discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches only the candidates of complete leaves, and names the leaf that was not', async () => {
    const batchIndex = 16;
    const { root } = parseShardQuery(SEARCH_BATCHES[batchIndex].q);
    // Small, because every candidate costs a paced REST call below.
    const people = makePopulation({ n: 12, from: root.from, to: root.to, seed: 3 });
    // One developer comes back null in every listing that includes them. Discovery corners them
    // in a small leaf, and only that leaf goes unlisted.
    const broken = people[5].id;
    const fake = fakeGraphql(people, {
      onList: ({ body }) => {
        const nodes = body.data.search.nodes;
        body.data.search.nodes = nodes.map((n) => (n.databaseId === broken ? null : n));
        return null;
      }
    });
    const searchClient = createSearchClient({
      token: 't',
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
      minIntervalMs: 0,
      log: { warn() {} }
    });

    // Every REST events feed is empty, so each candidate is screened out after one call.
    const fetched = [];
    vi.stubGlobal('fetch', async (url) => {
      fetched.push(/\/users\/([^/]+)\/events/.exec(String(url))[1]);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    });
    const warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((line) => warnings.push(String(line)));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-discovery-'));
    const result = await fetchPakistaniDevelopers({
      token: 't',
      repoRoot,
      batchIndex,
      rawOnly: true,
      withScreening: true,
      searchClient
    });

    // The warning names the leaf, and that leaf is exactly who was not fetched.
    const named = warnings
      .map((line) =>
        /^::warning title=Discovery::PK Dec2022-Feb2023: leaf (\S+ \S+) is incomplete/.exec(line)
      )
      .filter(Boolean);
    expect(named).toHaveLength(1);
    const failedLeaf = `location:pakistan type:user repos:>3 ${named[0][1]}`;
    const unlisted = new Set(people.filter(matcher(failedLeaf)).map((u) => u.login.toLowerCase()));
    expect(unlisted.has(people[5].login.toLowerCase())).toBe(true);
    expect(unlisted.size).toBeLessThan(people.length);
    expect(fetched.filter((login) => unlisted.has(login))).toEqual([]);
    expect(fetched.length + unlisted.size).toBe(people.length);
    expect(result.screenedOut).toHaveLength(fetched.length);
    expect(result.discoveryComplete).toBe(false);
  });

  it('fails the run when nobody in a batch lists completely', async () => {
    const { root } = parseShardQuery(SEARCH_BATCHES[16].q);
    const people = makePopulation({ n: 10, from: root.from, to: root.to, seed: 9 });
    const fake = fakeGraphql(people, {
      onList: ({ body }) => {
        body.data.search.nodes = body.data.search.nodes.map(() => null);
        return null;
      }
    });
    const searchClient = createSearchClient({
      token: 't',
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
      minIntervalMs: 0,
      log: { warn() {} }
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      fetchPakistaniDevelopers({
        token: 't',
        repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-discovery-')),
        batchIndex: 16,
        rawOnly: true,
        withScreening: true,
        searchClient
      })
    ).rejects.toThrow(/listed none of its 10 developers completely/);
  });
});

describe('fetchPakistaniDevelopers with the city twin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const batchIndex = 16;
  const { root } = parseShardQuery(SEARCH_BATCHES[batchIndex].q);
  const isTwin = (q) => q.includes('-location:pakistan');

  function searchFor(people, hooks) {
    const fake = fakeGraphql(people, hooks);
    return createSearchClient({
      token: 't',
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
      minIntervalMs: 0,
      log: { warn() {} }
    });
  }

  // A REST GitHub over the same people: every feed passes the screen, and the profile reports
  // the person's location as it is at fetch time.
  function stubRest(people) {
    const byLogin = new Map(people.map((u) => [u.login.toLowerCase(), u]));
    const requested = [];
    vi.stubGlobal('fetch', async (url) => {
      const [, login, rest = ''] = /^\/users\/([^/?]+)(.*)$/.exec(
        String(url).replace('https://api.github.com', '')
      );
      const person = byLogin.get(login.toLowerCase());
      let body = [];
      if (rest.startsWith('/events')) {
        requested.push(login);
        body = activeFeed();
      } else if (rest === '') {
        body = {
          login: person.login,
          location: person.location,
          created_at: '2020-01-01T00:00:00Z',
          public_repos: 10,
          followers: 5,
          following: 1
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body)
      };
    });
    return requested;
  }

  function quietConsole() {
    const warnings = [];
    const logs = [];
    vi.spyOn(console, 'warn').mockImplementation((line) => warnings.push(String(line)));
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));
    return { warnings, logs };
  }

  const run = (searchClient) =>
    fetchPakistaniDevelopers({
      token: 't',
      repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-discovery-')),
      batchIndex,
      rawOnly: true,
      withScreening: true,
      searchClient
    });

  const where = ['Pakistan', 'Lahore', 'Karachi, Sindh', 'Lahore, India', 'Berlin'];
  const people = () =>
    makePopulation({
      n: 10,
      from: root.from,
      to: root.to,
      seed: 21,
      location: (_, i) => where[i % where.length]
    });
  const source = (result) =>
    Object.fromEntries(result.developers.map((d) => [d.username, d.discovery_source]));

  it('unites both searches by databaseId and records which one found each developer', async () => {
    const population = people();
    // This developer drops "Pakistan" from their location between the two searches, so both
    // list them: they count once, as the main query found them.
    const moved = population[0];
    const fake = {
      onCount: ({ queries }) => {
        if (queries.some(isTwin)) moved.location = 'Lahore';
        return null;
      }
    };
    const requested = stubRest(population);
    const { logs } = quietConsole();

    const result = await run(searchFor(population, fake));

    expect(result.discoveryComplete).toBe(true);
    expect(requested).toHaveLength(new Set(requested).size);
    const expected = {};
    population.forEach((u, i) => {
      const at = where[i % where.length];
      if (at === 'Pakistan') expected[u.login] = 'pakistan';
      if (at === 'Lahore' || at === 'Karachi, Sindh') expected[u.login] = 'city';
    });
    expect(source(result)).toEqual(expected);
    expect(logs.some((line) => /1 city candidate\(s\) were also listed/.test(line))).toBe(true);

    // Found by "Lahore", then ruled out on the location the profile gives.
    const abroad = population.filter((u) => u.location === 'Lahore, India');
    expect(result.locationRejected.map((r) => r.username).sort()).toEqual(
      abroad.map((u) => u.login.toLowerCase()).sort()
    );
    expect(result.locationRejected[0].reason).toMatch(/also names "india"/);
    expect(logs.some((line) => /^Not counting .*also names "india"/.test(line))).toBe(true);
    // Berlin matches neither search and is never fetched.
    const berlin = new Set(population.filter((u) => u.location === 'Berlin').map((u) => u.login));
    expect(requested.some((login) => berlin.has(login))).toBe(false);
  });

  it('reports discovery incomplete when only the city twin is', async () => {
    const population = people();
    const hidden = population.find((u) => u.location === 'Lahore').id;
    const fake = {
      onList: ({ q, body }) => {
        if (!isTwin(q)) return null;
        body.data.search.nodes = body.data.search.nodes.map((n) =>
          n?.databaseId === hidden ? null : n
        );
        return null;
      }
    };
    stubRest(population);
    const { warnings } = quietConsole();

    const result = await run(searchFor(population, fake));

    expect(result.discoveryComplete).toBe(false);
    expect(
      warnings.some((line) => /PK Dec2022-Feb2023 cities: leaf .* is incomplete/.test(line))
    ).toBe(true);
    // The main query's developers are all measured all the same.
    const main = population.filter((u) => u.location === 'Pakistan').map((u) => u.login);
    expect(result.developers.map((d) => d.username)).toEqual(expect.arrayContaining(main));
  });

  it('publishes the batch from the main query when the twin cannot be counted at all', async () => {
    const population = people();
    const fake = {
      onCount: ({ queries }) =>
        queries.some(isTwin) ? respond(502, '<html>Bad gateway</html>') : null
    };
    stubRest(population);
    const { warnings } = quietConsole();

    const result = await run(searchFor(population, fake));

    expect(result.discoveryComplete).toBe(false);
    expect(
      warnings.some((line) =>
        /^::warning title=Discovery::PK Dec2022-Feb2023 cities: could not be measured/.test(line)
      )
    ).toBe(true);
    expect(Object.values(source(result))).toEqual(
      population.filter((u) => u.location === 'Pakistan').map(() => 'pakistan')
    );
  });

  it('still fails the run when the main query cannot be counted', async () => {
    const population = people();
    const fake = {
      onCount: ({ queries }) =>
        queries.some(isTwin) ? null : respond(502, '<html>Bad gateway</html>')
    };
    stubRest(population);
    quietConsole();
    await expect(run(searchFor(population, fake))).rejects.toThrow(
      /Discovery failed for batch "PK Dec2022-Feb2023"/
    );
  });
});
