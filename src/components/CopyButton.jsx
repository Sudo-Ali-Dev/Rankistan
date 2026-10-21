import React, { useState } from 'react';

/** Copies text to the clipboard and says so for a moment afterwards. */
export default function CopyButton({ text, className = '', label = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      onClick={handle}
      className={`font-mono text-[10px] uppercase tracking-widest border border-outline-variant px-3 py-1 transition-colors hover:border-primary hover:text-primary ${copied ? 'text-tertiary border-tertiary' : 'text-outline'} ${className}`}
    >
      {copied ? (
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-xs" aria-hidden="true">
            check
          </span>
          Copied
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-xs" aria-hidden="true">
            content_copy
          </span>
          {label}
        </span>
      )}
    </button>
  );
}
