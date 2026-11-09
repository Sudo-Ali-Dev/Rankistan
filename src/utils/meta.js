/**
 * The page's own name, for the tags a link preview reads.
 *
 * A developer's page is written with its own tags at build time (scripts/build-routes.js), so a
 * link to rankistan.dev/username previews that developer. The page opened through the hash -
 * the badge link every README carries, /#username - is the same page, and the server cannot
 * know which developer it is, so the tags are set here once the page knows.
 */

/** What the tags say when the site is showing the leaderboard. */
export const SITE_DEFAULTS = Object.freeze({
  title: 'Rankistan | The Pakistani Developer Leaderboard',
  description:
    'Discover and rank top Pakistani developers. Explore profiles, check out GitHub activity, and connect with the community.',
  image: 'https://rankistan.dev/favicon.svg'
});

/** Sets a meta tag's content, adding the tag when the page has none. */
export function setMetaContent(attribute, key, content) {
  if (typeof document === 'undefined') return;
  let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', String(content ?? ''));
}

/** Points the canonical link at a URL, adding the link when the page has none. */
export function setCanonical(url) {
  if (typeof document === 'undefined') return;
  let link = document.head.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', String(url ?? ''));
}

/** The tags of a developer's page. */
export function setProfileMeta({ title, description, url, image }) {
  setMetaContent('property', 'og:title', title);
  setMetaContent('property', 'og:description', description);
  setMetaContent('property', 'og:url', url);
  setMetaContent('property', 'og:image', image);
  setMetaContent('property', 'twitter:title', title);
  setMetaContent('property', 'twitter:description', description);
  setMetaContent('property', 'twitter:url', url);
  setMetaContent('property', 'twitter:image', image);
  setMetaContent('name', 'description', description);
  setCanonical(url);
}

/** The tags of the site itself, for a tab. */
export function setSiteMeta() {
  setMetaContent('property', 'og:title', SITE_DEFAULTS.title);
  setMetaContent('property', 'og:description', SITE_DEFAULTS.description);
  setMetaContent('property', 'og:image', SITE_DEFAULTS.image);
  setMetaContent('property', 'twitter:title', SITE_DEFAULTS.title);
  setMetaContent('property', 'twitter:description', SITE_DEFAULTS.description);
  setMetaContent('property', 'twitter:image', SITE_DEFAULTS.image);
  setMetaContent('name', 'description', SITE_DEFAULTS.description);
}
