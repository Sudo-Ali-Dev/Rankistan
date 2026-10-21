import React, { useEffect, useState } from 'react';
import { generateDeveloperSummary } from '../../utils/groq';
import Section from './Section';

/**
 * The AI summary, read from the same endpoint the expanded card uses. The Worker builds the
 * prompt from its own copy of the published board, so it says nothing that is not published.
 *
 * When it cannot be had - the Worker is down, the rate limit is reached, the answer is refused -
 * the bio stands in its place, and the section says which one is showing.
 */
export default function AiSummary({ dev }) {
  // The answer is kept with the username it belongs to, so a page that opens another developer
  // shows their summary and not the one still loading.
  const [result, setResult] = useState({ username: null, text: null });

  const username = dev?.username || '';

  useEffect(() => {
    if (!username) return undefined;
    let cancelled = false;

    generateDeveloperSummary(dev).then((text) => {
      if (cancelled) return;
      setResult({ username, text: !text || text === 'error' ? null : text });
    });

    return () => {
      cancelled = true;
    };
  }, [username, dev]);

  const ready = result.username === username && Boolean(result.text);
  const loading = result.username !== username;
  const bio = typeof dev?.bio === 'string' ? dev.bio.trim() : '';

  return (
    <Section
      title="AI_Summary"
      icon="auto_awesome"
      aside={ready ? 'Groq' : loading ? 'Generating' : 'Bio'}
    >
      <div className="p-4 md:p-6">
        {loading ? (
          <div className="space-y-2" aria-hidden="true">
            <div className="h-3 w-full bg-surface-container-high animate-pulse" />
            <div className="h-3 w-4/5 bg-surface-container-high animate-pulse" />
            <div className="h-3 w-2/3 bg-surface-container-high animate-pulse" />
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant leading-relaxed font-body max-w-3xl">
            {ready ? result.text : bio || 'No biography available.'}
          </p>
        )}
      </div>
    </Section>
  );
}
