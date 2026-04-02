const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_MAX_TOKENS = 120;
const GROQ_TEMPERATURE = 0.5;
const GROQ_TIMEOUT_MS = 15000;
const GROQ_RETRY_DELAY_MS = 3000;
const MIN_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 400;
const ERROR_VALUE = 'error';

const REFUSAL_PREFIXES = [
  "i'm sorry",
  'i cannot',
  'as an ai'
];

const SYSTEM_PROMPT = [
  'You are writing a brief developer profile summary.',
  'Write exactly 2 sentences describing this developer based on their GitHub activity.',
  'Be specific - mention their main technologies and what kind of projects they build.',
  'Do not use bullet points. Do not start with "This developer". Write in third person.',
  'Use he/him or she/her pronouns based on the developer\'s name. Pay careful attention to the name — e.g. Muhammad, Ali, Ibrahim, Ahmed are male; Fatima, Ayesha, Noor (female name) are female.',
  'If the gender is truly ambiguous, use "they/them".'
].join(' ');

const summaryCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeName(dev) {
  const name = typeof dev?.name === 'string' ? dev.name.trim() : '';
  return name;
}

function normalizeLanguages(dev) {
  const langs = Array.isArray(dev?.top_languages)
    ? dev.top_languages
      .map((value) => (value == null ? '' : String(value).trim()))
      .filter((value) => value.length > 0)
    : [];

  return langs.length > 0 ? langs.join(', ') : 'Not specified';
}

function formatRepoLine(repo) {
  const name = String(repo?.name || 'unknown-repo').trim() || 'unknown-repo';
  const language = repo?.language == null || String(repo.language).trim() === ''
    ? 'Unknown'
    : String(repo.language).trim();
  const description = typeof repo?.description === 'string' ? repo.description.trim() : '';

  if (description) {
    return `- ${name}: ${description} (${language})`;
  }

  return `- ${name} (${language})`;
}

function formatTopProjects(dev) {
  const repos = Array.isArray(dev?.top_repos) ? dev.top_repos : [];
  if (repos.length === 0) {
    return 'No public repos';
  }

  const lines = repos.map(formatRepoLine);
  return lines.join('\n');
}

function buildUserPrompt(dev) {
  const username = String(dev?.username || '').trim();
  const name = normalizeName(dev);

  const displayIdentity = name ? `${name} (@${username})` : `@${username}`;
  const lines = [`Developer: ${displayIdentity}`];

  if (typeof dev?.location === 'string' && dev.location.trim()) {
    lines[0] = `${lines[0]} from ${dev.location.trim()}`;
  }

  lines.push(`Top languages: ${normalizeLanguages(dev)}`);
  lines.push(`Total stars: ${Number.isFinite(Number(dev?.total_stars)) ? Number(dev.total_stars) : 0}`);
  lines.push(`Recent activity (last 30 days): ${Number.isFinite(Number(dev?.events_30d)) ? Number(dev.events_30d) : 0} events`);
  lines.push('Top projects:');
  lines.push(formatTopProjects(dev));

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
      throw new Error(`Groq API error ${response.status}: ${body}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    return validateSummary(text);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms.`);
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

  const apiKey = import.meta.env.VITE_GROQ_KEY;
  if (!apiKey) {
    console.warn('Module 7: VITE_GROQ_KEY is missing from build');
    summaryCache.set(username, ERROR_VALUE);
    return ERROR_VALUE;
  }

  try {
    const summary = await callGroqOnce(dev, apiKey);
    summaryCache.set(username, summary);
    return summary;
  } catch (firstError) {
    console.warn(`Module 7: attempt 1 failed for ${username}: ${firstError.message}`);
    await sleep(GROQ_RETRY_DELAY_MS);

    try {
      const summary = await callGroqOnce(dev, apiKey);
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
  GROQ_API_URL,
  GROQ_MODEL,
  GROQ_MAX_TOKENS,
  GROQ_TEMPERATURE,
  GROQ_TIMEOUT_MS,
  GROQ_RETRY_DELAY_MS,
  MIN_SUMMARY_LENGTH,
  MAX_SUMMARY_LENGTH,
  ERROR_VALUE,
  REFUSAL_PREFIXES,
  SYSTEM_PROMPT,
  summaryCache,
  sleep,
  buildUserPrompt,
  truncateSummary,
  validateSummary,
  callGroqOnce,
  generateDeveloperSummary,
  clearSummaryCache
};
