import { describe, it, expect } from 'vitest';
import {
  FLAG_FORK,
  FLAG_ORG,
  FLAG_OWNED,
  FLAG_PROFILE,
  KIND_BOT,
  KIND_ORG,
  KIND_USER,
  NOBODY,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN,
  SHAPE_VERSION,
  WINDOW_DAYS,
  actorKind,
  addDays,
  commitDate,
  dayOffset,
  decodeMeasurement,
  encodeMeasurement,
  instantOffset,
  isMeasurement,
  measurementWindow,
  pktDate,
  repositoryFlags,
  searchMergedRange
} from './measurement.js';

const NOW = Date.parse('2026-10-14T09:30:00Z');
const W = measurementWindow(NOW);

describe('measurementWindow', () => {
  it('covers the 30 Pakistan dates before the measurement, half-open', () => {
    expect(W.from).toBe('2026-09-14');
    expect(W.to).toBe('2026-10-14');
    expect(addDays(W.from, WINDOW_DAYS)).toBe(W.to);
  });

  it('turns over at Pakistan midnight, not UTC midnight', () => {
    // 18:59:59Z is still the 14th in Pakistan; 19:00Z is the 15th.
    expect(measurementWindow(Date.parse('2026-10-14T18:59:59Z')).to).toBe('2026-10-14');
    expect(measurementWindow(Date.parse('2026-10-14T19:00:00Z')).to).toBe('2026-10-15');
    expect(measurementWindow(Date.parse('2026-10-14T00:30:00Z')).to).toBe('2026-10-14');
  });

  it('asks GitHub for a range that holds every instant and commit date of the window', () => {
    expect(W.query).toEqual({ from: '2026-09-13T19:00:00Z', to: '2026-10-13T23:59:59Z' });
    expect(W.instants.from).toBe(Date.parse('2026-09-13T19:00:00Z'));
    expect(W.instants.to).toBe(Date.parse('2026-10-13T19:00:00Z'));
  });

  it('probes for future commits from two days after the measurement, for a year', () => {
    expect(W.future).toEqual({ from: '2026-10-16T00:00:00Z', to: '2027-10-15T23:59:59Z' });
  });

  it('gives a search range to the second', () => {
    expect(searchMergedRange(W)).toBe('2026-09-13T19:00:00+00:00..2026-10-13T18:59:59+00:00');
  });

  it('refuses a measurement without a time', () => {
    expect(() => measurementWindow(undefined)).toThrow(TypeError);
  });
});

describe('dates', () => {
  it('puts an instant on its Pakistan date', () => {
    expect(pktDate('2026-10-13T18:59:59Z')).toBe('2026-10-13');
    expect(pktDate('2026-10-13T19:00:00Z')).toBe('2026-10-14');
  });

  it('keeps only instants whose Pakistan date is in the window', () => {
    expect(instantOffset('2026-09-13T18:59:59Z', W)).toBeNull();
    expect(instantOffset('2026-09-13T19:00:00Z', W)).toBe(0);
    expect(instantOffset('2026-10-13T18:59:59Z', W)).toBe(29);
    expect(instantOffset('2026-10-13T19:00:00Z', W)).toBeNull();
    expect(instantOffset('not a time', W)).toBeNull();
  });

  it('reads the date a commit contribution stands for', () => {
    expect(commitDate('2026-10-13T07:00:00Z')).toBe('2026-10-13');
    expect(commitDate('2026-10-13T08:00:00Z')).toBe('2026-10-13');
    expect(dayOffset('2026-09-13', W)).toBeNull();
    expect(dayOffset('2026-09-14', W)).toBe(0);
    expect(dayOffset('2026-10-13', W)).toBe(29);
    expect(dayOffset('2026-10-14', W)).toBeNull();
  });
});

describe('repositoryFlags', () => {
  const flags = (nameWithOwner, ownerType = 'User', isFork = false, login = 'ana') =>
    repositoryFlags({ nameWithOwner, ownerType, isFork }, login);

  it('marks ownership whatever the case', () => {
    expect(flags('Ana/app')).toBe(FLAG_OWNED);
    expect(flags('bob/app')).toBe(0);
  });

  it("marks forks, organizations and profile repositories, anyone's", () => {
    expect(flags('ana/app', 'User', true)).toBe(FLAG_OWNED | FLAG_FORK);
    expect(flags('acme/app', 'Organization')).toBe(FLAG_ORG);
    expect(flags('ana/ana')).toBe(FLAG_OWNED | FLAG_PROFILE);
    expect(flags('bob/Bob')).toBe(FLAG_PROFILE);
    // An organization named after itself has no profile README.
    expect(flags('acme/acme', 'Organization')).toBe(FLAG_ORG);
  });

  it('names actor kinds', () => {
    expect(actorKind('User')).toBe(KIND_USER);
    expect(actorKind('Bot')).toBe(KIND_BOT);
    expect(actorKind('Organization')).toBe(KIND_ORG);
    expect(actorKind('Mannequin')).toBe('X');
  });
});

const kgryte = { login: 'kgryte', kind: KIND_USER, created: '2012-01-01' };
const stdlib = { login: 'stdlib-js', kind: KIND_ORG, created: '2016-03-13' };
const newbie = { login: 'newbie', kind: KIND_USER, created: '2026-09-01' };

/** A readable measurement with something in every list. */
function sample() {
  return {
    version: SHAPE_VERSION,
    measured_at: '2026-10-14T09:30:00Z',
    login: 'ana',
    github_id: 7,
    window: { from: W.from, to: W.to },
    restricted: 12,
    commits: [
      { repo: 'ana/zeta', flags: FLAG_OWNED, stars: 3, days: [{ day: 2, commits: 5 }] },
      {
        repo: 'ana/app',
        flags: FLAG_OWNED,
        stars: 40,
        days: [
          { day: 0, commits: 1 },
          { day: 29, commits: 1000000 }
        ]
      }
    ],
    pull_requests: [
      {
        repo: 'stdlib-js/stdlib',
        flags: FLAG_ORG,
        items: [
          { day: 4, number: 9, outcome: OUTCOME_MERGED },
          { day: 1, number: 3, outcome: OUTCOME_CLOSED },
          { day: 4, number: 8, outcome: OUTCOME_OPEN }
        ]
      }
    ],
    issues: [{ repo: 'bob/lib', flags: 0, items: [{ day: 7, number: 1 }] }],
    reviews: [
      {
        repo: 'ana/app',
        flags: FLAG_OWNED,
        stars: 40,
        items: [
          { day: 3, number: 2, author: newbie },
          { day: 3, number: 4, author: null }
        ]
      }
    ],
    accepted: [
      {
        repo: 'stdlib-js/stdlib',
        flags: FLAG_ORG,
        stars: 6002,
        owner: stdlib,
        items: [{ day: 4, number: 9, merger: kgryte, lines: 120, files: 3 }]
      }
    ],
    maintained: [
      {
        repo: 'ana/app',
        flags: FLAG_OWNED,
        stars: 40,
        items: [{ day: 5, number: 6, author: newbie, lines: 2, files: 1 }]
      }
    ],
    future_repos: ['ana/zeta'],
    integrity: [{ repo: 'ana/app', sampled: 20, bot: 0, max_lead_hours: 0, max_ahead_hours: -3.5 }],
    cut: 0
  };
}

describe('the stored block', () => {
  it('round-trips through its compact form and through JSON', () => {
    const block = encodeMeasurement(sample());
    const back = decodeMeasurement(JSON.parse(JSON.stringify(block)));
    expect(encodeMeasurement(back)).toEqual(block);
    expect(back.accepted[0].items[0].merger).toEqual(kgryte);
    expect(back.reviews[0].items[1].author).toBeNull();
    expect(isMeasurement(block)).toBe(true);
  });

  it('encodes equal measurements to equal bytes, whatever order the lists came in', () => {
    const a = sample();
    const b = sample();
    b.commits.reverse();
    b.pull_requests[0].items.reverse();
    b.reviews[0].items.reverse();
    expect(JSON.stringify(encodeMeasurement(b))).toBe(JSON.stringify(encodeMeasurement(a)));
  });

  it('lists each person once, by login, and refers to them by index', () => {
    const block = encodeMeasurement(sample());
    expect(block.pp.map((p) => p[0])).toEqual(['kgryte', 'newbie', 'stdlib-js']);
    expect(block.ac[0][3]).toBe(2);
    expect(block.rv[0][3]).toEqual([3, 2, 1, 3, 4, NOBODY]);
  });

  it('is positional and flat', () => {
    const block = encodeMeasurement(sample());
    expect(block.cr[0]).toEqual(['ana/app', FLAG_OWNED, 40, [0, 1, 29, 1000000]]);
    expect(block.pr[0][2]).toEqual([
      1,
      3,
      OUTCOME_CLOSED,
      4,
      8,
      OUTCOME_OPEN,
      4,
      9,
      OUTCOME_MERGED
    ]);
  });

  it('decodes anything else to null rather than guessing', () => {
    const good = encodeMeasurement(sample());
    expect(decodeMeasurement(null)).toBeNull();
    expect(decodeMeasurement({ v: 1, at: 'x' })).toBeNull();
    expect(decodeMeasurement({ ...good, w: ['2026-09-14', '2026-10-13'] })).toBeNull();
    expect(
      decodeMeasurement({ ...good, ac: [[...good.ac[0].slice(0, 3), 9, good.ac[0][4]]] })
    ).toBeNull();
    expect(decodeMeasurement({ ...good, pr: [['x/y', 0, [0, 1, 7]]] })).toBeNull();
    expect(decodeMeasurement({ ...good, cr: [['x/y', 0, 0, [30, 1]]] })).toBeNull();
    expect(decodeMeasurement({ ...good, cr: [['x/y', 0, 0, [3]]] })).toBeNull();
    expect(decodeMeasurement({ ...good, pp: [['a', 'Q', null]] })).toBeNull();
  });
});
