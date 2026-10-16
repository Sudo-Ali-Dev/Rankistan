import React from 'react';
import { SCORE_CONFIG, MODEL_VERSION } from '../model/config.js';

const REPO_COMMIT_BASE = 'https://github.com/Sudo-Ali-Dev/Rankistan/commit';
const CONFIG_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/score-config.json';

// The current formula is read from the model's config. The timeline entries
// below are history and keep the numbers they had at the time.
const { SCALE, WEIGHTS, WINDOW_DAYS, RECENCY_FLOOR, WORK, COLLABORATION, APPRECIATION, MIN_ACCOUNT_AGE_DAYS } =
  SCORE_CONFIG;
const pts = (weight) => Math.round(SCALE * weight);

const INTRO_BULLETS = [
  {
    label: 'Public work only',
    text: `The score reads your public contributions over the last ${WINDOW_DAYS} days from GitHub's contributions API. Private contributions are shown as context and never scored.`,
  },
  {
    label: 'What does not count',
    text: 'Followers, repository counts, account age, stars on projects you are not working on, and watching, starring, forking or commenting.',
  },
  {
    label: 'Fairness',
    text: 'A day counts once however much was done on it, so volume cannot be farmed. To reach the top, other people have to accept your work.',
  },
  {
    label: 'Check any score',
    text: 'Every developer\'s file lists the evidence behind their score, item by item, and Register measures any account live with the pipeline\'s own code.',
  },
];

const FORMULA_PLAIN_ENGLISH = [
  `Work is worth up to ${pts(WEIGHTS.work)} points. It is the share of the last ${WINDOW_DAYS} days you did public work, recent days weighing more (yesterday 1, the oldest day ${RECENCY_FLOOR}), on a curve where each extra day adds a little less.`,
  `Collaboration is worth up to ${pts(WEIGHTS.collaboration)} points. It is work another person accepted, counted per project and per person so that no one can vouch for you without limit, and it reaches half at ${COLLABORATION.HALF_POINT} merges into well-known projects by different people.`,
  `Appreciation is worth up to ${pts(WEIGHTS.appreciation)} points. It is the stars on the best known project you own and worked on this month, from ${APPRECIATION.FROM_STARS} stars up, a third for every tenfold.`,
  `You are ranked with at least ${WORK.GATE_MIN_DAYS} working days in the last ${WINDOW_DAYS} and an account ${MIN_ACCOUNT_AGE_DAYS} days old. Equal scores share a rank.`,
];

const CONSTANTS_ACROSS_ERAS = [
  'Only public work counts.',
  'Activity is measured over the last 30 days.',
  'Every number the score uses lives in one config file, read by the pipeline, the site and the Worker.',
  'Every row records the model version it was scored with, so any published score can be recomputed.',
];

const BEHIND_THE_SCENES = [
  {
    text: 'All weights and caps live in one config file so the site and batch job stay in sync.',
    commit: 'a5ec558',
  },
  {
    text: 'Register previews a score with the same code the pipeline runs, on the Cloudflare Worker.',
    commit: null,
  },
];

const EVOLUTION_ENTRIES = [
  {
    id: 'v1-flat',
    date: '2026-03-21',
    title: 'Everything counted the same',
    summary: 'One activity number for all event types in 30 days.',
    commit: 'a34ea46',
    formula: 'base = min(stars, 2000)×2 + events_30d×3 + followers×1 + public_repos×0.5',
    changes: [
      'Your score combined stars, followers, public repo count, and a single 30-day activity total.',
      'Every meaningful event (push, PR, issue, release) added the same amount—3 points each.',
      'Star cap was 2,000 (up to 4,000 star points). New accounts under 6 months got half the score.',
    ],
    reasoning:
      'This was easy to understand, but volume could beat quality—a push counted the same as a release, so busy accounts could climb without deeper contribution.',
  },
  {
    id: 'v2-per-type',
    date: '2026-05-05',
    title: 'Stronger events count more',
    summary: 'Releases and PRs worth more than pushes; still linear over 30 days.',
    commit: 'b93d39c',
    formula: 'activity = releases×5 + PRs×4 + pushes×2 + issues×1.5 (30d totals)',
    changes: [
      'Activity split into four types: releases (5×), pull requests (4×), pushes (2×), issues (1.5×).',
      'Your total was still the sum across the whole month—no per-day limit yet.',
      'Profiles missing per-type data used a neutral blended estimate until refreshed.',
    ],
    reasoning:
      'Not all GitHub activity is equal—merging code and shipping releases matter more than light pushes. Linear totals still let someone flood one event type in a single day and rack up points.',
  },
  {
    id: 'v3-star-cap',
    date: '2026-05-05',
    title: 'Star cap (250)',
    summary: 'Maximum 500 points from stars (250 × 2).',
    commit: 'c763841',
    formula: 'max star contribution = 250 × 2 = 500 points',
    changes: [
      'Only the first 250 stars count toward your score (was 2,000).',
      'Huge popular repos no longer dominate the board on stars alone.',
    ],
    reasoning:
      'Rankistan ranks builders with recent open-source work, not passive celebrity. The cap keeps star count from outweighing activity.',
  },
  {
    id: 'v4-follower-cap',
    date: '2026-05-06',
    title: 'Follower cap (500)',
    summary: 'Maximum 500 points from followers.',
    commit: '3a40c9b',
    formula: 'max follower contribution = 500 × 1 = 500 points',
    changes: [
      'Follower count above 500 no longer adds extra score points.',
    ],
    reasoning:
      'Social reach is not the same as open-source contribution. The follower cap mirrors the star cap so the board stays about engineering impact.',
  },
  {
    id: 'v7-diminishing',
    date: '2026-05-23',
    title: 'Daily limits and diminishing returns',
    summary: 'Current rules: per-day curves and caps; burst spam earns little.',
    commit: null,
    formula:
      'marginal(n) = base / log2(n+1) per type per UTC day; daily cap; sum over 30 days',
    changes: [
      'Activity is scored per UTC day, not as one big monthly pile.',
      'Each extra event that day earns less (diminishing returns). Each type also has a daily point cap.',
      'Push: up to 20 pushes counted per day, max 15 pts/day. Issue: 15. PR: 25. Release: 20.',
      'Spreading work across the month earns more than dumping hundreds of events on one day.',
    ],
    example:
      'Example: 199 releases in a single day used to add ~995 activity points under linear scoring. Under current rules that day caps at about 20 release points—steady contributors are not beaten by release farming.',
    reasoning:
      'Linear monthly totals still rewarded gaming—mass releases or push spam in one day. Daily caps and diminishing returns reward consistent public work and limit burst farming.',
  },
  {
    id: 'v8-one-model',
    date: '2026-10-13',
    title: 'One model, recorded on every row',
    summary: 'No score changed. Ties break on the exact score, then the username.',
    commit: null,
    formula: 'order = score before rounding (desc), then username · every row records model_version 2.0.0',
    changes: [
      'Scores are unchanged: the weights, caps, activity curve, and new-account penalty are exactly what they were.',
      'The board used to sort on the rounded score, so developers who rounded to the same number were put in alphabetical order. It now sorts on the score before rounding, and only an exact tie falls back to the username.',
      'That username comparison is now the same on every machine. It used to follow the locale settings of whatever computer built the board.',
      'Every row records the model version it was scored with, along with the unrounded score, its activity points, and when it was scored, so a published score can be recomputed from the published row alone.',
      'Register and the batch job now run the same scoring code instead of two copies of the formula, and no score is ever estimated: it is computed from the measured events or not at all.',
    ],
    reasoning:
      'On 13 October 2026 the board held 1,000 developers but only 340 distinct rounded scores, so most positions were settled by the alphabet rather than by work. And with the formula written twice, Register agreed with the board only until someone changed one copy and not the other.',
  },
  {
    id: 'v9-city-names',
    date: '2026-10-13',
    title: 'A Pakistani city counts without the word "Pakistan"',
    summary: 'Who is searched for changed; how anyone is scored did not.',
    commit: null,
    formula:
      'search = location:pakistan, then location:lahore … location:mardan (15 cities) -location:pakistan',
    changes: [
      'GitHub matches a profile\'s location word by word. A location that said only "Lahore" never matched a search for "Pakistan", so the board could not find that developer however active they were.',
      'Each hourly batch now runs a second search over the same account-creation dates: any of 15 cities (Lahore, Karachi, Islamabad, Rawalpindi, Peshawar, Faisalabad, Multan, Quetta, Sialkot, Gujranwala, Abbottabad, Bahawalpur, Sargodha, Sukkur and Mardan) and not "Pakistan", so nobody is found twice.',
      'Developers found this way pass the same activity gates as everyone else. One whose location also names a place outside Pakistan, such as India, Bangladesh or Iran, is not counted.',
      'Hyderabad, Mirpur, Gujrat, Punjab, Kashmir and Hub are not searched. Hyderabad matched mostly Hyderabad in India, Mirpur mostly Mirpur in Dhaka, and Gujrat mostly misspellings of Gujarat; Punjab and Kashmir span the border, and Hub is an ordinary word as well as a town. A developer there who adds "Pakistan" to their location is found as before.',
      'Every developer measured from now on records which search found them.',
    ],
    reasoning:
      'On 13 October 2026, 26,002 GitHub accounts with more than 3 repositories and more than 1 follower said "Pakistan" in their location, and 8,836 more named one of these 15 cities without it: a third as many again, none of whom could ever appear. Each city was kept only after a sample of 30 of its matches turned out to be 30 Pakistani developers.',
  },
  {
    id: 'registration-by-issue',
    date: '2026-10-13',
    title: 'Register, or leave, by GitHub issue',
    summary: 'Who can be on the board, not how it is scored: no score changed.',
    commit: null,
    formula:
      'candidate = found by location search OR registered by issue · every other gate unchanged · opt-out removes, by account id',
    changes: [
      'Developers whose GitHub location says neither Pakistan nor one of the searched cities can register by opening a Register issue. The account that opens it is the account registered; nothing typed into the issue is read, so nobody can register anyone else.',
      'Registering replaces only the location search. Every other gate still applies: more than 3 public repositories, more than 1 follower, an account at least 30 days old, and the activity thresholds.',
      "A registered developer is measured in the batch that covers their account's creation date, like everyone else.",
      'Anyone can take themselves off the board with a Remove me issue. It applies at the next pipeline run, whichever batch holds their row, and they are not measured while it stands. A later Register issue reverses it.',
      'Both are keyed on the numeric GitHub account id rather than the username, which can be changed and then claimed by someone else. Rows now record that id.',
    ],
    reasoning:
      'Searching by location cannot find a Pakistani developer whose profile names another country, an unsearched city, or nothing, and there was no way to ask to be taken off. A run that cannot read the opt-outs now saves nothing, rather than risk republishing someone who asked to leave.',
  },
  {
    id: 'v10-contributions',
    date: '2026-10-16',
    title: 'Scoring v3, ranked by public work and work others accepted',
    summary: 'Every score changed. Followers, repository counts and the new-account penalty are gone.',
    commit: null,
    formula:
      'score = 1000 × (0.5 work + 0.4 collaboration + 0.1 appreciation) · work = 1 − (1 − x)², x = recency-weighted share of working days · collaboration = c / (c + 3)',
    changes: [
      'Activity now comes from GitHub\'s contributions API, which is keyed on dates and sees the whole month. The events feed version 2 read stopped at 200 events, so for 199 of the 1,000 developers on the board a "30-day" score covered fewer days, one of them six.',
      'Work counts days, not commits. A day with a public commit, a pull request or issue opened in someone else\'s project, or a review of someone else\'s pull request counts once, however much was done on it.',
      'Collaboration is new. A pull request someone else merged into a project you do not own, a review of someone else\'s pull request, and someone else\'s pull request merged into your project count, if the other person\'s account was a year old. Each project and each person can vouch for you only so far, and a spray of pull requests that are mostly closed unmerged earns less.',
      'Stars count only for a project you own and worked on this month, from 10 stars up, and are worth at most 100 points. Followers and repository counts no longer count at all.',
      'Commits never count from forks, from profile README repositories, from repositories holding commits dated in the future or author dates hours after their commit dates, or from repositories a bot commits to in your name. A public moderation list can remove a repository whose commits a script makes, with the evidence beside it.',
      'The new-account penalty is gone. An account must be 30 days old to be ranked, and after that its age changes nothing.',
      'Equal scores share a rank, and the order within a tie changes daily instead of following the alphabet.',
      'The whole board is scored again from its measurements on every run, and each developer\'s evidence is published with their score.',
    ],
    example:
      'One account on the board made 1,031,238 commits in 30 days to a repository nobody had starred, 1,028,906 of them on a single day. Under version 3 that is one working day per day it committed, the same as one commit. Two accounts pay a service that paints their contribution graph, its commits dated up to 21.8 hours after they were made, and those commits now count for nothing. Measured on the whole board before the switch, 896 of 997 developers pass the new gate, 3 of version 2\'s top 50 stay in the top 50, and the score no longer follows followers or stars, with rank correlations of −0.06 and −0.12.',
    reasoning:
      'Version 2 claimed to rank active developers, but stars and followers decided the order. Activity supplied 40% of the points and almost none of the ranking, and the top ten were accounts at the star and follower caps. Volume could be farmed with a script, and work other people accepted, the one thing a single account cannot fake, was not measured at all.',
  },
];

const LAST_DOCUMENTED = EVOLUTION_ENTRIES[EVOLUTION_ENTRIES.length - 1].date;

export default function Evolution() {
  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none" />
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 md:py-12 relative z-10">

        <div className="mb-8 border-l-4 border-primary pl-4 sm:mb-12 sm:pl-6">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-on-surface mb-2">
            Scoring{' '}
            <span className="text-primary font-normal tracking-normal">Evolution</span>
          </h1>
          <p className="font-body text-sm sm:text-base text-outline max-w-2xl leading-relaxed">
            How Rankistan calculates your score, and why the rules changed over time to reward steady
            public work and work others accept, not bursts or fame.
          </p>
        </div>

        <div className="border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8 mb-8 sm:mb-12">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-tertiary text-lg">info</span>
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">
              Before you read the timeline
            </span>
          </div>
          <ul className="space-y-3">
            {INTRO_BULLETS.map(({ label, text }) => (
              <li key={label} className="font-body text-xs sm:text-sm text-outline leading-relaxed">
                <span className="text-on-surface font-medium">{label}.</span>
                <span className="text-outline"> {text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8 mb-8 sm:mb-12">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 bg-tertiary animate-pulse" />
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">Current_Formula</span>
          </div>
          <div className="overflow-x-auto bg-surface-container-low border border-outline-variant p-3 sm:p-5 mb-4 font-mono text-xs sm:text-sm leading-relaxed">
            <div className="text-primary">
              score = round({SCALE} × ({WEIGHTS.work} × work + {WEIGHTS.collaboration} × collaboration + {WEIGHTS.appreciation} × appreciation))
            </div>
            <div className="text-tertiary mt-2">
              work = 1 − (1 − x)^{WORK.CURVE_POWER}, collaboration = c / (c + {COLLABORATION.HALF_POINT}), appreciation = (log10(stars) − 1) / {APPRECIATION.DECADES}
            </div>
            <div className="text-outline mt-3 text-[11px]">
              x = Σ recency weights of your working days / Σ recency weights of all {WINDOW_DAYS} days · c = accepted work, per project and per person
            </div>
          </div>
          <div className="mb-4 space-y-2">
            {FORMULA_PLAIN_ENGLISH.map((line) => (
              <p key={line} className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed">
                {line}
              </p>
            ))}
          </div>
          <ul className="space-y-2 border-t border-outline-variant/50 pt-4">
            {CONSTANTS_ACROSS_ERAS.map((line) => (
              <li key={line} className="font-body text-xs text-outline leading-relaxed flex gap-2">
                <span className="text-tertiary shrink-0">—</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-6 sm:mb-8">
          <span className="material-symbols-outlined text-primary">history</span>
          <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">
            How the formula changed
          </h2>
          <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// oldest → newest</span>
        </div>

        <ol className="relative border-l-2 border-outline-variant ml-3 sm:ml-4 space-y-0">
          {EVOLUTION_ENTRIES.map((entry, index) => {
            const isLast = index === EVOLUTION_ENTRIES.length - 1;
            return (
              <li
                key={entry.id}
                className={`relative pl-6 sm:pl-10 pb-10 sm:pb-12 ${isLast ? 'pb-4' : ''}`}
              >
                <span
                  className={`absolute -left-[9px] sm:-left-[11px] top-1 flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full border-2 font-mono text-[8px] sm:text-[9px] font-bold ${
                    isLast
                      ? 'border-tertiary bg-tertiary text-on-tertiary'
                      : 'border-primary bg-surface-container-lowest text-primary'
                  }`}
                  aria-hidden
                >
                  {index + 1}
                </span>

                <article className="border border-outline-variant bg-surface-container-lowest p-4 sm:p-6">
                  <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 mb-2">
                    <time className="font-mono text-[10px] sm:text-xs text-outline uppercase tracking-widest">
                      {entry.date}
                    </time>
                    {entry.commit && (
                      <a
                        href={`${REPO_COMMIT_BASE}/${entry.commit}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[10px] text-primary hover:underline"
                      >
                        {entry.commit}
                      </a>
                    )}
                    {isLast && (
                      <span className="font-mono text-[9px] text-tertiary bg-tertiary/15 px-2 py-0.5 uppercase tracking-widest">
                        current
                      </span>
                    )}
                  </div>

                  <h3 className="font-headline text-base sm:text-lg font-bold text-on-surface mb-1 tracking-tight">
                    {entry.title}
                  </h3>
                  {entry.summary && (
                    <p className="font-body text-xs text-outline mb-3 leading-relaxed">{entry.summary}</p>
                  )}

                  <div className="font-mono text-[11px] sm:text-xs text-primary/90 bg-primary/5 border border-primary/20 px-3 py-2 mb-4 break-all">
                    {entry.formula}
                  </div>

                  {entry.example && (
                    <div className="mb-4 border border-tertiary/40 bg-tertiary/5 px-3 py-3 sm:px-4">
                      <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-1">
                        Real impact
                      </span>
                      <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed">
                        {entry.example}
                      </p>
                    </div>
                  )}

                  <div className="mb-4">
                    <span className="font-mono text-[10px] text-outline uppercase tracking-widest block mb-2">
                      What changed
                    </span>
                    <ul className="space-y-1.5">
                      {entry.changes.map((item) => (
                        <li
                          key={item}
                          className="font-body text-xs text-on-surface-variant leading-relaxed flex gap-2"
                        >
                          <span className="text-primary shrink-0 mt-0.5">›</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="border-l-2 border-tertiary/60 pl-3 sm:pl-4">
                    <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-1">
                      Why it matters
                    </span>
                    <p className="font-body text-xs sm:text-sm text-outline leading-relaxed">
                      {entry.reasoning}
                    </p>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>

        <footer className="mt-8 sm:mt-12 space-y-6">
          <div className="p-4 sm:p-6 border border-outline-variant/50 bg-surface-container-low">
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest block mb-3">
              Behind the scenes
            </span>
            <ul className="space-y-3">
              {BEHIND_THE_SCENES.map(({ text, commit }) => (
                <li key={text} className="font-body text-xs sm:text-sm text-outline leading-relaxed flex flex-wrap items-baseline gap-2">
                  <span>{text}</span>
                  {commit && (
                    <a
                      href={`${REPO_COMMIT_BASE}/${commit}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-primary hover:underline shrink-0"
                    >
                      {commit}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="p-4 border border-outline-variant/50 bg-surface-container-low font-mono text-[10px] text-outline uppercase tracking-widest leading-relaxed">
            <p>
              Scoring version: {MODEL_VERSION} · Last documented: {LAST_DOCUMENTED}
            </p>
            <p className="mt-2 normal-case tracking-normal font-body text-xs">
              Live weights:{' '}
              <a
                href={CONFIG_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono"
              >
                score-config.json
              </a>
            </p>
          </div>
        </footer>
      </div>
    </main>
  );
}
