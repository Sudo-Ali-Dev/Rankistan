import { useEffect, useState } from 'react';
import { loadBoard, loadDeveloperHistory } from '../utils/leaderboard-data';
import { registerSummary } from '../utils/rank-history-text';

/**
 * Register's line for a profile already on the board: where it stands today, how it moved since
 * yesterday, its first day and best rank under the current scoring, and a link to its page. Nothing
 * for a profile not on the board.
 */
export default function BoardStanding({ login }) {
  const [state, setState] = useState({ login: null, text: null, username: null });

  useEffect(() => {
    if (!login) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { payload } = await loadBoard();
        const wanted = login.toLowerCase();
        const row = (payload?.leaderboard ?? []).find(
          (r) => String(r?.username || '').toLowerCase() === wanted
        );
        if (!row) return;
        const { history } = await loadDeveloperHistory(row.username);
        if (!cancelled) setState({ login, text: registerSummary(history), username: row.username });
      } catch {
        // No board, or no history: Register says nothing it has not checked.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [login]);

  if (state.login !== login || !state.text) return null;
  return (
    <section className="mt-6 border border-outline-variant bg-surface-container-lowest p-4 sm:p-6">
      <h2 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-2">
        On_The_Board
      </h2>
      <p className="font-mono text-xs text-on-surface uppercase tracking-widest tabular-nums">
        {state.text}
      </p>
      <a
        href={`/#${encodeURIComponent(state.username)}`}
        className="mt-3 inline-flex min-h-11 sm:min-h-0 items-center font-mono text-[10px] text-primary uppercase tracking-widest hover:underline"
      >
        View rank history →
      </a>
    </section>
  );
}
