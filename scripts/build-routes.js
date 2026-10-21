// After `vite build`: give every path a real page, so rankistan.dev/map answers 200.
//
//   node scripts/build-routes.js [--out dist]
//
// GitHub Pages serves dist/map.html for /map, so each tab in src/utils/route.js gets a copy of
// dist/index.html under its own name; the app then reads the tab from the path. A link preview
// (LinkedIn, Slack) of a tab URL therefore gets the page, not a 404. Assets are root-absolute
// (vite.config.js `base: '/'`), so one HTML file works at any depth.
//
// A developer's own page is the same idea: dist/<login>.html, one per developer on the board,
// each with its own title, description and preview tags, so a link to a developer in a tweet or
// a résumé shows that developer and answers 200. The page itself is the same app: the tags say
// who it is for, and the app reads the login from the path.
//
// dist/404.html is the same app for every other path - a developer who is not on the board, a
// campaign landing like /from/linkedin/infra-1 after a reload, a mistyped link. It remembers the
// path it was asked for and sends the visitor to the root, where index.html restores it before
// the app mounts. It answers 404, which is right for a path that names nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAB_PATHS, RESERVED_PATHS } from '../src/utils/route.js';
import { SITE, profileDescription } from '../src/utils/profile.js';

const RESTORE_ID = 'rankistan-path-restore';
const STORE_ID = 'rankistan-path-store';

// GitHub's rule for a login: letters, digits and single hyphens, at most 39 characters.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The pages every build writes: one per tab path, and the 404 fallback. */
export function routeFiles() {
  return [
    ...Object.values(TAB_PATHS)
      .filter((p) => p !== '/')
      .map((p) => `${p.slice(1)}.html`),
    '404.html'
  ];
}

/** Escapes text for an HTML attribute or a text node. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The file name a developer's page is written under.
 *
 * The login as GitHub has it, and the same name in lower case: a link written by hand is often
 * in lower case, and GitHub Pages matches file names exactly. A login that is a tab's own name
 * has no page - the tab is there - and is left out.
 *
 * Only a login GitHub could have given is written: the name becomes a file name, and a row that
 * carried something else is skipped rather than written.
 */
export function profileFileNames(login) {
  const name = String(login ?? '').trim();
  if (!name) return [];
  if (!GITHUB_LOGIN_RE.test(name)) return [];
  if (RESERVED_PATHS.has(name.toLowerCase())) return [];
  const names = [name];
  const lower = name.toLowerCase();
  if (lower !== name) names.push(lower);
  return names.map((file) => `${file}.html`);
}

/** Replaces a meta tag's content, whichever it is. */
function setMeta(html, selector, content) {
  const re = new RegExp(`(<meta ${selector} content=")[^"]*(")`, 'g');
  return html.replace(re, (_match, before, after) => `${before}${content}${after}`);
}

/** The tags a developer's page carries, so a link to it shows that developer. */
export function profileHtml(indexHtml, row, detail) {
  const username = String(row?.username ?? '').trim();
  const name = String(row?.name ?? '').trim() || username;
  const url = `${SITE}/${username}`;
  const title = `${name} (@${username}) | Rankistan`;
  const description = profileDescription(row, detail);
  const image = String(row?.avatar_url ?? '').trim() || `${SITE}/favicon.svg`;

  let html = indexHtml;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = setMeta(html, 'name="description"', escapeHtml(description));
  html = setMeta(html, 'property="og:type"', 'profile');
  html = setMeta(html, 'property="og:url"', escapeHtml(url));
  html = setMeta(html, 'property="og:title"', escapeHtml(title));
  html = setMeta(html, 'property="og:description"', escapeHtml(description));
  html = setMeta(html, 'property="og:image"', escapeHtml(image));
  html = setMeta(html, 'property="twitter:card"', 'summary');
  html = setMeta(html, 'property="twitter:url"', escapeHtml(url));
  html = setMeta(html, 'property="twitter:title"', escapeHtml(title));
  html = setMeta(html, 'property="twitter:description"', escapeHtml(description));
  html = setMeta(html, 'property="twitter:image"', escapeHtml(image));
  html = html.replace(
    /<link rel="canonical" href="[^"]*"/,
    `<link rel="canonical" href="${escapeHtml(url)}"`
  );

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name,
    alternateName: `@${username}`,
    url,
    image,
    description,
    sameAs: [`https://github.com/${username}`]
  };
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n    </script>`
  );

  return html;
}

/**
 * The 404 page: the same app, with the path it was asked for kept aside and the visitor sent to
 * the root, where index.html puts the path back before the app mounts. The app then shows what
 * the path is - a developer who is not on the board, or the leaderboard for anything else.
 */
export function notFoundHtml(indexHtml) {
  // The restore script belongs to the root page; this one stores the path instead.
  const html = indexHtml.replace(
    new RegExp(`<script id="${RESTORE_ID}">[\\s\\S]*?</script>\\s*`, 'g'),
    ''
  );

  const store = `<script id="${STORE_ID}">
      (function () {
        try {
          sessionStorage.setItem('rankistan:path', window.location.pathname);
        } catch (error) {
          /* No storage: the root page is still the right answer. */
        }
        window.location.replace('/');
      })();
    </script>`;

  return html.replace('</head>', `    ${store}\n  </head>`);
}

/** The sitemap: every tab, and every developer's own page. */
export function sitemapXml(rows) {
  const urls = [
    ...Object.entries(TAB_PATHS).map(([, tabPath]) => ({
      loc: `${SITE}${tabPath}`,
      changefreq:
        tabPath === '/' || tabPath === '/map' || tabPath === '/digest' ? 'daily' : 'weekly',
      priority: tabPath === '/' ? '1.0' : '0.7'
    })),
    ...rows.map((row) => ({
      loc: `${SITE}/${row.username}`,
      changefreq: 'daily',
      priority: '0.5'
    }))
  ];

  const body = urls
    .map(
      (url) =>
        `  <url>\n    <loc>${escapeHtml(url.loc)}</loc>\n    <changefreq>${url.changefreq}</changefreq>\n    <priority>${url.priority}</priority>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/**
 * The board the profile pages are written from: dist/board.json, which the split build wrote
 * before this one. A build without it writes the tab pages and nothing else.
 */
function readBoard(outDir) {
  const file = path.join(outDir, 'board.json');
  if (!fs.existsSync(file)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
  } catch {
    return [];
  }
}

/** A developer's own file, for the biography the preview tags carry. */
function readDetail(outDir, login) {
  const file = path.join(outDir, 'dev', `${String(login).toLowerCase()}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.developer ?? null;
  } catch {
    return null;
  }
}

export function buildRoutes({ outDir }) {
  const index = path.join(outDir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`${index} is missing - run \`vite build\` first.`);
  const html = fs.readFileSync(index, 'utf8');
  const written = [];
  for (const name of routeFiles()) {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, name === '404.html' ? notFoundHtml(html) : html);
    written.push(name);
  }

  // One page per developer on the board, so a link to a developer answers 200 and previews.
  const rows = readBoard(outDir);
  const skipped = [];
  const pages = [];
  for (const row of rows) {
    const names = profileFileNames(row?.username);
    if (names.length === 0) {
      skipped.push(String(row?.username ?? ''));
      continue;
    }
    const detail = readDetail(outDir, row.username);
    const page = profileHtml(html, row, detail);
    for (const name of names) {
      fs.writeFileSync(path.join(outDir, name), page);
      written.push(name);
    }
    pages.push({ username: row.username });
  }

  // The sitemap, with the developers' pages in it - and only the pages that were written.
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemapXml(pages));
  written.push('sitemap.xml');

  return { written, profiles: pages.length, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  const outDir = path.resolve(at === -1 ? 'dist' : argv[at + 1]);
  try {
    const result = buildRoutes({ outDir });
    console.log(
      `build-routes: ${result.written.length} files, ${result.profiles} developer pages` +
        (result.skipped.length > 0 ? `, ${result.skipped.length} skipped (a tab's name)` : '')
    );
  } catch (error) {
    console.error(`build-routes: ${error.message}`);
    process.exit(1);
  }
}
