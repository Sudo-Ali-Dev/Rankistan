/**
 * The board's order and ranks: a total order over rows that does not depend on where it runs.
 *
 * Rows are ordered by the unrounded score. Rows whose scores are exactly equal share a rank
 * (competition ranking: 1, 2, 2, 4), because the measurement found nothing to tell them apart
 * and the board should not pretend it did. Within such a tie the display order rotates daily by
 * a hash of the account id and the board's Pakistan date, so no one is always shown first because
 * of their name. (Until 2026-10-13 the board sorted on the rounded score and then the username,
 * so the alphabet settled most positions.)
 *
 * At the board's size limit a tie is never split: everyone sharing the last rank is on the board.
 *
 * Nothing here consults the locale. v2's board once sorted with `localeCompare`, which uses the
 * host's ICU collation, so the same file could rank differently on another machine.
 */
import { pktDate } from './measurement.js';

/**
 * Compare two strings by Unicode code point. `<` on JS strings compares UTF-16
 * code units, which disagrees with code point order for characters outside
 * the Basic Multilingual Plane; this does not.
 */
export function compareCodePoints(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(j);
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

/** The seed a board's tie order rotates on: its Pakistan date. */
export function boardSeed(lastUpdated) {
  return pktDate(lastUpdated);
}

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
