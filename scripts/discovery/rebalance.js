// Recompute the batch table (batches.js) from measured candidate counts.
//
//   MY_GITHUB_PAT=... node scripts/discovery/rebalance.js
//
// Counts every period (2000-2009 as one, then each year to 2012, then each month) for the main
// search and its city twin with GraphQL `userCount` - a few points in all, no REST search - then
// splits the periods into 24 contiguous batches: largest batch as small as possible, the newest
// batch held to NEWEST_SHARE of it so it can absorb the accounts that join each month, and the
// spread minimised within that. Prints the BATCH_RANGES to paste into batches.js. Changing the
// table is safe at any time: run-all.js re-derives every row's owner from `created_at` on load.

import { pathToFileURL } from 'node:url';
import { BASE_QUERY } from './batches.js';
import { cityTwinQuery } from './locations.js';

export const BATCH_COUNT = 24;
export const NEWEST_SHARE = 0.6;
const GRAPHQL = 'https://api.github.com/graphql';
const ALIASES_PER_REQUEST = 25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The periods counted: coarse while accounts were few, monthly after. The last is open-ended. */
export function periodsUntil(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const periods = [{ from: '2000-01-01', to: '2009-12-31' }];
  for (let y = 2010; y <= 2012; y += 1) periods.push({ from: `${y}-01-01`, to: `${y}-12-31` });
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth() + 1;
  for (let y = 2013; y <= endY; y += 1) {
    for (let m = 1; m <= 12 && (y < endY || m <= endM); m += 1) {
      periods.push({ from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` });
    }
  }
  periods[periods.length - 1].to = '2099-12-31';
  return periods;
}

function feasible(sizes, k, cap, newestCap) {
  let j = sizes.length;
  let used = 0;
  while (j > 0) {
    const limit = used === 0 ? newestCap : cap;
    let total = 0;
    let i = j;
    while (i > 0 && total + sizes[i - 1] <= limit) total += sizes[--i];
    if (i === j) return false;
    j = i;
    used += 1;
    if (used > k) return false;
  }
  return true;
}

/**
 * Split `sizes` (periods in order) into `k` contiguous groups. Returns the group boundaries as
 * [start, end) index pairs. Pure.
 */
export function planBatches(sizes, { k = BATCH_COUNT, newestShare = NEWEST_SHARE } = {}) {
  if (sizes.length < k) throw new Error(`Cannot split ${sizes.length} periods into ${k} batches.`);
  const pre = [0];
  for (const size of sizes) pre.push(pre[pre.length - 1] + size);
  const sum = (i, j) => pre[j] - pre[i];

  // The smallest cap that admits a split, by bisection on a monotone predicate.
  let lo = Math.max(...sizes);
  let hi = pre[pre.length - 1];
  const capFor = (cap) => Math.max(sizes[sizes.length - 1], Math.round(cap * newestShare));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (feasible(sizes, k, mid, capFor(mid))) hi = mid;
    else lo = mid + 1;
  }
  const cap = lo;
  const newestCap = capFor(cap);

  // Within that cap, the split closest to equal sizes (least squared deviation).
  const n = sizes.length;
  const target = pre[n] / k;
  const cost = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const from = Array.from({ length: k + 1 }, () => new Int32Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let g = 1; g <= k; g += 1) {
    const limit = g === k ? newestCap : cap;
    for (let j = g; j <= n; j += 1) {
      for (let i = j - 1; i >= g - 1; i -= 1) {
        const size = sum(i, j);
        if (size > limit) break;
        if (cost[g - 1][i] === Infinity) continue;
        const value = cost[g - 1][i] + (size - target) ** 2;
        if (value < cost[g][j]) {
          cost[g][j] = value;
          from[g][j] = i;
        }
      }
    }
  }
  const groups = [];
  let j = n;
  for (let g = k; g >= 1; g -= 1) {
    const i = from[g][j];
    groups.unshift([i, j]);
    j = i;
  }
  return { groups, cap, newestCap };
}

export function labelFor({ from, to }, index) {
  const month = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]}${date.slice(0, 4)}`;
  if (index === 0) return `PK 2000-${month(to)}`;
  if (to.startsWith('2099')) return `PK ${month(from)}+`;
  return `PK ${month(from)}-${month(to)}`;
}

async function countPeriods(periods, token) {
  const counted = [];
  let points = 0;
  for (let i = 0; i < periods.length; i += ALIASES_PER_REQUEST) {
    const chunk = periods.slice(i, i + ALIASES_PER_REQUEST);
    const fields = chunk.map(({ from, to }, j) => {
      const main = `${BASE_QUERY} created:${from}..${to}`;
      return (
        `m${j}: search(type: USER, query: ${JSON.stringify(main)}, first: 0) { userCount } ` +
        `c${j}: search(type: USER, query: ${JSON.stringify(cityTwinQuery(main))}, first: 0) { userCount }`
      );
    });
    const response = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { ${fields.join(' ')} rateLimit { cost } }` })
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL answered HTTP ${response.status} with no JSON.`);
    }
    // A partial answer cannot be trusted for any period in it.
    if (!response.ok || body.errors || !body.data) {
      throw new Error(
        `Counting failed: HTTP ${response.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`
      );
    }
    points += body.data.rateLimit.cost;
    chunk.forEach((period, j) =>
      counted.push({
        ...period,
        main: body.data[`m${j}`].userCount,
        city: body.data[`c${j}`].userCount
      })
    );
  }
  return { counted, points };
}

async function main() {
  const token = process.env.MY_GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set MY_GITHUB_PAT (or GITHUB_TOKEN) to count with.');
  const { counted, points } = await countPeriods(periodsUntil(), token);
  const sizes = counted.map((p) => p.main + p.city);
  const { groups, cap, newestCap } = planBatches(sizes);
  const day = new Date().toISOString().slice(0, 10);
  console.log(
    `Counted ${counted.length} periods for ${points} GraphQL points: ${sizes.reduce((a, b) => a + b, 0)} candidates on ${day}.`
  );
  console.log(`Largest batch at most ${cap}; newest at most ${newestCap}.\n`);
  console.log('export const BATCH_RANGES = Object.freeze([');
  groups.forEach(([i, j], index) => {
    const range = { from: counted[i].from, to: counted[j - 1].to };
    const measured = sizes.slice(i, j).reduce((a, b) => a + b, 0);
    console.log(
      `  { from: '${range.from}', to: '${range.to}', label: '${labelFor(range, index)}', measured: ${measured} },`
    );
  });
  console.log(']);');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
