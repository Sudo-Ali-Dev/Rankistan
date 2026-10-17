// The geometry of a Rank History card's two lines (src/components/RankHistoryPanel.jsx). Pure.

const DAY_MS = 24 * 60 * 60 * 1000;
const dayIndex = (from, date) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The two lines' geometry, in a 240 by 40 viewBox: x by date from the first day to today, the rank
 * line with the best rank at the top, the score line with the highest score at the top. A line
 * breaks across days off the board, but not across a day with no board at all.
 */
export function historyLines(file, width = 240, height = 40) {
  const points = file.points.map(([d, rank, , score]) => ({ d, rank, score }));
  const gaps = new Set(file.gaps);
  const span = Math.max(1, dayIndex(points[0].d, file.today));
  // Inset, so a point on the first day or today is not cut in half by the edge.
  const inset = 4;
  const x = (d) => inset + (dayIndex(points[0].d, d) / span) * (width - 2 * inset);
  const scale = (values, invert) => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = 4;
    return (v) => {
      if (hi === lo) return height / 2;
      const t = (v - lo) / (hi - lo);
      return pad + (invert ? t : 1 - t) * (height - 2 * pad);
    };
  };
  const yRank = scale(
    points.map((p) => p.rank),
    true
  );
  const yScore = scale(
    points.map((p) => p.score),
    false
  );
  const away = (a, b) => {
    for (let i = dayIndex(a.d, b.d) - 1; i > 0; i -= 1) {
      const between = new Date(Date.parse(`${a.d}T00:00:00Z`) + i * DAY_MS)
        .toISOString()
        .slice(0, 10);
      if (!gaps.has(between)) return true;
    }
    return false;
  };
  // A point with no neighbour on its own spell, such as today after a return, is drawn apart as a
  // dot: a zero-length segment with round caps, which stays round however the plot is stretched.
  const starts = points.map((p, i) => i === 0 || away(points[i - 1], p));
  const alone = points.map((_, i) => starts[i] && (i === points.length - 1 || starts[i + 1]));
  const at = (p, y) => `${x(p.d).toFixed(1)},${y(p).toFixed(1)}`;
  const path = (y) =>
    points
      .map((p, i) => (alone[i] ? '' : `${starts[i] ? 'M' : 'L'}${at(p, y)}`))
      .filter(Boolean)
      .join(' ');
  const dotsOf = (y) =>
    points
      .filter((_, i) => alone[i])
      .map((p) => `M${at(p, y)} l0.01,0`)
      .join(' ');
  return {
    rank: path((p) => yRank(p.rank)),
    score: path((p) => yScore(p.score)),
    rankDots: dotsOf((p) => yRank(p.rank)),
    scoreDots: dotsOf((p) => yScore(p.score)),
    dots: points.map((p) => ({ x: x(p.d), rank: yRank(p.rank), score: yScore(p.score) })),
    points
  };
}
