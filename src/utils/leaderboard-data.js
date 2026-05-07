import { CACHE_KEYS, cache } from './cache';

const DEFAULT_LEADERBOARD_PATH = './data.json';

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.replace(/\/+$/, '');
}

function resolveLeaderboardUrl() {
  const configuredBase = normalizeBaseUrl(import.meta.env.VITE_LEADERBOARD_API_URL);
  if (!configuredBase) {
    return DEFAULT_LEADERBOARD_PATH;
  }

  if (configuredBase.endsWith('/api/leaderboard')) {
    return configuredBase;
  }

  if (configuredBase.endsWith('/api')) {
    return `${configuredBase}/leaderboard`;
  }

  return `${configuredBase}/api/leaderboard`;
}

function computeBatchMeta(now = new Date()) {
  const utcHour = now.getUTCHours();
  const currentBatch = (utcHour + 5) % 24;
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  nextHour.setUTCHours(now.getUTCHours() + 1);
  const nextBatch = (nextHour.getUTCHours() + 5) % 24;

  return {
    currentBatch,
    nextBatch,
    nextRefreshIso: nextHour.toISOString()
  };
}

async function loadLeaderboardData() {
  let payload;
  const url = resolveLeaderboardUrl();

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      payload = await response.json();
      cache.set(CACHE_KEYS.LEADERBOARD, payload);
    }
  } catch {
    payload = null;
  }

  if (!payload) {
    payload = cache.get(CACHE_KEYS.LEADERBOARD);
  }

  if (!payload) {
    throw new Error('Failed to load leaderboard data from API and local cache.');
  }

  return payload;
}

export {
  DEFAULT_LEADERBOARD_PATH,
  resolveLeaderboardUrl,
  computeBatchMeta,
  loadLeaderboardData
};
