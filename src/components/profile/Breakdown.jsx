import React from 'react';
import { scoreBreakdown, breakdownTotal } from '../../utils/score-breakdown';
import Section from './Section';

/**
 * The score in its three parts: active days, open source contributions and stars. Each bar is
 * the share of that part's maximum the developer reached, and under it is what was found.
 *
 * Followers, repository counts and account age are not here, because they give no points
 * (SCORE_NOT_COUNTED in score-explainer.js) and a bar for them would say they do.
 */
export default function Breakdown({ dev }) {
  const parts = scoreBreakdown(dev);
  const total = breakdownTotal(dev);

  if (parts.length === 0) {
    return (
      <Section title="Score_Breakdown" icon="bar_chart">
        <p className="p-4 md:p-6 font-mono text-[10px] text-outline uppercase tracking-widest">
          The breakdown of this score is not available.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Score_Breakdown"
      icon="bar_chart"
      aside={total ? `${total.points} of ${total.max}` : null}
    >
      <div className="p-4 md:p-6 space-y-5">
        {parts.map((part) => (
          <div key={part.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-[10px] text-on-surface uppercase tracking-widest">
                {part.label}
              </span>
              <span className="font-mono text-[10px] text-primary tabular-nums">
                {part.points_text} / {part.max}
              </span>
            </div>
            <div className="mt-1.5 h-2 bg-surface-container-high border border-outline-variant">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.round(part.share * 1000) / 10}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-outline leading-relaxed font-body">{part.detail}</p>
          </div>
        ))}
        <p className="font-mono text-[10px] text-outline/80 uppercase tracking-widest leading-relaxed border-t border-outline-variant/50 pt-4">
          Scored by the pipeline on {String(dev?.scored_at || '').slice(0, 10) || 'an earlier date'}
          . Every part is a share of the score, and the three add up to it.
        </p>
      </div>
    </Section>
  );
}
