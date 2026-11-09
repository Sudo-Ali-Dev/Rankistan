import React, { useState } from 'react';
import { normalizeLocationForDisplay } from '../../utils/location';

const GitHubIcon = ({ size = 16 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    aria-hidden="true"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 1.15 0 0 1.06.35 1.62.87.62.56 1.06 1.31 1.06 2.16 0 7.39-4.87 8.4-9.08 8.4-.2 0-.4-.01-.6-.02 4.23.55 7.4-3.42 7.4-7.4 0-4.14-3.36-7.5-7.5-7.5z" />
  </svg>
);

/**
 * Who this page is about: the avatar, the rank, the name, where they are, what they write about,
 * and the links out - GitHub, LinkedIn, the page itself to share, and their badge.
 */
export default function Hero({ dev, sharedBy = 1, onBadge }) {
  const [shared, setShared] = useState(false);
  const username = dev?.username || '';
  const avatar = dev?.avatar_url || `https://github.com/${username}.png?size=200`;
  const location = normalizeLocationForDisplay(dev?.location);
  const bio = typeof dev?.bio === 'string' ? dev.bio.trim() : '';
  const linkedin = typeof dev?.linkedin_url === 'string' ? dev.linkedin_url.trim() : '';
  const tags = Array.isArray(dev?.tags) ? dev.tags : [];
  const rank = Number(dev?.rank);

  const share = async () => {
    const url = `${window.location.origin}/${username}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${username} on Rankistan`, url });
      } else {
        await navigator.clipboard.writeText(url);
      }
      setShared(true);
      setTimeout(() => setShared(false), 1800);
    } catch {
      // A cancelled share is not a failure worth showing.
    }
  };

  return (
    <div className="border border-outline-variant bg-surface-container-lowest">
      <div className="flex flex-col gap-6 p-5 md:flex-row md:items-start md:p-8">
        <div className="flex shrink-0 items-start gap-4">
          <img
            src={avatar}
            alt={username}
            className="w-24 h-24 border border-outline-variant object-cover md:w-32 md:h-32"
          />
          <div className="min-w-0">
            <div className="font-mono text-4xl font-bold text-outline-variant md:text-5xl tabular-nums">
              {Number.isFinite(rank) ? String(rank).padStart(3, '0') : '---'}
            </div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest">
              Rank{sharedBy > 1 ? ` · Tied with ${sharedBy - 1}` : ''}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="border-l-4 border-primary pl-4">
            <h1 className="font-headline text-3xl md:text-5xl font-bold tracking-tighter leading-none break-words">
              {dev?.name || username}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-outline">
              <a
                href={`https://github.com/${username}`}
                target="_blank"
                rel="noreferrer"
                className="text-on-surface-variant hover:text-primary transition-colors break-all"
              >
                @{username}
              </a>
              {location ? (
                <span className="flex items-center gap-1 min-w-0">
                  <span className="material-symbols-outlined text-sm" aria-hidden="true">
                    location_on
                  </span>
                  <span className="break-words">{location}</span>
                </span>
              ) : null}
            </div>
          </div>

          {bio ? (
            <p className="text-sm text-on-surface-variant leading-relaxed font-body max-w-3xl">
              {bio}
            </p>
          ) : null}

          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="shrink-0 bg-secondary-container/20 text-on-secondary-container border border-secondary-container/50 text-[10px] font-mono px-2 py-0.5"
                >
                  {String(tag).toUpperCase()}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={`https://github.com/${username}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 border border-outline-variant bg-surface-container-high px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:border-primary hover:text-primary transition-colors"
            >
              <GitHubIcon />
              GitHub
            </a>
            {linkedin ? (
              <a
                href={linkedin}
                target="_blank"
                rel="noreferrer"
                title={linkedin}
                className="inline-flex items-center gap-2 border border-outline-variant bg-surface-container-high px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:border-primary hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">
                  work
                </span>
                LinkedIn
              </a>
            ) : null}
            <button
              type="button"
              onClick={share}
              className="inline-flex items-center gap-2 border border-outline-variant bg-surface-container-high px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:border-primary hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                {shared ? 'check' : 'share'}
              </span>
              {shared ? 'Copied' : 'Share'}
            </button>
            <button
              type="button"
              onClick={() => onBadge?.(username)}
              className="inline-flex items-center gap-2 bg-tertiary text-on-tertiary px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-tertiary-fixed transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                military_tech
              </span>
              Badge
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
