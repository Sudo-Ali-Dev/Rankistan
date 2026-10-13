import { describe, it, expect } from 'vitest';
import { shouldRun, COVER_WINDOW_MINUTES } from './should-run.js';

const NOW = Date.parse('2026-10-13T14:35:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const run = (over) => ({
  id: 1,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  created_at: minutesAgo(35),
  ...over
});

describe('shouldRun', () => {
  it('always runs a dispatched run', () => {
    expect(
      shouldRun({ event: 'workflow_dispatch', runs: [run()], currentRunId: 9, now: NOW }).run
    ).toBe(true);
  });

  it('stands down when the external scheduler already ran this hour', () => {
    const d = shouldRun({ event: 'schedule', runs: [run()], currentRunId: 9, now: NOW });
    expect(d.run).toBe(false);
    expect(d.reason).toContain('already covers this hour');
  });

  it('stands down while a dispatched run is still queued or running', () => {
    for (const status of ['queued', 'in_progress', 'pending']) {
      const d = shouldRun({
        event: 'schedule',
        runs: [run({ status, conclusion: null })],
        currentRunId: 9,
        now: NOW
      });
      expect(d.run).toBe(false);
    }
  });

  it('runs when nothing dispatched this hour - the 2026-10-13 14:00 gap', () => {
    // The last dispatch was at 13:00; the 14:00 one never came.
    const d = shouldRun({
      event: 'schedule',
      runs: [run({ created_at: minutesAgo(95) })],
      currentRunId: 9,
      now: NOW
    });
    expect(d.run).toBe(true);
  });

  it('retries when this hour’s dispatched run failed or was cancelled', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
      expect(
        shouldRun({ event: 'schedule', runs: [run({ conclusion })], currentRunId: 9, now: NOW }).run
      ).toBe(true);
    }
  });

  it('does not count another scheduled run, or itself', () => {
    const runs = [run({ id: 9, event: 'schedule' }), run({ id: 8, event: 'schedule' })];
    expect(shouldRun({ event: 'schedule', runs, currentRunId: 9, now: NOW }).run).toBe(true);
  });

  it('uses a window shorter than an hour, so the previous hour never counts', () => {
    expect(COVER_WINDOW_MINUTES).toBeLessThan(60);
    const d = shouldRun({
      event: 'schedule',
      runs: [run({ created_at: minutesAgo(COVER_WINDOW_MINUTES + 1) })],
      currentRunId: 9,
      now: NOW
    });
    expect(d.run).toBe(true);
  });
});
