import { useEffect, useMemo, useState } from 'react';
import { resolveHeatmapJsonUrl } from '../utils/groq.js';
import { sparklinePath } from '../utils/sparkline';

/**
 * The activity sparkline from #50, with its data replaced.
 *
 * The panel, the curve and the bar geometry are that PR's. What it drew was a
 * 30-day series invented from the `events_30d` total by a seeded random walk,
 * which is why 5eae21d took it out. The shape now comes from GitHub's own
 * per-day contribution intensity, read through the Worker.
 *
 * The headline figure is days active rather than a number of events, because
 * intensity is a 0-4 band: summing it would print a quantity of work that the
 * data does not contain. Counting the days that had any activity is a claim the
 * series can actually support.
 */
export default function ActivitySparkline({ username }) {
  const [result, setResult] = useState({ username: null, days: null });

  useEffect(() => {
    if (!username) return undefined;

    let cancelled = false;

    fetch(resolveHeatmapJsonUrl(username))
      .then((response) => {
        if (!response.ok) throw new Error(`Activity request failed: ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const series = Array.isArray(payload?.days) ? payload.days : [];
        if (series.length === 0) throw new Error('Activity response carried no days.');
        setResult({ username, days: series });
      })
      .catch(() => {
        if (!cancelled) setResult({ username, days: null });
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  const days = result.username === username ? result.days : null;

  const {
    path,
    bars,
    maxVal,
    activeDays,
    days: shown
  } = useMemo(
    () =>
      sparklinePath(
        (days || []).map((day) => day.level),
        240,
        40
      ),
    [days]
  );

  // Renders nothing until there is a real series to draw, rather than an empty
  // frame or a flat line standing in for data that has not arrived.
  if (!days || bars.length === 0) return null;

  return (
    <div className="border border-outline-variant bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest">
          Activity_Sparkline
        </h3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-tertiary tabular-nums">
            {activeDays}/{shown} active
          </span>
          <span className="font-mono text-[9px] text-outline uppercase tracking-wider">
            Intensity
          </span>
        </div>
      </div>
      <div className="w-full overflow-hidden">
        <svg
          viewBox="0 0 240 44"
          preserveAspectRatio="none"
          className="w-full h-10"
          role="img"
          aria-label={`Activity sparkline for ${username || 'developer'}: contribution intensity over the last 30 days, peak ${maxVal} of 4`}
        >
          <g className="text-tertiary">
            {bars.map((bar) => (
              <rect
                key={bar.key}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx="1"
                fill="currentColor"
                opacity="0.25"
              />
            ))}
          </g>
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-tertiary"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="flex justify-between mt-1.5 font-mono text-[8px] text-outline-variant uppercase tracking-widest">
        <span>{shown} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
