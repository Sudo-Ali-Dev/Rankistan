/**
 * The next model's pre-screen, run beside today's and logged only: nothing here admits or
 * rejects anyone.
 *
 * Scoring v3 gates on public working days measured from the contributions API, so the events
 * screen today's gate uses cannot decide who to measure: it reads REST, and it misses a developer
 * whose only work is reviews. The planned screen reads each candidate's contribution calendar
 * instead, 50 to a request. The calendar counts every public contribution (and private work, for
 * those who share it) on the developer's own dates, so its active days are an upper bound on
 * public working days. A Pakistan date and the developer's date differ by at most one, so four
 * working days in the window cannot show as fewer than two calendar days in the 32 dates around
 * it: SCREEN_MIN_DAYS = 2 rejects nobody the gate would admit.
 *
 * What this logs, per batch, is what PR4's budget and gate need measured first: how many
 * candidates pass the calendar screen, how that set compares with today's, and, for a small
 * deterministic sample of candidates who pass it but are not on the board today, how many
 * working days they have.
 */
import { screenCalendars, measureShadowContributions, decodeMeasurement } from './contributions.js';
import { deriveEvidence } from '../../src/model/next/evidence.js';
import { SCORE_CONFIG as NEXT_CONFIG } from '../../src/model/next/config.js';

export const SCREEN_MIN_DAYS = 2;
export const GATE_MIN_DAYS = NEXT_CONFIG.WORK.GATE_MIN_DAYS;
export const SAMPLE_SIZE = 15;
/**
 * Calendars read per batch besides the board's own rows. A calendar request holds 25 and takes
 * about 7 s (measured 2026-10-16), so all ~1,500 candidates of a batch would add 7 minutes to
 * every run for a figure 600 measures well: about 14,000 of the ~36,000 candidates a day.
 */
export const CALENDAR_SAMPLE = 600;

/** Working days as scoring v3 counts them (src/model/next/evidence.js). */
export function workingDays(m) {
  return deriveEvidence(m).working_days.length;
}

/** FNV-1a, for an order that is fixed per day and owes nothing to the alphabet. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function sampleOrder(rows, seed) {
  return [...rows].sort(
    (a, b) =>
      hash(`${seed}:${a.username.toLowerCase()}`) - hash(`${seed}:${b.username.toLowerCase()}`) ||
      (a.username < b.username ? -1 : 1)
  );
}

/** The counts the log line reports, from what the run saw. Pure. */
export function comparePrescreen({ candidates, calendarDays, fullyFetched, published }) {
  const key = (login) => login.toLowerCase();
  const fetchedSet = new Set(fullyFetched.map(key));
  const publishedSet = new Set(published.map(key));
  let read = 0;
  let pass = 0;
  const passNotFetched = [];
  const publishedUnder = [];
  for (const c of candidates) {
    const days = calendarDays.get(key(c.username));
    if (days === undefined) continue;
    read += 1;
    if (days >= SCREEN_MIN_DAYS) {
      pass += 1;
      if (!fetchedSet.has(key(c.username))) passNotFetched.push(c.username);
    } else if (publishedSet.has(key(c.username))) {
      publishedUnder.push(c.username);
    }
  }
  return { candidates: candidates.length, read, pass, passNotFetched, publishedUnder };
}

const quiet = { log() {}, warn() {} };

/**
 * Runs the calendar screen over this batch's candidates and measures a sample. Never throws and
 * never changes a row: a failure is one warning line.
 */
export async function prescreenStep({
  candidates,
  fullyFetched,
  published,
  client,
  now,
  log = console
}) {
  if (!client || !Array.isArray(candidates) || candidates.length === 0) return null;
  try {
    const all = candidates.map((c) => ({ username: c.login, github_id: c.id }));
    const seed = new Date(now).toISOString().slice(0, 10);
    const onBoard = new Set(published.map((login) => login.toLowerCase()));
    // Every developer the board takes, so "on the board but under the screen" is exact, and a
    // fixed-per-day sample of everyone else.
    const boardRows = all.filter((r) => onBoard.has(r.username.toLowerCase()));
    const others = sampleOrder(
      all.filter((r) => !onBoard.has(r.username.toLowerCase())),
      seed
    ).slice(0, CALENDAR_SAMPLE);
    const rows = [...boardRows, ...others];
    const calendar = await screenCalendars(rows, { client, now, log: quiet });
    const counts = comparePrescreen({
      candidates: rows,
      calendarDays: calendar.days,
      fullyFetched,
      published
    });
    const publishedSet = new Set(published.map((login) => login.toLowerCase()));
    const pool = rows.filter(
      (r) =>
        (calendar.days.get(r.username.toLowerCase()) ?? 0) >= SCREEN_MIN_DAYS &&
        !publishedSet.has(r.username.toLowerCase())
    );
    const sample = sampleOrder(pool, seed).slice(0, SAMPLE_SIZE);
    const measured = sample.length
      ? await measureShadowContributions(sample, { client, now, log: quiet })
      : { blocks: new Map(), failed: new Map() };
    const days = [...measured.blocks.values()]
      .map((block) => decodeMeasurement(block))
      .filter(Boolean)
      .map(workingDays)
      .sort((a, b) => a - b);
    const admitted = days.filter((d) => d >= GATE_MIN_DAYS).length;

    log.log(
      `Pre-screen (logged, not applied): ${all.length} candidates; calendars of the ` +
        `${boardRows.length} the board takes and ${others.length} others sampled, read for ` +
        `${counts.read} (${calendar.failed.size} not read); ${counts.pass} have >= ${SCREEN_MIN_DAYS} ` +
        `active calendar days. Today's screen fetched ${fullyFetched.length} in full and the board ` +
        `takes ${published.length}. On the board but under the calendar screen: ` +
        `${counts.publishedUnder.length}${counts.publishedUnder.length ? ` (${counts.publishedUnder.slice(0, 10).join(', ')})` : ''}. ` +
        `Over it but not fetched today: ${counts.passNotFetched.length}.`
    );
    log.log(
      `Pre-screen sample of candidates not on the board: ${days.length} of ${sample.length} measured; ` +
        `working days [${days.join(', ')}]; ${admitted} would pass a ${GATE_MIN_DAYS}-day gate.`
    );
    return { counts, sampleDays: days, admitted };
  } catch (error) {
    log.warn(`::warning title=PRESCREEN::The logged pre-screen failed: ${error.message}`);
    return null;
  }
}
