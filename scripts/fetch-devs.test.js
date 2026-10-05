import { describe, it, expect } from 'vitest';
import { rateLimitWaitMs, MAX_RATE_LIMIT_RETRIES, SEARCH_BATCHES } from './fetch-devs.js';

describe('rateLimitWaitMs', () => {
  const headers = (map = {}) => ({ get: (k) => map[k.toLowerCase()] ?? null });
  const SECONDARY =
    '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}';

  it('honours retry-after when GitHub sends one', () => {
    expect(rateLimitWaitMs(SECONDARY, headers({ 'retry-after': '120' }))).toBe(125000);
  });

  // The regression: a secondary limit was waited out using the primary limit's
  // reset, which is in the past during a secondary block, so the wait collapsed
  // to the 5s floor and the retry walked straight back into the same block.
  it('waits at least a minute on a secondary limit, not five seconds', () => {
    const past = headers();
    expect(rateLimitWaitMs(SECONDARY, past, 0)).toBeGreaterThanOrEqual(60000);
  });

  it('backs off further on each successive attempt', () => {
    const a = rateLimitWaitMs(SECONDARY, headers(), 0);
    const b = rateLimitWaitMs(SECONDARY, headers(), 1);
    const c = rateLimitWaitMs(SECONDARY, headers(), 2);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('never waits less than a minute even when the primary reset is past', () => {
    const primary = '{"message":"API rate limit exceeded for user ID 1."}';
    expect(rateLimitWaitMs(primary, headers(), 0)).toBeGreaterThanOrEqual(60000);
  });

  it('gives more than one retry before giving up', () => {
    expect(MAX_RATE_LIMIT_RETRIES).toBeGreaterThan(1);
  });
});

describe('SEARCH_BATCHES', () => {
  const createdRange = (q) => q.match(/created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/).slice(1);

  // PK Mar2023-Jun2023 matches ~1,090 accounts, above GitHub's 1,000-hit cap for a
  // single search, so it has to be sharded. The shards must tile the window exactly:
  // a gap would drop accounts, an overlap would just double-fetch them.
  it('shards PK Mar2023-Jun2023 into contiguous, non-overlapping date ranges', () => {
    const batch = SEARCH_BATCHES.find((b) => b.label === 'PK Mar2023-Jun2023');
    expect(batch.queries).toHaveLength(2);

    const [first, second] = batch.queries.map(createdRange);
    expect(first[0]).toBe('2023-03-01');
    expect(second[1]).toBe('2023-06-30');

    const nextDay = new Date(new Date(`${first[1]}T00:00:00Z`).getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    expect(second[0]).toBe(nextDay);
  });
});
