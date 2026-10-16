/**
 * Check that a published leaderboard is what the model says it should be.
 *
 *   node scripts/verify-published.js [path]      (default: public/data.json)
 *
 * Every row must carry the current model version, and its score must recompute exactly:
 *
 *   - from its measurement, when the row carries one (the pipeline's state): the measurement and
 *     the moderation list are the whole input, so score, score_exact, score_parts and scored_at
 *     must come out bit for bit, and the measurement must still pass the gate;
 *   - from its `score_parts` otherwise (the data.json the site serves, which leaves the
 *     measurement out): score_exact is SCALE times the weighted parts.
 *
 * The board must be in board order for its own date (src/model/order.js), equal scores must
 * share a rank and other ranks follow their position, and no developer may appear twice.
 *
 * The pipeline runs this on every board before saving it (run-all.js), and CI runs it on the
 * dry run's output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_CONFIG } from '../src/model/config.js';
import { recomputePublished, scoreModel } from '../src/model/score.js';
import { boardOrder, boardSeed } from '../src/model/order.js';
import { CONTRIBUTIONS_FIELD } from './measure/contributions.js';
import { loadModerationFile, MODERATION_PATH } from './moderation.js';

const MAX_LISTED = 20;

function label(row, index) {
  return `#${index + 1} ${JSON.stringify(row?.username)}`;
}

function sameParts(a, b) {
  return ['work', 'collaboration', 'appreciation'].every((id) => a?.[id] === b?.[id]);
}

export function verifyPublished(payload, { config = SCORE_CONFIG, moderation = [] } = {}) {
  const errors = [];
  const rows = payload?.leaderboard;
  if (!Array.isArray(rows)) {
    return {
      total: 0,
      fromMeasurement: 0,
      fromParts: 0,
      errors: ['payload has no "leaderboard" array']
    };
  }

  let fromMeasurement = 0;
  let fromParts = 0;
  rows.forEach((row, i) => {
    if (row?.model_version !== config.MODEL_VERSION) {
      errors.push(
        `${label(row, i)}: scored by ${JSON.stringify(row?.model_version)}, not ${config.MODEL_VERSION}`
      );
      return;
    }
    try {
      if (row[CONTRIBUTIONS_FIELD] != null) {
        const result = scoreModel(row[CONTRIBUTIONS_FIELD], { config, moderation });
        if (result.score_exact !== row.score_exact || result.score !== row.score) {
          errors.push(
            `${label(row, i)}: published ${row.score_exact}, its measurement scores ${result.score_exact}`
          );
        } else if (!sameParts(result.parts, row.score_parts)) {
          errors.push(`${label(row, i)}: published parts differ from its measurement's`);
        } else if (result.evidence.measured_at !== row.scored_at) {
          errors.push(
            `${label(row, i)}: scored_at ${row.scored_at}, measured ${result.evidence.measured_at}`
          );
        } else if (!result.gate) {
          errors.push(`${label(row, i)}: its measurement does not pass the gate`);
        } else {
          fromMeasurement += 1;
        }
      } else {
        const { score, score_exact } = recomputePublished(row, { config });
        if (score_exact !== row.score_exact || score !== row.score) {
          errors.push(
            `${label(row, i)}: published ${row.score_exact}, its parts give ${score_exact}`
          );
        } else {
          fromParts += 1;
        }
      }
    } catch (error) {
      errors.push(`${label(row, i)}: ${error.message}`);
    }
  });

  const seen = new Set();
  const seenIds = new Set();
  rows.forEach((row, i) => {
    const expected =
      i > 0 && row?.score_exact === rows[i - 1]?.score_exact ? rows[i - 1]?.rank : i + 1;
    if (row?.rank !== expected)
      errors.push(`${label(row, i)}: rank is ${row?.rank}, expected ${expected}`);
    const key = String(row?.username).toLowerCase();
    if (seen.has(key)) errors.push(`${label(row, i)}: appears more than once`);
    seen.add(key);
    // One account, one row, whatever logins it has had.
    if (Number.isInteger(row?.github_id)) {
      if (seenIds.has(row.github_id))
        errors.push(`${label(row, i)}: account ${row.github_id} appears more than once`);
      seenIds.add(row.github_id);
    }
  });

  try {
    const order = boardOrder(boardSeed(payload.last_updated));
    for (let i = 1; i < rows.length; i += 1) {
      if (order(rows[i - 1], rows[i]) >= 0) {
        errors.push(`${label(rows[i - 1], i - 1)} and ${label(rows[i], i)} are not in board order`);
      }
    }
  } catch (error) {
    errors.push(`order: ${error.message}`);
  }

  return { total: rows.length, fromMeasurement, fromParts, errors };
}

function main() {
  const target = path.resolve(process.cwd(), process.argv[2] || path.join('public', 'data.json'));
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  const moderation = loadModerationFile(path.join(process.cwd(), MODERATION_PATH));
  const report = verifyPublished(payload, { moderation });

  console.log(`Verifying ${target}`);
  console.log(
    `  ${report.total} rows: ${report.fromMeasurement} recomputed from their measurement, ` +
      `${report.fromParts} from their published parts`
  );
  if (report.errors.length > 0) {
    console.error(`\nFAIL: ${report.errors.length} problem(s)`);
    for (const message of report.errors.slice(0, MAX_LISTED)) console.error(`  ${message}`);
    if (report.errors.length > MAX_LISTED)
      console.error(`  ... and ${report.errors.length - MAX_LISTED} more`);
    process.exit(1);
  }
  console.log('\nPublished leaderboard verified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
