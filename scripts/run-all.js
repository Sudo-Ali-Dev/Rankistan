import fs from 'node:fs';
import path from 'node:path';
import {
  fetchPakistaniDevelopers,
  applyActivityFilter,
  SEARCH_BATCHES,
  MAX_DEVELOPERS,
  ACTIVITY_THRESHOLDS
} from './fetch-devs.js';
import { scoreDevelopers } from './score.js';
import { stripInternalFields, atomicWriteJsonSync } from './write-leaderboard.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_JSON = path.join(PUBLIC_DIR, 'data.json');
const DRY_RUN_DATA_JSON = path.join(PUBLIC_DIR, 'data.dry-run.json');

function loadExistingLeaderboard(targetPath = DATA_JSON) {
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.leaderboard) ? data.leaderboard : [];
  } catch {
    return [];
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

  const scored = scoreDevelopers(filtered);
  console.log(`Scored ${scored.length} developers.`);

  const newEntries = scored.map((d) => ({
    ...stripInternalFields(d),
    batch_index: batchIndex,
  }));

  const existing = loadExistingLeaderboard(DATA_JSON);
  const kept = existing.filter((d) => d.batch_index !== batchIndex);
  
  // Strict Transaction Integrity Check
  const removedCount = existing.length - kept.length;
  if (removedCount > 0 && newEntries.length === 0) {
    throw new Error(
      `Data Integrity Exception: Refusing to update batch ${batchIndex} (${SEARCH_BATCHES[batchIndex].label}). ` +
      `This operation would permanently purge ${removedCount} existing records without replacing them with new data. ` +
      `Aborting write sequence to maintain fallback data.`
    );
  }

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

const args = process.argv.slice(2);
const mode = args[0];
const dryRun = args.includes('--dry-run') || process.env.SKIP_GITHUB === 'true';

if (mode === '--incremental') {
  const idx = parseInt(args[1], 10);
  if (Number.isNaN(idx)) {
    console.error('Usage: node scripts/run-all.js --incremental <batch-index> [--dry-run]');
    process.exit(1);
  }
  runIncremental(idx, { dryRun }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.error('Usage: node scripts/run-all.js --incremental <batch-index> [--dry-run]');
  process.exit(1);
}