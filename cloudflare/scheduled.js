// The Worker's cron trigger: an hourly clock that does not depend on GitHub's scheduler.
//
// On 2026-10-13 no workflow in this repository had run on a `schedule` since 2026-04-03. The
// watchdog (cron :17, merged 13:03 UTC) missed five slots in a row, and the backup trigger (cron
// :35) missed its first two, while every workflow_dispatch ran at once. Both workflows were
// `active`, on the default branch, valid, and last edited by the owner's account. So the backup
// that was meant to cover an hour cron-job.org missed, and the watchdog meant to notice, ran only
// when the pipeline itself dispatched them - and nothing at all would run if cron-job.org stopped.
//
// This dispatches both workflows from Cloudflare instead. Dispatching is safe to repeat:
// pipeline-backup.yml runs scripts/should-run.js and starts the pipeline only when no run already
// covers the hour, so this never processes a batch twice, and a second watchdog run in an hour
// only re-reads the same state. If GitHub's own schedule starts firing again, the two coexist.
//
// The token is a fine-grained personal access token limited to this repository with
// Actions: read and write, stored as the Worker secret GITHUB_DISPATCH_TOKEN. Nothing else.

export const DISPATCH_REPO = 'Sudo-Ali-Dev/Rankistan';
export const DISPATCH_REF = 'main';
export const SCHEDULED_WORKFLOWS = ['pipeline-backup.yml', 'watchdog.yml'];
const GITHUB_API = 'https://api.github.com';
const DISPATCH_TIMEOUT_MS = 15000;

/**
 * Dispatch every SCHEDULED_WORKFLOWS entry on DISPATCH_REF. Each is attempted even if another
 * fails, and the run throws afterwards if any did, so Cloudflare records the cron as failed
 * rather than as a success that dispatched nothing. A failure message never includes the token.
 */
export async function dispatchScheduledWorkflows(env, { fetchImpl = fetch, log = console } = {}) {
  const token =
    typeof env?.GITHUB_DISPATCH_TOKEN === 'string' ? env.GITHUB_DISPATCH_TOKEN.trim() : '';
  if (!token) {
    throw new Error('GITHUB_DISPATCH_TOKEN is not set, so the hourly dispatch cannot run.');
  }

  const failures = [];
  for (const workflow of SCHEDULED_WORKFLOWS) {
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
    const message = `Hourly dispatch failed for ${failures.length} of ${SCHEDULED_WORKFLOWS.length}: ${failures.join('; ')}`;
    log.error(message);
    throw new Error(message);
  }
  return SCHEDULED_WORKFLOWS.length;
}
