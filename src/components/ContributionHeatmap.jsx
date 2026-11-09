import { useState } from 'react';
import { resolveHeatmapApiUrl, resolveHeatmapDirectUrl } from '../utils/groq.js';

/**
 * The contribution heatmap, read through the Worker and falling back to the chart service
 * itself. The card and a developer's own page show the same one.
 *
 * Both the fallback and the failure are kept with the username they belong to, so a card that
 * opens another developer's chart does not show the last one's failure.
 */
export default function ContributionHeatmap({ username, className = '' }) {
  const [fallback, setFallback] = useState(null);
  const [failedFor, setFailedFor] = useState(null);

  if (!username) {
    return (
      <div className="font-mono text-[10px] text-outline uppercase text-center px-2">
        No username available.
      </div>
    );
  }

  const apiUrl = resolveHeatmapApiUrl(username);
  const directUrl = resolveHeatmapDirectUrl(username);
  const usingFallback = fallback?.username === username;
  const src = usingFallback ? fallback.src : apiUrl;

  if (failedFor === username) {
    return (
      <div className="font-mono text-[10px] text-outline uppercase text-center px-2">
        Activity graph unavailable
      </div>
    );
  }

  const handleError = () => {
    if (src === directUrl) {
      setFailedFor(username);
      return;
    }
    setFallback({ username, src: directUrl });
  };

  return (
    <img
      src={src}
      alt={`${username} contribution chart`}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={handleError}
      className={`w-full h-full object-contain opacity-80 hover:opacity-100 transition-all drop-shadow-md ${className}`}
    />
  );
}
