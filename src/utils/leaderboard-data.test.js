import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadLeaderboardData, resetLeaderboardData, MEMORY_MAX_AGE_MS } from './leaderboard-data';
import { cache, CACHE_KEYS } from './cache';

const PAYLOAD = { last_updated: '2026-10-13T11:36:15Z', leaderboard: [{ username: 'a', rank: 1 }] };

function okFetch(payload = PAYLOAD) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
}

describe('loadLeaderboardData', () => {
  beforeEach(() => {
    resetLeaderboardData();
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads once for five pages mounting in turn', async () => {
    // Leaderboard, Map, Digest, Register and Badge each used to fetch it, and
    // a tab switch remounts the page: that was one 400 KB download per switch.
    const fetchImpl = okFetch();
    for (let i = 0; i < 5; i += 1) await loadLeaderboardData({ fetchImpl, now: 1_000 + i });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one request between pages that mount at the same moment', async () => {
    const fetchImpl = okFetch();
    const [a, b] = await Promise.all([
      loadLeaderboardData({ fetchImpl, now: 1_000 }),
      loadLeaderboardData({ fetchImpl, now: 1_000 })
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.payload).toBe(b.payload);
  });

  it('no longer opts out of the browser cache', async () => {
    const fetchImpl = okFetch();
    await loadLeaderboardData({ fetchImpl, now: 1_000 });
    expect(fetchImpl.mock.calls[0]).toEqual(['./data.json']);
  });

  it('refetches once the in-memory copy is older than the Pages cache window', async () => {
    const fetchImpl = okFetch();
    await loadLeaderboardData({ fetchImpl, now: 1_000 });
    await loadLeaderboardData({ fetchImpl, now: 1_000 + MEMORY_MAX_AGE_MS + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the saved copy, and says it did', async () => {
    cache.set(CACHE_KEYS.LEADERBOARD, PAYLOAD);
    const failing = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const result = await loadLeaderboardData({ fetchImpl: failing, now: 1_000 });
    expect(result.fromCache).toBe(true);
    expect(result.payload.leaderboard[0].username).toBe('a');
  });

  it('treats an HTTP error like a network error', async () => {
    cache.set(CACHE_KEYS.LEADERBOARD, PAYLOAD);
    const notFound = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect((await loadLeaderboardData({ fetchImpl: notFound, now: 1_000 })).fromCache).toBe(true);
  });

  it('retries the network next time instead of serving the fallback for ten minutes', async () => {
    cache.set(CACHE_KEYS.LEADERBOARD, PAYLOAD);
    const failing = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await loadLeaderboardData({ fetchImpl: failing, now: 1_000 });
    const recovered = okFetch();
    const result = await loadLeaderboardData({ fetchImpl: recovered, now: 1_001 });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });

  it('fails with a clear message when there is no saved copy either', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await expect(loadLeaderboardData({ fetchImpl: failing, now: 1_000 })).rejects.toThrow(
      /no saved copy/
    );
  });

  it('saves a fresh download for the next visit to fall back on', async () => {
    await loadLeaderboardData({ fetchImpl: okFetch(), now: 1_000 });
    expect(cache.get(CACHE_KEYS.LEADERBOARD)?.last_updated).toBe(PAYLOAD.last_updated);
  });
});
