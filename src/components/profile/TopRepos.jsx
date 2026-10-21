import React from 'react';
import Section from './Section';

const MAX_REPOS = 6;

/** The developer's own repositories, the ones people came for. */
export default function TopRepos({ dev }) {
  const repos = Array.isArray(dev?.top_repos) ? dev.top_repos.slice(0, MAX_REPOS) : [];

  return (
    <Section
      title="Top_Repos"
      icon="folder_open"
      aside={repos.length ? `${repos.length} shown` : null}
    >
      {repos.length === 0 ? (
        <p className="p-4 md:p-6 font-mono text-[10px] text-outline uppercase tracking-widest">
          No public repositories found.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-outline-variant">
          {repos.map((repo) => (
            <article key={repo.name} className="bg-surface-container-lowest p-4 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-sm text-primary hover:underline break-all min-w-0"
                >
                  {repo.name}
                </a>
                <span className="font-mono text-[10px] text-tertiary tabular-nums shrink-0">
                  ⭐ {Number(repo.stars) || 0}
                </span>
              </div>
              {repo.description ? (
                <p className="mt-2 text-xs text-on-surface-variant leading-relaxed font-body line-clamp-3">
                  {repo.description}
                </p>
              ) : null}
              {repo.language ? (
                <div className="mt-2 font-mono text-[10px] text-outline uppercase tracking-widest">
                  {repo.language}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}
