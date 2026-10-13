import { SCORE_CONFIG as config } from '../src/model/config.js';
import {
  marginalPoints,
  computeActivityScore30d,
  scoreDayType
} from '../src/model/activity.js';

const BASE = 2;
const REFERENCE_N = [1, 2, 5, 10, 20];

let failed = 0;

for (const n of REFERENCE_N) {
  const actual = marginalPoints(n, BASE);
  const rounded = Math.round(actual * 100) / 100;
  const expected = Math.round((BASE / Math.log2(n + 1)) * 100) / 100;

  if (rounded !== expected) {
    console.error(`FAIL push n=${n}: expected ${expected}, got ${rounded}`);
    failed += 1;
  } else {
    console.log(`OK push n=${n}: ${rounded}`);
  }
}

const pushConfig = config.ACTIVITY_SCORING.push;
const twentyPushDay = scoreDayType(20, pushConfig);
if (twentyPushDay > pushConfig.dailyCap + 0.001) {
  console.error(`FAIL 20-push day exceeds cap: ${twentyPushDay} > ${pushConfig.dailyCap}`);
  failed += 1;
} else {
  console.log(`OK 20 pushes in one day scores ${twentyPushDay} (cap ${pushConfig.dailyCap})`);
}

const now = Date.now();
const burstDay = new Date(now).toISOString();
const spreadDays = Array.from({ length: 10 }, (_, i) => ({
  type: 'PushEvent',
  created_at: new Date(now - i * 24 * 60 * 60 * 1000).toISOString()
}));
const burstEvents = Array.from({ length: 50 }, () => ({
  type: 'PushEvent',
  created_at: burstDay
}));

const burstScore = computeActivityScore30d(burstEvents, { config, now });
const spreadScore = computeActivityScore30d(spreadDays, { config, now });

if (burstScore >= spreadScore) {
  console.error(
    `FAIL burst (${burstScore}) should score less than spread (${spreadScore})`
  );
  failed += 1;
} else {
  console.log(`OK burst ${burstScore} < spread ${spreadScore}`);
}

if (failed > 0) {
  process.exit(1);
}

console.log('All activity score checks passed.');
