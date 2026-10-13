// Watches the leaderboard pipeline from outside, and fails loudly when it stalls.
//
// Why this exists: from 13:00 UTC on 2026-10-05 the site served the same data
// for eight days and nothing said so. Run 37313510144 created its Pages
// deployment and then stopped at the github-pages environment gate without
// ever getting a runner (its job still reads `waiting`). It held the
// pipeline's concurrency group, so each of the next 190 hourly dispatches sat
// `pending` for an hour and was displaced by the one after. A displaced run
// concludes `cancelled`, which is not a failure, and a pipeline that never
// starts cannot report on itself.
//
// Earlier, batch 0's rows went unpublished for 23 days (2026-08-30 to 09-22)
// while the board's `last_updated` never looked more than about three hours
// old, because the other 23 batches kept publishing. A single global freshness
// check cannot see that.
//
// Each check below answers one of those incidents. The thresholds come from
// 90 days of run history (2026-07-14 to 10-13):
//
//   SITE_STALE         live data older than 4 h. The worst gap in 83 days of
//                      normal operation was 3.2 h.
//   BATCH_STALE        a batch has measured nobody for 49 h: two missed daily
//                      turns, plus an hour of slack. Read from the newest
//                      `scored_at` per `batch_index` in the latest state asset
//                      on the `pipeline-state` release, since the pipeline no
//                      longer commits anything to main to read it from. A batch
//                      with no `scored_at` on any row also alarms, in words that
//                      say its date is unknown rather than that it is frozen.
//   STUCK_RUN          any run queued, pending, waiting or requested for 90
//                      min. Read by status filter, never from the newest page
//                      of runs - the eight-day holder was older than the latest
//                      100 runs, which is how a first diagnosis concluded that
//                      nothing held the lock.
//   LONG_RUN           a pipeline run past 75% of its timeout. Batch 23's
//                      range is open-ended, grew from 1,753 to 2,571 candidates
//                      in three months, and already takes 88-95 of its 120
//                      minutes.
//   CANCELLED_STREAK   the last two finished pipeline runs were both cancelled.
//   WORKFLOW_DISABLED  the pipeline workflow is not active.
//   CHECK_FAILED       one of the above could not be read. A check that cannot
//                      see is not a check that passed.
//
// Alarms keep one open issue that mentions the owner, updated to the current
// findings on every run and closed automatically once every check passes. Only
// new trouble - the issue opening, or a check or batch that was not already in
// it - comments on the issue and fails this run, which is what GitHub emails.
// A problem that persists, or shrinks as batches recover, updates the issue
// quietly: on 2026-10-13 a migration left 21 batches stale for a day, and
// failing every run would have sent two emails an hour for all of it.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATE_TAG, createStateStore, makeGitHubClient } from './state-store.js';

export const THRESHOLDS = {
  SITE_STALE_HOURS: 4,
  BATCH_STALE_HOURS: 49,
  BATCH_COUNT: 24,
  STUCK_RUN_MINUTES: 90,
  // Must equal `timeout-minutes` in update-digest.yml; a test reads that file
  // so the two cannot drift apart silently.
  PIPELINE_TIMEOUT_MINUTES: 120,
  LONG_RUN_FRACTION: 0.75,
  CANCELLED_STREAK: 2
};

export const PIPELINE_WORKFLOW = 'update-digest.yml';
// The backup trigger. It carries the only `schedule` in the pipeline's path, so
// it is the part GitHub can auto-disable after 60 days without activity - and
// a disabled backup must be seen, not discovered during the next outage.
export const BACKUP_WORKFLOW = 'pipeline-backup.yml';
export const ISSUE_MARKER = '<!-- rankistan-watchdog -->';
const SIGNATURE_PREFIX = '<!-- watchdog-signature: ';

// Run records GitHub reports as `queued` but refuses to cancel ("Cannot cancel
// a workflow run that is completed"), confirmed 2026-10-13. They hold nothing:
// the pipeline published normally after both dates. Without this list they
// would alarm forever. Add an id here only after `gh run cancel <id>` has
// refused it the same way.
export const IGNORED_RUN_IDS = new Set([34748788652, 32217802234]);

const WAITING_STATUSES = ['queued', 'pending', 'waiting', 'requested'];

function hoursSince(iso, now) {
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? (now - ts) / 3_600_000 : NaN;
}

function formatDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * Pure: turns an observed state into alarms. Every input that could not be
 * read arrives as `{ error }` and becomes CHECK_FAILED rather than a pass.
 */
export function evaluate(state, now = Date.now()) {
  const alarms = [];
  const unreadable = [];

  if (state.site?.error) {
    unreadable.push(`live site (${state.site.error})`);
  } else {
    const age = hoursSince(state.site?.lastUpdated, now);
    if (!Number.isFinite(age)) {
      unreadable.push('live site (last_updated missing or unparseable)');
    } else if (age > THRESHOLDS.SITE_STALE_HOURS) {
      alarms.push({
        code: 'SITE_STALE',
        key: 'site',
        message:
          `The live site's data is ${formatDuration(age)} old ` +
          `(last_updated ${state.site.lastUpdated}). Threshold: ${THRESHOLDS.SITE_STALE_HOURS} h.`
      });
    }
  }

  if (state.batches?.error) {
    unreadable.push(`pipeline state (${state.batches.error})`);
  } else {
    // Two different findings, reported in different words. A batch with a date older than the
    // threshold is known to be frozen. A batch with no date at all has only rows from before
    // `scored_at` existed: it may have run an hour ago, and this check cannot say, so the message
    // must not claim it has measured nobody. Both still alarm - unknown is not healthy.
    const stale = [];
    const undated = [];
    for (let batch = 0; batch < THRESHOLDS.BATCH_COUNT; batch += 1) {
      const last = state.batches?.lastPublished?.[batch];
      if (!last) undated.push(batch);
      else if (hoursSince(last, now) > THRESHOLDS.BATCH_STALE_HOURS) stale.push(batch);
    }
    const which = (list) =>
      list.length === THRESHOLDS.BATCH_COUNT
        ? `all ${THRESHOLDS.BATCH_COUNT} batches`
        : `batch${list.length > 1 ? 'es' : ''} ${list.join(', ')}`;
    const findings = [];
    if (stale.length > 0) {
      findings.push(
        `Nothing measured in ${THRESHOLDS.BATCH_STALE_HOURS} h for ${which(stale)}. ` +
          'Those rows on the board are frozen.'
      );
    }
    if (undated.length > 0) {
      findings.push(
        `No measurement date on record for ${which(undated)}: every row ${
          undated.length > 1 ? 'they own' : 'it owns'
        } predates \`scored_at\`, so when ${
          undated.length > 1 ? 'they' : 'it'
        } last ran is unknown. ${
          undated.length > 1 ? 'Each clears' : 'This clears'
        } the next time it runs.`
      );
    }
    if (findings.length > 0) {
      alarms.push({
        code: 'BATCH_STALE',
        key: [...stale, ...undated].sort((a, b) => a - b).join(','),
        message: findings.join(' ')
      });
    }
  }

  if (state.runs?.error) {
    unreadable.push(`workflow runs (${state.runs.error})`);
  } else {
    for (const run of state.runs?.waiting || []) {
      if (IGNORED_RUN_IDS.has(Number(run.id))) continue;
      const age = hoursSince(run.created_at, now);
      if (age * 60 > THRESHOLDS.STUCK_RUN_MINUTES) {
        alarms.push({
          code: 'STUCK_RUN',
          key: String(run.id),
          message:
            `"${run.name}" run ${run.id} has been \`${run.status}\` for ${formatDuration(age)}. ` +
            'A run held like this blocks every later run in its concurrency group. ' +
            `Cancel it with \`gh run cancel ${run.id}\`.`
        });
      }
    }

    const longRunHours = (THRESHOLDS.PIPELINE_TIMEOUT_MINUTES * THRESHOLDS.LONG_RUN_FRACTION) / 60;
    for (const run of state.runs?.pipelineInProgress || []) {
      const age = hoursSince(run.run_started_at || run.created_at, now);
      if (age > longRunHours) {
        alarms.push({
          code: 'LONG_RUN',
          key: String(run.id),
          message:
            `Pipeline run ${run.id} has been running ${formatDuration(age)}, past ` +
            `${Math.round(THRESHOLDS.LONG_RUN_FRACTION * 100)}% of its ` +
            `${THRESHOLDS.PIPELINE_TIMEOUT_MINUTES}-minute timeout.`
        });
      }
    }

    const recent = (state.runs?.pipelineRecentConclusions || []).slice(
      0,
      THRESHOLDS.CANCELLED_STREAK
    );
    if (
      recent.length === THRESHOLDS.CANCELLED_STREAK &&
      recent.every((conclusion) => conclusion === 'cancelled')
    ) {
      alarms.push({
        code: 'CANCELLED_STREAK',
        key: 'pipeline',
        message:
          `The last ${THRESHOLDS.CANCELLED_STREAK} finished pipeline runs were cancelled. ` +
          'Cancelled runs raise no failure, which is how the October 2026 outage went unseen.'
      });
    }
  }

  if (state.workflow?.error) {
    unreadable.push(`pipeline workflow state (${state.workflow.error})`);
  } else if (state.workflow?.state !== 'active') {
    alarms.push({
      code: 'WORKFLOW_DISABLED',
      key: String(state.workflow?.state),
      message: `${PIPELINE_WORKFLOW} is \`${state.workflow?.state}\`, so nothing will run it.`
    });
  }

  if (state.backupWorkflow?.error) {
    unreadable.push(`backup trigger state (${state.backupWorkflow.error})`);
  } else if (state.backupWorkflow && state.backupWorkflow.state !== 'active') {
    alarms.push({
      code: 'BACKUP_DISABLED',
      key: String(state.backupWorkflow.state),
      message:
        `${BACKUP_WORKFLOW} is \`${state.backupWorkflow.state}\`: the hourly backup trigger will not run, ` +
        "and the Worker's :00 dispatch is now the only thing starting the pipeline. Re-enable it in the Actions tab."
    });
  }

  if (unreadable.length > 0) {
    alarms.push({
      code: 'CHECK_FAILED',
      key: unreadable.map((item) => item.split(' (')[0]).join(','),
      message: `Could not read: ${unreadable.join('; ')}.`
    });
  }

  return alarms;
}

/**
 * Whether `alarms` hold anything the issue did not already report: a check
 * whose code is new, or a member of its key that is new (a key such as
 * BATCH_STALE's lists its batches, comma-separated). Fewer batches, or the same
 * ones, is not new. With nothing reported before, everything is new.
 */
export function isNewTrouble(previousSignature, alarms) {
  if (alarms.length === 0) return false;
  if (!previousSignature) return true;
  const members = (signature) => {
    const out = new Set();
    for (const part of signature.split('|').filter(Boolean)) {
      const at = part.indexOf(':');
      const code = at === -1 ? part : part.slice(0, at);
      const key = at === -1 ? '' : part.slice(at + 1);
      out.add(code);
      for (const member of key.split(',')) out.add(`${code}:${member}`);
    }
    return out;
  };
  const before = members(previousSignature);
  for (const member of members(signatureOf(alarms))) {
    if (!before.has(member)) return true;
  }
  return false;
}

/** Order-independent identity of an alarm set, so a re-run that finds the
 *  same problems does not post the same comment again. */
export function signatureOf(alarms) {
  return alarms
    .map((alarm) => `${alarm.code}:${alarm.key}`)
    .sort()
    .join('|');
}

export function readSignature(body) {
  const start = String(body || '').indexOf(SIGNATURE_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(' -->', start);
  return end === -1 ? null : body.slice(start + SIGNATURE_PREFIX.length, end);
}

function alarmTable(alarms) {
  const rows = alarms.map(
    (alarm) => `| \`${alarm.code}\` | ${alarm.message.replace(/\|/g, '\\|')} |`
  );
  return ['| Check | Finding |', '|---|---|', ...rows].join('\n');
}

export function renderIssueBody(alarms, { owner, runUrl, checkedAt }) {
  return [
    ISSUE_MARKER,
    `${SIGNATURE_PREFIX}${signatureOf(alarms)} -->`,
    '',
    `${owner ? `@${owner} ` : ''}The leaderboard pipeline needs attention.`,
    '',
    alarmTable(alarms),
    '',
    `Checked at ${checkedAt}${runUrl ? ` by ${runUrl}` : ''}.`,
    '',
    'This issue is updated when the set of problems changes, and closed automatically ' +
      'once every check passes again.'
  ].join('\n');
}

export function renderSummary(alarms, facts, checkedAt) {
  const lines = [`## Pipeline watchdog - ${checkedAt}`, ''];
  lines.push(alarms.length === 0 ? '**All checks passing.**' : `**${alarms.length} alarm(s).**`);
  lines.push('');
  if (alarms.length > 0) lines.push(alarmTable(alarms), '');
  lines.push('| Observed | Value |', '|---|---|');
  for (const [label, value] of facts) lines.push(`| ${label} | ${value} |`);
  return lines.join('\n');
}

/** Thin REST client. Injected so collectState can be tested without network. */
export function makeApi({ token, repo, fetchImpl = globalThis.fetch }) {
  const base = `https://api.github.com/repos/${repo}`;
  let rateLimit = null;

  async function request(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rankistan-watchdog',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const limit = response.headers?.get?.('x-ratelimit-limit');
    if (limit) {
      rateLimit = { limit, resource: response.headers.get('x-ratelimit-resource') };
    }

    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}`);
    return text ? JSON.parse(text) : null;
  }

  async function getPages(path, pick, maxPages = 5) {
    const items = [];
    const joiner = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = pick(await request('GET', `${path}${joiner}per_page=100&page=${page}`));
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  async function graphql(query) {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rankistan-watchdog'
      },
      body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`GraphQL -> HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.errors?.length) throw new Error(payload.errors[0].message);
    return payload.data;
  }

  return { request, getPages, graphql, rateLimit: () => rateLimit };
}

async function attempt(read) {
  try {
    return await read();
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * When each batch last ran: the time it recorded in the state's `batch_runs`
 * (scripts/run-all.js), or the newest `scored_at` among its rows, whichever is
 * later. Rows alone cannot answer it: a batch that ran an hour ago can have
 * lost every row to the 1,000 cap. A batch with neither is absent, which
 * evaluate() reads as undated.
 */
export function lastMeasuredByBatch(rows, batchRuns = {}) {
  const lastPublished = {};
  for (const [batch, run] of Object.entries(batchRuns || {})) {
    const index = Number(batch);
    const when = Date.parse(run?.at);
    if (Number.isInteger(index) && Number.isFinite(when)) {
      lastPublished[index] = new Date(when).toISOString();
    }
  }
  for (const row of rows || []) {
    const batch = row?.batch_index;
    const when = Date.parse(row?.scored_at);
    if (!Number.isInteger(batch) || !Number.isFinite(when)) continue;
    if (!lastPublished[batch] || when > Date.parse(lastPublished[batch])) {
      lastPublished[batch] = new Date(when).toISOString();
    }
  }
  return lastPublished;
}

export async function collectState({
  api,
  siteUrl,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  loadState
}) {
  const site = await attempt(async () => {
    const response = await fetchImpl(`${siteUrl}?watchdog=${now}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return { lastUpdated: payload?.last_updated };
  });

  const batches = await attempt(async () => {
    if (!loadState) throw new Error('no state reader');
    const latest = await loadState();
    if (!latest) throw new Error(`no state saved on release ${STATE_TAG}`);
    return {
      lastPublished: lastMeasuredByBatch(latest.payload.leaderboard, latest.payload.batch_runs),
      asset: { name: latest.asset?.name, createdAt: latest.asset?.created_at }
    };
  });

  const runs = await attempt(async () => {
    // One request per status, over the whole history. Reading the newest page
    // of runs instead is exactly the mistake this file exists to prevent.
    const waiting = [];
    for (const status of WAITING_STATUSES) {
      waiting.push(
        ...(await api.getPages(`/actions/runs?status=${status}`, (p) => p.workflow_runs))
      );
    }
    const pipelineInProgress = await api.getPages(
      `/actions/workflows/${PIPELINE_WORKFLOW}/runs?status=in_progress`,
      (p) => p.workflow_runs
    );
    const finished = await api.request(
      'GET',
      `/actions/workflows/${PIPELINE_WORKFLOW}/runs?status=completed&per_page=5`
    );
    return {
      waiting,
      pipelineInProgress,
      pipelineRecentConclusions: (finished?.workflow_runs || []).map((run) => run.conclusion)
    };
  });

  const workflow = await attempt(async () => {
    const info = await api.request('GET', `/actions/workflows/${PIPELINE_WORKFLOW}`);
    return { state: info?.state };
  });

  const backupWorkflow = await attempt(async () => {
    const info = await api.request('GET', `/actions/workflows/${BACKUP_WORKFLOW}`);
    return { state: info?.state };
  });

  // Not a check, only a recorded fact: the GraphQL allowance this token really
  // has. The docs say 1,000 points/h for GITHUB_TOKEN; the REST figure the docs
  // give was already wrong for this repo, and the redesigned pipeline will
  // spend this budget, so it is read rather than assumed.
  const graphqlLimit = api.graphql
    ? await attempt(
        async () => (await api.graphql('{ rateLimit { limit remaining used } }')).rateLimit
      )
    : { error: 'not requested' };

  return { site, batches, runs, workflow, backupWorkflow, graphqlLimit };
}

export function factsFrom(state, now, rateLimit) {
  const facts = [];
  const age = hoursSince(state.site?.lastUpdated, now);
  facts.push([
    'Live site last_updated',
    state.site?.error
      ? `unreadable (${state.site.error})`
      : `${state.site?.lastUpdated} (${Number.isFinite(age) ? formatDuration(age) : '?'} old)`
  ]);
  if (!state.batches?.error) {
    const seen = Object.values(state.batches?.lastPublished || {}).filter(
      (when) => hoursSince(when, now) <= THRESHOLDS.BATCH_STALE_HOURS
    ).length;
    facts.push([
      `Batches measured in last ${THRESHOLDS.BATCH_STALE_HOURS} h`,
      `${seen} of ${THRESHOLDS.BATCH_COUNT}`
    ]);
    const asset = state.batches?.asset;
    const assetAge = hoursSince(asset?.createdAt, now);
    facts.push([
      'Latest state asset',
      `${asset?.name} (saved ${asset?.createdAt}, ` +
        `${Number.isFinite(assetAge) ? formatDuration(assetAge) : '?'} old)`
    ]);
  }
  if (!state.runs?.error) {
    const held = (state.runs?.waiting || []).filter((run) => !IGNORED_RUN_IDS.has(Number(run.id)));
    facts.push(['Runs queued/pending/waiting', String(held.length)]);
    facts.push([
      'Last pipeline conclusions',
      (state.runs?.pipelineRecentConclusions || []).join(', ') || 'none'
    ]);
  }
  facts.push([
    'Pipeline workflow',
    state.workflow?.error ? 'unreadable' : String(state.workflow?.state)
  ]);
  // The REST allowance GitHub actually grants this token, read off its own
  // response headers rather than taken from the docs, which disagree with it.
  if (rateLimit) facts.push(['Token REST limit', `${rateLimit.limit}/h (${rateLimit.resource})`]);
  if (state.graphqlLimit && !state.graphqlLimit.error) {
    facts.push([
      'Token GraphQL limit',
      `${state.graphqlLimit.limit} points/h (${state.graphqlLimit.remaining} remaining)`
    ]);
  }
  return facts;
}

async function findOpenIssue(api) {
  const issues = await api.getPages('/issues?state=open', (list) => list, 3);
  return issues.find(
    (issue) => !issue.pull_request && String(issue.body || '').includes(ISSUE_MARKER)
  );
}

/**
 * Opens, updates or closes the single watchdog issue. Returns what it did, and
 * whether the alarms include new trouble (isNewTrouble), which alone comments
 * on the issue and fails the run.
 */
export async function reconcileIssue({ api, alarms, owner, runUrl, checkedAt, dryRun }) {
  const open = await findOpenIssue(api);
  const result = (outcome, newTrouble = false) => ({ outcome, newTrouble });

  if (alarms.length === 0) {
    if (!open) return result('no issue open, nothing to do');
    if (dryRun) return result(`would close #${open.number}`);
    await api.request('POST', `/issues/${open.number}/comments`, {
      body: `All checks passing again at ${checkedAt}${runUrl ? ` (${runUrl})` : ''}. Closing.`
    });
    await api.request('PATCH', `/issues/${open.number}`, {
      state: 'closed',
      state_reason: 'completed'
    });
    return result(`closed #${open.number}`);
  }

  const body = renderIssueBody(alarms, { owner, runUrl, checkedAt });
  if (!open) {
    if (dryRun) return result('would open a new issue', true);
    const created = await api.request('POST', '/issues', {
      title: 'Pipeline watchdog: the leaderboard pipeline needs attention',
      body
    });
    return result(`opened #${created.number}`, true);
  }

  const previous = readSignature(open.body);
  if (previous === signatureOf(alarms)) {
    return result(`#${open.number} already describes these alarms`);
  }
  const newTrouble = isNewTrouble(previous, alarms);
  if (dryRun) return result(`would update #${open.number}`, newTrouble);
  await api.request('PATCH', `/issues/${open.number}`, { body });
  if (!newTrouble) {
    return result(`updated #${open.number} quietly: nothing new, only fewer or the same problems`);
  }
  await api.request('POST', `/issues/${open.number}/comments`, {
    body: `New problems at ${checkedAt}:\n\n${alarmTable(alarms)}`
  });
  return result(`updated #${open.number} with new problems`, true);
}

async function runCli() {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'Sudo-Ali-Dev/Rankistan';
  const siteUrl = process.env.SITE_URL || 'https://rankistan.dev/data.json';
  if (!token) throw new Error('GITHUB_TOKEN is required.');

  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  const api = makeApi({ token, repo });
  // The state store logs its fallbacks itself; the summary reports the rest.
  const store = createStateStore({
    client: makeGitHubClient({ token, repo, userAgent: 'rankistan-watchdog' }),
    log: { log: () => {}, warn: (message) => console.log(message) }
  });
  const state = await collectState({ api, siteUrl, now, loadState: () => store.load() });
  const alarms = evaluate(state, now);
  const summary = renderSummary(alarms, factsFrom(state, now, api.rateLimit()), checkedAt);

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  // An issue that cannot be updated cannot carry the alarm, so the run must.
  let issue = { outcome: '', newTrouble: alarms.length > 0 };
  try {
    issue = await reconcileIssue({
      api,
      alarms,
      owner: process.env.WATCHDOG_OWNER,
      runUrl,
      checkedAt,
      dryRun
    });
  } catch (error) {
    issue.outcome = `issue update failed: ${error.message}`;
    process.exitCode = 1;
  }
  console.log(`\nIssue: ${issue.outcome}`);

  // Every finding is annotated on the run; only new trouble fails it.
  const level = issue.newTrouble ? 'error' : 'warning';
  for (const alarm of alarms) console.log(`::${level} title=${alarm.code}::${alarm.message}`);
  if (issue.newTrouble) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`::error title=WATCHDOG_CRASHED::${error.message}`);
    process.exit(1);
  });
}
