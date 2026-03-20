'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const GITHUB_API_BASE = 'https://api.github.com';
const SEARCH_DELAY_MS = 2000;
const MAX_DEVELOPERS = 300;
const USER_EVENTS_PER_PAGE = 90;
const INACTIVE_DAYS_CUTOFF = 90;
const MIN_ACCOUNT_AGE_DAYS = 30;
const REQUEST_TIMEOUT_MS = 20000;

const LOCATION_QUERIES = [
  'location:Pakistan',
  'location:Lahore',
  'location:Karachi',
  'location:Islamabad',
  'location:Rawalpindi',
  'location:Peshawar',
  'location:Faisalabad',
  'location:PK'
];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysSince(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

async function githubRequest(endpoint, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pakdev-index-fetch-devs'
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms for ${endpoint}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status} for ${endpoint}: ${body}`);
  }

  return response.json();
}

async function loadRegisteredDevelopers(repoRoot) {
  const registeredPath = path.join(repoRoot, 'public', 'registered_devs.json');

  try {
    const raw = await fs.readFile(registeredPath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim().replace(/^@/, '');
        }

        if (entry && typeof entry.username === 'string') {
          return entry.username.trim().replace(/^@/, '');
        }

        return '';
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function dedupeUsernames(usernames) {
  const seen = new Set();
  const deduped = [];

  for (const username of usernames) {
    const normalized = username.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

async function discoverUsersByLocation(token) {
  const discovered = [];

  for (let index = 0; index < LOCATION_QUERIES.length; index += 1) {
    const query = LOCATION_QUERIES[index];
    console.log(`[discover ${index + 1}/${LOCATION_QUERIES.length}] ${query}`);

    const endpoint = `/search/users?q=${encodeURIComponent(query)}&per_page=100&page=1`;
    const result = await githubRequest(endpoint, token);

    for (const item of result.items || []) {
      if (item && typeof item.login === 'string') {
        discovered.push(item.login);
      }
    }

    if (index < LOCATION_QUERIES.length - 1) {
      await sleep(SEARCH_DELAY_MS);
    }
  }

  return discovered;
}

function isLikelyFakeFromProfile(profile) {
  if (!profile) {
    return true;
  }

  const hasNoRepos = (profile.public_repos || 0) === 0;
  const hasNoNetwork = (profile.followers || 0) === 0 && (profile.following || 0) === 0;
  const isVeryNewAccount = daysSince(profile.created_at) < MIN_ACCOUNT_AGE_DAYS;

  return hasNoRepos || hasNoNetwork || isVeryNewAccount;
}

function extractRecentEvents(events, maxAgeDays) {
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  return (events || []).filter((event) => {
    const createdAt = new Date(event.created_at).getTime();
    return now - createdAt <= maxAgeMs;
  });
}

function extractReposPushedInLast7Days(events) {
  const recentPushes = extractRecentEvents(
    (events || []).filter((e) => e.type === 'PushEvent'),
    7
  );

  const repoMap = new Map();
  for (const event of recentPushes) {
    const fullName = event.repo?.name;
    if (!fullName || repoMap.has(fullName)) {
      continue;
    }

    const [owner, name] = fullName.split('/');
    repoMap.set(fullName, {
      owner,
      name,
      full_name: fullName,
      pushed_at: event.created_at
    });
  }

  return [...repoMap.values()];
}

async function fetchDeveloperActivity(username, token) {
  const [profile, events] = await Promise.all([
    githubRequest(`/users/${encodeURIComponent(username)}`, token),
    githubRequest(
      `/users/${encodeURIComponent(username)}/events/public?per_page=${USER_EVENTS_PER_PAGE}&page=1`,
      token
    )
  ]);

  if (isLikelyFakeFromProfile(profile)) {
    return null;
  }

  const eventsLast90Days = extractRecentEvents(events, INACTIVE_DAYS_CUTOFF);
  if (eventsLast90Days.length === 0) {
    return null;
  }

  const eventsLast30Days = extractRecentEvents(events, 30);

  return {
    username: profile.login,
    name: profile.name || '',
    avatar: profile.avatar_url,
    bio: profile.bio || '',
    location: profile.location || '',
    followers: profile.followers || 0,
    following: profile.following || 0,
    public_repos: profile.public_repos || 0,
    created_at: profile.created_at,
    events_30d: eventsLast30Days.length,
    events_90d: eventsLast90Days.length,
    repos_pushed_7d: extractReposPushedInLast7Days(eventsLast90Days),
    raw_events_90d: eventsLast90Days
  };
}

async function fetchPakistaniDevelopers(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  await loadDotEnv(repoRoot);

  const token = options.token || process.env.MY_GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GitHub token. Set MY_GITHUB_PAT in .env or pass options.token.');
  }

  const discoveredUsers = await discoverUsersByLocation(token);
  const registeredUsers = await loadRegisteredDevelopers(repoRoot);

  const merged = dedupeUsernames([...discoveredUsers, ...registeredUsers]);
  const limited = merged.slice(0, MAX_DEVELOPERS);

  console.log(`Discovered ${discoveredUsers.length} users from location search.`);
  console.log(`Loaded ${registeredUsers.length} registered users.`);
  console.log(`Processing ${limited.length} unique users (cap ${MAX_DEVELOPERS}).`);

  const developers = [];

  for (let index = 0; index < limited.length; index += 1) {
    const username = limited[index];
    if (index % 10 === 0) {
      console.log(`[fetch ${index + 1}/${limited.length}] ${username}`);
    }

    try {
      const dev = await fetchDeveloperActivity(username, token);
      if (dev) {
        developers.push(dev);
      }
    } catch (error) {
      // Continue processing if one user fails due to API or data issues.
      console.error(`Skipping ${username}: ${error.message}`);
    }
  }

  return developers;
}

module.exports = {
  fetchPakistaniDevelopers,
  LOCATION_QUERIES,
  MAX_DEVELOPERS
};

if (require.main === module) {
  console.log('Starting PakDev developer fetch...');
  fetchPakistaniDevelopers()
    .then((developers) => {
      console.log(`Fetched ${developers.length} valid developers.`);
      console.log(JSON.stringify(developers.slice(0, 3), null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
