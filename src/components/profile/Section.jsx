import React from 'react';

/**
 * The frame every section on a developer's page sits in: the same header bar, the same border,
 * the same label style the expanded card uses.
 */
export default function Section({ title, icon, aside, children, className = '' }) {
  return (
    <section className={`border border-outline-variant bg-surface-container-lowest ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant bg-surface-container-high px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          {icon ? (
            <span className="material-symbols-outlined text-sm text-primary" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <h2 className="font-mono text-[10px] text-outline uppercase tracking-widest truncate">
            {title}
          </h2>
        </div>
        {aside ? (
          <span className="font-mono text-[10px] text-outline uppercase tracking-widest shrink-0">
            {aside}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
