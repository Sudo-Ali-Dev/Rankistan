/**
 * The rank badge: the URL the image is served from, and the snippet that puts it in a README.
 *
 * The badge is a Shields.io endpoint that reads the Worker's answer, so it always shows the
 * current rank. The link it wraps points at the developer's own page: /username, the same URL
 * everyone can share. The hash form, /#username, is what earlier badges carry and still opens
 * the same page.
 */
import { resolveBadgeApiUrl } from './groq.js';
import { profileUrl } from './profile.js';

export { profileUrl };

export const BADGE_STYLES = Object.freeze([
  { id: 'flat', label: 'Flat' },
  { id: 'for-the-badge', label: 'For The Badge' },
  { id: 'flat-square', label: 'Flat Square' },
  { id: 'plastic', label: 'Plastic' }
]);

export const BADGE_FORMATS = Object.freeze(['md', 'html', 'rst']);

/** The badge for a developer who is not on the board. */
export function buildStaticBadgeUrl(message, style) {
  return (
    `https://img.shields.io/badge/Rankistan-${encodeURIComponent(message)}-1a7f4e` +
    `?labelColor=0f6e56` +
    `&style=${style}` +
    `&logo=github` +
    `&logoColor=white`
  );
}

/** The live badge: a Shields endpoint reading the Worker's answer for this developer. */
export function buildBadgeUrl(username, style) {
  const endpoint = resolveBadgeApiUrl(username);
  return `https://img.shields.io/endpoint?url=${encodeURIComponent(endpoint)}&style=${style}`;
}

/** The snippet that puts the badge in a README, in the format asked for. */
export function getSnippet(style, username, fmt) {
  const img = buildBadgeUrl(username, style);
  const link = profileUrl(username);
  const alt = 'Rankistan rank badge';
  if (fmt === 'md') return `[![${alt}](${img})](${link})`;
  if (fmt === 'html') return `<a href="${link}">\n  <img src="${img}" alt="${alt}">\n</a>`;
  if (fmt === 'rst') return `.. image:: ${img}\n   :target: ${link}\n   :alt: ${alt}`;
  return '';
}
