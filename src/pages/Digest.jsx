import React, { useEffect, useState, useMemo } from 'react';

function formatNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

export default function Digest({ onChangeTab }) {
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError('');

      try {
        const res = await fetch('./data.json', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to load data (${res.status}).`);
        }
        const data = await res.json();
        if (!alive) return;

        const rows = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
        setLeaderboard(rows);
        setLastUpdated(data.last_updated || '');
      } catch (e) {
        if (!alive) return;
        setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    return () => { alive = false; };
  }, []);

  const { topRepos, topContributors, totalRepos, devsWithRepos } = useMemo(() => {
    const devs = Array.isArray(leaderboard) ? leaderboard : [];
    const repos = devs.flatMap(d =>
      (d.digest_repos || []).map(r => ({
        ...r,
        stars: r.stars || 0,
        dev: d.username,
        devAvatar: d.avatar_url,
      }))
    );
    repos.sort((a, b) => b.stars - a.stars);

    const contribMap = new Map();
    for (const r of repos) {
      if (!contribMap.has(r.dev)) {
        contribMap.set(r.dev, { username: r.dev, avatar: r.devAvatar, repoCount: 0, totalStars: 0 });
      }
      const entry = contribMap.get(r.dev);
      entry.repoCount += 1;
      entry.totalStars += r.stars;
    }
    const contributors = Array.from(contribMap.values())
      .sort((a, b) => b.totalStars - a.totalStars);

    return {
      topRepos: repos.slice(0, 100),
      topContributors: contributors.slice(0, 10),
      totalRepos: repos.length,
      devsWithRepos: devs.filter(d => d.digest_repos?.length > 0).length,
    };
  }, [leaderboard]);

  const generatedDate = lastUpdated
    ? new Date(lastUpdated).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      })
    : null;

  const topStars = topRepos[0]?.stars || 0;

  if (loading) {
    return (
      <main className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 grid-lines pointer-events-none"></div>
        <div className="flex items-center justify-center h-96 relative z-10">
          <span className="font-mono text-sm text-tertiary animate-pulse uppercase tracking-widest">Loading Digest Stream...</span>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 grid-lines pointer-events-none"></div>
        <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-12 relative z-10">
          <div className="mb-8 sm:mb-12 border-l-4 border-primary pl-4 sm:pl-6">
            <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
              <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
              SYSTEM_STATUS: NO_DATA
            </div>
            <h1 className="font-headline text-3xl sm:text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
              Repository <span className="text-primary italic">Digest</span>
            </h1>
          </div>
          <div className="border border-outline-variant bg-surface-container-lowest p-6 sm:p-8 text-center">
            <span className="material-symbols-outlined text-outline-variant text-4xl mb-4">article</span>
            <p className="font-mono text-sm text-outline uppercase tracking-widest">{error}</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 md:py-12 relative z-10">

        {/* Hero */}
        <div className="mb-8 sm:mb-12 border-l-4 border-primary pl-4 sm:pl-6">
          <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
            <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
            SYSTEM_STATUS: DIGEST_ACTIVE
          </div>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="font-headline text-3xl sm:text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
                Repository <span className="text-primary italic">Digest</span>
              </h1>
              <p className="font-mono text-xs sm:text-sm text-tertiary mt-2 sm:mt-3 uppercase tracking-widest">
                Top Repositories From The Pakistani Developer Community
              </p>
            </div>
            <div className="flex gap-4 sm:gap-6 shrink-0 flex-wrap">
              <div className="text-right">
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Generated</div>
                <div className="font-headline text-xs sm:text-sm font-bold text-on-surface">{generatedDate || 'N/A'}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Repos Tracked</div>
                <div className="font-headline text-lg sm:text-2xl font-bold text-primary">{formatNum(totalRepos)}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8 sm:mb-12">
          <div className="border border-outline-variant bg-surface-container-lowest p-3 sm:p-5">
            <span className="material-symbols-outlined text-primary text-lg sm:text-2xl mb-2">inventory_2</span>
            <div className="font-headline text-lg sm:text-2xl font-bold text-primary">{formatNum(totalRepos)}</div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-1">Repositories</div>
          </div>
          <div className="border border-outline-variant bg-surface-container-lowest p-3 sm:p-5">
            <span className="material-symbols-outlined text-tertiary text-lg sm:text-2xl mb-2">group</span>
            <div className="font-headline text-lg sm:text-2xl font-bold text-tertiary">{formatNum(devsWithRepos)}</div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-1">Contributors</div>
          </div>
          <div className="border border-outline-variant bg-surface-container-lowest p-3 sm:p-5">
            <span className="material-symbols-outlined text-secondary text-lg sm:text-2xl mb-2">military_tech</span>
            <div className="font-headline text-lg sm:text-2xl font-bold text-secondary">{topStars >= 1000 ? (topStars / 1000).toFixed(1) + 'k' : topStars}</div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-1">Highest Repo</div>
          </div>
          <div className="border border-outline-variant bg-surface-container-lowest p-3 sm:p-5">
            <span className="material-symbols-outlined text-primary-container text-lg sm:text-2xl mb-2">trending_up</span>
            <div className="font-headline text-lg sm:text-2xl font-bold text-primary-container">{formatNum(leaderboard.length)}</div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-1">Active Devs</div>
          </div>
        </div>

        {/* Top Contributors */}
        {topContributors.length > 0 && (
          <div className="mb-8 sm:mb-12 border border-outline-variant bg-surface-container-lowest overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
                Top Contributors
              </span>
              <span className="font-mono text-[10px] text-outline uppercase">{topContributors.length} devs</span>
            </div>
            <div className="divide-y divide-outline-variant/30">
              {topContributors.map((c, i) => (
                <div key={c.username} className="flex items-center gap-3 px-4 sm:px-6 py-3 sm:py-4 hover:bg-surface-container-low transition-colors">
                  <span className="font-mono text-[10px] text-outline w-5 shrink-0">{i + 1}</span>
                  <img
                    alt={c.username}
                    className="w-8 h-8 sm:w-10 sm:h-10 grayscale hover:grayscale-0 transition-all border border-outline-variant object-cover shrink-0"
                    src={`https://avatars.githubusercontent.com/${c.username}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-headline text-xs sm:text-sm font-bold text-on-surface truncate">{c.username}</div>
                    <div className="font-mono text-[10px] text-outline uppercase tracking-tight">
                      {c.repoCount} {c.repoCount === 1 ? 'repo' : 'repos'} &bull; {formatNum(c.totalStars)} stars
                    </div>
                  </div>
                  <a
                    href={`https://github.com/${c.username}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10px] text-primary hover:underline shrink-0"
                  >
                    View Profile
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top Repos Table */}
        {topRepos.length > 0 && (
          <div className="border border-outline-variant overflow-hidden bg-surface-container-lowest mb-8 sm:mb-12">
            <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
                Top Repositories
              </span>
              <span className="font-mono text-[10px] text-outline uppercase">Top {formatNum(topRepos.length)} by stars</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-high/50 border-b border-outline-variant">
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-3 w-8">#</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-3">Repository</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-3 hidden md:table-cell">Description</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-3 hidden sm:table-cell">Language</th>
                    <th className="text-right font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-3">Stars</th>
                  </tr>
                </thead>
                <tbody>
                  {topRepos.map((repo, i) => (
                    <tr
                      key={`${repo.owner}/${repo.name}`}
                      className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors"
                    >
                      <td className="px-3 sm:px-4 py-3 font-mono text-[10px] text-outline">{i + 1}</td>
                      <td className="px-3 sm:px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <a
                            href={repo.url || `https://github.com/${repo.owner}/${repo.name}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-headline text-xs font-bold text-primary uppercase tracking-tight hover:underline"
                          >
                            {repo.owner}/{repo.name}
                          </a>
                          <span className="font-mono text-[9px] text-outline-variant">by {repo.dev}</span>
                        </div>
                      </td>
                      <td className="px-3 sm:px-4 py-3 font-mono text-[10px] text-outline truncate max-w-[200px] hidden md:table-cell">
                        {repo.description || '\u2014'}
                      </td>
                      <td className="px-3 sm:px-4 py-3 hidden sm:table-cell">
                        {repo.language ? (
                          <span className="font-mono text-[10px] text-tertiary bg-tertiary/10 px-2 py-0.5 uppercase tracking-tight">
                            {repo.language}
                          </span>
                        ) : (
                          <span className="font-mono text-[10px] text-outline-variant">{'\u2014'}</span>
                        )}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-right font-mono text-xs font-bold text-on-surface tabular-nums">
                        {repo.stars > 0 ? formatNum(repo.stars) : '\u2014'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CTA */}
        <div className="border border-outline-variant bg-surface-container-lowest p-6 sm:p-8 text-center">
          <span className="material-symbols-outlined text-primary text-2xl sm:text-3xl mb-4">leaderboard</span>
          <h3 className="font-headline text-base sm:text-lg font-bold tracking-tighter uppercase mb-2">Full Leaderboard</h3>
          <p className="font-body text-xs text-outline leading-relaxed max-w-lg mx-auto mb-4 sm:mb-6">
            View the complete ranking of active Pakistani developers ranked by score.
          </p>
          {onChangeTab && (
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => onChangeTab('leaderboard')}
                className="inline-flex min-h-11 items-center justify-center gap-2 bg-primary text-on-primary font-headline font-bold py-3 px-5 sm:px-6 hover:bg-primary-container transition-colors duration-50 active:scale-[0.98] uppercase tracking-widest text-xs"
              >
                Go to Leaderboard
              </button>
              <button
                type="button"
                onClick={() => onChangeTab('badge')}
                className="inline-flex min-h-11 items-center justify-center gap-2 border border-outline-variant text-on-surface font-headline font-bold py-3 px-5 sm:px-6 hover:bg-surface-container-low transition-colors duration-50 active:scale-[0.98] uppercase tracking-widest text-xs"
              >
                Generate Badge
              </button>
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
