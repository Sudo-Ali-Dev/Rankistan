import React from 'react';
import { SCORE_CONFIG } from '../model/config.js';
import {
  PART_LABELS,
  pointsForCredits,
  pointsForStars,
  workPointsForDays
} from '../utils/score-explainer.js';

const { SCALE, WEIGHTS, WINDOW_DAYS, APPRECIATION } = SCORE_CONFIG;

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** How the active-days points came out, in words, from the developer's own numbers. */
function workHow(days, points) {
  if (days === 0) return 'No active days in the window.';
  const even = workPointsForDays(days);
  const base = `Spread evenly across the month, ${plural(days, 'active day', 'active days')} would earn about ${Math.round(even)} points.`;
  if (points > even + 0.5)
    return `${base} More of yours were recent, and recent days count a little more, so you get ${formatPoints(points)}.`;
  if (points < even - 0.5)
    return `${base} More of yours were longer ago, and older days count a little less, so you get ${formatPoints(points)}.`;
  return base;
}

/** What the open source contributions were, in words. */
function collaborationWhat(evidence) {
  const items = [];
  if (evidence.accepted.length)
    items.push(
      `${plural(evidence.accepted.length, 'pull request', 'pull requests')} merged into open source projects you do not own`
    );
  if (evidence.reviews.length) items.push(plural(evidence.reviews.length, 'review', 'reviews'));
  if (evidence.maintained.length)
    items.push(
      `${plural(evidence.maintained.length, 'pull request', 'pull requests')} from other developers merged into your repositories`
    );
  return items.length ? items.join(', ') : `None in the last ${WINDOW_DAYS} days`;
}

function collaborationHow(credits, points, rejection = 1) {
  if (!(credits > 0)) {
    return `No credits yet. One pull request merged into a popular open source project would add about ${Math.round(pointsForCredits(1))} points.`;
  }
  return `Each pull request earns up to 1 credit, more in a project with more stars. A review, or a pull request merged into your own repository, earns half, and each further project or person counts a little less. Together yours earn ${credits.toFixed(2)} credits, which give ${formatPoints(pointsForCredits(credits))} points.${rejection < 1 ? ` Most of your pull requests to other projects were closed without being merged, so that is multiplied by ${rejection.toFixed(2)}, giving ${formatPoints(points)}.` : ''} For comparison, 1 credit gives ${Math.round(pointsForCredits(1))} and 3 credits give ${Math.round(pointsForCredits(3))}.`;
}

function starsHow(repo, points) {
  if (!repo) return `Under ${APPRECIATION.FROM_STARS} stars gives nothing.`;
  const full = pointsForStars(repo.stars);
  const base = `${repo.stars.toLocaleString('en-US')} stars give ${formatPoints(full)} points.`;
  if (repo.days >= APPRECIATION.FULL_AFTER_DAYS) return base;
  return `${base} The full amount needs commits on ${APPRECIATION.FULL_AFTER_DAYS} days, you have ${repo.days}, so you get ${repo.days}/${APPRECIATION.FULL_AFTER_DAYS} of ${formatPoints(full)}, which is ${formatPoints(points)}.`;
}

function formatNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

function formatPoints(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toFixed(1);
}

/** The preview the Worker measured (cloudflare/score-preview.js), as the three parts it adds up. */
export default function ScoreBreakdownPanel({ preview, gatesPassed = true }) {
  if (!preview) {
    return null;
  }

  const { parts, score, evidence } = preview;
  const points = (id) => SCALE * WEIGHTS[id] * parts[id];
  const appreciated = preview.details?.appreciated
    ? evidence.appreciation.find((r) => r.repo === preview.details.appreciated)
    : null;

  return (
    <section className="mb-8 sm:mb-12 border border-outline-variant bg-surface-container-lowest">
      <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">pie_chart</span>
          <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tighter uppercase text-on-surface">
            Score Breakdown
          </h2>
        </div>
        <div className="font-mono text-2xl sm:text-3xl font-bold text-primary tabular-nums">
          {formatNum(score)}
          <span className="text-[10px] sm:text-xs text-outline font-normal ml-2 uppercase tracking-widest">
            of {formatNum(SCALE)}
          </span>
        </div>
      </div>

      {!gatesPassed && (
        <div className="px-4 sm:px-6 py-3 border-b border-outline-variant bg-error-container/10 font-mono text-[10px] text-error uppercase tracking-widest">
          This profile would not be ranked yet. The breakdown is still how its score is calculated.
        </div>
      )}

      <div className="p-4 sm:p-6 border-b border-outline-variant bg-tertiary/5">
        <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-2">
          Only_Public_Repositories
        </span>
        <ul className="space-y-1.5 font-body text-xs text-outline leading-relaxed">
          <li>
            Your activity in public repositories on GitHub over the last{' '}
            <span className="text-on-surface">{WINDOW_DAYS} days</span>, read with the same code the
            leaderboard uses.
          </li>
          <li>
            Followers, how many repositories you have, and activity in private repositories give no
            points.
          </li>
        </ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-outline-variant bg-surface-container-low text-[10px] uppercase tracking-widest text-outline">
              <th className="p-3 sm:p-4 font-normal">Part</th>
              <th className="p-3 sm:p-4 font-normal">What we found</th>
              <th className="p-3 sm:p-4 font-normal text-right">Points</th>
            </tr>
          </thead>
          <tbody className="text-on-surface-variant">
            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">{PART_LABELS.work}</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(evidence.working_days.length)} of {WINDOW_DAYS} days active
                <span className="block text-[10px] text-outline/70 mt-0.5 font-body normal-case">
                  {workHow(evidence.working_days.length, points('work'))}
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('work'))}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">{PART_LABELS.collaboration}</td>
              <td className="p-3 sm:p-4 text-outline">
                {collaborationWhat(evidence)}
                <span className="block text-[10px] text-outline/70 mt-0.5 font-body normal-case">
                  {collaborationHow(
                    preview.details?.c,
                    points('collaboration'),
                    preview.details?.rejection_factor
                  )}
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('collaboration'))}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">{PART_LABELS.appreciation}</td>
              <td className="p-3 sm:p-4 text-outline">
                {appreciated
                  ? `${appreciated.repo}, ${formatNum(appreciated.stars)} stars, committed to on ${plural(appreciated.days, 'day', 'days')}`
                  : `No repository of yours with ${APPRECIATION.FROM_STARS} or more stars that you committed to this month`}
                <span className="block text-[10px] text-outline/70 mt-0.5 font-body normal-case">
                  {starsHow(appreciated, points('appreciation'))}
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('appreciation'))}
              </td>
            </tr>

            {evidence.excluded.length > 0 && (
              <tr className="border-b border-outline-variant/50">
                <td className="p-3 sm:p-4 text-error" colSpan={3}>
                  These repositories were not counted.{' '}
                  {evidence.excluded.map((e) => `${e.repo} (${e.reason})`).join(', ')}
                </td>
              </tr>
            )}

            <tr className="bg-primary/10">
              <td className="p-3 sm:p-4 font-bold text-on-surface uppercase tracking-tight">
                Score
              </td>
              <td className="p-3 sm:p-4 text-outline">
                {['work', 'collaboration', 'appreciation']
                  .map((id) => formatPoints(points(id)))
                  .join(' + ')}
                , rounded to a whole number
              </td>
              <td className="p-3 sm:p-4 text-right font-bold text-primary text-base tabular-nums">
                {formatNum(score)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="p-4 sm:p-6 font-mono text-[10px] text-outline/80 uppercase leading-relaxed border-t border-outline-variant/50">
        Measured live on {preview.measured_at.slice(0, 10)}. The board's own score comes from the
        pipeline, which measures each developer once a day.
      </p>
    </section>
  );
}
