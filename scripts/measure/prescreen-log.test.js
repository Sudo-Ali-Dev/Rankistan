import { describe, it, expect } from 'vitest';
import {
  SCREEN_MIN_DAYS,
  comparePrescreen,
  prescreenStep,
  provisionalWorkingDays,
  sampleOrder
} from './prescreen-log.js';
import {
  FLAG_FORK,
  FLAG_OWNED,
  FLAG_PROFILE,
  KIND_BOT,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN
} from '../../src/model/measurement.js';

const empty = (overrides = {}) => ({
  login: 'ana',
  commits: [],
  pull_requests: [],
  issues: [],
  reviews: [],
  ...overrides
});

describe('provisionalWorkingDays', () => {
  it('counts a day once, however much was done on it', () => {
    const m = empty({
      commits: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          days: [
            { day: 1, commits: 1000000 },
            { day: 2, commits: 1 }
          ]
        },
        { repo: 'ana/lib', flags: FLAG_OWNED, days: [{ day: 2, commits: 5 }] }
      ]
    });
    expect(provisionalWorkingDays(m)).toBe(2);
  });

  it("ignores forks and profile repositories, anyone's", () => {
    const m = empty({
      commits: [
        { repo: 'ana/fork', flags: FLAG_OWNED | FLAG_FORK, days: [{ day: 1, commits: 1 }] },
        { repo: 'bob/bob', flags: FLAG_PROFILE, days: [{ day: 2, commits: 1 }] }
      ]
    });
    expect(provisionalWorkingDays(m)).toBe(0);
  });

  it("counts pull requests and issues only in other people's repositories, and no rejected pull request", () => {
    const m = empty({
      pull_requests: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          items: [{ day: 1, number: 1, outcome: OUTCOME_MERGED }]
        },
        {
          repo: 'acme/lib',
          flags: 0,
          items: [
            { day: 2, number: 2, outcome: OUTCOME_OPEN },
            { day: 3, number: 3, outcome: OUTCOME_CLOSED }
          ]
        }
      ],
      issues: [
        { repo: 'ana/app', flags: FLAG_OWNED, items: [{ day: 4, number: 1 }] },
        { repo: 'acme/lib', flags: 0, items: [{ day: 5, number: 2 }] }
      ]
    });
    expect(provisionalWorkingDays(m)).toBe(2);
  });

  it("counts reviews of another user's pull request only", () => {
    const m = empty({
      reviews: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          items: [
            { day: 1, number: 1, author: { login: 'Ana', kind: KIND_USER } },
            { day: 2, number: 2, author: { login: 'dependabot', kind: KIND_BOT } },
            { day: 3, number: 3, author: null },
            { day: 4, number: 4, author: { login: 'carl', kind: KIND_USER } }
          ]
        }
      ]
    });
    expect(provisionalWorkingDays(m)).toBe(1);
  });
});

describe('sampleOrder', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((username) => ({ username }));

  it('is fixed for a seed and owes nothing to the alphabet', () => {
    expect(sampleOrder(rows, 's1')).toEqual(sampleOrder([...rows].reverse(), 's1'));
    const orders = new Set(
      ['s1', 's2', 's3', 's4'].map((s) =>
        sampleOrder(rows, s)
          .map((r) => r.username)
          .join('')
      )
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('comparePrescreen', () => {
  it('finds board rows under the screen and passes the events screen did not fetch', () => {
    const counts = comparePrescreen({
      candidates: ['a', 'b', 'c', 'd'].map((username) => ({ username })),
      calendarDays: new Map([
        ['a', 5],
        ['b', 1],
        ['c', SCREEN_MIN_DAYS]
      ]),
      fullyFetched: ['a', 'b'],
      published: ['a', 'b']
    });
    expect(counts).toEqual({
      candidates: 4,
      read: 3,
      pass: 2,
      passNotFetched: ['c'],
      publishedUnder: ['b']
    });
  });
});

describe('prescreenStep', () => {
  it('never throws when GitHub cannot be reached, and says it read nothing', async () => {
    const lines = [];
    const client = {
      query: async () => {
        throw new TypeError('boom');
      },
      usage: () => ({ requests: 0, points: 0 }),
      sleep: async () => {}
    };
    const result = await prescreenStep({
      candidates: [{ id: 1, login: 'a' }],
      fullyFetched: [],
      published: [],
      client,
      now: Date.parse('2026-10-14T09:30:00Z'),
      log: { log: (l) => lines.push(l), warn: (l) => lines.push(l) }
    });
    expect(result.counts.read).toBe(0);
    expect(lines[0]).toMatch(
      /calendars of the 0 the board takes and 1 others sampled, read for 0 \(1 not read\)/
    );
  });

  it('does nothing without a client or candidates', async () => {
    expect(
      await prescreenStep({ candidates: [], fullyFetched: [], published: [], client: null, now: 0 })
    ).toBeNull();
  });
});
