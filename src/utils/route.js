// Tab <-> URL path. Each tab has a real path so a page view can be measured per tab (Cloudflare
// Web Analytics records paths, ignores the hash and drops query strings), so a tab can be linked
// to, and so the back button moves between tabs. The developer deep link `/#username` stays on
// the leaderboard path: a GitHub login contains no `/`, so it can never collide with a tab.
//
// Any other path - a campaign landing such as /from/linkedin/infra-1 (index.html rewrites UTM
// links to that), or a stale link - shows the leaderboard and keeps its URL until the visitor
// moves, so the landing is counted under the path it arrived on.

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
