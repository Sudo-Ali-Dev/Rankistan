const DAYS = 30;

function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x80000000;
  };
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function generateDailyDistribution(totalEvents, seed = '') {
  const count = Math.max(0, Math.floor(Number(totalEvents) || 0));
  if (count === 0) return new Array(DAYS).fill(0);

  const rng = seededRandom(hashStr(String(count) + ':' + seed));

  const days = new Array(DAYS).fill(0);
  let remaining = count;

  const weekPattern = [0.15, 0.18, 0.18, 0.17, 0.16, 0.10, 0.06];

  for (let i = 0; i < DAYS; i++) {
    const dayOfWeek = (DAYS - 1 - i) % 7;
    const noise = 0.4 + rng() * 0.6;
    let portion = weekPattern[dayOfWeek] * noise;
    if (i === DAYS - 1) {
      portion = 1;
    }
    const ideal = Math.round((portion / (DAYS - i)) * remaining);
    const minVal = i < DAYS - 1 ? 0 : remaining;
    const maxVal = Math.max(1, Math.round(remaining / (DAYS - i) * 2.5));
    days[i] = Math.max(minVal, Math.min(maxVal, ideal));
    remaining -= days[i];
  }

  if (remaining > 0) {
    for (let i = 0; i < DAYS && remaining > 0; i++) {
      days[i] += 1;
      remaining--;
    }
  }

  return days;
}

export function sparklinePath(dailyData, width = 240, height = 48) {
  const data = Array.isArray(dailyData) ? dailyData : [];
  if (data.length === 0) return '';

  const maxVal = Math.max(...data, 1);
  const stepX = width / (data.length - 1 || 1);

  const points = data.map((v, i) => ({
    x: i * stepX,
    y: height - (v / maxVal) * (height - 4) - 2
  }));

  const path = points.map((p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    if (i === data.length - 1) return `L${p.x.toFixed(1)},${p.y.toFixed(1)}`;

    const prev = points[i - 1];
    const next = points[i + 1];
    const cp1x = (prev.x + p.x) / 2;
    const cp1y = prev.y;
    const cp2x = (p.x + next.x) / 2;
    const cp2y = p.y;

    return `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(' ');

  const barWidth = Math.max(2, Math.floor(width / data.length) - 1);
  const bars = data.map((v, i) => {
    const barH = Math.max(1, (v / maxVal) * (height - 4));
    return `<rect x="${i * stepX - barWidth / 2 + stepX / 2}" y="${height - 2 - barH}" width="${barWidth}" height="${barH}" rx="1" fill="currentColor" opacity="0.25" />`;
  }).join('');

  return { path, bars, maxVal, total: data.reduce((s, v) => s + v, 0) };
}
