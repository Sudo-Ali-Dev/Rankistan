/**
 * The 30-day activity term of the score: per UTC day and per event type,
 * `base / log2(n + 1)` for the n-th event, summed and then capped.
 *
 * Moved here from src/utils/activity-score.js, minus its two fallbacks:
 * `getActivityScoringConfig` substituted built-in weights when the config
 * lacked ACTIVITY_SCORING, and `computeActivityScore30dFromCounts` scored a
 * 30-day *total* as though it were a single day, applying one daily cap to a
 * month of work. Both produced a number that looked like a score and was not.
 * This module scores the events it is given, or throws.
 *
 * Summation order is part of the result. Floating-point addition is not
 * associative, so days are accumulated in the order their first event appears
 * and types are totalled push, pr, issue, release, exactly as before; the
 * differential test holds this to the bit against the previous implementation.
 */
import { assertValidatedConfig } from './config.js';

export const MEANINGFUL_EVENT_TYPES = new Set([
  'PushEvent',
  'PullRequestEvent',
  'IssuesEvent',
  'ReleaseEvent'
]);

export const EVENT_TYPE_TO_KEY = Object.freeze({
  PushEvent: 'push',
  PullRequestEvent: 'pr',
  IssuesEvent: 'issue',
  ReleaseEvent: 'release'
});

export const SCORING_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function marginalPoints(n, base) {
  return base / Math.log2(n + 1);
}

/** Points for `count` events of one type on one UTC day. */
export function scoreDayType(count, typeConfig) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (safeCount === 0) {
    return 0;
  }

  const { base, dailyCap, maxCountedPerDay } = typeConfig;
  const limit = maxCountedPerDay === null ? safeCount : Math.min(safeCount, maxCountedPerDay);
  let sum = 0;

  for (let n = 1; n <= limit; n += 1) {
    sum += marginalPoints(n, base);
  }

  return Math.min(dailyCap, sum);
}

function utcDayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/**
 * Count meaningful events per (UTC day, type) inside the window ending at
 * `now`. A Map, so iteration follows first appearance.
 */
function countByDayAndType(events, now) {
  const counts = new Map();
  const cutoff = now - SCORING_WINDOW_DAYS * DAY_MS;

  for (const event of events) {
    if (!MEANINGFUL_EVENT_TYPES.has(event?.type)) {
      continue;
    }

    const ts = new Date(event.created_at).getTime();
    if (Number.isNaN(ts) || ts < cutoff) {
      continue;
    }

    const key = `${utcDayKey(ts)}|${EVENT_TYPE_TO_KEY[event.type]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

export function requireNow(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(
      'scoring model: `now` is required (a Date or epoch milliseconds); ' +
        'the score depends on it, so it is never read from the clock implicitly'
    );
  }
  return ms;
}

/**
 * Activity points by type over the 30 days ending at `now`.
 *
 * @returns {{ total: number, byType: Record<'push'|'pr'|'issue'|'release', { points: number, events30d: number }> }}
 */
export function computeActivityBreakdown30d(events, { config, now } = {}) {
  assertValidatedConfig(config);
  const nowMs = requireNow(now);
  if (!Array.isArray(events)) {
    throw new TypeError('scoring model: events must be an array');
  }

  const byType = {
    push: { points: 0, events30d: 0 },
    pr: { points: 0, events30d: 0 },
    issue: { points: 0, events30d: 0 },
    release: { points: 0, events30d: 0 }
  };

  for (const [key, count] of countByDayAndType(events, nowMs)) {
    const typeKey = key.slice(key.indexOf('|') + 1);
    byType[typeKey].events30d += count;
    byType[typeKey].points += scoreDayType(count, config.ACTIVITY_SCORING[typeKey]);
  }

  const total = Object.values(byType).reduce((sum, row) => sum + row.points, 0);

  return { total, byType };
}

export function computeActivityScore30d(events, options) {
  return computeActivityBreakdown30d(events, options).total;
}
