import React from 'react';
import { SCORE_CONFIG, MODEL_VERSION } from '../model/config.js';
import ScoreExplainer from '../components/ScoreExplainer';
import {
  SCORE_ELIGIBILITY,
  WORK_POINTS,
  COLLABORATION_POINTS,
  APPRECIATION_POINTS
} from '../utils/score-explainer.js';

const REPO_COMMIT_BASE = 'https://github.com/Sudo-Ali-Dev/Rankistan/commit';
const CONFIG_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/score-config.json';
const DESIGN_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/docs/scoring.md';

// The current formula is read from the model's config. The timeline entries
// below are history and keep the numbers they had at the time. This page is
// about how a score is calculated, so changes to who is searched for or how
// the board is stored belong elsewhere.
const { SCALE, WINDOW_DAYS } = SCORE_CONFIG;

const INTRO_BULLETS = [
  {
    label: 'Only public repositories count',
    text: `Your score looks at your activity in public repositories on GitHub in the last ${WINDOW_DAYS} days. Activity in private repositories is shown on your card but earns nothing, because nobody can check it.`,
  },
  {
    label: 'What earns nothing',
    text: 'Followers, the number of repositories you have, the age of your account, and stars on repositories you are not working on.',
  },
  {
    label: 'Why it is fair',
    text: 'Doing a lot in one day still counts as one day, so spamming does not help. To reach the top, other developers have to accept your open source contributions.',
  },
  {
    label: 'Check any score',
    text: 'Every developer\'s file lists exactly what was counted, with links to GitHub. Register shows your score before you join.',
  },
];

const CONSTANTS_ACROSS_ERAS = [
  'Only activity in public repositories counts.',
  `Activity is measured over the last ${WINDOW_DAYS} days.`,
];

const EVOLUTION_ENTRIES = [
  {
    id: 'v1-flat',
    date: '2026-03-21',
    title: 'Everything counted the same',
    summary: 'Every kind of activity earned the same points.',
    commit: 'a34ea46',
    formula: 'base = min(stars, 2000)×2 + events_30d×3 + followers×1 + public_repos×0.5',
    changes: [
      'Your score added up stars, followers, the number of repositories you had, and your activity in the last 30 days.',
      'Every push, pull request, issue or release earned the same 3 points.',
      'Stars counted up to 2,000. Accounts younger than 6 months got half the score.',
    ],
    reasoning:
      'It was easy to understand, but doing more beat doing better. A small push counted as much as a release.',
  },
  {
    id: 'v2-per-type',
    date: '2026-05-05',
    title: 'Bigger contributions count more',
    summary: 'Releases and pull requests earned more than pushes.',
    commit: 'b93d39c',
    formula: 'activity = releases×5 + PRs×4 + pushes×2 + issues×1.5 (30d totals)',
    changes: [
      'Releases earned 5 points, pull requests 4, pushes 2 and issues 1.5.',
      'Everything was still added up over the whole month, with no limit per day.',
    ],
    reasoning:
      'Shipping a release matters more than a small push. But someone could still flood one kind of activity in a single day.',
  },
  {
    id: 'v3-star-cap',
    date: '2026-05-05',
    title: 'Stars capped at 250',
    summary: 'Stars could add at most 500 points.',
    commit: 'c763841',
    formula: 'max star contribution = 250 × 2 = 500 points',
    changes: [
      'Only the first 250 stars counted, down from 2,000.',
      'Very popular projects no longer won on stars alone.',
    ],
    reasoning: 'Rankistan ranks people who build, not people who are famous.',
  },
  {
    id: 'v4-follower-cap',
    date: '2026-05-06',
    title: 'Followers capped at 500',
    summary: 'Followers could add at most 500 points.',
    commit: '3a40c9b',
    formula: 'max follower contribution = 500 × 1 = 500 points',
    changes: ['Followers above 500 no longer added points.'],
    reasoning: 'Having followers is not the same as doing open source work.',
  },
  {
    id: 'v7-diminishing',
    date: '2026-05-23',
    title: 'Daily limits',
    summary: 'Doing a lot in one day earned less and less.',
    commit: null,
    formula: 'marginal(n) = base / log2(n+1) per type per UTC day, daily cap, sum over 30 days',
    changes: [
      'Activity was scored day by day instead of as one total for the month.',
      'Each extra event on the same day earned less than the one before, and each kind of activity had a daily limit.',
      'Pushes could earn up to 15 points a day, issues 15, pull requests 25 and releases 20.',
    ],
    example:
      'One account made 199 releases in a single day. Before, that was worth about 995 points. With daily limits it was worth about 20.',
    reasoning: 'Steady work across the month should beat a burst on one day.',
  },
  {
    id: 'v10-contributions',
    date: '2026-10-16',
    title: 'Scoring v3, ranked by real work',
    summary: 'Every score changed. You now earn points for the days you are active and for open source contributions other developers accept.',
    commit: '343de1b',
    formula: 'score = active days (up to 500) + open source contributions (up to 400) + stars (up to 100)',
    changes: [
      'Active days, up to 500 points. Every day you are active in public repositories in the last 30 counts once. A hundred commits on one day count the same as one.',
      'Open source contributions, up to 400 points. You earn them when another developer merges your pull request into their open source project, when you review another developer\'s pull request, or when you merge another developer\'s pull request into your own repository.',
      'Stars, up to 100 points. Stars on your own repository, but only one you worked on this month and only from 10 stars up.',
      'Followers, the number of repositories you have and the age of your account no longer earn points. New accounts are no longer cut in half.',
      'Work that can be faked does not count. That means commits a bot made in your name, commits with impossible dates, and repositories where a script commits for you.',
      'Your whole month is now read, not just your last 200 events, so busy developers are measured fairly.',
      'Equal scores share the same rank.',
    ],
    example:
      'One account made over a million commits in a month, almost all of them on one day. Under version 3 each of those days counts once, like any other active day. Only 3 of the old top 50 are still in the top 50, because stars and followers no longer decide the order.',
    reasoning:
      'Version 2 promised to rank active developers, but stars and followers decided who was on top. Version 3 ranks people by how active they are and by the open source contributions other developers accept.',
  },
  {
    id: 'v11-review-panel',
    date: '2026-10-16',
    title: 'Scoring v3.1, harder to game',
    summary: 'Six independent checks of v3 against the real board found a few things too easy. They were fixed the same day.',
    commit: null,
    formula: 'score = active days (up to 500) + open source contributions (up to 400) + stars (up to 100)',
    changes: [
      'Each further project or person counts a little less than the one before. Many one-line fixes spread over many projects no longer beat deep work in one project.',
      'One person can only give you so much. A friend who merges your pull requests, whose pull requests you review and who sends pull requests to your repository counts once, not three times.',
      'A review by someone with no role in the project counts as if the project had no stars, so a quick review cannot borrow a famous project\'s standing.',
      'If most of your pull requests to other projects are closed without being merged, your open source points shrink in proportion. Closing your own pull requests at work no longer counts against you.',
      'A pull request you merged yourself now counts when another developer approved it first, the way most companies work.',
      'Commits made by a bot named like "Repo Health Bot" are caught, gh-pages commits are checked too, and commits GitHub counts that are missing from the repository no longer count.',
      'Recent days still count more, now by the same small step each day, which makes exact ties rare.',
    ],
    example:
      'Measured on the whole board, 9 of the top 10 and 46 of the top 50 stay. A developer with 66 large pull requests merged into one project moves from 9th to 5th, and one with 62 small fixes across 52 projects from 8th to 13th. Developers whose colleagues approved their pull requests move up, one from 70th to 23rd. Exact ties fall from 392 rows to 33.',
    reasoning:
      'The checks agreed that v3 was the right idea and much fairer than v2, but thirty quick reviews of strangers\' pull requests could reach the top of the board, and one friend could add hundreds of points. Each fix closes one of those without costing honest developers.',
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
            How your score is calculated today, and how the rules changed over time to reward steady
            activity and open source contributions, not bursts or fame.
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
            <div className="text-primary">score = active days + open source contributions + stars</div>
            <div className="text-tertiary mt-2">
              up to {WORK_POINTS} + up to {COLLABORATION_POINTS} + up to {APPRECIATION_POINTS} = {SCALE.toLocaleString('en-US')} points
            </div>
            <div className="text-outline mt-3 text-[11px]">
              The exact formula, with every rule and the reason for it, is in{' '}
              <a href={DESIGN_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                docs/scoring.md
              </a>
            </div>
          </div>
          <div className="mb-4">
            <ScoreExplainer />
          </div>
          <p className="mb-4 font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed">{SCORE_ELIGIBILITY}</p>
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
