// Decides whether a scheduled pipeline run should go ahead.
//
// Why this exists: the pipeline was dispatched only by an external scheduler
// (cron-job.org), using a personal token. On 2026-10-13 that token was revoked
// and the 14:00 UTC run simply never happened - nothing failed, so nothing
// said so. Since then the Cloudflare Worker's cron dispatches the pipeline at
// :00 and this backup (pipeline-backup.yml) at :35.
//
// The backup firing in an hour the :00 dispatch already
// covered would run the same batch twice: no
// harm to the board, but about 1,300 wasted API calls. So a scheduled run
// stands down when a dispatched run already covers the hour - one that is
// queued, running, or finished successfully. A dispatched run that failed or
// was cancelled does not count: the backup should then try again.
//
// The external trigger stays primary on purpose. GitHub disables scheduled
// workflows after 60 days without repository activity; a workflow_dispatch
// from outside is not affected.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COVER_WINDOW_MINUTES = 50;

export function shouldRun({ event, runs, currentRunId, now = Date.now() }) {
  if (event !== 'schedule') return { run: true, reason: `triggered by ${event}` };

  const cutoff = now - COVER_WINDOW_MINUTES * 60_000;
  const covering = (runs || []).find(
    (run) =>
      String(run.id) !== String(currentRunId) &&
      run.event === 'workflow_dispatch' &&
      Date.parse(run.created_at) >= cutoff &&
      (run.status !== 'completed' || run.conclusion === 'success')
  );

  return covering
    ? {
        run: false,
        reason: `dispatched run ${covering.id} (${covering.status}${covering.conclusion ? `/${covering.conclusion}` : ''}) already covers this hour`
      }
    : { run: true, reason: `no dispatched run in the last ${COVER_WINDOW_MINUTES} minutes` };
}

// CLI: node scripts/should-run.js <runs.json> <event> <current-run-id>
// Prints `run=true|false` for $GITHUB_OUTPUT and the reason to stderr.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, event, currentRunId] = process.argv.slice(2);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decision = shouldRun({ event, runs: payload.workflow_runs || [], currentRunId });
  console.error(`should-run: ${decision.reason}`);
  console.log(`run=${decision.run}`);
}
