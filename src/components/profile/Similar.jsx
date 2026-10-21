import React from 'react';
import Section from './Section';

/**
 * The developers whose tags overlap this one's the most: the same fields, the same tags, so the
 * list is a way into the rest of the board rather than a wall of names.
 */
export default function Similar({ neighbours, onOpen }) {
  const list = Array.isArray(neighbours) ? neighbours : [];

  return (
    <Section
      title="Similar_Developers"
      icon="group"
      aside={list.length ? `${list.length} found` : null}
    >
      {list.length === 0 ? (
        <p className="p-4 md:p-6 font-mono text-[10px] text-outline uppercase tracking-widest">
          No other developer shares these tags.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {list.map((entry) => {
            const dev = entry.dev;
            const rank = Number(dev?.rank);
            return (
              <li key={dev.username} className="flex items-center gap-3 p-3 md:p-4 min-w-0">
                <span className="font-mono text-[10px] text-outline tabular-nums w-8 shrink-0">
                  {Number.isFinite(rank) ? String(rank).padStart(3, '0') : '---'}
                </span>
                <img
                  src={dev.avatar_url || `https://github.com/${dev.username}.png?size=80`}
                  alt=""
                  className="w-8 h-8 border border-outline-variant object-cover shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpen?.(dev.username)}
                    className="font-mono text-xs text-on-surface hover:text-primary transition-colors truncate block text-left"
                  >
                    {dev.username}
                  </button>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {entry.shared.map((tag) => (
                      <span
                        key={tag}
                        className="border border-outline-variant bg-surface-container-high px-1.5 py-0.5 font-mono text-[9px] text-outline uppercase tracking-widest"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
