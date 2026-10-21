import React, { useState } from 'react';
import {
  BADGE_FORMATS,
  BADGE_STYLES,
  buildBadgeUrl,
  getSnippet,
  profileUrl
} from '../../utils/badge';
import CopyButton from '../CopyButton';
import Section from './Section';

/**
 * The badge for this developer, and the snippet that puts it in a README.
 *
 * The link the badge wraps points at this page: /username, the same URL this page is on. The
 * badge itself is a live endpoint, so it always shows the current rank.
 */
export default function BadgeEmbed({ username }) {
  const [style, setStyle] = useState('flat');
  const [fmt, setFmt] = useState('md');

  const badgeUrl = buildBadgeUrl(username, style);
  const snippet = getSnippet(style, username, fmt);

  return (
    <Section title="Embed_Badge" icon="military_tech">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-outline-variant">
        <div className="bg-surface-container-lowest p-4 md:p-6 space-y-4">
          <div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-2">
              Style
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
              {BADGE_STYLES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setStyle(entry.id)}
                  className={`min-h-11 py-2.5 px-2.5 sm:px-3 font-mono text-[9px] sm:text-[10px] uppercase tracking-widest border transition-colors text-left leading-tight ${
                    style === entry.id
                      ? 'border-primary text-primary bg-primary/10'
                      : 'border-outline-variant text-outline hover:border-outline hover:text-on-surface-variant'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-2">
              Format
            </div>
            <div className="flex gap-2">
              {BADGE_FORMATS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setFmt(entry)}
                  className={`min-h-11 flex-1 py-2 font-mono text-[10px] uppercase tracking-widest border transition-colors sm:py-2 ${
                    fmt === entry
                      ? 'border-secondary text-secondary bg-secondary/10'
                      : 'border-outline-variant text-outline hover:border-outline hover:text-on-surface-variant'
                  }`}
                >
                  {entry === 'md' ? 'Markdown' : entry === 'html' ? 'HTML' : 'reST'}
                </button>
              ))}
            </div>
          </div>

          <div className="border border-outline-variant bg-surface p-4 flex items-center justify-center min-h-[72px] overflow-x-auto">
            <img
              key={badgeUrl}
              src={badgeUrl}
              alt="Rankistan rank badge preview"
              className="max-w-full h-auto"
              style={{ maxHeight: style === 'for-the-badge' ? '28px' : '20px' }}
            />
          </div>
        </div>

        <div className="bg-surface-container-lowest p-4 md:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
              Copy snippet
            </span>
            <CopyButton text={snippet} />
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-[11px] text-on-surface-variant leading-relaxed whitespace-pre-wrap break-all border border-outline-variant bg-surface-container-lowest sm:text-xs">
            <code>{snippet}</code>
          </pre>
          <p className="font-mono text-[10px] text-outline/80 uppercase tracking-widest leading-relaxed">
            The badge links to {profileUrl(username)}. Paste it into your README.
          </p>
        </div>
      </div>
    </Section>
  );
}
