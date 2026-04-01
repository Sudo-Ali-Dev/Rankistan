'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const GITHUB_API_BASE = 'https://api.github.com';
const SEARCH_DELAY_MS = 2000;
const SEARCH_RETRY_DELAY_MS = 3000;
const MAX_DEVELOPERS = 300;
const PRELIMINARY_MAX_DEVELOPERS = 2500;
const USER_EVENTS_PER_PAGE = 100;
const USER_EVENTS_MAX_PAGES = 1;
const USER_REPOS_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10;
const INACTIVE_DAYS_CUTOFF = 90;
const MIN_ACCOUNT_AGE_DAYS = 30;

const ACTIVITY_THRESHOLDS = {
  MIN_CONTRIBUTIONS_90D: 25,
  MIN_ACTIVE_WEEKS: 4,
  MAX_INACTIVITY_GAP_DAYS: 30
};
const REQUEST_TIMEOUT_MS = 20000;
const RATE_LIMIT_RETRY_DELAY_MS = 60000;
const USER_CALL_DELAY_MIN_MS = 100;
const USER_CALL_DELAY_MAX_MS = 150;

const MEANINGFUL_EVENT_TYPES = new Set([
  'PushEvent',
  'PullRequestEvent',
  'IssuesEvent',
  'ReleaseEvent'
]);

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

function randomDelayMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function daysSince(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function computeActivityMetrics(rawEvents90d) {
  const now = Date.now();
  const NINETY_DAYS_MS = INACTIVE_DAYS_CUTOFF * 24 * 60 * 60 * 1000;
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const meaningful = (rawEvents90d || []).filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type));
  const totalContributions = meaningful.length;

  const weekBuckets = new Set();
  for (const event of meaningful) {
    const eventTime = new Date(event.created_at).getTime();
    const weeksAgo = Math.floor((now - eventTime) / ONE_WEEK_MS);
    if (weeksAgo < 12) {
      weekBuckets.add(weeksAgo);
    }
  }

  const activeWeeks = weekBuckets.size;

  const timestamps = meaningful
    .map((e) => new Date(e.created_at).getTime())
    .filter((t) => t >= now - NINETY_DAYS_MS)
    .sort((a, b) => a - b);

  let longestGapDays = INACTIVE_DAYS_CUTOFF;

  if (timestamps.length > 0) {
    const periodStart = now - NINETY_DAYS_MS;
    longestGapDays = Math.floor((timestamps[0] - periodStart) / (1000 * 60 * 60 * 24));

    for (let i = 1; i < timestamps.length; i += 1) {
      const gap = Math.floor((timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60 * 24));
      longestGapDays = Math.max(longestGapDays, gap);
    }

    const gapToNow = Math.floor((now - timestamps[timestamps.length - 1]) / (1000 * 60 * 60 * 24));
    longestGapDays = Math.max(longestGapDays, gapToNow);
  }

  return {
    total_contributions_90d: totalContributions,
    active_weeks_12: activeWeeks,
    longest_gap_days: longestGapDays
  };
}

async function githubRequest(endpoint, token, options = {}) {
  const { allow404 = false, retriedAfter429 = false } = options;

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

  if (response.status === 404 && allow404) {
    return null;
  }

  if (response.status === 429 && !retriedAfter429) {
    console.warn(`Rate limited on ${endpoint}; waiting 60s and retrying once.`);
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    return githubRequest(endpoint, token, {
      ...options,
      retriedAfter429: true
    });
  }

  if (!response.ok) {
    const body = await response.text();
    // GitHub Search API returns 403 (Forbidden) instead of 429 when rate limit is exceeded
    if (response.status === 403 && body.includes('API rate limit exceeded') && !retriedAfter429) {
      console.warn(`Search Rate limited (403) on ${endpoint}; waiting 65s and retrying once.`);
      // Wait 65 seconds just to be absolutely safe the minute window resets
      await sleep(RATE_LIMIT_RETRY_DELAY_MS + 5000);
      return githubRequest(endpoint, token, {
        ...options,
        retriedAfter429: true
      });
    }
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
    console.log(`[discover ${index + 1}/${LOCATION_QUERIES.length}] ${query} (pages 1-${SEARCH_MAX_PAGES})`);

    let success = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
          const endpoint = `/search/users?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
          const result = await githubRequest(endpoint, token);

          const items = result.items || [];
          for (const item of items) {
            if (item && typeof item.login === 'string') {
              discovered.push(item.login);
            }
          }

          if (items.length < 100) {
            break;
          }
          
          // The Search API restricts authenticated users to exactly 30 requests per minute
          // We sleep for 2.1 seconds between every page to stay under the limit cleanly.
          await sleep(2100);
        }

        success = true;
        break;
      } catch (error) {
        if (attempt === 1) {
          console.warn(`Search failed for ${query}; retrying once after 3s. Reason: ${error.message}`);
          await sleep(SEARCH_RETRY_DELAY_MS);
        } else {
          console.error(`Skipping query ${query} after retry failure: ${error.message}`);
        }
      }
    }

    if (!success) {
      continue;
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

function filterMeaningfulEvents(events) {
  return (events || []).filter((event) => MEANINGFUL_EVENT_TYPES.has(event.type));
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

function mapTopRepos(repos) {
  return (repos || [])
    .map((repo) => ({
      name: repo?.name || '',
      description: repo?.description || '',
      stars: Number(repo?.stargazers_count || 0),
      url: repo?.html_url || '',
      language: repo?.language || null
    }))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 3);
}

function buildDigestRepos(reposActive7d, repos) {
  if (!Array.isArray(reposActive7d) || reposActive7d.length === 0 || !Array.isArray(repos) || repos.length === 0) {
    return [];
  }

  const wanted = new Set(reposActive7d);
  const digestRepos = [];

  for (const repo of repos) {
    const name = repo?.name || '';
    if (!name || !wanted.has(name)) {
      continue;
    }

    digestRepos.push({
      owner: repo?.owner?.login || '',
      name,
      description: repo?.description || '',
      stars: Number(repo?.stargazers_count || 0),
      language: repo?.language || null,
      url: repo?.html_url || ''
    });
  }

  return digestRepos;
}

function summarizeRepos(repos) {
  let totalStars = 0;
  const languageCounts = new Map();

  for (const repo of repos || []) {
    totalStars += Number(repo?.stargazers_count || 0);

    const language = repo?.language;
    if (language) {
      languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
    }
  }

  const topLanguages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language]) => language);

  return {
    total_stars: totalStars,
    top_languages: topLanguages
  };
}

async function fetchAllUserRepos(username, token) {
  const allRepos = [];

  for (let page = 1; ; page += 1) {
    const repos = await githubRequest(
      `/users/${encodeURIComponent(username)}/repos?per_page=${USER_REPOS_PER_PAGE}&page=${page}`,
      token
    );

    if (!Array.isArray(repos) || repos.length === 0) {
      break;
    }

    allRepos.push(...repos);

    if (repos.length < USER_REPOS_PER_PAGE) {
      break;
    }
  }

  return allRepos;
}

async function fetchDeveloperActivity(username, token) {
  const profile = await githubRequest(`/users/${encodeURIComponent(username)}`, token, { allow404: true });
  if (!profile) {
    console.warn(`Skipping ${username}: user not found (404).`);
    return null;
  }

  if (isLikelyFakeFromProfile(profile)) {
    return null;
  }

  const events = [];
  for (let page = 1; page <= USER_EVENTS_MAX_PAGES; page += 1) {
    const eventsResponse = await githubRequest(
      `/users/${encodeURIComponent(username)}/events?per_page=${USER_EVENTS_PER_PAGE}&page=${page}`,
      token
    );
    const pageEvents = Array.isArray(eventsResponse) ? eventsResponse : [];
    events.push(...pageEvents);
    if (pageEvents.length < USER_EVENTS_PER_PAGE) {
      break;
    }
  }

  const repos = await fetchAllUserRepos(username, token);

  const eventsLast90Days = extractRecentEvents(events, INACTIVE_DAYS_CUTOFF);
  const meaningfulLast30Days = filterMeaningfulEvents(extractRecentEvents(events, 30));
  const repoSummary = summarizeRepos(repos);
  const reposActive7d = extractReposPushedInLast7Days(eventsLast90Days).map((repo) => repo.name);
  const topRepos = mapTopRepos(repos);
  const digestRepos = buildDigestRepos(reposActive7d, repos);

  const activityMetrics = computeActivityMetrics(eventsLast90Days);

  return {
    username: profile.login || username,
    name: profile.name || '',
    avatar_url: profile.avatar_url || '',
    bio: profile.bio || '',
    location: profile.location || '',
    followers: profile.followers || 0,
    following: profile.following || 0,
    public_repos: profile.public_repos || 0,
    total_stars: repoSummary.total_stars,
    top_repos: topRepos,
    top_languages: repoSummary.top_languages,
    created_at: profile.created_at,
    events_30d: meaningfulLast30Days.length,
    events_90d: eventsLast90Days.length > 0,
    total_contributions_90d: activityMetrics.total_contributions_90d,
    active_weeks_12: activityMetrics.active_weeks_12,
    longest_gap_days: activityMetrics.longest_gap_days,
    repos_active_7d: reposActive7d,
    digest_repos: digestRepos,
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
  const preliminaryUsernames = merged.slice(0, PRELIMINARY_MAX_DEVELOPERS);

  console.log(`Discovered ${discoveredUsers.length} users from location search.`);
  console.log(`Loaded ${registeredUsers.length} registered users.`);
  console.log(`Merged ${merged.length} unique users.`);
  console.log(`Applying preliminary cap: ${preliminaryUsernames.length}/${PRELIMINARY_MAX_DEVELOPERS}`);

  const fetchedDevelopers = [];

  for (let index = 0; index < preliminaryUsernames.length; index += 1) {
    const username = preliminaryUsernames[index];
    if (index % 10 === 0) {
      console.log(`[fetch ${index + 1}/${preliminaryUsernames.length}] ${username}`);
    }

    try {
      const developer = await fetchDeveloperActivity(username, token);
      if (developer) {
        fetchedDevelopers.push(developer);
      }
    } catch (error) {
      console.error(`Skipping ${username}: ${error.message}`);
    }

    if (index < preliminaryUsernames.length - 1) {
      await sleep(randomDelayMs(USER_CALL_DELAY_MIN_MS, USER_CALL_DELAY_MAX_MS));
    }
  }

  const filteredDevelopers = fetchedDevelopers.filter((dev) => {
    const hasNoRepos = Number(dev.public_repos || 0) === 0;
    const hasNoNetwork = Number(dev.followers || 0) === 0 && Number(dev.following || 0) === 0;
    const isVeryNewAccount = daysSince(dev.created_at) < MIN_ACCOUNT_AGE_DAYS;

    if (hasNoRepos || hasNoNetwork || isVeryNewAccount) {
      return false;
    }

    const hasEnoughContributions = dev.total_contributions_90d >= ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_90D;
    const hasSteadyPresence = dev.active_weeks_12 >= ACTIVITY_THRESHOLDS.MIN_ACTIVE_WEEKS;
    const hasNoLongGaps = dev.longest_gap_days <= ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS;

    return hasEnoughContributions && hasSteadyPresence && hasNoLongGaps;
  });

  const passedBasic = fetchedDevelopers.filter((dev) => {
    const hasNoRepos = Number(dev.public_repos || 0) === 0;
    const hasNoNetwork = Number(dev.followers || 0) === 0 && Number(dev.following || 0) === 0;
    const isVeryNewAccount = daysSince(dev.created_at) < MIN_ACCOUNT_AGE_DAYS;
    return !(hasNoRepos || hasNoNetwork || isVeryNewAccount);
  });

  console.log(
    `Activity filter: ${fetchedDevelopers.length} fetched -> ${passedBasic.length} passed basic checks -> ${filteredDevelopers.length} passed activity thresholds ` +
    `(>=${ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_90D} contributions, >=${ACTIVITY_THRESHOLDS.MIN_ACTIVE_WEEKS} active weeks, <=${ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS}d max gap)`
  );

  filteredDevelopers.sort((a, b) => {
    const followerDiff = Number(b.followers || 0) - Number(a.followers || 0);
    if (followerDiff !== 0) {
      return followerDiff;
    }

    return String(a.username || '').localeCompare(String(b.username || ''));
  });

  const finalDevelopers = filteredDevelopers.slice(0, MAX_DEVELOPERS);

  console.log(`Final leaderboard: ${finalDevelopers.length} developers (capped at ${MAX_DEVELOPERS})`);
  return finalDevelopers;
}

module.exports = {
  fetchPakistaniDevelopers,
  computeActivityMetrics,
  LOCATION_QUERIES,
  MAX_DEVELOPERS,
  ACTIVITY_THRESHOLDS
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
