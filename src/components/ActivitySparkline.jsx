import { useEffect, useMemo, useState } from 'react';
import { resolveHeatmapJsonUrl } from '../utils/groq.js';
import { sparklinePath } from '../utils/sparkline';

// Formatted by hand rather than through Intl: `en-GB` renders September as
// "Sept", which is four characters next to every other month's three and reads
// as a typo in a mono row. Fixed widths also mean the label cannot change size
// as you move along the plot.
//
// The date is parsed as UTC on purpose. `new Date('2026-09-17')` is UTC
// midnight, so reading it with local getters in a behind-UTC timezone would
// name the day before and the tooltip would disagree with the bar it points at.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

// Centred on its column, except at the ends, where centring would hang the
// label off the edge of the card and clip it.
function tooltipPosition(index, total) {
  const pct = (index / Math.max(1, total - 1)) * 100;
  if (pct <= 10) return { left: 0 };
  if (pct >= 90) return { right: 0 };
  return { left: `${pct}%`, transform: 'translateX(-50%)' };
}

/** The per-day readout, shown floating above the plot on a pointer device and
 *  parked under it on a phone, where a fingertip would cover a tooltip. */
function Readout({ day }) {
  return (
    <>
      <span className="text-outline">{formatDay(day.date)}</span>{' '}
      <span className={day.level > 0 ? 'text-tertiary' : 'text-outline'}>
        {day.level > 0 ? `level ${day.level} of 4` : 'no contributions'}
      </span>
    </>
  );
}

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
  const [hovered, setHovered] = useState(null);

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

  // `sparklinePath` draws only the tail of the series, so line the dates up with
  // the bars before either is indexed - `days` is the full 90 the Worker sends.
  const window = days.slice(-shown);
  const active = hovered === null ? null : window[hovered];

  // Read the day off the pointer's position rather than giving each one its own
  // target. At 375 the plot is 343px wide, so a per-day target is 9px - under a
  // third of a fingertip, and no amount of tuning makes 30 of them tappable.
  // Tracking the pointer means a drag along the plot scrubs through the days on
  // touch, and hovering works unchanged with a mouse.
  const trackPointer = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const ratio = (event.clientX - box.left) / box.width;
    const index = Math.round(ratio * (shown - 1));
    setHovered(Math.min(shown - 1, Math.max(0, index)));
  };

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
      <div className="relative w-full">
        {/* HTML, not an SVG <text>. The plot is drawn with
            `preserveAspectRatio="none"`, so 240 viewBox units are stretched
            across the full card - about 4.6x horizontally against 0.9x
            vertically. Anything lettered inside the SVG inherits that and comes
            out smeared sideways. */}
        {active ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap border border-outline-variant bg-surface-container-high px-2 py-1 font-mono text-[10px] sm:block"
            style={tooltipPosition(hovered, shown)}
          >
            <Readout day={active} />
          </div>
        ) : null}
        <svg
          viewBox="0 0 240 44"
          preserveAspectRatio="none"
          className="w-full h-10"
          role="img"
          aria-label={`Activity sparkline for ${username || 'developer'}: contribution intensity over the last 30 days, peak ${maxVal} of 4`}
          onPointerMove={trackPointer}
          onPointerDown={trackPointer}
          onPointerLeave={() => setHovered(null)}
          onMouseLeave={() => setHovered(null)}
        >
          <g className="text-tertiary">
            {bars.map((bar, index) => (
              <rect
                key={bar.key}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx="1"
                fill="currentColor"
                opacity={hovered === index ? 0.55 : 0.25}
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
      <div className="mt-2 flex min-h-[1.25rem] items-center font-mono text-[10px] sm:hidden">
        {active ? <Readout day={active} /> : null}
      </div>
      <div className="flex justify-between mt-1.5 font-mono text-[8px] text-outline-variant uppercase tracking-widest">
        <span>{shown} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
