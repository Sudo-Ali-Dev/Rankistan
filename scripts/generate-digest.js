import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GROQ_KEY_SLOTS = 8;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_MAX_COMPLETION_TOKENS = 1400;
const GROQ_TEMPERATURE = 0.7;
const GROQ_REASONING_EFFORT = 'low';
const GROQ_INCLUDE_REASONING = false;
const GROQ_TIMEOUT_MS = 45000;
const GROQ_RETRY_DELAY_MS = 10000;
const MIN_VALID_DIGEST_LENGTH = 100;
const MAX_REPOS_FOR_PROMPT = 40;

const REFUSAL_PREFIXES = [
  "i'm sorry",
  'i cannot',
  'as an ai'
];

const NO_REPOS_TEXT = 'No new repos this week.';
const NO_DESCRIPTIONS_TEXT = 'No new repos with descriptions this week.';

const SYSTEM_PROMPT = [
  "You are a tech journalist covering Pakistan's open source developer community.",
  'Write a 250-300 word weekly digest summarizing what Pakistani developers built',
  'this week on GitHub. Be specific - mention project names and what they do.',
  'Group related projects by theme where possible (e.g. AI/ML, Web Tools, DevOps).',
  'Write in an engaging, readable tone. Do not use bullet points - write in prose.'
].join(' ');

async function loadDotEnv(repoRoot) {
  const envPath = path.join(repoRoot, '.env');

  let content;
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^['\"]|['\"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeRepo(repo) {
  return {
    owner: String(repo?.owner || '').trim(),
    name: String(repo?.name || '').trim(),
    description: typeof repo?.description === 'string' ? repo.description.trim() : '',
    language: repo?.language == null || String(repo.language).trim() === '' ? 'Unknown' : String(repo.language).trim(),
    stars: Number.isFinite(Number(repo?.stars)) ? Number(repo.stars) : 0,
    url: String(repo?.url || '').trim()
  };
}

function flattenDigestRepos(data) {
  const leaderboard = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
  return leaderboard.flatMap((dev) => (Array.isArray(dev?.digest_repos) ? dev.digest_repos : []));
}

function dedupeReposByOwnerName(repos) {
  const repoMap = new Map();

  for (const raw of repos) {
    const repo = normalizeRepo(raw);
    if (!repo.owner || !repo.name) {
      continue;
    }

    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    const existing = repoMap.get(key);

    if (!existing || repo.stars > existing.stars) {
      repoMap.set(key, repo);
    }
  }

  return [...repoMap.values()];
}

function filterAndCapRepos(repos) {
  const withNormalizedLanguage = repos.map(normalizeRepo);

  return withNormalizedLanguage
    .filter((repo) => repo.description.length > 0)
    .sort((a, b) => b.stars - a.stars)
    .slice(0, MAX_REPOS_FOR_PROMPT);
}

function formatWeekOf(runDate = new Date()) {
  const end = new Date(runDate);
  const start = new Date(runDate);
  start.setDate(end.getDate() - 6);

  const month = (d) => d.toLocaleString('en-US', { month: 'long' });
  const day = (d) => String(d.getDate()).padStart(2, '0');
  const year = end.getFullYear();

  return `${month(start)} ${day(start)} - ${month(end)} ${day(end)}, ${year}`;
}

function buildUserPrompt(repos) {
  const lines = ['Here are the repos Pakistani developers pushed to this week:', ''];

  repos.forEach((repo, index) => {
    lines.push(`${index + 1}. ${repo.owner}/${repo.name} (${repo.language}, ${String.fromCodePoint(0x2b50)}${repo.stars})`);
    lines.push(`   ${repo.description}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function validateDigestText(text) {
  if (typeof text !== 'string') {
    throw new Error('Groq response is not a string.');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Groq response is empty.');
  }

  if (trimmed.length < MIN_VALID_DIGEST_LENGTH) {
    throw new Error(`Groq response too short (${trimmed.length} chars).`);
  }

  const lower = trimmed.toLowerCase();
  if (REFUSAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new Error('Groq response looks like a refusal/apology.');
  }

  return trimmed;
}

async function callGroqDigest(repos, apiKey) {
  const userPrompt = buildUserPrompt(repos);
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
          { role: 'user', content: userPrompt }
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
    return validateDigestText(text);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroqWithOneRetry(repos, apiKey) {
  try {
    return await callGroqDigest(repos, apiKey);
  } catch (firstError) {
    console.warn(`Groq attempt 1 failed: ${firstError.message}`);
    await new Promise((resolve) => setTimeout(resolve, GROQ_RETRY_DELAY_MS));

    try {
      return await callGroqDigest(repos, apiKey);
    } catch (secondError) {
      console.error(`Groq attempt 2 failed: ${secondError.message}`);
      throw secondError;
    }
  }
}

async function atomicWriteJson(targetPath, value) {
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, targetPath);
}

async function readDataJson(repoRoot) {
  const dataPath = path.join(repoRoot, 'public', 'data.json');
  const raw = await fs.readFile(dataPath, 'utf8');
  return JSON.parse(raw);
}

function resolveGroqApiKeyFromEnv(env) {
  for (let slot = 1; slot <= GROQ_KEY_SLOTS; slot += 1) {
    const key = env[`GROQ_API_KEY_${slot}`];
    if (typeof key === 'string' && key.trim()) {
      return { key: key.trim(), source: `GROQ_API_KEY_${slot}` };
    }
  }

  return null;
}

async function generateWeeklyDigest(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  await loadDotEnv(repoRoot);

  const apiKeyFromEnv = resolveGroqApiKeyFromEnv(process.env);
  const apiKey = options.groqApiKey || apiKeyFromEnv?.key;
  const digestPath = path.join(repoRoot, 'public', 'digest.json');

  let apiKeySource = 'none';
  if (options.groqApiKey) {
    apiKeySource = 'options.groqApiKey';
  } else if (apiKeyFromEnv) {
    apiKeySource = apiKeyFromEnv.source;
  }
  console.log(`Module 3 key source: ${apiKeySource}`);

  const data = await readDataJson(repoRoot);
  const allRepos = flattenDigestRepos(data);
  const deduped = dedupeReposByOwnerName(allRepos);
  const finalRepos = filterAndCapRepos(deduped);

  const output = {
    week_of: formatWeekOf(options.runDate || new Date()),
    generated_at: new Date().toISOString(),
    digest_text: '',
    repos: finalRepos
  };

  if (allRepos.length === 0) {
    output.digest_text = NO_REPOS_TEXT;
    await atomicWriteJson(digestPath, output);
    return output;
  }

  if (finalRepos.length === 0) {
    output.digest_text = NO_DESCRIPTIONS_TEXT;
    output.repos = [];
    await atomicWriteJson(digestPath, output);
    return output;
  }

  if (!apiKey) {
    throw new Error('Missing GROQ_API_KEY_1 … GROQ_API_KEY_8. Aborting without overwriting digest.json.');
  }

  const digestText = await callGroqWithOneRetry(finalRepos, apiKey);
  output.digest_text = digestText;

  await atomicWriteJson(digestPath, output);
  return output;
}

export {
  generateWeeklyDigest,
  flattenDigestRepos,
  dedupeReposByOwnerName,
  filterAndCapRepos,
  formatWeekOf,
  validateDigestText
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  generateWeeklyDigest()
    .then((result) => {
      console.log(`Digest generated for ${result.week_of}. Repos used: ${result.repos.length}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
