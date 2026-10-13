/**
 * GraphQL transport for discovery: batched counts and one-request listings over
 * `search(type: USER)`.
 *
 * Why GraphQL: it counts and lists on GraphQL points alone and never touches the REST search
 * budget of 30 requests a minute (verified 2026-10-13). `userCount` equals REST `total_count`, a
 * hundred counts fit in one request for one point, and a 100-row listing with basic fields costs
 * one point in about 3.5 seconds. Measured on 2026-10-13, a batch spends 20-25 points of the
 * 5,000 an hour the Actions token is given.
 *
 * Every response is classified before anything reads it, because GraphQL reports most failures
 * inside an HTTP 200:
 *
 *   ok        200 with data and no errors.
 *   partial   200 carrying `errors[]`. The caller decides what it is evidence of. The one case
 *             that is about a single result is NOT_FOUND on one search node; anything else
 *             discards the response whole. Observed: a partial listing returned `location: null`
 *             on 494 of 494 rows, which read naively is 494 developers who left Pakistan.
 *   gateway   502/503/504, a timeout, a network error, or a 200 whose body is not JSON. A 502
 *             returns HTML and costs no points; it usually means the request outran GitHub's
 *             ~10 s gateway window, so callers make it smaller rather than repeat it: an alias
 *             batch in half, a leaf into its halves.
 *   secondary 403/429 secondary rate limit. Backed off and retried at the same size, never
 *             split - splitting would only send more requests into the same limit.
 *   primary   the hourly budget is spent. Waited out until the reset.
 *   fatal     bad credentials, a malformed request: thrown, because no retry can fix it.
 *
 * Requests are sequential, paced MIN_INTERVAL_MS apart. Points are summed from each response's
 * own `rateLimit { cost }`, not from the shared remaining figure, which other jobs move too.
 */

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

/** Above about this many aliases a count request can hit GitHub's ~10 s gateway timeout. */
export const MAX_ALIASES = 100;
export const MAX_RATE_LIMIT_RETRIES = 3;
/** Retries for a request that has already been split as far as it can go. */
export const MAX_DISCARD_RETRIES = 2;
/** Below this many points left, wait for the hourly reset rather than spend the last of it. */
export const LOW_BUDGET_POINTS = 50;

const REQUEST_TIMEOUT_MS = 20000;
const MIN_INTERVAL_MS = 250;
const RETRY_BASE_MS = 5000;
// GitHub's guidance for a secondary limit: honour retry-after, and wait at least a minute
// without one. Backs off linearly, as fetch-devs.js does for REST.
const SECONDARY_MIN_WAIT_MS = 60000;

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function header(headers, name) {
  return headers?.get?.(name) ?? null;
}

/**
 * Classify one HTTP exchange. Pure, so every branch is testable without a network.
 *
 * @returns {{kind: 'ok'|'partial'|'gateway'|'secondary'|'primary'|'fatal', reason?, data?,
 *            errors?, retryAfterMs?}}
 */
export function classifyResponse(status, headers, text) {
  if (status === 200) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'gateway', reason: 'HTTP 200 with a body that is not JSON' };
    }
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.some((error) => error?.type === 'RATE_LIMITED')) {
      return { kind: 'primary', reason: 'GraphQL RATE_LIMITED', data: body?.data ?? null };
    }
    return { kind: errors.length ? 'partial' : 'ok', data: body?.data ?? null, errors };
  }

  if (status === 403 || status === 429) {
    const retryAfter = parseInt(header(headers, 'retry-after'), 10);
    const retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : null;
    if (/secondary rate limit/i.test(text) || retryAfterMs != null) {
      return { kind: 'secondary', reason: `HTTP ${status} secondary rate limit`, retryAfterMs };
    }
    if (header(headers, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(text)) {
      return { kind: 'primary', reason: `HTTP ${status} rate limit exceeded` };
    }
    if (status === 429) return { kind: 'secondary', reason: 'HTTP 429', retryAfterMs: null };
    return { kind: 'fatal', reason: `HTTP 403: ${text.slice(0, 200)}` };
  }

  if (status >= 500) return { kind: 'gateway', reason: `HTTP ${status}` };
  return { kind: 'fatal', reason: `HTTP ${status}: ${text.slice(0, 200)}` };
}

/** `type at path: message` for up to three errors, for a log line. */
export function describeErrors(errors) {
  const shown = errors.slice(0, 3).map((error) => {
    const where = Array.isArray(error?.path) ? ` at ${error.path.join('.')}` : '';
    return `${error?.type || 'error'}${where}: ${String(error?.message || '').slice(0, 120)}`;
  });
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  return `${shown.join('; ')}${more}`;
}

/** The node index an error is scoped to, when its path points into `search.nodes[i]`. */
export function nodeIndex(error) {
  const path = error?.path;
  if (!Array.isArray(path) || path[0] !== 'search' || path[1] !== 'nodes') return null;
  return Number.isInteger(path[2]) ? path[2] : null;
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

function countDocument(n) {
  const params = Array.from({ length: n }, (_, i) => `$q${i}: String!`).join(', ');
  const aliases = Array.from(
    { length: n },
    (_, i) => `c${i}: search(type: USER, query: $q${i}, first: 0) { userCount }`
  ).join('\n  ');
  return `query(${params}) {\n  rateLimit { cost remaining resetAt }\n  ${aliases}\n}`;
}

const LIST_DOCUMENT = `query($q: String!, $first: Int!) {
  rateLimit { cost remaining resetAt }
  search(type: USER, query: $q, first: $first) {
    userCount
    pageInfo { hasNextPage }
    nodes { ... on User { databaseId login createdAt } }
  }
}`;

/**
 * @param {object} options
 * @param {string} options.token
 * @param {Function} [options.fetchImpl]  defaults to the global fetch, resolved per call
 * @param {Function} [options.sleep]
 * @param {Function} [options.now]        epoch milliseconds
 * @param {number}   [options.minIntervalMs]  gap between consecutive requests
 * @param {number}   [options.maxAliases]     counts per request
 * @param {number}   [options.timeoutMs]      per request, including reading the body
 * @param {{warn: Function}} [options.log]
 */
export function createSearchClient({
  token,
  fetchImpl,
  sleep = defaultSleep,
  now = Date.now,
  minIntervalMs = MIN_INTERVAL_MS,
  maxAliases = MAX_ALIASES,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = console
} = {}) {
  if (!token) throw new Error('createSearchClient needs a token');
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const headers = {
    Authorization: `bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'rankistan-discovery'
  };
  const usage = { requests: 0, points: 0, discarded: 0, remaining: null, resetAt: null };
  let lastRequestAt = 0;

  function recordBudget(classified, responseHeaders) {
    if (header(responseHeaders, 'x-ratelimit-resource') === 'graphql') {
      const remaining = parseInt(header(responseHeaders, 'x-ratelimit-remaining'), 10);
      const reset = parseInt(header(responseHeaders, 'x-ratelimit-reset'), 10);
      if (!Number.isNaN(remaining)) usage.remaining = remaining;
      if (!Number.isNaN(reset)) usage.resetAt = reset * 1000;
    }
    const rateLimit = classified.data?.rateLimit;
    if (rateLimit) {
      if (Number.isFinite(rateLimit.cost)) usage.points += rateLimit.cost;
      if (Number.isFinite(rateLimit.remaining)) usage.remaining = rateLimit.remaining;
      const resetAt = Date.parse(rateLimit.resetAt);
      if (Number.isFinite(resetAt)) usage.resetAt = resetAt;
    }
  }

  function untilResetMs() {
    return usage.resetAt == null ? 0 : Math.max(0, usage.resetAt - now());
  }

  async function send(document, variables) {
    if (usage.remaining != null && usage.remaining < LOW_BUDGET_POINTS && untilResetMs() > 0) {
      const waitMs = untilResetMs() + 5000;
      log.warn(
        `GraphQL budget low (${usage.remaining} points left); waiting ${Math.ceil(waitMs / 1000)}s for the reset.`
      );
      await sleep(waitMs);
      usage.remaining = null;
    }
    const gap = lastRequestAt + minIntervalMs - now();
    if (gap > 0) await sleep(gap);
    lastRequestAt = now();
    usage.requests += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await doFetch(GITHUB_GRAPHQL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal
      });
      // Read as text first: a 502 is an HTML page, and response.json() would throw on it.
      text = await response.text();
    } catch (error) {
      const reason =
        error?.name === 'AbortError'
          ? `no response within ${timeoutMs / 1000}s`
          : `network error: ${error?.message}`;
      return { kind: 'gateway', reason };
    } finally {
      clearTimeout(timer);
    }

    const classified = classifyResponse(response.status, response.headers, text);
    recordBudget(classified, response.headers);
    return classified;
  }

  /** One request, with rate limits waited out. Returns ok, partial or gateway; throws otherwise. */
  async function request(document, variables) {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await send(document, variables);
      if (outcome.kind === 'secondary' || outcome.kind === 'primary') {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new RateLimitError(`${outcome.reason}, still limited after ${attempt + 1} tries`);
        }
        const waitMs =
          outcome.kind === 'secondary'
            ? (outcome.retryAfterMs ?? SECONDARY_MIN_WAIT_MS * (attempt + 1)) + 1000
            : Math.max(untilResetMs(), SECONDARY_MIN_WAIT_MS) + 5000;
        log.warn(
          `GraphQL ${outcome.reason}; waiting ${Math.ceil(waitMs / 1000)}s ` +
            `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}) and retrying at the same size.`
        );
        await sleep(waitMs);
        continue;
      }
      if (outcome.kind === 'fatal') throw new Error(`GraphQL search failed: ${outcome.reason}`);
      return outcome;
    }
  }

  async function countChunk(queries, retry = 0) {
    const variables = Object.fromEntries(queries.map((q, i) => [`q${i}`, q]));
    const outcome = await request(countDocument(queries.length), variables);
    const values =
      outcome.kind === 'ok' ? queries.map((_, i) => outcome.data?.[`c${i}`]?.userCount) : [];
    if (outcome.kind === 'ok' && values.every(isCount)) return values;

    // Not a count for every alias: a gateway failure, a 200 carrying errors, or a 200 with the
    // aliases null, which is an over-large query rather than zero. A partial response is discarded
    // whole, never trusted alias by alias, and the batch is split.
    usage.discarded += 1;
    const reason =
      outcome.kind === 'gateway'
        ? outcome.reason
        : outcome.kind === 'partial'
          ? describeErrors(outcome.errors)
          : 'HTTP 200 without a count for every alias';
    if (queries.length > 1) {
      const mid = Math.ceil(queries.length / 2);
      return [
        ...(await countChunk(queries.slice(0, mid))),
        ...(await countChunk(queries.slice(mid)))
      ];
    }
    if (retry < MAX_DISCARD_RETRIES) {
      await sleep(RETRY_BASE_MS * (retry + 1));
      return countChunk(queries, retry + 1);
    }
    throw new Error(`Could not count "${queries[0]}": ${reason}`);
  }

  /** userCount for every query, in order. Throws if any one cannot be counted. */
  async function count(queries) {
    const totals = [];
    for (let i = 0; i < queries.length; i += maxAliases) {
      totals.push(...(await countChunk(queries.slice(i, i + maxAliases))));
    }
    return totals;
  }

  /**
   * One listing request. Never retries and never throws for a failed response: it reports
   * `{ok: false, reason}` and leaves the decision to split or retry to the caller, which knows the
   * slice. On success, `notFound` holds the indices of nodes a NOT_FOUND error was scoped to.
   */
  async function list(query, { first }) {
    const outcome = await request(LIST_DOCUMENT, { q: query, first });
    if (outcome.kind === 'gateway') {
      usage.discarded += 1;
      return { ok: false, reason: outcome.reason };
    }

    const notFound = new Set();
    const other = [];
    for (const error of outcome.errors || []) {
      const index = nodeIndex(error);
      if (error?.type === 'NOT_FOUND' && index != null) notFound.add(index);
      else other.push(error);
    }
    if (other.length > 0) {
      usage.discarded += 1;
      return { ok: false, reason: `GraphQL errors: ${describeErrors(other)}` };
    }

    const search = outcome.data?.search;
    if (!search || !Number.isInteger(search.userCount) || !Array.isArray(search.nodes)) {
      usage.discarded += 1;
      return { ok: false, reason: 'the response carried no search result' };
    }
    return {
      ok: true,
      userCount: search.userCount,
      hasNextPage: search.pageInfo?.hasNextPage === true,
      nodes: search.nodes,
      notFound: [...notFound].sort((a, b) => a - b)
    };
  }

  // `sleep` is exposed so a caller's own backoff between requests runs on the same clock.
  return { count, list, sleep, usage: () => ({ ...usage }) };
}
