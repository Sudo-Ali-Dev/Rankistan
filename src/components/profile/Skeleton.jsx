import React from 'react';

/** A block that waits for its content: the shape of what is coming, in place. */
export function SkeletonLine({ className = '' }) {
  return <div className={`bg-surface-container-high animate-pulse ${className}`} />;
}

/** The placeholders for a developer's page, one per section, so the page does not jump. */
export default function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the developer’s profile…</span>

      <div className="border border-outline-variant bg-surface-container-lowest p-5 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row">
          <SkeletonLine className="w-24 h-24 md:w-32 md:h-32 shrink-0" />
          <div className="flex-1 space-y-3">
            <SkeletonLine className="h-8 w-2/3" />
            <SkeletonLine className="h-4 w-1/3" />
            <SkeletonLine className="h-3 w-full" />
            <SkeletonLine className="h-3 w-4/5" />
          </div>
        </div>
      </div>

      <div className="border border-outline-variant bg-surface-container-lowest">
        <SkeletonLine className="h-12 w-full" />
        <div className="p-4 md:p-6 grid grid-cols-2 gap-4 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonLine key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>

      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="border border-outline-variant bg-surface-container-lowest">
          <SkeletonLine className="h-12 w-full" />
          <div className="p-4 md:p-6 space-y-3">
            <SkeletonLine className="h-3 w-full" />
            <SkeletonLine className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
