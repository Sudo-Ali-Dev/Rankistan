import React, { useEffect, useMemo, useState } from 'react';
import DevCard from '../components/DevCard';
import { CACHE_KEYS, cache } from '../utils/cache';
import { enrichLeaderboardWithTags, getAvailableTags } from '../utils/tags';
import { generateDeveloperSummary } from '../utils/groq';

export default function Leaderboard() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [digest, setDigest] = useState(null);
  const [selectedTag, setSelectedTag] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summaryByUser, setSummaryByUser] = useState({});
  const [loadingSummaryUser, setLoadingSummaryUser] = useState('');

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const devsPerPage = 10;

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      setLoading(true);
      setError('');

      try {
        let leaderboardPayload;
        try {
          const response = await fetch('./data.json', { cache: 'no-store' });
          if (response.ok) {
            leaderboardPayload = await response.json();
            cache.set(CACHE_KEYS.LEADERBOARD, leaderboardPayload);
          }
        } catch {
          leaderboardPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        }
        if (!leaderboardPayload) {
          leaderboardPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        }
        if (!leaderboardPayload) {
          throw new Error('Failed to load data.json and no cached data available.');
        }

        let digestPayload;
        try {
          const response = await fetch('./digest.json', { cache: 'no-store' });
          if (response.ok) {
            digestPayload = await response.json();
            cache.set(CACHE_KEYS.DIGEST, digestPayload);
          }
        } catch {
          digestPayload = cache.get(CACHE_KEYS.DIGEST);
        }
        if (!digestPayload) {
          digestPayload = cache.get(CACHE_KEYS.DIGEST);
        }

        if (!alive) return;

        const rows = Array.isArray(leaderboardPayload?.leaderboard)
          ? leaderboardPayload.leaderboard
          : [];

        setLeaderboard(enrichLeaderboardWithTags(rows));
        setDigest(digestPayload || null);
      } catch (loadError) {
        if (!alive) return;
        setError(loadError?.message || 'Failed to load frontend data.');
      } finally {
        if (alive) setLoading(false);
      }
    }

    loadAll();

    return () => { alive = false; };
  }, []);

  const tags = useMemo(() => ['All', ...getAvailableTags(leaderboard)], [leaderboard]);

  const filteredLeaderboard = useMemo(() => {
    if (selectedTag === 'All') return leaderboard;
    return leaderboard.filter((dev) => Array.isArray(dev?.tags) && dev.tags.includes(selectedTag));
  }, [leaderboard, selectedTag]);

  // Pagination Logic
  const indexOfLastDev = currentPage * devsPerPage;
  const indexOfFirstDev = Math.max(0, indexOfLastDev - devsPerPage);
  const currentDevs = filteredLeaderboard.slice(indexOfFirstDev, indexOfLastDev);
  const totalPages = Math.max(1, Math.ceil(filteredLeaderboard.length / devsPerPage));

  const startIdx = indexOfFirstDev + 1;
  const endIdx = Math.min(indexOfLastDev, filteredLeaderboard.length);
  
  async function handleGenerateSummary(dev) {
    const username = String(dev?.username || '').trim();
    if (!username || loadingSummaryUser === username) return;

    setLoadingSummaryUser(username);
    try {
      const summary = await generateDeveloperSummary(dev);
      setSummaryByUser((prev) => ({ ...prev, [username]: summary }));
    } finally {
      setLoadingSummaryUser('');
    }
  }

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      <div className="mb-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-outline-variant pb-6">
          <div>
            <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
              <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
              SYSTEM_STATUS: LIVE_SYNC
            </div>
            <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
              Top <span className="text-primary italic">Talent</span> Archive
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs flex items-center gap-2 hover:bg-surface-container-highest transition-colors relative group cursor-pointer">
              <span className="material-symbols-outlined text-sm">filter_list</span>
              FILTER: {selectedTag.toUpperCase()}
              <select className="absolute inset-0 opacity-0 cursor-pointer w-full" value={selectedTag} onChange={(e) => { setSelectedTag(e.target.value); setCurrentPage(1); }}>
                {tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </div>
            <button className="bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs flex items-center gap-2 hover:bg-surface-container-highest transition-colors">
              <span className="material-symbols-outlined text-sm">sort</span>
              SORT: SCORE_DESC
            </button>
            <button className="bg-primary text-on-primary px-6 py-2 font-headline font-bold uppercase tracking-tight active:scale-95 transition-all">
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {loading ? (
          <div className="text-center py-20 font-mono text-tertiary animate-pulse">LOADING_DATA_STREAM...</div>
      ) : error ? (
          <div className="text-center py-20 font-mono text-error">{error}</div>
      ) : (
        <>
          <div className="border border-outline-variant overflow-hidden">
            {/* Table Header */}
            <div className="hidden md:grid grid-cols-12 bg-surface-container-lowest text-outline font-mono text-[10px] uppercase tracking-widest py-4 px-6 border-b border-outline-variant">
              <div className="col-span-1">Rank</div>
              <div className="col-span-4">Developer Instance</div>
              <div className="col-span-2">Location</div>
              <div className="col-span-3">Tech Stack</div>
              <div className="col-span-1 text-right">Score</div>
              <div className="col-span-1 text-right">Action</div>
            </div>

            {/* Leaderboard Rows */}
            <div>
              {currentDevs.map(dev => (
                <DevCard 
                  key={dev.username} 
                  dev={dev} 
                  onGenerateSummary={handleGenerateSummary}
                  summary={summaryByUser[dev.username]}
                  loadingSummaryUser={loadingSummaryUser}
                />
              ))}
            </div>
          </div>

          {/* Pagination Controls */}
          {filteredLeaderboard.length > 0 && (
            <div className="mt-8 flex flex-col md:flex-row justify-between items-center gap-4 font-mono text-xs border border-outline-variant p-4 bg-surface-container-lowest">
              <div className="text-outline uppercase">
                Showing {String(startIdx).padStart(3, '0')} - {String(endIdx).padStart(3, '0')} of {filteredLeaderboard.length.toLocaleString()} Node_Instances
              </div>
              <div className="flex gap-px bg-outline-variant border border-outline-variant">
                <button 
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                >
                  PREV
                </button>
                <button className="bg-primary text-on-primary px-4 py-2">
                  {String(currentPage).padStart(2, '0')}
                </button>
                <button 
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                >
                  NEXT
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
