import React, { useState } from 'react';
import { normalizeLocationForDisplay } from '../utils/location';

export default function DevCard({ dev, onGenerateSummary, summary, loadingSummaryUser }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const tagsColors = [
    { bg: "bg-secondary-container/20", text: "text-on-secondary-container", border: "border-secondary-container/50" },
    { bg: "bg-[#001c38]", text: "text-[#a2c9ff]", border: "border-[#004882]" },
    { bg: "bg-[#002106]", text: "text-[#90fa97]", border: "border-[#00531b]" }
  ];

  const toggleExpand = async () => {
    setIsExpanded(!isExpanded);
    if (!isExpanded && !summary) {
      await onGenerateSummary(dev);
    }
  };

  const username = dev?.username || '';
  const avatar = dev?.avatar || `https://avatars.githubusercontent.com/${username}`;
  const cleanLocation = normalizeLocationForDisplay(dev?.location);
  const linkedinUrl = typeof dev?.linkedin_url === 'string' ? dev.linkedin_url.trim() : '';
  const hasLinkedin = linkedinUrl !== '';
  
  return (
    <div className="border-b border-outline-variant">
      {/* Main Row Info */}
      <div className="grid grid-cols-1 md:grid-cols-12 md:gap-x-4 bg-surface items-center py-6 px-6 group hover:bg-surface-container-low transition-colors">
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
                 <span key={tag} className={`shrink-0 max-w-[min(100%,7.5rem)] truncate ${colors.bg} ${colors.text} text-[10px] font-mono px-1.5 py-0.5 border md:max-w-none md:px-2 ${colors.border} ${idx >= 2 ? 'hidden md:inline' : ''}`}>
                   {tag.toUpperCase()}
                 </span>
               );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-3 md:contents">
            <div className="whitespace-nowrap text-left font-mono font-bold text-tertiary tabular-nums md:col-span-1 md:flex md:justify-end md:text-right">
              {dev.score?.toLocaleString() || 0}
            </div>
            <div className="flex shrink-0 justify-end md:col-span-1">
              <button type="button" onClick={toggleExpand} className="text-outline hover:text-primary transition-colors" aria-expanded={isExpanded} aria-label={isExpanded ? 'Collapse details' : 'Expand details'}>
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
                <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Bio_Data</h3>
                <p className="text-sm text-on-surface-variant leading-relaxed font-body">
                  {loadingSummaryUser === username ? "Generating AI Summary..." : (summary && summary !== 'error') ? summary : dev.bio || "No biography available."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="border-l border-outline-variant pl-4 py-2">
                  <div className="font-mono text-[10px] text-outline uppercase">Followers</div>
                  <div className="font-headline font-bold text-xl">{dev.followers >= 1000 ? (dev.followers/1000).toFixed(1) + 'k' : (dev.followers || 0)}</div>
                </div>
                <div className="border-l border-outline-variant pl-4 py-2">
                  <div className="font-mono text-[10px] text-outline uppercase">Repos</div>
                  <div className="font-headline font-bold text-xl">{dev.public_repos || 0}</div>
                </div>
              </div>
            </div>
            <div className="md:col-span-8 flex flex-col">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-grow">
                {/* Heatmap */}
                <div className="flex flex-col">
                  <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Contribution_Heatmap</h3>
                  <div className="flex-grow bg-surface border border-outline-variant p-2 overflow-hidden flex justify-center items-center h-[160px]">
                     <img 
                       src={`https://ghchart.rshah.org/50b85e/${username}`} 
                       alt={`${username} chart`} 
                       className="w-full h-full object-contain opacity-80 hover:opacity-100 transition-all drop-shadow-md" 
                     />
                  </div>
                </div>

                {/* Top Repos */}
                <div className="flex flex-col">
                  <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">Top_Repos</h3>
                  <div className="flex-grow bg-surface border border-outline-variant p-3 overflow-y-auto h-[160px]">
                    {Array.isArray(dev.top_repos) && dev.top_repos.length > 0 ? (
                      <ul className="text-xs text-on-surface-variant space-y-2">
                        {dev.top_repos.map(r => (
                          <li key={r.name} className="flex justify-between items-center border-b border-surface-container pb-1">
                            <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate font-mono mr-2">{r.name}</a>
                            <span className="text-tertiary text-[10px]">⭐ {r.stars}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-xs text-outline font-mono mt-4 text-center">No public repositories found.</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
                <a href={`https://github.com/${username}`} target="_blank" rel="noreferrer" className="text-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-[10px] uppercase hover:text-primary transition-all active:translate-y-px">
                  View GitHub
                </a>
                {hasLinkedin ? (
                  <a
                    href={linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={linkedinUrl}
                    className="text-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-[10px] uppercase hover:text-primary transition-all active:translate-y-px"
                  >
                    Contact Dev
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="This developer has not linked a LinkedIn profile on GitHub."
                    className="text-center bg-surface-container-high border border-outline-variant py-2.5 font-mono text-[10px] uppercase text-outline opacity-60 cursor-not-allowed"
                  >
                    Contact Unavailable
                  </button>
                )}
                <a href={`https://github.com/${username}`} target="_blank" rel="noreferrer" className="text-center bg-tertiary text-on-tertiary py-2.5 font-mono text-[10px] font-bold uppercase hover:bg-tertiary-fixed transition-all active:translate-y-px">
                  Follow Node
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
