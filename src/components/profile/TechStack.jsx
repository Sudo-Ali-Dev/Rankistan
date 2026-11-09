import React from 'react';
import Section from './Section';

/**
 * The languages the developer writes in, and how much of their work is in each.
 *
 * The counts are the number of their public repositories written in that language. A row
 * measured before the pipeline kept them has the names only, and then the names are shown as
 * they are: a bar without a number behind it would say more than the data does.
 */
export default function TechStack({ dev }) {
  const names = Array.isArray(dev?.top_languages) ? dev.top_languages : [];
  const counts = Array.isArray(dev?.language_counts)
    ? dev.language_counts.filter((entry) => entry && entry.language)
    : [];

  const bars = counts.length > 0 ? counts : [];
  const max = bars.reduce((top, entry) => Math.max(top, Number(entry.count) || 0), 0);

  return (
    <Section title="Tech_Stack" icon="code">
      <div className="p-4 md:p-6">
        {bars.length > 0 ? (
          <div className="space-y-3">
            {bars.map((entry) => {
              const count = Number(entry.count) || 0;
              const share = max > 0 ? count / max : 0;
              return (
                <div key={entry.language}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] text-on-surface uppercase tracking-widest">
                      {entry.language}
                    </span>
                    <span className="font-mono text-[10px] text-outline tabular-nums">
                      {count} {count === 1 ? 'repository' : 'repositories'}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 bg-surface-container-high border border-outline-variant">
                    <div
                      className="h-full bg-tertiary"
                      style={{ width: `${Math.round(share * 1000) / 10}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : names.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {names.map((name) => (
              <span
                key={name}
                className="shrink-0 border border-outline-variant bg-surface-container-high px-2 py-1 font-mono text-[10px] text-on-surface uppercase tracking-widest"
              >
                {name}
              </span>
            ))}
          </div>
        ) : (
          <p className="font-mono text-[10px] text-outline uppercase tracking-widest">
            No languages published for this developer.
          </p>
        )}
      </div>
    </Section>
  );
}
