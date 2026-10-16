/**
 * Scoring v3's board order and ranks.
 *
 * Rows are ordered by the unrounded score. Rows whose scores are exactly equal share a rank
 * (competition ranking: 1, 2, 2, 4), because the measurement found nothing to tell them apart
 * and the board should not pretend it did. Within such a tie the display order rotates daily by
 * a hash of the account id and the date, so no one is always shown first because of their name,
 * which is what ordering by username did: v2's board was mostly ordered by the alphabet.
 *
 * At the board's size limit a tie is never split: everyone sharing the last rank is on the board.
 */
import { compareCodePoints } from '../order.js';

/** FNV-1a over a string: a fixed, platform-independent hash. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function scoreOf(row) {
  const value = row?.score_exact;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`board order: ${JSON.stringify(row?.username)} has no finite score_exact`);
  }
  return value;
}

/**
 * The comparator for a board built on `seed` (the run's Pakistan date). Best first; total, so
 * the order never depends on where it runs or on the input order.
 */
export function boardOrder(seed) {
  if (typeof seed !== 'string' || seed === '') throw new TypeError('boardOrder needs a seed');
  return (a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sa !== sb) return sa > sb ? -1 : 1;
    const ha = fnv1a(`${seed}:${a.github_id}`);
    const hb = fnv1a(`${seed}:${b.github_id}`);
    if (ha !== hb) return ha < hb ? -1 : 1;
    if (a.github_id !== b.github_id) return a.github_id < b.github_id ? -1 : 1;
    return compareCodePoints(String(a.username), String(b.username));
  };
}

/** Rows (already in board order) with competition ranks: equal scores share a rank. */
export function assignRanks(sorted) {
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || scoreOf(row) !== scoreOf(sorted[i - 1])) rank = i + 1;
    return { ...row, rank };
  });
}

/** The first `limit` rows, extended to the end of a tie that straddles the limit. */
export function cutAtLimit(ranked, limit) {
  if (ranked.length <= limit) return ranked;
  let end = limit;
  while (end < ranked.length && ranked[end].rank === ranked[limit - 1].rank) end += 1;
  return ranked.slice(0, end);
}
