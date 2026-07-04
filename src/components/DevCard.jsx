import React, { useEffect, useRef, useState } from 'react';
import { normalizeLocationForDisplay } from '../utils/location';
import { resolveHeatmapApiUrl, resolveHeatmapDirectUrl } from '../utils/groq.js';

const GitHubIcon = ({ size = 16 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width={size} height={size} aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
  </svg>
);

function ContributionHeatmap({ username }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!username) {
      setSrc('');
      setFailed(false);
      return;
    }
    setSrc(resolveHeatmapApiUrl(username));
    setFailed(false);
  }, [username]);

  const handleError = () => {
    const directUrl = resolveHeatmapDirectUrl(username);
    if (src !== directUrl) {
      setSrc(directUrl);
      return;
    }
    setFailed(true);
  };

  if (!username) {
    return (
      <div className="font-mono text-xs text-outline uppercase text-center px-2">
        No username available.
      </div>
    );
  }

  if (failed) {
    return (
      <div className="font-mono text-xs text-outline uppercase text-center px-2">
        Heatmap unavailable
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`${username} contribution chart`}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={handleError}
      className="w-full h-full object-contain opacity-80 hover:opacity-100 transition-all drop-shadow-md"
    />
  );
}

export default function DevCard({ dev, onGenerateSummary, onGenerateBadge, summary, loadingSummaryUser, isHighlighted = false, highlightRef = null, onCopyLink }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    if (isHighlighted && !isExpanded) {
      setIsExpanded(true);
    }
  // Intentionally omits other deps — only reacts to the flag becoming true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHighlighted]);
  
  const tagsColors = [
    { bg: "bg-secondary-container/20", text: "text-on-secondary-container", border: "border-secondary-container/50" },
    { bg: "bg-[#001c38]", text: "text-[#a2c9ff]", border: "border-[#004882]" },
    { bg: "bg-[#002106]", text: "text-[#90fa97]", border: "border-[#00531b]" }
  ];

  const toggleExpand = async () => {
    const wasCollapsed = !isExpanded;
    setIsExpanded(prev => !prev);
    if (wasCollapsed && !summary) {
      await onGenerateSummary?.(dev);
    }
  };

  const username = dev?.username || '';
  const githubUrl = `https://github.com/${username}`;
  const avatar = dev?.avatar || `https://avatars.githubusercontent.com/${username}`;
  const cleanLocation = normalizeLocationForDisplay(dev?.location);
  const linkedinUrl = typeof dev?.linkedin_url === 'string' ? dev.linkedin_url.trim() : '';
  const hasLinkedin = linkedinUrl !== '';

  function handleCopyLink() {
    const url = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(username)}`;
    window.history.replaceState(null, '', `#${encodeURIComponent(username)}`);
    navigator.clipboard.writeText(url).catch(() => {});
    onCopyLink?.(username);
    setCopyFeedback(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedback(false), 1500);
  }

  return (
    <div ref={highlightRef} className={`border-b border-outline-variant${isHighlighted ? ' ring-2 ring-inset ring-primary' : ''}`}>
      {/* Main Row Info */}
      <div className={`grid grid-cols-1 md:grid-cols-12 md:gap-x-4 items-center py-6 px-6 group hover:bg-surface-container-low transition-colors cursor-pointer${isHighlighted ? ' bg-primary/5' : ' bg-surface'}`} onClick={toggleExpand}>
        <div className="col-span-full md:col-span-1 mb-2 md:mb-0">
          <span className="font-mono text-2xl font-bold text-outline-variant group-hover:text-primary transition-colors">
            {String(dev.rank).padStart(3, '0')}
          </span>
        </div>
        <div className="col-span-full md:col-span-4 flex items-center gap-4 mb-4 md:mb-0">
          <div className="relative shrink-0">
            <img alt={username} className="w-12 h-12 grayscale group-hover:grayscale-0 transition-all border border-outline-variant p-0.5 object-cover" src={avatar} />
            {dev.rank <= 3 && <div className="absolute -top-1 -right-1 w-3 h-3 bg-tertiary border-2 border-surface"></div>}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="font-headline font-bold text-lg leading-tight truncate">{username}</div>
            <div className="font-mono text-xs text-outline truncate">{dev.name || `github.com/${username}`}</div>
          </div>
        </div>
        <div className="col-span-full md:col-span-2 mb-4 md:mb-0 md:-ml-2 md:pr-2 min-w-0 w-full">
          <div className="flex items-start gap-2 text-on-surface-variant font-mono text-sm min-w-0 w-full">
            <span className="material-symbols-outlined shrink-0 text-sm" aria-hidden>location_on</span>
            <span className="min-w-0 flex-1 break-words leading-snug">{cleanLocation}</span>
          </div>
        </div>
        <div className="col-span-full flex w-full min-w-0 items-center gap-2 md:contents">
          <div className="min-w-0 flex flex-1 flex-nowrap items-center justify-start gap-1.5 overflow-hidden md:col-span-3 md:pl-1 md:flex-wrap md:gap-2">
            {Array.isArray(dev.tags) && dev.tags.slice(0, 3).map((tag, idx) => {
               const colors = tagsColors[idx % tagsColors.length];
               return (
                 <span key={tag} className={`shrink-0 max-w-[min(100%,7.5rem)] truncate ${colors.bg} ${colors.text} text-xs font-mono px-1.5 py-0.5 border md:max-w-none md:px-2 ${colors.border} ${idx >= 2 ? 'hidden md:inline' : ''}`}>
                   {tag.toUpperCase()}
                 </span>
               );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-3 md:contents">
            <div className="whitespace-nowrap text-left font-mono font-bold text-tertiary tabular-nums md:col-span-1 md:flex md:justify-end md:text-right">
              {dev.score?.toLocaleString() || 0}
            </div>
            <div className="flex shrink-0 items-center gap-2 justify-end md:col-span-1">
              <a
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label={`${username} on GitHub`}
                className="text-outline hover:text-primary transition-colors"
              >
                <GitHubIcon />
              </a>
              <button type="button" onClick={(e) => { e.stopPropagation(); toggleExpand(); }} className="text-outline hover:text-primary transition-colors" aria-expanded={isExpanded} aria-label={isExpanded ? 'Collapse details' : 'Expand details'}>
                <span className="material-symbols-outlined">{isExpanded ? 'expand_less' : 'unfold_more'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="bg-surface-container-lowest border-t border-outline-variant p-6 md:p-8 transform transition-all">
          <div className="grid md:grid-cols-12 gap-8">
            <div className="md:col-span-4 space-y-6">
              <div>
                <h3 className="font-mono text-xs text-outline uppercase tracking-widest mb-4">Bio_Data</h3>
                <p className="text-sm text-on-surface-variant leading-relaxed font-body">
                  {loadingSummaryUser === username ? "Generating AI Summary..." : (summary && summary !== 'error') ? summary : dev.bio || "No biography available."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="border-l border-outline-variant pl-4 py-2">
                  <div className="font-mono text-xs text-outline uppercase">Followers</div>
                  <div className="font-headline font-bold text-xl">{dev.followers >= 1000 ? (dev.followers/1000).toFixed(1) + 'k' : (dev.followers || 0)}</div>
                </div>
                <div className="border-l border-outline-variant pl-4 py-2">
                  <div className="font-mono text-xs text-outline uppercase">Repos</div>
                  <div className="font-headline font-bold text-xl">{dev.public_repos || 0}</div>
                </div>
              </div>
            </div>
            <div className="md:col-span-8 flex flex-col">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-grow">
                {/* Heatmap */}
                <div className="flex flex-col">
                  <h3 className="font-mono text-xs text-outline uppercase tracking-widest mb-4">Contribution_Heatmap</h3>
                  <div className="flex-grow bg-surface border border-outline-variant p-2 overflow-hidden flex justify-center items-center h-[160px]">
                    <ContributionHeatmap username={username} />
                  </div>
                </div>

                {/* Top Repos */}
                <div className="flex flex-col">
                  <h3 className="font-mono text-xs text-outline uppercase tracking-widest mb-4">Top_Repos</h3>
                  <div className="flex-grow bg-surface border border-outline-variant p-3 overflow-y-auto h-[160px]">
                    {Array.isArray(dev.top_repos) && dev.top_repos.length > 0 ? (
                      <ul className="text-xs text-on-surface-variant space-y-2">
                        {dev.top_repos.map(r => (
                          <li key={r.name} className="flex justify-between items-center border-b border-surface-container pb-1">
                            <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate font-mono mr-2">{r.name}</a>
                            <span className="text-tertiary text-xs">⭐ {r.stars}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-xs text-outline font-mono mt-4 text-center">No public repositories found.</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
                <a href={githubUrl} target="_blank" rel="noreferrer" className="flex items-center justify-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-xs uppercase hover:text-primary transition-all active:translate-y-px">
                  View GitHub
                </a>
                {hasLinkedin ? (
                  <a
                    href={linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={linkedinUrl}
                    className="flex items-center justify-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-xs uppercase hover:text-primary transition-all active:translate-y-px"
                  >
                    Contact Dev
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="This developer has not linked a LinkedIn profile on GitHub."
                    className="flex items-center justify-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-xs uppercase text-outline opacity-60 cursor-not-allowed"
                  >
                    Contact Unavailable
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onGenerateBadge?.(username)}
                  className="flex items-center justify-center bg-tertiary text-on-tertiary py-2.5 font-mono text-xs font-bold uppercase hover:bg-tertiary-fixed transition-all active:translate-y-px"
                >
                  Generate Badge
                </button>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="flex items-center justify-center gap-1 bg-surface-container-high border border-outline-variant py-2.5 font-mono text-xs uppercase hover:text-primary transition-all active:translate-y-px"
                  title={`Copy shareable link for ${username}`}
                >
                  <span className="material-symbols-outlined text-sm leading-none">{copyFeedback ? 'check' : 'link'}</span>
                  {copyFeedback ? 'COPIED!' : 'Copy Link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
