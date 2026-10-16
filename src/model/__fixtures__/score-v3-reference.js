/**
 * An independent, deliberately naive implementation of scoring v3, written from the formula in
 * docs and the config rather than from src/model/next/score.js, for the differential test. It
 * reads the decoded measurement directly (no evidence step), so a rule implemented twice
 * differently shows up as a mismatch.
 *
 * Kept simple on purpose: plain loops, and nothing shared with the model under test.
 */
const DAY = 86400000;

function dateOf(from, offset) {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
}

function ageDays(created, date) {
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / DAY);
}

export function referenceScore(m, config, moderation = []) {
  const W = config.WINDOW_DAYS;
  const weight = (offset) => config.RECENCY_FLOOR + ((1 - config.RECENCY_FLOOR) * offset) / (W - 1);
  const me = m.login.toLowerCase();
  const C = config.COLLABORATION;
  const I = config.INTEGRITY;

  // Excluded repositories.
  const excluded = new Set();
  for (const repo of m.future_repos) excluded.add(repo.toLowerCase());
  for (const s of m.integrity) {
    if (s.sampled === 0) continue;
    const lead = s.max_lead_hours !== null && s.max_lead_hours > I.MAX_LEAD_HOURS;
    const ahead = s.max_ahead_hours !== null && s.max_ahead_hours > I.MAX_AHEAD_HOURS;
    const bot = s.bot / s.sampled >= I.BOT_SHARE;
    if (lead || ahead || bot) excluded.add(s.repo.toLowerCase());
  }
  for (const entry of moderation) excluded.add(entry.repo.toLowerCase());

  const isOthers = (flags) => (flags & 1) === 0 && (flags & 2) === 0 && (flags & 4) === 0;
  const other = (p) => p && p.kind === 'U' && p.login.toLowerCase() !== me;
  const old = (p, offset) =>
    p.created && ageDays(p.created, dateOf(m.window.from, offset)) >= C.COUNTERPARTY_MIN_AGE_DAYS;

  // Work.
  const active = new Array(W).fill(false);
  for (const r of m.commits) {
    if (r.flags & 2 || r.flags & 4 || excluded.has(r.repo.toLowerCase())) continue;
    for (const d of r.days) active[d.day] = true;
  }
  let merged = 0;
  let closed = 0;
  for (const r of m.pull_requests) {
    if (!isOthers(r.flags)) continue;
    for (const i of r.items) {
      if (i.outcome === 1) merged += 1;
      if (i.outcome === 2) closed += 1;
      else active[i.day] = true;
    }
  }
  for (const r of m.issues) if (isOthers(r.flags)) for (const i of r.items) active[i.day] = true;
  const latestReview = {};
  for (const r of m.reviews) {
    if (r.flags & 2) continue;
    for (const i of r.items) {
      if (!other(i.author)) continue;
      active[i.day] = true;
      const key = `${r.repo.toLowerCase()}#${i.number}`;
      if (!latestReview[key] || i.day > latestReview[key].i.day) latestReview[key] = { r, i };
    }
  }
  let num = 0;
  let den = 0;
  for (let k = 0; k < W; k += 1) {
    den += weight(k);
    if (active[k]) num += weight(k);
  }
  const work = 1 - (1 - num / den) ** config.WORK.CURVE_POWER;

  // Collaboration.
  const star = (s) => Math.min(1, C.STARS_FLOOR + C.STARS_PER_DIGIT * Math.log10(1 + s));
  const size = (i) =>
    i.files <= C.TINY_MAX_FILES && i.lines <= C.TINY_MAX_LINES ? C.TINY_WEIGHT : 1;
  const credit = (groups) =>
    Object.keys(groups)
      .sort()
      .reduce((sum, k) => sum + Math.min(C.CAP_PER_GROUP, Math.log2(1 + groups[k])), 0);
  const twoWay = (items, keyA, keyB, value) => {
    const a = {};
    const b = {};
    for (const it of items) {
      a[keyA(it)] = (a[keyA(it)] || 0) + value(it);
      b[keyB(it)] = (b[keyB(it)] || 0) + value(it);
    }
    return Math.min(credit(a), credit(b));
  };

  const acc = [];
  for (const r of m.accepted) {
    if (!isOthers(r.flags)) continue;
    for (const i of r.items) if (other(i.merger) && old(i.merger, i.day)) acc.push({ r, i });
  }
  const accepted = twoWay(
    acc,
    ({ r }) => (r.owner?.login ?? r.repo.split('/')[0]).toLowerCase(),
    ({ i }) => i.merger.login.toLowerCase(),
    ({ r, i }) => star(r.stars) * size(i) * weight(i.day)
  );
  const p = C.REJECTION_PRIOR;
  const f = Math.min(1, (p * (merged + p)) / (merged + closed + 2 * p));
  const rv = Object.values(latestReview).filter(({ i }) => old(i.author, i.day));
  const reviews = twoWay(
    rv,
    ({ r }) => r.repo.split('/')[0].toLowerCase(),
    ({ i }) => i.author.login.toLowerCase(),
    ({ r, i }) => C.REVIEW_WEIGHT * star(r.stars) * weight(i.day)
  );
  const byAuthor = {};
  for (const r of m.maintained) {
    if (!(r.flags & 1) || r.flags & 2) continue;
    for (const i of r.items) {
      if (!other(i.author) || !old(i.author, i.day)) continue;
      const k = i.author.login.toLowerCase();
      byAuthor[k] =
        (byAuthor[k] || 0) + C.MAINTAINED_WEIGHT * star(r.stars) * size(i) * weight(i.day);
    }
  }
  const maintained = credit(byAuthor);
  const c = f * accepted + reviews + maintained;
  const collaboration = c / (c + C.HALF_POINT);

  // Appreciation.
  const A = config.APPRECIATION;
  let appreciation = 0;
  for (const r of m.commits) {
    if (!(r.flags & 1) || r.flags & 2 || r.flags & 4 || excluded.has(r.repo.toLowerCase()))
      continue;
    if (r.stars < A.FROM_STARS) continue;
    const v =
      Math.min(1, Math.max(0, (Math.log10(r.stars) - Math.log10(A.FROM_STARS)) / A.DECADES)) *
      Math.min(1, r.days.length / A.FULL_AFTER_DAYS);
    appreciation = Math.max(appreciation, v);
  }

  const exact =
    config.SCALE *
    (config.WEIGHTS.work * work +
      config.WEIGHTS.collaboration * collaboration +
      config.WEIGHTS.appreciation * appreciation);
  return { work, collaboration, appreciation, exact, days: active.filter(Boolean).length };
}
