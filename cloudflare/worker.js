const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_MAX_TOKENS = 120;
const GROQ_TEMPERATURE = 0.5;
const GROQ_TIMEOUT_MS = 15000;
const MIN_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 400;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const REFUSAL_PREFIXES = ["i'm sorry", 'i cannot', 'as an ai'];

const SYSTEM_PROMPT = [
  'You are writing a brief developer profile summary.',
  'Write exactly 2 sentences describing this developer based on their GitHub activity.',
  'Be specific - mention their main technologies and what kind of projects they build.',
  'Do not use bullet points. Do not start with "This developer". Write in third person.',
  'Use he/him or she/her pronouns based on the developer\'s name. Pay careful attention to the name — e.g. Muhammad, Ali, Ibrahim, Ahmed, Shayan are male; Fatima, Ayesha, Noor (female name) are female.',
  'If the gender is truly ambiguous, use "they/them".'
].join(' ');

const rateLimitByIp = new Map();

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
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
  const forwarded = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  return forwarded.split(',')[0].trim() || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();

  for (const [key, timestamps] of rateLimitByIp.entries()) {
    const recent = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      rateLimitByIp.delete(key);
    } else {
      rateLimitByIp.set(key, recent);
    }
  }

  const recent = (rateLimitByIp.get(ip) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitByIp.set(ip, recent);
    return true;
  }

  recent.push(now);
  rateLimitByIp.set(ip, recent);
  return false;
}

function parseKeyList(rawValue) {
  if (typeof rawValue !== 'string') {
    return [];
  }

  return rawValue
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getGroqApiKeys(env) {
  const fromList = parseKeyList(env.GROQ_API_KEYS);
  const singles = [env.GROQ_API_KEY, env.GROQ_API_KEY_PAKDEVINDEX]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);

  const fromIndexedSecrets = Object.entries(env)
    .filter(([key]) => /^gsk_key_\d+$/i.test(key) || /^groq_api_key_\d+$/i.test(key))
    .map(([, value]) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);

  return [...new Set([...fromList, ...singles, ...fromIndexedSecrets])];
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
        max_tokens: GROQ_MAX_TOKENS,
        temperature: GROQ_TEMPERATURE,
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

export default {
  async fetch(request, env) {
    const corsOrigin = resolveCorsOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return jsonResponse({}, 204, corsOrigin);
    }

    if (url.pathname !== '/api/dev-summary') {
      return jsonResponse({ error: 'Not found.' }, 404, corsOrigin);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, corsOrigin);
    }

    const ip = getClientIp(request);
    if (isRateLimited(ip)) {
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

    if (!dev.username) {
      return jsonResponse({ error: 'Missing dev.username.' }, 400, corsOrigin);
    }

    const apiKeys = getGroqApiKeys(env);
    if (apiKeys.length === 0) {
      return jsonResponse({ error: 'Server is missing Groq keys (GROQ_API_KEYS or GROQ_API_KEY).' }, 500, corsOrigin);
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