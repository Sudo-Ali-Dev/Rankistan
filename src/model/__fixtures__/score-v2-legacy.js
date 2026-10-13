/**
 * The scoring implementation as it stood before src/model/ existed, frozen so
 * the differential test has something independent to compare against.
 *
 * Copied from origin/main at 82f9bcee:
 *   - src/utils/activity-score.js           (whole file)
 *   - scripts/score.js                      (calculateDeveloperScore, scoreDevelopers)
 *   - src/utils/score-breakdown.js          (computeDeveloperScoreBreakdown)
 *
 * The only edits are the ones needed to make three files one module: the
 * config import points at the frozen copy of score-config.json beside this
 * file, the activity imports are dropped because the functions are now local,
 * and score-breakdown's private `daysSince` is renamed `breakdownDaysSince`
 * so it does not collide with score.js's. Formatting was normalised by
 * prettier; no expression was changed.
 *
 * Do not "fix" anything here. Its value is that it is the old code.
 */
import config from './score-config-v2.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// src/utils/activity-score.js
// ---------------------------------------------------------------------------

const MEANINGFUL_EVENT_TYPES = new Set([
  'PushEvent',
  'PullRequestEvent',
  'IssuesEvent',
  'ReleaseEvent'
]);

const EVENT_TYPE_TO_KEY = {
  PushEvent: 'push',
  PullRequestEvent: 'pr',
  IssuesEvent: 'issue',
  ReleaseEvent: 'release'
};

const COUNT_KEY_TO_TYPE = {
  pushes: 'push',
  prs: 'pr',
  issues: 'issue',
  releases: 'release'
};

export const SCORING_WINDOW_DAYS = 30;

export { MEANINGFUL_EVENT_TYPES, EVENT_TYPE_TO_KEY };

function resolveConfig(options) {
  const config = options?.config;
  if (!config || typeof config !== 'object') {
    throw new Error('activity-score: options.config is required');
  }
  return config;
}

export function getActivityScoringConfig(config) {
  const fromConfig = config?.ACTIVITY_SCORING;
  if (fromConfig && typeof fromConfig === 'object') {
    return fromConfig;
  }

  const weights = config?.WEIGHTS || {};
  return {
    push: { base: weights.push ?? 2, dailyCap: 15, maxCountedPerDay: 20 },
    issue: { base: weights.issue ?? 1.5, dailyCap: 15 },
    pr: { base: weights.pr ?? 4, dailyCap: 25 },
    release: { base: weights.release ?? 5, dailyCap: 20 }
  };
}

export function marginalPoints(n, base) {
  return base / Math.log2(n + 1);
}

export function scoreDayType(count, typeConfig) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (safeCount === 0) {
    return 0;
  }

  const { base, dailyCap, maxCountedPerDay } = typeConfig;
  const limit = maxCountedPerDay != null ? Math.min(safeCount, maxCountedPerDay) : safeCount;
  let sum = 0;

  for (let n = 1; n <= limit; n += 1) {
    sum += marginalPoints(n, base);
  }

  return Math.min(dailyCap, sum);
}

function utcDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function bucketEventsByUtcDay(events, cutoffMs, now = Date.now()) {
  const buckets = new Map();

  for (const event of events || []) {
    if (!MEANINGFUL_EVENT_TYPES.has(event?.type)) {
      continue;
    }

    const ts = new Date(event.created_at).getTime();
    if (Number.isNaN(ts) || ts < now - cutoffMs) {
      continue;
    }

    const dayKey = utcDayKey(event.created_at);
    const typeKey = EVENT_TYPE_TO_KEY[event.type];
    if (!dayKey || !typeKey) {
      continue;
    }

    const bucketKey = `${dayKey}|${typeKey}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey).push(event);
  }

  return buckets;
}

function createEmptyActivityByType() {
  return {
    push: { points: 0, events30d: 0 },
    pr: { points: 0, events30d: 0 },
    issue: { points: 0, events30d: 0 },
    release: { points: 0, events30d: 0 }
  };
}

export function computeActivityBreakdown30d(events, options = {}) {
  const config = resolveConfig(options);
  const now = options.now ?? Date.now();
  const activityScoring = getActivityScoringConfig(config);
  const cutoffMs = SCORING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const buckets = bucketEventsByUtcDay(events, cutoffMs, now);
  const byType = createEmptyActivityByType();

  for (const [, dayEvents] of buckets) {
    const typeKey = EVENT_TYPE_TO_KEY[dayEvents[0]?.type];
    if (!typeKey || !activityScoring[typeKey]) {
      continue;
    }

    byType[typeKey].events30d += dayEvents.length;
    dayEvents.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    byType[typeKey].points += scoreDayType(dayEvents.length, activityScoring[typeKey]);
  }

  const total = Object.values(byType).reduce((sum, row) => sum + row.points, 0);

  return { total, byType };
}

export function computeActivityScore30d(events, options = {}) {
  return computeActivityBreakdown30d(events, options).total;
}

export function computeActivityScore30dFromCounts(eventCounts, options = {}) {
  const config = resolveConfig(options);
  const activityScoring = getActivityScoringConfig(config);
  let total = 0;

  for (const [countKey, typeKey] of Object.entries(COUNT_KEY_TO_TYPE)) {
    const count = eventCounts?.[countKey] || 0;
    total += scoreDayType(count, activityScoring[typeKey]);
  }

  return total;
}

// ---------------------------------------------------------------------------
// scripts/score.js
// ---------------------------------------------------------------------------

const WEIGHTS = config.WEIGHTS;
const STAR_WEIGHT = config.STAR_WEIGHT;
// 3.125 is the exact average of the new individual weights (5 + 4 + 2 + 1.5 = 12.5 / 4)
const FALLBACK_ACTIVITY_WEIGHT = config.FALLBACK_ACTIVITY_WEIGHT;
const SIX_MONTHS_DAYS = config.SIX_MONTHS_DAYS;
const MAX_STARS_FOR_SCORING = config.MAX_STARS_FOR_SCORING;
const MAX_FOLLOWERS_FOR_SCORING = config.MAX_FOLLOWERS_FOR_SCORING;
const MAX_PUBLIC_REPOS_FOR_SCORING = config.MAX_PUBLIC_REPOS_FOR_SCORING;

function daysSince(date) {
  if (!date) {
    return Number.POSITIVE_INFINITY;
  }

  const ts = new Date(date).getTime();
  if (Number.isNaN(ts)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

function sanitizeScoreField(developer, field) {
  const value = developer?.[field];
  const n = Number(value);

  if (value === null || value === undefined || Number.isNaN(n)) {
    console.warn(
      `Missing/invalid ${field} for ${developer?.username || 'unknown'}; defaulting to 0.`
    );
    return 0;
  }

  return n;
}

function calculateDeveloperScore(developer) {
  const stars = sanitizeScoreField(developer, 'total_stars');
  const followers = sanitizeScoreField(developer, 'followers');
  const publicRepos = sanitizeScoreField(developer, 'public_repos');

  const cappedStars = Math.min(stars, MAX_STARS_FOR_SCORING);
  const cappedFollowers = Math.min(followers, MAX_FOLLOWERS_FOR_SCORING);
  const cappedPublicRepos = Math.min(publicRepos, MAX_PUBLIC_REPOS_FOR_SCORING);

  let activityScore;
  const ec = developer.event_counts_30d;
  const rawEvents = developer.raw_events_60d;

  if (Array.isArray(rawEvents) && rawEvents.length > 0) {
    activityScore = computeActivityScore30d(rawEvents, { config });
  } else if (ec && typeof ec === 'object') {
    activityScore = computeActivityScore30dFromCounts(ec, { config });
  } else {
    const events30d = sanitizeScoreField(developer, 'events_30d');
    activityScore = events30d * FALLBACK_ACTIVITY_WEIGHT;
  }

  const baseScore =
    cappedStars * STAR_WEIGHT +
    activityScore +
    cappedFollowers * WEIGHTS.followers +
    cappedPublicRepos * WEIGHTS.publicRepos;

  const accountAgeDays = daysSince(developer.created_at);
  const isNewAccount = accountAgeDays < SIX_MONTHS_DAYS;
  const penaltyMultiplier = isNewAccount ? 0.5 : 1;

  const finalScore = Number.isFinite(baseScore) ? Math.round(baseScore * penaltyMultiplier) : 0;

  if (!Number.isFinite(baseScore)) {
    console.warn(`NaN score for ${developer?.username || 'unknown'}; setting score to 0.`);
  }

  return { score: finalScore, age_penalty_applied: isNewAccount };
}

export function scoreDevelopers(rawDevelopers) {
  if (!Array.isArray(rawDevelopers)) {
    throw new Error('Expected an array of developers.');
  }

  const scored = rawDevelopers.map((developer) => {
    const scoring = calculateDeveloperScore(developer);

    return {
      ...developer,
      tags: Array.isArray(developer.tags) ? developer.tags : [],
      score: scoring.score,
      age_penalty_applied: scoring.age_penalty_applied
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return String(a.username || '').localeCompare(String(b.username || ''));
  });

  return scored.map((dev, index) => ({
    ...dev,
    rank: index + 1
  }));
}

export { calculateDeveloperScore, config as LEGACY_CONFIG };

// ---------------------------------------------------------------------------
// src/utils/score-breakdown.js
// ---------------------------------------------------------------------------

function breakdownDaysSince(date) {
  if (!date) {
    return Number.POSITIVE_INFINITY;
  }
  const ts = new Date(date).getTime();
  if (Number.isNaN(ts)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

export function computeDeveloperScoreBreakdown({
  config,
  events,
  totalStars,
  followers,
  publicRepos,
  createdAt
}) {
  if (!config || typeof config !== 'object') {
    throw new Error('score-breakdown: config is required');
  }

  const starWeight = config.STAR_WEIGHT ?? 2;
  const maxStars = config.MAX_STARS_FOR_SCORING ?? 250;
  const maxFollowers = config.MAX_FOLLOWERS_FOR_SCORING ?? 500;
  const maxPublicRepos = config.MAX_PUBLIC_REPOS_FOR_SCORING ?? 200;
  const sixMonthsDays = config.SIX_MONTHS_DAYS ?? 180;
  const followerWeight = config.WEIGHTS?.followers ?? 1;
  const publicRepoWeight = config.WEIGHTS?.publicRepos ?? 0.5;

  const rawStars = Math.max(0, Math.floor(Number(totalStars) || 0));
  const cappedStars = Math.min(rawStars, maxStars);
  const starsPoints = cappedStars * starWeight;

  const rawFollowers = Math.max(0, Math.floor(Number(followers) || 0));
  const cappedFollowers = Math.min(rawFollowers, maxFollowers);
  const followersPoints = cappedFollowers * followerWeight;

  const rawRepos = Math.max(0, Math.floor(Number(publicRepos) || 0));
  const cappedRepos = Math.min(rawRepos, maxPublicRepos);
  const publicReposPoints = cappedRepos * publicRepoWeight;

  const activity = computeActivityBreakdown30d(events, { config });

  const baseScore = starsPoints + activity.total + followersPoints + publicReposPoints;

  const accountAgeDays = breakdownDaysSince(createdAt);
  const agePenaltyApplied = accountAgeDays < sixMonthsDays;
  const ageMultiplier = agePenaltyApplied ? 0.5 : 1;
  const finalScore = Math.round(baseScore * ageMultiplier);
  const penaltyPointsLost = agePenaltyApplied ? Math.round(baseScore - finalScore) : 0;

  return {
    stars: {
      raw: rawStars,
      capped: cappedStars,
      weight: starWeight,
      points: starsPoints,
      capApplied: rawStars > cappedStars
    },
    followers: {
      raw: rawFollowers,
      capped: cappedFollowers,
      points: followersPoints,
      capApplied: rawFollowers > cappedFollowers
    },
    publicRepos: {
      raw: rawRepos,
      capped: cappedRepos,
      weight: publicRepoWeight,
      points: publicReposPoints,
      capApplied: rawRepos > cappedRepos
    },
    activity: {
      total: activity.total,
      byType: activity.byType
    },
    baseScore,
    agePenalty: {
      applied: agePenaltyApplied,
      multiplier: ageMultiplier,
      accountAgeDays: Number.isFinite(accountAgeDays) ? accountAgeDays : null,
      pointsLost: penaltyPointsLost,
      label: agePenaltyApplied ? '0.5× new account penalty' : null
    },
    finalScore
  };
}
