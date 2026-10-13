// The Worker's cron triggers: the pipeline's clock, independent of GitHub's scheduler.
//
// On 2026-10-13 no workflow in this repository had run on a `schedule` since 2026-04-03. The
// watchdog (cron :17, merged 13:03 UTC) missed five slots in a row, and the backup trigger (cron
// :35) missed its first two, while every workflow_dispatch ran at once. Both workflows were
// `active`, on the default branch, valid, and last edited by the owner's account. The pipeline
// itself was dispatched by cron-job.org, whose token had been revoked that afternoon.
//
// So both clocks live here now, in DISPATCH_PLAN:
//
//   :00  update-digest.yml - the hour's batch, the primary trigger. Dispatched directly, as
//        cron-job.org did; the batch is chosen from the Asia/Karachi hour inside the run.
//   :35  pipeline-backup.yml, which starts the pipeline only when no run covered the hour
//        (scripts/should-run.js), so a missed :00 costs half an hour, never a double batch;
//        and watchdog.yml, so the alarms run hourly.
//
// Nothing here can report its own failure, so an outside monitor watches the result instead:
// cron-job.org requests /api/health (health.js), which answers 503 once the board is stale.
//
// The token is a fine-grained personal access token limited to this repository with
// Actions: read and write, stored as the Worker secret GITHUB_DISPATCH_TOKEN. Nothing else.

export const DISPATCH_REPO = 'Sudo-Ali-Dev/Rankistan';
export const DISPATCH_REF = 'main';
export const DISPATCH_PLAN = Object.freeze({
  '0 * * * *': Object.freeze(['update-digest.yml']),
  '35 * * * *': Object.freeze(['pipeline-backup.yml', 'watchdog.yml'])
});

/** The workflows a cron expression dispatches. An expression with no plan is a config error. */
export function workflowsFor(cron) {
  const workflows = DISPATCH_PLAN[cron];
  if (!workflows) {
    throw new Error(
      `No dispatch plan for cron "${cron}". Known: ${Object.keys(DISPATCH_PLAN).join(', ')}.`
    );
  }
  return workflows;
}
const GITHUB_API = 'https://api.github.com';
const DISPATCH_TIMEOUT_MS = 15000;

/**
 * Dispatch every workflow `cron` plans, on DISPATCH_REF. Each is attempted even if another
 * fails, and the run throws afterwards if any did, so Cloudflare records the cron as failed
 * rather than as a success that dispatched nothing. A failure message never includes the token.
 */
export async function dispatchScheduledWorkflows(
  env,
  { cron, fetchImpl = fetch, log = console } = {}
) {
  const workflows = workflowsFor(cron);
  const token =
    typeof env?.GITHUB_DISPATCH_TOKEN === 'string' ? env.GITHUB_DISPATCH_TOKEN.trim() : '';
  if (!token) {
    throw new Error('GITHUB_DISPATCH_TOKEN is not set, so the hourly dispatch cannot run.');
  }

  const failures = [];
  for (const workflow of workflows) {
    const url = `${GITHUB_API}/repos/${DISPATCH_REPO}/actions/workflows/${workflow}/dispatches`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'rankistan-worker-cron',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ ref: DISPATCH_REF }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS)
      });
      // 204 is the documented answer; newer API versions may answer 200 with the run's id.
      if (response.status === 204 || response.status === 200) {
        log.log(`Dispatched ${workflow} on ${DISPATCH_REF}.`);
        continue;
      }
      const body = (await response.text()).slice(0, 200).replaceAll(token, '[token]');
      failures.push(`${workflow}: HTTP ${response.status} ${body}`);
    } catch (error) {
      failures.push(`${workflow}: ${String(error?.message || error).replaceAll(token, '[token]')}`);
    }
  }

  if (failures.length > 0) {
    const message = `Hourly dispatch failed for ${failures.length} of ${workflows.length}: ${failures.join('; ')}`;
    log.error(message);
    throw new Error(message);
  }
  return workflows.length;
}
