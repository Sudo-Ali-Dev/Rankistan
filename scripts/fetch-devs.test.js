import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  rateLimitWaitMs,
  MAX_RATE_LIMIT_RETRIES,
  shardQuality,
  screenFirstPage,
  passesActivityGate,
  applyActivityFilter,
  fetchDeveloperActivity
} from './fetch-devs.js';

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

describe('shardQuality', () => {
  it('stays silent for a complete listing', () => {
    expect(shardQuality({ total: 966, unique: 966, incomplete: false })).toEqual([]);
  });

  it('names a listing that came back short, the 560-of-881 case', () => {
    expect(shardQuality({ total: 881, unique: 560, incomplete: false })).toEqual([
      'paging returned 560 unique of 881 expected'
    ]);
  });

  it('names duplicates, which shrink the unique count', () => {
    // 2026-10-05: a mid-pagination rate-limit wait returned 1,000 items but
    // only 848 distinct developers.
    expect(shardQuality({ total: 1100, unique: 848, incomplete: false })[0]).toContain(
      '848 unique of 1000'
    );
  });

  it('names a shard over the search cap even when paging was clean', () => {
    expect(shardQuality({ total: 1354, unique: 1000, incomplete: false })).toEqual([
      '1354 match but only 1000 are reachable'
    ]);
  });

  it('passes on what GitHub itself flags', () => {
    expect(shardQuality({ total: 500, unique: 500, incomplete: true })).toEqual([
      'GitHub flagged incomplete_results'
    ]);
  });

  it('does not invent an expectation when the total is unknown', () => {
    expect(shardQuality({ total: null, unique: 12, incomplete: false })).toEqual([]);
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
  function stubGitHub({ pages }) {
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
          following: 1
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
