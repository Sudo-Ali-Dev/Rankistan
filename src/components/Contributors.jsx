import React, { useEffect, useState } from 'react';
import fallbackData from '../contributors.json';

const CONTRIBUTORS_API =
  'https://api.github.com/repos/Sudo-Ali-Dev/Rankistan/contributors?per_page=100';

// Logins kept out of the credits grid.
const EXCLUDED_LOGINS = new Set(['muhammadhamzachishti']);

function isListable(login, ownerLogin) {
  const lower = String(login || '').toLowerCase();
  if (!lower) return false;
  // The owner has their own card above; the old version listed them twice.
  if (lower === String(ownerLogin || '').toLowerCase()) return false;
  return !EXCLUDED_LOGINS.has(lower);
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
          data
            // Filter on type so every bot is excluded, not just the one login
            .filter((c) => c?.type !== 'Bot' && isListable(c?.login, owner.username))
            .map((c) => ({
              username: c.login,
              avatar_url: c.avatar_url,
              contributions: Number(c.contributions) || 0
            }))
            .sort((a, b) => b.contributions - a.contributions)
        );
      } catch {
        if (!alive) return;
        // Offline or rate-limited (unauthenticated calls get 60/hr per IP).
        // Fall back to the checked-in list so the section is never empty.
        setUsedFallback(true);
        setContributors(
          (fallbackData.contributors || [])
            .filter((c) => isListable(c.username, owner.username))
            .map((c) => ({
              username: c.username,
              avatar_url: c.avatar_url,
              contributions: null
            }))
        );
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [owner.username]);

  const loading = contributors === null;
  const count = contributors ? contributors.length : 0;
  const totalCommits = contributors
    ? contributors.reduce((sum, c) => sum + (c.contributions || 0), 0)
    : 0;

  return (
    <div className="border border-outline-variant bg-surface-container-lowest">
      <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="material-symbols-outlined text-primary" aria-hidden="true">
            group
          </span>
          <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">
            The Team
          </h2>
          {!loading && (
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
              {count} contributor{count === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-4">
        {/* Owner is the main block; the stats panel fills the trailing third so
            the row does not end in empty space. Contributors sit below. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5 p-4 sm:p-5 border-2 border-primary/30 bg-primary/5">
            <img
              src={owner.avatar_url}
              alt=""
              width="80"
              height="80"
              loading="lazy"
              decoding="async"
              className="w-16 h-16 sm:w-20 sm:h-20 shrink-0 border-2 border-primary/50 object-cover"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-headline text-lg sm:text-xl font-bold text-on-surface">
                  {owner.name}
                </span>
                <span className="font-mono text-[10px] text-primary bg-primary/10 px-2 py-0.5 uppercase tracking-widest">
                  Owner
                </span>
              </div>
              {owner.bio && (
                <p className="font-body text-xs sm:text-sm text-on-surface-variant mt-1.5">
                  {owner.bio}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 font-mono text-[11px]">
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

          <div className="flex flex-col justify-between gap-4 p-4 sm:p-5 border border-outline-variant bg-surface">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="font-headline text-2xl font-bold text-tertiary tabular-nums">
                  {loading ? '—' : count}
                </div>
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-0.5">
                  Contributors
                </div>
              </div>
              <div>
                <div className="font-headline text-2xl font-bold text-primary tabular-nums">
                  {loading || !totalCommits ? '—' : totalCommits}
                </div>
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest mt-0.5">
                  Commits
                </div>
              </div>
            </div>
            <a
              href="https://github.com/Sudo-Ali-Dev/Rankistan/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-primary/60 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                arrow_forward
              </span>
              Contribute
            </a>
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
              Contributors
            </span>
            {usedFallback && (
              <span className="font-mono text-[10px] text-outline/70 uppercase tracking-widest">
                cached list
              </span>
            )}
          </div>

          {loading ? (
            <div
              role="status"
              className="font-mono text-[10px] text-outline uppercase tracking-widest animate-pulse py-6 text-center"
            >
              Loading contributors...
            </div>
          ) : count === 0 ? (
            <div className="p-6 sm:p-8 border border-dashed border-outline-variant/40 text-center">
              <div className="font-mono text-[10px] text-outline uppercase tracking-widest">
                No contributors yet
              </div>
              <p className="font-body text-xs text-on-surface-variant mt-1">
                Be the first to contribute.
              </p>
            </div>
          ) : (
            /* Denser grid across the full width, instead of two columns
               squeezed into half the section. */
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {contributors.map((c) => (
                <li key={c.username}>
                  <a
                    href={`https://github.com/${c.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex h-full items-center gap-3 p-3 border border-outline-variant/60 bg-surface hover:border-primary hover:bg-surface-container-low transition-colors"
                  >
                    <img
                      src={c.avatar_url}
                      alt=""
                      width="40"
                      height="40"
                      loading="lazy"
                      decoding="async"
                      className="w-10 h-10 shrink-0 border border-outline-variant object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-headline text-sm font-bold text-on-surface group-hover:text-primary transition-colors break-all leading-tight">
                        {c.username}
                      </span>
                      {c.contributions != null && (
                        <span className="block font-mono text-[10px] text-outline mt-0.5">
                          {c.contributions} commit{c.contributions === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
