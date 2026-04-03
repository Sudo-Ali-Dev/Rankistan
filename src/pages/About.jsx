import React, { useState } from 'react';

const SCORING_WEIGHTS = [
  { field: 'Stars', weight: '× 2', note: 'Capped at 2,000 to prevent outlier dominance' },
  { field: 'Events (30d)', weight: '× 3', note: 'Meaningful contributions in the last 30 days' },
  { field: 'Followers', weight: '× 1', note: 'Community reach' },
  { field: 'Public Repos', weight: '× 0.5', note: 'Breadth of open-source work' },
];

const ACTIVITY_FILTERS = [
  { label: 'Meaningful contributions in 60 days', threshold: '>= 30', icon: 'code' },
  { label: 'Longest inactivity gap', threshold: '<= 30 days', icon: 'schedule' },
  { label: 'Account age', threshold: '>= 30 days', icon: 'calendar_month' },
  { label: 'Public repos', threshold: '> 3', icon: 'folder_open' },
  { label: 'Followers', threshold: '> 1', icon: 'group' },
];

const PIPELINE_STEPS = [
  { step: '01', title: 'DISCOVER', icon: 'search', desc: 'Search GitHub for Pakistani developers via location:pakistan, split into 24 date-range batches to bypass the 1,000-result API cap.' },
  { step: '02', title: 'FETCH', icon: 'download', desc: 'For each developer, fetch profile, up to 200 recent events (2 pages), and all public repositories.' },
  { step: '03', title: 'FILTER', icon: 'filter_alt', desc: 'Apply activity thresholds — contributions, inactivity gaps, account age. Only genuinely active developers pass.' },
  { step: '04', title: 'SCORE', icon: 'calculate', desc: 'Calculate a weighted score from stars, recent activity, followers, and repo count. Apply new-account penalties.' },
  { step: '05', title: 'MERGE', icon: 'merge', desc: 'Merge scored developers into the leaderboard using per-batch replacement. Deduplicate, re-sort, re-rank.' },
  { step: '06', title: 'DEPLOY', icon: 'rocket_launch', desc: 'Build the frontend and deploy to GitHub Pages. Leaderboard, map, and all pages update automatically.' },
];

const FAQ = [
  { q: 'How often is the leaderboard updated?', a: 'Every hour. An external cron service triggers the GitHub Actions workflow 24 times per day — one batch per hour. A full cycle through all developers completes in 24 hours.' },
  { q: 'Why am I not on the leaderboard?', a: 'You need at least 30 meaningful contributions in the last 60 days, no gap longer than 30 days, an account older than 30 days, more than 3 public repos, and more than 1 follower. Your GitHub profile must also include "Pakistan" in the location field.' },
  { q: 'What counts as a "meaningful" contribution?', a: 'Only PushEvents, PullRequestEvents, IssuesEvents, and ReleaseEvents. Starring repos, forking, watching, or commenting do not count toward the contribution threshold.' },
  { q: 'Why is my score lower than expected?', a: 'Stars are capped at 2,000 for scoring purposes. Accounts younger than 6 months receive a 0.5× penalty on their entire score. The score also weighs recent 30-day activity heavily (3× multiplier).' },
  { q: 'What is the "new account penalty"?', a: 'If your GitHub account is less than 6 months old, your final score is halved (multiplied by 0.5). This prevents newly created accounts from dominating the board.' },
  { q: 'How does the Developer Map work?', a: 'The map parses each developer\'s GitHub profile location string and maps it to a known Pakistani city using substring matching. Profiles that can\'t be matched go into "Other / Unresolved".' },
  { q: 'Can I register manually?', a: 'Yes — use the Register tab to enter a GitHub username. It validates the profile against all pipeline criteria and shows you exactly which thresholds you pass or fail.' },
  { q: 'Is this open source?', a: 'Yes. The full Rankistan codebase — pipeline scripts, scoring algorithm, and frontend — is on GitHub at github.com/Sudo-Ali-Dev/pakdev-index.' },
];

export default function About() {
  const [openFaq, setOpenFaq] = useState(null);

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">

        {/* Hero */}
        <div className="mb-12 border-l-4 border-primary pl-6">
          <h1 className="font-headline text-5xl font-extrabold tracking-tighter text-on-surface mb-2">
            About <span className="text-primary font-normal tracking-normal ml-2 inline-block align-middle -translate-y-[0.1em] text-[0.94em]" style={{ fontFamily: "'Waltograph', 'Space Grotesk', sans-serif" }}>Rankistan</span>
          </h1>
          <p className="font-mono text-sm text-outline max-w-xl uppercase tracking-widest">
            System documentation for the Pakistani developer tracking infrastructure.
          </p>
        </div>

        {/* Intro Card */}
        <div className="border border-outline-variant bg-surface-container-lowest p-8 mb-12">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">System_Overview</span>
          </div>
          <p className="font-body text-sm text-on-surface-variant leading-relaxed max-w-3xl">
            Rankistan is an automated leaderboard that discovers, tracks, and ranks active Pakistani developers on GitHub.
            The pipeline runs every hour — scanning profiles, measuring real activity, and updating the board.
            No manual submissions. No vanity metrics. Just code.
          </p>
        </div>

        {/* Pipeline */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <span className="material-symbols-outlined text-primary">settings</span>
            <h2 className="font-headline text-xl font-bold tracking-tighter uppercase">The Pipeline</h2>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// How It Works</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 border border-outline-variant">
            {PIPELINE_STEPS.map((s, i) => (
              <div
                key={s.step}
                className={`p-6 bg-surface-container-lowest hover:bg-surface-container-low transition-colors ${
                  i < PIPELINE_STEPS.length - 1 ? 'border-b md:border-b lg:border-b' : ''
                } ${i % 3 !== 2 ? 'lg:border-r' : ''} ${i % 2 !== 1 ? 'md:border-r lg:border-r-0' : 'md:border-r-0'} ${i % 3 !== 2 ? 'lg:border-r' : 'lg:border-r-0'} border-outline-variant`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="font-mono text-[10px] text-on-primary bg-primary px-2 py-0.5">{s.step}</span>
                  <span className="material-symbols-outlined text-primary text-sm">{s.icon}</span>
                  <span className="font-headline text-sm font-bold uppercase tracking-tight">{s.title}</span>
                </div>
                <p className="font-body text-xs text-outline leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Scoring + Filters side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant mb-12">

          {/* Scoring */}
          <div className="lg:col-span-7 p-8 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant">
            <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-tertiary">calculate</span>
              <h2 className="font-headline text-xl font-bold tracking-tighter uppercase">Scoring Formula</h2>
            </div>

            <div className="bg-surface-container-low border border-outline-variant p-5 mb-6 font-mono text-sm leading-relaxed">
              <div className="text-primary">
                base_score = (stars × 2) + (events_30d × 3) + (followers × 1) + (public_repos × 0.5)
              </div>
              <div className="text-tertiary mt-2">
                final_score = base_score × (account_age &lt; 6mo ? 0.5 : 1.0)
              </div>
            </div>

            <div className="space-y-3">
              {SCORING_WEIGHTS.map(w => (
                <div key={w.field} className="flex items-center gap-4 border-b border-outline-variant/30 pb-3">
                  <span className="font-headline text-sm font-bold text-on-surface w-28 shrink-0">{w.field}</span>
                  <span className="font-mono text-xs text-primary bg-primary/10 px-2 py-0.5">{w.weight}</span>
                  <span className="font-body text-xs text-outline">{w.note}</span>
                </div>
              ))}
            </div>

            <div className="mt-6 p-4 border-l-2 border-tertiary bg-tertiary/5">
              <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">Penalty Notice</span>
              <p className="font-body text-xs text-outline leading-relaxed mt-1">
                Accounts younger than <span className="text-on-surface font-bold">6 months</span> receive a <span className="text-on-surface font-bold">0.5×</span> multiplier.
                Stars are capped at <span className="text-on-surface font-bold">2,000</span> before the weight is applied.
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="lg:col-span-5 p-8 bg-surface">
            <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-secondary">filter_alt</span>
              <h2 className="font-headline text-xl font-bold tracking-tighter uppercase">Activity Filters</h2>
            </div>
            <p className="font-mono text-[10px] text-outline uppercase tracking-widest mb-6">
              All checks must pass to appear on the leaderboard.
            </p>

            <div className="space-y-3">
              {ACTIVITY_FILTERS.map(f => (
                <div key={f.label} className="flex items-start gap-3 p-3 border border-outline-variant/50 bg-surface-container-lowest hover:border-outline-variant transition-colors">
                  <span className="material-symbols-outlined text-primary text-sm mt-0.5">{f.icon}</span>
                  <div className="flex-1">
                    <div className="font-body text-xs text-on-surface">{f.label}</div>
                    <div className="font-mono text-[10px] text-tertiary mt-0.5">{f.threshold}</div>
                  </div>
                  <span className="font-mono text-[10px] text-tertiary">[REQ]</span>
                </div>
              ))}
            </div>

            <div className="mt-6 p-3 bg-surface-container-low border border-outline-variant/50">
              <span className="font-mono text-[10px] text-outline uppercase tracking-widest">Meaningful Events Only</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'ReleaseEvent'].map(e => (
                  <span key={e} className="font-mono text-[9px] text-primary bg-primary/10 px-2 py-1">{e}</span>
                ))}
              </div>
              <p className="font-mono text-[9px] text-outline/60 mt-2 uppercase leading-relaxed">
                Stars, forks, watches, and comments do not count.
              </p>
            </div>
          </div>
        </div>

        {/* Batches */}
        <div className="mb-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-primary mb-4">schedule</span>
            <div className="text-3xl font-headline font-bold text-primary mb-1">24</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Batches / Day</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Developers are split into 24 groups by account creation date. One batch runs per hour, cycling through all groups in 24 hours.</p>
          </div>
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-tertiary mb-4">update</span>
            <div className="text-3xl font-headline font-bold text-tertiary mb-1">1hr</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Update Interval</h4>
            <p className="font-body text-xs text-outline leading-relaxed">An external cron service (cron-job.org) triggers the pipeline via GitHub's workflow_dispatch API every hour, reliably.</p>
          </div>
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-secondary mb-4">dns</span>
            <div className="text-3xl font-headline font-bold text-secondary mb-1">~800</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Devs / Batch</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Each batch targets 800–950 developers, staying under GitHub's 1,000-result search API cap. Results merge incrementally.</p>
          </div>
        </div>

        {/* FAQ */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <span className="material-symbols-outlined text-primary">help</span>
            <h2 className="font-headline text-xl font-bold tracking-tighter uppercase">Frequently Asked</h2>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// {FAQ.length} Questions</span>
          </div>
          <div className="border border-outline-variant">
            {FAQ.map((item, i) => (
              <div key={i} className={`${i > 0 ? 'border-t border-outline-variant' : ''}`}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full text-left px-6 py-4 flex items-center justify-between hover:bg-surface-container-low transition-colors bg-surface-container-lowest"
                >
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[10px] text-outline w-6">{String(i + 1).padStart(2, '0')}</span>
                    <span className="font-headline text-sm font-bold tracking-tight">{item.q}</span>
                  </span>
                  <span className={`material-symbols-outlined text-outline text-sm transition-transform duration-200 ${openFaq === i ? 'rotate-45' : ''}`}>add</span>
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-4 pt-2 bg-surface-container-lowest border-t border-outline-variant/30">
                    <p className="font-body text-xs text-outline leading-relaxed ml-9">{item.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Open Source CTA */}
        <div className="border border-outline-variant bg-surface-container-lowest p-8 text-center">
          <span className="material-symbols-outlined text-primary text-3xl mb-4">code</span>
          <h3 className="font-headline text-lg font-bold tracking-tighter uppercase mb-2">Fully Open Source</h3>
          <p className="font-body text-xs text-outline leading-relaxed max-w-lg mx-auto mb-6">
            The pipeline scripts, scoring algorithm, and frontend are all on GitHub. Inspect the code, file issues, or contribute.
          </p>
          <a
            href="https://github.com/Sudo-Ali-Dev/pakdev-index"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 bg-primary text-on-primary font-headline font-bold py-3 px-6 hover:bg-primary-container transition-colors duration-50 active:scale-[0.98]"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            <span className="uppercase tracking-widest">View on GitHub</span>
            <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </a>
        </div>

      </div>
    </main>
  );
}
