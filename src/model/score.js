/**
 * The developer score. This is the only implementation: the pipeline
 * (scripts/score.js), the Register preview (src/utils/score-breakdown.js) and
 * the published-board check (scripts/verify-published.js) all call it.
 *
 *   base  = min(stars, cap)·w + activity + min(followers, cap)·w + min(repos, cap)·w
 *   exact = base × (account younger than SIX_MONTHS_DAYS ? AGE_PENALTY_MULTIPLIER : 1)
 *   score = round(exact)
 *
 * Every input is required. The previous pipeline had three ways to arrive at
 * an activity figure - the events, a per-type 30-day count scored as though it
 * were one day, and `events_30d × 3.125` - and the last two are gone. A
 * published score is computed from the measurement or it is not computed.
 */
import { assertValidatedConfig, majorVersion, SCORE_CONFIG } from './config.js';
import { computeActivityBreakdown30d, requireNow } from './activity.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What scoreModel reads from a developer. Nothing else affects the score. */
export const MODEL_INPUT_FIELDS = Object.freeze([
  'total_stars',
  'followers',
  'public_repos',
  'created_at',
  'raw_events_60d'
]);

/**
 * What a published row must carry, beyond the profile counts and created_at,
 * for its score to be recomputed without the raw events. The age penalty
 * depends on when the row was scored, so `scored_at` is part of the input.
 */
export const PUBLISHED_MODEL_FIELDS = Object.freeze([
  'score_exact',
  'activity_score',
  'model_version',
  'scored_at'
]);

function whose(row) {
  return typeof row?.username === 'string' ? ` for ${row.username}` : '';
}

function show(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function requireCount(row, field) {
  const value = row?.[field];
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `scoring model: \`${field}\` must be a non-negative integer${whose(row)}, got ${show(value)}`
    );
  }
  return value;
}

function requireTimestamp(row, field) {
  const value = row?.[field];
  const ms = typeof value === 'string' ? new Date(value).getTime() : NaN;
  if (Number.isNaN(ms)) {
    throw new TypeError(
      `scoring model: \`${field}\` must be an ISO date string${whose(row)}, got ${show(value)}`
    );
  }
  return ms;
}

/**
 * Everything after the activity term. Shared by scoreModel and
 * recomputePublished so the two cannot drift: a published score is checked by
 * the same arithmetic that produced it.
 */
function combine({ stars, followers, publicRepos, activityScore, createdAtMs, nowMs }, config) {
  const cappedStars = Math.min(stars, config.MAX_STARS_FOR_SCORING);
  const cappedFollowers = Math.min(followers, config.MAX_FOLLOWERS_FOR_SCORING);
  const cappedPublicRepos = Math.min(publicRepos, config.MAX_PUBLIC_REPOS_FOR_SCORING);

  const starsPoints = cappedStars * config.STAR_WEIGHT;
  const followersPoints = cappedFollowers * config.WEIGHTS.followers;
  const publicReposPoints = cappedPublicRepos * config.WEIGHTS.publicRepos;

  // Left to right, in this order. It is the order the score has always been
  // summed in, and floating-point addition is not associative.
  const baseScore = starsPoints + activityScore + followersPoints + publicReposPoints;

  const accountAgeDays = Math.floor((nowMs - createdAtMs) / DAY_MS);
  const agePenaltyApplied = accountAgeDays < config.SIX_MONTHS_DAYS;
  const multiplier = agePenaltyApplied ? config.AGE_PENALTY_MULTIPLIER : 1;
  const scoreExact = baseScore * multiplier;

  if (!Number.isFinite(scoreExact)) {
    throw new RangeError(`scoring model: score is not finite (${scoreExact})`);
  }

  return {
    score: Math.round(scoreExact),
    score_exact: scoreExact,
    age_penalty_applied: agePenaltyApplied,
    components: {
      stars: {
        raw: stars,
        capped: cappedStars,
        cap: config.MAX_STARS_FOR_SCORING,
        weight: config.STAR_WEIGHT,
        points: starsPoints
      },
      followers: {
        raw: followers,
        capped: cappedFollowers,
        cap: config.MAX_FOLLOWERS_FOR_SCORING,
        weight: config.WEIGHTS.followers,
        points: followersPoints
      },
      public_repos: {
        raw: publicRepos,
        capped: cappedPublicRepos,
        cap: config.MAX_PUBLIC_REPOS_FOR_SCORING,
        weight: config.WEIGHTS.publicRepos,
        points: publicReposPoints
      },
      base_score: baseScore,
      age: {
        account_age_days: accountAgeDays,
        threshold_days: config.SIX_MONTHS_DAYS,
        multiplier,
        applied: agePenaltyApplied
      }
    }
  };
}

/**
 * Score one developer.
 *
 * @param {{ total_stars: number, followers: number, public_repos: number,
 *           created_at: string, raw_events_60d: object[] }} inputs
 * @param {{ config: object, now: Date | number }} options
 *   `config` must come from validateScoreConfig (use SCORE_CONFIG). `now` is
 *   the instant the score is taken at; both the 30-day window and the age
 *   penalty are measured from it.
 */
export function scoreModel(inputs, { config, now } = {}) {
  assertValidatedConfig(config);
  const nowMs = requireNow(now);

  if (inputs === null || typeof inputs !== 'object') {
    throw new TypeError(`scoring model: expected a developer object, got ${show(inputs)}`);
  }

  const stars = requireCount(inputs, 'total_stars');
  const followers = requireCount(inputs, 'followers');
  const publicRepos = requireCount(inputs, 'public_repos');
  const createdAtMs = requireTimestamp(inputs, 'created_at');

  if (!Array.isArray(inputs.raw_events_60d)) {
    throw new TypeError(
      `scoring model: \`raw_events_60d\` is required${whose(inputs)}. ` +
        'There is no approximate path: a score is computed from the events or not at all.'
    );
  }

  const activity = computeActivityBreakdown30d(inputs.raw_events_60d, { config, now: nowMs });
  const combined = combine(
    { stars, followers, publicRepos, activityScore: activity.total, createdAtMs, nowMs },
    config
  );

  return {
    score: combined.score,
    score_exact: combined.score_exact,
    activity_score: activity.total,
    components: {
      ...combined.components,
      activity: { points: activity.total, by_type: activity.byType }
    },
    age_penalty_applied: combined.age_penalty_applied
  };
}

/**
 * The model fields a scored row is published with. `scored_at` is `now`
 * itself, at millisecond precision, so the age penalty recomputes exactly.
 */
export function publishedScoreFields(result, { config, now } = {}) {
  assertValidatedConfig(config);
  return {
    score: result.score,
    score_exact: result.score_exact,
    activity_score: result.activity_score,
    model_version: config.MODEL_VERSION,
    scored_at: new Date(requireNow(now)).toISOString()
  };
}

/**
 * Recompute `score` and `score_exact` from a published row alone.
 *
 * The raw events are not published, so `activity_score` is taken as measured;
 * everything downstream of it - caps, weights, the sum, the age penalty, the
 * rounding - is recomputed. A row from a different major model version is
 * refused, since by definition its score is not this model's to reproduce.
 * Within a major version, minor and patch releases promise identical scores,
 * so a mismatch there is a broken promise and is reported as one.
 */
export function recomputePublished(row, { config } = {}) {
  assertValidatedConfig(config);

  if (typeof row?.model_version !== 'string') {
    throw new TypeError(
      `scoring model: row${whose(row)} has no model_version; it predates versioned scoring ` +
        'and cannot be recomputed'
    );
  }
  if (majorVersion(row.model_version) !== majorVersion(config.MODEL_VERSION)) {
    throw new RangeError(
      `scoring model: row${whose(row)} was scored by model ${row.model_version}, ` +
        `this code is ${config.MODEL_VERSION}; across a major version scores are not comparable`
    );
  }

  const activityScore = row.activity_score;
  if (typeof activityScore !== 'number' || !Number.isFinite(activityScore) || activityScore < 0) {
    throw new TypeError(
      `scoring model: \`activity_score\` must be a finite number >= 0${whose(row)}, ` +
        `got ${show(activityScore)}`
    );
  }

  const { score, score_exact } = combine(
    {
      stars: requireCount(row, 'total_stars'),
      followers: requireCount(row, 'followers'),
      publicRepos: requireCount(row, 'public_repos'),
      activityScore,
      createdAtMs: requireTimestamp(row, 'created_at'),
      nowMs: requireTimestamp(row, 'scored_at')
    },
    config
  );

  return { score, score_exact };
}

/** The published row's score, recomputed under the model this code ships. */
export function scoreFromPublished(row) {
  return recomputePublished(row, { config: SCORE_CONFIG }).score;
}
