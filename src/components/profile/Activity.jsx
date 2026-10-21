import React from 'react';
import { ACTIVITY_ROWS } from '../../utils/activity-summary';
import Section from './Section';

/**
 * What the developer did in the last 30 days, in counts.
 *
 * These are counted from the same measurement the score is computed from, under the same rules:
 * a fork, a profile README repository and a repository under moderation are not work, and a pull
 * request counts only when it was opened in a repository the developer does not own.
 */
export default function Activity({ dev }) {
  const activity = dev?.activity;

  if (!activity) {
    return (
      <Section title="Activity_Breakdown" icon="bolt">
        <p className="p-4 md:p-6 font-mono text-[10px] text-outline uppercase tracking-widest">
          The activity behind this score is not available.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Activity_Breakdown" icon="bolt" aside="last 30 days">
      <div className="grid grid-cols-2 gap-px bg-outline-variant md:grid-cols-3">
        {ACTIVITY_ROWS.map((row) => {
          const value = Number(activity[row.key]);
          return (
            <div key={row.key} className="bg-surface-container-lowest p-4 min-w-0">
              <div className="font-mono text-[10px] text-outline uppercase tracking-widest">
                {row.label}
              </div>
              <div className="font-headline font-bold text-2xl tabular-nums leading-tight">
                {Number.isFinite(value) ? value.toLocaleString('en-US') : '0'}
              </div>
              <div className="font-mono text-[10px] text-outline/80 uppercase tracking-wider leading-relaxed">
                {row.hint}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
