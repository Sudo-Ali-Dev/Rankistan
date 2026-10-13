import React from 'react';
import { ACTIVITY_TYPE_ROWS } from '../utils/score-breakdown.js';

function formatNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

function formatPoints(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export default function ScoreBreakdownPanel({ breakdown, gatesPassed = true }) {
  if (!breakdown) {
    return null;
  }

  const { stars, followers, publicRepos, activity, baseScore, agePenalty, finalScore } =
    breakdown;

  const activityRows = ACTIVITY_TYPE_ROWS.map(({ typeKey, label }) => {
    const row = activity.byType[typeKey] || { points: 0, events30d: 0 };
    return { label, ...row };
  });

  const pushNote = 'First 20 pushes per UTC day enter the curve; daily cap 15 pts.';

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
          {formatNum(finalScore)}
          <span className="text-[10px] sm:text-xs text-outline font-normal ml-2 uppercase tracking-widest">
            est. total
          </span>
        </div>
      </div>

      {!gatesPassed && (
        <div className="px-4 sm:px-6 py-3 border-b border-outline-variant bg-error-container/10 font-mono text-[10px] text-error uppercase tracking-widest">
          Profile did not pass all registration gates — breakdown is still how your score would be calculated.
        </div>
      )}

      <div className="p-4 sm:p-6 border-b border-outline-variant bg-tertiary/5">
        <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-2">
          Open_Source_Only
        </span>
        <ul className="space-y-1.5 font-body text-xs text-outline leading-relaxed">
          <li>
            <span className="text-on-surface font-medium">Stars</span> — summed from{' '}
            <span className="text-on-surface">public repositories</span> only (private repos are not included).
          </li>
          <li>
            <span className="text-on-surface font-medium">Activity</span> —{' '}
            <span className="text-on-surface">public</span> Push, Pull Request, Issue, and Release events from the last{' '}
            <span className="text-on-surface">30 days</span>, scored per UTC calendar day with diminishing returns.
          </li>
          <li>Watch, star, fork, and comment activity do not count toward score or contribution thresholds.</li>
        </ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-outline-variant bg-surface-container-low text-[10px] uppercase tracking-widest text-outline">
              <th className="p-3 sm:p-4 font-normal">Component</th>
              <th className="p-3 sm:p-4 font-normal">Input (30d / profile)</th>
              <th className="p-3 sm:p-4 font-normal text-right">Points</th>
            </tr>
          </thead>
          <tbody className="text-on-surface-variant">
            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Stars</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(stars.raw)} stars
                {stars.capApplied && (
                  <span className="text-tertiary"> → capped at {formatNum(stars.capped)}</span>
                )}
                <span className="block text-[10px] text-outline/70 mt-0.5">
                  × {stars.weight} per star
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(stars.points)}
              </td>
            </tr>

            {activityRows.map((row) => (
              <tr key={row.label} className="border-b border-outline-variant/30 bg-surface-container-low/30">
                <td className="p-3 sm:p-4 pl-6 sm:pl-8 text-on-surface">{row.label}</td>
                <td className="p-3 sm:p-4 text-outline">
                  {formatNum(row.events30d)} events in 30d
                  {row.label === 'PushEvent' && (
                    <span className="block text-[10px] text-outline/70 mt-0.5">{pushNote}</span>
                  )}
                </td>
                <td className="p-3 sm:p-4 text-right text-primary tabular-nums">
                  +{formatPoints(row.points)}
                </td>
              </tr>
            ))}

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-outline italic" colSpan={2}>
                Activity subtotal
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(activity.total)}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Followers</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(followers.raw)} followers
                {followers.capApplied && (
                  <span className="text-tertiary"> → capped at {formatNum(followers.capped)}</span>
                )}
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(followers.points)}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Public repos</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(publicRepos.raw)} repos × {publicRepos.weight}
                {publicRepos.capApplied && (
                  <span className="text-tertiary"> → capped at {formatNum(publicRepos.capped)}</span>
                )}
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(publicRepos.points)}
              </td>
            </tr>

            <tr className="border-b border-outline-variant bg-surface-container-low">
              <td className="p-3 sm:p-4 font-bold text-on-surface" colSpan={2}>
                Base score (before age penalty)
              </td>
              <td className="p-3 sm:p-4 text-right font-bold text-on-surface tabular-nums">
                {formatPoints(baseScore)}
              </td>
            </tr>

            {agePenalty.applied && (
              <tr className="border-b border-outline-variant/50">
                <td className="p-3 sm:p-4 text-error" colSpan={2}>
                  {agePenalty.label}
                  {agePenalty.accountAgeDays != null && (
                    <span className="block text-[10px] text-outline mt-0.5">
                      Account age: {agePenalty.accountAgeDays} days
                    </span>
                  )}
                </td>
                <td className="p-3 sm:p-4 text-right text-error tabular-nums">
                  −{formatPoints(agePenalty.pointsLost)}
                </td>
              </tr>
            )}

            <tr className="bg-primary/10">
              <td className="p-3 sm:p-4 font-bold text-on-surface uppercase tracking-tight" colSpan={2}>
                Final estimated score
              </td>
              <td className="p-3 sm:p-4 text-right font-bold text-primary text-base tabular-nums">
                {formatNum(finalScore)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="p-4 sm:p-6 font-mono text-[10px] text-outline/80 uppercase leading-relaxed border-t border-outline-variant/50">
        Points above sum to your estimated score. The board's own score comes from the pipeline, which re-measures each developer once a day.
      </p>
    </section>
  );
}
