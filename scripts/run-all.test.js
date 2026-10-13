import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReplacementIsSafe,
  mergeBatchIntoLeaderboard,
  remergeBatch,
  batchEntriesPath,
  MIN_REPLACEMENT_RATIO,
  MIN_COHORT_FOR_RATIO_CHECK,
  MAX_MISSED_RUNS,
  MIN_MISS_SPAN_HOURS
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
      // b was fetched this run and failed the gate, so it is genuinely out.
      evaluated: ['a', 'b', 'z'],
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
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('only', 0, 500)],
        // All 200 were fetched and rejected: a real collapse, still refused.
        evaluated: ['only', ...Array.from({ length: 200 }, (_, i) => `u${i}`)],
        targetPath: tmp
      })
    ).toThrow(/Data Integrity Exception/);
  });

  describe('absence from search is not evidence', () => {
    it('carries forward a developer the run never saw, unchanged and counted', () => {
      write(tmp, [row('seen', 0, 500), row('missed', 0, 400)]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen'],
        targetPath: tmp
      });
      const missed = read(tmp).find((d) => d.username === 'missed');
      expect(missed).toBeDefined();
      expect(missed.score).toBe(400);
      expect(missed.missed_runs).toBe(1);
    });

    it('removes a developer on the second consecutive miss, a day apart', () => {
      const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
      write(tmp, [row('seen', 0, 500), { ...row('missed', 0, 400), missed_runs: 1, missed_since: dayAgo }]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen'],
        targetPath: tmp
      });
      expect(MAX_MISSED_RUNS).toBe(2);
      expect(read(tmp).map((d) => d.username)).toEqual(['seen']);
    });

    it('does not remove on two misses minutes apart - a re-run is one observation', () => {
      // 2026-10-13: a batch run twice in fifteen minutes removed a developer
      // after his "second" miss.
      const minutesAgo = new Date(Date.now() - 15 * 60_000).toISOString();
      write(tmp, [row('seen', 0, 500), { ...row('missed', 0, 400), missed_runs: 1, missed_since: minutesAgo }]);
      mergeBatchIntoLeaderboard({ batchIndex: 0, newEntries: [row('seen', 0, 600)], evaluated: ['seen'], targetPath: tmp });
      const kept = read(tmp).find((d) => d.username === 'missed');
      expect(kept).toBeDefined();
      expect(kept.missed_since).toBe(minutesAgo);
      expect(MIN_MISS_SPAN_HOURS).toBeGreaterThanOrEqual(20);
    });

    it('starts the clock for a row missed before missed_since existed', () => {
      write(tmp, [row('seen', 0, 500), { ...row('legacy', 0, 400), missed_runs: 1 }]);
      mergeBatchIntoLeaderboard({ batchIndex: 0, newEntries: [row('seen', 0, 600)], evaluated: ['seen'], targetPath: tmp });
      const kept = read(tmp).find((d) => d.username === 'legacy');
      expect(kept).toBeDefined();
      expect(Number.isFinite(Date.parse(kept.missed_since))).toBe(true);
    });

    it('freezes miss counters when discovery was incomplete', () => {
      // A search known to be short cannot show that anyone left.
      const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
      write(tmp, [row('seen', 0, 500), { ...row('missed', 0, 400), missed_runs: 1, missed_since: dayAgo }, row('first', 0, 300)]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen'],
        discoveryComplete: false,
        targetPath: tmp
      });
      const out = read(tmp);
      expect(out.find((d) => d.username === 'missed')?.missed_runs).toBe(1);
      expect(out.find((d) => d.username === 'first')?.missed_runs).toBeUndefined();
    });

    it('still removes the evaluated-and-ineligible when discovery was incomplete', () => {
      write(tmp, [row('quiet', 0, 400), row('active', 0, 500)]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('active', 0, 510)],
        evaluated: ['quiet', 'active'],
        discoveryComplete: false,
        targetPath: tmp
      });
      expect(read(tmp).find((d) => d.username === 'quiet')).toBeUndefined();
    });

    it('clears the miss count once the developer is measured again', () => {
      write(tmp, [{ ...row('back', 0, 400), missed_runs: 1 }]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('back', 0, 450)],
        evaluated: ['back'],
        targetPath: tmp
      });
      const back = read(tmp)[0];
      expect(back.score).toBe(450);
      expect(back.missed_runs).toBeUndefined();
    });

    it('treats a fetch that errored like a search that missed', () => {
      // A per-developer fetch failure leaves them out of `evaluated` too: the
      // run did not look at them, so it cannot judge them.
      write(tmp, [row('errored', 0, 700), row('ok', 0, 300)]);
      mergeBatchIntoLeaderboard({
        batchIndex: 0,
        newEntries: [row('ok', 0, 310)],
        evaluated: ['ok'],
        targetPath: tmp
      });
      expect(read(tmp).find((d) => d.username === 'errored')?.missed_runs).toBe(1);
    });

    it('keeps rank 7 when a degraded search drops them, the #104 incident', () => {
      // Batch 16, 2026-09-29: nadiraliofficial was #7 and absent from that
      // run's search results, so the old merge deleted the row outright.
      const board = [
        row('top-1', 3, 1300),
        ...Array.from({ length: 5 }, (_, i) => row(`peer-${i}`, 16, 1200 - i)),
        row('nadiraliofficial', 16, 1100),
        ...Array.from({ length: 40 }, (_, i) => row(`b16-${i}`, 16, 500 - i))
      ];
      write(tmp, board);
      const reFound = board.filter((d) => d.batch_index === 16 && d.username !== 'nadiraliofficial');
      mergeBatchIntoLeaderboard({
        batchIndex: 16,
        newEntries: reFound,
        evaluated: reFound.map((d) => d.username),
        targetPath: tmp
      });
      const nadir = read(tmp).find((d) => d.username === 'nadiraliofficial');
      expect(nadir?.rank).toBe(7);
      expect(nadir?.missed_runs).toBe(1);
    });

    it('never lets a carried row override what another batch just measured', () => {
      write(tmp, [row('dual', 0, 100), row('dual', 5, 900)]);
      mergeBatchIntoLeaderboard({ batchIndex: 0, newEntries: [], evaluated: [], targetPath: tmp });
      const rows = read(tmp).filter((d) => d.username === 'dual');
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(900);
    });

    it('still fails loudly when a second bad run would empty the batch', () => {
      // Two degraded runs in a row turn carried rows into removals. That is a
      // real collapse of what this batch can see, and it must stop the publish.
      // First misses a day back, so this run's misses really are the second.
      const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
      write(tmp, Array.from({ length: 30 }, (_, i) => ({ ...row(`u${i}`, 0, 100 - i), missed_runs: 1, missed_since: dayAgo })));
      expect(() =>
        mergeBatchIntoLeaderboard({
          batchIndex: 0,
          newEntries: [row('u0', 0, 101), row('u1', 0, 99)],
          evaluated: ['u0', 'u1'],
          targetPath: tmp
        })
      ).toThrow(/Data Integrity Exception/);
    });
  });
});

describe('remergeBatch', () => {
  let dir;
  let target;
  const prevDir = process.env.BATCH_OUTPUT_DIR;
  const row = (username, batch, score) => ({ username, batch_index: batch, score });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-remerge-'));
    process.env.BATCH_OUTPUT_DIR = dir;
    target = path.join(dir, 'data.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ leaderboard: [row('kept', 2, 900), row('gone', 2, 400), row('quiet', 2, 300)] })
    );
  });
  afterEach(() => {
    process.env.BATCH_OUTPUT_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readNames = () =>
    JSON.parse(fs.readFileSync(target, 'utf8')).leaderboard.map((d) => d.username).sort();

  it('applies the same rule on replay: only the evaluated can be removed', () => {
    fs.writeFileSync(
      batchEntriesPath(2),
      JSON.stringify({ batch_index: 2, entries: [row('kept', 2, 950)], evaluated: ['kept', 'gone'] })
    );
    remergeBatch(2, { targetPath: target });
    expect(readNames()).toEqual(['kept', 'quiet']);
  });

  it('removes nobody as ineligible when the saved file predates `evaluated`', () => {
    fs.writeFileSync(batchEntriesPath(2), JSON.stringify({ batch_index: 2, entries: [row('kept', 2, 950)] }));
    remergeBatch(2, { targetPath: target });
    expect(readNames()).toEqual(['gone', 'kept', 'quiet']);
  });
});
