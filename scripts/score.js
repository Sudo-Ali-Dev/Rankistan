import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../score-config.json' with { type: 'json' };
import {
  computeActivityScore30d,
  computeActivityScore30dFromCounts
} from '../src/utils/activity-score.js';

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
    console.warn(`Missing/invalid ${field} for ${developer?.username || 'unknown'}; defaulting to 0.`);
    return 0;
  }

  return n;
}

function calculateDeveloperScore(developer) {
  const stars       = sanitizeScoreField(developer, 'total_stars');
  const followers   = sanitizeScoreField(developer, 'followers');
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
    cappedStars       * STAR_WEIGHT          +
    activityScore                            +
    cappedFollowers   * WEIGHTS.followers    +
    cappedPublicRepos * WEIGHTS.publicRepos;

  const accountAgeDays    = daysSince(developer.created_at);
  const isNewAccount      = accountAgeDays < SIX_MONTHS_DAYS;
  const penaltyMultiplier = isNewAccount ? 0.5 : 1;

  const finalScore = Number.isFinite(baseScore)
    ? Math.round(baseScore * penaltyMultiplier)
    : 0;

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

export { calculateDeveloperScore, WEIGHTS, SIX_MONTHS_DAYS };

async function runCli() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];

  if (!inputArg) {
    console.error('Usage: node scripts/score.js <input-json> [output-json]');
    process.exit(1);
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : null;

  const raw = await fs.readFile(inputPath, 'utf8');
  const developers = JSON.parse(raw);

  const ranked = scoreDevelopers(developers);

  if (outputPath) {
    await fs.writeFile(outputPath, JSON.stringify(ranked, null, 2));
    console.log(`Scored ${ranked.length} developers -> ${outputPath}`);
    return;
  }

  console.log(JSON.stringify(ranked.slice(0, 10), null, 2));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
