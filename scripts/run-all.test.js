import { describe, it, expect } from 'vitest';
import {
  assertReplacementIsSafe,
  MIN_REPLACEMENT_RATIO,
  MIN_COHORT_FOR_RATIO_CHECK
} from './run-all.js';

const call = (over = {}) =>
  assertReplacementIsSafe({
    batchIndex: 6,
    batchLabel: 'PK test cohort',
    removedCount: 100,
    replacementCount: 100,
    ...over
  });

describe('assertReplacementIsSafe', () => {
  it('allows a like-for-like replacement', () => {
    expect(() => call()).not.toThrow();
  });

  it('allows growth', () => {
    expect(() => call({ replacementCount: 140 })).not.toThrow();
  });

  it('is a no-op on the first run, when nothing is displaced', () => {
    expect(() => call({ removedCount: 0, replacementCount: 0 })).not.toThrow();
  });

  it('refuses to purge a cohort and replace it with nothing', () => {
    expect(() => call({ replacementCount: 0 })).toThrow(/without replacing them/);
  });

  it('refuses an implausibly small replacement, the throttled-fetch case', () => {
    // 100 developers displaced, 5 came back: the shape of a secondary
    // rate-limit storm mid-batch, which the old zero-only check let through.
    expect(() => call({ replacementCount: 5 })).toThrow(/below the 50% floor/);
  });

  it('allows a replacement exactly at the floor', () => {
    expect(() => call({ replacementCount: 100 * MIN_REPLACEMENT_RATIO })).not.toThrow();
  });

  it('rejects just under the floor', () => {
    expect(() => call({ replacementCount: 100 * MIN_REPLACEMENT_RATIO - 1 })).toThrow(
      /below the 50% floor/
    );
  });

  it('skips the ratio check for small cohorts, where variance is normal', () => {
    // A 12-developer batch losing half its members is ordinary noise, not a bug.
    const small = MIN_COHORT_FOR_RATIO_CHECK - 8;
    expect(() => call({ removedCount: small, replacementCount: 1 })).not.toThrow();
  });

  it('still refuses a total wipe even for a small cohort', () => {
    expect(() => call({ removedCount: 3, replacementCount: 0 })).toThrow(
      /without replacing them/
    );
  });

  it('honours the ALLOW_LEADERBOARD_SHRINK escape hatch', () => {
    expect(() => call({ replacementCount: 5, allowShrink: true })).not.toThrow();
  });

  it('does not let the escape hatch permit a total wipe', () => {
    expect(() => call({ replacementCount: 0, allowShrink: true })).toThrow(
      /without replacing them/
    );
  });

  it('names the batch so a CI failure is diagnosable', () => {
    expect(() => call({ batchIndex: 23, batchLabel: 'PK Apr2025-Now', replacementCount: 0 }))
      .toThrow(/batch 23 \(PK Apr2025-Now\)/);
  });
});
