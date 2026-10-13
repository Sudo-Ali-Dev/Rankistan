import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  dispatchScheduledWorkflows,
  workflowsFor,
  DISPATCH_PLAN,
  DISPATCH_REPO
} from './scheduled.js';

const TOKEN = 'github_pat_test_0123456789';
const PRIMARY = '0 * * * *';
const BACKUP = '35 * * * *';
const quiet = { log: () => {}, error: () => {} };
const here = path.dirname(fileURLToPath(import.meta.url));

function recorder(answer = () => new Response(null, { status: 204 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

const dispatchUrl = (w) =>
  `https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${w}/dispatches`;

describe('DISPATCH_PLAN', () => {
  it('runs the pipeline at :00, and the guarded backup and the watchdog at :35', () => {
    expect(workflowsFor(PRIMARY)).toEqual(['update-digest.yml']);
    expect(workflowsFor(BACKUP)).toEqual(['pipeline-backup.yml', 'watchdog.yml']);
  });

  it('never dispatches the pipeline directly at :35, which would bypass the should-run guard', () => {
    expect(workflowsFor(BACKUP)).not.toContain('update-digest.yml');
  });

  it('matches the crons wrangler.toml declares, so a trigger never fires with no plan', () => {
    const toml = fs.readFileSync(path.join(here, 'wrangler.toml'), 'utf8');
    const line = toml.match(/^crons\s*=\s*\[(.*)\]\s*$/m);
    expect(line).not.toBeNull();
    const crons = [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(crons.sort()).toEqual(Object.keys(DISPATCH_PLAN).sort());
  });

  it('refuses a cron with no plan', () => {
    expect(() => workflowsFor('*/5 * * * *')).toThrow(/No dispatch plan/);
  });
});

describe('dispatchScheduledWorkflows', () => {
  it('dispatches the pipeline on main at :00', async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      dispatchScheduledWorkflows(
        { GITHUB_DISPATCH_TOKEN: TOKEN },
        { cron: PRIMARY, fetchImpl, log: quiet }
      )
    ).resolves.toBe(1);
    expect(calls.map((c) => c.url)).toEqual([dispatchUrl('update-digest.yml')]);
  });

  it('dispatches the backup trigger and the watchdog on main at :35', async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      dispatchScheduledWorkflows(
        { GITHUB_DISPATCH_TOKEN: TOKEN },
        { cron: BACKUP, fetchImpl, log: quiet }
      )
    ).resolves.toBe(2);
    expect(calls.map((c) => c.url)).toEqual(
      ['pipeline-backup.yml', 'watchdog.yml'].map(dispatchUrl)
    );
    for (const { init } of calls) {
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers['User-Agent']).toBeTruthy();
      expect(JSON.parse(init.body)).toEqual({ ref: 'main' });
    }
  });

  it('refuses to run without a token, so the cron is recorded as failed', async () => {
    const { calls, fetchImpl } = recorder();
    for (const env of [{}, { GITHUB_DISPATCH_TOKEN: '  ' }, undefined]) {
      await expect(
        dispatchScheduledWorkflows(env, { cron: PRIMARY, fetchImpl, log: quiet })
      ).rejects.toThrow(/GITHUB_DISPATCH_TOKEN is not set/);
    }
    expect(calls).toHaveLength(0);
  });

  it('still tries the watchdog when the backup dispatch fails, then throws', async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.includes('pipeline-backup')
        ? new Response('{"message":"Bad credentials"}', { status: 401 })
        : new Response(null, { status: 204 })
    );
    await expect(
      dispatchScheduledWorkflows(
        { GITHUB_DISPATCH_TOKEN: TOKEN },
        { cron: BACKUP, fetchImpl, log: quiet }
      )
    ).rejects.toThrow(/1 of 2: pipeline-backup\.yml: HTTP 401 .*Bad credentials/);
    expect(calls).toHaveLength(2);
  });

  it('keeps the token out of every failure message', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('watchdog')) throw new Error(`socket closed for Bearer ${TOKEN}`);
      return new Response(`echo ${TOKEN}`, { status: 500 });
    };
    const error = await dispatchScheduledWorkflows(
      { GITHUB_DISPATCH_TOKEN: TOKEN },
      { cron: BACKUP, fetchImpl, log: quiet }
    ).catch((e) => e);
    expect(error.message).toMatch(/2 of 2/);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[token]');
  });
});

describe('the Worker entry module', () => {
  it('exports only functions and handler objects, which is all the runtime accepts', async () => {
    const entry = await import('./worker.js');
    for (const [name, value] of Object.entries(entry)) {
      const ok =
        typeof value === 'function' ||
        (name === 'default' && typeof value === 'object' && value !== null);
      expect(ok, `${name} is a ${typeof value}`).toBe(true);
    }
    expect(typeof entry.default.scheduled).toBe('function');
    expect(typeof entry.default.fetch).toBe('function');
  });

  it('routes /api/health to the health check', async () => {
    const entry = await import('./worker.js');
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ last_updated: new Date().toISOString() }));
    try {
      const response = await entry.default.fetch(
        new Request('https://example.test/api/health'),
        {}
      );
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe('ok');
    } finally {
      globalThis.fetch = original;
    }
  });
});
