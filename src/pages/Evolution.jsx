import React from 'react';

const REPO_COMMIT_BASE = 'https://github.com/Sudo-Ali-Dev/Rankistan/commit';
const CONFIG_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/score-config.json';
const SCORING_VERSION = '2.0.0';
const LAST_DOCUMENTED = 'May 2026';

const INTRO_BULLETS = [
  {
    label: 'Open source only',
    text: 'Stars come from your public repositories. Activity uses public Push, Pull Request, Issue, and Release events from the last 30 days.',
  },
  {
    label: 'What does not count',
    text: 'Watching, starring, forking, and commenting on repos do not affect your score or contribution gates.',
  },
  {
    label: 'Fairness',
    text: 'Stars and followers are capped so fame metrics cannot drown out builders. Steady work across many days beats one-day bursts.',
  },
  {
    label: 'Score vs rank',
    text: 'Register shows an estimated score right away. Your official leaderboard rank updates after the next hourly batch sync.',
  },
];

const FORMULA_PLAIN_ENGLISH = [
  'Stars, followers, and public repos are capped (250 stars, 500 followers, 200 repos) before weights are applied.',
  'Activity points use diminishing returns per UTC calendar day—spamming the same event type in one day earns very little.',
  'Accounts younger than 6 months receive half the base score (0.5× multiplier).',
];

const CONSTANTS_ACROSS_ERAS = [
  'Only Push, Pull Request, Issue, and Release events count toward activity.',
  'Activity is scored over the last 30 days, grouped by UTC day, with a daily cap per event type.',
  'The leaderboard may show a raw 30-day event count—that number can be higher than the capped activity points in your score.',
  'Accounts under 6 months old get a 0.5× multiplier on the full base score.',
];

const BEHIND_THE_SCENES = [
  {
    text: 'All weights and caps live in one config file so the site and batch job stay in sync.',
    commit: 'a5ec558',
  },
  {
    text: 'Register previews your score with the same rules before you appear on the official board.',
    commit: '219b54a',
  },
  {
    text: 'Older leaderboard rows without per-type event data use a neutral average until the next batch refresh.',
    commit: '842b9a6',
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
];

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
            How Rankistan calculates your score—and why the rules changed over time to reward steady
            open-source work, not bursts or fame metrics.
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
                <span className="text-on-surface font-medium">{label}</span>
                <span className="text-outline"> — {text}</span>
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
              base_score = (min(stars, 250) × 2) + activity_score + (min(followers, 500) × 1) + (min(public_repos, 200) × 0.5)
            </div>
            <div className="text-tertiary mt-2">
              final_score = round(base_score × (account_age &lt; 6mo ? 0.5 : 1.0))
            </div>
            <div className="text-outline mt-3 text-[11px]">
              activity_score = Σ daily min(cap, Σ base / log2(n+1)) over 30d, per type, UTC days
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
                <li key={commit} className="font-body text-xs sm:text-sm text-outline leading-relaxed flex flex-wrap items-baseline gap-2">
                  <span>{text}</span>
                  <a
                    href={`${REPO_COMMIT_BASE}/${commit}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] text-primary hover:underline shrink-0"
                  >
                    {commit}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="p-4 border border-outline-variant/50 bg-surface-container-low font-mono text-[10px] text-outline uppercase tracking-widest leading-relaxed">
            <p>
              Scoring version: {SCORING_VERSION} · Last documented: {LAST_DOCUMENTED}
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
