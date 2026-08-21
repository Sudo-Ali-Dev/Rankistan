const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_MAX_COMPLETION_TOKENS = 800;
const GROQ_TEMPERATURE = 0;
const GROQ_REASONING_EFFORT = 'low';
const GROQ_INCLUDE_REASONING = false;
const GROQ_TIMEOUT_MS = 25000;
const MIN_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 400;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_MAX_TRACKED_IPS = 10000;

const REFUSAL_PREFIXES = ["i'm sorry", 'i cannot', 'as an ai'];

const SYSTEM_PROMPT = [
  'You are writing a brief developer profile summary.',
  'Write exactly 2 sentences describing this developer based on their GitHub activity.',
  'Be specific - mention their main technologies and what kind of projects they build.',
  'Do not use bullet points. Do not start with "This developer". Write in third person.',
  // A name does not tell you someone's pronouns. The previous instruction
  // asked the model to infer gender from the name, which misgendered real
  // people on a public leaderboard (#73) - and fired even when `name` was
  // empty, leaving it nothing to reason from but a username.
  'Use they/them pronouns. Never infer gender from a name, username, location, or project.',
  'Prefer their name or "they" as the subject.'
].join(' ');

const rateLimitByIp = new Map();

function normalizeText(value, maxLength = 200) {
  const text = value == null ? '' : String(value);
  // Every value that passes through here is interpolated into the LLM prompt
  // by buildUserPrompt(). A newline lets a caller close the current field and
  // inject their own instruction lines, so collapse control characters and
  // runs of whitespace to single spaces before truncating.
  return text
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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
    stars: Number.isFinite(Number(repo?.stars)) ? Number(repo.stars) : 0
  }));
}

function sanitizeDeveloper(rawDev) {
  return {
    username: normalizeText(rawDev?.username, 80),
    name: normalizeText(rawDev?.name, 120),
    location: normalizeText(rawDev?.location, 120),
    top_languages: normalizeLanguages(rawDev?.top_languages),
    total_stars: Number.isFinite(Number(rawDev?.total_stars)) ? Number(rawDev.total_stars) : 0,
    events_30d: Number.isFinite(Number(rawDev?.events_30d)) ? Number(rawDev.events_30d) : 0,
    top_repos: normalizeTopRepos(rawDev?.top_repos)
  };
}

function formatRepoLine(repo) {
  const name = normalizeText(repo?.name, 120) || 'unknown-repo';
  const language = normalizeText(repo?.language, 40) || 'Unknown';
  const description = normalizeText(repo?.description, 260);

  if (description) {
    return `- ${name}: ${description} (${language})`;
  }

  return `- ${name} (${language})`;
}

function buildUserPrompt(dev) {
  const username = normalizeText(dev?.username, 80);
  const name = normalizeText(dev?.name, 120);

  const displayIdentity = name ? `${name} (@${username})` : `@${username}`;
  const lines = [`Developer: ${displayIdentity}`];

  const location = normalizeText(dev?.location, 120);
  if (location) {
    lines[0] = `${lines[0]} from ${location}`;
  }

  const normalizedLanguages = normalizeLanguages(dev?.top_languages);
  const languagesText = normalizedLanguages.length > 0 ? normalizedLanguages.join(', ') : 'Not specified';

  lines.push(`Top languages: ${languagesText}`);
  lines.push(`Total stars: ${Number.isFinite(Number(dev?.total_stars)) ? Number(dev.total_stars) : 0}`);
  lines.push(`Recent activity (last 30 days): ${Number.isFinite(Number(dev?.events_30d)) ? Number(dev.events_30d) : 0} events`);
  lines.push('Top projects:');

  const repos = Array.isArray(dev?.top_repos) ? dev.top_repos : [];
  if (repos.length === 0) {
    lines.push('No public repos');
  } else {
    lines.push(...repos.map(formatRepoLine));
  }

  return lines.join('\n');
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

function buildCorsHeaders(corsOrigin = '*') {
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Responses here carry a per-request ACAO and some of them are cached.
    // Without Vary, a cache can hand one origin's ACAO to a different origin.
    'Vary': 'Origin'
  };
}

function resolveCorsOrigin(request, env) {
  const configured = normalizeText(env.SUMMARY_ALLOWED_ORIGIN, 500);
  if (!configured || configured === '*') {
    return '*';
  }

  const allowedOrigins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (allowedOrigins.length === 0) {
    return '*';
  }

  const requestOrigin = normalizeText(request.headers.get('Origin'), 260);
  if (!requestOrigin) {
    return allowedOrigins[0];
  }

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
}

function jsonResponse(body, status = 200, corsOrigin = '*') {
  const headers = buildCorsHeaders(corsOrigin);

  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status, headers });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    }
  });
}

function getClientIp(request) {
  // Only CF-Connecting-IP is trustworthy here: Cloudflare sets it and a client
  // cannot forge it. x-forwarded-for used to be accepted as a fallback, which
  // made the rate-limit key caller-controlled - a request could pick a fresh
  // key every time and never be limited, while also growing the Map without
  // bound. An absent CF header now shares one bucket rather than escaping.
  const ip = request.headers.get('CF-Connecting-IP');
  return (ip && ip.trim()) || 'unknown';
}

// Cloudflare's Rate Limiting binding is the authoritative counter. The Map
// below is only a fallback: module-level state lives in a single Worker
// isolate and is neither shared nor persistent, so the old implementation
// enforced the limit per-isolate rather than per-IP (#65). Configure the
// binding in wrangler.toml; without it this endpoint is only weakly
// protected, and the leaderboard-membership check below is what actually
// caps the cost of abuse.
//
// Note the binding is authoritative per Cloudflare location, not strictly
// global - materially better than per-isolate, but not a hard global cap.
async function isRateLimited(request, env) {
  const ip = getClientIp(request);
  const limiter = env?.SUMMARY_RATE_LIMITER;

  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key: ip });
      return !success;
    } catch (error) {
      console.error('SUMMARY_RATE_LIMITER failed; falling back to in-isolate counter.', error);
    }
  }

  return isRateLimitedInIsolate(ip);
}

function isRateLimitedInIsolate(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  // Only the requesting key is read. The previous version rewrote *every*
  // entry in the Map on *every* request, so a spray of distinct keys was a
  // CPU amplifier on top of the unbounded-memory problem.
  const recent = (rateLimitByIp.get(ip) || []).filter((ts) => ts > cutoff);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitByIp.set(ip, recent);
    return true;
  }

  recent.push(now);
  rateLimitByIp.set(ip, recent);

  // Amortised eviction: sweep only once the Map exceeds the cap, so memory
  // stays bounded without paying a scan per request.
  if (rateLimitByIp.size > RATE_LIMIT_MAX_TRACKED_IPS) {
    for (const [key, timestamps] of rateLimitByIp) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        rateLimitByIp.delete(key);
      }
    }
  }

  return false;
}

const LEADERBOARD_URL = 'https://rankistan.dev/data.json';
const LEADERBOARD_CACHE_SECONDS = 300;

// Shared by /api/badge and /api/dev-summary. Returns the leaderboard entry for
// a username, or null if that developer is not ranked. Throws on a failed
// fetch so callers can distinguish "not ranked" from "lookup unavailable" -
// the badge route previously called response.json() without checking
// response.ok, so a 404 HTML body surfaced as a generic error badge.
async function findRankedDeveloper(username) {
  const response = await fetch(LEADERBOARD_URL, {
    cf: { cacheTtl: LEADERBOARD_CACHE_SECONDS }
  });

  if (!response.ok) {
    throw new Error(`Leaderboard fetch failed with ${response.status}.`);
  }

  const data = await response.json();
  const wanted = username.toLowerCase();

  return (data.leaderboard || []).find(
    (entry) => String(entry.username || '').toLowerCase() === wanted
  ) || null;
}

const GROQ_KEY_SLOTS = 8;

function readGroqKey(env, slot) {
  const value = env[`GROQ_API_KEY_${slot}`];
  return typeof value === 'string' ? value.trim() : '';
}

function getGroqApiKeys(env) {
  const keys = [];
  for (let slot = 1; slot <= GROQ_KEY_SLOTS; slot += 1) {
    const value = readGroqKey(env, slot);
    if (value) {
      keys.push(value);
    }
  }
  return keys;
}

function shouldTryNextKey(error) {
  const status = Number(error?.status || 0);
  const body = String(error?.body || '').toLowerCase();

  if (status === 429 || status === 401) {
    return true;
  }

  if (status === 403) {
    return body.includes('rate') || body.includes('quota') || body.includes('limit') || body.includes('insufficient');
  }

  return false;
}

async function callGroqOnce(dev, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
        temperature: GROQ_TEMPERATURE,
        reasoning_effort: GROQ_REASONING_EFFORT,
        include_reasoning: GROQ_INCLUDE_REASONING,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(dev) }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Groq API error ${response.status}: ${body}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    const payload = await response.json();
    return validateSummary(payload?.choices?.[0]?.message?.content);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroqWithKeyFallback(dev, apiKeys) {
  let lastError;

  for (let index = 0; index < apiKeys.length; index += 1) {
    const key = apiKeys[index];

    try {
      return await callGroqOnce(dev, key);
    } catch (error) {
      lastError = error;
      const canTryNext = shouldTryNextKey(error) && index < apiKeys.length - 1;

      if (!canTryNext) {
        break;
      }

      console.warn(`Groq key ${index + 1} failed (status ${error.status || 'n/a'}). Trying next key.`);
    }
  }

  throw lastError || new Error('All Groq keys failed.');
}

const HEATMAP_UPSTREAM = 'https://github-readme-activity-graph.vercel.app/graph';
const HEATMAP_COLOR = '50b85e';
const HEATMAP_BG = '10141a';
const HEATMAP_CACHE_SECONDS = 3600;
const HEATMAP_ERROR_MARKERS = ["Can't fetch any contribution", 'Please check your username'];
const GITHUB_USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

function isHeatmapErrorCard(svg) {
  return HEATMAP_ERROR_MARKERS.some((marker) => svg.includes(marker));
}

function buildHeatmapUpstreamUrl(username) {
  const params = new URLSearchParams({
    username,
    theme: 'react-dark',
    hide_border: 'true',
    area: 'true',
    color: HEATMAP_COLOR,
    line: HEATMAP_COLOR,
    point: HEATMAP_COLOR,
    bg_color: HEATMAP_BG
  });
  return `${HEATMAP_UPSTREAM}?${params.toString()}`;
}

// The upstream is a third party we do not control. Serve its bytes only as an
// SVG image, never with a Content-Type it chose: reflecting that header meant a
// compromised or changed upstream could return text/html and have us serve
// attacker-influenced markup from our own origin. nosniff and a deny-all CSP
// are defence in depth for the same reason (the app embeds this via <img>, so
// scripts would not run there, but a direct visit to the Worker URL would).
const HEATMAP_SVG_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cache-Control': `public, max-age=${HEATMAP_CACHE_SECONDS}`
};

async function handleHeatmapRequest(request, env) {
  const corsOrigin = resolveCorsOrigin(request, env);
  const username = new URL(request.url).pathname.split('/').pop()?.trim();

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, corsOrigin);
  }

  if (!username || !GITHUB_USERNAME_RE.test(username)) {
    return jsonResponse({ error: 'Invalid username.' }, 400, corsOrigin);
  }

  const upstreamUrl = buildHeatmapUpstreamUrl(username);
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const cacheKey = new Request(upstreamUrl, { method: 'GET' });

  // Only the SVG body is cached, with no CORS header on it. Previously the
  // cached entry carried the Access-Control-Allow-Origin of whichever origin
  // asked first, while the cache key (the upstream URL) had no Origin in it -
  // so that first caller's ACAO was replayed to everyone for an hour.
  const serve = (svg) =>
    new Response(svg, { headers: { ...buildCorsHeaders(corsOrigin), ...HEATMAP_SVG_HEADERS } });

  try {
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cached) {
      const cachedSvg = await cached.text();

      if (!isHeatmapErrorCard(cachedSvg)) {
        return serve(cachedSvg);
      }

      await cache.delete(cacheKey);
    }

    const upstream = await fetch(upstreamUrl);

    if (!upstream.ok) {
      throw new Error(`Heatmap upstream returned ${upstream.status}.`);
    }

    const svg = await upstream.text();

    if (isHeatmapErrorCard(svg)) {
      throw new Error('Heatmap upstream returned an error card.');
    }

    if (cache) {
      await cache.put(cacheKey, new Response(svg, { headers: HEATMAP_SVG_HEADERS }));
    }

    return serve(svg);
  } catch (error) {
    console.error(`Heatmap proxy failed for ${username}: ${error.message}`);
    return new Response(JSON.stringify({ error: 'Heatmap unavailable.' }), {
      status: 502,
      headers: {
        ...buildCorsHeaders(corsOrigin),
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  }
}

async function handleBadgeRequest(request, env) {
  const corsOrigin = resolveCorsOrigin(request, env);
  const username = new URL(request.url).pathname.split('/').pop()?.toLowerCase();
  const headers = {
    ...buildCorsHeaders(corsOrigin),
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${LEADERBOARD_CACHE_SECONDS}`
  };

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, corsOrigin);
  }

  // The heatmap route already validated usernames with this regex; the badge
  // route only checked for non-empty, which was an inconsistency rather than
  // an exploit. Validate before spending a leaderboard fetch on it.
  if (!username || !GITHUB_USERNAME_RE.test(username)) {
    return jsonResponse({ error: 'Invalid username.' }, 400, corsOrigin);
  }

  try {
    const dev = await findRankedDeveloper(username);

    if (!dev) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        label: 'Rankistan',
        message: 'not ranked',
        color: 'lightgrey'
      }), { headers });
    }

    return new Response(JSON.stringify({
      schemaVersion: 1,
      label: `Rankistan @${dev.username}`,
      message: `rank #${dev.rank}`,
      color: '1a7f4e',
      labelColor: '0f6e56',
      namedLogo: 'github',
      logoColor: 'white',
      cacheSeconds: LEADERBOARD_CACHE_SECONDS
    }), { headers });
  } catch (error) {
    console.error(`Badge lookup failed for ${username}: ${error.message}`);
    return new Response(JSON.stringify({
      schemaVersion: 1,
      label: 'Rankistan',
      message: 'error',
      color: 'red'
    }), { status: 502, headers });
  }
}

export default {
  async fetch(request, env) {
    const corsOrigin = resolveCorsOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return jsonResponse({}, 204, corsOrigin);
    }

    if (url.pathname.startsWith('/api/badge/')) {
      return handleBadgeRequest(request, env);
    }

    if (url.pathname.startsWith('/api/heatmap/')) {
      return handleHeatmapRequest(request, env);
    }

    if (url.pathname !== '/api/dev-summary') {
      return jsonResponse({ error: 'Not found.' }, 404, corsOrigin);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, corsOrigin);
    }

    if (await isRateLimited(request, env)) {
      return jsonResponse({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, corsOrigin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400, corsOrigin);
    }

    const rawDev = body?.dev && typeof body.dev === 'object' ? body.dev : body;
    const dev = sanitizeDeveloper(rawDev || {});

    // sanitizeDeveloper() only coerces and clamps; it never validated the
    // username, unlike the heatmap route. Validate the shape first.
    if (!dev.username || !GITHUB_USERNAME_RE.test(dev.username)) {
      return jsonResponse({ error: 'Invalid dev.username.' }, 400, corsOrigin);
    }

    // This endpoint spends real money per call, and every field below is
    // interpolated into the prompt. Serving only developers who are actually
    // on the leaderboard bounds the abuse surface to a known 1000-row set,
    // and mirrors what /api/badge already does.
    let rankedDev;
    try {
      rankedDev = await findRankedDeveloper(dev.username);
    } catch (error) {
      console.error(`Leaderboard lookup failed for ${dev.username}: ${error.message}`);
      return jsonResponse({ error: 'Leaderboard lookup unavailable.' }, 503, corsOrigin);
    }

    if (!rankedDev) {
      return jsonResponse({ error: 'Developer is not on the leaderboard.' }, 404, corsOrigin);
    }

    const apiKeys = getGroqApiKeys(env);
    if (apiKeys.length === 0) {
      return jsonResponse({ error: 'Server is missing Groq keys (set GROQ_API_KEY_1 … GROQ_API_KEY_8).' }, 500, corsOrigin);
    }

    try {
      const summary = await callGroqWithKeyFallback(dev, apiKeys);
      return jsonResponse({ summary }, 200, corsOrigin);
    } catch (error) {
      console.error(`cloudflare worker failed for ${dev.username}: ${error.message}`);
      return jsonResponse({ error: 'Failed to generate summary.' }, 502, corsOrigin);
    }
  }
};

// Exported for unit tests only. The Workers runtime uses the default export as
// its entrypoint and ignores additional named exports, so this has no runtime
// effect on the deployed Worker.
export {
  normalizeText,
  normalizeLanguages,
  normalizeTopRepos,
  sanitizeDeveloper,
  buildUserPrompt,
  truncateSummary,
  validateSummary,
  resolveCorsOrigin,
  buildCorsHeaders,
  getClientIp,
  isRateLimitedInIsolate,
  isHeatmapErrorCard,
  GITHUB_USERNAME_RE,
  RATE_LIMIT_MAX_REQUESTS
};
