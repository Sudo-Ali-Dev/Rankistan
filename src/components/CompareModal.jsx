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
    if (val == null) return '—';
    if (row.key === 'followers' && val >= 1000) return (val / 1000).toFixed(1) + 'k';
    return val.toLocaleString();
  }
  if (row.type === 'array') {
    if (!Array.isArray(val) || val.length === 0) return '—';
    return val.join(', ');
  }
  if (row.key === 'location') return normalizeLocationForDisplay(val) || '—';
  return val || '—';
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
  if (!developers || developers.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto border border-outline-variant bg-surface-container-lowest"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-6 border-b border-outline-variant bg-surface-container-high">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary">compare_arrows</span>
            <span className="font-headline text-lg font-bold uppercase tracking-tight">Developer Comparison</span>
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
              {developers.length} Nodes
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-outline hover:text-primary transition-colors font-mono text-xs"
          >
            <span className="material-symbols-outlined text-sm">close</span>
            CLOSE
          </button>
        </div>

        {/* Comparison Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container-low">
                <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-4 w-40 min-w-[140px]">
                  Metric
                </th>
                {developers.map((dev) => (
                  <th key={dev.username} className="text-center font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-4 min-w-[160px]">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-10 h-10 border border-outline-variant overflow-hidden grayscale hover:grayscale-0 transition-all">
                        <img
                          src={dev.avatar_url || `https://github.com/${dev.username}.png?size=40`}
                          alt={dev.username}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div>
                        <div className="font-headline font-bold text-xs text-primary">{dev.username}</div>
                        {dev.name && <div className="text-[9px] text-outline truncate max-w-[140px]">{dev.name}</div>}
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
                    <td className="px-4 py-3 font-mono text-[10px] text-outline uppercase tracking-widest">
                      {row.label}
                    </td>
                    {developers.map((dev, idx) => {
                      const isWinner = idx === winnerIdx;
                      return (
                        <td
                          key={dev.username}
                          className={`px-4 py-3 text-center font-mono text-xs ${
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
