import { describe, it, expect } from 'vitest';
import {
  healthVerdict,
  handleHealthRequest,
  HEALTH_BOARD_URL,
  HEALTH_STALE_HOURS
} from './health.js';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

describe('healthVerdict', () => {
  it('is ok inside the threshold, including the worst normal gap (3.2 h)', () => {
    expect(HEALTH_STALE_HOURS).toBe(4);
    expect(healthVerdict(hoursAgo(0.5), NOW)).toMatchObject({
      status: 'ok',
      http: 200,
      age_hours: 0.5
    });
    expect(healthVerdict(hoursAgo(3.2), NOW)).toMatchObject({ status: 'ok', http: 200 });
  });

  it('is stale past the threshold', () => {
    expect(healthVerdict(hoursAgo(4.5), NOW)).toMatchObject({
      status: 'stale',
      http: 503,
      age_hours: 4.5
    });
  });

  it('treats a missing or unparseable timestamp as unreadable, never as ok', () => {
    for (const value of [undefined, null, '', 'yesterday']) {
      expect(healthVerdict(value, NOW)).toMatchObject({ status: 'unreadable', http: 503 });
    }
  });
});

describe('handleHealthRequest', () => {
  const serving =
    (payload, status = 200) =>
    async (url) => {
      expect(url).toBe(HEALTH_BOARD_URL);
      return new Response(JSON.stringify(payload), { status });
    };

  it('answers 200 with the age for a fresh board, uncached', async () => {
    const response = await handleHealthRequest({
      fetchImpl: serving({ last_updated: hoursAgo(1) }),
      now: NOW
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ok',
      last_updated: hoursAgo(1),
      age_hours: 1,
      threshold_hours: 4,
      checked_at: new Date(NOW).toISOString()
    });
  });

  it('answers 503 for a stale board, so the monitor emails', async () => {
    const response = await handleHealthRequest({
      fetchImpl: serving({ last_updated: hoursAgo(9) }),
      now: NOW
    });
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('stale');
  });

  it('answers 503 when the board cannot be fetched or parsed', async () => {
    const cases = [
      serving({}, 404),
      async () => new Response('<html>502</html>', { status: 200 }),
      async () => {
        throw new TypeError('network down');
      }
    ];
    for (const fetchImpl of cases) {
      const response = await handleHealthRequest({ fetchImpl, now: NOW });
      expect(response.status).toBe(503);
      expect((await response.json()).status).toBe('unreadable');
    }
  });
});
