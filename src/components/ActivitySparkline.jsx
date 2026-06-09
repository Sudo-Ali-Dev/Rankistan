import { useMemo } from 'react';
import { generateDailyDistribution, sparklinePath } from '../utils/sparkline';

export default function ActivitySparkline({ totalEvents = 0, username }) {
  const { path, bars, maxVal, total } = useMemo(() => {
    const data = generateDailyDistribution(totalEvents);
    return sparklinePath(data, 240, 40);
  }, [totalEvents]);

  if (total === 0) return null;

  return (
    <div className="border border-outline-variant bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest">
          Activity_Sparkline
        </h3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-tertiary tabular-nums">
            {total} events
          </span>
          <span className="font-mono text-[9px] text-outline uppercase tracking-wider">
            30 days
          </span>
        </div>
      </div>
      <div className="w-full overflow-hidden">
        <svg
          viewBox="0 0 240 44"
          preserveAspectRatio="none"
          className="w-full h-10"
          role="img"
          aria-label={`Activity sparkline for ${username || 'developer'}: ${total} events over 30 days, peak ${maxVal}`}
        >
          <g dangerouslySetInnerHTML={{ __html: bars }} />
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
        <span>Day 1</span>
        <span>Day 15</span>
        <span>Day 30</span>
      </div>
    </div>
  );
}
