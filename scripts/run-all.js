import fs from 'node:fs';
import os from 'node:os';
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

  saveBatchEntries(batchIndex, newEntries);
  mergeBatchIntoLeaderboard({ batchIndex, newEntries, targetPath });
}

/**
 * Where this batch's own rows are parked so the merge can be replayed without
 * going back to GitHub.
 *
 * Deliberately outside the working tree: the retry in the workflow resets hard
 * onto origin/main between attempts, and anything kept in the repo would be
 * thrown away exactly when it is needed.
 */
export function batchEntriesPath(batchIndex) {
  const dir = process.env.BATCH_OUTPUT_DIR || os.tmpdir();
  return path.join(dir, `rankistan-batch-${batchIndex}.json`);
}

function saveBatchEntries(batchIndex, entries) {
  const target = batchEntriesPath(batchIndex);
  atomicWriteJsonSync(target, { batch_index: batchIndex, entries });
  console.log(`Batch ${batchIndex} rows saved for re-merge: ${target}`);
}

/**
 * Fold one batch's rows into whatever the leaderboard currently holds.
 *
 * This is the whole of the merge, and it is a merge *by row owner*: every row
 * carries the `batch_index` that produced it, this batch replaces only its own,
 * and the other 23 batches are carried across untouched. Two batches finishing
 * at once are therefore not in conflict - they own disjoint rows.
 *
 * That is why the retry path re-runs this against the newest file rather than
 * asking git to reconcile two versions of it. `public/data.json` is generated,
 * 1.6MB, and rewritten whole on every run; a textual three-way merge of it
 * conflicts every single time, which is what `ci: retry leaderboard push after
 * rebasing onto main` (186ad85) has been doing daily since May.
 */
export function mergeBatchIntoLeaderboard({ batchIndex, newEntries, targetPath = DATA_JSON }) {
  const existing = loadExistingLeaderboard(targetPath);
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
  return output;
}

/**
 * Replay a finished batch onto the leaderboard as it stands right now.
 *
 * Used when a push loses the race: rather than reconciling two rewrites of a
 * generated file, take the newest file and fold this batch's saved rows back
 * into it. The integrity checks run again on the way through, so a replay
 * cannot smuggle in a shrunken or mixed-model board.
 */
export function remergeBatch(batchIndex, { targetPath = DATA_JSON } = {}) {
  const source = batchEntriesPath(batchIndex);
  if (!fs.existsSync(source)) {
    throw new Error(
      `No saved rows for batch ${batchIndex} at ${source}. ` +
      `A re-merge can only replay a batch this run already computed.`
    );
  }

  const saved = JSON.parse(fs.readFileSync(source, 'utf8'));
  const entries = Array.isArray(saved?.entries) ? saved.entries : [];
  if (saved?.batch_index !== batchIndex) {
    throw new Error(
      `Saved rows at ${source} are for batch ${saved?.batch_index}, not ${batchIndex}.`
    );
  }
  if (entries.length === 0) {
    throw new Error(`Saved rows for batch ${batchIndex} are empty; refusing to re-merge.`);
  }

  console.log(`\nRe-merging batch ${batchIndex} (${entries.length} rows) onto the current file.`);
  return mergeBatchIntoLeaderboard({ batchIndex, newEntries: entries, targetPath });
}

// Only run the CLI when this file is the process entry point. Previously the
// block below executed on *import*, so the module could not be imported by a
// test without process.exit(1) tearing the runner down.
function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const dryRun = args.includes('--dry-run') || process.env.SKIP_GITHUB === 'true';
  const usage =
    'Usage: node scripts/run-all.js --incremental <batch-index> [--dry-run]\n' +
    '       node scripts/run-all.js --remerge <batch-index>';

  if (mode !== '--incremental' && mode !== '--remerge') {
    console.error(usage);
    process.exit(1);
  }

  const idx = parseInt(args[1], 10);
  if (Number.isNaN(idx)) {
    console.error(usage);
    process.exit(1);
  }

  // `--remerge` touches no network: it replays rows this run already fetched.
  if (mode === '--remerge') {
    try {
      remergeBatch(idx);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
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
