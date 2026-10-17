// Rank History: one record per Pakistan date of where every developer stood on the board that
// day, taken from the day's closing board, the last state the pipeline saved on that date.
// docs/rank-history-design.md is the design; this module is its pure part. scripts/history-store.js
// keeps the records on the `board-history` release, and scripts/run-all.js writes each day once,
// on the first run after it ends.
//
// A record, one line of a month's file:
//
//   {"v":1,"d":"2026-10-17","at":"<the close's last_updated>","state":"<its asset name>",
//    "model":"3.1.0","moderation":104,"n":1000,"last_score":212.41,
//    "batches":"111111111111111111111111",
//    "cols":["id","login","rank","tie","score","work","collab","appr","days","age","flags"],
//    "rows":[[1234567,"devone",1,0,773.15,495.2,267.9,10,27,0,0], ...],
//    "out_cols":["id","login","reason","rank","score","days"],
//    "out":[[123,"someone","cut",1004,211.3,9]]}
//
// or, for a date with no closing board, {"v":1,"d":"2026-10-25","gap":"no_state"}.
//
// Ranks are the shared ranks the board publishes, with how many share them, so the daily rotation
// inside a tie never reads as movement. Rows are keyed by account id: a login is a label that can
// change hands. Nothing is recorded from before scoring v3 (the owner, 16 October 2026).

import { decodeMeasurement } from '../src/model/measurement.js';
import { deriveEvidence } from '../src/model/evidence.js';
import { SCORE_CONFIG } from '../src/model/config.js';

export const HISTORY_VERSION = 1;
/** The first date recorded: the first full Pakistan date of scoring v3.1. */
export const HISTORY_START = '2026-10-17';
export const ROW_COLUMNS = Object.freeze([
  'id',
  'login',
  'rank',
  'tie',
  'score',
  'work',
  'collab',
  'appr',
  'days',
  'age',
  'flags'
]);
export const OUT_COLUMNS = Object.freeze(['id', 'login', 'reason', 'rank', 'score', 'days']);
/** The row was carried after a search miss (scripts/run-all.js mergeBatch). */
export const FLAG_CARRIED = 1;
/** Its score changed from the day before with the same measurement: the moderation list changed. */
export const FLAG_MODERATION = 2;

/** The pipeline's reasons for removing a row, as Rank History names them. */
export const DEPARTURE_REASONS = Object.freeze({
  displaced: 'cut',
  ineligible: 'below_gate',
  moderated: 'moderated',
  rescored: 'rescored',
  missed: 'not_found',
  unmeasured: 'unmeasured',
  unscorable: 'unscorable'
});

const DAY_MS = 24 * 60 * 60 * 1000;
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Pakistan date (UTC+5) of an instant. */
export const pktDateOf = (instant) =>
  new Date(Date.parse(instant) + PKT_OFFSET_MS).toISOString().slice(0, 10);
export const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const round = (value, places) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
const idOf = (row) => (Number.isInteger(row?.github_id) ? row.github_id : null);

/** The dates from `from` to `to`, both included, oldest first. */
export function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The `YYYY-MM` a date belongs to. */
export const monthOf = (date) => date.slice(0, 7);

/** Active days of a row, from its measurement, or null when it carries none the model can read. */
function activeDays(row, { moderation, config }) {
  const m = decodeMeasurement(row?.contributions);
  return m ? deriveEvidence(m, { config, moderation }).working_days.length : null;
}

/**
 * The record of `date` from its closing board. `previous` is the record of the date before, or
 * null when that date is not in the history; it supplies the figures of anyone who left (as they
 * last stood), and the measured date that tells a moderation change from a new measurement.
 * `moderation` is the list the board was scored with, and `optedOut` the account ids that must
 * appear nowhere. Pure.
 */
export function dayRecord({
  date,
  close,
  state,
  previous = null,
  moderation = [],
  optedOut = new Set(),
  config = SCORE_CONFIG
}) {
  if (!DATE_RE.test(date)) throw new TypeError(`not a date: ${JSON.stringify(date)}`);
  const rows = (close?.leaderboard ?? []).filter(
    (row) => idOf(row) !== null && !optedOut.has(idOf(row))
  );
  const sharing = new Map();
  for (const row of rows) sharing.set(row.rank, (sharing.get(row.rank) ?? 0) + 1);
  const before = previousRows(previous);
  const points = (part, row) =>
    round(config.SCALE * config.WEIGHTS[part] * row.score_parts[part], 1);

  const recorded = rows.map((row) => {
    const id = idOf(row);
    const measured = typeof row.scored_at === 'string' ? pktDateOf(row.scored_at) : date;
    const score = round(row.score_exact, 2);
    let flags = 0;
    if (Number(row.missed_runs) > 0) flags |= FLAG_CARRIED;
    const was = before.get(id);
    if (was && addDays(previous.d, -was.age) === measured && was.score !== score) {
      flags |= FLAG_MODERATION;
    }
    return [
      id,
      row.username,
      row.rank,
      sharing.get(row.rank) > 1 ? sharing.get(row.rank) : 0,
      score,
      points('work', row),
      points('collaboration', row),
      points('appreciation', row),
      activeDays(row, { moderation, config }),
      Math.max(0, daysBetween(measured, date)),
      flags
    ];
  });

  const here = new Set(rows.map(idOf));
  const reasons = departureReasons(close?.departures);
  const out = [];
  for (const [id, was] of before) {
    if (here.has(id) || optedOut.has(id)) continue;
    out.push([id, was.login, reasons.get(id) ?? 'unknown', was.rank, was.score, was.days]);
  }
  out.sort((a, b) => a[3] - b[3] || a[0] - b[0]);

  const runs = close?.batch_runs ?? {};
  const batches = Array.from({ length: 24 }, (_, i) =>
    typeof runs[i]?.at === 'string' && pktDateOf(runs[i].at) === date ? '1' : '0'
  ).join('');
  const scores = recorded.map((r) => r[4]);
  return {
    v: HISTORY_VERSION,
    d: date,
    at: close?.last_updated ?? null,
    state,
    model: rows[0]?.model_version ?? null,
    moderation: moderation.length,
    n: recorded.length,
    last_score: scores.length ? Math.min(...scores) : null,
    batches,
    cols: ROW_COLUMNS,
    rows: recorded,
    out_cols: OUT_COLUMNS,
    out
  };
}

/** A date no closing board was kept for. */
export const gapRecord = (date) => ({ v: HISTORY_VERSION, d: date, gap: 'no_state' });

/** A record's rows by account id, as objects, or an empty map for a gap or nothing. */
export function previousRows(record) {
  const out = new Map();
  if (!record || record.gap || !Array.isArray(record.rows)) return out;
  const col = Object.fromEntries(record.cols.map((name, i) => [name, i]));
  for (const r of record.rows) {
    out.set(r[col.id], {
      login: r[col.login],
      rank: r[col.rank],
      score: r[col.score],
      days: r[col.days],
      age: r[col.age]
    });
  }
  return out;
}

/**
 * The last reason each account in a close's departure log was removed for, in Rank History's
 * names. The log holds the close's date and the one before (DEPARTURE_DAYS), and only those on the
 * day before's board are looked up, so an entry from the date before still names this day's
 * departure: a run that merged just before midnight and saved just after logged it there.
 */
function departureReasons(log) {
  const out = new Map();
  const entries = (Array.isArray(log) ? log : []).filter((entry) => typeof entry?.at === 'string');
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const entry of entries) out.set(entry.id, DEPARTURE_REASONS[entry.reason] ?? 'unknown');
  return out;
}

/** A record without any trace of the accounts in `optedOut`, and whether it changed. Pure. */
export function scrubRecord(record, optedOut) {
  if (record.gap) return { record, changed: false };
  const keep = (r) => !optedOut.has(r[0]);
  const rows = record.rows.filter(keep);
  const out = record.out.filter(keep);
  if (rows.length === record.rows.length && out.length === record.out.length) {
    return { record, changed: false };
  }
  // The rest of the record stands as published: the ranks of everyone else are not recomputed.
  return { record: { ...record, n: rows.length, rows, out }, changed: true };
}

/** A month's records from its file, oldest first, or an exception saying why it is not one. */
export function parseMonth(text, month) {
  const records = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${month}: line ${i + 1} is not JSON`);
    }
    if (record?.v !== HISTORY_VERSION || !DATE_RE.test(record.d) || monthOf(record.d) !== month) {
      throw new Error(`${month}: line ${i + 1} is not a ${month} record`);
    }
    if (records.length && record.d <= records.at(-1).d) {
      throw new Error(`${month}: ${record.d} is out of order`);
    }
    records.push(record);
  }
  return records;
}

/** A month's file from its records. */
export function serializeMonth(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

/**
 * Adds records to a month's, refusing any that would rewrite a date already written: a published
 * day changes only by an opt-out (scrubRecord). Pure.
 */
export function appendRecords(existing, added) {
  const last = existing.at(-1)?.d ?? '';
  const out = [...existing];
  for (const record of added) {
    if (record.d <= (out.at(-1)?.d ?? last)) {
      throw new Error(`refusing to rewrite ${record.d}: the history already holds it`);
    }
    out.push(record);
  }
  return out;
}
