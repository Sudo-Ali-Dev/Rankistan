import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_CONFIG } from '../src/model/config.js';
import { scoreModel, publishedScoreFields } from '../src/model/score.js';

/**
 * Score and rank one batch of developers.
 *
 * All the arithmetic lives in src/model/. This attaches the published model
 * fields to each row and orders the batch. One `now` serves the whole batch,
 * so every row in it is scored at the same instant and records that instant
 * as `scored_at`.
 */
export function scoreDevelopers(rawDevelopers, { now = Date.now() } = {}) {
  if (!Array.isArray(rawDevelopers)) {
    throw new Error('Expected an array of developers.');
  }

  const scored = rawDevelopers.map((developer) => {
    const result = scoreModel(developer, { config: SCORE_CONFIG, now });

    return {
      ...developer,
      tags: Array.isArray(developer.tags) ? developer.tags : [],
      ...publishedScoreFields(result, { config: SCORE_CONFIG, now }),
      age_penalty_applied: result.age_penalty_applied
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
