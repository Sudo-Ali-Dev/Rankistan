import React from 'react';

/**
 * BadgeBanner
 * Sits between the leaderboard header and the dev table.
 * Props:
 *   onNavigateToBadge  — () => void   calls onChangeTab('badge') in parent
 */
export default function BadgeBanner({ onNavigateToBadge }) {
  return (
    <div className="mb-6 border border-outline-variant bg-surface-container-lowest flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-6 py-4">
      <div className="flex items-start gap-4 min-w-0">
        <span className="material-symbols-outlined text-secondary shrink-0 mt-0.5">shield</span>
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-secondary uppercase tracking-widest mb-1">New Feature</div>
          <p className="font-body text-sm text-on-surface-variant leading-snug">
            Flaunt your Rankistan rank in your GitHub README.{' '}
            <span className="font-mono text-[11px] text-primary">
              ranked_devs can embed a live badge powered by Rankistan.
            </span>
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onNavigateToBadge}
        className="shrink-0 flex items-center gap-2 border border-secondary text-secondary font-mono text-[10px] uppercase tracking-widest px-4 py-2 hover:bg-secondary/10 transition-colors active:scale-95"
      >
        <span className="material-symbols-outlined text-sm">arrow_forward</span>
        Get Your Badge
      </button>
    </div>
  );
}
