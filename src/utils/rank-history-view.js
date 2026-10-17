// Rank History, as the site shows it: each developer's file (history/<login>.json, built at deploy
// by scripts/build-split-data.js) and the quiet marker under each rank in the list. Pure, and shared
// by the build and the browser. The records are the daily ones scripts/rank-history.js writes; the
// design, with every rule below and why, is docs/rank-history-design.md.
//
// - Nothing is compared across a scoring change. The current scoring is the model's major.minor,
//   and only days recorded under it count.
// - The arrow compares with the board saved closest to 24 hours earlier, "this time yesterday",
//   and splits the move into what the developer's own score explains and what other developers
//   explain. The two add up exactly.
// - The best rank is the best daily close, never an intraday peak. Today's point is live: it is the
//   board as it stands now, and becomes a daily close when the date ends.

export const HISTORY_FILE_SCHEMA = 1;

/**
 * Boards saved before this instant are not compared with. From scoring v3.0's launch until the fix
 * on 17 October 2026 (#154), the pipeline stored no merges for the developers it measured, and
 * batches 2 to 4 were whole again only once measured again that night, the last at about 00:30
 * UTC. An arrow against one of those boards would show the restore as hundreds of places of
 * movement.
 */
export const COMPARABLE_FROM = '2026-10-17T01:00:00Z';

const DAY_MS = 24 * 60 * 60 * 1000;
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
export const pktDateOf = (instant) =>
  new Date(Date.parse(instant) + PKT_OFFSET_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const round2 = (value) => Math.round(value * 100) / 100;

/** A model version's scoring, its major and minor: a patch changes no published score. */
export const scoringOf = (version) =>
  typeof version === 'string' ? version.split('.').slice(0, 2).join('.') : null;

const idOf = (row) => (Number.isInteger(row?.github_id) ? row.github_id : null);
const column = (record, name) => record.cols.indexOf(name);

/**
 * The records of the current scoring, oldest first, and the date it began: the day after the last
 * record of another scoring, or the first record. Gap records stay in, as gaps.
 */
export function currentSegment(records, scoring) {
  let since = null;
  const kept = [];
  for (const record of records) {
    if (!record.gap && scoringOf(record.model) !== scoring) {
      kept.length = 0;
      since = null;
      continue;
    }
    if (!record.gap && since === null) since = record.d;
    if (since !== null) kept.push(record);
  }
  return { records: kept, since };
}

/** Each account's daily points in a segment's records, oldest first. */
export function pointsById(records) {
  const out = new Map();
  for (const record of records) {
    if (record.gap) continue;
    const at = {
      id: column(record, 'id'),
      rank: column(record, 'rank'),
      tie: column(record, 'tie'),
      score: column(record, 'score'),
      days: column(record, 'days'),
      flags: column(record, 'flags')
    };
    for (const row of record.rows) {
      const id = row[at.id];
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({
        d: record.d,
        rank: row[at.rank],
        tie: row[at.tie],
        score: row[at.score],
        days: row[at.days],
        flags: row[at.flags]
      });
    }
  }
  return out;
}

/** Who left the board on which date, and why, in a segment's records. */
function departuresById(records) {
  const out = new Map();
  for (const record of records) {
    if (record.gap) continue;
    for (const row of record.out ?? []) {
      const [id, , reason] = row;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push([record.d, reason]);
    }
  }
  return out;
}

/**
 * The board saved closest to 24 hours before `board`, as `{last_updated, scoring, ranks}`, ranks
 * a Map of account id to `{rank, score}`, or null when it cannot be compared with: another
 * scoring, saved before COMPARABLE_FROM, or none at all.
 */
export function comparableThen(then, board) {
  if (!then || !Array.isArray(then.rows)) return null;
  if (Date.parse(then.last_updated) < Date.parse(COMPARABLE_FROM)) return null;
  const scoring = scoringOf(board?.leaderboard?.[0]?.model_version);
  if (scoringOf(then.model) !== scoring) return null;
  return {
    last_updated: then.last_updated,
    ranks: new Map(then.rows.map(([id, rank, score]) => [id, { rank, score }]))
  };
}

/**
 * How a developer's rank moved since `then`: the places their own score explains, where their
 * score then would rank among everyone else's now, and the places other developers explain. Pure.
 */
export function splitMove({ rankThen, scoreThen, rankNow, scoreNow, othersNow }) {
  const placed = 1 + othersNow.filter((score) => score > scoreThen).length;
  return {
    rank_then: rankThen,
    rank_now: rankNow,
    score_then: round2(scoreThen),
    score_now: round2(scoreNow),
    places: rankThen - rankNow,
    own: placed - rankNow,
    others: rankThen - placed
  };
}

/**
 * The marker under each rank in the list, by account id: a number of places moved since this time
 * yesterday (0 for the same rank), 'new', 'back', or nothing when there is no board to compare
 * with under the same scoring. Pure.
 */
export function boardMoves({ board, then, records = [] }) {
  const out = new Map();
  const before = comparableThen(then, board);
  if (!before) return out;
  const scoring = scoringOf(board.leaderboard[0]?.model_version);
  const today = pktDateOf(board.last_updated);
  const seen = new Set();
  for (const [id, points] of pointsById(currentSegment(records, scoring).records)) {
    if (points.some((p) => p.d < today)) seen.add(id);
  }
  for (const row of board.leaderboard) {
    const id = idOf(row);
    if (id === null) continue;
    const was = before.ranks.get(id);
    if (was) out.set(id, was.rank - row.rank);
    else out.set(id, seen.has(id) ? 'back' : 'new');
  }
  return out;
}

/**
 * One developer's history file, or null when they are not on `board`. `records` are the daily
 * records oldest first, `then` the board saved closest to 24 hours earlier (scripts/history-pull.js).
 * Pure.
 */
export function developerHistory({ records = [], board, then = null, row }) {
  const id = idOf(row);
  if (id === null || !board.leaderboard.includes(row)) return null;
  const scoring = scoringOf(row.model_version);
  const today = pktDateOf(board.last_updated);
  const segment = currentSegment(records, scoring);
  const closes = (pointsById(segment.records).get(id) ?? []).filter((p) => p.d < today);
  const live = { d: today, rank: row.rank, tie: tieOf(board, row), score: round2(row.score_exact) };
  const points = [
    ...closes.map(({ d, rank, tie, score, days }) => ({ d, rank, tie, score, days })),
    live
  ];
  const gaps = segment.records.filter((r) => r.gap && r.d < today).map((r) => r.d);

  const best = closes.reduce((a, p) => (a === null || p.rank < a.rank ? p : a), null);
  const first = points[0].d;
  const span = daysBetween(first, today) + 1 - gaps.filter((d) => d >= first).length;

  let movement = null;
  const before = comparableThen(then, board);
  if (before) {
    const was = before.ranks.get(id);
    if (was) {
      movement = {
        kind: 'move',
        since: before.last_updated,
        ...splitMove({
          rankThen: was.rank,
          scoreThen: was.score,
          rankNow: row.rank,
          scoreNow: row.score_exact,
          othersNow: board.leaderboard.filter((r) => r !== row).map((r) => r.score_exact)
        })
      };
    } else if (closes.length === 0) {
      movement = { kind: 'new' };
    } else {
      const last = closes.at(-1);
      movement = {
        kind: 'back',
        last: { d: last.d, rank: last.rank },
        away_days: Math.max(0, daysBetween(last.d, today) - 1)
      };
    }
  } else if (then && scoringOf(then.model) !== scoring) {
    movement = { kind: 'scoring' };
  }

  return {
    schema: HISTORY_FILE_SCHEMA,
    login: row.username,
    id,
    generated: board.last_updated,
    today,
    scoring: { version: scoring, since: segment.since ?? today },
    points: points.map(({ d, rank, tie, score, days }) => [d, rank, tie, score, days ?? null]),
    left: departuresById(segment.records).get(id) ?? [],
    moderation: closes.filter((p) => p.flags & 2).map((p) => p.d),
    gaps,
    best: best ? { rank: best.rank, d: best.d } : null,
    first,
    days_on: points.length,
    days_span: span,
    movement
  };
}

function tieOf(board, row) {
  const sharing = board.leaderboard.filter((r) => r.rank === row.rank).length;
  return sharing > 1 ? sharing : 0;
}

/** Whether `value` is a history file for `login`. */
export function isHistoryFileFor(value, login) {
  return (
    value?.schema === HISTORY_FILE_SCHEMA &&
    typeof value.login === 'string' &&
    value.login.toLowerCase() === String(login).toLowerCase() &&
    Array.isArray(value.points) &&
    value.points.length > 0
  );
}
