import { useEffect, useState } from 'react';
import DevCard from '../components/DevCard';
import { loadBoard, loadDeveloperHistory } from '../utils/leaderboard-data';
import { boardSpells, shortDate } from '../utils/rank-history-text';

/** Each spell on the board under the current scoring, newest first, and how each one ended. */
function Spells({ username }) {
  const [file, setFile] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadDeveloperHistory(username).then(
      ({ history }) => !cancelled && setFile(history),
      () => !cancelled && setFile(null)
    );
    return () => {
      cancelled = true;
    };
  }, [username]);
  if (!file) return null;
  const spells = boardSpells(file).reverse();
  return (
    <div className="border border-outline-variant bg-surface p-4">
      <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-3">
        On_The_Board
      </h3>
      <ul className="space-y-2">
        {spells.map((spell) => (
          <li
            key={spell.from}
            className="flex flex-col gap-1 border-b border-surface-container pb-2 sm:flex-row sm:items-baseline sm:justify-between"
          >
            <span className="font-mono text-xs text-on-surface tabular-nums">
              {shortDate(spell.from)}
              {spell.left === null
                ? spell.from === spell.to
                  ? ' · today'
                  : ' to today'
                : spell.to !== spell.from
                  ? ` to ${shortDate(spell.to)}`
                  : ''}
              <span className="text-outline"> · best {spell.best}</span>
            </span>
            {spell.left ? (
              <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
                {spell.left}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A developer's page, at rankistan.dev/#login: the link every README badge carries. Their card
 * open, with Rank History, and each spell on the board under the current scoring. It shows only
 * while they are on today's board (the owner's decision, 16 October 2026).
 */
export default function Developer({ login, onBack }) {
  const [state, setState] = useState({ login: null, row: null, sharedBy: 1, status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadBoard().then(
      ({ payload }) => {
        if (cancelled) return;
        const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
        const wanted = login.toLowerCase();
        const row = rows.find((r) => String(r?.username || '').toLowerCase() === wanted) ?? null;
        const sharedBy = row ? rows.filter((r) => r.rank === row.rank).length : 1;
        setState({ login, row, sharedBy, status: row ? 'ready' : 'missing' });
      },
      () => !cancelled && setState({ login, row: null, sharedBy: 1, status: 'failed' })
    );
    return () => {
      cancelled = true;
    };
  }, [login]);

  const current = state.login === login ? state : { status: 'loading' };

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-7xl mx-auto p-4 md:p-8 relative z-10">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-sm" aria-hidden="true">
            arrow_back
          </span>
          The leaderboard
        </button>
        <div className="border-l-4 border-primary pl-6 mb-8">
          <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter leading-none break-words">
            {current.row?.username ?? login}
          </h1>
        </div>
        {current.status === 'ready' ? (
          <div className="space-y-6">
            <div className="border border-outline-variant">
              <DevCard
                dev={current.row}
                sharedBy={current.sharedBy}
                defaultExpanded
                onGenerateSummary={() => {}}
              />
            </div>
            <Spells username={current.row.username} />
          </div>
        ) : (
          <p className="font-mono text-sm text-outline max-w-xl leading-relaxed">
            {current.status === 'loading'
              ? 'Loading...'
              : current.status === 'failed'
                ? 'The board could not be loaded just now.'
                : `${login} is not on today's board. A developer's page shows here only while they are on it.`}
          </p>
        )}
      </div>
    </main>
  );
}
