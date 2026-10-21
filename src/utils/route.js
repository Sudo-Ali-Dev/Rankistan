// Tab <-> URL path. Each tab has a real path so a page view can be measured per tab (Cloudflare
// Web Analytics records paths, ignores the hash and drops query strings), so a tab can be linked
// to, and so the back button moves between tabs. The developer deep link `/#username` stays on
// the leaderboard path: a GitHub login contains no `/`, so it can never collide with a tab.
//
// A developer's own page is /username: a real path, so it can be shared, previewed and crawled
// rather than only reached through the leaderboard's hash. A path that names no tab and no
// developer - a campaign landing such as /from/linkedin/infra-1 (index.html rewrites UTM links to
// that), or a stale link - shows the leaderboard and keeps its URL until the visitor moves, so the
// landing is counted under the path it arrived on.

export const TAB_PATHS = Object.freeze({
  leaderboard: '/',
  map: '/map',
  badge: '/badge',
  register: '/register',
  digest: '/digest',
  about: '/about',
  evolution: '/evolution'
});

export const TABS = Object.freeze(Object.keys(TAB_PATHS));

/** The tab a path names, or null for any other path. Trailing slashes and case are ignored. */
export function tabFromPath(pathname) {
  const clean =
    String(pathname || '/')
      .toLowerCase()
      .replace(/\/+$/, '') || '/';
  for (const [tab, path] of Object.entries(TAB_PATHS)) {
    if (path === clean) return tab;
  }
  return null;
}

/** The path for a tab; unknown tabs go to the leaderboard. */
export function pathForTab(tab) {
  return TAB_PATHS[tab] || '/';
}

// GitHub's rule for a login: letters, digits and single hyphens, not starting or ending with one,
// at most 39 characters.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The developer a `#login` hash names, or null for any other hash. */
export function loginFromHash(hash) {
  let value;
  try {
    value = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  } catch {
    return null;
  }
  return LOGIN_RE.test(value) ? value : null;
}

// The tab paths, without the leaderboard's: a developer whose login is `map` cannot have a page
// at /map, because the tab is there. Such a developer keeps the hash link their README badge
// carries, and the build skips their file.
export const RESERVED_PATHS = Object.freeze(
  new Set(
    Object.values(TAB_PATHS)
      .filter((path) => path !== '/')
      .map((path) => path.slice(1).toLowerCase())
  )
);

/** Whether a path is a tab's own, and so belongs to that tab rather than to a developer. */
export function isReservedPath(pathname) {
  const segments = String(pathname || '/')
    .split('/')
    .filter(Boolean);
  return segments.length === 1 && RESERVED_PATHS.has(segments[0].toLowerCase());
}

/**
 * The developer a `/username` path names, or null for any other path.
 *
 * One segment only: a campaign landing is three, and a tab path is reserved. The login is read
 * with GitHub's rule, so a path that names no GitHub account is no developer's page - it stays
 * on the leaderboard rather than showing a "not found" for a link that was never a profile.
 */
export function usernameFromPath(pathname) {
  const segments = String(pathname || '/')
    .split('/')
    .filter(Boolean);
  if (segments.length !== 1) return null;
  let value;
  try {
    value = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (RESERVED_PATHS.has(value.toLowerCase())) return null;
  return LOGIN_RE.test(value) ? value : null;
}
