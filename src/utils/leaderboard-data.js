import { cache, CACHE_KEYS } from './cache';

// One download of data.json per visit, shared by every page.
//
// Five pages used to fetch it themselves - four with `cache: 'no-store'`, which
// also bypassed the browser's HTTP cache - and a page is mounted only while its
// tab is active. So every tab switch downloaded the file again: about 400 KB
// over the wire and 1.65 MB to parse, each time. A visit that went Leaderboard
// -> Map -> Digest -> back cost 1.6 MB.
//
// GitHub Pages serves the file with `max-age=600`, so the browser cache covers
// reloads; this covers tab switches. The in-memory copy is reused for the same
// ten minutes, so a tab left open all day still picks up new data.
//
// Failure keeps what the most careful of the five pages did: fall back to the
// copy saved in localStorage, and say so through `fromCache` so the page does
// not present a saved copy as live.
export const MEMORY_MAX_AGE_MS = 10 * 60 * 1000;

let inflight = null;
let loadedAt = 0;

async function fetchFresh(fetchImpl) {
  try {
    const response = await fetchImpl('./data.json');
    if (!response.ok) throw new Error(`data.json returned ${response.status}`);
    const payload = await response.json();
    cache.set(CACHE_KEYS.LEADERBOARD, payload);
    return { payload, fromCache: false };
  } catch {
    const saved = cache.get(CACHE_KEYS.LEADERBOARD);
    if (saved) return { payload: saved, fromCache: true };
    throw new Error('Could not load data.json and no saved copy is available.');
  }
}

/** @returns {Promise<{ payload: object, fromCache: boolean }>} */
export function loadLeaderboardData({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (inflight && now - loadedAt < MEMORY_MAX_AGE_MS) return inflight;

  loadedAt = now;
  inflight = fetchFresh(fetchImpl).then(
    (result) => {
      // A saved copy stands in for this call only; the next one tries the
      // network again rather than serving the fallback for ten minutes.
      if (result.fromCache) inflight = null;
      return result;
    },
    (error) => {
      inflight = null;
      throw error;
    }
  );
  return inflight;
}

/** Test seam: forget the in-memory copy. */
export function resetLeaderboardData() {
  inflight = null;
  loadedAt = 0;
}
