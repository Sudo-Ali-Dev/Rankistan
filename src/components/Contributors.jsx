import React, { useEffect, useState } from 'react';
import fallbackData from '../contributors.json';

const CONTRIBUTORS_API =
  'https://api.github.com/repos/Sudo-Ali-Dev/Rankistan/contributors?per_page=100';

// Logins kept out of the credits grid.
const EXCLUDED_LOGINS = new Set(['muhammadhamzachishti']);

// Same accent rotation the map uses for its place dots.
const NODE_COLORS = ['#a2c9ff', '#74dd7e', '#d8baff', '#58a6ff', '#cda8ff', '#90fa97'];

function isListable(login, ownerLogin) {
  const lower = String(login || '').toLowerCase();
  if (!lower) return false;
  // The owner has their own block above; the old version listed them twice.
  if (lower === String(ownerLogin || '').toLowerCase()) return false;
  return !EXCLUDED_LOGINS.has(lower);
}

// GitHub's sidebar counts 12 contributors while /contributors returns 9,
// because that endpoint reports commit *authors* only and ignores
// Co-authored-by trailers. These are the people credited that way, resolved by
// matching the trailer email against the GitHub user search. Merged in so the
// credits are complete rather than whatever one API happens to expose.
function withCoAuthors(apiList, ownerLogin) {
  const seen = new Set(apiList.map((c) => c.username.toLowerCase()));
  const extra = (fallbackData.coAuthors || []).filter(
    (c) => !seen.has(String(c.username).toLowerCase()) && isListable(c.username, ownerLogin)
  );
  // Whether we have real counts is decided by the *primary* list, not by the
  // merged one. The offline fallback carries no commit counts while the
  // co-authors do, so sorting the mix by count would rank the two co-authors
  // above every real contributor and render the rest as "--" with empty bars.
  const haveCounts = apiList.some((c) => (c.contributions || 0) > 0);

  if (!haveCounts) {
    // Countless mode: drop the co-author counts too so the list is uniform,
    // and order by name instead of by a number we only have for two rows.
    return [...apiList, ...extra]
      .map((c) => ({ ...c, contributions: 0 }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  return [...apiList, ...extra].sort(
    (a, b) => (b.contributions || 0) - (a.contributions || 0)
  );
}

export default function Contributors() {
  const owner = fallbackData.owner;
  const [contributors, setContributors] = useState(null);
  const [usedFallback, setUsedFallback] = useState(false);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const res = await fetch(CONTRIBUTORS_API);
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        if (!Array.isArray(data)) throw new Error('Unexpected API shape');

        setContributors(
          withCoAuthors(
            data
              // Filter on type so every bot is excluded, not just one login
              .filter((c) => c?.type !== 'Bot' && isListable(c?.login, owner.username))
              .map((c) => ({
                username: c.login,
                avatar_url: c.avatar_url,
                contributions: Number(c.contributions) || 0
              })),
            owner.username
          )
        );
      } catch {
        if (!alive) return;
        // Offline or rate-limited (unauthenticated calls get 60/hr per IP).
        setUsedFallback(true);
        setContributors(
          withCoAuthors(
            (fallbackData.contributors || [])
              .filter((c) => isListable(c.username, owner.username))
              .map((c) => ({
                username: c.username,
                avatar_url: c.avatar_url,
                contributions: Number(c.contributions) || 0
              })),
            owner.username
          )
        );
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [owner.username]);

  const loading = contributors === null;
  const list = contributors || [];
  const count = list.length;
  const totalCommits = list.reduce((sum, c) => sum + c.contributions, 0);
  const maxCommits = list.reduce((max, c) => Math.max(max, c.contributions), 0);

  return (
    <div className="border border-outline-variant bg-surface-container-lowest">
      {/* Header in the same idiom as the map's Place Breakdown panel */}
      <div className="flex items-center justify-between gap-3 p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 bg-tertiary animate-pulse shrink-0"></span>
          <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase truncate">
            The <span className="text-primary italic">Team</span>
          </h2>
        </div>
        <span className="font-mono text-[10px] text-outline uppercase tracking-widest shrink-0">
          {loading ? 'SYNCING' : `${count} CONTRIBUTOR${count === 1 ? '' : 'S'}`}
        </span>
      </div>

      <div className="p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Main block: the owner */}
          <div className="lg:col-span-2 relative border border-primary/40 border-l-4 border-l-primary bg-primary/5 p-4 sm:p-5">
            <div className="font-mono text-[9px] text-primary/70 uppercase tracking-widest mb-3">
              PRIMARY_NODE // MAINTAINER
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
              <img
                src={owner.avatar_url}
                alt=""
                width="72"
                height="72"
                loading="lazy"
                decoding="async"
                className="w-16 h-16 sm:w-[72px] sm:h-[72px] shrink-0 border border-primary/50 object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="font-headline text-xl sm:text-2xl font-bold uppercase tracking-tighter text-on-surface leading-none">
                  {owner.name}
                </div>
                {owner.bio && (
                  <p className="font-mono text-[11px] text-on-surface-variant mt-2">{owner.bio}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 font-mono text-[11px]">
                  <a
                    href={`https://github.com/${owner.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    @{owner.username}
                  </a>
                  {owner.website && (
                    <a
                      href={owner.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-tertiary hover:text-primary transition-colors"
                    >
                      <span className="material-symbols-outlined text-xs" aria-hidden="true">
                        language
                      </span>
                      {owner.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right sub block: stats + CTA */}
          <div className="flex flex-col justify-between gap-4 border border-outline-variant bg-surface p-4 sm:p-5">
            <div>
              <div className="font-mono text-[9px] text-outline uppercase tracking-widest mb-3">
                COMMUNITY // STATS
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="border-l-2 border-tertiary/60 pl-2.5">
                  <div className="font-mono text-2xl font-bold text-tertiary tabular-nums leading-none">
                    {loading ? '--' : String(count).padStart(2, '0')}
                  </div>
                  <div className="font-mono text-[9px] text-outline uppercase tracking-widest mt-1">
                    Contributors
                  </div>
                </div>
                <div className="border-l-2 border-primary/60 pl-2.5">
                  <div className="font-mono text-2xl font-bold text-primary tabular-nums leading-none">
                    {loading || !totalCommits ? '--' : totalCommits}
                  </div>
                  <div className="font-mono text-[9px] text-outline uppercase tracking-widest mt-1">
                    Commits
                  </div>
                </div>
              </div>
            </div>
            <a
              href="https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center justify-between gap-2 border border-primary/50 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-primary hover:bg-primary/10 hover:border-primary transition-colors"
            >
              <span>Join_The_Index</span>
              <span
                className="material-symbols-outlined text-sm group-hover:translate-x-0.5 transition-transform"
                aria-hidden="true"
              >
                arrow_forward
              </span>
            </a>
          </div>
        </div>

        {/* Sub blocks: contributors, ranked like the leaderboard */}
        <div>
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-tighter flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-tertiary shrink-0"></span>
              Contributor_Nodes
            </span>
            <span className="font-mono text-[9px] text-outline uppercase tracking-widest">
              {usedFallback ? 'cached' : 'by commits'}
            </span>
          </div>

          {loading ? (
            <div
              role="status"
              className="font-mono text-[10px] text-tertiary uppercase tracking-widest animate-pulse py-8 text-center"
            >
              Loading_Contributor_Nodes...
            </div>
          ) : count === 0 ? (
            <div className="p-6 sm:p-8 border border-dashed border-outline-variant/40 text-center">
              <div className="font-mono text-[10px] text-outline uppercase tracking-widest">
                No contributors yet
              </div>
            </div>
          ) : (
            <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {list.map((c, idx) => {
                const color = NODE_COLORS[idx % NODE_COLORS.length];
                const share = totalCommits > 0 ? (c.contributions / totalCommits) * 100 : 0;
                const barPct = maxCommits > 0 ? (c.contributions / maxCommits) * 100 : 0;
                return (
                  <li key={c.username}>
                    <a
                      href={`https://github.com/${c.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group block border border-outline-variant/50 bg-surface-container-low p-2.5 sm:p-3 hover:border-primary hover:bg-surface-container-high transition-all duration-200"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[10px] text-outline w-5 text-right shrink-0 group-hover:text-primary transition-colors">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        ></span>
                        <img
                          src={c.avatar_url}
                          alt=""
                          width="24"
                          height="24"
                          loading="lazy"
                          decoding="async"
                          className="w-6 h-6 shrink-0 border border-outline-variant object-cover"
                        />
                        <span className="font-headline text-xs sm:text-sm font-bold uppercase tracking-tighter truncate text-on-surface group-hover:text-primary transition-colors">
                          {c.username}
                        </span>
                        <span className="font-mono text-sm font-bold text-primary shrink-0 ml-auto tabular-nums">
                          {c.contributions || '--'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 mt-2 ml-[30px] sm:ml-[38px] min-w-0">
                        <div className="flex-1 bg-surface-container-highest h-1.5">
                          <div
                            className="h-full transition-all duration-500"
                            style={{ width: `${barPct}%`, backgroundColor: color }}
                          ></div>
                        </div>
                        <span className="font-mono text-[10px] text-outline w-12 text-right shrink-0">
                          {totalCommits > 0 ? `${share.toFixed(1)}%` : ''}
                        </span>
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
