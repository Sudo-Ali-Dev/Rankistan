import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReplacementIsSafe,
  mergeBatch,
  guardBoard,
  runBatch,
  replayBatch,
  evaluatedLogins,
  createFileStore,
  dispatchWorkflows,
  reownRows,
  MIN_REPLACEMENT_RATIO,
  MIN_COHORT_FOR_RATIO_CHECK,
  MAX_MISSED_RUNS,
  MIN_MISS_SPAN_HOURS,
  UNMEASURED_AFTER_DAYS,
  MAX_UNEXPLAINED_LOSS,
  DISPATCHED_WORKFLOWS
} from './run-all.js';
import { MAX_DEVELOPERS } from './fetch-devs.js';
import { emptyRegistry } from './registry.js';
import { BATCH_RANGES } from './discovery/batches.js';
import { SCORE_CONFIG } from '../src/model/config.js';

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
    expect(() => call({ removedCount: 3, replacementCount: 0 })).toThrow(/without replacing them/);
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
    expect(() =>
      call({ batchIndex: 23, batchLabel: 'PK Apr2025-Now', replacementCount: 0 })
    ).toThrow(/batch 23 \(PK Apr2025-Now\)/);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const quiet = { log: () => {}, warn: () => {} };
// No registrations and no opt-outs. runBatch requires a registry reader.
const noIntents = async () => emptyRegistry();

// Legacy-shaped rows: verify:published counts them without recomputing, so
// these tests exercise the merge and guards rather than the scoring model.
const row = (username, batch, score, extra = {}) => ({
  username,
  batch_index: batch,
  score,
  ...extra
});
const at = (days) => new Date(NOW - days * DAY).toISOString();
const hoursBefore = (h) => new Date(NOW - h * 3_600_000).toISOString();
const names = (board) => board.leaderboard.map((d) => d.username);
const merge = (existing, args) =>
  mergeBatch({ existing, batchIndex: 0, newEntries: [], now: NOW, log: quiet, ...args });

describe('mergeBatch', () => {
  it('replaces only the rows the batch owns', () => {
    const { board } = merge([row('a', 0, 500), row('b', 0, 400), row('c', 7, 300)], {
      newEntries: [row('a', 0, 900), row('z', 0, 800)],
      // b was fetched this run and failed the gate, so it is genuinely out.
      evaluated: ['a', 'b', 'z']
    });
    expect(names(board).sort()).toEqual(['a', 'c', 'z']);
    expect(board.leaderboard.find((d) => d.username === 'a').score).toBe(900);
    // untouched batch carried across at its old value
    expect(board.leaderboard.find((d) => d.username === 'c').score).toBe(300);
  });

  it('reranks across the whole board, not within the batch', () => {
    const { board } = merge([row('a', 0, 100), row('b', 7, 800), row('c', 7, 700)], {
      newEntries: [row('a', 0, 900)]
    });
    expect(board.leaderboard.map((d) => [d.username, d.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ]);
  });

  it('stamps the board with the run time and leaves its input untouched', () => {
    const existing = [row('a', 0, 100), row('b', 7, 800)];
    const before = JSON.stringify(existing);
    const { board } = merge(existing, { newEntries: [row('a', 0, 900)] });
    expect(board.last_updated).toBe(new Date(NOW).toISOString());
    expect(board.total_devs).toBe(2);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it('still refuses a replacement that would shrink the board', () => {
    const existing = Array.from({ length: 200 }, (_, i) => row(`u${i}`, 0, 100 - i / 10));
    expect(() =>
      merge(existing, {
        newEntries: [row('only', 0, 500)],
        // All 200 were fetched and rejected: a real collapse, still refused.
        evaluated: ['only', ...existing.map((d) => d.username)]
      })
    ).toThrow(/Data Integrity Exception/);
  });

  describe('absence from search is not evidence', () => {
    it('carries forward a developer the run never saw, unchanged and counted', () => {
      const { board } = merge([row('seen', 0, 500), row('missed', 0, 400)], {
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen']
      });
      const missed = board.leaderboard.find((d) => d.username === 'missed');
      expect(missed.score).toBe(400);
      expect(missed.missed_runs).toBe(1);
    });

    it('removes a developer on the second consecutive miss, a day apart, and says so', () => {
      const { board, removed } = merge(
        [
          row('seen', 0, 500),
          row('missed', 0, 400, { missed_runs: 1, missed_since: hoursBefore(25) })
        ],
        { newEntries: [row('seen', 0, 600)], evaluated: ['seen'] }
      );
      expect(MAX_MISSED_RUNS).toBe(2);
      expect(names(board)).toEqual(['seen']);
      expect(removed).toEqual([{ username: 'missed', batch_index: 0, reason: 'missed' }]);
    });

    it('records when the first miss happened', () => {
      const { board } = merge([row('seen', 0, 500), row('missed', 0, 400)], {
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen']
      });
      const missed = board.leaderboard.find((d) => d.username === 'missed');
      expect(missed.missed_runs).toBe(1);
      expect(missed.missed_since).toBe(new Date(NOW).toISOString());
    });

    it('does not remove on two misses minutes apart - a re-run is one observation', () => {
      // 2026-10-13: a batch run twice in fifteen minutes removed a developer
      // after his "second" miss.
      const minutesAgo = new Date(NOW - 15 * 60_000).toISOString();
      const { board, removed } = merge(
        [row('seen', 0, 500), row('missed', 0, 400, { missed_runs: 1, missed_since: minutesAgo })],
        { newEntries: [row('seen', 0, 600)], evaluated: ['seen'] }
      );
      const kept = board.leaderboard.find((d) => d.username === 'missed');
      expect(kept).toBeDefined();
      expect(kept.missed_since).toBe(minutesAgo);
      expect(removed).toEqual([]);
      expect(MIN_MISS_SPAN_HOURS).toBeGreaterThanOrEqual(20);
    });

    it('starts the clock for a row missed before missed_since existed', () => {
      const { board } = merge([row('seen', 0, 500), row('legacy', 0, 400, { missed_runs: 1 })], {
        newEntries: [row('seen', 0, 600)],
        evaluated: ['seen']
      });
      const kept = board.leaderboard.find((d) => d.username === 'legacy');
      expect(kept).toBeDefined();
      expect(Number.isFinite(Date.parse(kept.missed_since))).toBe(true);
    });

    it('freezes miss counters when discovery was incomplete', () => {
      // A search known to be short cannot show that anyone left.
      const { board, removed } = merge(
        [
          row('seen', 0, 500),
          row('missed', 0, 400, { missed_runs: 1, missed_since: hoursBefore(25) }),
          row('first', 0, 300)
        ],
        { newEntries: [row('seen', 0, 600)], evaluated: ['seen'], discoveryComplete: false }
      );
      expect(board.leaderboard.find((d) => d.username === 'missed')?.missed_runs).toBe(1);
      expect(board.leaderboard.find((d) => d.username === 'first')?.missed_runs).toBeUndefined();
      expect(removed).toEqual([]);
    });

    it('still removes the evaluated-and-ineligible when discovery was incomplete', () => {
      const { board, removed } = merge([row('quiet', 0, 400), row('active', 0, 500)], {
        newEntries: [row('active', 0, 510)],
        evaluated: ['quiet', 'active'],
        discoveryComplete: false
      });
      expect(board.leaderboard.find((d) => d.username === 'quiet')).toBeUndefined();
      expect(removed).toEqual([{ username: 'quiet', batch_index: 0, reason: 'ineligible' }]);
    });

    it('clears the miss count once the developer is measured again', () => {
      const { board } = merge([row('back', 0, 400, { missed_runs: 1 })], {
        newEntries: [row('back', 0, 450)],
        evaluated: ['back']
      });
      expect(board.leaderboard[0].score).toBe(450);
      expect(board.leaderboard[0].missed_runs).toBeUndefined();
    });

    it('treats a fetch that errored like a search that missed', () => {
      // A per-developer fetch failure leaves them out of `evaluated` too: the
      // run did not look at them, so it cannot judge them.
      const { board } = merge([row('errored', 0, 700), row('ok', 0, 300)], {
        newEntries: [row('ok', 0, 310)],
        evaluated: ['ok']
      });
      expect(board.leaderboard.find((d) => d.username === 'errored')?.missed_runs).toBe(1);
    });

    it('keeps rank 7 when a degraded search drops them, the #104 incident', () => {
      // Batch 16, 2026-09-29: nadiraliofficial was #7 and absent from that
      // run's search results, so the old merge deleted the row outright.
      const existing = [
        row('top-1', 3, 1300),
        ...Array.from({ length: 5 }, (_, i) => row(`peer-${i}`, 16, 1200 - i)),
        row('nadiraliofficial', 16, 1100),
        ...Array.from({ length: 40 }, (_, i) => row(`b16-${i}`, 16, 500 - i))
      ];
      const reFound = existing.filter(
        (d) => d.batch_index === 16 && d.username !== 'nadiraliofficial'
      );
      const { board } = mergeBatch({
        existing,
        batchIndex: 16,
        newEntries: reFound,
        evaluated: reFound.map((d) => d.username),
        now: NOW,
        log: quiet
      });
      const nadir = board.leaderboard.find((d) => d.username === 'nadiraliofficial');
      expect(nadir?.rank).toBe(7);
      expect(nadir?.missed_runs).toBe(1);
    });

    it('never lets a carried row override what another batch just measured', () => {
      const { board } = merge([row('dual', 0, 100), row('dual', 5, 900)], { evaluated: [] });
      const rows = board.leaderboard.filter((d) => d.username === 'dual');
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(900);
    });

    it('still fails loudly when a second bad run would empty the batch', () => {
      // Two degraded runs in a row turn carried rows into removals. That is a
      // real collapse of what this batch can see, and it must stop the save.
      // First misses a day back, so this run's misses really are the second.
      const existing = Array.from({ length: 30 }, (_, i) =>
        row(`u${i}`, 0, 100 - i, { missed_runs: 1, missed_since: hoursBefore(25) })
      );
      expect(() =>
        merge(existing, {
          newEntries: [row('u0', 0, 101), row('u1', 0, 99)],
          evaluated: ['u0', 'u1']
        })
      ).toThrow(/Data Integrity Exception/);
    });
  });

  describe('rows not measured for a week', () => {
    it(`takes rows off the board ${UNMEASURED_AFTER_DAYS} days after their last measurement`, () => {
      // Batch 9 has not run for eight days: a crash, or a range that outgrew
      // its timeout. Its rows used to stay on the board at their old scores.
      const { board, removed } = merge(
        [row('fresh', 0, 500), row('frozen', 9, 900, { scored_at: at(8) })],
        { newEntries: [row('fresh', 0, 510, { scored_at: at(0) })], evaluated: ['fresh'] }
      );
      expect(names(board)).toEqual(['fresh']);
      expect(removed).toEqual([{ username: 'frozen', batch_index: 9, reason: 'unmeasured' }]);
    });

    it('keeps carried and other rows meanwhile, up to the day itself', () => {
      const { board } = merge(
        [
          row('seen', 0, 500),
          row('carried', 0, 400, { scored_at: at(2) }),
          row('six-days', 9, 300, { scored_at: at(6) }),
          row('seven-days', 9, 200, { scored_at: at(UNMEASURED_AFTER_DAYS) })
        ],
        { newEntries: [row('seen', 0, 510)], evaluated: ['seen'] }
      );
      expect(names(board)).toEqual(['seen', 'carried', 'six-days', 'seven-days']);
      expect(board.leaderboard.find((d) => d.username === 'carried').missed_runs).toBe(1);
    });

    it('keeps rows that predate scored_at until their batch re-runs', () => {
      const { board } = merge([row('legacy', 9, 300)], {});
      expect(names(board)).toEqual(['legacy']);
    });
  });

  it(`names who falls below the ${MAX_DEVELOPERS} cap`, () => {
    const existing = Array.from({ length: MAX_DEVELOPERS }, (_, i) => row(`u${i}`, 5, 10_000 - i));
    const { board, removed } = merge(existing, {
      newEntries: [row('new-1', 0, 20_000), row('new-2', 0, 19_000)]
    });
    expect(board.total_devs).toBe(MAX_DEVELOPERS);
    expect(removed.map((r) => [r.username, r.reason])).toEqual([
      [`u${MAX_DEVELOPERS - 2}`, 'displaced'],
      [`u${MAX_DEVELOPERS - 1}`, 'displaced']
    ]);
  });
});

describe('guardBoard', () => {
  const board = (rows) => ({
    last_updated: 'x',
    total_devs: rows.length,
    leaderboard: rows.map((d, i) => ({ ...d, rank: i + 1 }))
  });
  const previous = Array.from({ length: 100 }, (_, i) => row(`u${i}`, 0, 1000 - i));

  it('passes a board that verifies and accounts for everyone who left', () => {
    const next = board(previous.slice(0, 90));
    const removed = previous.slice(90).map((d) => ({ ...d, reason: 'ineligible' }));
    expect(guardBoard({ previous, board: next, removed, log: quiet }).unexplained).toEqual([]);
  });

  it(`refuses more than ${MAX_UNEXPLAINED_LOSS * 100}% leaving with no recorded reason`, () => {
    const next = board(previous.slice(0, 94));
    expect(() => guardBoard({ previous, board: next, removed: [], log: quiet })).toThrow(
      /6 of 100 developers would leave the board with no recorded reason/
    );
  });

  it('lets a small unexplained loss through, by name, so it can be found', () => {
    const warnings = [];
    const log = { log: () => {}, warn: (m) => warnings.push(m) };
    const next = board(previous.slice(0, 95));
    const result = guardBoard({ previous, board: next, removed: [], log });
    expect(result.unexplained).toHaveLength(5);
    expect(warnings.join('\n')).toMatch(/u95, u96, u97, u98, u99/);
  });

  it('refuses a board that fails verification', () => {
    const next = board(previous.slice(0, 2));
    next.leaderboard[1].username = 'U0';
    const removed = previous.slice(2).map((d) => ({ ...d, reason: 'ineligible' }));
    expect(() => guardBoard({ previous, board: next, removed, log: quiet })).toThrow(
      /fails verification .*more than once/
    );
  });

  it('accepts mixed model versions only during a migration', () => {
    const next = board([
      { ...row('a', 0, 10), model_version: '9.0.0' },
      { ...row('b', 1, 5), model_version: '8.0.0' }
    ]);
    const prev = next.leaderboard;
    expect(() => guardBoard({ previous: prev, board: next, removed: [], log: quiet })).toThrow(
      /2 model versions/
    );
    expect(() =>
      guardBoard({
        previous: prev,
        board: next,
        removed: [],
        allowMixedVersions: true,
        log: quiet
      })
    ).not.toThrow();
  });
});

describe('runBatch', () => {
  function memoryStore(payload, calls) {
    return {
      saved: null,
      async load() {
        calls.push('load');
        return payload ? { payload, source: 'memory' } : null;
      },
      async save(board, meta) {
        calls.push('save');
        this.saved = { board, meta };
        return { asset: { name: meta.name }, bytes: 1 };
      }
    };
  }
  const state = (rows) => ({ last_updated: at(1), total_devs: rows.length, leaderboard: rows });
  const existing = [row('a', 0, 500), row('b', 0, 400), row('c', 7, 300)];

  it('loads, measures, merges, guards, saves, then dispatches - in that order', async () => {
    const calls = [];
    const store = memoryStore(state(existing), calls);
    const result = await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: async ({ existing: seen }) => {
        calls.push('measure');
        expect(seen).toHaveLength(3);
        return { newEntries: [row('a', 0, 900)], evaluated: ['a', 'b'] };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return ['deploy.yml'];
      },
      name: 'state-1-1.json.gz',
      now: NOW,
      log: quiet
    });

    expect(calls).toEqual(['load', 'measure', 'save', 'dispatch']);
    expect(names(store.saved.board)).toEqual(['a', 'c']);
    expect(store.saved.meta).toEqual({
      name: 'state-1-1.json.gz',
      label: 'batch 0, 2 developers'
    });
    expect(result.removed).toEqual([{ username: 'b', batch_index: 0, reason: 'ineligible' }]);
    expect(result.dispatched).toEqual(['deploy.yml']);
  });

  it('records when this batch ran, and carries every other batch run forward', async () => {
    const calls = [];
    const earlier = { 7: { at: at(1), measured: 3, complete: true } };
    const store = memoryStore({ ...state(existing), batch_runs: earlier }, calls);
    await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: async () => ({
        newEntries: [row('a', 0, 900)],
        evaluated: ['a', 'b'],
        discoveryComplete: false
      }),
      now: NOW,
      log: quiet
    });
    expect(store.saved.board.batch_runs).toEqual({
      ...earlier,
      0: { at: new Date(NOW).toISOString(), measured: 1, complete: false }
    });
  });

  it('saves nothing and dispatches nothing when a guard refuses', async () => {
    const calls = [];
    const store = memoryStore(state(existing), calls);
    await expect(
      runBatch({
        registry: noIntents,
        batchIndex: 0,
        store,
        // A versioned row that cannot be recomputed: the board fails verification.
        measure: async () => ({
          newEntries: [row('a', 0, 900, { model_version: SCORE_CONFIG.MODEL_VERSION })]
        }),
        dispatch: async () => calls.push('dispatch'),
        now: NOW,
        log: quiet
      })
    ).rejects.toThrow(/Refusing to save/);
    expect(calls).toEqual(['load']);
    expect(store.saved).toBeNull();
  });

  it("passes the measurement's discovery completeness to the merge", async () => {
    const calls = [];
    const store = memoryStore(
      state([row('a', 0, 500), row('gone', 0, 400, { missed_runs: 1, missed_since: at(2) })]),
      calls
    );
    const result = await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: async () => ({
        newEntries: [row('a', 0, 510)],
        evaluated: ['a'],
        discoveryComplete: false
      }),
      name: 'state-1-1.json.gz',
      now: NOW,
      log: quiet
    });
    // Two misses over two days would remove `gone`; a short search freezes it.
    expect(result.removed).toEqual([]);
    expect(store.saved.board.leaderboard.find((d) => d.username === 'gone').missed_runs).toBe(1);
  });

  it('seeds a never-saved store from the fallback, once', async () => {
    const calls = [];
    const store = memoryStore(null, calls);
    const fallback = { load: async () => ({ payload: state(existing), source: 'data.json' }) };
    await runBatch({
      registry: noIntents,
      batchIndex: 7,
      store,
      fallback,
      measure: async () => ({ newEntries: [row('c', 7, 350)], evaluated: ['c'] }),
      now: NOW,
      log: quiet
    });
    expect(names(store.saved.board)).toEqual(['a', 'b', 'c']);
  });

  it('refuses to start from nothing, which would publish one batch as the board', async () => {
    const calls = [];
    await expect(
      runBatch({
        registry: noIntents,
        batchIndex: 0,
        store: memoryStore(null, calls),
        fallback: { load: async () => null },
        measure: async () => {
          calls.push('measure');
          return { newEntries: [row('a', 0, 1)] };
        },
        now: NOW,
        log: quiet
      })
    ).rejects.toThrow(/No saved state and nothing to seed it from/);
    expect(calls).toEqual(['load']);
  });

  it('never seeds over a store that has state it cannot read', async () => {
    let seeded = false;
    await expect(
      runBatch({
        registry: noIntents,
        batchIndex: 0,
        store: {
          load: async () => {
            throw new Error('None of the newest 5 state assets could be read');
          }
        },
        fallback: {
          load: async () => {
            seeded = true;
            return null;
          }
        },
        measure: async () => ({ newEntries: [] }),
        log: quiet
      })
    ).rejects.toThrow(/could be read/);
    expect(seeded).toBe(false);
  });

  it('reports a failed dispatch after the state is already saved', async () => {
    const calls = [];
    const store = memoryStore(state(existing), calls);
    await expect(
      runBatch({
        registry: noIntents,
        batchIndex: 0,
        store,
        measure: async () => ({ newEntries: existing.filter((d) => d.batch_index === 0) }),
        dispatch: async () => {
          throw new Error('could not dispatch deploy.yml');
        },
        name: 'state-1-1.json.gz',
        now: NOW,
        log: quiet
      })
    ).rejects.toThrow(/could not dispatch/);
    expect(store.saved).not.toBeNull();
  });

  it('stamps the board when it merges, not when the hour-long measurement began', async () => {
    const calls = [];
    const store = memoryStore(state(existing), calls);
    let clock = NOW;
    await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: async () => {
        clock += 50 * 60_000;
        return { newEntries: existing.filter((d) => d.batch_index === 0) };
      },
      now: () => clock,
      name: 'state-1-1.json.gz',
      log: quiet
    });
    expect(store.saved.board.last_updated).toBe(new Date(NOW + 50 * 60_000).toISOString());
  });

  it('takes the clock from the loaded board when asked, as the dry run does', async () => {
    const calls = [];
    const store = memoryStore(state([row('old', 0, 5, { scored_at: at(30) })]), calls);
    await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: replayBatch,
      now: (payload) => Date.parse(payload.last_updated) - 29 * DAY,
      name: 'state-1-1.json.gz',
      log: quiet
    });
    // Measured 30 days before NOW, judged one day after that: still on.
    expect(names(store.saved.board)).toEqual(['old']);
  });

  describe('registrations and opt-outs', () => {
    const avatar = (id) => `https://avatars.githubusercontent.com/u/${id}?v=4`;
    const board = [
      row('a', 0, 500, { github_id: 1 }),
      row('b', 0, 400, { avatar_url: avatar(2) }),
      row('c', 7, 300, { avatar_url: avatar(3) }),
      row('d', 7, 200, { github_id: 4, bio: 'untouched' })
    ];
    const intents = (over) => async () => ({ ...emptyRegistry(), ...over });

    it('removes an opted-out developer from another batch this run, and nobody else', async () => {
      const calls = [];
      const store = memoryStore(state(board), calls);
      let seen = null;
      const result = await runBatch({
        batchIndex: 0,
        store,
        registry: intents({ optedOut: new Set([3]) }),
        measure: async ({ existing }) => {
          seen = existing.map((d) => d.username);
          return { newEntries: [row('a', 0, 510, { github_id: 1 })], evaluated: ['a'] };
        },
        name: 'state-1-1.json.gz',
        now: NOW,
        log: quiet
      });
      // Batch 7 did not run, and its opted-out developer still left, with a reason.
      expect(seen).toEqual(['a', 'b', 'd']);
      expect(names(store.saved.board)).toEqual(['a', 'b', 'd']);
      expect(result.removed).toEqual([{ username: 'c', batch_index: 7, reason: 'opted_out' }]);
      expect(result.guard.unexplained).toEqual([]);
      // On neither list: carried as it was, apart from the rank the whole board is given.
      const { rank, ...d } = store.saved.board.leaderboard.find((r) => r.username === 'd');
      expect(rank).toBe(3);
      expect(d).toEqual(board[3]);
    });

    it('matches on the account id, so a renamed login cannot escape an opt-out', async () => {
      const store = memoryStore(state(board), []);
      const result = await runBatch({
        batchIndex: 0,
        store,
        registry: intents({ optedOut: new Set([1]) }),
        // The measurement found account 1 under a new login. It is still account 1.
        measure: async () => ({
          newEntries: [row('a-renamed', 0, 520, { github_id: 1 })],
          evaluated: ['a-renamed']
        }),
        name: 'state-1-1.json.gz',
        now: NOW,
        log: quiet
      });
      expect(names(store.saved.board)).toEqual(['b', 'c', 'd']);
      expect(result.removed).toEqual([{ username: 'a', batch_index: 0, reason: 'opted_out' }]);
    });

    it('stops before measuring or saving when the registry cannot be read', async () => {
      const calls = [];
      const store = memoryStore(state(board), calls);
      const lines = [];
      await expect(
        runBatch({
          batchIndex: 0,
          store,
          registry: async () => {
            throw new Error('GET /issues -> HTTP 502');
          },
          measure: async () => {
            calls.push('measure');
            return { newEntries: [] };
          },
          dispatch: async () => calls.push('dispatch'),
          now: NOW,
          log: { log: (m) => lines.push(m), warn: () => {} }
        })
      ).rejects.toThrow(/saves and publishes nothing: GET \/issues -> HTTP 502/);
      expect(calls).toEqual(['load']);
      expect(store.saved).toBeNull();
      expect(lines.some((l) => l.startsWith('::error title=REGISTRY_UNREADABLE::'))).toBe(true);
    });

    it('refuses to run with no registry reader at all', async () => {
      const calls = [];
      const store = memoryStore(state(board), calls);
      await expect(
        runBatch({
          batchIndex: 0,
          store,
          measure: async () => ({ newEntries: [] }),
          now: NOW,
          log: quiet
        })
      ).rejects.toThrow(/no registry reader/);
      expect(store.saved).toBeNull();
    });

    it('hands the registry to the measurement, and merges a registered developer it measured', async () => {
      const store = memoryStore(state(board), []);
      const registered = [{ id: 9, nodeId: 'U_9', login: 'reg', issueNumber: 1, at: at(1) }];
      const result = await runBatch({
        batchIndex: 0,
        store,
        registry: intents({ registered }),
        measure: async ({ registry }) => {
          expect(registry.registered).toEqual(registered);
          return {
            newEntries: [
              row('a', 0, 500, { github_id: 1 }),
              row('b', 0, 400, { avatar_url: avatar(2) }),
              row('reg', 0, 450, { github_id: 9, discovery_source: 'registered' })
            ],
            evaluated: ['a', 'b', 'reg']
          };
        },
        name: 'state-1-1.json.gz',
        now: NOW,
        log: quiet
      });
      expect(names(store.saved.board)).toEqual(['a', 'reg', 'b', 'c', 'd']);
      const reg = store.saved.board.leaderboard.find((r) => r.username === 'reg');
      expect(reg).toMatchObject({ batch_index: 0, github_id: 9, discovery_source: 'registered' });
      expect(result.removed).toEqual([]);
    });
  });
});

describe('reownRows', () => {
  // Noon on the first day of a batch's range in the current table.
  const createdIn = (batch) => `${BATCH_RANGES[batch].from}T12:00:00Z`;

  it('gives each row the batch whose range holds its created_at, and counts who moved', () => {
    const stays = row('stays', 5, 1, { created_at: createdIn(5) });
    const { rows, moved } = reownRows([
      stays,
      row('moves', 23, 1, { created_at: createdIn(5) }),
      row('undated', 9, 1),
      row('unreadable', 9, 1, { created_at: 'not a date' })
    ]);
    expect(moved).toBe(1);
    expect(rows.map((r) => r.batch_index)).toEqual([5, 5, 9, 9]);
    // Unmoved rows are the same objects; a moved one is a copy with nothing else changed.
    expect(rows[0]).toBe(stays);
    expect(rows[1]).toEqual(row('moves', 5, 1, { created_at: createdIn(5) }));
  });

  it('lets the batch that now holds a row judge it, after the table changed', async () => {
    // Under the old table this developer belonged to batch 23. Batch 5 now searches their range,
    // fetched them, and they failed the gate: they must leave, not be kept as another batch's row.
    const store = {
      saved: null,
      async load() {
        return {
          payload: {
            last_updated: at(1),
            total_devs: 3,
            leaderboard: [
              row('moved', 23, 300, { created_at: createdIn(5) }),
              row('measured', 5, 250, { created_at: createdIn(5) }),
              row('other', 23, 200, { created_at: createdIn(23) })
            ]
          },
          source: 'memory'
        };
      },
      async save(board) {
        this.saved = board;
        return { asset: { name: 'x' }, bytes: 1 };
      }
    };
    const lines = [];
    const result = await runBatch({
      registry: noIntents,
      batchIndex: 5,
      store,
      measure: async () => ({
        newEntries: [row('measured', 5, 260, { created_at: createdIn(5) })],
        evaluated: ['moved', 'measured']
      }),
      now: NOW,
      log: { log: (l) => lines.push(l), warn: () => {} }
    });
    expect(result.removed).toEqual([{ username: 'moved', batch_index: 5, reason: 'ineligible' }]);
    expect(names(store.saved)).toEqual(['measured', 'other']);
    expect(lines.some((l) => /^Ownership: 1 row\(s\) moved/.test(l))).toBe(true);
  });
});

describe('evaluatedLogins', () => {
  const fetched = {
    developers: [{ username: 'Active' }],
    screenedOut: ['quiet'],
    locationRejected: [{ username: 'abroad', location: 'Hyderabad, India', reason: 'india' }]
  };

  it('counts the fetched, the screened out and the location-rejected as looked at', () => {
    expect(evaluatedLogins(fetched)).toEqual(['Active', 'quiet', 'abroad']);
    expect(evaluatedLogins({ developers: [] })).toEqual([]);
  });

  it('so a developer found by city name and ruled out on location leaves as ineligible', () => {
    const { board, removed } = merge(
      [row('Active', 0, 500), row('abroad', 0, 400), row('unseen', 0, 300)],
      {
        newEntries: [row('Active', 0, 510, { discovery_source: 'city' })],
        evaluated: evaluatedLogins(fetched),
        // One of the batch's two searches was short: the unseen are carried, not counted.
        discoveryComplete: false
      }
    );
    expect(removed).toEqual([{ username: 'abroad', batch_index: 0, reason: 'ineligible' }]);
    expect(names(board).sort()).toEqual(['Active', 'unseen']);
    expect(board.leaderboard.find((d) => d.username === 'unseen').missed_runs).toBeUndefined();
    expect(board.leaderboard.find((d) => d.username === 'Active').discovery_source).toBe('city');
  });
});

describe('replayBatch', () => {
  it("replays the batch's own rows as measured, without their miss counts", () => {
    const { newEntries, evaluated } = replayBatch({
      batchIndex: 3,
      existing: [row('a', 3, 1, { missed_runs: 1 }), row('b', 4, 2)]
    });
    expect(newEntries).toEqual([row('a', 3, 1)]);
    expect(evaluated).toEqual(['a']);
  });
});

describe('createFileStore', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-file-store-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads nothing from a missing file, and refuses a corrupt one', async () => {
    const file = path.join(dir, 'data.json');
    expect(await createFileStore({ readPath: file }).load()).toBeNull();
    fs.writeFileSync(file, '{"leaderboard": ');
    await expect(createFileStore({ readPath: file }).load()).rejects.toThrow();
    fs.writeFileSync(file, '{"rows": []}');
    await expect(createFileStore({ readPath: file }).load()).rejects.toThrow(/Refusing/);
  });

  it('runs the dry-run flow on the committed sample without changing who is on it', async () => {
    const out = path.join(dir, 'data.dry-run.json');
    const store = createFileStore({
      readPath: new URL('../fixtures/data.sample.json', import.meta.url).pathname,
      writePath: out
    });
    const before = (await store.load()).payload;
    await runBatch({
      registry: noIntents,
      batchIndex: 0,
      store,
      measure: replayBatch,
      allowEmpty: true,
      now: (payload) => Date.parse(payload.last_updated),
      log: quiet
    });
    const after = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(names(after)).toEqual(names(before));
    expect(after.last_updated).toBe(before.last_updated);
  });
});

describe('dispatchWorkflows', () => {
  // A client whose workflows are all active unless `states` says otherwise.
  function fakeClient(states = {}, { rejectDispatch = [] } = {}) {
    const calls = [];
    return {
      calls,
      json: async (method, route, { body } = {}) => {
        calls.push([method, route, body]);
        const workflow = /\/actions\/workflows\/([^/]+)/.exec(route)?.[1];
        if (method === 'GET') return { state: states[workflow] ?? 'active' };
        if (rejectDispatch.includes(workflow)) throw new Error('HTTP 403');
        return null;
      }
    };
  }

  it('checks each workflow is active, then dispatches it on main', async () => {
    const client = fakeClient();
    expect(await dispatchWorkflows({ client, log: quiet })).toEqual(DISPATCHED_WORKFLOWS);
    expect(client.calls).toEqual([
      ['GET', '/actions/workflows/deploy.yml', undefined],
      ['POST', '/actions/workflows/deploy.yml/dispatches', { ref: 'main' }],
      ['GET', '/actions/workflows/watchdog.yml', undefined],
      ['POST', '/actions/workflows/watchdog.yml/dispatches', { ref: 'main' }]
    ]);
  });

  it('fails the run when the watchdog has been disabled, after still dispatching the deploy', async () => {
    // GitHub disables a scheduled workflow after 60 days without repository
    // activity, and a disabled watchdog cannot report itself. This failure is
    // what reaches the owner instead.
    const client = fakeClient({ 'watchdog.yml': 'disabled_inactivity' });
    const lines = [];
    await expect(
      dispatchWorkflows({ client, log: { log: (m) => lines.push(m), warn: () => {} } })
    ).rejects.toThrow(/could not dispatch watchdog\.yml \(it is `disabled_inactivity`/);
    expect(client.calls.map(([m, r]) => `${m} ${r}`)).toEqual([
      'GET /actions/workflows/deploy.yml',
      'POST /actions/workflows/deploy.yml/dispatches',
      'GET /actions/workflows/watchdog.yml'
    ]);
    expect(lines.some((l) => l.startsWith('::error title=DISPATCH_FAILED::'))).toBe(true);
  });

  it('tries every workflow before failing, so one rejection does not cost the other', async () => {
    const client = fakeClient({}, { rejectDispatch: ['deploy.yml'] });
    await expect(dispatchWorkflows({ client, log: quiet })).rejects.toThrow(
      /state is saved, but could not dispatch deploy\.yml \(HTTP 403\)/
    );
    expect(client.calls.filter(([m]) => m === 'POST')).toHaveLength(2);
  });
});
