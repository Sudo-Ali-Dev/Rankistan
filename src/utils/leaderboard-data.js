import { cache, CACHE_KEYS } from './cache';
import {
  buildDigest,
  developerFilePath,
  isBoardPayload,
  isDeveloperFileFor,
  isDigestPayload,
  toDeveloperRow
} from './split-data';

// Every page reads the leaderboard through this module, and each page asks for
// the smallest file that serves it:
//
//   loadBoard()               ./board.json      the list views     (~49 KB gzip)
//   loadDeveloperDetail(l)    /dev/<l>.json     one expanded card  (~0.8 KB)
//   loadDigest()              ./digest.json     the Digest         (~9 KB)
//   loadLeaderboardData()     ./data.json       everything         (~400 KB)
//
// The first three are derived from data.json at build time
// (scripts/build-split-data.js). Each falls back to data.json when its file is
// missing or unreadable - the Vite dev server, which serves public/ only, or a
// deploy built without the split step - so the site degrades to one larger
// download rather than to an empty page.
//
// Five pages used to fetch data.json themselves, four with `cache: 'no-store'`,
// and a page is mounted only while its tab is active, so every tab switch
// downloaded it again. GitHub Pages serves these files with `max-age=600`, so
// the browser cache covers reloads; the in-memory copies below cover tab
// switches, and are reused for the same ten minutes so a tab left open all day
// still picks up new data.
//
// Failure keeps what the most careful of the five pages did: fall back to a
// copy saved in localStorage, and say so through `fromCache` so the page does
// not present a saved copy as live.
export const MEMORY_MAX_AGE_MS = 10 * 60 * 1000;

// Set once the server has answered that the split files are not there (a 404,
// or a body that is not a split file), so the remaining loaders go straight to
// data.json instead of requesting a file per expanded card. A network failure
// says nothing about the deploy and leaves it unset.
let splitUnavailable = false;

// One shared in-flight request per resource, reused for MEMORY_MAX_AGE_MS. A
// result served from a saved copy stands in for that call only: the next call
// tries the network again rather than serving the fallback for ten minutes.
function reusable(load) {
  let inflight = null;
  let loadedAt = 0;

  function get(options) {
    if (inflight && options.now - loadedAt < MEMORY_MAX_AGE_MS) return inflight;

    loadedAt = options.now;
    const attempt = load(options).then(
      (result) => {
        if (result.fromCache && inflight === attempt) inflight = null;
        return result;
      },
      (error) => {
        if (inflight === attempt) inflight = null;
        throw error;
      }
    );
    inflight = attempt;
    return attempt;
  }

  return {
    get,
    reset() {
      inflight = null;
      loadedAt = 0;
    }
  };
}

/**
 * @returns {Promise<{ ok: true, value: object } | { ok: false, missing: boolean }>}
 *   `missing` when the server answered but the file is not there or is not a
 *   valid split file; false for a network failure or a server error.
 */
async function fetchSplitFile(fetchImpl, url, isValid) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch {
    return { ok: false, missing: false };
  }
  if (!response.ok) return { ok: false, missing: response.status === 404 };
  try {
    const value = await response.json();
    if (isValid(value)) return { ok: true, value };
  } catch {
    // The dev server answers a missing file with index.html and a 200.
  }
  return { ok: false, missing: true };
}

function newerOf(a, b) {
  if (!a || !b) return a || b || null;
  return String(b.last_updated || '') > String(a.last_updated || '') ? b : a;
}

const fullData = reusable(async ({ fetchImpl }) => {
  try {
    const response = await fetchImpl('/data.json');
    if (!response.ok) throw new Error(`data.json returned ${response.status}`);
    const payload = await response.json();
    cache.set(CACHE_KEYS.LEADERBOARD, payload);
    return { payload, fromCache: false };
  } catch {
    const saved = cache.get(CACHE_KEYS.LEADERBOARD);
    if (saved) return { payload: saved, fromCache: true };
    throw new Error('Could not load data.json and no saved copy is available.');
  }
});

/**
 * The whole published payload, every field of every row. Only the fallbacks
 * below need it; a page that does is downloading ~400 KB.
 * @returns {Promise<{ payload: object, fromCache: boolean }>}
 */
export function loadLeaderboardData({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  return fullData.get({ fetchImpl, now });
}

const board = reusable(async ({ fetchImpl, now }) => {
  const result = await fetchSplitFile(fetchImpl, '/board.json', isBoardPayload);
  if (result.ok) {
    splitUnavailable = false;
    cache.set(CACHE_KEYS.BOARD, result.value);
    return { payload: result.value, fromCache: false };
  }
  if (result.missing) splitUnavailable = true;

  // data.json carries every board field, so it serves as a board as it is.
  let full = null;
  try {
    full = await loadLeaderboardData({ fetchImpl, now });
  } catch {
    // Neither file is reachable; try the saved board below.
  }
  if (full && !full.fromCache) return full;

  const savedBoard = cache.get(CACHE_KEYS.BOARD);
  const saved = newerOf(full?.payload, isBoardPayload(savedBoard) ? savedBoard : null);
  if (saved) return { payload: saved, fromCache: true };
  throw new Error('Could not load board.json or data.json, and no saved copy is available.');
});

/**
 * Every row, with the fields the list views read (BOARD_FIELDS in
 * split-data.js). Falls back to data.json, whose rows are a superset.
 * @returns {Promise<{ payload: object, fromCache: boolean }>}
 */
export function loadBoard({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  return board.get({ fetchImpl, now });
}

const digest = reusable(async ({ fetchImpl, now }) => {
  if (!splitUnavailable) {
    const result = await fetchSplitFile(fetchImpl, '/digest.json', isDigestPayload);
    if (result.ok) {
      cache.set(CACHE_KEYS.DIGEST, result.value);
      return { payload: result.value, fromCache: false };
    }
    if (result.missing) splitUnavailable = true;
  }

  // The same function the build ran, over the same rows.
  let computed = null;
  try {
    const full = await loadLeaderboardData({ fetchImpl, now });
    computed = { payload: buildDigest(full.payload), fromCache: full.fromCache };
  } catch {
    // Neither file is reachable; try the saved digest below.
  }
  if (computed && !computed.fromCache) return computed;

  const savedDigest = cache.get(CACHE_KEYS.DIGEST);
  const saved = newerOf(computed?.payload, isDigestPayload(savedDigest) ? savedDigest : null);
  if (saved) return { payload: saved, fromCache: true };
  throw new Error('Could not load digest.json or data.json, and no saved copy is available.');
});

/**
 * The Digest's aggregates, as `summarizeDigest` in split-data.js computes them,
 * plus `last_updated`.
 * @returns {Promise<{ payload: object, fromCache: boolean }>}
 */
export function loadDigest({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  return digest.get({ fetchImpl, now });
}

const details = new Map();

function loadDetail(login) {
  return async ({ fetchImpl, now }) => {
    const path = developerFilePath(login);
    if (path && !splitUnavailable) {
      const result = await fetchSplitFile(fetchImpl, `/${path}`, (value) =>
        isDeveloperFileFor(value, login)
      );
      if (result.ok) return { developer: result.value.developer, fromCache: false };
      // One missing file says nothing about the others - the build skips a
      // login it cannot name safely, and a board cached before a deploy can
      // list someone that deploy dropped - so this leaves `splitUnavailable`.
    }

    const { payload, fromCache } = await loadLeaderboardData({ fetchImpl, now });
    const wanted = String(login).trim().toLowerCase();
    const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
    const developer = rows.find((row) => String(row?.username || '').toLowerCase() === wanted);
    if (!developer) throw new Error(`${login} is not on the leaderboard.`);
    return { developer: toDeveloperRow(developer), fromCache };
  };
}

/**
 * One developer's full published row: everything in data.json, including what
 * the board leaves out (bio, top_repos, digest_repos, linkedin_url).
 * @returns {Promise<{ developer: object, fromCache: boolean }>}
 */
export function loadDeveloperDetail(
  login,
  { fetchImpl = globalThis.fetch, now = Date.now() } = {}
) {
  const key = String(login ?? '')
    .trim()
    .toLowerCase();
  if (!key) return Promise.reject(new Error('A developer login is required.'));
  if (!details.has(key)) details.set(key, reusable(loadDetail(key)));
  return details.get(key).get({ fetchImpl, now });
}

/** Test seam: forget every in-memory copy. */
export function resetLeaderboardData() {
  fullData.reset();
  board.reset();
  digest.reset();
  details.clear();
  splitUnavailable = false;
}
