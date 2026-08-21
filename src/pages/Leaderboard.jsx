import React, { useEffect, useMemo, useState } from 'react';
import DevCard from '../components/DevCard';
import CompareModal from '../components/CompareModal';
import { CACHE_KEYS, cache } from '../utils/cache';
import { normalizeLocationForDisplay } from '../utils/location';
import { ensureLeaderboardTags, getAvailableTags } from '../utils/tags';
import { generateDeveloperSummary } from '../utils/groq';
import BadgeBanner from '../components/BadgeBanner';
import { exportCSV } from '../utils/csv';

const SORT_OPTIONS = [
  { key: 'score_desc', label: 'SCORE DESC', fn: (a, b) => (b.score || 0) - (a.score || 0) },
  { key: 'score_asc', label: 'SCORE ASC', fn: (a, b) => (a.score || 0) - (b.score || 0) },
  { key: 'name_asc', label: 'NAME A-Z', fn: (a, b) => (a.name || '').localeCompare(b.name || '') },
  { key: 'name_desc', label: 'NAME Z-A', fn: (a, b) => (b.name || '').localeCompare(a.name || '') },
  { key: 'followers_desc', label: 'FOLLOWERS', fn: (a, b) => (b.followers || 0) - (a.followers || 0) },
  { key: 'activity_desc', label: 'ACTIVITY', fn: (a, b) => (b.events_30d || 0) - (a.events_30d || 0) },
];

/** Public leaderboard fields only. Do not add `linkedin_url` or other private contact / social URLs. */
const CSV_EXPORT_COLUMNS = [
  'rank', 'username', 'name', 'location', 'score', 'followers', 'public_repos', 'events_30d', 'total_stars', 'top_languages'
];

export default function Leaderboard({ searchTerm = '', onSearchChange, onChangeTab, onNavigateToBadge }) {
  const [leaderboard, setLeaderboard] = useState([]);
  const [selectedTag, setSelectedTag] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summaryByUser, setSummaryByUser] = useState({});
  const [loadingSummaryUser, setLoadingSummaryUser] = useState('');
  const [sortIndex, setSortIndex] = useState(0);
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState([]);
  // The modal used to mount as soon as a second row was ticked, which covered
  // the list and made a third selection impossible - so the "of 3" indicator
  // and the 3-item branch in handleCompareSelect were both unreachable. Opening
  // is now an explicit action.
  const [compareOpen, setCompareOpen] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
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

        if (!alive) return;

        const rows = Array.isArray(leaderboardPayload?.leaderboard)
          ? leaderboardPayload.leaderboard
          : [];

        setLeaderboard(ensureLeaderboardTags(rows));
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
    let result = leaderboard;

    if (selectedTag !== 'All') {
      result = result.filter((dev) => Array.isArray(dev?.tags) && dev.tags.includes(selectedTag));
    }

    const q = searchTerm.trim().toLowerCase();
    if (q) {
      result = result.filter((dev) => {
        const username = (dev.username || '').toLowerCase();
        const name = (dev.name || '').toLowerCase();
        const location = (dev.location || '').toLowerCase();
        const cleanLocation = normalizeLocationForDisplay(dev.location).toLowerCase();
        const langs = (dev.top_languages || []).join(' ').toLowerCase();
        return username.includes(q) || name.includes(q) || location.includes(q) || cleanLocation.includes(q) || langs.includes(q);
      });
    }

    const sort = SORT_OPTIONS[sortIndex];
    if (sort) {
      result = [...result].sort(sort.fn);
    }

    return result;
  }, [leaderboard, selectedTag, searchTerm, sortIndex]);

  useEffect(() => { setCurrentPage(1); }, [selectedTag, searchTerm, sortIndex]);

  const indexOfLastDev = currentPage * devsPerPage;
  const indexOfFirstDev = Math.max(0, indexOfLastDev - devsPerPage);
  const currentDevs = filteredLeaderboard.slice(indexOfFirstDev, indexOfLastDev);
  const totalPages = Math.max(1, Math.ceil(filteredLeaderboard.length / devsPerPage));

  const startIdx = indexOfFirstDev + 1;
  const endIdx = Math.min(indexOfLastDev, filteredLeaderboard.length);

  const goToPage = (n) => {
    if (!Number.isFinite(n)) return;
    setCurrentPage(Math.min(totalPages, Math.max(1, Math.trunc(n))));
  };

  const handleJump = (e) => {
    e.preventDefault();
    const n = parseInt(pageInput, 10);
    if (!Number.isNaN(n)) goToPage(n);
    setPageInput('');
  };

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

  function handleSortCycle() {
    setSortIndex((prev) => (prev + 1) % SORT_OPTIONS.length);
  }

  function handleCompareSelect(dev) {
    if (!compareMode) return;
    setCompareSelection((prev) => {
      const idx = prev.findIndex((d) => d.username === dev.username);
      if (idx !== -1) return prev.filter((_, i) => i !== idx);
      if (prev.length >= 3) return [prev[1], prev[2], dev];
      return [...prev, dev];
    });
  }

  function handleCompareToggle() {
    setCompareMode((prev) => !prev);
    setCompareSelection([]);
    setCompareOpen(false);
  }

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-7xl mx-auto p-4 md:p-8 relative z-10">
        <div className="flex flex-col gap-6">
          <div>
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-outline-variant pb-6">
              <div className="border-l-4 border-primary pl-6">
                <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
                  <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
                  SYSTEM_STATUS: LIVE_SYNC
                </div>
                <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
                  Top <span className="text-primary italic">Talent</span> Archive
                </h1>
              </div>
              <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:gap-2.5 md:w-auto md:items-end">
                <div className="flex w-full flex-wrap items-stretch gap-2 md:w-auto md:flex-nowrap">
                  <div className="relative group flex flex-1 basis-0 min-w-0 items-center justify-center gap-2 cursor-pointer bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs hover:bg-surface-container-highest transition-colors md:flex-none md:basis-auto md:justify-start">
                    <span className="material-symbols-outlined text-sm">filter_list</span>
                    <span className="truncate">FILTER: {selectedTag.toUpperCase()}</span>
                    <select
                      className="absolute inset-0 opacity-0 cursor-pointer w-full bg-surface-container-high text-on-surface"
                      value={selectedTag}
                      onChange={(e) => { setSelectedTag(e.target.value); }}
                      style={{ colorScheme: 'dark' }}
                      aria-label="Filter by tag"
                    >
                      {tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={handleSortCycle}
                    className="hidden md:flex bg-surface-container-high border border-outline-variant px-4 py-2 font-mono text-xs items-center gap-2 hover:bg-surface-container-highest transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">sort</span>
                    SORT: {SORT_OPTIONS[sortIndex].label}
                  </button>
                  <button
                    type="button"
                    onClick={handleCompareToggle}
                    className={`md:hidden flex flex-1 basis-0 min-w-0 items-center justify-center gap-2 px-4 py-2 font-mono text-xs active:scale-95 transition-all ${
                      compareMode
                        ? 'bg-tertiary text-on-tertiary'
                        : 'bg-surface-container-high border border-outline-variant text-on-surface'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm">compare_arrows</span>
                    <span className="truncate">{compareMode ? 'EXIT' : 'COMPARE'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => exportCSV(filteredLeaderboard, CSV_EXPORT_COLUMNS)}
                    className="md:hidden flex flex-1 basis-0 min-w-0 items-center justify-center gap-2 bg-primary text-on-primary px-4 py-2 font-mono text-xs active:scale-95 transition-all"
                  >
                    <span className="material-symbols-outlined text-sm">download</span>
                    <span className="truncate">EXPORT CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCompareToggle}
                    className={`hidden md:flex items-center justify-center gap-2 px-4 py-2 font-mono text-xs transition-colors ${
                      compareMode
                        ? 'bg-tertiary text-on-tertiary'
                        : 'bg-surface-container-high border border-outline-variant text-on-surface hover:bg-surface-container-highest'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm">compare_arrows</span>
                    COMPARE
                  </button>
                  <button
                    type="button"
                    onClick={() => exportCSV(filteredLeaderboard, CSV_EXPORT_COLUMNS)}
                    className="hidden md:block bg-primary text-on-primary px-6 py-2 font-headline font-bold uppercase tracking-tight active:scale-95 transition-all"
                  >
                    Export CSV
                  </button>
                </div>
                {onSearchChange && (
                  <div className="relative w-full min-w-0 max-w-full lg:hidden">
                    <input
                      className="w-full bg-surface-container-lowest border-b-2 border-outline-variant focus:border-tertiary focus:ring-0 text-sm font-mono py-2 pl-3 pr-10 placeholder:text-outline/50 transition-all text-on-surface"
                      placeholder="Search developer..."
                      type="search"
                      value={searchTerm}
                      onChange={(e) => onSearchChange(e.target.value)}
                      autoComplete="off"
                      enterKeyHint="search"
                      aria-label="Search developers"
                    />
                    <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-outline">search</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {onChangeTab && <BadgeBanner onNavigateToBadge={() => onChangeTab('badge')} />}

          {loading ? (
            <div className="text-center py-20 font-mono text-tertiary animate-pulse">LOADING_DATA_STREAM...</div>
          ) : error ? (
            <div className="text-center py-20 font-mono text-error">{error}</div>
          ) : (
            <>
              <div className="border border-outline-variant overflow-hidden bg-surface-container-lowest">
                <div className="hidden md:grid grid-cols-12 md:gap-x-4 bg-surface-container-lowest text-outline font-mono text-[10px] uppercase tracking-widest py-4 px-6 border-b border-outline-variant">
                  <div className="col-span-1">Rank</div>
                  <div className="col-span-4">Developer Instance</div>
                  <div className="col-span-2 md:-ml-2 md:pr-2">Location</div>
                  <div className="col-span-3 md:pl-1">Tech Stack</div>
                  <div className="col-span-1 text-right">Score</div>
                  <div className="col-span-1 text-right">Action</div>
                </div>

                <div>
                  {currentDevs.length === 0 ? (
                    <div className="text-center py-12 font-mono text-outline-variant text-xs uppercase">
                      No developers match your search.
                    </div>
                  ) : (
                    currentDevs.map(dev => (
                      <DevCard
                        key={dev.username}
                        dev={dev}
                        onGenerateSummary={handleGenerateSummary}
                        onGenerateBadge={onNavigateToBadge}
                        summary={summaryByUser[dev.username]}
                        loadingSummaryUser={loadingSummaryUser}
                        compareMode={compareMode}
                        isCompareSelected={compareSelection.some(d => d.username === dev.username)}
                        onCompareSelect={handleCompareSelect}
                      />
                    ))
                  )}
                </div>
              </div>

              {filteredLeaderboard.length > 0 && (
                <div className="mt-8 flex flex-col md:flex-row justify-between items-center gap-4 font-mono text-xs border border-outline-variant p-4 bg-surface-container-lowest">
                  <div className="text-outline uppercase">
                    Showing {String(startIdx).padStart(3, '0')} - {String(endIdx).padStart(3, '0')} of {filteredLeaderboard.length.toLocaleString()} Node_Instances
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <div className="flex gap-px bg-outline-variant border border-outline-variant">
                      <button
                        onClick={() => goToPage(1)}
                        disabled={currentPage === 1}
                        aria-label="First page"
                        className="bg-surface px-3 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                      >
                        FIRST
                      </button>
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        aria-label="Previous page"
                        className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                      >
                        PREV
                      </button>
                      <span className="bg-primary text-on-primary px-4 py-2" aria-current="page">
                        {String(currentPage).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}
                      </span>
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        aria-label="Next page"
                        className="bg-surface px-4 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                      >
                        NEXT
                      </button>
                      <button
                        onClick={() => goToPage(totalPages)}
                        disabled={currentPage === totalPages}
                        aria-label="Last page"
                        className="bg-surface px-3 py-2 hover:bg-primary hover:text-on-primary transition-colors disabled:opacity-50"
                      >
                        LAST
                      </button>
                    </div>
                    {totalPages > 1 && (
                      <form onSubmit={handleJump} className="flex items-center gap-2">
                        <label htmlFor="page-jump" className="text-outline uppercase">Go to</label>
                        <input
                          id="page-jump"
                          type="number"
                          min="1"
                          max={totalPages}
                          value={pageInput}
                          onChange={(e) => setPageInput(e.target.value)}
                          placeholder={String(currentPage)}
                          aria-label={`Jump to page (1 to ${totalPages})`}
                          className="w-16 bg-surface-container-lowest border border-outline-variant px-2 py-2 text-center text-on-surface focus:border-primary focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          type="submit"
                          className="bg-surface border border-outline-variant px-3 py-2 hover:bg-primary hover:text-on-primary transition-colors"
                        >
                          GO
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      {/* Compare selection indicator */}
      {compareMode && compareSelection.length > 0 && (
        <div className="mt-4 border border-tertiary bg-surface-container-lowest p-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
            <span className="text-tertiary uppercase tracking-widest">
              {compareSelection.length} of 3 Nodes Selected
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setCompareOpen(true)}
              disabled={compareSelection.length < 2}
              className="border border-tertiary/60 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-tertiary hover:bg-tertiary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Compare
            </button>
            <button
              type="button"
              onClick={handleCompareToggle}
              className="text-outline hover:text-primary transition-colors font-mono text-xs uppercase"
            >
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Compare Modal */}
      {compareOpen && compareSelection.length >= 2 && (
        <CompareModal
          developers={compareSelection}
          // Closing returns to the list with the selection intact, so a third
          // node can be added and the modal reopened.
          onClose={() => setCompareOpen(false)}
        />
      )}
      </div>
    </main>
  );
}