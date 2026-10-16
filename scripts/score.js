import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_CONFIG } from '../src/model/config.js';
import { scoreModel, publishedScoreFields } from '../src/model/score.js';
import { CONTRIBUTIONS_FIELD } from './measure/contributions.js';

/**
 * Score rows from their measurement. All the arithmetic lives in src/model/: this attaches the
 * published fields to each row. The score is a function of the row's `contributions` block and
 * the moderation list alone, so scoring a row twice gives the same bits, and every run re-scores
 * the whole board (scripts/run-all.js, rescoreRows) rather than carrying old numbers.
 *
 * @param {object[]} rows  rows carrying a `contributions` block
 * @param {{moderation?: object[]}} [options]
 * @returns {object[]} the rows with score, score_exact, score_parts, model_version and scored_at,
 *   and `gate` (whether the measurement passes the eligibility gate), in input order
 */
export function scoreDevelopers(rows, { moderation = [] } = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('Expected an array of developers.');
  }
  return rows.map((row) => {
    const result = scoreModel(row[CONTRIBUTIONS_FIELD], { config: SCORE_CONFIG, moderation });
    return {
      ...row,
      tags: Array.isArray(row.tags) ? row.tags : [],
      ...publishedScoreFields(result, { config: SCORE_CONFIG }),
      gate: result.gate
    };
  });
}

async function runCli() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: node scripts/score.js <board.json>');
    process.exit(1);
  }
  const payload = JSON.parse(await fs.readFile(path.resolve(process.cwd(), inputArg), 'utf8'));
  const rows = (payload.leaderboard || payload).filter((row) => row?.[CONTRIBUTIONS_FIELD]);
  const scored = scoreDevelopers(rows).sort((a, b) => b.score_exact - a.score_exact);
  for (const row of scored.slice(0, 20)) {
    console.log(`${String(row.score).padStart(4)}  ${row.username}`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
