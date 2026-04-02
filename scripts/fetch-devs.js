'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const GITHUB_API_BASE = 'https://api.github.com';
const SEARCH_DELAY_MS = 2100;
const SEARCH_RETRY_DELAY_MS = 3000;
const MAX_DEVELOPERS = 1000;
const USER_EVENTS_PER_PAGE = 100;
const USER_EVENTS_MAX_PAGES = 2;
const USER_REPOS_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10;
const INACTIVE_DAYS_CUTOFF = 60;
const MIN_ACCOUNT_AGE_DAYS = 30;
const RATE_LIMIT_BUFFER = 150;

const ACTIVITY_THRESHOLDS = {
  MIN_CONTRIBUTIONS_60D: 30,
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

const SEARCH_BATCHES = [
  { label: 'PK 2000-Jun2014',    q: 'location:pakistan type:user repos:>3 followers:>1 created:2000-01-01..2014-06-30' },
  { label: 'PK Jul2014-Jan2016', q: 'location:pakistan type:user repos:>3 followers:>1 created:2014-07-01..2016-01-31' },
  { label: 'PK Feb2016-Feb2017', q: 'location:pakistan type:user repos:>3 followers:>1 created:2016-02-01..2017-02-28' },
  { label: 'PK Mar2017-Dec2017', q: 'location:pakistan type:user repos:>3 followers:>1 created:2017-03-01..2017-12-31' },
  { label: 'PK Jan2018-Sep2018', q: 'location:pakistan type:user repos:>3 followers:>1 created:2018-01-01..2018-09-30' },
  { label: 'PK Oct2018-Apr2019', q: 'location:pakistan type:user repos:>3 followers:>1 created:2018-10-01..2019-04-30' },
  { label: 'PK May2019-Sep2019', q: 'location:pakistan type:user repos:>3 followers:>1 created:2019-05-01..2019-09-30' },
  { label: 'PK Oct2019-Feb2020', q: 'location:pakistan type:user repos:>3 followers:>1 created:2019-10-01..2020-02-29' },
  { label: 'PK Mar2020-Jun2020', q: 'location:pakistan type:user repos:>3 followers:>1 created:2020-03-01..2020-06-30' },
  { label: 'PK Jul2020-Nov2020', q: 'location:pakistan type:user repos:>3 followers:>1 created:2020-07-01..2020-11-30' },
  { label: 'PK Dec2020-Mar2021', q: 'location:pakistan type:user repos:>3 followers:>1 created:2020-12-01..2021-03-31' },
  { label: 'PK Apr2021-Aug2021', q: 'location:pakistan type:user repos:>3 followers:>1 created:2021-04-01..2021-08-31' },
  { label: 'PK Sep2021-Dec2021', q: 'location:pakistan type:user repos:>3 followers:>1 created:2021-09-01..2021-12-31' },
  { label: 'PK Jan2022-Apr2022', q: 'location:pakistan type:user repos:>3 followers:>1 created:2022-01-01..2022-04-30' },
  { label: 'PK May2022-Aug2022', q: 'location:pakistan type:user repos:>3 followers:>1 created:2022-05-01..2022-08-31' },
  { label: 'PK Sep2022-Nov2022', q: 'location:pakistan type:user repos:>3 followers:>1 created:2022-09-01..2022-11-30' },
  { label: 'PK Dec2022-Feb2023', q: 'location:pakistan type:user repos:>3 followers:>1 created:2022-12-01..2023-02-28' },
  { label: 'PK Mar2023-Jun2023', q: 'location:pakistan type:user repos:>3 followers:>1 created:2023-03-01..2023-06-30' },
  { label: 'PK Jul2023-Sep2023', q: 'location:pakistan type:user repos:>3 followers:>1 created:2023-07-01..2023-09-30' },
  { label: 'PK Oct2023-Dec2023', q: 'location:pakistan type:user repos:>3 followers:>1 created:2023-10-01..2023-12-31' },
  { label: 'PK Jan2024-Mar2024', q: 'location:pakistan type:user repos:>3 followers:>1 created:2024-01-01..2024-03-31' },
  { label: 'PK Apr2024-Jul2024', q: 'location:pakistan type:user repos:>3 followers:>1 created:2024-04-01..2024-07-31' },
  { label: 'PK Aug2024-Dec2024', q: 'location:pakistan type:user repos:>3 followers:>1 created:2024-08-01..2024-12-31' },
  { label: 'PK 2025+',           q: 'location:pakistan type:user repos:>3 followers:>1 created:2025-01-01..2099-12-31' },
];

const rateLimit = { remaining: Infinity, resetAt: 0 };

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

function computeActivityMetrics(rawEvents) {
  const now = Date.now();
  const CUTOFF_MS = INACTIVE_DAYS_CUTOFF * 24 * 60 * 60 * 1000;

  const meaningful = (rawEvents || []).filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type));
  const totalContributions = meaningful.length;

  const timestamps = meaningful
    .map((e) => new Date(e.created_at).getTime())
    .filter((t) => t >= now - CUTOFF_MS)
    .sort((a, b) => a - b);

  let longestGapDays = INACTIVE_DAYS_CUTOFF;

  if (timestamps.length > 0) {
    longestGapDays = 0;

    for (let i = 1; i < timestamps.length; i += 1) {
      const gap = Math.floor((timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60 * 24));
      longestGapDays = Math.max(longestGapDays, gap);
    }

    const gapToNow = Math.floor((now - timestamps[timestamps.length - 1]) / (1000 * 60 * 60 * 24));
    longestGapDays = Math.max(longestGapDays, gapToNow);
  }

  return {
    total_contributions_60d: totalContributions,
    longest_gap_days: longestGapDays
  };
}

function updateRateLimit(headers) {
  const resource = headers.get('x-ratelimit-resource');
  if (resource && resource !== 'core') return;
  const remaining = parseInt(headers.get('x-ratelimit-remaining'), 10);
  const resetAt = parseInt(headers.get('x-ratelimit-reset'), 10);
  if (!Number.isNaN(remaining)) rateLimit.remaining = remaining;
  if (!Number.isNaN(resetAt)) rateLimit.resetAt = resetAt;
}

async function waitForRateLimit() {
  if (rateLimit.remaining > RATE_LIMIT_BUFFER) return;
  const waitMs = Math.max(0, rateLimit.resetAt * 1000 - Date.now()) + 5000;
  console.log(
    `Rate limit low (${rateLimit.remaining} remaining). Pausing ${Math.ceil(waitMs / 1000)}s until reset...`
  );
  await sleep(waitMs);
  rateLimit.remaining = Infinity;
}

async function githubRequest(endpoint, token, options = {}) {
  const { allow404 = false, retriedAfter429 = false } = options;

  await waitForRateLimit();

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

  updateRateLimit(response.headers);

  if (response.status === 404 && allow404) {
    return null;
  }

  if (response.status === 429 && !retriedAfter429) {
    const retryAfter = parseInt(response.headers.get('retry-after'), 10);
    const waitMs = (retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_RETRY_DELAY_MS) + 5000;
    console.warn(`Rate limited on ${endpoint}; waiting ${Math.ceil(waitMs / 1000)}s and retrying.`);
    await sleep(waitMs);
    return githubRequest(endpoint, token, { ...options, retriedAfter429: true });
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403 && body.includes('rate limit') && !retriedAfter429) {
      const waitMs = Math.max(0, rateLimit.resetAt * 1000 - Date.now()) + 5000;
      console.warn(`Rate limited (403) on ${endpoint}; waiting ${Math.ceil(waitMs / 1000)}s and retrying.`);
      await sleep(waitMs);
      return githubRequest(endpoint, token, { ...options, retriedAfter429: true });
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

async function discoverUsers(token, batches) {
  const discovered = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(`[discover ${index + 1}/${SEARCH_BATCHES.length}] ${batch.label} (pages 1-${SEARCH_MAX_PAGES})`);

    let batchCount = 0;
    let success = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
          const endpoint =
            `/search/users?q=${encodeURIComponent(batch.q)}` +
            `&sort=followers&order=desc&per_page=100&page=${page}`;
          const result = await githubRequest(endpoint, token);

          const items = result?.items || [];
          for (const item of items) {
            if (item && typeof item.login === 'string') {
              discovered.push(item.login);
              batchCount += 1;
            }
          }

          if (items.length < 100) {
            break;
          }

          await sleep(SEARCH_DELAY_MS);
        }

        success = true;
        break;
      } catch (error) {
        if (attempt === 1) {
          console.warn(`Search failed for ${batch.label}; retrying after 3s. Reason: ${error.message}`);
          await sleep(SEARCH_RETRY_DELAY_MS);
        } else {
          console.error(`Skipping batch ${batch.label} after retry failure: ${error.message}`);
        }
      }
    }

    if (success) {
      console.log(`  -> found ${batchCount} users`);
    }

    if (index < batches.length - 1) {
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

  const recentEvents = extractRecentEvents(events, INACTIVE_DAYS_CUTOFF);
  const meaningfulLast30Days = filterMeaningfulEvents(extractRecentEvents(events, 30));
  const repoSummary = summarizeRepos(repos);
  const reposActive7d = extractReposPushedInLast7Days(recentEvents).map((repo) => repo.name);
  const topRepos = mapTopRepos(repos);
  const digestRepos = buildDigestRepos(reposActive7d, repos);

  const activityMetrics = computeActivityMetrics(recentEvents);

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
    total_contributions_60d: activityMetrics.total_contributions_60d,
    longest_gap_days: activityMetrics.longest_gap_days,
    repos_active_7d: reposActive7d,
    digest_repos: digestRepos,
    raw_events_60d: recentEvents
  };
}

function applyActivityFilter(developers) {
  return developers.filter((dev) => {
    const hasEnoughContributions = dev.total_contributions_60d >= ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D;
    const hasNoLongGaps = dev.longest_gap_days <= ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS;
    return hasEnoughContributions && hasNoLongGaps;
  });
}

async function fetchPakistaniDevelopers(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  await loadDotEnv(repoRoot);

  const token = options.token || process.env.MY_GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GitHub token. Set MY_GITHUB_PAT in .env or pass options.token.');
  }

  const batchIndex = options.batchIndex;
  const rawOnly = options.rawOnly === true;
  const batches = batchIndex != null
    ? [SEARCH_BATCHES[batchIndex]]
    : SEARCH_BATCHES;

  console.log(
    batchIndex != null
      ? `Running batch ${batchIndex}: ${batches[0].label}`
      : `Running all ${batches.length} search batches`
  );

  const discoveredUsers = await discoverUsers(token, batches);
  const registeredUsers = batchIndex === 0 || batchIndex == null
    ? await loadRegisteredDevelopers(repoRoot)
    : [];

  const allUsernames = dedupeUsernames([...discoveredUsers, ...registeredUsers]);

  console.log(`Discovered ${discoveredUsers.length} users from search.`);
  if (registeredUsers.length > 0) {
    console.log(`Loaded ${registeredUsers.length} registered users.`);
  }
  console.log(`Total unique usernames to scan: ${allUsernames.length}`);

  const fetchedDevelopers = [];
  let skippedProfile = 0;
  let skippedError = 0;

  for (let index = 0; index < allUsernames.length; index += 1) {
    const username = allUsernames[index];
    if (index % 50 === 0) {
      console.log(
        `[fetch ${index + 1}/${allUsernames.length}] ${username} ` +
        `(rate limit: ${rateLimit.remaining} remaining)`
      );
    }

    try {
      const developer = await fetchDeveloperActivity(username, token);
      if (developer) {
        fetchedDevelopers.push(developer);
      } else {
        skippedProfile += 1;
      }
    } catch (error) {
      skippedError += 1;
      console.error(`Skipping ${username}: ${error.message}`);
    }

    if (index < allUsernames.length - 1) {
      await sleep(randomDelayMs(USER_CALL_DELAY_MIN_MS, USER_CALL_DELAY_MAX_MS));
    }
  }

  console.log(
    `Fetch complete: ${fetchedDevelopers.length} valid profiles, ` +
    `${skippedProfile} skipped (empty/fake), ${skippedError} errors`
  );

  if (rawOnly) {
    console.log(`Raw mode: returning ${fetchedDevelopers.length} unfiltered developers.`);
    return fetchedDevelopers;
  }

  const filteredDevelopers = applyActivityFilter(fetchedDevelopers);

  console.log(
    `Activity filter: ${fetchedDevelopers.length} profiles -> ${filteredDevelopers.length} passed ` +
    `(>=${ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D} contributions in 60d, ` +
    `<=${ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS}d max gap)`
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
  applyActivityFilter,
  computeActivityMetrics,
  SEARCH_BATCHES,
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
