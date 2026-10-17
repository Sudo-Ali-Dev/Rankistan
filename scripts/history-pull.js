// Downloads what the site's Rank History is built from, for deploy.yml:
//
//   node scripts/history-pull.js <dir> [--board public/data.json]
//
//   <dir>/history.ndjson   every daily record of the last HISTORY_MONTHS months, oldest first
//   <dir>/then.json        the board saved closest to 24 hours before --board, reduced to each
//                          account's rank and score: what "since this time yesterday" compares with
//
// scripts/build-split-data.js reads them when RANK_HISTORY_DIR names the directory. Keep it outside
// public/: the site serves each developer's own history only, never the whole of it.
//
// Fail-soft: the site is built without Rank History rather than not built, so anything that goes
// wrong writes nothing and ends with a workflow warning and exit 0. Public reads, so no token is
// needed; GITHUB_TOKEN is used when set.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitHubClient, createStateStore, newestFirst, DEFAULT_REPO } from './state-store.js';
import { createHistoryStore } from './history-store.js';

/** Months of daily records the site reads: a year, the retention the design keeps. */
export const HISTORY_MONTHS = 13;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The state asset saved closest to 24 hours before `at`, never after it. */
export function stateNearDayBefore(assets, at) {
  const target = at - DAY_MS;
  let best = null;
  for (const asset of newestFirst(assets)) {
    const saved = Date.parse(asset.created_at);
    if (saved > at) continue;
    if (!best || Math.abs(saved - target) < Math.abs(Date.parse(best.created_at) - target)) {
      best = asset;
    }
  }
  return best;
}

/** A board reduced to what a comparison needs. Pure. */
export function reduceBoard(payload) {
  return {
    last_updated: payload.last_updated,
    model: payload.leaderboard?.[0]?.model_version ?? null,
    rows: (payload.leaderboard ?? [])
      .filter((row) => Number.isInteger(row?.github_id))
      .map((row) => [row.github_id, row.rank, row.score_exact])
  };
}

export async function pullHistory({ dir, boardPath, client, log = console }) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const at = Date.parse(board.last_updated);
  if (!Number.isFinite(at)) throw new Error(`${boardPath} has no last_updated`);

  const history = createHistoryStore({ client, log });
  const months = (await history.months()).slice(-HISTORY_MONTHS);
  const records = [];
  for (const month of months) records.push(...(await history.readMonth(month)));

  const states = createStateStore({ client, log });
  const listed = await states.list();
  const asset = stateNearDayBefore(listed?.assets ?? [], at);
  const then = asset ? reduceBoard((await states.readAsset(asset)).payload) : null;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'history.ndjson'),
    records.map((r) => `${JSON.stringify(r)}\n`).join('')
  );
  if (then) fs.writeFileSync(path.join(dir, 'then.json'), JSON.stringify(then));
  return { months: months.length, records: records.length, then: asset?.name ?? null };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const boardAt = argv.indexOf('--board');
  const boardPath = boardAt >= 0 ? argv[boardAt + 1] : 'public/data.json';
  if (!dir) throw new Error('Usage: node scripts/history-pull.js <dir> [--board public/data.json]');
  const client = makeGitHubClient({
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY || DEFAULT_REPO
  });
  try {
    const result = await pullHistory({ dir, boardPath, client });
    console.log(
      `Rank History: ${result.records} daily record(s) from ${result.months} month(s); ` +
        `compared with ${result.then ?? 'no board'}.`
    );
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(
      `::warning title=RANK_HISTORY::The site is built without Rank History: ${error.message}`
    );
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
