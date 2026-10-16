/**
 * Repositories a moderator should read, from rows just measured: the shapes a script leaves that
 * the automatic integrity rules cannot prove (src/model/evidence.js). Never a verdict and never
 * applied: an entry in public/moderation.json is a person's decision, made by reading the commits.
 *
 *   cadence    commits on SUSPECT_MIN_DAYS or more days at a near-constant count a day (the
 *              coefficient of variation at most SUSPECT_MAX_CADENCE): a cron commits like that, and
 *              so does a person keeping a streak, which is why a person decides.
 *   coverage   a complete commit sample that finds fewer than half the days GitHub credits, but
 *              not so few that the missing-commits rule already excluded the repository.
 *
 * Run on every batch's newly measured rows (scripts/run-all.js), so a script admitted today is in
 * front of a moderator within the hour. On 2026-10-16 a one-off pass missed five script accounts
 * the first v3 runs admitted after it.
 */
import { decodeMeasurement, FLAG_FORK, FLAG_PROFILE } from '../src/model/measurement.js';
import { deriveEvidence } from '../src/model/evidence.js';
import { CONTRIBUTIONS_FIELD } from './measure/contributions.js';

export const SUSPECT_MIN_DAYS = 20;
export const SUSPECT_MAX_CADENCE = 0.3;
export const SUSPECT_MAX_COVERAGE = 0.5;

/** Coefficient of variation of a repository's commits per active day: near 0 is a metronome. */
export function cadence(days) {
  const counts = days.map((d) => d.commits);
  if (counts.length === 0) return null;
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  return mean > 0 ? sd / mean : null;
}

/**
 * @param {object[]} rows  board rows carrying a measurement
 * @param {{moderation?: object[]}} [options]
 * @returns {{login: string, repo: string, why: string}[]} in login, then repository order
 */
export function moderationSuspects(rows, { moderation = [] } = {}) {
  const out = [];
  for (const row of rows) {
    const m = decodeMeasurement(row?.[CONTRIBUTIONS_FIELD]);
    if (!m) continue;
    const excluded = new Set(
      deriveEvidence(m, { moderation }).excluded.map((e) => e.repo.toLowerCase())
    );
    const samples = new Map(m.integrity.map((s) => [s.repo.toLowerCase(), s]));
    for (const r of m.commits) {
      if (r.flags & (FLAG_FORK | FLAG_PROFILE) || excluded.has(r.repo.toLowerCase())) continue;
      const cv = cadence(r.days);
      if (r.days.length >= SUSPECT_MIN_DAYS && cv !== null && cv <= SUSPECT_MAX_CADENCE) {
        out.push({
          login: m.login,
          repo: r.repo,
          why: `commits on ${r.days.length} days at a near-constant rate (cv ${cv.toFixed(2)})`
        });
        continue;
      }
      const s = samples.get(r.repo.toLowerCase());
      if (
        s &&
        s.days !== null &&
        r.days.length >= 10 &&
        s.days < SUSPECT_MAX_COVERAGE * r.days.length
      ) {
        out.push({
          login: m.login,
          repo: r.repo,
          why: `GitHub credits ${r.days.length} days, the history holds commits on ${s.days}`
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.login.toLowerCase().localeCompare(b.login.toLowerCase(), 'en') ||
      a.repo.toLowerCase().localeCompare(b.repo.toLowerCase(), 'en')
  );
}

/** The suspects as lines for a log, and as markdown for a GitHub step summary. */
export function formatSuspects(suspects, { batchIndex }) {
  if (suspects.length === 0) {
    return { log: `Moderation suspects in batch ${batchIndex}: none.`, markdown: '' };
  }
  const lines = suspects.map(
    (s) => `- ${s.login} [${s.repo}](https://github.com/${s.repo}/commits) ${s.why}`
  );
  return {
    log:
      `Moderation suspects in batch ${batchIndex}, for a person to read (not applied):\n` +
      suspects.map((s) => `  ${s.login} ${s.repo}: ${s.why}`).join('\n'),
    markdown:
      `### Moderation suspects, batch ${batchIndex}\n\n` +
      'For a person to read against the commits. Nothing here is applied.\n\n' +
      `${lines.join('\n')}\n`
  };
}
