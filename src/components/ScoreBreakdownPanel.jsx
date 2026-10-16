import React from 'react';
import { SCORE_CONFIG } from '../model/config.js';

const { SCALE, WEIGHTS, WINDOW_DAYS } = SCORE_CONFIG;

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
          Public_Work_Only
        </span>
        <ul className="space-y-1.5 font-body text-xs text-outline leading-relaxed">
          <li>
            Measured from GitHub's contributions API over the last{' '}
            <span className="text-on-surface">{WINDOW_DAYS} days</span>, with the code the pipeline
            runs.
          </li>
          <li>Followers, repository counts and private contributions do not count.</li>
        </ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-outline-variant bg-surface-container-low text-[10px] uppercase tracking-widest text-outline">
              <th className="p-3 sm:p-4 font-normal">Part</th>
              <th className="p-3 sm:p-4 font-normal">Measured</th>
              <th className="p-3 sm:p-4 font-normal text-right">Points</th>
            </tr>
          </thead>
          <tbody className="text-on-surface-variant">
            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Work</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(evidence.working_days.length)} of {WINDOW_DAYS} days with public work
                <span className="block text-[10px] text-outline/70 mt-0.5">
                  Recent days weigh more. A day counts once.
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('work'))}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Collaboration</td>
              <td className="p-3 sm:p-4 text-outline">
                {formatNum(evidence.accepted.length)} merged by others,{' '}
                {formatNum(evidence.reviews.length)} reviews,{' '}
                {formatNum(evidence.maintained.length)} merged into your projects
                <span className="block text-[10px] text-outline/70 mt-0.5">
                  Counted per project and per person.
                </span>
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('collaboration'))}
              </td>
            </tr>

            <tr className="border-b border-outline-variant/50">
              <td className="p-3 sm:p-4 text-on-surface">Appreciation</td>
              <td className="p-3 sm:p-4 text-outline">
                {appreciated
                  ? `${appreciated.repo}, ${formatNum(appreciated.stars)} stars, worked on ${appreciated.days} days`
                  : `No project of yours with ${SCORE_CONFIG.APPRECIATION.FROM_STARS} or more stars worked on this month`}
              </td>
              <td className="p-3 sm:p-4 text-right text-primary font-bold tabular-nums">
                +{formatPoints(points('appreciation'))}
              </td>
            </tr>

            {evidence.excluded.length > 0 && (
              <tr className="border-b border-outline-variant/50">
                <td className="p-3 sm:p-4 text-error" colSpan={3}>
                  Not counted: {evidence.excluded.map((e) => `${e.repo} (${e.reason})`).join(', ')}
                </td>
              </tr>
            )}

            <tr className="bg-primary/10">
              <td
                className="p-3 sm:p-4 font-bold text-on-surface uppercase tracking-tight"
                colSpan={2}
              >
                Score
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
