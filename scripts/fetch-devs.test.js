import { describe, it, expect } from 'vitest';
import { rateLimitWaitMs, MAX_RATE_LIMIT_RETRIES, shardQuality } from './fetch-devs.js';

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

describe('shardQuality', () => {
  it('stays silent for a complete listing', () => {
    expect(shardQuality({ total: 966, unique: 966, incomplete: false })).toEqual([]);
  });

  it('names a listing that came back short, the 560-of-881 case', () => {
    expect(shardQuality({ total: 881, unique: 560, incomplete: false })).toEqual([
      'paging returned 560 unique of 881 expected'
    ]);
  });

  it('names duplicates, which shrink the unique count', () => {
    // 2026-10-05: a mid-pagination rate-limit wait returned 1,000 items but
    // only 848 distinct developers.
    expect(shardQuality({ total: 1100, unique: 848, incomplete: false })[0]).toContain(
      '848 unique of 1000'
    );
  });

  it('names a shard over the search cap even when paging was clean', () => {
    expect(shardQuality({ total: 1354, unique: 1000, incomplete: false })).toEqual([
      '1354 match but only 1000 are reachable'
    ]);
  });

  it('passes on what GitHub itself flags', () => {
    expect(shardQuality({ total: 500, unique: 500, incomplete: true })).toEqual([
      'GitHub flagged incomplete_results'
    ]);
  });

  it('does not invent an expectation when the total is unknown', () => {
    expect(shardQuality({ total: null, unique: 12, incomplete: false })).toEqual([]);
  });
});
