const CACHE_KEYS = {
  LEADERBOARD: 'pakdev_leaderboard_v2',
  LEADERBOARD_TS: 'pakdev_leaderboard_ts_v2',
  DIGEST: 'pakdev_digest_v2',
  DIGEST_TS: 'pakdev_digest_ts_v2'
};

const TTL = {
  LEADERBOARD: 24 * 60 * 60 * 1000,
  DIGEST: 7 * 24 * 60 * 60 * 1000
};

const KEY_MAP = {
  [CACHE_KEYS.LEADERBOARD]: {
    tsKey: CACHE_KEYS.LEADERBOARD_TS,
    ttl: TTL.LEADERBOARD
  },
  [CACHE_KEYS.DIGEST]: {
    tsKey: CACHE_KEYS.DIGEST_TS,
    ttl: TTL.DIGEST
  }
};

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // silent no-op
  }
}

function getKeyMeta(cacheKey) {
  const meta = KEY_MAP[cacheKey];
  if (!meta) {
    console.warn(`[cache] Unknown cache key: ${String(cacheKey)}`);
    return null;
  }

  return meta;
}

function get(cacheKey) {
  const meta = getKeyMeta(cacheKey);
  if (!meta) {
    return null;
  }

  const tsRaw = safeGet(meta.tsKey);
  if (!tsRaw) {
    return null;
  }

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return null;
  }

  const age = Date.now() - ts;
  if (age > meta.ttl) {
    return null;
  }

  const raw = safeGet(cacheKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function set(cacheKey, data) {
  const meta = getKeyMeta(cacheKey);
  if (!meta) {
    return false;
  }

  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return false;
  }

  const wroteData = safeSet(cacheKey, serialized);
  const wroteTs = safeSet(meta.tsKey, String(Date.now()));
  return wroteData && wroteTs;
}

function isStale(cacheKey) {
  const meta = getKeyMeta(cacheKey);
  if (!meta) {
    return true;
  }

  const tsRaw = safeGet(meta.tsKey);
  if (!tsRaw) {
    return true;
  }

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return true;
  }

  const age = Date.now() - ts;
  return age > meta.ttl;
}

function clear(cacheKey) {
  const meta = getKeyMeta(cacheKey);
  if (!meta) {
    return;
  }

  safeRemove(cacheKey);
  safeRemove(meta.tsKey);
}

function clearAll() {
  Object.keys(KEY_MAP).forEach((cacheKey) => {
    clear(cacheKey);
  });
}

const cache = {
  get,
  set,
  isStale,
  clear,
  clearAll
};

export {
  cache,
  CACHE_KEYS,
  TTL,
  KEY_MAP,
  safeGet,
  safeSet,
  safeRemove,
  get,
  set,
  isStale,
  clear,
  clearAll
};
