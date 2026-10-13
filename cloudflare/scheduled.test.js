import { describe, it, expect } from 'vitest';
import { dispatchScheduledWorkflows, SCHEDULED_WORKFLOWS, DISPATCH_REPO } from './scheduled.js';

const TOKEN = 'github_pat_test_0123456789';
const quiet = { log: () => {}, error: () => {} };

function recorder(answer = () => new Response(null, { status: 204 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

describe('dispatchScheduledWorkflows', () => {
  it('dispatches the backup trigger and the watchdog on main', async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      dispatchScheduledWorkflows({ GITHUB_DISPATCH_TOKEN: TOKEN }, { fetchImpl, log: quiet })
    ).resolves.toBe(2);
    expect(SCHEDULED_WORKFLOWS).toEqual(['pipeline-backup.yml', 'watchdog.yml']);
    expect(calls.map((c) => c.url)).toEqual(
      SCHEDULED_WORKFLOWS.map(
        (w) => `https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${w}/dispatches`
      )
    );
    for (const { init } of calls) {
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers['User-Agent']).toBeTruthy();
      expect(JSON.parse(init.body)).toEqual({ ref: 'main' });
    }
  });

  it('never dispatches the pipeline itself, which would bypass the should-run guard', () => {
    expect(SCHEDULED_WORKFLOWS).not.toContain('update-digest.yml');
  });

  it('refuses to run without a token, so the cron is recorded as failed', async () => {
    const { calls, fetchImpl } = recorder();
    for (const env of [{}, { GITHUB_DISPATCH_TOKEN: '  ' }, undefined]) {
      await expect(dispatchScheduledWorkflows(env, { fetchImpl, log: quiet })).rejects.toThrow(
        /GITHUB_DISPATCH_TOKEN is not set/
      );
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
      dispatchScheduledWorkflows({ GITHUB_DISPATCH_TOKEN: TOKEN }, { fetchImpl, log: quiet })
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
      { fetchImpl, log: quiet }
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
});
