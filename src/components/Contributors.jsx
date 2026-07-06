import React, { useEffect, useState } from 'react';
import fallbackData from '../contributors.json';

const CONTRIBUTORS_API = 'https://api.github.com/repos/Sudo-Ali-Dev/Rankistan/contributors';

export default function Contributors() {
  const [owner] = useState(fallbackData.owner);
  const [contributors, setContributors] = useState(fallbackData.contributors);

  useEffect(() => {
    let alive = true;

    async function fetchContributors() {
      try {
        const res = await fetch(CONTRIBUTORS_API);
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const data = await res.json();
        if (!alive) return;

        const filtered = data
          .filter((c) => c.login !== 'github-actions[bot]')
          .map((c) => ({
            name: c.login,
            username: c.login,
            avatar_url: c.avatar_url,
            bio: null,
            role: 'Contributor',
          }));

        setContributors(filtered);
      } catch {
        if (alive) setContributors(fallbackData.contributors);
      }
    }

    fetchContributors();
    return () => { alive = false; };
  }, []);

  return (
    <div className="border border-outline-variant bg-surface-container-lowest">
      <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="material-symbols-outlined text-primary">group</span>
          <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase">Owner & Contributors</h2>
          <span className="font-mono text-[10px] text-outline uppercase tracking-widest">// The Team</span>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Owner */}
          <div className="lg:w-1/2">
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Owner</div>
            <div className="flex items-start gap-4 p-4 sm:p-5 border-2 border-primary/30 bg-primary/5">
              <img
                src={owner.avatar_url}
                alt={owner.name}
                className="w-14 h-14 sm:w-16 sm:h-16 border-2 border-primary/50 object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="font-headline text-base sm:text-lg font-bold text-on-surface">{owner.name}</div>
                <div className="font-mono text-xs text-outline mt-1">
                  <a
                    href={`https://github.com/${owner.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    @{owner.username}
                  </a>
                  <span className="text-outline/50 ml-1">// Owner</span>
                </div>
                <p className="font-body text-xs sm:text-sm text-on-surface-variant mt-2">{owner.bio}</p>
                {owner.website && (
                  <a
                    href={owner.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 font-mono text-[10px] text-tertiary hover:text-primary transition-colors"
                  >
                    <span className="material-symbols-outlined text-xs">language</span>
                    {owner.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Contributors */}
          <div className="lg:w-1/2">
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Contributors</div>
            {contributors.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {contributors.map((contributor) => (
                  <div
                    key={contributor.username}
                    className="p-3 sm:p-4 border border-outline-variant/50 bg-surface hover:border-outline-variant transition-colors"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <img
                        src={contributor.avatar_url}
                        alt={contributor.name}
                        className="w-8 h-8 sm:w-10 sm:h-10 border border-outline-variant object-cover"
                      />
                      <div className="min-w-0">
                        <div className="font-headline text-xs sm:text-sm font-bold text-on-surface truncate">{contributor.name}</div>
                        <div className="font-mono text-[9px] text-outline truncate">
                          <a
                            href={`https://github.com/${contributor.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary"
                          >
                            @{contributor.username}
                          </a>
                        </div>
                      </div>
                    </div>
                    {contributor.role && (
                      <div className="font-mono text-[9px] text-tertiary bg-tertiary/10 px-2 py-0.5 inline-block uppercase tracking-tight">
                        {contributor.role}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 sm:p-8 border border-dashed border-outline-variant/30 text-center">
                <span className="material-symbols-outlined text-outline-variant text-2xl mb-2">person_add</span>
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest">No contributors yet</div>
                <p className="font-body text-xs text-outline/60 mt-1">Be the first to contribute!</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
