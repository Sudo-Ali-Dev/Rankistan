import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  THRESHOLDS,
  IGNORED_RUN_IDS,
  ISSUE_MARKER,
  evaluate,
  signatureOf,
  readSignature,
  renderIssueBody,
  collectState,
  reconcileIssue,
  isNewTrouble,
  lastMeasuredByBatch,
  factsFrom
} from './watchdog.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

function allBatchesAt(iso) {
  const lastPublished = {};
  for (let b = 0; b < THRESHOLDS.BATCH_COUNT; b += 1) lastPublished[b] = iso;
  return lastPublished;
}

function healthy(overrides = {}) {
  return {
    site: { lastUpdated: hoursAgo(1) },
    batches: { lastPublished: allBatchesAt(hoursAgo(20)) },
    runs: {
      waiting: [],
      pipelineInProgress: [],
      pipelineRecentConclusions: ['success', 'success']
    },
    workflow: { state: 'active' },
    ...overrides
  };
}

const codes = (alarms) => alarms.map((a) => a.code).sort();

describe('evaluate', () => {
  it('raises nothing for a healthy pipeline', () => {
    expect(evaluate(healthy(), NOW)).toEqual([]);
  });

  it('flags live data older than the threshold', () => {
    const alarms = evaluate(healthy({ site: { lastUpdated: hoursAgo(4.5) } }), NOW);
    expect(codes(alarms)).toEqual(['SITE_STALE']);
  });

  it('tolerates the worst normal gap seen in 83 days of operation (3.2 h)', () => {
    expect(evaluate(healthy({ site: { lastUpdated: hoursAgo(3.2) } }), NOW)).toEqual([]);
  });

  it('catches one frozen batch that a global timestamp cannot', () => {
    // 2026-08-30 to 09-22: batch 0 published nothing for 23 days while the
    // board's last_updated never looked more than about three hours old.
    const lastPublished = allBatchesAt(hoursAgo(20));
    delete lastPublished[0];
    const alarms = evaluate(healthy({ batches: { lastPublished } }), NOW);
    expect(codes(alarms)).toEqual(['BATCH_STALE']);
    expect(alarms[0].key).toBe('0');
  });

  it('names every batch rather than listing 24 when all are frozen', () => {
    const alarms = evaluate(healthy({ batches: { lastPublished: {} } }), NOW);
    expect(alarms[0].message).toContain('all 24 batches');
  });

  it('flags a run held in `waiting`, the exact state of the eight-day holder', () => {
    const state = healthy({
      runs: {
        waiting: [
          {
            id: 37313510144,
            name: 'Update Leaderboard',
            status: 'waiting',
            created_at: minutesAgo(91)
          }
        ],
        pipelineInProgress: [],
        pipelineRecentConclusions: ['success', 'success']
      }
    });
    const alarms = evaluate(state, NOW);
    expect(codes(alarms)).toEqual(['STUCK_RUN']);
    expect(alarms[0].message).toContain('gh run cancel 37313510144');
  });

  it('leaves an ordinary queue alone', () => {
    const state = healthy({
      runs: {
        waiting: [{ id: 1, name: 'CI', status: 'queued', created_at: minutesAgo(30) }],
        pipelineInProgress: [],
        pipelineRecentConclusions: ['success']
      }
    });
    expect(evaluate(state, NOW)).toEqual([]);
  });

  it('ignores the two phantom records GitHub will not let anyone cancel', () => {
    const waiting = [...IGNORED_RUN_IDS].map((id) => ({
      id,
      name: 'Update Leaderboard',
      status: 'queued',
      created_at: hoursAgo(24 * 50)
    }));
    const state = healthy({
      runs: { waiting, pipelineInProgress: [], pipelineRecentConclusions: ['success'] }
    });
    expect(evaluate(state, NOW)).toEqual([]);
  });

  it('warns before a pipeline run reaches its timeout', () => {
    const state = healthy({
      runs: {
        waiting: [],
        pipelineInProgress: [{ id: 9, run_started_at: minutesAgo(95) }],
        pipelineRecentConclusions: ['success']
      }
    });
    expect(codes(evaluate(state, NOW))).toEqual(['LONG_RUN']);
  });

  it('flags consecutive cancellations, which GitHub reports as nothing at all', () => {
    const state = healthy({
      runs: {
        waiting: [],
        pipelineInProgress: [],
        pipelineRecentConclusions: ['cancelled', 'cancelled']
      }
    });
    expect(codes(evaluate(state, NOW))).toEqual(['CANCELLED_STREAK']);
  });

  it('does not flag a single cancellation', () => {
    const state = healthy({
      runs: {
        waiting: [],
        pipelineInProgress: [],
        pipelineRecentConclusions: ['cancelled', 'success']
      }
    });
    expect(evaluate(state, NOW)).toEqual([]);
  });

  it('flags a disabled backup trigger, the part GitHub can auto-disable', () => {
    const alarms = evaluate(healthy({ backupWorkflow: { state: 'disabled_inactivity' } }), NOW);
    expect(codes(alarms)).toEqual(['BACKUP_DISABLED']);
    expect(alarms[0].message).toContain("the Worker's :00 dispatch is now the only thing");
  });

  it('treats an unreadable backup trigger as a failed check', () => {
    const alarms = evaluate(healthy({ backupWorkflow: { error: 'HTTP 404' } }), NOW);
    expect(codes(alarms)).toEqual(['CHECK_FAILED']);
  });

  it('is quiet when the backup trigger is active', () => {
    expect(evaluate(healthy({ backupWorkflow: { state: 'active' } }), NOW)).toEqual([]);
  });

  it('flags a disabled pipeline workflow', () => {
    const alarms = evaluate(healthy({ workflow: { state: 'disabled_inactivity' } }), NOW);
    expect(codes(alarms)).toEqual(['WORKFLOW_DISABLED']);
  });

  it('treats a check it could not read as a failure, not a pass', () => {
    const alarms = evaluate(healthy({ site: { error: 'HTTP 503' } }), NOW);
    expect(codes(alarms)).toEqual(['CHECK_FAILED']);
    expect(alarms[0].message).toContain('HTTP 503');
  });

  it('would have fired 90 minutes into the October 2026 outage', () => {
    // 2026-10-05 14:31 UTC: the holder had sat in `waiting` since 13:00, and
    // the 14:00 dispatch was pending behind it. Data was still only two hours
    // old, so only the stuck-run check could have caught it this early.
    const at = Date.parse('2026-10-05T14:31:00Z');
    const state = {
      site: { lastUpdated: '2026-10-05T12:22:09Z' },
      batches: { lastPublished: allBatchesAt('2026-10-05T12:22:09Z') },
      runs: {
        waiting: [
          {
            id: 37313510144,
            name: 'Update Leaderboard',
            status: 'waiting',
            created_at: '2026-10-05T13:00:20Z'
          },
          {
            id: 37314000000,
            name: 'Update Leaderboard',
            status: 'pending',
            created_at: '2026-10-05T14:00:20Z'
          }
        ],
        pipelineInProgress: [],
        pipelineRecentConclusions: ['success', 'success']
      },
      workflow: { state: 'active' }
    };
    const alarms = evaluate(state, at);
    expect(codes(alarms)).toEqual(['STUCK_RUN']);
    expect(alarms[0].key).toBe('37313510144');
  });
});

describe('signatures', () => {
  it('ignores the order alarms were found in', () => {
    const a = [
      { code: 'SITE_STALE', key: 'site' },
      { code: 'STUCK_RUN', key: '1' }
    ];
    expect(signatureOf(a)).toBe(signatureOf([...a].reverse()));
  });

  it('round-trips through the issue body', () => {
    const alarms = [{ code: 'SITE_STALE', key: 'site', message: 'old' }];
    const body = renderIssueBody(alarms, { owner: 'someone', checkedAt: 'now' });
    expect(body).toContain(ISSUE_MARKER);
    expect(body).toContain('@someone');
    expect(readSignature(body)).toBe(signatureOf(alarms));
  });
});

describe('collectState', () => {
  it('reads runs by status filter, never from the newest page alone', async () => {
    // The eight-day holder was older than the latest 100 runs. A watchdog that
    // read only the first page would have reported it as absent, exactly as
    // the first diagnosis did.
    const seen = [];
    const api = {
      request: async (method, path) => {
        seen.push(path);
        return path.includes('/actions/workflows/update-digest.yml/runs')
          ? { workflow_runs: [] }
          : { state: 'active' };
      },
      getPages: async (path, pick) => {
        seen.push(path);
        return pick({ workflow_runs: [] });
      }
    };
    const fetchImpl = async () => ({ ok: true, json: async () => ({ last_updated: hoursAgo(1) }) });

    await collectState({ api, siteUrl: 'https://example.test/data.json', now: NOW, fetchImpl });

    for (const status of ['queued', 'pending', 'waiting', 'requested']) {
      expect(seen).toContain(`/actions/runs?status=${status}`);
    }
  });

  it('reports a site it cannot reach as unreadable instead of throwing', async () => {
    const api = {
      request: async () => ({ workflow_runs: [], state: 'active' }),
      getPages: async (path, pick) => pick({ workflow_runs: [] })
    };
    const fetchImpl = async () => ({ ok: false, status: 502 });
    const state = await collectState({
      api,
      siteUrl: 'https://example.test/data.json',
      now: NOW,
      fetchImpl
    });
    expect(state.site.error).toBe('HTTP 502');
  });
});

describe('batch freshness, read from the pipeline state', () => {
  // Nothing commits the board to main any more, so the time a batch last
  // published is the newest `scored_at` among its rows in the latest state.
  const quietApi = {
    request: async () => ({ workflow_runs: [], state: 'active' }),
    getPages: async (path, pick) => pick({ workflow_runs: [] })
  };
  const site = async () => ({ ok: true, json: async () => ({ last_updated: hoursAgo(1) }) });
  const rowsFor = (batch, ...ages) =>
    ages.map((h, i) => ({
      username: `b${batch}-${i}`,
      batch_index: batch,
      scored_at: hoursAgo(h)
    }));
  const stateWith =
    (rows, createdAt = hoursAgo(0.5)) =>
    async () => ({
      payload: { leaderboard: rows },
      asset: { name: 'state-38413673323-1.json.gz', created_at: createdAt }
    });

  it('dates a batch by its recorded run, even with no rows left on the board', () => {
    // A batch can run and still lose every row to the 1,000 cap; its run is the evidence.
    const last = lastMeasuredByBatch(rowsFor(0, 30), {
      0: { at: hoursAgo(2) },
      5: { at: hoursAgo(1) },
      bad: { at: 'x' }
    });
    expect(last).toEqual({ 0: hoursAgo(2), 5: hoursAgo(1) });
  });

  it('keeps the later of a recorded run and a row', () => {
    const last = lastMeasuredByBatch(rowsFor(3, 1), { 3: { at: hoursAgo(10) } });
    expect(last).toEqual({ 3: hoursAgo(1) });
  });

  it('takes the newest scored_at per batch, and skips rows from before it existed', () => {
    const last = lastMeasuredByBatch([
      ...rowsFor(0, 30, 20),
      { username: 'legacy', batch_index: 1, score: 5 },
      ...rowsFor(2, 70)
    ]);
    expect(last).toEqual({ 0: hoursAgo(20), 2: hoursAgo(70) });
  });

  it('flags the one batch whose rows have not been measured in 49 hours', async () => {
    const rows = [];
    for (let b = 0; b < THRESHOLDS.BATCH_COUNT; b += 1) rows.push(...rowsFor(b, b === 9 ? 50 : 20));
    const state = await collectState({
      api: quietApi,
      siteUrl: 'https://example.test/data.json',
      now: NOW,
      fetchImpl: site,
      loadState: stateWith(rows)
    });
    const alarms = evaluate(state, NOW);
    expect(codes(alarms)).toEqual(['BATCH_STALE']);
    expect(alarms[0].key).toBe('9');
    expect(alarms[0].message).toMatch(/Nothing measured in 49 h for batch 9/);
  });

  it('says a batch with no dated rows is unknown, not that it measured nobody', async () => {
    // 2026-10-13: batches 16-18 ran at 11:07, 12:00 and 13:00 UTC, before rows carried
    // `scored_at`, and the first state-based run reported "Nothing measured in 49 h" for them.
    const rows = [];
    for (let b = 0; b < THRESHOLDS.BATCH_COUNT; b += 1) {
      if (b === 16 || b === 17) rows.push({ username: `legacy-${b}`, batch_index: b, score: 5 });
      else rows.push(...rowsFor(b, b === 9 ? 50 : 20));
    }
    const state = await collectState({
      api: quietApi,
      siteUrl: 'https://example.test/data.json',
      now: NOW,
      fetchImpl: site,
      loadState: stateWith(rows)
    });
    const alarms = evaluate(state, NOW);
    expect(codes(alarms)).toEqual(['BATCH_STALE']);
    expect(alarms[0].key).toBe('9,16,17');
    expect(alarms[0].message).toMatch(/Nothing measured in 49 h for batch 9\./);
    expect(alarms[0].message).toMatch(/No measurement date on record for batches 16, 17:/);
    expect(alarms[0].message).not.toMatch(/Nothing measured in 49 h for batch(es)? [^.]*16/);
  });

  it('reports one undated batch in the singular', () => {
    const lastPublished = allBatchesAt(hoursAgo(20));
    delete lastPublished[3];
    const [alarm] = evaluate(healthy({ batches: { lastPublished } }), NOW);
    expect(alarm.message).toBe(
      'No measurement date on record for batch 3: every row it owns predates `scored_at`, ' +
        'so when it last ran is unknown. This clears the next time it runs.'
    );
  });

  it('treats a missing or unreadable state as a failed check, not a pass', async () => {
    for (const loadState of [
      async () => null,
      async () => {
        throw new Error('None of the newest 5 state assets could be read');
      }
    ]) {
      const state = await collectState({
        api: quietApi,
        siteUrl: 'https://example.test/data.json',
        now: NOW,
        fetchImpl: site,
        loadState
      });
      const alarms = evaluate(state, NOW);
      expect(codes(alarms)).toEqual(['CHECK_FAILED']);
      expect(alarms[0].message).toMatch(/pipeline state/);
    }
  });

  it("records the state asset's age among the facts", async () => {
    const rows = [];
    for (let b = 0; b < THRESHOLDS.BATCH_COUNT; b += 1) rows.push(...rowsFor(b, b === 3 ? 60 : 2));
    const state = await collectState({
      api: quietApi,
      siteUrl: 'https://example.test/data.json',
      now: NOW,
      fetchImpl: site,
      loadState: stateWith(rows, hoursAgo(1.5))
    });
    const facts = Object.fromEntries(factsFrom(state, NOW, null));
    expect(facts['Latest state asset']).toBe(
      `state-38413673323-1.json.gz (saved ${hoursAgo(1.5)}, 1.5 h old)`
    );
    expect(facts['Batches measured in last 49 h']).toBe('23 of 24');
  });
});

describe('reconcileIssue', () => {
  function fakeApi(openIssues = []) {
    const calls = [];
    return {
      calls,
      getPages: async () => openIssues,
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        return { number: 77 };
      }
    };
  }
  const alarms = [{ code: 'SITE_STALE', key: 'site', message: 'old' }];
  const run = async (api, current) => reconcileIssue({ api, alarms: current, checkedAt: 'now' });

  it('opens one issue when the first alarm appears, as new trouble', async () => {
    const api = fakeApi([]);
    expect(await run(api, alarms)).toEqual({ outcome: 'opened #77', newTrouble: true });
    expect(api.calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('stays quiet while the same alarms persist', async () => {
    const body = renderIssueBody(alarms, { checkedAt: 'earlier' });
    const api = fakeApi([{ number: 5, body }]);
    const result = await run(api, alarms);
    expect(result.outcome).toContain('already describes');
    expect(result.newTrouble).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('comments, and reports new trouble, when a new check alarms', async () => {
    const body = renderIssueBody(alarms, { checkedAt: 'earlier' });
    const api = fakeApi([{ number: 5, body }]);
    const more = [...alarms, { code: 'STUCK_RUN', key: '9', message: 'held' }];
    expect(await run(api, more)).toEqual({
      outcome: 'updated #5 with new problems',
      newTrouble: true
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /issues/5',
      'POST /issues/5/comments'
    ]);
  });

  it('updates the issue without a comment while stale batches recover', async () => {
    // 2026-10-13: 21 batches stale after the outage, clearing one an hour. Each hour the set
    // shrinks; none of that is news, and none of it should email anyone.
    const stale = (batches) => [
      { code: 'BATCH_STALE', key: batches.join(','), message: `stale ${batches.join(',')}` }
    ];
    const body = renderIssueBody(stale([0, 1, 2, 3]), { checkedAt: 'earlier' });
    const api = fakeApi([{ number: 5, body }]);
    const result = await run(api, stale([1, 2, 3]));
    expect(result.newTrouble).toBe(false);
    expect(result.outcome).toMatch(/quietly/);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /issues/5']);
  });

  it('reports new trouble when a batch joins the stale set', async () => {
    const stale = (batches) => [{ code: 'BATCH_STALE', key: batches.join(','), message: 'x' }];
    const body = renderIssueBody(stale([1, 2]), { checkedAt: 'earlier' });
    const api = fakeApi([{ number: 5, body }]);
    expect((await run(api, stale([1, 2, 7]))).newTrouble).toBe(true);
    expect(api.calls.at(-1).path).toBe('/issues/5/comments');
  });

  it('closes the issue once every check passes again', async () => {
    const api = fakeApi([{ number: 5, body: renderIssueBody(alarms, { checkedAt: 'x' }) }]);
    expect(await run(api, [])).toEqual({ outcome: 'closed #5', newTrouble: false });
    expect(api.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { state: 'closed' } });
  });

  it('never touches an issue it did not open', async () => {
    const api = fakeApi([
      { number: 3, body: 'somebody else' },
      { number: 4, pull_request: {}, body: ISSUE_MARKER }
    ]);
    expect((await run(api, [])).outcome).toContain('nothing to do');
  });

  it('writes nothing on a dry run', async () => {
    const api = fakeApi([]);
    const result = await reconcileIssue({ api, alarms, checkedAt: 'now', dryRun: true });
    expect(result.outcome).toContain('would open');
    expect(api.calls).toEqual([]);
  });
});

describe('isNewTrouble', () => {
  const sig = (alarms) => signatureOf(alarms);
  const a = (code, key) => ({ code, key, message: '' });

  it('treats everything as new when nothing was reported', () => {
    expect(isNewTrouble(null, [a('SITE_STALE', 'site')])).toBe(true);
    expect(isNewTrouble(null, [])).toBe(false);
  });

  it('is not new for the same, or fewer, members of a reported check', () => {
    const before = sig([a('BATCH_STALE', '0,1,2'), a('SITE_STALE', 'site')]);
    expect(isNewTrouble(before, [a('BATCH_STALE', '0,1,2')])).toBe(false);
    expect(isNewTrouble(before, [a('BATCH_STALE', '2')])).toBe(false);
  });

  it('is new for a new check, or a new member of a reported one', () => {
    const before = sig([a('BATCH_STALE', '0,1')]);
    expect(isNewTrouble(before, [a('BATCH_STALE', '0,1,5')])).toBe(true);
    expect(isNewTrouble(before, [a('BATCH_STALE', '0'), a('STUCK_RUN', '9')])).toBe(true);
  });
});

describe('THRESHOLDS', () => {
  it('matches the pipeline timeout actually configured', () => {
    const workflow = fs.readFileSync(
      new URL('../.github/workflows/update-digest.yml', import.meta.url),
      'utf8'
    );
    // The pipeline job's own timeout, not the first one in the file: the
    // guard job ahead of it has a short timeout of its own.
    const configured = Number(
      /update-leaderboard:[\s\S]*?timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]
    );
    expect(configured).toBe(THRESHOLDS.PIPELINE_TIMEOUT_MINUTES);
  });
});
