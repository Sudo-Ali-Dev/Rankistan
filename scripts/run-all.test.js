import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReplacementIsSafe,
  mergeBatchIntoLeaderboard,
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

describe('mergeBatchIntoLeaderboard', () => {
  const row = (username, batch, score) => ({
    username,
    batch_index: batch,
    score,
    score_exact: score,
    model_version: '3.0.0'
  });

  const write = (file, leaderboard) =>
    fs.writeFileSync(file, JSON.stringify({ last_updated: 'x', total_devs: leaderboard.length, leaderboard }));

  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).leaderboard;

  let tmp;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `rankistan-merge-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  });
  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  it('replaces only the rows the batch owns', () => {
    write(tmp, [row('a', 0, 500), row('b', 0, 400), row('c', 7, 300)]);
    mergeBatchIntoLeaderboard({
      batchIndex: 0,
      newEntries: [row('a', 0, 900), row('z', 0, 800)],
      targetPath: tmp
    });
    const out = read(tmp);
    expect(out.map((d) => d.username).sort()).toEqual(['a', 'c', 'z']);
    expect(out.find((d) => d.username === 'a').score).toBe(900);
    // untouched batch carried across at its old value
    expect(out.find((d) => d.username === 'c').score).toBe(300);
  });

  // The race this exists to survive: batch 0 checks out the board, spends 46
  // minutes fetching, and by the time it pushes, batch 23 has published its own
  // rows. Re-merging must keep both. A textual merge conflicts here, and
  // resolving that conflict by taking either side wholesale silently deletes
  // the other batch's work.
  it('keeps the other batch when a slow batch lands after it', () => {
    const atCheckout = [row('slow-1', 0, 500), row('other', 23, 300)];
    write(tmp, atCheckout);

    // main moves: batch 23 republishes while batch 0 is still fetching
    write(tmp, [row('slow-1', 0, 500), row('other', 23, 999), row('newcomer', 23, 950)]);

    // batch 0 finishes and replays its rows onto the file as it now stands
    mergeBatchIntoLeaderboard({
      batchIndex: 0,
      newEntries: [row('slow-1', 0, 600), row('slow-2', 0, 550)],
      targetPath: tmp
    });

    const out = read(tmp);
    const byName = Object.fromEntries(out.map((d) => [d.username, d]));
    expect(Object.keys(byName).sort()).toEqual(['newcomer', 'other', 'slow-1', 'slow-2']);
    expect(byName['slow-1'].score).toBe(600);
    expect(byName.other.score).toBe(999);
    expect(byName.newcomer.score).toBe(950);
  });

  it('reranks across the whole board, not within the batch', () => {
    write(tmp, [row('a', 0, 100), row('b', 7, 800), row('c', 7, 700)]);
    mergeBatchIntoLeaderboard({ batchIndex: 0, newEntries: [row('a', 0, 900)], targetPath: tmp });
    const out = read(tmp);
    expect(out.map((d) => [d.username, d.rank])).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });

  it('still refuses a replacement that would shrink the board', () => {
    write(tmp, Array.from({ length: 200 }, (_, i) => row(`u${i}`, 0, 100 - i / 10)));
    expect(() =>
      mergeBatchIntoLeaderboard({ batchIndex: 0, newEntries: [row('only', 0, 500)], targetPath: tmp })
    ).toThrow(/Data Integrity Exception/);
  });
});
