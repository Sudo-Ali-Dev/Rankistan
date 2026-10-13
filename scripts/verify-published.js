/**
 * Check that a published leaderboard is what the model says it should be.
 *
 *   node scripts/verify-published.js [path]      (default: public/data.json)
 *
 * For every row stamped with a `model_version`, the score is recomputed from
 * the row's own published fields and must match exactly; all stamped rows
 * must share one version; and the board must be in compareRows order with
 * ranks 1..n.
 *
 * Rows with no `model_version` were published before versioned scoring, by
 * the same formula, and do not carry the fields a recomputation needs. They
 * are counted rather than failed, and each disappears the next time its batch
 * runs. A board with no stamped rows at all was also *ordered* by the previous
 * code, so its order is reported (how many rows the new order would move) but
 * not asserted. Once any batch has merged under the new code, the whole board
 * has been re-sorted by compareRows, and from then on the order is asserted.
 *
 * The pipeline runs this on every board before saving it (run-all.js). During
 * a model migration the board is mixed by construction - one batch re-scored,
 * 23 still on the old version - and stays mixed until every batch has run, so
 * `allowMixedVersions` (ALLOW_MIXED_MODELS=1 in the pipeline) accepts several
 * versions and skips recomputing rows from another major version, which by
 * definition this code cannot reproduce. Rows on this major version are still
 * recomputed, and order, ranks and duplicates are still checked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_CONFIG, majorVersion } from '../src/model/config.js';
import { recomputePublished } from '../src/model/score.js';
import { compareRows } from '../src/model/order.js';

const MAX_LISTED = 20;

// A malformed version is not "another major": recomputation reports it.
function fromOtherMajor(row, config) {
  try {
    return majorVersion(row.model_version) !== majorVersion(config.MODEL_VERSION);
  } catch {
    return false;
  }
}

function label(row, index) {
  return `#${index + 1} ${JSON.stringify(row?.username)}`;
}

export function verifyPublished(
  payload,
  { config = SCORE_CONFIG, allowMixedVersions = false } = {}
) {
  const errors = [];
  const rows = payload?.leaderboard;

  if (!Array.isArray(rows)) {
    return {
      total: 0,
      stamped: 0,
      legacy: 0,
      versions: [],
      recomputed: 0,
      foreign: 0,
      orderAsserted: false,
      wouldMove: null,
      errors: ['payload has no "leaderboard" array']
    };
  }

  const stampedIdx = [];
  let legacy = 0;
  rows.forEach((row, i) => {
    if (typeof row?.model_version === 'string') stampedIdx.push(i);
    else legacy += 1;
  });

  // One ranking, one model. A board that mixes them orders scores computed
  // by different formulas against each other, and no single row looks wrong.
  const versions = [...new Set(stampedIdx.map((i) => rows[i].model_version))].sort();
  if (versions.length > 1 && !allowMixedVersions) {
    errors.push(
      `stamped rows carry ${versions.length} model versions (${versions.join(', ')}); ` +
        'a ranking may not mix scoring models'
    );
  }

  let recomputed = 0;
  let foreign = 0;
  for (const i of stampedIdx) {
    const row = rows[i];
    if (allowMixedVersions && fromOtherMajor(row, config)) {
      foreign += 1;
      continue;
    }
    try {
      const { score, score_exact } = recomputePublished(row, { config });
      if (score !== row.score) {
        errors.push(`${label(row, i)}: published score ${row.score}, recomputed ${score}`);
      } else if (score_exact !== row.score_exact) {
        errors.push(
          `${label(row, i)}: published score_exact ${row.score_exact}, recomputed ${score_exact}`
        );
      } else {
        recomputed += 1;
      }
    } catch (error) {
      errors.push(`${label(row, i)}: ${error.message}`);
    }
  }

  const seen = new Set();
  rows.forEach((row, i) => {
    if (row?.rank !== i + 1) {
      errors.push(`${label(row, i)}: rank is ${row?.rank}, expected ${i + 1}`);
    }
    const key = String(row?.username).toLowerCase();
    if (seen.has(key)) {
      errors.push(`${label(row, i)}: appears more than once`);
    }
    seen.add(key);
  });

  const orderAsserted = stampedIdx.length > 0;
  let wouldMove = null;
  try {
    if (orderAsserted) {
      for (let i = 1; i < rows.length; i += 1) {
        if (compareRows(rows[i - 1], rows[i]) >= 0) {
          errors.push(
            `${label(rows[i - 1], i - 1)} and ${label(rows[i], i)} are not in compareRows order`
          );
        }
      }
    } else {
      const sorted = [...rows].sort(compareRows);
      wouldMove = sorted.filter((row, i) => row !== rows[i]).length;
    }
  } catch (error) {
    errors.push(`order: ${error.message}`);
  }

  return {
    total: rows.length,
    stamped: stampedIdx.length,
    legacy,
    versions,
    recomputed,
    foreign,
    orderAsserted,
    wouldMove,
    errors
  };
}

function main() {
  const target = path.resolve(process.cwd(), process.argv[2] || path.join('public', 'data.json'));
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  const report = verifyPublished(payload);

  console.log(`Verifying ${target}`);
  console.log(
    `  ${report.total} rows: ${report.stamped} stamped ` +
      `(${report.versions.join(', ') || 'no version'}), ${report.legacy} legacy`
  );
  console.log(`  ${report.recomputed} of ${report.stamped} stamped scores recomputed exactly`);
  if (report.legacy > 0) {
    console.log(
      `  ${report.legacy} legacy rows predate versioned scoring; they carry no fields to ` +
        'recompute from and are replaced as each batch re-runs'
    );
  }
  if (report.orderAsserted) {
    console.log('  board order checked against compareRows');
  } else if (report.wouldMove !== null) {
    console.log(
      `  no stamped rows, so the board was ordered by the previous code; ` +
        `${report.wouldMove} rows would move under compareRows (not asserted)`
    );
  }

  if (report.errors.length > 0) {
    console.error(`\nFAIL: ${report.errors.length} problem(s)`);
    for (const message of report.errors.slice(0, MAX_LISTED)) {
      console.error(`  ${message}`);
    }
    if (report.errors.length > MAX_LISTED) {
      console.error(`  ... and ${report.errors.length - MAX_LISTED} more`);
    }
    process.exit(1);
  }

  console.log('\nPublished leaderboard verified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
