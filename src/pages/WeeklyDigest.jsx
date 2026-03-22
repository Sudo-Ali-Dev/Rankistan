import React, { useState, useEffect, useMemo } from 'react';
import { CACHE_KEYS, cache } from '../utils/cache';

function splitDigestText(text) {
  if (!text) return ['', ''];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length < 2) return [text, ''];
  const halfLen = text.length / 2;
  let cumLen = 0;
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < sentences.length; i++) {
    cumLen += sentences[i].length;
    const diff = Math.abs(cumLen - halfLen);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  const splitAt = bestIdx + 1;
  return [
    sentences.slice(0, splitAt).join('').trim(),
    sentences.slice(splitAt).join('').trim()
  ];
}

function computeTechStack(repos) {
  if (!Array.isArray(repos) || repos.length === 0) return [];
  const langCount = {};
  repos.forEach(repo => {
    const lang = repo.language || 'Other';
    langCount[lang] = (langCount[lang] || 0) + 1;
  });
  const total = repos.length;
  return Object.entries(langCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang, count]) => ({
      name: lang.toUpperCase(),
      percentage: Math.round((count / total) * 100)
    }));
}

function getWeekNumber(weekOf) {
  try {
    const parts = (weekOf || '').split(' - ');
    const endStr = (parts[1] || parts[0] || '').trim();
    const date = new Date(endStr);
    if (isNaN(date.getTime())) return '??';
    const start = new Date(date.getFullYear(), 0, 1);
    return String(Math.ceil(((date - start) / 86400000 + start.getDay() + 1) / 7)).padStart(2, '0');
  } catch {
    return '??';
  }
}

function getShortDateRange(weekOf) {
  if (!weekOf) return '---';
  try {
    const parts = weekOf.split(' - ');
    if (parts.length < 2) return weekOf.toUpperCase();
    const startParts = parts[0].trim().split(' ');
    const endParts = parts[1].trim().split(/[, ]+/);
    const startMonth = startParts[0].substring(0, 3).toUpperCase();
    return `${startMonth} ${startParts[1]} - ${endParts[1]}`;
  } catch {
    return weekOf.toUpperCase();
  }
}

const TECH_BAR_COLORS = [
  { bar: 'bg-primary', text: '' },
  { bar: 'bg-secondary', text: '' },
  { bar: 'bg-tertiary', text: '' },
];

export default function WeeklyDigest() {
  const [digestData, setDigestData] = useState(null);
  const [leaderboardData, setLeaderboardData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        let digestPayload;
        try {
          const res = await fetch('./digest.json', { cache: 'no-store' });
          if (res.ok) {
            digestPayload = await res.json();
            cache.set(CACHE_KEYS.DIGEST, digestPayload);
          }
        } catch {
          digestPayload = cache.get(CACHE_KEYS.DIGEST);
        }
        if (!digestPayload) {
          digestPayload = cache.get(CACHE_KEYS.DIGEST);
        }
        setDigestData(digestPayload);

        let lbPayload;
        try {
          const res = await fetch('./data.json', { cache: 'no-store' });
          if (res.ok) {
            lbPayload = await res.json();
            cache.set(CACHE_KEYS.LEADERBOARD, lbPayload);
          }
        } catch {
          lbPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        }
        if (!lbPayload) {
          lbPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        }
        setLeaderboardData(lbPayload || null);
      } catch (e) {
        console.error("Failed to load data", e);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const [textLeft, textRight] = useMemo(
    () => splitDigestText(digestData?.digest_text),
    [digestData?.digest_text]
  );

  const techStack = useMemo(
    () => computeTechStack(digestData?.repos),
    [digestData?.repos]
  );

  const stats = useMemo(() => {
    const leaderboard = leaderboardData?.leaderboard || [];
    const totalActivity = leaderboard.reduce((sum, d) => sum + (d.events_30d || 0), 0);
    const totalDevs = leaderboardData?.total_devs || leaderboard.length || 0;
    const featuredRepos = digestData?.repos?.length || 0;
    return { totalActivity, totalDevs, featuredRepos };
  }, [leaderboardData, digestData]);

  const weekNum = useMemo(() => getWeekNumber(digestData?.week_of), [digestData?.week_of]);
  const dateRange = useMemo(() => getShortDateRange(digestData?.week_of), [digestData?.week_of]);

  const topContributors = useMemo(() => {
    const leaderboard = leaderboardData?.leaderboard || [];
    return leaderboard
      .filter(d => d.username && d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5);
  }, [leaderboardData]);

  const getLangStyles = (lang) => {
    const language = (lang || '').toLowerCase();
    if (language.includes('python') || language.includes('jupyter')) {
      return {
        bg: 'bg-tertiary-container/20',
        border: 'border-tertiary/30',
        text: 'text-tertiary',
        icon: 'database',
        accent: 'group-hover:text-tertiary'
      };
    }
    if (language.includes('javascript') || language.includes('typescript') || language.includes('html') || language.includes('css')) {
      return {
        bg: 'bg-secondary-container/20',
        border: 'border-secondary/30',
        text: 'text-secondary',
        icon: 'language',
        accent: 'group-hover:text-secondary'
      };
    }
    return {
      bg: 'bg-primary-container/20',
      border: 'border-primary/30',
      text: 'text-primary',
      icon: 'code',
      accent: 'group-hover:text-primary'
    };
  };

  return (
    <main className="flex-grow">
      {/* Hero Editorial Section */}
      <section className="relative border-b border-outline-variant bg-surface overflow-hidden">
        <div className="absolute inset-0 terminal-grid opacity-20"></div>
        <div className="scanline"></div>
        <div className="absolute top-0 right-0 p-6 opacity-10 pointer-events-none">
          <pre className="font-mono text-[10px] text-primary leading-none">{'01010000 01000001\n01001011 01000100\n01000101 01010110'}</pre>
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-12 lg:py-20 z-20">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-secondary-container text-on-secondary-container font-mono text-[10px] mb-8 w-fit border border-secondary/30">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-tertiary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-tertiary"></span>
            </span>
            AI_EDITORIAL_ENGINE: {loading ? 'SYNCING' : 'ACTIVE'} // VOL_{weekNum}_RUNNING
          </div>

          <div className="flex flex-col lg:flex-row gap-12">
            <div className="flex-1">
              <h1 className="font-headline text-6xl md:text-9xl font-extrabold text-on-surface leading-[0.85] tracking-tighter uppercase mb-12 hero-title-shadow">
                The Weekly <br />
                <span className="text-primary italic">Source</span>
                <span className="text-primary opacity-50">.</span>
              </h1>

              {loading ? (
                <div className="font-mono text-sm text-outline animate-pulse mb-10">
                  Retrieving contextual analysis array...
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
                  <div className="font-mono text-xs md:text-sm text-outline leading-relaxed border-l border-primary/30 pl-6">
                    {textLeft}
                  </div>
                  <div className="font-mono text-xs md:text-sm text-outline leading-relaxed border-l border-outline-variant pl-6">
                    {textRight}
                  </div>
                </div>
              )}
            </div>

            {/* Technical Sidebar */}
            <div className="lg:w-80 flex flex-col gap-px border border-outline-variant bg-surface-container shrink-0">
              <div className="bg-surface-container-high font-mono py-8 px-4 border-b border-outline-variant">
                <div className="text-[10px] text-primary uppercase mb-1">Session_Metadata</div>
                <div className="flex justify-between items-end">
                  <span className="text-xl font-bold tracking-tighter">
                    {loading ? '...' : `WEEK_${weekNum}`}
                  </span>
                  <span className="text-[10px] text-outline">{loading ? '' : dateRange}</span>
                </div>
              </div>

              <div className="bg-surface-container font-mono py-8 px-4 border-b border-outline-variant">
                <div className="text-[10px] text-outline uppercase mb-2 italic">Activity_Metrics</div>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-[10px]">TOTAL_COMMITS</span>
                    <span className="text-xs text-primary font-bold">
                      {loading ? '---' : stats.totalActivity.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[10px]">NEW_REPOS</span>
                    <span className="text-xs text-secondary font-bold">
                      {loading ? '---' : stats.featuredRepos.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[10px]">ACTIVE_DEVS</span>
                    <span className="text-xs text-tertiary font-bold">
                      {loading ? '---' : stats.totalDevs.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-surface-container font-mono py-8 px-4">
                <div className="text-[10px] text-outline uppercase mb-3 italic">Tech_Stack_Dominance</div>
                <div className="space-y-4">
                  {loading ? (
                    <div className="text-[10px] text-outline animate-pulse">COMPUTING...</div>
                  ) : techStack.map((tech, i) => (
                    <div key={tech.name}>
                      <div className="flex justify-between text-[10px] mb-1">
                        <span>{tech.name}</span>
                        <span>{tech.percentage}%</span>
                      </div>
                      <div className="h-1 bg-surface-container-highest">
                        <div
                          className={`h-full ${TECH_BAR_COLORS[i % TECH_BAR_COLORS.length].bar}`}
                          style={{ width: `${tech.percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-surface-container font-mono py-8 px-4 border-t border-outline-variant">
                <div className="text-[10px] text-outline uppercase mb-3 italic">Top_Contributors_Weekly</div>
                <div className="space-y-4">
                  {loading ? (
                    <div className="text-[10px] text-outline animate-pulse">LOADING...</div>
                  ) : topContributors.map(dev => (
                    <div key={dev.username} className="flex justify-between items-center">
                      <a
                        href={`https://github.com/${dev.username}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary font-bold tracking-tight hover:text-primary-container transition-colors"
                      >
                        @{dev.username}
                      </a>
                      <span className="text-[10px] text-tertiary">{Math.round(dev.score).toLocaleString()} PTS</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Archive / Previous Reports Section */}
      <section className="border-b border-outline-variant bg-surface-container-lowest px-6 py-12">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-primary">history</span>
              <h2 className="font-headline text-xl font-bold uppercase tracking-tighter">PREVIOUS_REPORTS</h2>
            </div>
            <button className="bg-primary text-on-primary px-4 py-2 font-mono text-[10px] uppercase tracking-widest glow-button transition-all">
              VIEW_ALL_ARCHIVES
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="border border-outline-variant bg-surface p-6 font-mono flex flex-col justify-between group hover:border-primary transition-colors cursor-pointer">
              <div>
                <div className="text-[10px] text-primary mb-1 uppercase tracking-[0.2em] font-bold">Released: 14_OCT_2024</div>
                <h3 className="text-on-surface font-headline font-bold text-xl mb-1 group-hover:text-primary transition-colors uppercase tracking-tighter">Weekly Dispatch: Vol_03</h3>
                <div className="text-[12px] text-outline mb-3 font-mono">The Rust Uprising</div>
                <p className="text-[10px] text-outline-variant line-clamp-2">Deep dive into low-level systems adoption across Islamabad's emerging tech clusters.</p>
              </div>
              <div className="mt-4 flex items-center gap-2 text-[10px] text-primary font-bold uppercase tracking-widest">
                <span>Read_Digest</span>
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </div>
            </div>

            <div className="border border-outline-variant bg-surface p-6 font-mono flex flex-col justify-between group hover:border-secondary transition-colors cursor-pointer">
              <div>
                <div className="text-[10px] text-secondary mb-1 uppercase tracking-[0.2em] font-bold">Released: 07_OCT_2024</div>
                <h3 className="text-on-surface font-headline font-bold text-xl mb-1 group-hover:text-secondary transition-colors uppercase tracking-tighter">Weekly Dispatch: Vol_02</h3>
                <div className="text-[12px] text-outline mb-3 font-mono">Karachi FinTech Boom</div>
                <p className="text-[10px] text-outline-variant line-clamp-2">Mapping the rapid growth of transactional microservices in the southern port city.</p>
              </div>
              <div className="mt-4 flex items-center gap-2 text-[10px] text-secondary font-bold uppercase tracking-widest">
                <span>Read_Digest</span>
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </div>
            </div>

            <div className="border border-outline-variant bg-surface p-6 font-mono flex flex-col justify-between group hover:border-tertiary transition-colors cursor-pointer">
              <div>
                <div className="text-[10px] text-tertiary mb-1 uppercase tracking-[0.2em] font-bold">Released: 30_SEP_2024</div>
                <h3 className="text-on-surface font-headline font-bold text-xl mb-1 group-hover:text-tertiary transition-colors uppercase tracking-tighter">Weekly Dispatch: Vol_01</h3>
                <div className="text-[12px] text-outline mb-3 font-mono">Inception_Protocol</div>
                <p className="text-[10px] text-outline-variant line-clamp-2">Initial baseline metrics for the Pakistani open-source ecosystem tracking system.</p>
              </div>
              <div className="mt-4 flex items-center gap-2 text-[10px] text-tertiary font-bold uppercase tracking-widest">
                <span>Read_Digest</span>
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Repository Grid */}
      <section className="px-6 py-12 max-w-7xl mx-auto terminal-grid">
        <div className="flex items-center justify-between mb-8 border-b border-outline-variant pb-4">
          <h2 className="font-headline text-2xl font-bold uppercase tracking-tighter flex items-center gap-3">
            <span className="material-symbols-outlined text-primary">grid_view</span>
            Trending_Repositories
          </h2>
          <div className="font-mono text-xs text-outline uppercase">
            Sorted_by: Velocity
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20 font-mono text-tertiary animate-pulse">
            LOADING_REPO_INDEX...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 border-l border-t border-outline-variant">
            {Array.isArray(digestData?.repos) && digestData.repos.map((repo, idx) => {
              const styles = getLangStyles(repo.language);
              return (
                <div key={`${repo.owner}-${repo.name}-${idx}`} className="flex flex-col h-full border-r border-b border-outline-variant p-6 bg-surface hover:bg-surface-container transition-colors group">
                  <div className="flex justify-between items-start mb-4">
                    <div className={`${styles.bg} ${styles.border} border p-2`}>
                      <span className={`material-symbols-outlined ${styles.text}`}>{styles.icon}</span>
                    </div>
                    <span className={`font-mono text-[10px] ${styles.text} uppercase`}>#{repo.language || 'SYS'}</span>
                  </div>
                  <h3 className={`font-headline text-xl font-bold mb-2 transition-colors truncate ${styles.accent}`}>
                    <a href={repo.url} target="_blank" rel="noreferrer" title={`${repo.owner}/${repo.name}`}>
                      {repo.name}
                    </a>
                  </h3>
                  <p className="text-sm text-on-surface-variant font-body mb-6 h-12 line-clamp-2">
                    {repo.description || "No system description provided."}
                  </p>
                  <div className="flex items-center justify-between mt-auto pt-4">
                    <div className="flex gap-4 font-mono text-xs text-outline">
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">star</span> {repo.stars?.toLocaleString() || 0}
                      </span>
                      <a href={`https://github.com/${repo.owner}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-primary transition-colors truncate max-w-[100px]" title={`Author: ${repo.owner}`}>
                        <span className="material-symbols-outlined text-sm">person</span> {repo.owner}
                      </a>
                    </div>
                    <div className={`text-[10px] ${styles.text} uppercase font-bold tracking-widest`}>
                      Active
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="border-r border-b border-outline-variant p-6 bg-surface-container-lowest flex flex-col items-center justify-center text-center group cursor-pointer border-dashed min-h-[250px]">
              <span className="material-symbols-outlined text-4xl text-outline group-hover:text-primary transition-colors mb-4">add</span>
              <h3 className="font-headline text-lg font-bold uppercase tracking-widest">Register_Your_Repo</h3>
              <p className="text-xs text-outline font-mono mt-2">Get featured in the next digest</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
