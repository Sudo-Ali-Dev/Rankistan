'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_MAX_TOKENS = 600;
const GROQ_TEMPERATURE = 0.7;
const GROQ_TIMEOUT_MS = 30000;
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
        max_tokens: GROQ_MAX_TOKENS,
        temperature: GROQ_TEMPERATURE,
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

async function generateWeeklyDigest(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  await loadDotEnv(repoRoot);

  const apiKeyFromEnv = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_PakDevIndex;
  const apiKey = options.groqApiKey || apiKeyFromEnv;
  const digestPath = path.join(repoRoot, 'public', 'digest.json');

  let apiKeySource = 'none';
  if (options.groqApiKey) {
    apiKeySource = 'options.groqApiKey';
  } else if (process.env.GROQ_API_KEY) {
    apiKeySource = 'GROQ_API_KEY';
  } else if (process.env.GROQ_API_KEY_PakDevIndex) {
    apiKeySource = 'GROQ_API_KEY_PakDevIndex';
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
    throw new Error('Missing GROQ_API_KEY or GROQ_API_KEY_PakDevIndex. Aborting without overwriting digest.json.');
  }

  const digestText = await callGroqWithOneRetry(finalRepos, apiKey);
  output.digest_text = digestText;

  await atomicWriteJson(digestPath, output);
  return output;
}

module.exports = {
  generateWeeklyDigest,
  flattenDigestRepos,
  dedupeReposByOwnerName,
  filterAndCapRepos,
  formatWeekOf,
  validateDigestText
};

if (require.main === module) {
  generateWeeklyDigest()
    .then((result) => {
      console.log(`Digest generated for ${result.week_of}. Repos used: ${result.repos.length}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
