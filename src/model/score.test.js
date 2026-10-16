import { describe, it, expect, vi } from 'vitest';
import rawConfig from '../../score-config.json' with { type: 'json' };
import { DERIVED_KEYS, SCORE_CONFIG, ScoreConfigError, validateScoreConfig } from './config.js';
import {
  deriveEvidence,
  REASON_AHEAD,
  REASON_BOT,
  REASON_FUTURE,
  REASON_LEAD
} from './evidence.js';
import {
  publishedScoreFields,
  recencyWeight,
  recomputePublished,
  rejectionFactor,
  scoreEvidence,
  scoreFromParts,
  scoreModel,
  starWeight
} from './score.js';
import { assignRanks, boardOrder, cutAtLimit } from './order.js';
import { referenceScore } from './__fixtures__/score-v3-reference.js';
import {
  FLAG_FORK,
  FLAG_ORG,
  FLAG_OWNED,
  FLAG_PROFILE,
  KIND_BOT,
  KIND_ORG,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  OUTCOME_OPEN,
  SHAPE_VERSION,
  decodeMeasurement,
  encodeMeasurement,
  measurementWindow
} from './measurement.js';

const W = measurementWindow(Date.parse('2026-10-14T09:30:00Z'));
const ME = 'ana';
const veteran = (login) => ({ login, kind: KIND_USER, created: '2015-01-01' });
const org = (login) => ({ login, kind: KIND_ORG, created: '2016-01-01' });

/** A readable measurement: nothing in it unless given. */
function measurement(overrides = {}) {
  return {
    version: SHAPE_VERSION,
    measured_at: '2026-10-14T09:30:00Z',
    login: ME,
    github_id: 7,
    window: { from: W.from, to: W.to },
    restricted: 0,
    commits: [],
    pull_requests: [],
    issues: [],
    reviews: [],
    accepted: [],
    maintained: [],
    future_repos: [],
    integrity: [],
    cut: 0,
    ...overrides
  };
}
const ownRepo = (
  days,
  { repo = `${ME}/app`, stars = 0, flags = FLAG_OWNED, commits = 1 } = {}
) => ({
  repo,
  flags,
  stars,
  days: days.map((day) => ({ day, commits }))
});
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
const merge = (repo, stars, items) => ({
  repo,
  flags: FLAG_ORG,
  stars,
  owner: org(repo.split('/')[0]),
  items
});
const mergeItem = (day, number, merger = veteran('maint'), { lines = 40, files = 3 } = {}) => ({
  day,
  number,
  merger,
  lines,
  files
});

const score = (m, options) => scoreEvidence(deriveEvidence(m, options), options);

// ---------------------------------------------------------------------------------------------
// Config

describe('config', () => {
  const clone = () => JSON.parse(JSON.stringify(rawConfig));

  it('accepts the shipped file, frozen', () => {
    expect(SCORE_CONFIG.MODEL_VERSION).toBe('3.0.0');
    expect(Object.isFrozen(SCORE_CONFIG.COLLABORATION)).toBe(true);
  });

  it('names a missing key', () => {
    const c = clone();
    delete c.COLLABORATION.HALF_POINT;
    expect(() => validateScoreConfig(c)).toThrow(/missing required key `COLLABORATION.HALF_POINT`/);
  });

  it('rejects every key of the previous model as unknown', () => {
    for (const [key, value] of [
      ['STAR_WEIGHT', 2],
      ['MAX_FOLLOWERS_FOR_SCORING', 500],
      ['AGE_PENALTY_MULTIPLIER', 0.5],
      ['ACTIVITY_SCORING', {}]
    ]) {
      expect(() => validateScoreConfig({ ...clone(), [key]: value })).toThrow(/unknown key/);
    }
  });

  it('refuses a constant without a derivation, and a derivation for nothing', () => {
    const c = clone();
    delete c.DERIVATIONS['COLLABORATION.TINY_WEIGHT'];
    expect(() => validateScoreConfig(c)).toThrow(/has no derivation/);
    const d = clone();
    d.DERIVATIONS.FOLLOWERS = 'because';
    expect(() => validateScoreConfig(d)).toThrow(/not a constant the model reads/);
    expect(DERIVED_KEYS.every((key) => typeof rawConfig.DERIVATIONS[key] === 'string')).toBe(true);
  });

  it("checks the weights sum to 1 and the window is the measurement's", () => {
    const c = clone();
    c.WEIGHTS.work = 0.49;
    expect(() => validateScoreConfig(c)).toThrow(/sum to 1/);
    const d = clone();
    d.WINDOW_DAYS = 28;
    expect(() => validateScoreConfig(d)).toThrow(/measurement covers 30 days/);
  });

  it('rejects malformed values with the key named', () => {
    const c = clone();
    c.RECENCY_FLOOR = 0;
    try {
      validateScoreConfig(c);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ScoreConfigError);
      expect(error.key).toBe('RECENCY_FLOOR');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The parts

describe('the curve and the weights', () => {
  it('weighs yesterday 1 and the oldest day RECENCY_FLOOR, evenly between', () => {
    expect(recencyWeight(29, SCORE_CONFIG)).toBe(1);
    expect(recencyWeight(0, SCORE_CONFIG)).toBe(0.5);
    expect(recencyWeight(14.5, SCORE_CONFIG)).toBeCloseTo(0.75, 12);
  });

  it('weighs a target by the digits of its stars', () => {
    expect(starWeight(0, SCORE_CONFIG)).toBeCloseTo(0.1, 12);
    expect(starWeight(9, SCORE_CONFIG)).toBeCloseTo(0.4, 12);
    expect(starWeight(99, SCORE_CONFIG)).toBeCloseTo(0.7, 12);
    expect(starWeight(999, SCORE_CONFIG)).toBeCloseTo(1, 12);
    expect(starWeight(500000, SCORE_CONFIG)).toBe(1);
  });

  it('lets a few rejections cost nothing and a mostly-rejected spray shrink', () => {
    expect(rejectionFactor({ merged: 0, closed: 0 }, SCORE_CONFIG)).toBe(1);
    expect(rejectionFactor({ merged: 5, closed: 2 }, SCORE_CONFIG)).toBe(1);
    expect(rejectionFactor({ merged: 59, closed: 120 }, SCORE_CONFIG)).toBeCloseTo(
      (2 * 61) / 183,
      12
    );
  });

  it('gives every working day of the window a perfect work score, and half the window three quarters', () => {
    expect(score(measurement({ commits: [ownRepo(range(0, 30))] })).parts.work).toBe(1);
    // Fifteen days spread evenly over the window weigh exactly half of it.
    const evens = range(0, 30).filter((d) => d % 2 === 0);
    const odds = range(0, 30).filter((d) => d % 2 === 1);
    const a = score(measurement({ commits: [ownRepo(evens)] })).details.x;
    const b = score(measurement({ commits: [ownRepo(odds)] })).details.x;
    expect(a + b).toBeCloseTo(1, 12);
  });
});

// ---------------------------------------------------------------------------------------------
// What counts

describe('what counts as a working day', () => {
  const days = (m) => deriveEvidence(m).working_days.length;

  it('counts a day once, one commit or a million', () => {
    expect(days(measurement({ commits: [ownRepo([3], { commits: 1 })] }))).toBe(1);
    expect(days(measurement({ commits: [ownRepo([3], { commits: 1028906 })] }))).toBe(1);
    const one = score(measurement({ commits: [ownRepo([3], { commits: 1 })] }));
    const farm = score(measurement({ commits: [ownRepo([3], { commits: 1028906 })] }));
    expect(farm.score_exact).toBe(one.score_exact);
  });

  it("never counts forks or profile README repositories, anyone's", () => {
    expect(days(measurement({ commits: [ownRepo([1], { flags: FLAG_OWNED | FLAG_FORK })] }))).toBe(
      0
    );
    expect(
      days(
        measurement({
          commits: [ownRepo([1], { repo: 'ana/ana', flags: FLAG_OWNED | FLAG_PROFILE })]
        })
      )
    ).toBe(0);
    // Someone else's profile repository, written to daily by a bot (seen on the board).
    expect(
      days(measurement({ commits: [ownRepo([1], { repo: 'mash/mash', flags: FLAG_PROFILE })] }))
    ).toBe(0);
  });

  it("counts pull requests and issues only in other people's repositories, and no rejected one", () => {
    const m = measurement({
      pull_requests: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          items: range(0, 30).map((d) => ({ day: d, number: d + 1, outcome: OUTCOME_MERGED }))
        },
        {
          repo: 'acme/lib',
          flags: FLAG_ORG,
          items: [
            { day: 2, number: 1, outcome: OUTCOME_OPEN },
            { day: 3, number: 2, outcome: OUTCOME_CLOSED }
          ]
        }
      ],
      issues: [{ repo: 'ana/app', flags: FLAG_OWNED, items: [{ day: 9, number: 1 }] }]
    });
    // 1,107 self-merged pull requests in one's own repositories make no working day by themselves.
    expect(deriveEvidence(m).working_days).toEqual([
      W.from.slice(0, 8) + String(16).padStart(2, '0')
    ]);
  });

  it("counts a review of another user's pull request, not of one's own or a bot's", () => {
    const m = measurement({
      reviews: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          stars: 0,
          items: [
            { day: 1, number: 1, author: { login: 'ANA', kind: KIND_USER, created: '2015-01-01' } },
            { day: 2, number: 2, author: { login: 'dependabot', kind: KIND_BOT, created: null } },
            { day: 3, number: 3, author: null },
            { day: 4, number: 4, author: veteran('carl') }
          ]
        }
      ]
    });
    expect(days(m)).toBe(1);
  });
});

describe('integrity', () => {
  const sample = (repo, extra) => ({
    repo,
    sampled: 20,
    bot: 0,
    max_lead_hours: 0,
    max_ahead_hours: -10,
    ...extra
  });
  const excludedBy = (m) => deriveEvidence(m).excluded;

  it('excludes the commits of a repository with impossible dates or a bot committer', () => {
    const commits = [ownRepo(range(0, 30), { repo: 'z/paint' }), ownRepo([5], { repo: 'z/real' })];
    for (const [extra, reason] of [
      [{ max_lead_hours: 21.8 }, REASON_LEAD],
      [{ max_ahead_hours: 8 }, REASON_AHEAD],
      [{ bot: 20 }, REASON_BOT]
    ]) {
      const m = measurement({ login: 'z', commits, integrity: [sample('z/paint', extra)] });
      expect(excludedBy(m)).toEqual([{ repo: 'z/paint', reason }]);
      expect(deriveEvidence(m).working_days).toHaveLength(1);
    }
  });

  it('excludes a repository holding commits dated in the future', () => {
    const m = measurement({ commits: [ownRepo(range(0, 30))], future_repos: ['ana/app'] });
    expect(excludedBy(m)).toEqual([{ repo: 'ana/app', reason: REASON_FUTURE }]);
    expect(score(m).score).toBe(0);
  });

  it('gives an honest sample, an unsampled repository and a little clock skew the benefit of the doubt', () => {
    const m = measurement({
      commits: [ownRepo([1, 2, 3])],
      integrity: [
        sample('ana/app', { max_lead_hours: 5.9, bot: 9 }),
        { repo: 'ana/x', sampled: 0, bot: 0, max_lead_hours: null, max_ahead_hours: null }
      ]
    });
    expect(excludedBy(m)).toEqual([]);
  });

  it('applies the moderation list, with its reason', () => {
    const m = measurement({ commits: [ownRepo(range(0, 30), { repo: 'ana/testrepo' })] });
    const e = deriveEvidence(m, {
      moderation: [{ repo: 'ana/testrepo', reason: 'commits every 10 minutes by a script' }]
    });
    expect(e.excluded).toEqual([
      { repo: 'ana/testrepo', reason: 'moderation: commits every 10 minutes by a script' }
    ]);
    expect(e.working_days).toEqual([]);
  });

  it('lists only the moderation entries for repositories the developer committed to', () => {
    const m = measurement({ commits: [ownRepo([1, 2, 3, 4], { repo: 'ana/app' })] });
    const e = deriveEvidence(m, {
      moderation: [
        { repo: 'someone/else', reason: 'a script' },
        { repo: 'Ana/App', reason: 'a cron' }
      ]
    });
    expect(e.excluded).toEqual([{ repo: 'Ana/App', reason: 'moderation: a cron' }]);
    expect(
      deriveEvidence(m, { moderation: [{ repo: 'someone/else', reason: 'a script' }] }).excluded
    ).toEqual([]);
  });
});

describe('collaboration', () => {
  const collab = (m) => score(m).details;

  it("counts a merge by another user of a year's standing, and nothing else", () => {
    const m = measurement({
      accepted: [
        merge('acme/lib', 1000, [
          mergeItem(29, 1),
          mergeItem(29, 2, { login: 'ana', kind: KIND_USER, created: '2015-01-01' }),
          mergeItem(29, 3, { login: 'mergify', kind: KIND_BOT, created: null }),
          mergeItem(29, 4, null),
          mergeItem(29, 5, { login: 'alt', kind: KIND_USER, created: '2026-09-20' })
        ])
      ]
    });
    expect(deriveEvidence(m).accepted.map((a) => a.number)).toEqual([1]);
    expect(collab(m).accepted).toBeCloseTo(1, 12);
  });

  it("judges the merger's age on the day of the merge, so time passing changes nothing", () => {
    // A merger 364 days old at the merge stays not old enough however late it is measured.
    const merger = { login: 'm', kind: KIND_USER, created: '2025-10-14' };
    const m = measurement({ accepted: [merge('acme/lib', 10, [mergeItem(29, 1, merger)])] });
    expect(deriveEvidence(m).accepted).toEqual([]);
  });

  it('lets no one owner and no one merger vouch without limit', () => {
    // One sock puppet merging 12 free organizations' pull requests.
    const many = range(0, 12).map((i) =>
      merge(
        `org${i}/x`,
        0,
        range(0, 10).map((d) => mergeItem(20 + (d % 10), d + 1, veteran('alt')))
      )
    );
    const puppet = collab(measurement({ accepted: many }));
    const cap = SCORE_CONFIG.COLLABORATION.CAP_PER_GROUP;
    expect(puppet.accepted).toBeLessThanOrEqual(cap);
    // One owner with a hundred merges by many people is capped the same way.
    const one = collab(
      measurement({
        accepted: [
          merge(
            'acme/lib',
            5000,
            range(0, 100).map((n) => mergeItem(25, n + 1, veteran(`m${n}`)))
          )
        ]
      })
    );
    expect(one.accepted).toBe(cap);
  });

  it('weighs a tiny change half', () => {
    const big = collab(measurement({ accepted: [merge('a/b', 1000, [mergeItem(29, 1)])] }));
    const tiny = collab(
      measurement({
        accepted: [merge('a/b', 1000, [mergeItem(29, 1, veteran('maint'), { lines: 2, files: 1 })])]
      })
    );
    expect(tiny.accepted).toBeCloseTo(Math.log2(1.5), 12);
    expect(big.accepted).toBeCloseTo(1, 12);
  });

  it('shrinks the accepted credit of a mostly-rejected spray', () => {
    const accepted = [merge('a/b', 1000, [mergeItem(29, 1)])];
    const spray = {
      repo: 'a/b',
      flags: FLAG_ORG,
      items: range(0, 30).map((d) => ({ day: d, number: 100 + d, outcome: OUTCOME_CLOSED }))
    };
    const clean = collab(measurement({ accepted }));
    const sprayed = collab(measurement({ accepted, pull_requests: [spray] }));
    expect(sprayed.c).toBeLessThan(clean.c / 4);
  });

  it('counts one pull request once however many times it was reviewed, at half a merge', () => {
    const items = range(0, 5).map((d) => ({ day: 25 + d, number: 1, author: veteran('carl') }));
    const m = measurement({ reviews: [{ repo: 'acme/lib', flags: FLAG_ORG, stars: 1000, items }] });
    expect(deriveEvidence(m).reviews).toHaveLength(1);
    expect(collab(m).reviews).toBeCloseTo(Math.log2(1.5), 12);
  });

  it("credits maintainers for other people's pull requests merged into their projects", () => {
    const m = measurement({
      maintained: [
        {
          repo: 'ana/app',
          flags: FLAG_OWNED,
          stars: 1000,
          items: [
            { day: 29, number: 1, author: veteran('carl'), lines: 50, files: 4 },
            {
              day: 29,
              number: 2,
              author: { login: 'dependabot', kind: KIND_BOT, created: null },
              lines: 50,
              files: 4
            }
          ]
        }
      ]
    });
    expect(collab(m).maintained).toBeCloseTo(Math.log2(1.5), 12);
  });

  it('gives half the collaboration points for three merges into well-known projects by three people this week', () => {
    const accepted = ['a/x', 'b/y', 'c/z'].map((repo, i) =>
      merge(repo, 5000, [mergeItem(29, 1, veteran(`m${i}`))])
    );
    expect(score(measurement({ accepted })).parts.collaboration).toBeCloseTo(0.5, 12);
  });
});

describe('appreciation', () => {
  const appreciation = (m) => score(m).parts.appreciation;

  it('starts at 10 stars and adds a third per tenfold', () => {
    const at = (stars) =>
      appreciation(measurement({ commits: [ownRepo([1, 2, 3, 4], { stars })] }));
    expect(at(9)).toBe(0);
    expect(at(10)).toBe(0);
    expect(at(100)).toBeCloseTo(1 / 3, 12);
    expect(at(1000)).toBeCloseTo(2 / 3, 12);
    expect(at(10000)).toBeCloseTo(1, 12);
    expect(at(10000000)).toBe(1);
  });

  it('needs work in the project this month, in full after four days', () => {
    expect(appreciation(measurement({ commits: [ownRepo([1], { stars: 10000 })] }))).toBeCloseTo(
      0.25,
      12
    );
    // Stars on someone else's repository, or on a fork, are not the developer's.
    expect(
      appreciation(
        measurement({
          commits: [ownRepo(range(0, 9), { repo: 'big/thing', flags: FLAG_ORG, stars: 141430 })]
        })
      )
    ).toBe(0);
    expect(
      appreciation(
        measurement({
          commits: [ownRepo(range(0, 9), { flags: FLAG_OWNED | FLAG_FORK, stars: 5000 })]
        })
      )
    ).toBe(0);
  });

  it('takes the best project, not a sum a star ring could spread', () => {
    const ring = range(0, 20).map((i) => ownRepo([1, 2, 3, 4], { repo: `ana/r${i}`, stars: 20 }));
    expect(appreciation(measurement({ commits: ring }))).toBeCloseTo((Math.log10(20) - 1) / 3, 12);
  });
});

// ---------------------------------------------------------------------------------------------
// Golden cases from the board

describe('golden cases', () => {
  const s = (m) => score(m).score;

  it('scores nothing as 0 and fails the gate', () => {
    const r = score(measurement());
    expect(r.score).toBe(0);
    expect(r.gate).toBe(false);
  });

  it('passes the gate at 4 working days, not 3', () => {
    expect(score(measurement({ commits: [ownRepo([1, 2, 3])] })).gate).toBe(false);
    expect(score(measurement({ commits: [ownRepo([1, 2, 3, 4])] })).gate).toBe(true);
  });

  it('caps a daily script at the work points, and keeps it within 56 of an honest regular', () => {
    const cron = s(measurement({ commits: [ownRepo(range(0, 30), { commits: 144 })] }));
    expect(cron).toBe(500);
    const regular = s(measurement({ commits: [ownRepo(range(0, 30).filter((d) => d % 3 !== 1))] }));
    expect(cron - regular).toBeLessThanOrEqual(56);
    expect(cron - regular).toBeGreaterThan(40);
  });

  it('puts a contributor working half the days, whose work others accept, above the daily script', () => {
    const cron = s(measurement({ commits: [ownRepo(range(0, 30))] }));
    const contributor = s(
      measurement({
        commits: [
          ownRepo(
            range(0, 30).filter((d) => d % 2 === 0),
            { repo: 'acme/lib', flags: FLAG_ORG }
          )
        ],
        accepted: [
          merge('acme/lib', 1200, [mergeItem(20, 1, veteran('a')), mergeItem(26, 2, veteran('b'))]),
          merge('beta/x', 300, [mergeItem(28, 3, veteran('c'))])
        ]
      })
    );
    expect(contributor).toBeGreaterThan(cron);
  });

  it('gives a student working most days in their own repositories a real score', () => {
    const student = score(
      measurement({ commits: [ownRepo(range(0, 30).filter((d) => d % 2 === 0))] })
    );
    expect(student.score).toBeGreaterThan(350);
    expect(student.gate).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties, over random measurements

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMeasurement(rand) {
  const pick = (n) => Math.floor(rand() * n);
  const some = (n, make) => Array.from({ length: pick(n + 1) }, (_, i) => make(i));
  const daysOf = () => [...new Set(some(12, () => pick(30)))].sort((a, b) => a - b);
  const person = () => ({
    login: `p${pick(6)}`,
    kind: rand() < 0.85 ? KIND_USER : KIND_BOT,
    created: rand() < 0.8 ? '2014-02-02' : '2026-09-01'
  });
  const flags = () => [0, FLAG_OWNED, FLAG_ORG, FLAG_OWNED | FLAG_FORK, FLAG_PROFILE][pick(5)];
  const repoName = (i) => `${['ana', 'acme', 'bob', 'zed'][pick(4)]}/r${i}`;
  const unique = (list) => {
    const seen = new Set();
    return list.filter((r) => (seen.has(r.repo) ? false : seen.add(r.repo)));
  };
  return measurement({
    commits: unique(
      some(5, (i) => {
        const name = repoName(i);
        return {
          repo: name,
          flags: name.startsWith('ana/') ? FLAG_OWNED : flags() & ~FLAG_OWNED,
          stars: [0, 3, 12, 150, 4000][pick(5)],
          days: daysOf().map((day) => ({ day, commits: 1 + pick(500) }))
        };
      })
    ),
    pull_requests: unique(
      some(3, (i) => ({
        repo: repoName(i),
        flags: flags(),
        items: some(4, (j) => ({ day: pick(30), number: j + 1, outcome: pick(3) }))
      }))
    ),
    issues: unique(
      some(2, (i) => ({
        repo: repoName(i),
        flags: flags(),
        items: some(3, (j) => ({ day: pick(30), number: j + 1 }))
      }))
    ),
    reviews: unique(
      some(3, (i) => {
        // A pull request has one author, whoever reviews it how often.
        const authors = [null, person(), person()];
        return {
          repo: repoName(i),
          flags: flags(),
          stars: [0, 40, 2000][pick(3)],
          items: some(4, () => {
            const number = pick(3);
            return { day: pick(30), number: number + 1, author: authors[number] };
          })
        };
      })
    ),
    accepted: unique(
      some(4, (i) => ({
        repo: `o${pick(5)}/x${i}`,
        flags: FLAG_ORG,
        stars: [0, 7, 90, 900, 90000][pick(5)],
        owner: org(`o${i}`),
        items: some(4, (j) => ({
          day: pick(30),
          number: j + 1,
          merger: rand() < 0.1 ? null : person(),
          lines: pick(200),
          files: pick(6)
        }))
      }))
    ),
    maintained: unique(
      some(2, (i) => ({
        repo: `ana/m${i}`,
        flags: FLAG_OWNED,
        stars: [0, 50, 3000][pick(3)],
        items: some(3, (j) => ({
          day: pick(30),
          number: j + 1,
          author: person(),
          lines: pick(50),
          files: pick(4)
        }))
      }))
    ),
    future_repos: rand() < 0.1 ? ['ana/r0'] : [],
    integrity:
      rand() < 0.2
        ? [
            {
              repo: 'ana/r1',
              sampled: 10,
              bot: pick(11),
              max_lead_hours: pick(20),
              max_ahead_hours: -pick(20)
            }
          ]
        : []
  });
}

/** A measurement as the pipeline would store it: encoded, so it is also well-formed. */
const stored = (m) => decodeMeasurement(encodeMeasurement(m));

describe('properties', () => {
  const rand = mulberry32(20261016);
  const samples = Array.from({ length: 20000 }, () => stored(randomMeasurement(rand)));

  it('every part is in [0, 1] and the score in [0, SCALE), for every sample', () => {
    for (const m of samples) {
      const r = score(m);
      for (const v of Object.values(r.parts)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(r.score_exact).toBeGreaterThanOrEqual(0);
      expect(r.score_exact).toBeLessThan(SCORE_CONFIG.SCALE);
      expect(r.score).toBe(Math.round(r.score_exact));
    }
  });

  it('matches the independent reference implementation on every sample', () => {
    for (const m of samples) {
      const r = score(m);
      const ref = referenceScore(m, SCORE_CONFIG);
      expect(r.parts.work).toBeCloseTo(ref.work, 10);
      expect(r.parts.collaboration).toBeCloseTo(ref.collaboration, 10);
      expect(r.parts.appreciation).toBeCloseTo(ref.appreciation, 10);
      expect(r.score_exact).toBeCloseTo(ref.exact, 8);
    }
  });

  it('never goes down when a working day is added', () => {
    for (const m of samples.slice(0, 3000)) {
      const before = score(m).score_exact;
      const day = (m.window && 29) - (m.commits.length % 30);
      const more = {
        ...m,
        commits: [
          ...m.commits,
          { repo: 'ana/new-work', flags: FLAG_OWNED, stars: 0, days: [{ day, commits: 1 }] }
        ]
      };
      expect(score(more).score_exact).toBeGreaterThanOrEqual(before);
    }
  });

  it('never goes down when another person accepts a pull request', () => {
    for (const m of samples.slice(0, 3000)) {
      const before = score(m).score_exact;
      const more = {
        ...m,
        accepted: [
          ...m.accepted,
          merge('fresh/repo', 100, [mergeItem(15, 1, veteran('someone-new'))])
        ]
      };
      expect(score(more).score_exact).toBeGreaterThanOrEqual(before);
    }
  });

  it('ignores volume: more commits on a counted day change nothing', () => {
    for (const m of samples.slice(0, 3000)) {
      const heavier = {
        ...m,
        commits: m.commits.map((r) => ({
          ...r,
          days: r.days.map((d) => ({ ...d, commits: d.commits * 1000 }))
        }))
      };
      expect(score(heavier).score_exact).toBe(score(m).score_exact);
    }
  });

  it('is pure: no clock, the same bits after a JSON round trip, whatever order the lists came in', () => {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the model read the clock');
    });
    try {
      for (const m of samples.slice(0, 3000)) {
        const a = scoreModel(encodeMeasurement(m));
        const b = scoreModel(JSON.parse(JSON.stringify(encodeMeasurement(m))));
        expect(b.score_exact).toBe(a.score_exact);
        const shuffled = {
          ...m,
          commits: [...m.commits].reverse(),
          accepted: [...m.accepted].reverse().map((r) => ({ ...r, items: [...r.items].reverse() })),
          reviews: [...m.reviews].reverse().map((r) => ({ ...r, items: [...r.items].reverse() }))
        };
        expect(score(shuffled).score_exact).toBe(a.score_exact);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('recomputes every published score exactly from its parts', () => {
    for (const m of samples.slice(0, 3000)) {
      const r = score(m);
      const row = { username: m.login, ...publishedScoreFields(r) };
      const back = recomputePublished(JSON.parse(JSON.stringify(row)));
      expect(back.score_exact).toBe(r.score_exact);
      expect(back.score).toBe(r.score);
    }
  });

  it('recomputes a score from the evidence it publishes', () => {
    for (const m of samples.slice(0, 2000)) {
      const r = score(m);
      const again = scoreEvidence(JSON.parse(JSON.stringify(r.evidence)));
      expect(again.score_exact).toBe(r.score_exact);
    }
  });
});

describe('published fields', () => {
  it('stamps the version, and dates the score by its measurement, not the clock', () => {
    const r = score(measurement({ commits: [ownRepo([1, 2, 3, 4])] }));
    const fields = publishedScoreFields(r);
    expect(fields).toMatchObject({ model_version: '3.0.0', scored_at: '2026-10-14T09:30:00Z' });
    expect(Object.keys(fields.score_parts)).toEqual(['work', 'collaboration', 'appreciation']);
  });

  it('refuses a row from another major version, or with parts out of range', () => {
    expect(() =>
      recomputePublished({ username: 'x', model_version: '2.0.0', score_parts: {} })
    ).toThrow(/scored by 2.0.0/);
    expect(() => scoreFromParts({ work: 1.2, collaboration: 0, appreciation: 0 })).toThrow(
      RangeError
    );
  });

  it('refuses a row with no measurement', () => {
    expect(() => scoreModel({ v: 1 })).toThrow(/no measurement/);
  });
});

// ---------------------------------------------------------------------------------------------
// Ranks

describe('board order and ranks', () => {
  const row = (username, github_id, score_exact) => ({ username, github_id, score_exact });

  it('ranks by the unrounded score, and equal scores share a rank', () => {
    const rows = [row('c', 3, 500), row('a', 1, 512.4), row('b', 2, 500), row('d', 4, 499.9)];
    const ranked = assignRanks([...rows].sort(boardOrder('2026-10-14')));
    expect(ranked.map((r) => [r.username, r.rank])).toEqual(
      expect.arrayContaining([
        ['a', 1],
        ['d', 4]
      ])
    );
    expect(
      ranked
        .filter((r) => r.rank === 2)
        .map((r) => r.username)
        .sort()
    ).toEqual(['b', 'c']);
  });

  it('rotates the order within a tie from day to day, not by the alphabet', () => {
    const tied = range(0, 12).map((i) => row(`u${i}`, 100 + i, 500));
    const firsts = new Set(
      ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].map(
        (seed) => [...tied].sort(boardOrder(seed))[0].username
      )
    );
    expect(firsts.size).toBeGreaterThan(1);
    // Any input order gives the same board for a seed.
    const a = [...tied].sort(boardOrder('s')).map((r) => r.username);
    const b = [...tied]
      .reverse()
      .sort(boardOrder('s'))
      .map((r) => r.username);
    expect(b).toEqual(a);
  });

  it('never splits a tie at the size limit', () => {
    const ranked = assignRanks(
      [row('a', 1, 9), row('b', 2, 8), row('c', 3, 8), row('d', 4, 8), row('e', 5, 1)].sort(
        boardOrder('s')
      )
    );
    expect(
      cutAtLimit(ranked, 2)
        .map((r) => r.username)
        .sort()
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(cutAtLimit(ranked, 10)).toHaveLength(5);
  });
});
