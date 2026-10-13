import { describe, it, expect } from 'vitest';
import { freshnessOf, formatAge, FRESHNESS } from './freshness';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

describe('freshnessOf', () => {
  it('calls recent data live and says how recent', () => {
    const f = freshnessOf(hoursAgo(0.5), NOW);
    expect(f.state).toBe('live');
    expect(f.label).toBe('SYSTEM_STATUS: LIVE_SYNC · UPDATED 30M AGO');
  });

  it('stays live through the worst normal gap seen in 83 days (3.2 h)', () => {
    expect(freshnessOf(hoursAgo(3.2), NOW).state).toBe('live');
  });

  it('stops claiming live past the threshold', () => {
    expect(freshnessOf(hoursAgo(FRESHNESS.LIVE_MAX_HOURS + 0.1), NOW).state).toBe('delayed');
  });

  it('says stale, and how stale, for the October 2026 outage', () => {
    // last_updated 2026-10-05T12:22Z, read eight days later.
    const f = freshnessOf('2026-10-05T12:22:09Z', NOW);
    expect(f.state).toBe('stale');
    expect(f.label).toBe('SYSTEM_STATUS: STALE · LAST SYNC 8D AGO');
  });

  it('keeps the state and the age apart so the line can wrap between them', () => {
    const f = freshnessOf('2026-10-05T12:22:09Z', NOW);
    expect(f.status).toBe('STALE');
    expect(f.detail).toBe('LAST SYNC 8D AGO');
  });

  it('reports unknown rather than live when the timestamp is missing', () => {
    expect(freshnessOf(undefined, NOW).state).toBe('unknown');
    expect(freshnessOf('not a date', NOW).state).toBe('unknown');
  });

  it('does not report a negative age when the visitor clock runs ahead', () => {
    expect(freshnessOf(new Date(NOW + 60_000).toISOString(), NOW).ageHours).toBe(0);
  });
});

describe('formatAge', () => {
  it('uses minutes, then hours, then days', () => {
    expect(formatAge(0.25)).toBe('15M');
    expect(formatAge(5)).toBe('5H');
    expect(formatAge(47)).toBe('47H');
    expect(formatAge(72)).toBe('3D');
  });
});
