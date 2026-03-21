import React, { useEffect, useMemo, useState } from 'react';
import { CACHE_KEYS, cache } from './utils/cache';
import { enrichLeaderboardWithTags, getAvailableTags } from './utils/tags';
import { generateDeveloperSummary } from './utils/groq';

function formatRank(rank, fallback) {
  const value = Number.isFinite(Number(rank)) ? Number(rank) : fallback;
  return String(value).padStart(3, '0');
}

function formatScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toLocaleString('en-US');
}

function formatFollowers(followers) {
  const value = Number(followers);
  if (!Number.isFinite(value)) {
    return '0';
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return String(value);
}

function App() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [selectedTag, setSelectedTag] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedUser, setExpandedUser] = useState('');
  const [summaryByUser, setSummaryByUser] = useState({});
  const [loadingSummaryUser, setLoadingSummaryUser] = useState('');

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      setLoading(true);
      setError('');

      try {
        let leaderboardPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        if (!leaderboardPayload || cache.isStale(CACHE_KEYS.LEADERBOARD)) {
          const response = await fetch('/data.json', { cache: 'no-store' });
          if (!response.ok) {
            throw new Error(`Failed to load data.json (${response.status})`);
          }
          leaderboardPayload = await response.json();
          cache.set(CACHE_KEYS.LEADERBOARD, leaderboardPayload);
        }

        if (!alive) {
          return;
        }

        const rows = Array.isArray(leaderboardPayload?.leaderboard)
          ? leaderboardPayload.leaderboard
          : [];

        setLeaderboard(enrichLeaderboardWithTags(rows));
        if (rows.length > 0) {
          setExpandedUser(String(rows[0]?.username || '').trim());
        }
      } catch (loadError) {
        if (!alive) {
          return;
        }
        setError(loadError?.message || 'Failed to load frontend data.');
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    loadAll();

    return () => {
      alive = false;
    };
  }, []);

  const tags = useMemo(() => ['All', ...getAvailableTags(leaderboard)], [leaderboard]);

  const filteredLeaderboard = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();

    if (selectedTag === 'All') {
      if (!normalizedQuery) {
        return leaderboard;
      }

      return leaderboard.filter((dev) => {
        const name = String(dev?.name || '').toLowerCase();
        const username = String(dev?.username || '').toLowerCase();
        const bio = String(dev?.bio || '').toLowerCase();
        return name.includes(normalizedQuery) || username.includes(normalizedQuery) || bio.includes(normalizedQuery);
      });
    }

    const tagFiltered = leaderboard.filter((dev) => Array.isArray(dev?.tags) && dev.tags.includes(selectedTag));
    if (!normalizedQuery) {
      return tagFiltered;
    }

    return tagFiltered.filter((dev) => {
      const name = String(dev?.name || '').toLowerCase();
      const username = String(dev?.username || '').toLowerCase();
      const bio = String(dev?.bio || '').toLowerCase();
      return name.includes(normalizedQuery) || username.includes(normalizedQuery) || bio.includes(normalizedQuery);
    });
  }, [leaderboard, selectedTag, searchTerm]);

  async function handleGenerateSummary(dev) {
    const username = String(dev?.username || '').trim();
    if (!username || loadingSummaryUser === username) {
      return;
    }

    setLoadingSummaryUser(username);
    try {
      const summary = await generateDeveloperSummary(dev);
      setSummaryByUser((prev) => ({ ...prev, [username]: summary }));
    } finally {
      setLoadingSummaryUser('');
    }
  }

  return (
    <div className="bg-surface text-on-surface font-body selection:bg-primary selection:text-on-primary min-h-screen">
      <header className="bg-[#10141a] text-[#a2c9ff] font-headline tracking-tight border-b border-[#414752] flex justify-between items-center w-full px-6 h-16 sticky top-0 z-50">
        <div className="text-xl font-bold tracking-tighter text-[#a2c9ff] uppercase">PakDev Index</div>
        <nav className="hidden md:flex items-center gap-8 h-full">
          <a className="text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1 h-full flex items-center px-2" href="#">Leaderboard</a>
          <a className="text-[#8b919d] hover:text-[#a2c9ff] transition-colors duration-50 flex items-center px-2 h-full" href="#">Weekly Digest</a>
          <a className="text-[#8b919d] hover:text-[#a2c9ff] transition-colors duration-50 flex items-center px-2 h-full" href="#">Register</a>
        </nav>
        <div className="flex items-center gap-4">
          <div className="relative hidden lg:block">
            <input
              className="bg-surface-container-lowest border-b-2 border-outline-variant focus:border-tertiary focus:ring-0 text-sm font-mono py-1 px-3 w-64 placeholder:text-outline/50 transition-all"
              placeholder="Search developer..."
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            <span className="material-symbols-outlined absolute right-2 top-1 text-outline">search</span>
          </div>
        </div>
      </header>

      <main className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
        <div className="mb-12">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-outline-variant pb-6">
            <div>
              <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary inline-block animate-pulse" />
                SYSTEM_STATUS: LIVE_SYNC
              </div>
              <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
                Top <span className="text-primary italic">Talent</span> Archive
              </h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs flex items-center gap-2 hover:bg-surface-container-highest transition-colors" type="button">
                <span className="material-symbols-outlined text-sm">filter_list</span>
                FILTER: {selectedTag.toUpperCase()}
              </button>
              <button className="bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs flex items-center gap-2 hover:bg-surface-container-highest transition-colors" type="button">
                <span className="material-symbols-outlined text-sm">sort</span>
                SORT: SCORE_DESC
              </button>
            </div>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setSelectedTag(tag)}
              className={`px-3 py-1 font-mono text-xs border transition-colors ${selectedTag === tag ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high border-outline-variant hover:bg-surface-container-highest'}`}
            >
              {tag}
            </button>
          ))}
        </div>

        {loading && <p className="font-mono text-sm">Loading leaderboard...</p>}
        {!loading && error && <p className="font-mono text-sm text-error">{error}</p>}

        {!loading && !error && (
          <>
            <div className="border border-outline-variant overflow-hidden">
              <div className="hidden md:grid grid-cols-12 bg-surface-container-lowest text-outline font-mono text-[10px] uppercase tracking-widest py-4 px-6 border-b border-outline-variant">
                <div className="col-span-1">Rank</div>
                <div className="col-span-4">Developer Instance</div>
                <div className="col-span-2">Location</div>
                <div className="col-span-3">Tech Stack</div>
                <div className="col-span-1 text-right">Score</div>
                <div className="col-span-1 text-right">Action</div>
              </div>

              {filteredLeaderboard.map((dev, index) => {
                const username = String(dev?.username || '').trim();
                const isExpanded = expandedUser === username;
                const summary = summaryByUser[username];
                const displayTags = Array.isArray(dev?.tags) && dev.tags.length > 0
                  ? dev.tags
                  : (Array.isArray(dev?.top_languages) ? dev.top_languages.slice(0, 3) : []);

                return (
                  <div key={username || `dev-${index}`} className="border-b border-outline-variant last:border-b-0">
                    <div className="grid grid-cols-1 md:grid-cols-12 bg-surface items-center py-6 px-6 group hover:bg-surface-container-low transition-colors">
                      <div className="col-span-1 mb-2 md:mb-0">
                        <span className="font-mono text-2xl font-bold text-outline-variant group-hover:text-primary transition-colors">
                          {formatRank(dev?.rank, index + 1)}
                        </span>
                      </div>

                      <div className="col-span-4 flex items-center gap-4 mb-4 md:mb-0">
                        <div className="relative shrink-0">
                          <img alt={username} className="w-12 h-12 grayscale border border-outline-variant p-0.5 object-cover" src={dev?.avatar_url || 'https://placehold.co/80x80'} />
                          {index === 0 && <div className="absolute -top-1 -right-1 w-3 h-3 bg-tertiary border-2 border-surface" />}
                        </div>
                        <div className="overflow-hidden">
                          <div className="font-headline font-bold text-lg leading-tight truncate">{dev?.name || username}</div>
                          <div className="font-mono text-xs text-outline truncate">github.com/{username}</div>
                        </div>
                      </div>

                      <div className="col-span-2 mb-4 md:mb-0">
                        <div className="flex items-center gap-2 text-on-surface-variant font-mono text-sm">
                          <span className="material-symbols-outlined text-sm">location_on</span>
                          {dev?.location || 'Pakistan'}
                        </div>
                      </div>

                      <div className="col-span-3 mb-4 md:mb-0 flex flex-wrap gap-2">
                        {displayTags.map((tag) => (
                          <span key={`${username}-${tag}`} className="bg-secondary-container/20 text-on-secondary-container text-[10px] font-mono px-2 py-0.5 border border-secondary-container/50">
                            {String(tag).toUpperCase()}
                          </span>
                        ))}
                      </div>

                      <div className="col-span-1 text-right mb-4 md:mb-0">
                        <div className="font-mono font-bold text-tertiary">{formatScore(dev?.score)}</div>
                      </div>

                      <div className="col-span-1 text-right">
                        <button className="text-outline hover:text-primary transition-colors" onClick={() => setExpandedUser(isExpanded ? '' : username)} type="button">
                          <span className="material-symbols-outlined">{isExpanded ? 'expand_less' : 'unfold_more'}</span>
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="bg-surface-container-lowest border-t border-outline-variant p-6 md:p-8">
                        <div className="grid md:grid-cols-12 gap-8">
                          <div className="md:col-span-4 space-y-6">
                            <div>
                              <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Bio_Data</h3>
                              <p className="text-sm text-on-surface-variant leading-relaxed font-body">{dev?.bio || 'No bio available for this developer.'}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <div className="border-l border-outline-variant pl-4 py-2">
                                <div className="font-mono text-[10px] text-outline uppercase">Followers</div>
                                <div className="font-headline font-bold text-xl">{formatFollowers(dev?.followers)}</div>
                              </div>
                              <div className="border-l border-outline-variant pl-4 py-2">
                                <div className="font-mono text-[10px] text-outline uppercase">Repos</div>
                                <div className="font-headline font-bold text-xl">{Number(dev?.public_repos || 0)}</div>
                              </div>
                            </div>
                          </div>

                          <div className="md:col-span-8 flex flex-col">
                            <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Top_Projects</h3>
                            <div className="border border-outline-variant p-4 space-y-3">
                              {(Array.isArray(dev?.top_repos) ? dev.top_repos.slice(0, 3) : []).map((repo) => (
                                <a className="block hover:text-primary transition-colors" href={repo?.url || '#'} key={`${username}-${repo?.name}`} target="_blank" rel="noreferrer">
                                  <div className="font-mono text-xs">{repo?.name || 'repo'}</div>
                                  <div className="text-xs text-on-surface-variant">{repo?.description || 'No description'}</div>
                                </a>
                              ))}
                            </div>

                            <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <a className="bg-surface-container-high border border-outline-variant py-2.5 font-mono text-[10px] uppercase hover:text-primary transition-all active:translate-y-px text-center" href={`https://github.com/${username}`} target="_blank" rel="noreferrer">View GitHub</a>
                              <button className="bg-surface-container-high border border-outline-variant py-2.5 font-mono text-[10px] uppercase hover:text-primary transition-all active:translate-y-px" type="button" onClick={() => handleGenerateSummary(dev)}>
                                {loadingSummaryUser === username ? 'Generating...' : 'Generate AI Summary'}
                              </button>
                              <button className="bg-tertiary text-on-tertiary py-2.5 font-mono text-[10px] font-bold uppercase hover:bg-tertiary-fixed transition-all active:translate-y-px" type="button">Follow Node</button>
                            </div>
                            {summary && <p className="mt-4 text-sm text-on-surface-variant">{summary}</p>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-8 flex flex-col md:flex-row justify-between items-center gap-4 font-mono text-xs border border-outline-variant p-4 bg-surface-container-lowest">
              <div className="text-outline uppercase">Showing 001 - {String(filteredLeaderboard.length).padStart(3, '0')} of {String(leaderboard.length).padStart(3, '0')} Node_Instances</div>
              <div className="flex gap-px bg-outline-variant border border-outline-variant">
                <button className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors" type="button">PREV</button>
                <button className="bg-primary text-on-primary px-4 py-2" type="button">01</button>
                <button className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors" type="button">NEXT</button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
