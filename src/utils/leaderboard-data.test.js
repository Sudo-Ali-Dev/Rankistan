import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadBoard,
  loadDeveloperDetail,
  loadDeveloperHistory,
  loadDigest,
  loadLeaderboardData,
  resetLeaderboardData,
  MEMORY_MAX_AGE_MS
} from './leaderboard-data';
import { cache, CACHE_KEYS } from './cache';
import { buildBoard, buildDeveloperFile, buildDigest } from './split-data';

const PAYLOAD = { last_updated: '2026-10-13T11:36:15Z', leaderboard: [{ username: 'a', rank: 1 }] };

function okFetch(payload = PAYLOAD) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
}

function useFreshState() {
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
}

describe('loadLeaderboardData', () => {
  useFreshState();

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
    expect(fetchImpl.mock.calls[0]).toEqual(['/data.json']);
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

// A full payload and the split files the build derives from it.
const FULL = {
  last_updated: '2026-10-13T12:30:32.193Z',
  total_devs: 2,
  leaderboard: [
    {
      rank: 1,
      username: 'Ali-Dev',
      score: 900,
      bio: 'Builds compilers.',
      tags: ['Systems'],
      linkedin_url: 'https://www.linkedin.com/in/ali',
      top_repos: [{ name: 'cc', stars: 3 }],
      digest_repos: [{ owner: 'Ali-Dev', name: 'cc', stars: 3 }]
    },
    {
      rank: 2,
      username: 'sara',
      score: 800,
      bio: '',
      tags: ['Web'],
      top_repos: [],
      digest_repos: []
    }
  ]
};

const SPLIT = {
  '/board.json': buildBoard(FULL),
  '/digest.json': buildDigest(FULL),
  '/dev/ali-dev.json': buildDeveloperFile(FULL, FULL.leaderboard[0]),
  '/dev/sara.json': buildDeveloperFile(FULL, FULL.leaderboard[1])
};

const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });
// What the Vite dev server answers for a file that is not in public/.
const indexHtml = () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError("Unexpected token '<'");
  }
});

/** Serves `files` by URL; anything else is a 404. */
function serve(files) {
  return vi.fn(async (url) => {
    if (!(url in files)) return notFound();
    const body = files[url];
    if (typeof body === 'function') return body();
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
}

const offline = () =>
  vi.fn(async () => {
    throw new TypeError('network down');
  });

const urls = (fetchImpl) => fetchImpl.mock.calls.map(([url]) => url);

describe('loadBoard', () => {
  useFreshState();

  it('reads board.json and never downloads data.json', async () => {
    const fetchImpl = serve({ ...SPLIT, '/data.json': FULL });
    const { payload, fromCache } = await loadBoard({ fetchImpl, now: 1_000 });
    expect(urls(fetchImpl)).toEqual(['/board.json']);
    expect(fromCache).toBe(false);
    expect(payload.leaderboard.map((r) => r.username)).toEqual(['Ali-Dev', 'sara']);
    expect(payload.leaderboard[0]).not.toHaveProperty('bio');
  });

  it('downloads once for the four list pages mounting in turn', async () => {
    const fetchImpl = serve(SPLIT);
    for (let i = 0; i < 4; i += 1) await loadBoard({ fetchImpl, now: 1_000 + i });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once the in-memory copy is older than the Pages cache window', async () => {
    const fetchImpl = serve(SPLIT);
    await loadBoard({ fetchImpl, now: 1_000 });
    await loadBoard({ fetchImpl, now: 1_000 + MEMORY_MAX_AGE_MS + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to data.json when board.json is not deployed', async () => {
    const fetchImpl = serve({ '/data.json': FULL });
    const { payload, fromCache } = await loadBoard({ fetchImpl, now: 1_000 });
    expect(urls(fetchImpl)).toEqual(['/board.json', '/data.json']);
    expect(fromCache).toBe(false);
    expect(payload.leaderboard[0].bio).toBe('Builds compilers.');
  });

  it('falls back when the dev server answers with index.html', async () => {
    const fetchImpl = serve({ '/board.json': indexHtml, '/data.json': FULL });
    expect((await loadBoard({ fetchImpl, now: 1_000 })).payload.leaderboard).toHaveLength(2);
    expect(urls(fetchImpl)).toContain('/data.json');
  });

  it('falls back when board.json has a schema this bundle cannot read', async () => {
    const newer = { ...SPLIT['/board.json'], schema: 999 };
    const fetchImpl = serve({ '/board.json': newer, '/data.json': FULL });
    expect((await loadBoard({ fetchImpl, now: 1_000 })).payload).toEqual(FULL);
  });

  it('falls back to the saved board offline, and says it did', async () => {
    await loadBoard({ fetchImpl: serve(SPLIT), now: 1_000 });
    resetLeaderboardData();
    const result = await loadBoard({ fetchImpl: offline(), now: 2_000 });
    expect(result.fromCache).toBe(true);
    expect(result.payload.leaderboard[0].username).toBe('Ali-Dev');
  });

  it('prefers the newer of two saved copies', async () => {
    cache.set(CACHE_KEYS.LEADERBOARD, { ...FULL, last_updated: '2026-10-01T00:00:00Z' });
    cache.set(CACHE_KEYS.BOARD, SPLIT['/board.json']);
    const result = await loadBoard({ fetchImpl: offline(), now: 1_000 });
    expect(result).toEqual({ payload: SPLIT['/board.json'], fromCache: true });
  });

  it('fails with a clear message when nothing is reachable or saved', async () => {
    await expect(loadBoard({ fetchImpl: offline(), now: 1_000 })).rejects.toThrow(/no saved copy/);
  });

  it('does not save a 1.65 MB copy when the board is available', async () => {
    await loadBoard({ fetchImpl: serve(SPLIT), now: 1_000 });
    expect(cache.get(CACHE_KEYS.BOARD)?.schema).toBe(SPLIT['/board.json'].schema);
    expect(cache.get(CACHE_KEYS.LEADERBOARD)).toBeNull();
  });
});

describe('loadDeveloperDetail', () => {
  useFreshState();

  it("reads the developer's own file, by lowercased login", async () => {
    const fetchImpl = serve(SPLIT);
    const { developer, fromCache } = await loadDeveloperDetail('Ali-Dev', {
      fetchImpl,
      now: 1_000
    });
    expect(urls(fetchImpl)).toEqual(['/dev/ali-dev.json']);
    expect(fromCache).toBe(false);
    expect(developer).toEqual(FULL.leaderboard[0]);
  });

  it('reads the file once however often the card is opened', async () => {
    const fetchImpl = serve(SPLIT);
    await loadDeveloperDetail('Ali-Dev', { fetchImpl, now: 1_000 });
    await loadDeveloperDetail('ali-dev', { fetchImpl, now: 1_001 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the matching row of data.json when the file is missing', async () => {
    const { '/dev/sara.json': _missing, ...rest } = SPLIT;
    const fetchImpl = serve({ ...rest, '/data.json': FULL });
    const { developer } = await loadDeveloperDetail('SARA', { fetchImpl, now: 1_000 });
    expect(urls(fetchImpl)).toEqual(['/dev/sara.json', '/data.json']);
    expect(developer).toEqual(FULL.leaderboard[1]);
  });

  it('gives the fallback row as the file would, without the pipeline-only fields', async () => {
    const measured = {
      ...FULL,
      leaderboard: FULL.leaderboard.map((row) => ({
        ...row,
        shadow_contributions: { v: 1 },
        events_window: { fetched: 1, truncated: false, days: 60 }
      }))
    };
    const fetchImpl = serve({ '/data.json': measured });
    const { developer } = await loadDeveloperDetail('sara', { fetchImpl, now: 1_000 });
    expect(developer).toEqual(FULL.leaderboard[1]);
    expect(developer).toEqual(SPLIT['/dev/sara.json'].developer);
  });

  it('does not take a file for someone else as this developer', async () => {
    const misrouted = {
      ...SPLIT,
      '/dev/sara.json': SPLIT['/dev/ali-dev.json'],
      '/data.json': FULL
    };
    const { developer } = await loadDeveloperDetail('sara', {
      fetchImpl: serve(misrouted),
      now: 1
    });
    expect(developer.username).toBe('sara');
  });

  it('goes straight to data.json once the board showed the split files are not deployed', async () => {
    const fetchImpl = serve({ '/data.json': FULL });
    await loadBoard({ fetchImpl, now: 1_000 });
    await loadDeveloperDetail('Ali-Dev', { fetchImpl, now: 1_001 });
    await loadDeveloperDetail('sara', { fetchImpl, now: 1_002 });
    // One data.json download serves the board and both cards.
    expect(urls(fetchImpl)).toEqual(['/board.json', '/data.json']);
  });

  it('still tries the files after a network blip on board.json', async () => {
    cache.set(CACHE_KEYS.BOARD, SPLIT['/board.json']);
    await loadBoard({ fetchImpl: offline(), now: 1_000 });
    const fetchImpl = serve(SPLIT);
    await loadDeveloperDetail('sara', { fetchImpl, now: 1_001 });
    expect(urls(fetchImpl)).toEqual(['/dev/sara.json']);
  });

  it('rejects a developer who is not on the leaderboard', async () => {
    const fetchImpl = serve({ ...SPLIT, '/data.json': FULL });
    await expect(loadDeveloperDetail('nobody', { fetchImpl, now: 1_000 })).rejects.toThrow(
      /not on the leaderboard/
    );
    await expect(loadDeveloperDetail('  ', { fetchImpl, now: 1_000 })).rejects.toThrow(/required/);
  });

  it('retries after a failure instead of remembering it', async () => {
    await expect(
      loadDeveloperDetail('sara', { fetchImpl: offline(), now: 1_000 })
    ).rejects.toThrow();
    const { developer } = await loadDeveloperDetail('sara', {
      fetchImpl: serve(SPLIT),
      now: 1_001
    });
    expect(developer.username).toBe('sara');
  });
});

describe('loadDigest', () => {
  useFreshState();

  it('reads the precomputed digest.json', async () => {
    const fetchImpl = serve({ ...SPLIT, '/data.json': FULL });
    const { payload, fromCache } = await loadDigest({ fetchImpl, now: 1_000 });
    expect(urls(fetchImpl)).toEqual(['/digest.json']);
    expect(fromCache).toBe(false);
    expect(payload.topRepos.map((r) => r.name)).toEqual(['cc']);
  });

  it('computes exactly what the build wrote when digest.json is missing', async () => {
    const fetchImpl = serve({ '/data.json': FULL });
    const { payload } = await loadDigest({ fetchImpl, now: 1_000 });
    expect(payload).toEqual(SPLIT['/digest.json']);
  });

  it('falls back to the saved digest offline', async () => {
    await loadDigest({ fetchImpl: serve(SPLIT), now: 1_000 });
    resetLeaderboardData();
    const result = await loadDigest({ fetchImpl: offline(), now: 2_000 });
    expect(result).toEqual({ payload: SPLIT['/digest.json'], fromCache: true });
  });

  it('ignores a saved value that is not a digest of this schema', async () => {
    cache.set(CACHE_KEYS.DIGEST, { week: '2026-W34', stories: [] });
    await expect(loadDigest({ fetchImpl: offline(), now: 1_000 })).rejects.toThrow(/no saved copy/);
  });
});

describe('loadDeveloperHistory', () => {
  useFreshState();
  const HISTORY = {
    schema: 1,
    login: 'Ali-Dev',
    id: 1,
    today: '2026-10-21',
    points: [['2026-10-21', 1, 0, 900, null]]
  };

  it("reads the developer's own history file, once, by lowercased login", async () => {
    const fetchImpl = serve({ '/history/ali-dev.json': HISTORY });
    const { history } = await loadDeveloperHistory('Ali-Dev', { fetchImpl, now: 1_000 });
    await loadDeveloperHistory('ali-dev', { fetchImpl, now: 1_001 });
    expect(history).toEqual(HISTORY);
    expect(urls(fetchImpl)).toEqual(['/history/ali-dev.json']);
  });

  it('rejects, with nothing to fall back to, when there is no file or it is not a history', async () => {
    await expect(
      loadDeveloperHistory('sara', { fetchImpl: serve({}), now: 1_000 })
    ).rejects.toThrow(/No Rank History/);
    const wrong = serve({ '/history/bob.json': { ...HISTORY, login: 'someone-else' } });
    await expect(loadDeveloperHistory('bob', { fetchImpl: wrong, now: 1_000 })).rejects.toThrow();
  });
});
