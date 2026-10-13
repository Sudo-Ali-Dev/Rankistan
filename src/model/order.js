/**
 * The board's order: a total order over rows that does not depend on where it
 * runs.
 *
 * The board used to be sorted on the *rounded* score and then
 * `localeCompare(username)`. Rounding collapses 1,000 developers into a few
 * hundred distinct scores, so most of the board was ordered by the string
 * compare - and `localeCompare` with no locale argument uses the host's ICU
 * collation, so the same file could rank differently on a different machine
 * with no score having changed.
 *
 * Now:
 *   1. `score_exact`, descending - the score before rounding.
 *   2. The username, case-folded, by Unicode code point. GitHub logins are
 *      case-insensitive, so this orders by the account rather than by how its
 *      owner chose to capitalise it. `toLowerCase` uses the locale-independent
 *      Unicode case mapping (`toLocaleLowerCase` is the one that varies).
 *   3. The exact username, by code point. Logins are unique case-insensitively,
 *      so on one board this key can never be reached; it is there so the
 *      comparator returns 0 only for identical strings and the order is total.
 */

/**
 * The value a row is ranked by. Rows published before versioned scoring carry
 * no `score_exact`, only the rounded `score`, and are ranked on that until
 * their batch next runs and re-scores them - at most one day after this
 * change, since every batch runs daily. Once every row carries `score_exact`
 * this branch is unreachable.
 */
function rankingScore(row) {
  const value = typeof row?.score_exact === 'number' ? row.score_exact : row?.score;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `compareRows: row ${JSON.stringify(row?.username)} has no finite score_exact or score`
    );
  }
  return value;
}

function username(row) {
  if (typeof row?.username !== 'string') {
    throw new TypeError(`compareRows: row has no username (${JSON.stringify(row?.username)})`);
  }
  return row.username;
}

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

/** Board order, for `Array.prototype.sort`: best first. */
export function compareRows(a, b) {
  const scoreA = rankingScore(a);
  const scoreB = rankingScore(b);
  if (scoreA !== scoreB) {
    return scoreA > scoreB ? -1 : 1;
  }

  const nameA = username(a);
  const nameB = username(b);
  const folded = compareCodePoints(nameA.toLowerCase(), nameB.toLowerCase());
  if (folded !== 0) {
    return folded;
  }

  return compareCodePoints(nameA, nameB);
}
