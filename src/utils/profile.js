/**
 * A developer's own page: the URL it is at, and what a link to it says.
 *
 * Shared by the page, the build that writes it and the badge, so the three cannot disagree
 * about where a developer's page is or what a preview of it says.
 */

export const SITE = 'https://rankistan.dev';

/** The page a developer's badge and their links point at. */
export function profileUrl(username) {
  return `${SITE}/${encodeURIComponent(String(username || '').trim())}`;
}

/**
 * What a link to a developer says: their biography when they have one, and what the board
 * knows about them either way.
 */
export function profileDescription(row, detail) {
  const rank = Number(row?.rank);
  const score = Number(row?.score_shown ?? row?.score);
  const stats = [
    Number.isFinite(rank) ? `Rank #${rank} on Rankistan` : 'On the Rankistan leaderboard',
    Number.isFinite(score) ? `${Math.trunc(score)} points` : null,
    `${Number(row?.followers) || 0} followers`,
    `${Number(row?.public_repos) || 0} public repositories`,
    `${Number(row?.total_stars) || 0} stars`,
    `${Number(row?.events_30d) || 0} events in the last 30 days`
  ]
    .filter(Boolean)
    .join(', ');

  const bio = typeof detail?.bio === 'string' ? detail.bio.trim() : '';
  const text = bio ? `${bio} — ${stats}` : stats;
  return text.length > 300 ? `${text.slice(0, 297).trimEnd()}…` : text;
}
