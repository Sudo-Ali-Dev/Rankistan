'use strict';

const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(process.cwd(), 'public');

function runBatch(batchIndex) {
  const { fetchPakistaniDevelopers, SEARCH_BATCHES } = require('./fetch-devs.js');

  if (batchIndex < 0 || batchIndex >= SEARCH_BATCHES.length) {
    console.error(`Invalid batch index: ${batchIndex}. Must be 0-${SEARCH_BATCHES.length - 1}.`);
    process.exit(1);
  }

  const outputPath = path.join(PUBLIC_DIR, `raw_batch_${batchIndex}.json`);

  return fetchPakistaniDevelopers({
    repoRoot: process.cwd(),
    batchIndex,
    rawOnly: true
  }).then((devs) => {
    fs.writeFileSync(outputPath, JSON.stringify(devs, null, 2));
    console.log(`Batch ${batchIndex}: saved ${devs.length} developers -> ${outputPath}`);
  });
}

function runMerge() {
  const {
    applyActivityFilter,
    ACTIVITY_THRESHOLDS,
    MAX_DEVELOPERS
  } = require('./fetch-devs.js');

  const batchFiles = fs.readdirSync(PUBLIC_DIR)
    .filter((f) => f.startsWith('raw_batch_') && f.endsWith('.json'))
    .sort();

  if (batchFiles.length === 0) {
    console.error('No batch files found in public/. Run fetch batches first.');
    process.exit(1);
  }

  const seen = new Set();
  const allDevs = [];

  for (const file of batchFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
    let added = 0;
    for (const dev of raw) {
      const key = (dev.username || '').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        allDevs.push(dev);
        added += 1;
      }
    }
    console.log(`  ${file}: ${raw.length} devs (${added} new, ${raw.length - added} dupes)`);
  }

  console.log(`Merged ${batchFiles.length} batch files -> ${allDevs.length} unique developers`);

  const filtered = applyActivityFilter(allDevs);
  console.log(
    `Activity filter: ${allDevs.length} -> ${filtered.length} passed ` +
    `(>=${ACTIVITY_THRESHOLDS.MIN_CONTRIBUTIONS_60D} contributions in 60d, ` +
    `<=${ACTIVITY_THRESHOLDS.MAX_INACTIVITY_GAP_DAYS}d max gap)`
  );

  filtered.sort((a, b) => {
    const diff = Number(b.followers || 0) - Number(a.followers || 0);
    return diff !== 0 ? diff : String(a.username || '').localeCompare(String(b.username || ''));
  });

  const capped = filtered.slice(0, MAX_DEVELOPERS);
  console.log(`Final: ${capped.length} developers (capped at ${MAX_DEVELOPERS})`);

  fs.writeFileSync(path.join(PUBLIC_DIR, 'raw.json'), JSON.stringify(capped, null, 2));
  console.log('Saved public/raw.json');

  console.log('Scoring...');
  execSync('node scripts/score.js public/raw.json public/scored.json', { stdio: 'inherit' });

  console.log('Writing leaderboard...');
  execSync('node scripts/write-leaderboard.js public/scored.json public/data.json', { stdio: 'inherit' });

  console.log('Generating digest...');
  execSync('node scripts/generate-digest.js', { stdio: 'inherit' });

  console.log('All tasks finished successfully.');
}

function runFull() {
  const { SEARCH_BATCHES } = require('./fetch-devs.js');

  const chain = Promise.resolve();
  const batchCount = SEARCH_BATCHES.length;

  return Array.from({ length: batchCount }, (_, i) => i)
    .reduce((p, i) => p.then(() => runBatch(i)), chain)
    .then(() => runMerge());
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--batch') {
  const idx = parseInt(args[1], 10);
  if (Number.isNaN(idx)) {
    console.error('Usage: node scripts/run-all.js --batch <0-7>');
    process.exit(1);
  }
  runBatch(idx).catch((e) => { console.error(e.message); process.exit(1); });
} else if (mode === '--merge') {
  try { runMerge(); } catch (e) { console.error(e.message); process.exit(1); }
} else {
  runFull().catch((e) => { console.error(e.message); process.exit(1); });
}
