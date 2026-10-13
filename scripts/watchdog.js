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
//   BATCH_STALE        a batch has not published for 49 h: two missed daily
//                      turns, plus an hour of slack.
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
// Any alarm fails this run, which GitHub can email, and keeps one open issue
// that mentions the owner. The issue gets a comment only when the set of
// alarms changes, so an outage is one thread rather than an hourly flood, and
// it is closed automatically once every check passes again.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    unreadable.push(`batch publish history (${state.batches.error})`);
  } else {
    const stale = [];
    for (let batch = 0; batch < THRESHOLDS.BATCH_COUNT; batch += 1) {
      const last = state.batches?.lastPublished?.[batch];
      if (!last || hoursSince(last, now) > THRESHOLDS.BATCH_STALE_HOURS) stale.push(batch);
    }
    if (stale.length > 0) {
      const which =
        stale.length === THRESHOLDS.BATCH_COUNT
          ? `all ${THRESHOLDS.BATCH_COUNT} batches`
          : `batch${stale.length > 1 ? 'es' : ''} ${stale.join(', ')}`;
      alarms.push({
        code: 'BATCH_STALE',
        key: stale.join(','),
        message: `No publish in ${THRESHOLDS.BATCH_STALE_HOURS} h for ${which}. Those rows on the board are frozen.`
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

  if (unreadable.length > 0) {
    alarms.push({
      code: 'CHECK_FAILED',
      key: unreadable.map((item) => item.split(' (')[0]).join(','),
      message: `Could not read: ${unreadable.join('; ')}.`
    });
  }

  return alarms;
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

export async function collectState({
  api,
  siteUrl,
  now = Date.now(),
  fetchImpl = globalThis.fetch
}) {
  const site = await attempt(async () => {
    const response = await fetchImpl(`${siteUrl}?watchdog=${now}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return { lastUpdated: payload?.last_updated };
  });

  const batches = await attempt(async () => {
    const since = new Date(now - THRESHOLDS.BATCH_STALE_HOURS * 3_600_000).toISOString();
    const commits = await api.getPages(
      `/commits?sha=main&path=public/data.json&since=${since}`,
      (list) => list
    );
    const lastPublished = {};
    for (const commit of commits) {
      const match = /\(batch (\d+)\)/.exec(commit?.commit?.message || '');
      if (!match) continue;
      const batch = Number(match[1]);
      const when = commit.commit.committer?.date;
      if (!lastPublished[batch] || when > lastPublished[batch]) lastPublished[batch] = when;
    }
    return { lastPublished };
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

  // Not a check, only a recorded fact: the GraphQL allowance this token really
  // has. The docs say 1,000 points/h for GITHUB_TOKEN; the REST figure the docs
  // give was already wrong for this repo, and the redesigned pipeline will
  // spend this budget, so it is read rather than assumed.
  const graphqlLimit = api.graphql
    ? await attempt(
        async () => (await api.graphql('{ rateLimit { limit remaining used } }')).rateLimit
      )
    : { error: 'not requested' };

  return { site, batches, runs, workflow, graphqlLimit };
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
    const seen = Object.keys(state.batches?.lastPublished || {}).length;
    facts.push([
      `Batches published in last ${THRESHOLDS.BATCH_STALE_HOURS} h`,
      `${seen} of ${THRESHOLDS.BATCH_COUNT}`
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

/** Opens, updates or closes the single watchdog issue. Returns what it did. */
export async function reconcileIssue({ api, alarms, owner, runUrl, checkedAt, dryRun }) {
  const open = await findOpenIssue(api);

  if (alarms.length === 0) {
    if (!open) return 'no issue open, nothing to do';
    if (dryRun) return `would close #${open.number}`;
    await api.request('POST', `/issues/${open.number}/comments`, {
      body: `All checks passing again at ${checkedAt}${runUrl ? ` (${runUrl})` : ''}. Closing.`
    });
    await api.request('PATCH', `/issues/${open.number}`, {
      state: 'closed',
      state_reason: 'completed'
    });
    return `closed #${open.number}`;
  }

  const body = renderIssueBody(alarms, { owner, runUrl, checkedAt });
  if (!open) {
    if (dryRun) return 'would open a new issue';
    const created = await api.request('POST', '/issues', {
      title: 'Pipeline watchdog: the leaderboard pipeline needs attention',
      body
    });
    return `opened #${created.number}`;
  }

  if (readSignature(open.body) === signatureOf(alarms)) {
    return `#${open.number} already describes these alarms`;
  }
  if (dryRun) return `would update #${open.number}`;
  await api.request('PATCH', `/issues/${open.number}`, { body });
  await api.request('POST', `/issues/${open.number}/comments`, {
    body: `The problems changed at ${checkedAt}:\n\n${alarmTable(alarms)}`
  });
  return `updated #${open.number}`;
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
  const state = await collectState({ api, siteUrl, now });
  const alarms = evaluate(state, now);
  const summary = renderSummary(alarms, factsFrom(state, now, api.rateLimit()), checkedAt);

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  let issueOutcome;
  try {
    issueOutcome = await reconcileIssue({
      api,
      alarms,
      owner: process.env.WATCHDOG_OWNER,
      runUrl,
      checkedAt,
      dryRun
    });
  } catch (error) {
    issueOutcome = `issue update failed: ${error.message}`;
    process.exitCode = 1;
  }
  console.log(`\nIssue: ${issueOutcome}`);

  for (const alarm of alarms) console.log(`::error title=${alarm.code}::${alarm.message}`);
  if (alarms.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`::error title=WATCHDOG_CRASHED::${error.message}`);
    process.exit(1);
  });
}
