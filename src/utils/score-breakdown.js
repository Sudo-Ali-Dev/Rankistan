/**
 * The Register preview's view of a score: src/model/ reshaped for
 * ScoreBreakdownPanel. No arithmetic happens here.
 *
 * This file used to be a second implementation of the formula, with every
 * config value repeated as a `??` default. It agreed with the pipeline only
 * because nobody had changed a key yet.
 */
import { SCORE_CONFIG } from '../model/config.js';
import { scoreModel } from '../model/score.js';

export const ACTIVITY_TYPE_ROWS = [
  { typeKey: 'push', eventType: 'PushEvent', label: 'PushEvent' },
  { typeKey: 'pr', eventType: 'PullRequestEvent', label: 'PullRequestEvent' },
  { typeKey: 'issue', eventType: 'IssuesEvent', label: 'IssuesEvent' },
  { typeKey: 'release', eventType: 'ReleaseEvent', label: 'ReleaseEvent' }
];

/**
 * @param {{ events: object[], totalStars: number, followers: number,
 *           publicRepos: number, createdAt: string, now: number | Date }} input
 */
export function computeDeveloperScoreBreakdown({
  events,
  totalStars,
  followers,
  publicRepos,
  createdAt,
  now
}) {
  const result = scoreModel(
    {
      total_stars: totalStars,
      followers,
      public_repos: publicRepos,
      created_at: createdAt,
      raw_events_60d: events
    },
    { config: SCORE_CONFIG, now }
  );

  const { stars, public_repos: repos, activity, base_score: baseScore, age } = result.components;
  const followerPart = result.components.followers;

  return {
    stars: {
      raw: stars.raw,
      capped: stars.capped,
      weight: stars.weight,
      points: stars.points,
      capApplied: stars.raw > stars.capped
    },
    followers: {
      raw: followerPart.raw,
      capped: followerPart.capped,
      weight: followerPart.weight,
      points: followerPart.points,
      capApplied: followerPart.raw > followerPart.capped
    },
    publicRepos: {
      raw: repos.raw,
      capped: repos.capped,
      weight: repos.weight,
      points: repos.points,
      capApplied: repos.raw > repos.capped
    },
    activity: {
      total: activity.points,
      byType: activity.by_type,
      rules: SCORE_CONFIG.ACTIVITY_SCORING
    },
    baseScore,
    agePenalty: {
      applied: age.applied,
      multiplier: age.multiplier,
      accountAgeDays: age.account_age_days,
      pointsLost: age.applied ? Math.round(baseScore - result.score) : 0,
      label: age.applied ? `${age.multiplier}× new account penalty` : null
    },
    finalScore: result.score
  };
}
