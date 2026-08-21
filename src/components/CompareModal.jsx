import { useEffect, useRef } from 'react';
import { normalizeLocationForDisplay } from '../utils/location';

const COMPARE_ROWS = [
  { key: 'rank', label: 'Rank', type: 'number', lowerBetter: true },
  { key: 'score', label: 'Score', type: 'number', lowerBetter: false },
  { key: 'followers', label: 'Followers', type: 'number', lowerBetter: false },
  { key: 'public_repos', label: 'Public Repos', type: 'number', lowerBetter: false },
  { key: 'total_stars', label: 'Total Stars', type: 'number', lowerBetter: false },
  { key: 'events_30d', label: 'Events (30d)', type: 'number', lowerBetter: false },
  { key: 'location', label: 'Location', type: 'string' },
  { key: 'top_languages', label: 'Top Languages', type: 'array' },
  { key: 'tags', label: 'Tags', type: 'array' },
];

function formatValue(dev, row) {
  const val = dev[row.key];
  if (row.type === 'number') {
    if (val == null) return '\u2014';
    if (row.key === 'followers' && val >= 1000) return (val / 1000).toFixed(1) + 'k';
    return val.toLocaleString();
  }
  if (row.type === 'array') {
    if (!Array.isArray(val) || val.length === 0) return '\u2014';
    return val.join(', ');
  }
  if (row.key === 'location') return normalizeLocationForDisplay(val) || '\u2014';
  return val || '\u2014';
}

function findWinner(devs, row) {
  if (row.type !== 'number' || devs.length < 2) return -1;
  let bestIdx = 0;
  for (let i = 1; i < devs.length; i++) {
    const a = devs[bestIdx][row.key] ?? (row.lowerBetter ? Infinity : -Infinity);
    const b = devs[i][row.key] ?? (row.lowerBetter ? Infinity : -Infinity);
    if (row.lowerBetter ? b < a : b > a) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

export default function CompareModal({ developers, onClose }) {
  const panelRef = useRef(null);

  // Escape to dismiss, and move focus into the dialog on open so a keyboard
  // user is not left behind on the list underneath. The panel's
  // stopPropagation was previously paired with no backdrop handler, so
  // clicking outside did nothing at all.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', onKeyDown);
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  if (!developers || developers.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Developer comparison"
        tabIndex={-1}
        className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto border border-outline-variant bg-surface-container-lowest outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high">
          <div className="flex items-center gap-3 min-w-0">
            <span className="material-symbols-outlined text-primary shrink-0">compare_arrows</span>
            <span className="font-headline text-base sm:text-lg font-bold uppercase tracking-tight">Developer Comparison</span>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest hidden sm:inline">
              {developers.length} Nodes
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-outline hover:text-primary transition-colors font-mono text-xs shrink-0"
          >
            <span className="material-symbols-outlined text-sm">close</span>
            CLOSE
          </button>
        </div>

        {/* Comparison Table */}
        <div className="overflow-x-auto relative">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container-low">
                <th className="sticky left-0 z-10 bg-surface-container-low text-left font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-4 w-32 sm:w-40 min-w-[120px] sm:min-w-[140px]">
                  Metric
                </th>
                {developers.map((dev) => (
                  <th key={dev.username} className="text-center font-mono text-[10px] text-outline uppercase tracking-widest px-3 sm:px-4 py-4 min-w-[130px] sm:min-w-[160px]">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-8 h-8 sm:w-10 sm:h-10 border border-outline-variant overflow-hidden grayscale hover:grayscale-0 transition-all">
                        <img
                          src={dev.avatar_url || `https://github.com/${dev.username}.png?size=40`}
                          alt={dev.username}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="font-headline font-bold text-xs text-primary truncate max-w-[120px] sm:max-w-none">{dev.username}</div>
                        {dev.name && <div className="text-[9px] text-outline truncate max-w-[120px] sm:max-w-[140px]">{dev.name}</div>}
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => {
                const winnerIdx = findWinner(developers, row);
                return (
                  <tr key={row.key} className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors">
                    <td className="sticky left-0 z-10 bg-surface-container-lowest px-3 sm:px-4 py-3 font-mono text-[10px] text-outline uppercase tracking-widest">
                      {row.label}
                    </td>
                    {developers.map((dev, idx) => {
                      const isWinner = idx === winnerIdx;
                      return (
                        <td
                          key={dev.username}
                          className={`px-3 sm:px-4 py-3 text-center font-mono text-xs ${
                            isWinner ? 'bg-tertiary/10 text-tertiary font-bold' : 'text-on-surface'
                          }`}
                        >
                          {formatValue(dev, row)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-outline-variant bg-surface-container-high text-center">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 bg-primary text-on-primary font-headline font-bold py-2.5 px-5 hover:bg-primary-container transition-colors duration-50 active:scale-[0.98] uppercase tracking-widest text-xs"
          >
            Close Comparison
          </button>
        </div>
      </div>
    </div>
  );
}
