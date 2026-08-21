import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchPakistaniDevelopers,
  applyActivityFilter,
  SEARCH_BATCHES,
  MAX_DEVELOPERS,
  ACTIVITY_THRESHOLDS
} from './fetch-devs.js';
import { fetchPronouns, attachPronouns } from './fetch-pronouns.js';
import { scoreDevelopers } from './score.js';
import { stripInternalFields, atomicWriteJsonSync } from './write-leaderboard.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_JSON = path.join(PUBLIC_DIR, 'data.json');
const DRY_RUN_DATA_JSON = path.join(PUBLIC_DIR, 'data.dry-run.json');

function loadExistingLeaderboard(targetPath = DATA_JSON) {
  if (!fs.existsSync(targetPath)) {
    // First run, or a checkout without published data. Empty is the correct
    // starting point, and there is nothing to purge.
    console.warn(`No existing leaderboard at ${targetPath}; starting from empty.`);
    return [];
  }

  // Any other failure must abort. The previous `catch { return [] }` turned an
  // unreadable file, a truncated write or invalid JSON into "no existing data",
  // which made removedCount 0, which silently bypassed the integrity check
  // below - publishing a leaderboard containing only the current batch and
  // deleting every other developer.
  const raw = fs.readFileSync(targetPath, 'utf8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.leaderboard)) {
    throw new Error(
      `Existing leaderboard at ${targetPath} is missing its "leaderboard" array. ` +
      `Refusing to treat this as empty.`
    );
  }

  return data.leaderboard;
}
// A batch replaces its own cohort wholesale, so the write is only safe if the
// incoming set is a plausible replacement for what it displaces.
//
// The original check fired only when the batch returned *nothing*. Per-developer
// fetch failures in fetch-devs.js are caught and merely counted, and secondary
// rate limits already cause roughly 5% of pipeline runs to fail, so a storm
// mid-batch can reduce a 200-developer batch to a handful. That passed the
// zero-only check and purged the rest.
//
// MIN_COHORT_FOR_RATIO_CHECK avoids false alarms on the small batches, where
// natural variance is large: batch sizes currently range from about 12 to 217,
// and a 12-developer cohort losing half its members is ordinary noise.
export const MIN_REPLACEMENT_RATIO = 0.5;
export const MIN_COHORT_FOR_RATIO_CHECK = 20;

export function assertReplacementIsSafe({
  batchIndex,
  batchLabel,
  removedCount,
  replacementCount,
  allowShrink = false
}) {
  if (removedCount <= 0) {
    return;
  }

  if (replacementCount === 0) {
    throw new Error(
      `Data Integrity Exception: Refusing to update batch ${batchIndex} (${batchLabel}). ` +
      `This operation would permanently purge ${removedCount} existing records without ` +
      `replacing them with new data. Aborting write sequence to maintain fallback data.`
    );
  }

  if (allowShrink || removedCount < MIN_COHORT_FOR_RATIO_CHECK) {
    return;
  }

  const floor = removedCount * MIN_REPLACEMENT_RATIO;
  if (replacementCount < floor) {
    throw new Error(
      `Data Integrity Exception: Refusing to update batch ${batchIndex} (${batchLabel}). ` +
      `Only ${replacementCount} developers came back to replace ${removedCount} existing ` +
      `records, below the ${MIN_REPLACEMENT_RATIO * 100}% floor. This usually means the ` +
      `fetch was throttled mid-batch rather than that the cohort really shrank. ` +
      `Set ALLOW_LEADERBOARD_SHRINK=1 to publish anyway.`
    );
  }
}

function buildDryRunOutput(batchIndex, maxDevelopers) {
  // Dry-run mode avoids GitHub entirely. It reuses the current local leaderboard
  // as test data so we can verify JSON generation and atomic writes safely.
  const existing = loadExistingLeaderboard(DATA_JSON);

  let leaderboard =
    existing.length > 0
      ? existing.map((d, i) => ({
          ...d,
          batch_index: typeof d.batch_index === 'number' ? d.batch_index : batchIndex,
          rank: i + 1,
        }))
      : [
          {
            username: 'dry-run-user',
            score: 0,
            batch_index: batchIndex,
            rank: 1,
          },
        ];

  leaderboard = leaderboard.slice(0, maxDevelopers);
  leaderboard.forEach((d, i) => {
    d.rank = i + 1;
  });

  return {
    last_updated: new Date().toISOString(),
    total_devs: leaderboard.length,
    leaderboard,
  };
}

async function runIncremental(batchIndex, { dryRun = false } = {}) {
  if (batchIndex < 0 || batchIndex >= SEARCH_BATCHES.length) {
    console.error(
      `Invalid batch index: ${batchIndex}. Must be 0-${SEARCH_BATCHES.length - 1}.`,
    );
    process.exit(1);
  }

  const targetPath = dryRun ? DRY_RUN_DATA_JSON : DATA_JSON;

  console.log(
    `\n=== Incremental batch ${batchIndex}: ${SEARCH_BATCHES[batchIndex].label} ===\n`,
  );

  if (dryRun) {
    console.log(`DRY RUN: skipping GitHub fetch and writing to ${targetPath}`);
    const output = buildDryRunOutput(batchIndex, MAX_DEVELOPERS);
    atomicWriteJsonSync(targetPath, output);
    console.log(
      `\nDry-run output written: ${output.total_devs} developers (capped at ${MAX_DEVELOPERS}).`,
    );
    return;
  }

  const rawDevs = await fetchPakistaniDevelopers({
    repoRoot: process.cwd(),
    batchIndex,
    rawOnly: true,
  });

  console.log(`Fetched ${rawDevs.length} raw developers.`);

  const filtered = applyActivityFilter(rawDevs);
  console.log(
    `Activity filter: ${rawDevs.length} -> ${filtered.length} passed ` +
      `(>=${ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D} contributions in 60d, ` +
      `<=${ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS}d max gap)`,
  );

  // Use each developer's own declared pronouns in the AI summaries rather
  // than inferring gender from a name (#73). Runs after the activity filter
  // so it covers only the developers that will be published, and failure is
  // non-fatal: a developer with none simply carries none.
  const pronounsByLogin = await fetchPronouns(
    filtered.map((d) => d.username),
    process.env.MY_GITHUB_PAT || process.env.GITHUB_TOKEN
  );
  const withPronouns = attachPronouns(filtered, pronounsByLogin);

  const scored = scoreDevelopers(withPronouns);
  console.log(`Scored ${scored.length} developers.`);

  const newEntries = scored.map((d) => ({
    ...stripInternalFields(d),
    batch_index: batchIndex,
  }));

  const existing = loadExistingLeaderboard(DATA_JSON);
  const kept = existing.filter((d) => d.batch_index !== batchIndex);
  
  const removedCount = existing.length - kept.length;
  assertReplacementIsSafe({
    batchIndex,
    batchLabel: SEARCH_BATCHES[batchIndex].label,
    removedCount,
    replacementCount: newEntries.length,
    allowShrink: process.env.ALLOW_LEADERBOARD_SHRINK === '1'
  });

  console.log(
    `Existing leaderboard: ${existing.length} total, ${kept.length} kept ` +
      `(removed ${removedCount} from batch ${batchIndex}).`,
  );

  const map = new Map(
    kept.map((d) => [String(d.username || '').toLowerCase(), d]),
  );
  for (const dev of newEntries) {
    map.set(String(dev.username || '').toLowerCase(), dev);
  }

  let leaderboard = [...map.values()];
  leaderboard.sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    return diff !== 0
      ? diff
      : String(a.username || '').localeCompare(String(b.username || ''));
  });
  leaderboard = leaderboard.slice(0, MAX_DEVELOPERS);
  leaderboard.forEach((d, i) => {
    d.rank = i + 1;
  });

  const output = {
    last_updated: new Date().toISOString(),
    total_devs: leaderboard.length,
    leaderboard,
  };

  atomicWriteJsonSync(targetPath, output);

  console.log(
    `\nLeaderboard updated: ${leaderboard.length} developers (capped at ${MAX_DEVELOPERS}).`,
  );
  console.log(
    `Added ${newEntries.length} from batch ${batchIndex}, kept ${kept.length} from other batches.`,
  );
}

// Only run the CLI when this file is the process entry point. Previously the
// block below executed on *import*, so the module could not be imported by a
// test without process.exit(1) tearing the runner down.
function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const dryRun = args.includes('--dry-run') || process.env.SKIP_GITHUB === 'true';
  const usage = 'Usage: node scripts/run-all.js --incremental <batch-index> [--dry-run]';

  if (mode !== '--incremental') {
    console.error(usage);
    process.exit(1);
  }

  const idx = parseInt(args[1], 10);
  if (Number.isNaN(idx)) {
    console.error(usage);
    process.exit(1);
  }

  runIncremental(idx, { dryRun }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

// Compare through realpath so a symlinked or differently-cased argv[1] still
// matches. If it somehow does not, say so loudly and fail: exiting 0 having
// silently done nothing would let the hourly pipeline "succeed" without ever
// running a batch.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (isEntryPoint()) {
  main();
} else if (process.argv[1] && /run-all\.js$/i.test(process.argv[1])) {
  console.error(
    `run-all.js was invoked directly but the entry-point check did not match ` +
    `(argv[1]=${process.argv[1]}). Refusing to exit 0 without doing work.`
  );
  process.exit(1);
}
