const SUMMARY_API_ROUTE = '/api/dev-summary';
const DEFAULT_SUMMARY_API_BASE = 'https://rankistan-summary-api.academics-ali.workers.dev';
const SUMMARY_REQUEST_TIMEOUT_MS = 15000;
const SUMMARY_RETRY_DELAY_MS = 3000;
const MIN_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 400;
const ERROR_VALUE = 'error';

const REFUSAL_PREFIXES = [
  "i'm sorry",
  'i cannot',
  'as an ai'
];

const summaryCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value, maxLength = 200) {
  const text = value == null ? '' : String(value).trim();
  return text.slice(0, maxLength);
}

function normalizeLanguages(languages) {
  if (!Array.isArray(languages)) {
    return [];
  }

  return languages
    .map((value) => normalizeText(value, 40))
    .filter((value) => value.length > 0)
    .slice(0, 8);
}

function normalizeTopRepos(repos) {
  if (!Array.isArray(repos)) {
    return [];
  }

  return repos.slice(0, 8).map((repo) => ({
    name: normalizeText(repo?.name, 120),
    description: normalizeText(repo?.description, 260),
    language: normalizeText(repo?.language, 40),
    stars: Number.isFinite(Number(repo?.stars)) ? Number(repo.stars) : 0,
    url: normalizeText(repo?.url, 220)
  }));
}

function buildDevPayload(dev) {
  return {
    username: normalizeText(dev?.username, 80),
    name: normalizeText(dev?.name, 120),
    location: normalizeText(dev?.location, 120),
    top_languages: normalizeLanguages(dev?.top_languages),
    total_stars: Number.isFinite(Number(dev?.total_stars)) ? Number(dev.total_stars) : 0,
    events_30d: Number.isFinite(Number(dev?.events_30d)) ? Number(dev.events_30d) : 0,
    top_repos: normalizeTopRepos(dev?.top_repos)
  };
}

function resolveSummaryApiUrl() {
  const configuredBase = normalizeText(import.meta.env.VITE_SUMMARY_API_URL, 260);
  const base = configuredBase || DEFAULT_SUMMARY_API_BASE;

  const normalized = base.replace(/\/+$/, '');

  // Accept either origin-only values (https://worker.workers.dev)
  // or full endpoint values (https://worker.workers.dev/api/dev-summary).
  if (normalized.endsWith(SUMMARY_API_ROUTE)) {
    return normalized;
  }

  if (normalized.endsWith('/api')) {
    return `${normalized}/dev-summary`;
  }

  return `${normalized}${SUMMARY_API_ROUTE}`;
}

function truncateSummary(text) {
  if (text.length <= MAX_SUMMARY_LENGTH) {
    return text;
  }

  const head = text.slice(0, MAX_SUMMARY_LENGTH);
  const lastBoundary = head.lastIndexOf('. ');

  if (lastBoundary !== -1) {
    return head.slice(0, lastBoundary + 1).trim();
  }

  return `${head}...`;
}

function validateSummary(text) {
  if (typeof text !== 'string') {
    throw new Error('Groq response is not a string.');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Groq response is empty.');
  }

  if (trimmed.length < MIN_SUMMARY_LENGTH) {
    throw new Error(`Groq response too short (${trimmed.length} chars).`);
  }

  const lower = trimmed.toLowerCase();
  if (REFUSAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new Error('Groq response is a refusal/apology.');
  }

  return truncateSummary(trimmed);
}

async function callSummaryApiOnce(dev) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(resolveSummaryApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dev: buildDevPayload(dev) }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Summary API error ${response.status}: ${body}`);
    }

    const payload = await response.json();
    return validateSummary(payload?.summary);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Summary request timed out after ${SUMMARY_REQUEST_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateDeveloperSummary(dev) {
  const username = String(dev?.username || '').trim();
  if (!username) {
    console.warn('Module 7: dev.username is missing - aborting summary call');
    return ERROR_VALUE;
  }

  if (summaryCache.has(username)) {
    return summaryCache.get(username);
  }

  try {
    const summary = await callSummaryApiOnce(dev);
    summaryCache.set(username, summary);
    return summary;
  } catch (firstError) {
    console.warn(`Module 7: attempt 1 failed for ${username}: ${firstError.message}`);
    await sleep(SUMMARY_RETRY_DELAY_MS);

    try {
      const summary = await callSummaryApiOnce(dev);
      summaryCache.set(username, summary);
      return summary;
    } catch (secondError) {
      console.warn(`Module 7: attempt 2 failed for ${username}: ${secondError.message}`);
      summaryCache.set(username, ERROR_VALUE);
      return ERROR_VALUE;
    }
  }
}

function clearSummaryCache() {
  summaryCache.clear();
}

export {
  SUMMARY_API_ROUTE,
  DEFAULT_SUMMARY_API_BASE,
  SUMMARY_REQUEST_TIMEOUT_MS,
  SUMMARY_RETRY_DELAY_MS,
  MIN_SUMMARY_LENGTH,
  MAX_SUMMARY_LENGTH,
  ERROR_VALUE,
  REFUSAL_PREFIXES,
  summaryCache,
  sleep,
  buildDevPayload,
  resolveSummaryApiUrl,
  truncateSummary,
  validateSummary,
  callSummaryApiOnce,
  generateDeveloperSummary,
  clearSummaryCache
};
