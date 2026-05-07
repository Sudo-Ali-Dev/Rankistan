'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_JSON = path.join(PUBLIC_DIR, 'data.json');

function loadExistingLeaderboard() {
  try {
    const raw = fs.readFileSync(DATA_JSON, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.leaderboard) ? data.leaderboard : [];
  } catch {
    return [];
  }
}

async function runIncremental(batchIndex) {
  const {
    fetchPakistaniDevelopers,
    applyActivityFilter,
    SEARCH_BATCHES,
    MAX_DEVELOPERS,
    ACTIVITY_THRESHOLDS
  } = require('./fetch-devs.js');
  const { scoreDevelopers } = require('./score.js');
  const { stripInternalFields } = require('./write-leaderboard.js');

  if (batchIndex < 0 || batchIndex >= SEARCH_BATCHES.length) {
    console.error(`Invalid batch index: ${batchIndex}. Must be 0-${SEARCH_BATCHES.length - 1}.`);
    process.exit(1);
  }

  console.log(`\n=== Incremental batch ${batchIndex}: ${SEARCH_BATCHES[batchIndex].label} ===\n`);

  const rawDevs = await fetchPakistaniDevelopers({
    repoRoot: process.cwd(),
    batchIndex,
    rawOnly: true
  });

  console.log(`Fetched ${rawDevs.length} raw developers.`);

  const filtered = applyActivityFilter(rawDevs);
  console.log(
    `Activity filter: ${rawDevs.length} -> ${filtered.length} passed ` +
    `(>=${ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D} contributions in 60d, ` +
    `<=${ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS}d max gap)`
  );

  const scored = scoreDevelopers(filtered);
  console.log(`Scored ${scored.length} developers.`);

  const newEntries = scored.map((d) => ({
    ...stripInternalFields(d),
    batch_index: batchIndex
  }));

  const existing = loadExistingLeaderboard();
  const kept = existing.filter((d) => d.batch_index !== batchIndex);
  console.log(`Existing leaderboard: ${existing.length} total, ${kept.length} kept (removed ${existing.length - kept.length} from batch ${batchIndex}).`);

  const map = new Map(kept.map((d) => [String(d.username || '').toLowerCase(), d]));
  for (const dev of newEntries) {
    map.set(String(dev.username || '').toLowerCase(), dev);
  }

  let leaderboard = [...map.values()];
  leaderboard.sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    return diff !== 0 ? diff : String(a.username || '').localeCompare(String(b.username || ''));
  });
  leaderboard = leaderboard.slice(0, MAX_DEVELOPERS);
  leaderboard.forEach((d, i) => { d.rank = i + 1; });

  const output = {
    last_updated: new Date().toISOString(),
    total_devs: leaderboard.length,
    leaderboard
  };

  fs.writeFileSync(DATA_JSON, JSON.stringify(output));
  console.log(`\nLeaderboard updated: ${leaderboard.length} developers (capped at ${MAX_DEVELOPERS}).`);
  console.log(`Added ${newEntries.length} from batch ${batchIndex}, kept ${kept.length} from other batches.`);
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--incremental') {
  const idx = parseInt(args[1], 10);
  if (Number.isNaN(idx)) {
    console.error('Usage: node scripts/run-all.js --incremental <batch-index>');
    process.exit(1);
  }
  runIncremental(idx).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.error('Usage: node scripts/run-all.js --incremental <batch-index>');
  process.exit(1);
}
