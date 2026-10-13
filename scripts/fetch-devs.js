import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTagsForDeveloper } from '../src/utils/tag-matcher.js';
import { createSearchClient } from './discovery/graphql.js';
import { annotation, describeDiscovery, discoverBatch } from './discovery/discover.js';
import { DISCOVERY_SOURCES, cityTwinQuery, foreignMarker } from './discovery/locations.js';
import { SEARCH_BATCHES } from './discovery/batches.js';
import { admitFetched, joinRegistry } from './registry.js';

const GITHUB_API_BASE = 'https://api.github.com';
const MAX_DEVELOPERS = 1000;
const USER_EVENTS_PER_PAGE = 100;
const USER_EVENTS_MAX_PAGES = 2;
const USER_REPOS_PER_PAGE = 100;
const INACTIVE_DAYS_CUTOFF = 60;
const MIN_ACCOUNT_AGE_DAYS = 30;
const RATE_LIMIT_BUFFER = 150;

const ACTIVITY_THRESHOLDS = {
  MIN_CONTRIBUTIONS_60D: 30,
  MAX_INACTIVITY_GAP_DAYS: 30
};
const REQUEST_TIMEOUT_MS = 20000;
const RATE_LIMIT_RETRY_DELAY_MS = 60000;

// A secondary rate limit is not the primary budget running out, and the two
// need different waits. The old handler computed its wait from
// `rateLimit.resetAt`, which tracks the *primary* limit - untouched during a
// secondary block, so it is already in the past and the wait collapsed to the
// +5000 floor. The pipeline therefore answered "please wait a few minutes"
// by waiting five seconds, retrying into the same block, and giving up: on
// 2026-09-21 batch 14 went from first 403 to fatal in eight seconds.
//
// GitHub's guidance is to honour `retry-after`, and to wait at least a minute
// when it is absent. Backs off linearly so a busy window is not hammered.
const SECONDARY_RATE_LIMIT_MIN_WAIT_MS = 60000;
export const MAX_RATE_LIMIT_RETRIES = 3;

export function rateLimitWaitMs(body, headers, attempt = 0, now = Date.now()) {
  const retryAfter = parseInt(headers?.get?.('retry-after'), 10);
  if (retryAfter > 0) return retryAfter * 1000 + 5000;

  if (String(body).includes('secondary rate limit')) {
    return SECONDARY_RATE_LIMIT_MIN_WAIT_MS * (attempt + 1);
  }

  // Primary budget: wait for the documented reset, never less than a minute.
  const untilReset = Math.max(0, rateLimit.resetAt * 1000 - now);
  return Math.max(untilReset, SECONDARY_RATE_LIMIT_MIN_WAIT_MS) + 5000;
}
const USER_CALL_DELAY_MIN_MS = 100;
const USER_CALL_DELAY_MAX_MS = 150;

const MEANINGFUL_EVENT_TYPES = new Set([
  'PushEvent',
  'PullRequestEvent',
  'IssuesEvent',
  'ReleaseEvent'
]);

// The batch -> range table lives in scripts/discovery/batches.js, with how its ranges were cut.
// Each batch owns the leaderboard rows for developers created in its range; run-all.js re-derives
// that ownership from `created_at` on every load. Each range is also searched by its city twin
// (scripts/discovery/locations.js), derived from it at run time.

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
    const value = line.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');

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
  const CUTOFF_30D_MS = 30 * 24 * 60 * 60 * 1000;

  const meaningful = (rawEvents || []).filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type));
  const totalContributions = meaningful.length;

  // Per-type counts for last 30 days
  const event_counts_30d = { pushes: 0, prs: 0, issues: 0, releases: 0 };
  for (const e of meaningful) {
    if (now - new Date(e.created_at).getTime() > CUTOFF_30D_MS) continue;
    if (e.type === 'PushEvent')        event_counts_30d.pushes++;
    if (e.type === 'PullRequestEvent') event_counts_30d.prs++;
    if (e.type === 'IssuesEvent')      event_counts_30d.issues++;
    if (e.type === 'ReleaseEvent')     event_counts_30d.releases++;
  }

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
    longest_gap_days: longestGapDays,
    event_counts_30d
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
  const { allow404 = false, retriedAfter429 = false, rateLimitAttempt = 0 } = options;

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
        'User-Agent': 'rankistan-fetch-devs'
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
    if (response.status === 403 && body.includes('rate limit') && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = rateLimitWaitMs(body, response.headers, rateLimitAttempt);
      console.warn(
        `Rate limited (403) on ${endpoint}; waiting ${Math.ceil(waitMs / 1000)}s ` +
        `(attempt ${rateLimitAttempt + 1}/${MAX_RATE_LIMIT_RETRIES}) and retrying.`
      );
      await sleep(waitMs);
      return githubRequest(endpoint, token, { ...options, rateLimitAttempt: rateLimitAttempt + 1 });
    }
    throw new Error(`GitHub API error ${response.status} for ${endpoint}: ${body}`);
  }

  return response.json();
}

function searchQueriesForBatch(batch) {
  if (batch && Array.isArray(batch.queries) && batch.queries.length > 0) {
    return batch.queries;
  }
  if (batch && typeof batch.q === 'string' && batch.q.length > 0) {
    return [batch.q];
  }
  return [];
}

/**
 * Discover one set of queries and judge it. Returns its candidates and whether the listing was
 * complete: every leaf listed, and the leaves adding up to the range.
 *
 * `required` is the main query's policy, unchanged: a range that cannot be partitioned, or of
 * which nobody lists completely, fails the run rather than publish a batch that was never
 * measured. The city twin is not required. It only ever adds people, so when it cannot be
 * measured the batch is still published from the main query, the twin is reported incomplete,
 * and the merge freezes miss counters: a city-sourced row then waits, carried, for a run that
 * can see it, rather than costing every other developer in the batch their refresh.
 */
async function discoverQueries({ label, queries }, client, { required }) {
  let report;
  try {
    report = await discoverBatch({ label, queries }, client);
  } catch (error) {
    if (required) {
      // A range that could not be counted has no leaves to judge, and a rejected credential will
      // not recover for the next leaf either.
      throw new Error(
        `Discovery failed for batch "${label}". Refusing to publish a batch whose ` +
        `search was not measured. Downstream error: ${error.message}`
      );
    }
    console.warn(
      `::warning title=Discovery::${annotation(
        `${label}: could not be measured (${error.message}). Nobody it lists was evaluated this run.`
      )}`
    );
    return { candidates: [], complete: false };
  }

  const { info, warnings } = describeDiscovery(report);
  info.forEach((line) => console.log(line));
  warnings.forEach((line) => console.warn(line));

  // Counted in developers, not leaves: a split can leave an empty half, which is trivially
  // complete and measures nobody.
  const measured = report.leaves
    .filter((leaf) => leaf.complete)
    .reduce((total, leaf) => total + leaf.count, 0);
  if (report.rootCount > 0 && measured === 0) {
    if (required) {
      throw new Error(
        `Discovery for batch "${label}" listed none of its ${report.rootCount} developers ` +
        `completely. Refusing to publish a batch that was never measured.`
      );
    }
    console.warn(
      `::warning title=Discovery::${annotation(
        `${label}: listed none of its ${report.rootCount} developers completely.`
      )}`
    );
  }

  const complete = report.sum.valid && report.leaves.every((leaf) => leaf.complete);
  return { candidates: report.candidates, complete };
}

/**
 * Every developer each batch's search matches, listed completely, leaf by leaf.
 *
 * This used to page `/search/users` sorted by followers, ten pages of 100 per range. A range over
 * GitHub's 1,000-result cap lost its lowest-follower developers outright, and paging inside the cap
 * skipped or repeated people whenever a follower tie straddled a page or a rate-limit wait shifted
 * the results underneath it. scripts/discovery/ replaces it: each range is partitioned into leaves
 * small enough to list in one GraphQL request apiece, and a leaf counts only if its listing is
 * provably complete.
 *
 * Each batch is searched twice over the same `created:` range: `location:pakistan`, and its city
 * twin (scripts/discovery/locations.js), the developers who name a Pakistani city and not the
 * country. The two are separate discoveries, because a batch's ranges must share one set of
 * qualifiers, and their candidates are united by databaseId. Each candidate records which search
 * found it; one both found - possible only if a location changed between the two - is `pakistan`.
 *
 * A leaf that is not complete is named in an Actions warning and contributes nobody. Its developers
 * are then not evaluated this run, and run-all.js carries their rows forward instead of removing
 * them. The run fails only when a main range cannot be partitioned at all, or nobody in it lists
 * completely.
 *
 * @returns {{candidates: Array<{id, login, source}>, complete: boolean}}
 */
async function discoverUsers(token, batches, { searchClient } = {}) {
  const client = searchClient || createSearchClient({ token });
  const byId = new Map();
  // False when either search of any batch was incomplete. The merge then freezes miss counters:
  // absence from a search known to be incomplete is not a miss.
  let complete = true;

  const add = (candidates, source) => {
    let added = 0;
    for (const { id, login } of candidates) {
      if (byId.has(id)) continue;
      byId.set(id, { id, login, source });
      added += 1;
    }
    return added;
  };

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const queries = searchQueriesForBatch(batch);

    if (queries.length === 0) {
      console.warn(`[discover ${index + 1}/${batches.length}] ${batch.label}: no search query; skipping`);
      continue;
    }

    console.log(`[discover ${index + 1}/${batches.length}] ${batch.label} (${queries.length} range(s))`);
    const main = await discoverQueries({ label: batch.label, queries }, client, { required: true });
    add(main.candidates, DISCOVERY_SOURCES.PAKISTAN);

    const twinLabel = `${batch.label} cities`;
    console.log(`[discover ${index + 1}/${batches.length}] ${twinLabel} (city names without "Pakistan")`);
    const twin = await discoverQueries(
      { label: twinLabel, queries: queries.map(cityTwinQuery) },
      client,
      { required: false }
    );
    const added = add(twin.candidates, DISCOVERY_SOURCES.CITY);
    if (added < twin.candidates.length) {
      console.log(
        `  ${twin.candidates.length - added} city candidate(s) were also listed by ` +
        'location:pakistan, and count once, as pakistan.'
      );
    }

    if (!main.complete || !twin.complete) complete = false;
  }

  return { candidates: [...byId.values()], complete };
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

async function fetchUserSocials(username, token) {
  try {
    const socials = await githubRequest(
      `/users/${encodeURIComponent(username)}/social_accounts?per_page=100`,
      token,
      { allow404: true }
    );

    if (!Array.isArray(socials)) {
      return [];
    }

    return socials
      .filter((entry) => entry && typeof entry.url === 'string' && entry.url.trim() !== '')
      .map((entry) => ({
        provider: typeof entry.provider === 'string' ? entry.provider.toLowerCase() : '',
        url: entry.url.trim()
      }));
  } catch (error) {
    // Socials are non-essential. Never fail a developer fetch because of this call.
    console.warn(`Could not fetch socials for ${username}: ${error.message}`);
    return [];
  }
}

function extractLinkedinUrl(socials) {
  if (!Array.isArray(socials) || socials.length === 0) {
    return '';
  }

  const match = socials.find((entry) => {
    if (!entry || typeof entry.url !== 'string') {
      return false;
    }
    if (entry.provider === 'linkedin') {
      return true;
    }
    return /(^|\.)linkedin\.com\//i.test(entry.url);
  });

  if (!match) {
    return '';
  }

  const url = match.url.trim();
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `https://${url.replace(/^\/+/, '')}`;
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

/**
 * Why a city-sourced developer's fetched location rules them out, or null when it does not.
 *
 * The city twin finds people by a city name alone, and a few cities share a name with places
 * elsewhere. So a developer it found is re-checked against the location their profile gives now,
 * and one that also names a FOREIGN_MARKERS place (scripts/discovery/locations.js) is not counted.
 * A developer `location:pakistan` found is never re-checked: the country was the evidence.
 */
function locationRejection(source, location) {
  if (source !== DISCOVERY_SOURCES.CITY) return null;
  const marker = foreignMarker(location);
  return marker ? `found by a Pakistani city name, but the location also names "${marker}"` : null;
}

/**
 * @param {string} username
 * @param {string} token
 * @param {{source?: string}} [options]  how discovery found them; see DISCOVERY_SOURCES
 */
async function fetchDeveloperActivity(username, token, { source } = {}) {
  // Events first: for most candidates this one call settles the gate.
  const firstPage = await githubRequest(
    `/users/${encodeURIComponent(username)}/events?per_page=${USER_EVENTS_PER_PAGE}&page=1`,
    token,
    { allow404: true }
  );
  if (firstPage === null) {
    // By login, so this may be a rename rather than a deletion: report it as
    // not found and let the merge's two-miss rule decide, rather than judging.
    console.warn(`Skipping ${username}: user not found (404).`);
    return null;
  }

  const screen = screenFirstPage(firstPage);
  if (screen.complete && !screen.passes) {
    return { screenedOut: true, username };
  }

  const profile = await githubRequest(`/users/${encodeURIComponent(username)}`, token, { allow404: true });
  if (!profile) {
    console.warn(`Skipping ${username}: user not found (404).`);
    return null;
  }

  // Before repos and social accounts: the profile alone settles it.
  const rejection = locationRejection(source, profile.location);
  if (rejection) {
    return { locationRejected: true, username, location: profile.location, reason: rejection };
  }

  if (isLikelyFakeFromProfile(profile)) {
    return null;
  }

  const events = Array.isArray(firstPage) ? [...firstPage] : [];
  for (let page = 2; page <= USER_EVENTS_MAX_PAGES && !screen.complete; page += 1) {
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
  const socials = await fetchUserSocials(username, token);

  const recentEvents = extractRecentEvents(events, INACTIVE_DAYS_CUTOFF);
  const meaningfulLast30Days = filterMeaningfulEvents(extractRecentEvents(events, 30));
  const repoSummary = summarizeRepos(repos);
  const reposActive7d = extractReposPushedInLast7Days(recentEvents).map((repo) => repo.name);
  const topRepos = mapTopRepos(repos);
  const digestRepos = buildDigestRepos(reposActive7d, repos);
  const linkedinUrl = extractLinkedinUrl(socials);

  const activityMetrics = computeActivityMetrics(recentEvents);

  const developer = {
    username: profile.login || username,
    github_id: profile.id,
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
    linkedin_url: linkedinUrl,
    created_at: profile.created_at,
    events_30d: meaningfulLast30Days.length,
    event_counts_30d: activityMetrics.event_counts_30d,
    total_contributions_60d: activityMetrics.total_contributions_60d,
    longest_gap_days: activityMetrics.longest_gap_days,
    repos_active_7d: reposActive7d,
    digest_repos: digestRepos,
    raw_events_60d: recentEvents,
    ...(source ? { discovery_source: source } : {})
  };

  developer.tags = matchTagsForDeveloper(developer);

  return developer;
}

/** The activity gate. One definition, used by the screen and by the filter, so
 *  the two can never disagree about who passes. */
function passesActivityGate(metrics) {
  const hasEnoughContributions =
    metrics.total_contributions_60d >= ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D;
  const hasNoLongGaps = metrics.longest_gap_days <= ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS;
  return hasEnoughContributions && hasNoLongGaps;
}

function applyActivityFilter(developers) {
  return developers.filter((dev) => passesActivityGate(dev));
}

/**
 * Decides the gate from the first page of a developer's events, when it can.
 *
 * Why this exists: each candidate cost about 4 REST calls - profile, events,
 * repos, social accounts - and 94% of candidates then failed the gate, so
 * nearly all of a ~105k-call day bought nothing. Measured over 120 runs, 6.2%
 * pass.
 *
 * A page holding fewer than USER_EVENTS_PER_PAGE events is the whole feed: the
 * fetch loop below stops after such a page anyway. So the gate computed from it
 * is not an estimate but the identical decision the full fetch would reach, and
 * a failing developer can be rejected after one call instead of four.
 *
 * A full first page proves nothing - more events may follow - so it is always
 * forwarded to the full fetch. (An earlier design also treated "the 100th event
 * is older than the window" as complete; the feed is not reliably time-ordered,
 * 139 of 1,000 sampled feeds were out of order by over a day, so it is not.)
 *
 * @returns {{ complete: boolean, passes: boolean | null }}
 */
function screenFirstPage(firstPage) {
  const events = Array.isArray(firstPage) ? firstPage : [];
  if (events.length >= USER_EVENTS_PER_PAGE) return { complete: false, passes: null };
  const metrics = computeActivityMetrics(extractRecentEvents(events, INACTIVE_DAYS_CUTOFF));
  return { complete: true, passes: passesActivityGate(metrics) };
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

  const { candidates, complete: searchComplete } = await discoverUsers(token, batches, {
    searchClient: options.searchClient
  });

  // Registration and opt-out by GitHub issue, keyed on the account id (scripts/registry.js).
  // Registered developers created in this batch's range join its candidates after both searches,
  // so one a search also found keeps the search's source; anyone who opted out is never fetched.
  const joined = await joinRegistry({
    discovered: candidates,
    registry: options.registry,
    batchIndex,
    batches: SEARCH_BATCHES,
    graphql: options.searchClient || createSearchClient({ token })
  });
  const discoveryComplete = searchComplete && joined.complete;

  // How each login was found.
  const sourceOf = new Map(joined.candidates.map((c) => [c.login.toLowerCase(), c.source]));
  const allUsernames = [...sourceOf.keys()];

  const fromCities = candidates.filter((c) => c.source === DISCOVERY_SOURCES.CITY).length;
  console.log(
    `Discovered ${candidates.length} users from search: ${candidates.length - fromCities} ` +
    `by location:pakistan, ${fromCities} by a Pakistani city name alone.`
  );
  console.log(`Total unique usernames to scan: ${allUsernames.length}`);

  const fetchedDevelopers = [];
  const screenedOut = [];
  const locationRejected = [];
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
      const developer = await fetchDeveloperActivity(username, token, {
        source: sourceOf.get(username)
      });
      if (developer?.screenedOut) {
        screenedOut.push(developer.username);
      } else if (developer?.locationRejected) {
        console.log(`Not counting ${username}: ${developer.reason} ("${developer.location}").`);
        locationRejected.push({
          username: developer.username,
          location: developer.location,
          reason: developer.reason
        });
      } else if (developer) {
        // Registered developers meet search's own gates here, by account id (scripts/registry.js).
        const verdict = admitFetched(joined, developer);
        if (verdict.admit) fetchedDevelopers.push(verdict.admit);
        else if (verdict.reject) screenedOut.push(developer.username);
        else skippedProfile += 1;
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
    `Fetch complete: ${fetchedDevelopers.length} fetched in full, ` +
    `${screenedOut.length} rejected on their first events page, ` +
    `${locationRejected.length} found by city name and rejected on their location, ` +
    `${skippedProfile} skipped (not found/fake), ${skippedError} errors`
  );

  // Screened-out and location-rejected developers were observed and are not
  // eligible, so a caller that asks for them can count them as evaluated -
  // unlike a fetch that errored.
  const withScreening = (developers) =>
    options.withScreening
      ? { developers, screenedOut, locationRejected, discoveryComplete }
      : developers;

  if (rawOnly) {
    console.log(`Raw mode: returning ${fetchedDevelopers.length} unfiltered developers.`);
    return withScreening(fetchedDevelopers);
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
  return withScreening(finalDevelopers);
}

export {
  fetchPakistaniDevelopers,
  fetchDeveloperActivity,
  applyActivityFilter,
  passesActivityGate,
  screenFirstPage,
  computeActivityMetrics,
  SEARCH_BATCHES,
  MAX_DEVELOPERS,
  ACTIVITY_THRESHOLDS
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
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
