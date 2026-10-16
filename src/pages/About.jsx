import React, { useState } from 'react';
import Contributors from '../components/Contributors';
import ScoreExplainer from '../components/ScoreExplainer';
import { SCORE_CONFIG } from '../model/config.js';
// The list discovery searches, read from the pipeline itself, so this page names exactly the
// cities that are searched.
import { CITY_TERMS } from '../../scripts/discovery/locations.js';

// Every number in the scoring copy below comes from the model's config (score-config.json), so
// the page cannot describe a formula the pipeline is not running.
const DESIGN_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/docs/scoring.md';
const { SCALE, WEIGHTS, WINDOW_DAYS, WORK, COLLABORATION, MIN_ACCOUNT_AGE_DAYS } = SCORE_CONFIG;
const WORK_POINTS = Math.round(SCALE * WEIGHTS.work);
const COLLABORATION_POINTS = Math.round(SCALE * WEIGHTS.collaboration);
const APPRECIATION_POINTS = Math.round(SCALE * WEIGHTS.appreciation);
const COUNTERPARTY_YEARS = COLLABORATION.COUNTERPARTY_MIN_AGE_DAYS / 365;
const COUNTERPARTY_AGE = Number.isInteger(COUNTERPARTY_YEARS)
  ? `${COUNTERPARTY_YEARS === 1 ? 'a year' : `${COUNTERPARTY_YEARS} years`}`
  : `${COLLABORATION.COUNTERPARTY_MIN_AGE_DAYS} days`;

const ACTIVITY_FILTERS = [
  { label: `Active days in the last ${WINDOW_DAYS}`, threshold: `>= ${WORK.GATE_MIN_DAYS}`, icon: 'code' },
  { label: 'Account age', threshold: `>= ${MIN_ACCOUNT_AGE_DAYS} days`, icon: 'calendar_month' },
  { label: 'Location names Pakistan or a Pakistani city, or you registered', threshold: 'Required', icon: 'location_on' }
];

const WORKING_DAY_KINDS = ['Commit to a public repository', 'Pull request on a repository you do not own', 'Issue on a repository you do not own', "Review of another developer's pull request"];

const CITY_NAMES = CITY_TERMS.map((city) => city[0].toUpperCase() + city.slice(1)).join(', ');

const PIPELINE_STEPS = [
  { step: '01', title: 'DISCOVER', icon: 'search', desc: `Search GitHub for Pakistani developers in 24 batches by account creation date: location:pakistan, and a second search for locations that name one of ${CITY_TERMS.length} Pakistani cities without the country. Each search is cut into slices small enough to list whole, so the 1,000-result search cap never truncates one. Developers neither search finds can register by GitHub issue instead, and are evaluated in the batch that covers their account's creation date.` },
  { step: '02', title: 'MEASURE', icon: 'download', desc: `Look at each candidate's public GitHub activity in the last ${WINDOW_DAYS} days. That is every day with a commit, every pull request, issue and review, and every pull request another developer merged.` },
  { step: '03', title: 'FILTER', icon: 'filter_alt', desc: `Keep developers with at least ${WORK.GATE_MIN_DAYS} active days in the last ${WINDOW_DAYS} and an account at least ${MIN_ACCOUNT_AGE_DAYS} days old. Drop commits that cannot be their own work, like commits with impossible dates or made by a bot in their name.` },
  { step: '04', title: 'SCORE', icon: 'calculate', desc: `Add active days, open source contributions and stars into a score out of ${SCALE.toLocaleString('en-US')}. Every run scores the whole board again, so nobody keeps an old number.` },
  { step: '05', title: 'MERGE', icon: 'merge', desc: 'Merge scored developers into the leaderboard using per-batch replacement. Anyone who opted out is removed first, whichever batch holds their row. Deduplicate, re-sort, re-rank.' },
  { step: '06', title: 'DEPLOY', icon: 'rocket_launch', desc: 'Build the frontend and deploy to GitHub Pages. Leaderboard, map, and all pages update automatically.' },
];

const SCANNER_METRICS = [
  {
    value: '34,838',
    label: 'Profiles Searched',
    desc: `Every account from 2000 to the present whose location says Pakistan or names one of ${CITY_TERMS.length} Pakistani cities, counted on 13 October 2026, split across 24 hourly batches.`
  },
  {
    value: 'Daily',
    label: 'Every Profile Screened',
    desc: 'Each is checked on its contribution calendar first. Only those who could qualify are measured in full and scored.'
  },
  {
    value: 'Strict',
    label: 'Ranking Gate',
    desc: `Only developers with ${WORK.GATE_MIN_DAYS} or more active days in the last ${WINDOW_DAYS} are ranked.`
  }
];

const AI_SUMMARY_STEPS = [
  {
    step: '01',
    title: 'Expand Trigger',
    lane: 'CLIENT',
    desc: 'Summary generation starts only when a user expands a developer card and no cached summary exists.'
  },
  {
    step: '02',
    title: 'Frontend Request',
    lane: 'CLIENT',
    desc: 'The client sanitizes developer metadata and sends it to the summary Worker endpoint with timeout and retry control.'
  },
  {
    step: '03',
    title: 'Worker Guardrails',
    lane: 'EDGE',
    desc: 'Cloudflare Worker applies CORS, per-IP rate limiting, payload sanitization, and keeps API keys server-side.'
  },
  {
    step: '04',
    title: 'Groq Generation',
    lane: 'MODEL',
    desc: 'Worker calls Groq with a structured prompt to produce a concise two-sentence technical profile summary.'
  },
  {
    step: '05',
    title: 'Validation + Cache',
    lane: 'EDGE',
    desc: 'Summary text is validated, trimmed, and cached per username so repeated card opens are fast and cheap.'
  }
];

const FAQ = [
  { q: 'How often is the leaderboard updated?', a: 'Every hour. A Cloudflare Worker\'s cron triggers the GitHub Actions workflow at the top of each hour, one batch per hour and 24 a day, with a backup at half past that runs only if the hour was missed. Each developer is measured again once a day, and the whole board is scored again from its measurements on every run.' },
  { q: 'Why am I not on the leaderboard?', a: `You need at least ${WORK.GATE_MIN_DAYS} active days in the last ${WINDOW_DAYS} and an account at least ${MIN_ACCOUNT_AGE_DAYS} days old. The pipeline also has to find you. Your GitHub location must say "Pakistan" or name one of ${CITY_TERMS.length} Pakistani cities (${CITY_NAMES}), or you register by GitHub issue from the Register tab. Some city names are not searched because they mostly mean somewhere else ("Hyderabad" alone is usually Hyderabad, India), so if yours is one of them, add "Pakistan" or register. The board shows the top 1,000.` },
  { q: 'What counts as an active day?', a: "Any day you made a commit to a public repository, opened a pull request or issue on a repository you do not own, or reviewed another developer's pull request. A day counts once, so a thousand commits in a day count the same as one. Commits to forks and profile README repositories do not count, and neither do stars, forks, watches or comments." },
  { q: 'Why is my score lower than expected?', a: `Being active every day earns at most ${WORK_POINTS} points. The other ${(SCALE - WORK_POINTS).toLocaleString('en-US')} come from open source contributions other developers accepted and from stars on a repository you are working on. Followers and how many repositories you have earn nothing, and activity in private repositories is not counted because nobody outside can check it.` },
  { q: 'Does my account\'s age matter?', a: `Only to get on the board. Your account must be at least ${MIN_ACCOUNT_AGE_DAYS} days old, and after that its age changes nothing. The developer who merges your pull request, or whose pull request you review, must have an account at least ${COUNTERPARTY_AGE} old, so a brand new second account cannot boost you.` },
  { q: 'Can my score be gamed?', a: 'Not easily. Doing a lot in one day still counts as one day. Commits with impossible dates or made by a bot in your name are dropped automatically. A script that commits for you every day is found by a person reading the commits and listed in public at rankistan.dev/moderation.json, with the evidence. Merges by yourself, by a bot or by a brand new account earn nothing.' },
  { q: 'Can I see exactly what my score was computed from?', a: 'Yes. Every developer\'s file on the site lists each day and each pull request, review and merge that counted, with a link to it on GitHub. The Register tab shows any account\'s score right now, with the same code the board uses.' },
  { q: 'How does the scanner work at scale?', a: 'Rankistan runs a rolling daily scanner from year 2000 to present. It searches about 34,800 profiles (26,002 that say Pakistan and 8,836 that name only a Pakistani city, counted on 13 October 2026). It reads every candidate\'s contribution calendar, measures in full only those who could qualify, then applies the eligibility gate before ranking.' },
  { q: 'How does AI summary generation work?', a: 'It is on-demand only. Expanding a card triggers a request to the Cloudflare Worker, which rate-limits and sanitizes input, calls Groq, validates output, and returns a cached summary per username.' },
  { q: 'How does the Developer Map work?', a: 'The map uses deterministic location normalization with city aliases and token-aware matching, then maps developers to canonical Pakistani city keys. Unknowns fall back to Pakistan.' },
  { q: 'Can I register manually?', a: `Yes, by opening a Register issue on GitHub (linked from the Register tab). It is for developers whose GitHub location does not say Pakistan or one of the searched cities, and it replaces only that check. You still need ${WORK.GATE_MIN_DAYS} active days in the last ${WINDOW_DAYS}. The account that opens the issue is the account registered, so you can only register yourself.` },
  { q: 'How do I take myself off the leaderboard?', a: 'Open a Remove me issue on GitHub (linked from the Register tab). You are removed at the next pipeline run, whichever batch your row is in, and are not measured again while the opt-out stands. Only the account that opens the issue is removed, and a later Register issue reverses it.' },
  { q: 'Is this open source?', a: 'Yes. The full Rankistan codebase, meaning the pipeline scripts, the scoring model and the frontend, is on GitHub at github.com/Sudo-Ali-Dev/Rankistan.' },
];

export default function About({ onChangeTab }) {
  const [openFaq, setOpenFaq] = useState(null);

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 md:py-12 relative z-10">

        {/* Hero */}
        <div className="mb-8 border-l-4 border-primary pl-4 sm:mb-12 sm:pl-6">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-on-surface mb-2">
            About <span className="text-primary font-normal tracking-normal ml-1 sm:ml-2 inline-block align-middle translate-y-0.5 sm:-translate-y-[0.16em] text-[1.08em]" style={{ fontFamily: "'Waltograph', 'Space Grotesk', sans-serif" }}>Rankistan</span>
          </h1>
          <p className="font-mono text-xs sm:text-sm text-outline max-w-xl uppercase tracking-widest leading-relaxed">
            System documentation for the Pakistani developer tracking infrastructure.
          </p>
        </div>

        {/* Owner & Contributors */}
        <div className="mb-8 sm:mb-12">
          <Contributors />
        </div>

        {/* Intro Card */}
        <div className="border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8 mb-8 sm:mb-12">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">System_Overview</span>
          </div>
          <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed max-w-3xl">
            Rankistan is an automated leaderboard that discovers, tracks, and ranks active Pakistani developers on GitHub.
            The pipeline runs every hour as a rolling daily scanner across historical and modern GitHub accounts.
            It searches about 34,800 profiles a day, screens every one, and ranks developers by their activity in public repositories in the last {WINDOW_DAYS} days.
            Developers the location search cannot find can register themselves by GitHub issue, and anyone can opt out the same way. Followers and repository counts never count. Work does.
          </p>
        </div>

        {/* Pipeline */}
        <div className="mb-8 sm:mb-12">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
            <span className="material-symbols-outlined text-primary">settings</span>
            <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">The Pipeline</h2>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// How It Works</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 border border-outline-variant">
            {PIPELINE_STEPS.map((s, i) => (
              <div
                key={s.step}
                className={`p-4 sm:p-6 bg-surface-container-lowest hover:bg-surface-container-low transition-colors ${
                  i < PIPELINE_STEPS.length - 1 ? 'border-b md:border-b lg:border-b' : ''
                } ${i % 2 !== 1 ? 'md:border-r lg:border-r-0' : 'md:border-r-0'} ${i % 3 !== 2 ? 'lg:border-r' : 'lg:border-r-0'} border-outline-variant`}
              >
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-3">
                  <span className="font-mono text-[10px] text-on-primary bg-primary px-2 py-0.5">{s.step}</span>
                  <span className="material-symbols-outlined text-primary text-sm">{s.icon}</span>
                  <span className="font-headline text-xs sm:text-sm font-bold uppercase tracking-tight">{s.title}</span>
                </div>
                <p className="font-body text-xs text-outline leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Scanner Scale */}
        <div className="mb-8 sm:mb-12 border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 sm:mb-5">
            <span className="material-symbols-outlined text-primary">travel_explore</span>
            <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">Scanner Pipeline</h2>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// Daily Full Cycle</span>
          </div>
          <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed max-w-4xl">
            Rankistan runs as a high-volume daily scanner from account-year 2000 to present.
            It does broad discovery first, then selective rescoring, then strict eligibility gating before publishing.
            The process is intentionally heavy so ranking changes reflect real developer work, and a burst of commits on one day counts as one day.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 mt-4 sm:mt-6">
            {SCANNER_METRICS.map((metric) => (
              <div key={metric.label} className="border border-outline-variant bg-surface p-3 sm:p-4">
                <div className="font-headline text-xl sm:text-2xl font-bold text-primary mb-1">{metric.value}</div>
                <div className="font-mono text-[10px] text-tertiary uppercase tracking-widest mb-2">{metric.label}</div>
                <p className="font-body text-xs text-outline leading-relaxed">{metric.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* AI Summary System */}
        <div className="mb-8 sm:mb-12 border border-outline-variant bg-surface overflow-hidden">
          <div className="px-4 py-4 sm:px-6 sm:py-6 border-b border-outline-variant bg-surface-container-low">
            <div className="flex items-start justify-between gap-3 sm:gap-4 flex-wrap mb-3 sm:mb-4">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <span className="material-symbols-outlined text-tertiary shrink-0">auto_awesome</span>
                <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase text-on-surface">AI Summary System</h2>
              </div>
              <span className="font-mono text-[10px] text-outline uppercase tracking-widest shrink-0">// On Demand</span>
            </div>

            <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed max-w-4xl mb-3 sm:mb-4">
              AI summaries are not precomputed in bulk. They are generated only when a user expands a developer card,
              then cached so future views are fast. This keeps costs controlled while still providing contextual intelligence.
            </p>

            <div className="flex flex-wrap gap-2">
              <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest border border-outline-variant px-2 py-1 bg-surface">Triggered on card expand</span>
              <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest border border-outline-variant px-2 py-1 bg-surface">Worker guarded</span>
              <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest border border-outline-variant px-2 py-1 bg-surface">Cached per username</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr]">
            <aside className="border-b lg:border-b-0 lg:border-r border-outline-variant bg-surface-container-lowest p-4 sm:p-5">
              <span className="font-mono text-[10px] text-outline uppercase tracking-widest">Execution Profile</span>
              <div className="mt-4 space-y-2">
                <div className="border border-outline-variant/50 bg-surface px-3 py-2">
                  <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Mode</div>
                  <div className="font-headline text-sm font-bold text-on-surface mt-1">On-Demand Only</div>
                </div>
                <div className="border border-outline-variant/50 bg-surface px-3 py-2">
                  <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Guardrails</div>
                  <div className="font-headline text-sm font-bold text-on-surface mt-1">Rate Limited</div>
                </div>
                <div className="border border-outline-variant/50 bg-surface px-3 py-2">
                  <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Output</div>
                  <div className="font-headline text-sm font-bold text-on-surface mt-1">2-Sentence Summary</div>
                </div>
              </div>
            </aside>

            <div className="p-4 sm:p-6 bg-surface overflow-hidden">
              <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Request Path</div>
              <div className="relative pl-6 sm:pl-8">
                <span className="absolute left-[7px] sm:left-[11px] top-1 bottom-1 w-px bg-outline-variant"></span>
                <div className="space-y-3">
                  {AI_SUMMARY_STEPS.map((item) => (
                    <div key={item.step} className="relative border border-outline-variant/60 bg-surface-container-lowest px-3 py-2.5 sm:px-4 sm:py-3 hover:bg-surface-container-low transition-colors">
                      <span className="absolute -left-[18px] sm:-left-[26px] top-5 w-2.5 h-2.5 rounded-full bg-tertiary border-2 border-surface"></span>
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="font-mono text-[10px] text-on-primary bg-primary px-2 py-0.5">{item.step}</span>
                        <span className="font-headline text-xs sm:text-sm font-bold uppercase tracking-tight text-on-surface">{item.title}</span>
                        <span className="font-mono text-[9px] text-outline border border-outline-variant px-2 py-0.5 tracking-widest bg-surface">{item.lane}</span>
                      </div>
                      <p className="font-body text-xs text-outline leading-relaxed">{item.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Scoring + Filters side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant mb-8 sm:mb-12">

          {/* Scoring */}
          <div className="lg:col-span-7 p-4 sm:p-6 lg:p-8 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant">
            <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
              <span className="material-symbols-outlined text-tertiary">calculate</span>
              <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">How Your Score Works</h2>
            </div>

            <div className="overflow-x-auto bg-surface-container-low border border-outline-variant p-3 sm:p-5 mb-4 sm:mb-6 font-mono text-xs sm:text-sm leading-relaxed">
              <div className="text-primary">score = active days + open source contributions + stars</div>
              <div className="text-tertiary mt-2">
                up to {WORK_POINTS} + up to {COLLABORATION_POINTS} + up to {APPRECIATION_POINTS} = {SCALE.toLocaleString('en-US')} points
              </div>
              <div className="text-outline mt-3 text-[11px]">
                The exact formula, with every rule and the reason for it, is in{' '}
                <a href={DESIGN_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  docs/scoring.md
                </a>
              </div>
            </div>

            <ScoreExplainer />

            <div className="mt-4 sm:mt-6 p-3 sm:p-4 border-l-2 border-tertiary bg-tertiary/5">
              <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">Not Scored</span>
              <p className="font-body text-xs text-outline leading-relaxed mt-1">
                <span className="text-on-surface font-bold">Followers</span>, <span className="text-on-surface font-bold">repository counts</span> and <span className="text-on-surface font-bold">account age</span> never earn points.
                 Activity in <span className="text-on-surface font-bold">private repositories</span> is shown on your card but not scored, because nobody outside can check it.
                Commits to <span className="text-on-surface font-bold">forks</span> and <span className="text-on-surface font-bold">profile README repositories</span>, commits with impossible dates or made by a bot in your name, and repositories on the public moderation list do not count.
              </p>
            </div>

            {typeof onChangeTab === 'function' && (
              <button
                type="button"
                onClick={() => onChangeTab('evolution')}
                className="mt-4 sm:mt-6 font-mono text-xs text-primary hover:text-tertiary transition-colors flex items-center gap-1 group"
              >
                View full scoring evolution
                <span className="material-symbols-outlined text-sm group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="lg:col-span-5 p-4 sm:p-6 lg:p-8 bg-surface">
            <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
              <span className="material-symbols-outlined text-secondary">filter_alt</span>
              <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">Activity Filters</h2>
            </div>
            <p className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4 sm:mb-6">
              All checks must pass to be ranked.
            </p>

            <div className="space-y-3">
              {ACTIVITY_FILTERS.map(f => (
                <div key={f.label} className="flex items-start gap-3 p-2.5 sm:p-3 border border-outline-variant/50 bg-surface-container-lowest hover:border-outline-variant transition-colors">
                  <span className="material-symbols-outlined text-primary text-sm mt-0.5 shrink-0">{f.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-body text-xs text-on-surface leading-relaxed">{f.label}</div>
                    <div className="font-mono text-[10px] text-tertiary mt-0.5">{f.threshold}</div>
                  </div>
                  <span className="font-mono text-[10px] text-tertiary shrink-0">[REQ]</span>
                </div>
              ))}
            </div>

            <div className="mt-4 sm:mt-6 p-3 bg-surface-container-low border border-outline-variant/50">
              <span className="font-mono text-[10px] text-outline uppercase tracking-widest">An Active Day Is Any Of</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {WORKING_DAY_KINDS.map(e => (
                  <span key={e} className="font-mono text-[9px] text-primary bg-primary/10 px-2 py-1">{e}</span>
                ))}
              </div>
              <p className="font-mono text-[9px] text-outline/60 mt-2 uppercase leading-relaxed">
                A day counts once, however much you did. Stars, forks, watches and comments do not count.
              </p>
            </div>
          </div>
        </div>

        {/* Batches */}
        <div className="mb-8 sm:mb-12 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-primary mb-4">schedule</span>
            <div className="text-2xl sm:text-3xl font-headline font-bold text-primary mb-1">24</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Batches / Day</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Developers are split into 24 groups by account creation date. One batch runs per hour, cycling through all groups in 24 hours.</p>
          </div>
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-tertiary mb-4">update</span>
            <div className="text-2xl sm:text-3xl font-headline font-bold text-tertiary mb-1">1hr</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Update Interval</h4>
            <p className="font-body text-xs text-outline leading-relaxed">A Cloudflare Worker's cron triggers the pipeline via GitHub's workflow_dispatch API every hour, with a backup at half past.</p>
          </div>
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-secondary mb-4">dns</span>
            <div className="text-2xl sm:text-3xl font-headline font-bold text-secondary mb-1">≤100</div>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Devs / Request</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Each batch's date range is cut into slices that fit one 100-result request, so none comes near GitHub's 1,000-result search cap. A slice counts only if it lists completely.</p>
          </div>
        </div>

        {/* FAQ */}
        <div className="mb-8 sm:mb-12">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
            <span className="material-symbols-outlined text-primary">help</span>
            <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">Frequently Asked</h2>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// {FAQ.length} Questions</span>
          </div>
          <div className="border border-outline-variant">
            {FAQ.map((item, i) => (
              <div key={i} className={`${i > 0 ? 'border-t border-outline-variant' : ''}`}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full min-h-11 text-left px-4 py-3 sm:px-6 sm:py-4 flex items-start sm:items-center justify-between gap-3 hover:bg-surface-container-low transition-colors bg-surface-container-lowest"
                >
                  <span className="flex items-start sm:items-center gap-2 sm:gap-3 min-w-0">
                    <span className="font-mono text-[10px] text-outline w-6 shrink-0 pt-0.5 sm:pt-0">{String(i + 1).padStart(2, '0')}</span>
                    <span className="font-headline text-xs sm:text-sm font-bold tracking-tight leading-snug">{item.q}</span>
                  </span>
                  <span className={`material-symbols-outlined text-outline text-sm shrink-0 transition-transform duration-200 ${openFaq === i ? 'rotate-45' : ''}`}>add</span>
                </button>
                {openFaq === i && (
                  <div className="px-4 pb-3 pt-2 sm:px-6 sm:pb-4 bg-surface-container-lowest border-t border-outline-variant/30">
                    <p className="font-body text-xs text-outline leading-relaxed sm:ml-9">{item.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Open Source CTA */}
        <div className="border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8 text-center">
          <span className="material-symbols-outlined text-primary text-2xl sm:text-3xl mb-4">code</span>
          <h3 className="font-headline text-base sm:text-lg font-bold tracking-tighter uppercase mb-2">Fully Open Source</h3>
          <p className="font-body text-xs text-outline leading-relaxed max-w-lg mx-auto mb-4 sm:mb-6 px-2 sm:px-0">
            The pipeline scripts, scoring algorithm, and frontend are all on GitHub. Inspect the code, file issues, or contribute.
          </p>
          <a
            href="https://github.com/Sudo-Ali-Dev/Rankistan"
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 bg-primary text-on-primary font-headline font-bold py-3 px-5 sm:px-6 hover:bg-primary-container transition-colors duration-50 active:scale-[0.98]"
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
