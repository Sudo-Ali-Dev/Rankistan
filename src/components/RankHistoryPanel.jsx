import { useEffect, useMemo, useState } from 'react';
import { loadDeveloperHistory } from '../utils/leaderboard-data';
import {
  attributionLine,
  historySentences,
  panelStats,
  shortDate
} from '../utils/rank-history-text';
import { historyLines } from '../utils/rank-history-lines';

// The plot and its scale: a fixed scale column, so every plot in the panel shares one x.
const PLOT_GRID = 'grid grid-cols-[1fr_3.5rem] gap-x-3';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

// Centred on its point, except at the ends, where centring would hang it off the card.
function tooltipPosition(x) {
  const pct = (x / 240) * 100;
  if (pct <= 12) return { left: 0 };
  if (pct >= 88) return { right: 0 };
  return { left: `${pct}%`, transform: 'translateX(-50%)' };
}

/** One cell of the stat strip, styled as the card's Followers and Repos cells. */
function Stat({ label, value, sub, tone = 'text-on-surface', title }) {
  return (
    <div className="border-l border-outline-variant pl-3 py-1 min-w-0" title={title}>
      <div className="font-mono text-[10px] text-outline uppercase tracking-widest">{label}</div>
      <div className={`font-headline font-bold text-xl tabular-nums leading-tight ${tone}`}>
        {value}
      </div>
      <div className="font-mono text-[10px] text-outline uppercase tracking-wider tabular-nums break-words">
        {sub}
      </div>
    </div>
  );
}

/**
 * One line of the chart, with its scale beside it in HTML: the plot is stretched to the card's
 * width, so text inside the SVG would be smeared sideways.
 */
function Chart({ label, d, alone, bands, top, bottom, tone, hoveredX, onPointer, onLeave, title }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-1">
        {label}
      </div>
      <div className={`${PLOT_GRID} items-stretch`}>
        <svg
          viewBox="0 0 240 40"
          preserveAspectRatio="none"
          className="w-full h-12 border-y border-outline-variant/40"
          role="img"
          aria-label={title}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={onLeave}
        >
          {bands.map((band) => (
            <rect
              key={band.x0}
              x={band.x0}
              y="0"
              width={Math.max(0, band.x1 - band.x0)}
              height="40"
              fill="currentColor"
              className="text-outline-variant"
              opacity="0.18"
            />
          ))}
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
          {hoveredX !== null ? (
            <line
              x1={hoveredX}
              x2={hoveredX}
              y1="0"
              y2="40"
              stroke="currentColor"
              className="text-outline"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <div className="flex flex-col justify-between py-0.5 font-mono text-[10px] text-outline tabular-nums text-right">
          <span>{top}</span>
          <span>{bottom}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The Rank_History panel of an expanded card, in the card's own terse voice: where the developer
 * stands, how the rank moved in the last 24 hours and how much of that their own score explains,
 * their peak daily close and days on the board under the current scoring, and the rank and score
 * each day. The same facts in plain sentences go to screen readers and the delta's tooltip.
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
  const lines = useMemo(() => (file && file.points.length > 1 ? historyLines(file) : null), [file]);

  const frame = (right, body) => (
    <div className="border border-outline-variant bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest">
          Rank_History
        </h3>
        {right ? (
          <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
            {right}
          </span>
        ) : null}
      </div>
      {body}
    </div>
  );

  if (!file) {
    return frame(
      null,
      <p className="font-mono text-[10px] text-outline uppercase tracking-widest">
        {state.failed && state.username === username
          ? 'Rank history unavailable'
          : 'Fetching rank history...'}
      </p>
    );
  }

  const stats = panelStats(file);
  const sentences = historySentences(file).join(' ');
  const attribution = attributionLine(file);
  const trackPointer = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || !lines) return;
    const ratio = ((event.clientX - box.left) / box.width) * 240;
    let best = 0;
    lines.dots.forEach((dot, i) => {
      if (Math.abs(dot.x - ratio) < Math.abs(lines.dots[best].x - ratio)) best = i;
    });
    setHovered(best);
  };
  const active = lines && hovered !== null ? lines.points[hovered] : null;
  const hoveredX = lines && hovered !== null ? lines.dots[hovered].x : null;

  return frame(
    `Model v${file.scoring.version} · since ${shortDate(file.scoring.since)}`,
    <>
      <p className="sr-only">{sentences}</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-4">
        <Stat {...stats.rank} />
        <Stat {...stats.delta} title={sentences} />
        <Stat {...stats.peak} />
        <Stat {...stats.onBoard} />
      </div>
      {attribution ? (
        <div
          className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-outline-variant/40 pt-3 font-mono text-[10px] uppercase tracking-widest"
          title="OWN is the places the developer's own score change explains. FIELD is the places other developers' changes explain."
        >
          <span className="text-outline">Attribution</span>
          <span className="text-on-surface-variant tabular-nums" aria-hidden="true">
            {attribution}
          </span>
        </div>
      ) : null}
      <div className="mt-4">
        {lines ? (
          <div className="relative space-y-3 sm:pt-6">
            {active ? (
              // Over the plot column only, so it sits above the point it describes.
              <div
                className={`${PLOT_GRID} pointer-events-none absolute inset-x-0 top-5 z-10 hidden sm:grid`}
              >
                <div className="relative">
                  <div
                    aria-hidden="true"
                    className="absolute bottom-0 whitespace-nowrap border border-outline-variant bg-surface-container-high px-2 py-1 font-mono text-[10px] tabular-nums"
                    style={tooltipPosition(hoveredX)}
                  >
                    <span className="text-outline">
                      {weekday(active.d)} {shortDate(active.d)}
                    </span>{' '}
                    <span className="text-on-surface">#{active.rank}</span>{' '}
                    <span className="text-tertiary">{active.score.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : null}
            <Chart
              label="Rank"
              d={lines.rank}
              alone={lines.rankDots}
              bands={lines.offBands}
              top={`#${lines.rankRange.top}`}
              bottom={`#${lines.rankRange.bottom}`}
              tone="text-on-surface-variant"
              hoveredX={hoveredX}
              onPointer={trackPointer}
              onLeave={() => setHovered(null)}
              title={`Daily rank of ${username} since ${shortDate(file.first)}, best at the top`}
            />
            <Chart
              label="Score"
              d={lines.score}
              alone={lines.scoreDots}
              bands={lines.offBands}
              top={lines.scoreRange.top.toFixed(2)}
              bottom={lines.scoreRange.bottom.toFixed(2)}
              tone="text-tertiary"
              hoveredX={hoveredX}
              onPointer={trackPointer}
              onLeave={() => setHovered(null)}
              title={`Daily score of ${username} since ${shortDate(file.first)}`}
            />
            <div className="flex min-h-[1rem] items-center font-mono text-[10px] tabular-nums sm:hidden">
              {active ? (
                <>
                  <span className="text-outline">
                    {weekday(active.d)} {shortDate(active.d)}
                  </span>
                  <span className="ml-2 text-on-surface">#{active.rank}</span>
                  <span className="ml-2 text-tertiary">{active.score.toFixed(2)}</span>
                </>
              ) : null}
            </div>
            <div className={PLOT_GRID}>
              <div className="flex justify-between font-mono text-[10px] text-outline-variant uppercase tracking-widest">
                <span>{shortDate(file.first)}</span>
                {lines.offBands.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-3 bg-outline-variant/40"
                      aria-hidden="true"
                    />
                    Off board
                  </span>
                ) : null}
                <span>Today</span>
              </div>
              <span aria-hidden="true" />
            </div>
          </div>
        ) : (
          <div className="border border-dashed border-outline-variant px-3 py-4 font-mono text-[10px] text-outline uppercase tracking-widest">
            Awaiting data · first daily close at 00:00 PKT
          </div>
        )}
      </div>
    </>
  );
}
