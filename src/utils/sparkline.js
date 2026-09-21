/**
 * Sparkline geometry, as it was in #50.
 *
 * The file used to also export `generateDailyDistribution`, which invented a
 * 30-day series from the single `events_30d` total with a seeded random walk.
 * That is what 5eae21d removed, and it is not coming back: everything on screen
 * comes from the pipeline or a real API.
 *
 * The drawing was never the problem, so the maths below is the original's,
 * unchanged - same curve, same bar placement, same rounding. What changed is
 * that it can no longer manufacture the series it draws; it only draws one it
 * is handed.
 */

/** Days rendered in the card. */
export const SPARKLINE_DAYS = 30;

/**
 * Path and bar geometry for a series of daily values.
 *
 * Each bar is centred on its own point in the line, so the peak of the curve
 * sits over the tall bar rather than between two of them. #50 offset the bars
 * half a step right of the line (`i * stepX - barWidth / 2 + stepX / 2` against
 * a line at `i * stepX`), which reads as a half-day lag between the two marks.
 *
 * Both control points of each curve segment sit on the same vertical as the
 * segment's own ends, so the line cannot bulge above the taller day or dip
 * below the shorter one and imply a value the series does not contain.
 */
export function sparklinePath(values, width = 240, height = 40) {
  const data = (Array.isArray(values) ? values : [])
    .map((value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0))
    .slice(-SPARKLINE_DAYS);

  if (data.length === 0) {
    return { path: '', bars: [], maxVal: 0, total: 0, activeDays: 0, days: 0 };
  }

  const maxVal = Math.max(...data, 1);
  const stepX = width / (data.length - 1 || 1);

  const points = data.map((value, index) => ({
    x: index * stepX,
    y: height - (value / maxVal) * (height - 4) - 2
  }));

  const at = (n) => n.toFixed(1);
  const path = points
    .map((point, index) => {
      if (index === 0) return `M${at(point.x)},${at(point.y)}`;

      const prev = points[index - 1];
      const midX = (prev.x + point.x) / 2;
      return `C${at(midX)},${at(prev.y)} ${at(midX)},${at(point.y)} ${at(point.x)},${at(point.y)}`;
    })
    .join(' ');

  const barWidth = Math.max(2, width / data.length - 1);
  const bars = points.map((point, index) => {
    const barHeight = Math.max(1, (data[index] / maxVal) * (height - 4));
    return {
      key: index,
      x: point.x - barWidth / 2,
      y: height - 2 - barHeight,
      width: barWidth,
      height: barHeight
    };
  });

  return {
    path,
    bars,
    maxVal,
    // The sum of 0-4 intensity bands, kept because the original returned it.
    // It is not a count of anything, and nothing user-facing prints it.
    total: data.reduce((sum, value) => sum + value, 0),
    activeDays: data.filter((value) => value > 0).length,
    days: data.length
  };
}
