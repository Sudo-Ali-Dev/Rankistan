import { useEffect, useMemo, useState } from 'react';
import { loadDeveloperHistory } from '../utils/leaderboard-data';
import { historySentences, moveMarker, shortDate } from '../utils/rank-history-text';
import { historyLines } from '../utils/rank-history-lines';

function Fact({ label, children }) {
  return (
    <div className="border-l border-outline-variant pl-3 py-1 min-w-0">
      <div className="font-mono text-[10px] text-outline uppercase tracking-widest">{label}</div>
      <div className="font-mono text-sm text-on-surface tabular-nums break-words">{children}</div>
    </div>
  );
}

function Line({ d, alone, dots, label, tone, hovered, onPointer, onLeave }) {
  return (
    <svg
      viewBox="0 0 240 40"
      preserveAspectRatio="none"
      className="w-full h-10"
      role="img"
      aria-label={label}
      onPointerMove={onPointer}
      onPointerDown={onPointer}
      onPointerLeave={onLeave}
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={tone}
        vectorEffect="non-scaling-stroke"
      />
      {alone ? (
        <path
          d={alone}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          className={tone}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {hovered !== null && dots[hovered] ? (
        <line
          x1={dots[hovered].x}
          x2={dots[hovered].x}
          y1="0"
          y2="40"
          stroke="currentColor"
          className="text-outline-variant"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

/**
 * The Rank_History panel of an expanded card: where the developer stands now, their best daily
 * close and first day under the current scoring, what moved their rank since this time yesterday,
 * and a rank line and a score line. It says so, rather than drawing anything, while there is no
 * history to show.
 */
export default function RankHistoryPanel({ username }) {
  const [state, setState] = useState({ username: null, file: null, failed: false });
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    if (!username) return undefined;
    let cancelled = false;
    loadDeveloperHistory(username).then(
      ({ history }) => !cancelled && setState({ username, file: history, failed: false }),
      () => !cancelled && setState({ username, file: null, failed: true })
    );
    return () => {
      cancelled = true;
    };
  }, [username]);

  const file = state.username === username ? state.file : null;
  const lines = useMemo(() => (file ? historyLines(file) : null), [file]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest">Rank_History</h3>
      {file ? (
        <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
          Current scoring · since {shortDate(file.scoring.since)}
        </span>
      ) : null}
    </div>
  );

  if (!file) {
    return (
      <div className="border border-outline-variant bg-surface p-4">
        {header}
        <p className="font-mono text-xs text-outline">
          {state.failed && state.username === username
            ? 'Rank History is not available for this developer right now.'
            : 'Loading Rank History...'}
        </p>
      </div>
    );
  }

  const now = file.points.at(-1);
  const marker = file.movement?.kind === 'move' ? moveMarker(file.movement.places) : null;
  const sentences = historySentences(file);
  const trackPointer = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || !lines) return;
    const ratio = (event.clientX - box.left) / box.width;
    let best = 0;
    lines.dots.forEach((dot, i) => {
      if (Math.abs(dot.x / 240 - ratio) < Math.abs(lines.dots[best].x / 240 - ratio)) best = i;
    });
    setHovered(best);
  };
  const active = hovered !== null ? lines.points[hovered] : null;

  return (
    <div className="border border-outline-variant bg-surface p-4">
      {header}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Fact label="Now">
          {now[1]}
          {now[2] > 1 ? <span className="text-outline"> · shared by {now[2]}</span> : null}
          {marker ? (
            <span className="text-outline">
              {' '}
              <span aria-hidden="true">
                {marker.text}
                <span className="text-[10px] uppercase tracking-widest"> since yesterday</span>
              </span>
              <span className="sr-only">{marker.label}</span>
            </span>
          ) : null}
        </Fact>
        <Fact label="Best">
          {file.best ? `${file.best.rank} (${shortDate(file.best.d)})` : 'From tomorrow'}
        </Fact>
        <Fact label="First on the board">{shortDate(file.first)}</Fact>
        <Fact label="Days on the board">
          {file.days_on} of {file.days_span}
        </Fact>
      </div>
      <p className="text-sm text-on-surface-variant leading-relaxed font-body mb-3">
        {sentences.join(' ')}
      </p>
      {lines && lines.points.length > 1 ? (
        <div className="space-y-2">
          <div className="flex min-h-[1.25rem] items-center font-mono text-[10px] text-outline tabular-nums">
            {active
              ? `${shortDate(active.d)} · rank ${active.rank} · ${active.score.toFixed(2)}`
              : 'Daily closes under the current scoring, and today'}
          </div>
          <div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-1">
              Rank, best at the top
            </div>
            <Line
              d={lines.rank}
              alone={lines.rankDots}
              dots={lines.dots}
              tone="text-on-surface-variant"
              label={`Rank of ${username} each day since ${shortDate(file.first)}`}
              hovered={hovered}
              onPointer={trackPointer}
              onLeave={() => setHovered(null)}
            />
          </div>
          <div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-1">
              Score
            </div>
            <Line
              d={lines.score}
              alone={lines.scoreDots}
              dots={lines.dots}
              tone="text-tertiary"
              label={`Score of ${username} each day since ${shortDate(file.first)}`}
              hovered={hovered}
              onPointer={trackPointer}
              onLeave={() => setHovered(null)}
            />
          </div>
          <div className="flex justify-between font-mono text-[8px] text-outline-variant uppercase tracking-widest">
            <span>{shortDate(file.first)}</span>
            <span>Today</span>
          </div>
        </div>
      ) : (
        <p className="font-mono text-[10px] text-outline uppercase tracking-widest">
          The lines start once there are two days to draw
        </p>
      )}
    </div>
  );
}
