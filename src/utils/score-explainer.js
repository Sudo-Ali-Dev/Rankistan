// The score explained for someone new to it, shared by About, Evolution and the Register
// breakdown so every page uses the same words and the same tables. Every number is read from the
// model's config, and the worked example is scored by the model itself, so the site cannot
// describe a score the board would not give.
//
// The site names the parts in everyday words. In the code and in docs/scoring.md they are work,
// collaboration and appreciation.
import { SCORE_CONFIG } from '../model/config.js';
import { scoreModel, starWeight } from '../model/score.js';
import {
  FLAG_ORG,
  FLAG_OWNED,
  KIND_ORG,
  KIND_USER,
  SHAPE_VERSION,
  encodeMeasurement,
  measurementWindow
} from '../model/measurement.js';

const { SCALE, WEIGHTS, WINDOW_DAYS, WORK, COLLABORATION, APPRECIATION, MIN_ACCOUNT_AGE_DAYS } =
  SCORE_CONFIG;

const fmt = (n) => n.toLocaleString('en-US');
const round1 = (n) => Math.round(n * 10) / 10;

export const PART_LABELS = Object.freeze({
  work: 'Active days',
  collaboration: 'Open source contributions',
  appreciation: 'Stars'
});

export const WORK_POINTS = Math.round(SCALE * WEIGHTS.work);
export const COLLABORATION_POINTS = Math.round(SCALE * WEIGHTS.collaboration);
export const APPRECIATION_POINTS = Math.round(SCALE * WEIGHTS.appreciation);

/** Points for active days spread evenly over the window, before recent days are counted up. */
export function workPointsForDays(days) {
  const share = Math.min(1, days / WINDOW_DAYS);
  return SCALE * WEIGHTS.work * (1 - (1 - share) ** WORK.CURVE_POWER);
}

/** Points for a number of contribution credits. */
export function pointsForCredits(credits) {
  return SCALE * WEIGHTS.collaboration * (credits / (credits + COLLABORATION.HALF_POINT));
}

/** Points for a repository's stars, with full credit for the days worked on it. */
export function pointsForStars(stars) {
  const decades = Math.log10(Math.max(stars, 1) / APPRECIATION.FROM_STARS);
  return SCALE * WEIGHTS.appreciation * Math.min(1, Math.max(0, decades / APPRECIATION.DECADES));
}

const yearsOld = COLLABORATION.COUNTERPARTY_MIN_AGE_DAYS / 365;
const COUNTERPARTY_AGE = Number.isInteger(yearsOld)
  ? yearsOld === 1
    ? 'a year'
    : `${yearsOld} years`
  : `${COLLABORATION.COUNTERPARTY_MIN_AGE_DAYS} days`;
const credit = (stars) => round1(starWeight(stars, SCORE_CONFIG));
export const FULL_CREDIT_STARS = Math.round(
  10 ** ((1 - COLLABORATION.STARS_FLOOR) / COLLABORATION.STARS_PER_DIGIT)
);

export const SCORE_INTRO = `Your score is a number out of ${fmt(SCALE)}. It adds up three parts, and each part has a maximum.`;

export const SCORE_PARTS = [
  {
    id: 'work',
    name: PART_LABELS.work,
    points: WORK_POINTS,
    question: `How many days were you active on GitHub in the last ${WINDOW_DAYS} days?`,
    lines: [
      "An active day is a day you made a commit to a public repository, opened a pull request or an issue on a repository you do not own, or reviewed another developer's pull request. Commits to forks and to your profile README repository do not count.",
      'A day counts once. One commit or a hundred commits on the same day is one active day.',
      `Your first active day is worth about ${Math.round(workPointsForDays(1))} points, and each extra day is worth a little less. That way a developer who is active most days is not far behind one who is active every single day.`
    ],
    table: {
      head: ['Active days', 'Points'],
      rows: [1, 5, 10, 15, 20, WINDOW_DAYS].map((d) => [
        String(d),
        String(Math.round(workPointsForDays(d)))
      ])
    },
    after:
      'Recent days count a little more than older days, so your points can be a few above or below this table.'
  },
  {
    id: 'collaboration',
    name: PART_LABELS.collaboration,
    points: COLLABORATION_POINTS,
    question: 'Did other developers accept your work?',
    lines: [
      "You earn credits for three things. Your pull request merged into an open source project you do not own, or one you merged yourself after another developer approved it. Your review of another developer's pull request. Another developer's pull request that you merged into your own repository.",
      `A merged pull request earns up to 1 credit. It earns the full credit in a project with ${fmt(FULL_CREDIT_STARS)} or more stars, about ${credit(99)} with 100 stars, ${credit(9)} with 10 stars and ${COLLABORATION.STARS_FLOOR} with none. A review, or a pull request you merged into your own repository, earns half. So does a tiny change of one file and up to ${COLLABORATION.TINY_MAX_LINES} lines. A review by someone with no role in the project counts as if the project had no stars.`,
      `The other developer's account must be at least ${COUNTERPARTY_AGE} old. More pull requests to the same project, or with the same person, earn a little less each, and each further project or person counts a little less than the one before. One person can only give you so much, whether they merge your work, you review theirs or they send you pull requests.`
    ],
    table: {
      head: ['Credits', 'Points'],
      rows: [1, 2, 3, 6, 12].map((c) => [String(c), String(Math.round(pointsForCredits(c)))])
    },
    after:
      'Recent merges count a little more than older ones. If most of your pull requests to other projects are closed without being merged, the points from this part shrink in proportion.'
  },
  {
    id: 'appreciation',
    name: PART_LABELS.appreciation,
    points: APPRECIATION_POINTS,
    question: 'Do people like what you build?',
    lines: [
      `We take the repository you own with the most stars, if you committed to it in the last ${WINDOW_DAYS} days. Repositories you did not work on this month earn nothing.`
    ],
    table: {
      head: ['Stars', 'Points'],
      rows: [
        [`under ${APPRECIATION.FROM_STARS}`, '0'],
        ...[100, 1000, 10000].map((s) => [fmt(s), String(Math.round(pointsForStars(s)))])
      ]
    },
    after: `You get the full amount once you have committed to that repository on ${APPRECIATION.FULL_AFTER_DAYS} different days this month. With fewer days you get a part, for example ${APPRECIATION.FULL_AFTER_DAYS - 1} days gives ${APPRECIATION.FULL_AFTER_DAYS - 1} quarters of it.`
  }
];

export const SCORE_NOT_COUNTED =
  'Followers, how many repositories you have, and how old your account is give no points. Activity in private repositories gives no points either, because nobody outside can check it.';

export const SCORE_ELIGIBILITY = `To be on the board you need at least ${WORK.GATE_MIN_DAYS} active days in the last ${WINDOW_DAYS} and a GitHub account at least ${MIN_ACCOUNT_AGE_DAYS} days old.`;

// The worked example. A made-up developer, measured on a fixed date so the numbers never move.
const EXAMPLE_DAYS = Math.round(WINDOW_DAYS / 2);
const EXAMPLE_MERGES = 2;
const EXAMPLE_STARS = APPRECIATION.FROM_STARS * 10;
const EXAMPLE_TARGET_STARS = 5000;

export function exampleMeasurement() {
  const window = measurementWindow(Date.parse('2026-10-16T09:00:00Z'));
  // Every other day, ending yesterday: spread across the month.
  const days = Array.from({ length: EXAMPLE_DAYS }, (_, i) => WINDOW_DAYS - 1 - 2 * i).sort(
    (a, b) => a - b
  );
  return {
    version: SHAPE_VERSION,
    measured_at: '2026-10-16T09:00:00Z',
    login: 'ayesha',
    github_id: 1,
    window: { from: window.from, to: window.to },
    restricted: 0,
    commits: [
      {
        repo: 'ayesha/app',
        flags: FLAG_OWNED,
        stars: EXAMPLE_STARS,
        days: days.map((day) => ({ day, commits: 3 }))
      }
    ],
    pull_requests: [],
    issues: [],
    reviews: [],
    // Merged yesterday, into two different projects, by two different maintainers.
    accepted: Array.from({ length: EXAMPLE_MERGES }, (_, i) => ({
      repo: `project${i + 1}/core`,
      flags: FLAG_ORG,
      stars: EXAMPLE_TARGET_STARS,
      owner: { login: `project${i + 1}`, kind: KIND_ORG, created: '2015-01-01' },
      items: [
        {
          day: WINDOW_DAYS - 1,
          number: 100 + i,
          merger: { login: `maintainer${i + 1}`, kind: KIND_USER, created: '2014-01-01' },
          lines: 60,
          files: 4
        }
      ]
    })),
    maintained: [],
    future_repos: [],
    integrity: [],
    cut: 0
  };
}

const exampleResult = scoreModel(encodeMeasurement(exampleMeasurement()));
const examplePoints = (id) => Math.round(SCALE * WEIGHTS[id] * exampleResult.parts[id]);

export const SCORE_EXAMPLE = {
  story: `Ayesha is a made-up developer. In the last ${WINDOW_DAYS} days she was active on ${EXAMPLE_DAYS} days, spread across the month. Yesterday ${EXAMPLE_MERGES} of her pull requests were merged into ${EXAMPLE_MERGES} different open source projects with ${fmt(EXAMPLE_TARGET_STARS)} stars each, worth ${round1(exampleResult.details.c)} credits, because the second project counts a little less than the first. Her own repository has ${fmt(EXAMPLE_STARS)} stars and she committed to it this month.`,
  rows: [
    { name: PART_LABELS.work, why: `${EXAMPLE_DAYS} active days`, points: examplePoints('work') },
    {
      name: PART_LABELS.collaboration,
      why: `${round1(exampleResult.details.c)} credits`,
      points: examplePoints('collaboration')
    },
    {
      name: PART_LABELS.appreciation,
      why: `${fmt(EXAMPLE_STARS)} stars`,
      points: examplePoints('appreciation')
    }
  ],
  score: exampleResult.score
};

const { INTEGRITY } = SCORE_CONFIG;

/**
 * How the board stops people scoring work they did not do, for the About page. Each rule says
 * what it stops and how, in plain words. All are automatic except the last, which a person runs
 * and publishes.
 */
export const SCORE_SAFEGUARDS = [
  {
    what: 'Many commits on one day',
    how: 'A day counts once. A thousand commits on one day earn the same as one, so committing more often gains nothing.'
  },
  {
    what: 'Commits a bot makes in your name',
    how: `When half or more of the sampled commits in a repository were made by an app or a bot account, that repository does not count. At least ${INTEGRITY.MIN_BOT_SAMPLE} sampled commits are needed before this is judged, so one automated commit never removes your work.`
  },
  {
    what: 'Profile README commits',
    how: 'Commits to your profile repository, the one named after your username, never count. It is the easiest place to keep a fake streak.'
  },
  {
    what: 'Forks',
    how: 'Commits to a fork do not count. The work belongs to the project it was copied from.'
  },
  {
    what: 'Fake dates',
    how: `A repository with commits dated in the future, or with commits that say they were written more than ${INTEGRITY.MAX_LEAD_HOURS} hours after they were saved, does not count. Real history never looks like that, and graph painting services do.`
  },
  {
    what: 'Commits that are not there',
    how: `When GitHub credits commits on ${INTEGRITY.MISSING_MIN_DAYS} or more days and the repository holds none of them, it does not count. Nobody can check work that is not there.`
  },
  {
    what: 'Merging your own pull requests',
    how: 'A pull request you merge yourself earns no open source points, unless another developer approved it first. Only another person accepting your work counts.'
  },
  {
    what: 'Second accounts',
    how: `The developer who merges, approves or sends you work must have a GitHub account at least ${COUNTERPARTY_AGE} old. A new account made to help yourself counts for nothing.`
  },
  {
    what: 'Friends vouching for each other',
    how: 'One person or one project can only add so much, and each further one counts a little less than the one before.'
  },
  {
    what: 'Quick reviews of famous projects',
    how: "A review by someone with no role in the project counts as if the project had no stars, so it cannot borrow the project's fame."
  },
  {
    what: 'Pull request spam',
    how: 'If most of your pull requests to other projects are closed without being merged, your open source points shrink in proportion.'
  },
  {
    what: 'Bought or friendly stars',
    how: `Stars count only from ${APPRECIATION.FROM_STARS} upward, only on a repository you worked on this month, and give at most ${APPRECIATION_POINTS} of ${fmt(SCALE)} points.`
  },
  {
    what: 'Private work',
    how: 'Activity in private repositories never earns points, because nobody outside can check it. It is still shown on your card.'
  },
  {
    what: 'Scripts no rule can prove',
    how: 'Every hour the board lists repositories that look automated for a person to read. When the commits show a script, the repository is added to a public list with the reason and a link to the evidence, at rankistan.dev/moderation.json. Anyone listed can appeal by opening a GitHub issue.'
  }
];
