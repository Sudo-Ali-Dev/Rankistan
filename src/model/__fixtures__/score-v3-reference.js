/**
 * An independent, deliberately naive implementation of scoring v3.1, written from the formula in
 * docs and the config rather than from src/model/score.js, for the differential test. It
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
  // 1 for the newest day, RECENCY_FLOOR for the oldest, the same ratio from each day to the next.
  const weight = (offset) =>
    Math.round(Math.pow(config.RECENCY_FLOOR, (W - 1 - offset) / (W - 1)) * 1e12) / 1e12;
  const me = m.login.toLowerCase();
  const C = config.COLLABORATION;
  const I = config.INTEGRITY;

  // Excluded repositories.
  const excluded = new Set();
  for (const repo of m.future_repos) excluded.add(repo.toLowerCase());
  const credited = {};
  for (const r of m.commits) credited[r.repo.toLowerCase()] = r.days.length;
  for (const s of m.integrity) {
    const lead = s.max_lead_hours !== null && s.max_lead_hours > I.MAX_LEAD_HOURS;
    const ahead = s.max_ahead_hours !== null && s.max_ahead_hours > I.MAX_AHEAD_HOURS;
    const bot = s.sampled >= I.MIN_BOT_SAMPLE && s.bot / s.sampled >= I.BOT_SHARE;
    const days = credited[s.repo.toLowerCase()] || 0;
    const missing = s.days === 0 && days >= I.MISSING_MIN_DAYS;
    if (lead || ahead || bot || missing) excluded.add(s.repo.toLowerCase());
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
  const selfMerges = new Set();
  for (const r of m.accepted) {
    for (const i of r.items) {
      if (i.merger && i.merger.login.toLowerCase() === me) selfMerges.add(r.repo.toLowerCase());
    }
  }
  let merged = 0;
  let closed = 0;
  for (const r of m.pull_requests) {
    if (!isOthers(r.flags)) continue;
    const counts = !selfMerges.has(r.repo.toLowerCase());
    for (const i of r.items) {
      if (i.outcome === 1 && counts) merged += 1;
      if (i.outcome === 2 && counts) closed += 1;
      if (i.outcome !== 2) active[i.day] = true;
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
      const prev = latestReview[key];
      const later =
        !prev ||
        i.day > prev.i.day ||
        (i.day === prev.i.day &&
          i.author.login.toLowerCase() < prev.i.author.login.toLowerCase()) ||
        (i.day === prev.i.day &&
          i.author.login.toLowerCase() === prev.i.author.login.toLowerCase() &&
          prev.i.outsider &&
          !i.outsider);
      if (later) latestReview[key] = { r, i };
    }
  }
  let num = 0;
  let den = 0;
  for (let k = 0; k < W; k += 1) {
    den += weight(k);
    if (active[k]) num += weight(k);
  }
  const work = 1 - (1 - num / den) ** config.WORK.CURVE_POWER;

  // Collaboration: every counted item, its value, the person who vouched and the place.
  const star = (s) => Math.min(1, C.STARS_FLOOR + C.STARS_PER_DIGIT * Math.log10(1 + s));
  const size = (i) =>
    i.files <= C.TINY_MAX_FILES && i.lines <= C.TINY_MAX_LINES ? C.TINY_WEIGHT : 1;
  const items = [];
  for (const r of m.accepted) {
    if (!isOthers(r.flags)) continue;
    const owner = (r.owner?.login ?? r.repo.split('/')[0]).toLowerCase();
    for (const i of r.items) {
      let who = null;
      if (other(i.merger) && old(i.merger, i.day)) who = i.merger;
      else if (
        i.merger &&
        i.merger.login.toLowerCase() === me &&
        other(i.approver) &&
        old(i.approver, i.day)
      )
        who = i.approver;
      if (!who) continue;
      items.push({
        v: star(r.stars) * size(i) * weight(i.day),
        stars: r.stars,
        person: who.login.toLowerCase(),
        place: 'o:' + owner
      });
    }
  }
  const maintainedPrs = new Set();
  for (const r of m.maintained) {
    if (!(r.flags & 1) || r.flags & 2) continue;
    for (const i of r.items) {
      if (!other(i.author) || !old(i.author, i.day)) continue;
      maintainedPrs.add(`${r.repo.toLowerCase()}#${i.number}`);
      items.push({
        v: C.MAINTAINED_WEIGHT * star(r.stars) * size(i) * weight(i.day),
        stars: r.stars,
        person: i.author.login.toLowerCase(),
        place: 'a:' + i.author.login.toLowerCase()
      });
    }
  }
  for (const { r, i } of Object.values(latestReview)) {
    if (!old(i.author, i.day)) continue;
    if (maintainedPrs.has(`${r.repo.toLowerCase()}#${i.number}`)) continue;
    const stars = i.outsider ? 0 : r.stars;
    items.push({
      v: C.REVIEW_WEIGHT * star(stars) * weight(i.day),
      stars,
      person: i.author.login.toLowerCase(),
      place: 'o:' + r.repo.split('/')[0].toLowerCase()
    });
  }
  const breadth = (key) => {
    const total = {};
    const best = {};
    for (const it of items) {
      total[key(it)] = (total[key(it)] || 0) + it.v;
      best[key(it)] = Math.max(best[key(it)] || 0, it.stars);
    }
    const credits = Object.keys(total).map((k) =>
      Math.min(C.CAP_PER_GROUP * Math.max(C.CAP_STAR_FLOOR, star(best[k])), Math.log2(1 + total[k]))
    );
    credits.sort((a, b) => b - a);
    let sum = 0;
    for (let k = 0; k < credits.length; k += 1)
      sum += credits[k] / Math.pow(k + 1, C.BREADTH_POWER);
    return sum;
  };
  const c = Math.min(
    breadth((it) => it.person),
    breadth((it) => it.place)
  );
  const p = C.REJECTION_PRIOR;
  const f = Math.min(1, (p * (merged + p)) / (merged + closed + 2 * p));
  const collaboration = (f * c) / (c + C.HALF_POINT);

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
