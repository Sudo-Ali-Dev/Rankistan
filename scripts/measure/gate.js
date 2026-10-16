/**
 * Who a batch evaluates, and on what: the contributions screen, measurement and eligibility gate.
 *
 *   screen    each candidate's contribution calendar, 25 to a request. The calendar counts every
 *             public contribution (and private work, for those who share it) on the developer's
 *             own dates, so its active days bound their public working days from above. A
 *             Pakistan date and the developer's date differ by at most one, so the gate's
 *             GATE_MIN_DAYS working days cannot show as fewer than ceil(GATE_MIN_DAYS / 2)
 *             calendar days in the 32 dates around the window: SCREEN_MIN_DAYS rejects nobody
 *             the gate would admit. Developers already on the board and registered developers
 *             skip the screen and are always measured.
 *   measure   scripts/measure/contributions.js for everyone who passed it. A developer whose
 *             working days fall short after the first phase is not searched or sampled.
 *   gate      the model's own (src/model/score.js): working days of the measurement as scored.
 *
 * Measured beside v2's events screen on 2026-10-16 (batch 23): 41% of candidates not on the
 * board passed the calendar screen, and 4 of a 15-developer sample of them the 4-day gate.
 *
 * Fail-soft per developer, never per batch: a candidate whose calendar could not be read is
 * measured anyway, one whose measurement failed was not evaluated, and `complete` is false when
 * the measurement stopped or more than MAX_FAILED_SHARE of it failed, so the merge freezes miss
 * counters rather than count a failure as an absence.
 */
import { screenCalendars, measureContributions } from './contributions.js';
import { decodeMeasurement } from '../../src/model/measurement.js';
import { deriveEvidence } from '../../src/model/evidence.js';
import { scoreModel } from '../../src/model/score.js';
import { SCORE_CONFIG } from '../../src/model/config.js';

export const GATE_MIN_DAYS = SCORE_CONFIG.WORK.GATE_MIN_DAYS;
export const SCREEN_MIN_DAYS = Math.ceil(GATE_MIN_DAYS / 2);
export const MAX_FAILED_SHARE = 0.1;

/** Working days as the model counts them. */
export function workingDays(m, { moderation = [] } = {}) {
  return deriveEvidence(m, { moderation }).working_days.length;
}

/**
 * Screen, measure and gate `candidates` (`{id, login}`).
 *
 * @param {object} options
 * @param {object} options.client     a measurement client (createMeasurementClient)
 * @param {Set<number>} [options.bypass]  account ids that skip the screen: the batch's own board
 *                                        rows and registered developers
 * @param {object[]} [options.moderation]
 * @returns {Promise<{passed: Map<string, object>, screenedOut: string[], failed: Map<string,
 *   string>, complete: boolean, counts: object}>}
 */
export async function contributionsGate(
  candidates,
  { client, now = Date.now(), bypass = new Set(), moderation = [], log = console }
) {
  const rows = candidates.map((c) => ({ username: c.login, github_id: c.id }));
  const skips = (r) => bypass.has(r.github_id);
  const toScreen = rows.filter((r) => !skips(r));
  const calendar = await screenCalendars(toScreen, { client, now, log });
  const screenedOut = [];
  const toMeasure = rows.filter((r) => {
    if (skips(r)) return true;
    const days = calendar.days.get(r.username.toLowerCase());
    if (days === undefined) return true; // not read: measure rather than guess
    if (days >= SCREEN_MIN_DAYS) return true;
    screenedOut.push(r.username);
    return false;
  });

  const measured = await measureContributions(toMeasure, {
    client,
    now,
    log,
    prefilter: (partial) => workingDays(partial, { moderation }) >= GATE_MIN_DAYS
  });
  for (const [login] of measured.ineligible) {
    screenedOut.push(rows.find((r) => r.username.toLowerCase() === login)?.username ?? login);
  }

  const passed = new Map();
  for (const [login, block] of measured.blocks) {
    const result = scoreModel(block, { moderation });
    if (result.gate) passed.set(login, block);
    else screenedOut.push(decodeMeasurement(block).login);
  }

  const failedShare = toMeasure.length ? measured.failed.size / toMeasure.length : 0;
  const complete = !measured.stats.stopped && failedShare <= MAX_FAILED_SHARE;
  const counts = {
    candidates: rows.length,
    screened: toScreen.length,
    calendarsUnread: calendar.failed.size,
    screenedOut: rows.length - toMeasure.length,
    measured: toMeasure.length,
    shortAfterFirstPhase: measured.ineligible.size,
    passed: passed.size,
    failed: measured.failed.size
  };
  log.log(
    `Gate: ${counts.candidates} candidates; ${counts.screenedOut} under the calendar screen ` +
      `(${counts.calendarsUnread} calendars not read, measured anyway); ${counts.measured} ` +
      `measured, ${counts.shortAfterFirstPhase} short of ${GATE_MIN_DAYS} working days after ` +
      `the first phase, ${counts.passed} pass, ${counts.failed} not measured` +
      `${complete ? '' : ' (incomplete: miss counters freeze this run)'}.`
  );
  return { passed, screenedOut, failed: measured.failed, complete, counts };
}
