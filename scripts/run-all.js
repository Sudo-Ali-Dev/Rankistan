// One batch of the leaderboard pipeline, start to finish:
//
//   load      the whole board: the newest state on the `pipeline-state`
//             release (scripts/state-store.js), or a local file
//   registry  registrations and opt-outs, from GitHub issues
//             (scripts/registry.js); opt-outs leave the board here
//   measure   this batch's developers on GitHub
//   merge     them into the board by row owner (mergeBatch)
//   guard     verify the result, and refuse an unexplained loss (guardBoard)
//   save      the board as the new newest state
//   dispatch  deploy.yml, which builds the site from that state, and
//             watchdog.yml, which checks it
//
// Nothing here commits to git. The board used to be public/data.json on main,
// rewritten by a commit every hour: 98.4% of the repository's packed size, and
// a push race that needed a five-attempt retry and a replay of the batch onto
// whatever main had become. With one serialized writer (the pipeline's
// concurrency group) and the board loaded and saved whole, neither exists.
//
//   node scripts/run-all.js --incremental <batch> [--state release|<path>] [--dry-run]
//
// --state release   load from and save to the release, then dispatch. What
//                   update-digest.yml runs; needs GITHUB_TOKEN with
//                   contents: write and actions: write.
// --state <path>    load from and save to a local file. The default, at
//                   public/data.json, so a local run never touches the
//                   published state.
// --dry-run         no GitHub at all: replay the batch's own rows from the
//                   file through the real merge and guards, and write
//                   public/data.dry-run.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRows } from '../src/model/order.js';
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
import { verifyPublished } from './verify-published.js';
import { makeGitHubClient, createStateStore, stateAssetName, DEFAULT_REPO } from './state-store.js';
import {
  readRegistry,
  loadRegistry,
  applyOptOuts,
  withoutOptedOut,
  emptyRegistry
} from './registry.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_JSON = path.join(PUBLIC_DIR, 'data.json');
const DRY_RUN_DATA_JSON = path.join(PUBLIC_DIR, 'data.dry-run.json');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A board read from a file, or `null` if there is no file. Anything else that
 * goes wrong aborts.
 */
export function readBoardFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null;
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

  return data;
}

/** A state store over a local file, with the same `load`/`save` as the release. */
export function createFileStore({ readPath, writePath = readPath }) {
  return {
    async load() {
      const payload = readBoardFile(readPath);
      return payload ? { payload, source: readPath } : null;
    },
    async save(board) {
      atomicWriteJsonSync(writePath, board);
      return { path: writePath };
    }
  };
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

// Absence from search is not evidence that a developer left.
//
// A batch used to drop every row it owned and re-add only what its search
// returned this run, so anyone the search missed was deleted. Search misses
// people for reasons that say nothing about them: a secondary rate limit
// mid-pagination resumes offset paging over a shifted result set, follower
// ties straddle page boundaries, a short page is taken as the end. Across
// 3,928 versions of data.json, 914 removals came back within two runs of the
// same batch - 11 of them from the top 10, one from rank 1 - and the rate
// jumped from 5 to 37 a day after 2026-09-22, when runs stopped failing on a
// rate limit and started publishing whatever pagination they had.
//
// So a row is removed only when this run fetched that developer and they
// failed the gate. A developer the run never looked at is carried forward
// unchanged and counted, and removed only on the second consecutive miss -
// one day later, since each batch runs once a day.
export const MAX_MISSED_RUNS = 2;

// The two-miss rule assumes a batch runs once a day. It does not always: a manual re-run, or the
// backup trigger, can run the same batch again within the hour, and two misses fifteen minutes
// apart are one observation, not two. On 2026-10-13 a developer was removed that way, fifteen
// minutes after his first miss. So a removal also needs the misses to span this long. The first
// miss records `missed_since`; a measurement clears it.
export const MIN_MISS_SPAN_HOURS = 20;
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

// A row whose last measurement is older than this is off the board.
//
// A batch that cannot run - a crash, a rate-limit storm every hour of a day, a
// range that outgrew its timeout - leaves its rows untouched, and they used to
// stay on the board indefinitely at whatever they last scored: batch 0's rows
// went unrefreshed for 23 days from 2026-08-30. A row carried because search
// missed it is removed on its batch's next miss, a day later, so this only
// binds when a batch has not run at all. Seven days is a week of daily turns;
// rows with no `scored_at` predate it and are kept until their batch re-runs.
export const UNMEASURED_AFTER_DAYS = 7;

/**
 * Fold one batch's rows into the board. Pure: takes the board, returns the
 * next one and why every row that left it went.
 *
 * This is a merge *by row owner*: every row carries the `batch_index` that
 * produced it, this batch replaces only its own, and the other 23 batches are
 * carried across untouched.
 *
 * `removed` lists each developer who is not on the returned board, with the
 * reason: `ineligible` (fetched this run and failed the gate), `missed`
 * (absent from MAX_MISSED_RUNS consecutive runs of their batch, the first at
 * least MIN_MISS_SPAN_HOURS ago), `unmeasured`
 * (not measured for UNMEASURED_AFTER_DAYS) or `displaced` (below the
 * MAX_DEVELOPERS cap). guardBoard holds the merge to that account.
 *
 * `discoveryComplete: false` means this run's search is known to be short, so
 * absence from it proves nothing: unseen rows are carried with their miss
 * counters frozen, while the developers it did evaluate are judged as usual.
 */
export function mergeBatch({
  existing,
  batchIndex,
  newEntries,
  evaluated = null,
  discoveryComplete = true,
  now = Date.now(),
  allowShrink = false,
  log = console
}) {
  const kept = existing.filter((d) => d.batch_index !== batchIndex);
  const own = existing.filter((d) => d.batch_index === batchIndex);

  const key = (d) => String(d?.username || d || '').toLowerCase();
  const fresh = new Set(newEntries.map(key));
  // `null` means nobody can be shown to have been evaluated, so nobody is
  // removed as ineligible.
  const judged = Array.isArray(evaluated) ? new Set(evaluated.map(key)) : null;

  const carried = [];
  const removed = [];
  const reason = (row, why) =>
    removed.push({ username: row.username, batch_index: row.batch_index, reason: why });
  // A search known to be incomplete cannot show that anyone left: carry everyone it did not see
  // unchanged, without advancing their miss count.
  const freezeMisses = discoveryComplete === false;
  for (const row of own) {
    if (fresh.has(key(row))) continue;
    if (judged?.has(key(row))) {
      reason(row, 'ineligible');
      continue;
    }
    if (freezeMisses) {
      carried.push({ ...row });
      continue;
    }
    const missed = (Number(row.missed_runs) || 0) + 1;
    const since = Date.parse(row.missed_since);
    const spanned = Number.isFinite(since) && now - since >= MIN_MISS_SPAN_HOURS * 3_600_000;
    if (missed >= MAX_MISSED_RUNS && spanned) {
      reason(row, 'missed');
      continue;
    }
    // A row from before `missed_since` existed starts its clock at this miss.
    carried.push({
      ...row,
      missed_runs: missed,
      missed_since: Number.isFinite(since) ? row.missed_since : new Date(now).toISOString()
    });
  }
  if (freezeMisses && own.length > 0) {
    log.warn(
      `::warning title=Discovery incomplete::Batch ${batchIndex}: miss counters frozen this run, ` +
        'since a search known to be incomplete cannot show that anyone left.'
    );
  }

  assertReplacementIsSafe({
    batchIndex,
    batchLabel: SEARCH_BATCHES[batchIndex].label,
    removedCount: own.length,
    replacementCount: newEntries.length + carried.length,
    allowShrink
  });

  // Carried rows go in first so that nothing outranks a real measurement: a
  // developer another batch has just measured keeps that batch's row, and this
  // batch's fresh rows override everything.
  const map = new Map(carried.map((d) => [key(d), d]));
  for (const dev of kept) {
    map.set(key(dev), dev);
  }
  for (const dev of newEntries) {
    map.set(key(dev), dev);
  }

  const cutoff = now - UNMEASURED_AFTER_DAYS * DAY_MS;
  for (const [k, row] of map) {
    const scoredAt = Date.parse(row.scored_at);
    if (Number.isFinite(scoredAt) && scoredAt < cutoff) {
      map.delete(k);
      reason(row, 'unmeasured');
    }
  }

  // The whole board is re-sorted on every merge, carried rows included, so it
  // is always in one order: see src/model/order.js.
  const sorted = [...map.values()].sort(compareRows);
  for (const row of sorted.slice(MAX_DEVELOPERS)) {
    reason(row, 'displaced');
  }
  const leaderboard = sorted.slice(0, MAX_DEVELOPERS).map((d, i) => ({ ...d, rank: i + 1 }));

  const board = {
    last_updated: new Date(now).toISOString(),
    total_devs: leaderboard.length,
    leaderboard,
  };

  const named = (why) => removed.filter((r) => r.reason === why);
  log.log(
    `Existing leaderboard: ${existing.length} total, ${kept.length} from other batches, ` +
      `${own.length} from batch ${batchIndex}.`,
  );
  log.log(
    `Batch ${batchIndex}: ${newEntries.length} measured, ${carried.length} carried forward ` +
      `(not seen this run), ${named('ineligible').length} removed as ineligible, ` +
      `${named('missed').length} removed after ${MAX_MISSED_RUNS} consecutive misses.`,
  );
  // Named, so a disappearance can be traced to a reason rather than inferred
  // from a diff of two states.
  const lines = [
    ['carried', carried],
    ['removed as ineligible', named('ineligible')],
    ['removed after consecutive misses', named('missed')],
    [`removed as unmeasured for ${UNMEASURED_AFTER_DAYS} days`, named('unmeasured')],
    [`displaced below the ${MAX_DEVELOPERS} cap`, named('displaced')]
  ];
  for (const [what, rows] of lines) {
    if (rows.length === 0) continue;
    const list = rows.map((d) =>
      d.batch_index === batchIndex ? d.username : `${d.username} (batch ${d.batch_index})`
    );
    log.log(`  ${what}: ${list.join(', ')}`);
  }
  log.log(
    `Leaderboard: ${leaderboard.length} developers (capped at ${MAX_DEVELOPERS}): ` +
      `${newEntries.length} from batch ${batchIndex}, ${carried.length} carried, ` +
      `${kept.length} kept from other batches.`,
  );

  return { board, removed, carried: carried.length };
}

// More than this share of the board leaving in one run with no recorded
// reason is refused. Every way mergeBatch removes a row records one, so an
// unexplained loss is a bug; this is the bound past which it must not ship.
export const MAX_UNEXPLAINED_LOSS = 0.05;

/**
 * The checks a board must pass before it is saved. Throws to refuse.
 *
 * 1. verify:published on the result: every versioned score recomputes, one
 *    model version (unless migrating), compareRows order, ranks 1..n, no
 *    developer twice.
 * 2. Of the developers on `previous` and not on `board`, those with no
 *    recorded reason in `removed` must be at most MAX_UNEXPLAINED_LOSS of
 *    `previous`. Any at all is reported by name.
 */
export function guardBoard({
  previous,
  board,
  removed,
  allowMixedVersions = false,
  log = console
}) {
  const report = verifyPublished(board, { allowMixedVersions });
  if (report.errors.length > 0) {
    const shown = report.errors.slice(0, 10).join('; ');
    const more = report.errors.length > 10 ? ` ... and ${report.errors.length - 10} more` : '';
    throw new Error(
      `Refusing to save: the board fails verification with ${report.errors.length} ` +
        `problem(s): ${shown}${more}`
    );
  }

  const key = (d) => String(d?.username || '').toLowerCase();
  const after = new Set(board.leaderboard.map(key));
  const explained = new Set(removed.map(key));
  const lost = previous.filter((row) => !after.has(key(row)));
  const unexplained = lost.filter((row) => !explained.has(key(row))).map((row) => row.username);

  if (unexplained.length > previous.length * MAX_UNEXPLAINED_LOSS) {
    throw new Error(
      `Refusing to save: ${unexplained.length} of ${previous.length} developers would leave ` +
        `the board with no recorded reason, more than ${MAX_UNEXPLAINED_LOSS * 100}% in one run: ` +
        `${unexplained.slice(0, 20).join(', ')}${unexplained.length > 20 ? ', ...' : ''}`
    );
  }
  if (unexplained.length > 0) {
    log.warn(
      `${unexplained.length} developer(s) left the board with no recorded reason, which is a ` +
        `bug in the merge: ${unexplained.join(', ')}`
    );
  }
  return { report, lost: lost.length, unexplained };
}

/**
 * Load, measure, merge, guard, save, dispatch. Every piece of I/O is passed
 * in, so the whole flow runs in a test.
 *
 * - `store` is where the board lives: `load()` returns `{ payload }` or null
 *   when nothing was ever saved, `save(board, { name, label })` writes it.
 * - `registry` reads the registrations and opt-outs (scripts/registry.js). It
 *   is required, and a run whose read fails throws before measuring.
 * - `fallback` seeds a store that has never been saved to - the very first
 *   run against the release, from public/data.json. A store whose saves exist
 *   but cannot be read throws instead, and is never seeded over.
 * - With neither, the run refuses unless `allowEmpty`: an empty board plus one
 *   batch would publish a 40-row leaderboard.
 * - `now` may be a function of the loaded payload (the dry run pins it to the
 *   file's own `last_updated`).
 */
export async function runBatch({
  batchIndex,
  measure,
  store,
  registry,
  fallback = null,
  allowEmpty = false,
  dispatch = null,
  now = () => Date.now(),
  name = null,
  allowShrink = false,
  allowMixedVersions = false,
  log = console
}) {
  let loaded = await store.load();
  if (!loaded && fallback) {
    loaded = await fallback.load();
    if (loaded) {
      log.warn(`No saved state; seeding it from ${loaded.source}. This should happen once.`);
    }
  }
  if (!loaded) {
    if (!allowEmpty) {
      throw new Error(
        'No saved state and nothing to seed it from. Restore one with ' +
          '`node scripts/state-store.js save <board.json>`, or set ALLOW_EMPTY_STATE=1 to ' +
          'start a new board from this batch alone.'
      );
    }
    log.warn('No saved state; starting from an empty board.');
    loaded = { payload: { leaderboard: [] }, source: 'an empty board' };
  }

  const previous = loaded.payload.leaderboard;
  const source = loaded.asset
    ? `${loaded.asset.name} (saved ${loaded.asset.created_at})`
    : loaded.source;
  log.log(`Loaded ${previous.length} developers from ${source}.`);
  for (const skip of loaded.skipped || []) {
    log.warn(`Skipped unreadable state ${skip.name}: ${skip.error}`);
  }

  // Opt-outs leave the board on every run, whatever batch owns the row, and a
  // run that cannot read them stops here, before it can save: republishing
  // someone who asked to leave is worse than losing an hour.
  const intents = await loadRegistry(registry, log);
  const optOut = applyOptOuts(previous, intents.optedOut, log);

  const { newEntries, evaluated, discoveryComplete } = await measure({
    batchIndex,
    existing: optOut.kept,
    registry: intents
  });
  // Read after measuring, which takes up to an hour: the board is stamped, and
  // the unmeasured cutoff taken, at merge time.
  const at = typeof now === 'function' ? now(loaded.payload) : now;
  const merged = mergeBatch({
    existing: optOut.kept,
    batchIndex,
    newEntries: withoutOptedOut(newEntries, intents.optedOut),
    evaluated,
    discoveryComplete,
    now: at,
    allowShrink,
    log
  });
  const removed = [...optOut.removed, ...merged.removed];
  const guard = guardBoard({
    previous,
    board: merged.board,
    removed,
    allowMixedVersions,
    log
  });

  const saved = await store.save(merged.board, {
    name,
    label: `batch ${batchIndex}, ${merged.board.total_devs} developers`
  });
  if (saved?.asset) {
    log.log(
      `Saved state ${saved.asset.name}: ${saved.bytes} bytes gzipped, read back byte for byte.`
    );
    if (saved.pruned?.length) log.log(`Pruned ${saved.pruned.length} older state asset(s).`);
    if (saved.pruneError) log.log(`::warning title=STATE_PRUNE_FAILED::${saved.pruneError}`);
  } else if (saved?.path) {
    log.log(`Wrote ${merged.board.total_devs} developers to ${saved.path}.`);
  }

  const dispatched = dispatch ? await dispatch() : [];
  return { ...merged, removed, guard, saved, dispatched, source };
}

// What a saved state sets running: the site is built from it, and checked.
export const DISPATCHED_WORKFLOWS = ['deploy.yml', 'watchdog.yml'];

/**
 * Dispatches each workflow on `ref`, and fails if any could not be: the run
 * then ends red, which is how the owner hears of it.
 *
 * GITHUB_TOKEN may trigger workflow_dispatch, the one kind of event it is
 * allowed to start, given `actions: write`. Each workflow's state is read
 * first, because one that is not `active` will not run whatever the dispatch
 * answers. That matters most for the watchdog: it carries a schedule, GitHub
 * disables a scheduled workflow after 60 days without repository activity,
 * and once this pipeline stops committing to main nothing else keeps the
 * repository active - and a disabled watchdog cannot report itself. Every
 * workflow is tried before failing, so a disabled watchdog does not also cost
 * the deploy.
 */
export async function dispatchWorkflows({
  client,
  workflows = DISPATCHED_WORKFLOWS,
  ref = 'main',
  log = console
}) {
  const failures = [];
  for (const workflow of workflows) {
    try {
      const info = await client.json('GET', `/actions/workflows/${workflow}`);
      if (info?.state !== 'active') {
        throw new Error(`it is \`${info?.state}\`; re-enable it in the Actions tab`);
      }
      await client.json('POST', `/actions/workflows/${workflow}/dispatches`, {
        body: { ref },
        // A repeated dispatch is harmless: both workflows cancel in progress.
        retry: true
      });
      log.log(`Dispatched ${workflow} on ${ref}.`);
    } catch (error) {
      failures.push(`${workflow} (${error.message})`);
    }
  }
  if (failures.length > 0) {
    const message =
      `The state is saved, but could not dispatch ${failures.join(', ')}. Until that is ` +
      'fixed the site keeps the previous board until the next deploy, and nothing ' +
      'checks the pipeline from outside.';
    log.log(`::error title=DISPATCH_FAILED::${message}`);
    throw new Error(message);
  }
  return workflows;
}

/**
 * Everyone a run actually looked at and can therefore judge: developers fetched
 * in full, whether or not they then pass the gate; developers screened out on
 * their first events page, whose whole feed was read and failed it; and
 * developers found by a city name whose fetched location names a place outside
 * Pakistan. Anyone search did not return, or whose fetch errored, was never
 * looked at and is carried forward instead.
 */
export function evaluatedLogins({ developers, screenedOut = [], locationRejected = [] }) {
  return [
    ...developers.map((d) => d.username),
    ...screenedOut,
    ...locationRejected.map((r) => r.username)
  ];
}

/** Measures one batch on GitHub: discovery, fetch, activity gate, scoring. */
export async function measureBatch({ batchIndex, registry }) {
  const fetched = await fetchPakistaniDevelopers({
    repoRoot: process.cwd(),
    batchIndex,
    registry,
    rawOnly: true,
    withScreening: true,
  });
  const { developers: rawDevs, discoveryComplete } = fetched;

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

  // Only these developers can be judged ineligible.
  const evaluated = evaluatedLogins(fetched);

  // False when either of this batch's searches is known to be short; the merge
  // then freezes miss counters rather than count absence from it.
  return { newEntries, evaluated, discoveryComplete };
}

/**
 * The dry run's measurement: the batch's own rows, replayed as though just
 * measured. It drives the real merge, guards and save without GitHub.
 */
export function replayBatch({ batchIndex, existing }) {
  const newEntries = existing
    .filter((d) => d.batch_index === batchIndex)
    .map((d) => {
      const row = { ...d };
      delete row.missed_runs;
      return row;
    });
  return { newEntries, evaluated: newEntries.map((d) => d.username) };
}

function optionValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

async function runCli(args, env = process.env) {
  const usage =
    'Usage: node scripts/run-all.js --incremental <batch-index> [--state release|<path>] [--dry-run]';
  if (args[0] !== '--incremental') throw new Error(usage);

  const batchIndex = parseInt(args[1], 10);
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= SEARCH_BATCHES.length) {
    throw new Error(
      `Invalid batch index: ${args[1]}. Must be 0-${SEARCH_BATCHES.length - 1}.\n${usage}`
    );
  }

  const dryRun = args.includes('--dry-run') || env.SKIP_GITHUB === 'true';
  const state = optionValue(args, '--state') || DATA_JSON;
  const shared = {
    batchIndex,
    allowShrink: env.ALLOW_LEADERBOARD_SHRINK === '1',
    allowMixedVersions: env.ALLOW_MIXED_MODELS === '1'
  };

  console.log(
    `\n=== Incremental batch ${batchIndex}: ${SEARCH_BATCHES[batchIndex].label} ===\n`,
  );

  if (dryRun) {
    if (state === 'release') throw new Error('--dry-run makes no GitHub calls; give it a file.');
    console.log(
      `DRY RUN: no GitHub calls; replaying batch ${batchIndex} from ${state} ` +
        `into ${DRY_RUN_DATA_JSON}`
    );
    await runBatch({
      ...shared,
      measure: replayBatch,
      registry: async () => emptyRegistry('not read, since a dry run makes no GitHub calls'),
      store: createFileStore({ readPath: path.resolve(state), writePath: DRY_RUN_DATA_JSON }),
      allowEmpty: true,
      // The file's own clock, so the unmeasured cutoff does not depend on the
      // day CI happens to run.
      now: (payload) => Date.parse(payload?.last_updated) || Date.now()
    });
    return;
  }

  if (state !== 'release') {
    // Locally GITHUB_REPOSITORY is unset, and the registry is the canonical repository's.
    const issues = makeGitHubClient({
      token: env.MY_GITHUB_PAT || env.GITHUB_TOKEN,
      repo: env.GITHUB_REPOSITORY || DEFAULT_REPO
    });
    await runBatch({
      ...shared,
      measure: measureBatch,
      registry: () => readRegistry({ api: issues }),
      store: createFileStore({ readPath: path.resolve(state) }),
      // A local file that does not exist yet is a first run.
      allowEmpty: true
    });
    return;
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error(
      '--state release needs GITHUB_TOKEN and GITHUB_REPOSITORY, as GitHub Actions sets them.'
    );
  }
  const client = makeGitHubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  await runBatch({
    ...shared,
    measure: measureBatch,
    registry: () => readRegistry({ api: client }),
    store: createStateStore({ client }),
    fallback: createFileStore({ readPath: DATA_JSON }),
    allowEmpty: env.ALLOW_EMPTY_STATE === '1',
    name: stateAssetName({
      runId: env.GITHUB_RUN_ID || `local${Date.now()}`,
      runAttempt: env.GITHUB_RUN_ATTEMPT || 1
    }),
    dispatch: () => dispatchWorkflows({ client })
  });
}

// Only run the CLI when this file is the process entry point. Previously the
// block below executed on *import*, so the module could not be imported by a
// test without process.exit(1) tearing the runner down.
function main() {
  runCli(process.argv.slice(2)).catch((e) => {
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
