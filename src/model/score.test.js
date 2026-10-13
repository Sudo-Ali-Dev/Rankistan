import { describe, it, expect, vi, afterEach } from 'vitest';
import { SCORE_CONFIG, MODEL_VERSION, validateScoreConfig } from './config.js';
import {
  scoreModel,
  publishedScoreFields,
  recomputePublished,
  scoreFromPublished,
  MODEL_INPUT_FIELDS
} from './score.js';
import { computeDeveloperScoreBreakdown } from '../utils/score-breakdown.js';
import {
  calculateDeveloperScore as legacyCalculateDeveloperScore,
  computeActivityScore30d as legacyActivityScore,
  computeDeveloperScoreBreakdown as legacyBreakdown,
  LEGACY_CONFIG
} from './__fixtures__/score-v2-legacy.js';

const DAY = 24 * 60 * 60 * 1000;
// Fixed, and deliberately not on a day boundary.
const NOW = Date.UTC(2026, 9, 13, 12, 34, 56, 789);

// Seeded so a failure reproduces.
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

const MEANINGFUL = ['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'ReleaseEvent'];
const NOISE = ['WatchEvent', 'ForkEvent', 'IssueCommentEvent', 'CreateEvent', 'DeleteEvent'];

function makeGenerator(seed) {
  const rand = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;

  // Around the cap, at zero, across the range, and a long tail.
  function count(cap) {
    const r = rand();
    if (r < 0.3) return Math.max(0, cap + int(-3, 3));
    if (r < 0.4) return 0;
    if (r < 0.8) return int(0, cap * 2);
    return Math.floor(Math.exp(rand() * Math.log(100000)));
  }

  // GitHub writes timestamps without milliseconds; the pipeline's own are
  // toISOString(). Both shapes, so parsing is exercised either way.
  function iso(ms) {
    const s = new Date(ms).toISOString();
    return chance(0.5) ? s.replace(/\.\d{3}Z$/, 'Z') : s;
  }

  function createdAt() {
    const r = rand();
    const boundary = NOW - SCORE_CONFIG.SIX_MONTHS_DAYS * DAY;
    // Straddle the age-penalty boundary to the millisecond.
    if (r < 0.25) {
      const offset = pick([-DAY, -1000, -1, 0, 1, 1000, DAY, int(-2 * DAY, 2 * DAY)]);
      return new Date(boundary + offset).toISOString();
    }
    if (r < 0.28) return iso(NOW + int(0, 10 * DAY)); // clock skew: a "future" account
    return iso(NOW - int(DAY, 15 * 365 * DAY));
  }

  function eventAt(ms, type) {
    return { type, created_at: iso(ms), repo: { name: 'o/r' } };
  }

  function events() {
    const shape = rand();
    const list = [];

    if (shape < 0.05) return list;

    // Bursts: many events of one type on one UTC day, past every cap and past
    // the push counting limit.
    if (shape < 0.35) {
      const days = int(1, 6);
      for (let d = 0; d < days; d += 1) {
        const dayStart = Math.floor((NOW - int(0, 35) * DAY) / DAY) * DAY;
        const type = pick(MEANINGFUL);
        const n = int(10, 80);
        for (let k = 0; k < n; k += 1) list.push(eventAt(dayStart + int(0, DAY - 1), type));
      }
    }

    const n = shape < 0.6 ? int(1, 40) : int(40, 300);
    for (let k = 0; k < n; k += 1) {
      const r = rand();
      const type = r < 0.8 ? pick(MEANINGFUL) : pick(NOISE);
      let ms;
      const where = rand();
      if (where < 0.05) {
        // The 30-day window edge, to the millisecond.
        ms = NOW - 30 * DAY + pick([-1, 0, 1]);
      } else if (where < 0.12) {
        // Either side of UTC midnight.
        ms = Math.floor((NOW - int(0, 29) * DAY) / DAY) * DAY + pick([-1, 0, 1, -1000, 1000]);
      } else if (where < 0.14) {
        ms = NOW + int(1, 2 * DAY);
      } else {
        ms = NOW - int(0, 60 * DAY);
      }
      list.push(eventAt(ms, type));
    }

    if (chance(0.02)) list.push({ type: 'PushEvent', created_at: 'not-a-date' });
    if (chance(0.02)) list.push({ type: 'PushEvent' });
    if (chance(0.02)) list.push(null);

    // Arrival order matters to floating-point summation; shuffle so the
    // test is not only ever seeing sorted feeds.
    if (chance(0.5)) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    return list;
  }

  // As scripts/fetch-devs.js computes it, so the legacy code sees what it
  // saw in production when the event list is empty.
  function eventCounts(list) {
    const counts = { pushes: 0, prs: 0, issues: 0, releases: 0 };
    for (const e of list) {
      if (!e || !MEANINGFUL.includes(e.type)) continue;
      if (NOW - new Date(e.created_at).getTime() > 30 * DAY) continue;
      if (e.type === 'PushEvent') counts.pushes++;
      if (e.type === 'PullRequestEvent') counts.prs++;
      if (e.type === 'IssuesEvent') counts.issues++;
      if (e.type === 'ReleaseEvent') counts.releases++;
    }
    return counts;
  }

  return function developer(i) {
    const raw = events();
    return {
      username: `dev-${i}`,
      total_stars: count(SCORE_CONFIG.MAX_STARS_FOR_SCORING),
      followers: count(SCORE_CONFIG.MAX_FOLLOWERS_FOR_SCORING),
      public_repos: count(SCORE_CONFIG.MAX_PUBLIC_REPOS_FOR_SCORING),
      created_at: createdAt(),
      raw_events_60d: raw,
      event_counts_30d: eventCounts(raw),
      events_30d: 0
    };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('differential: scoreModel against the pre-change implementation', () => {
  const N = 12000;
  // Tens of thousands of events through two implementations; the default 5s
  // is not a statement about this test.
  const TIMEOUT_MS = 120000;
  const developer = makeGenerator(0x5eed2026);
  const developers = Array.from({ length: N }, (_, i) => developer(i));

  it(
    `agrees exactly with the old calculateDeveloperScore on ${N} synthetic developers`,
    () => {
      // The old code read the clock itself; pin it to the same instant.
      vi.spyOn(Date, 'now').mockReturnValue(NOW);

      const mismatches = [];
      const seen = { penalised: 0, unpenalised: 0, starsCapped: 0, emptyFeed: 0, roundsAtHalf: 0 };

      for (const dev of developers) {
        const legacy = legacyCalculateDeveloperScore(dev);
        const result = scoreModel(dev, { config: SCORE_CONFIG, now: NOW });

        if (
          result.score !== legacy.score ||
          result.age_penalty_applied !== legacy.age_penalty_applied
        ) {
          mismatches.push({ username: dev.username, legacy, model: result.score });
        }

        // The activity term itself, bit for bit, on the branch the old code took.
        const legacyActivity =
          dev.raw_events_60d.length > 0
            ? legacyActivityScore(dev.raw_events_60d, { config: LEGACY_CONFIG, now: NOW })
            : 0;
        if (!Object.is(result.activity_score, legacyActivity)) {
          mismatches.push({
            username: dev.username,
            legacyActivity,
            modelActivity: result.activity_score
          });
        }

        if (result.age_penalty_applied) seen.penalised += 1;
        else seen.unpenalised += 1;
        if (dev.total_stars > SCORE_CONFIG.MAX_STARS_FOR_SCORING) seen.starsCapped += 1;
        if (dev.raw_events_60d.length === 0) seen.emptyFeed += 1;
        if (Math.abs((result.score_exact % 1) - 0.5) < 1e-9) seen.roundsAtHalf += 1;
      }

      expect(mismatches.slice(0, 5)).toEqual([]);
      expect(mismatches).toHaveLength(0);

      // The generator reached the cases that matter.
      expect(seen.penalised).toBeGreaterThan(1000);
      expect(seen.unpenalised).toBeGreaterThan(1000);
      expect(seen.starsCapped).toBeGreaterThan(1000);
      expect(seen.emptyFeed).toBeGreaterThan(100);
      expect(seen.roundsAtHalf).toBeGreaterThan(100);
    },
    TIMEOUT_MS
  );

  // A shape test on top of the numeric one above, so a third of the sample.
  it(
    'Register preview matches the old breakdown field for field, and the board',
    () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);

      for (const dev of developers.slice(0, 4000)) {
        const input = {
          events: dev.raw_events_60d,
          totalStars: dev.total_stars,
          followers: dev.followers,
          publicRepos: dev.public_repos,
          createdAt: dev.created_at
        };
        const before = legacyBreakdown({ config: LEGACY_CONFIG, ...input });
        const after = computeDeveloperScoreBreakdown({ ...input, now: NOW });

        expect(after).toMatchObject(before);
        expect(after.finalScore).toBe(scoreModel(dev, { config: SCORE_CONFIG, now: NOW }).score);
      }
    },
    TIMEOUT_MS
  );
});

describe('scoreModel', () => {
  const base = {
    username: 'someone',
    total_stars: 300,
    followers: 40,
    public_repos: 12,
    created_at: '2019-05-01T00:00:00Z',
    raw_events_60d: [{ type: 'ReleaseEvent', created_at: new Date(NOW - DAY).toISOString() }]
  };

  it('reads only the declared inputs', () => {
    const noisy = { ...base, events_30d: 999, event_counts_30d: { pushes: 999 }, score: 1 };
    expect(scoreModel(noisy, { config: SCORE_CONFIG, now: NOW })).toEqual(
      scoreModel(base, { config: SCORE_CONFIG, now: NOW })
    );
    expect(MODEL_INPUT_FIELDS).toEqual([
      'total_stars',
      'followers',
      'public_repos',
      'created_at',
      'raw_events_60d'
    ]);
  });

  it('has no approximate path: missing raw events throw, whatever else is present', () => {
    const { raw_events_60d: _drop, ...rest } = base;
    const withCounts = { ...rest, event_counts_30d: { pushes: 10 }, events_30d: 10 };
    expect(() => scoreModel(withCounts, { config: SCORE_CONFIG, now: NOW })).toThrow(
      /raw_events_60d.*someone.*no approximate path/s
    );
  });

  it('scores an empty feed as zero activity, which is a measurement and not an absence', () => {
    const result = scoreModel({ ...base, raw_events_60d: [] }, { config: SCORE_CONFIG, now: NOW });
    expect(result.activity_score).toBe(0);
  });

  it.each([
    ['total_stars', undefined],
    ['total_stars', '300'],
    ['followers', -1],
    ['public_repos', 1.5],
    ['created_at', undefined],
    ['created_at', 'yesterday']
  ])('throws on %s = %j, naming the developer', (field, value) => {
    expect(() =>
      scoreModel({ ...base, [field]: value }, { config: SCORE_CONFIG, now: NOW })
    ).toThrow(new RegExp(`${field}.*someone`));
  });

  it('never reads the clock: `now` is required', () => {
    expect(() => scoreModel(base, { config: SCORE_CONFIG })).toThrow(/`now` is required/);
  });

  it('takes the age penalty multiplier from config', () => {
    const young = { ...base, created_at: new Date(NOW - 10 * DAY).toISOString() };
    const config = validateScoreConfig({
      ...JSON.parse(JSON.stringify(SCORE_CONFIG)),
      AGE_PENALTY_MULTIPLIER: 0.25
    });
    const full = scoreModel(base, { config, now: NOW });
    const penalised = scoreModel(young, { config, now: NOW });
    expect(penalised.age_penalty_applied).toBe(true);
    expect(penalised.score_exact).toBe(full.components.base_score * 0.25);
  });
});

describe('scoreFromPublished', () => {
  const developer = makeGenerator(42);

  function publish(dev, now) {
    const result = scoreModel(dev, { config: SCORE_CONFIG, now });
    const row = {
      username: dev.username,
      total_stars: dev.total_stars,
      followers: dev.followers,
      public_repos: dev.public_repos,
      created_at: dev.created_at,
      ...publishedScoreFields(result, { config: SCORE_CONFIG, now })
    };
    // Through JSON, as the file is.
    return JSON.parse(JSON.stringify(row));
  }

  it('recomputes score and score_exact exactly, across the age boundary', () => {
    for (let i = 0; i < 3000; i += 1) {
      const row = publish(developer(i), NOW);
      expect(scoreFromPublished(row)).toBe(row.score);
      expect(recomputePublished(row, { config: SCORE_CONFIG }).score_exact).toBe(row.score_exact);
    }
  });

  it('stamps the shipped model version and the instant of scoring', () => {
    const row = publish(developer(1), NOW);
    expect(row.model_version).toBe(MODEL_VERSION);
    expect(row.scored_at).toBe(new Date(NOW).toISOString());
  });

  it('uses scored_at, not the current time, for the age penalty', () => {
    // An account 179 days old when scored is penalised, and stays penalised
    // in the recomputation however long after the check runs.
    const dev = { ...developer(2), created_at: new Date(NOW - 179 * DAY).toISOString() };
    const row = publish(dev, NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 365 * DAY);
    expect(scoreFromPublished(row)).toBe(row.score);
  });

  it('notices a tampered row', () => {
    // Below the star cap, so one more star is worth something.
    const row = publish({ ...developer(3), total_stars: 10, raw_events_60d: [] }, NOW);
    expect(scoreFromPublished({ ...row, activity_score: row.activity_score + 40 })).not.toBe(
      row.score
    );
    expect(scoreFromPublished({ ...row, total_stars: row.total_stars + 1 })).not.toBe(row.score);
  });

  it('refuses a row with no model_version, or from another major version', () => {
    const row = publish(developer(4), NOW);
    const { model_version: _drop, ...legacy } = row;
    expect(() => scoreFromPublished(legacy)).toThrow(/no model_version/);
    expect(() => scoreFromPublished({ ...row, model_version: '3.0.0' })).toThrow(/major version/);
    // Minor and patch releases promise identical scores, so they are checked.
    expect(scoreFromPublished({ ...row, model_version: '2.7.1' })).toBe(row.score);
  });

  it('refuses a row missing a field the recomputation needs', () => {
    const row = publish(developer(5), NOW);
    for (const field of ['activity_score', 'scored_at', 'created_at', 'total_stars']) {
      const { [field]: _drop, ...rest } = row;
      expect(() => scoreFromPublished(rest)).toThrow(new RegExp(field));
    }
  });
});
