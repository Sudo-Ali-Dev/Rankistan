import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildRoutes,
  routeFiles,
  profileFileNames,
  profileHtml,
  notFoundHtml,
  sitemapXml
} from './build-routes.js';
import { profileDescription } from '../src/utils/profile.js';

describe('buildRoutes', () => {
  it('writes one page per tab path plus the 404 fallback, each the same as index.html', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
    const result = buildRoutes({ outDir: dir });
    expect(result.written).toEqual(expect.arrayContaining(routeFiles()));
    expect(result.written).toEqual(
      expect.arrayContaining(['map.html', 'badge.html', 'register.html', 'about.html', '404.html'])
    );
    expect(result.written).not.toContain('.html');
    for (const name of routeFiles()) {
      if (name === '404.html') continue;
      expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('<html>app</html>');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to run before vite build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    expect(() => buildRoutes({ outDir: dir })).toThrow(/vite build/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a page per developer on the board, and the sitemap that lists them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
    fs.mkdirSync(path.join(dir, 'dev'));
    fs.writeFileSync(
      path.join(dir, 'board.json'),
      JSON.stringify({
        leaderboard: [
          {
            username: 'ayesha',
            name: 'Ayesha',
            rank: 1,
            score: 500,
            avatar_url: 'https://a/a.png'
          },
          { username: 'Bilal', name: 'Bilal', rank: 2, score: 400 }
        ]
      })
    );
    fs.writeFileSync(
      path.join(dir, 'dev', 'ayesha.json'),
      JSON.stringify({ developer: { username: 'ayesha', bio: 'Builds things.' } })
    );

    const result = buildRoutes({ outDir: dir });
    expect(result.profiles).toBe(2);
    expect(fs.existsSync(path.join(dir, 'ayesha.html'))).toBe(true);
    // The lower-case name too: a link written by hand is often in lower case.
    expect(fs.existsSync(path.join(dir, 'bilal.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'Bilal.html'))).toBe(true);

    const sitemap = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('https://rankistan.dev/ayesha');
    expect(sitemap).toContain('https://rankistan.dev/map');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('profileFileNames', () => {
  it('writes the login as GitHub has it, and the same in lower case', () => {
    expect(profileFileNames('ayesha')).toEqual(['ayesha.html']);
    expect(profileFileNames('Ali-Dev')).toEqual(['Ali-Dev.html', 'ali-dev.html']);
  });

  it('leaves out a login that is a tab’s own name, because the tab is there', () => {
    expect(profileFileNames('map')).toEqual([]);
    expect(profileFileNames('MAP')).toEqual([]);
    expect(profileFileNames('about')).toEqual([]);
  });

  it('writes nothing for a name GitHub could not have given', () => {
    // The name becomes a file name: a row that carried something else is skipped, not written.
    expect(profileFileNames('../../etc/passwd')).toEqual([]);
    expect(profileFileNames('a b')).toEqual([]);
    expect(profileFileNames('a/b')).toEqual([]);
    expect(profileFileNames('-ali')).toEqual([]);
    expect(profileFileNames('a'.repeat(40))).toEqual([]);
  });
});

describe('profileDescription', () => {
  it('says what the board knows about the developer', () => {
    const text = profileDescription(
      {
        username: 'ayesha',
        rank: 3,
        score: 431,
        followers: 70,
        public_repos: 22,
        total_stars: 359,
        events_30d: 52
      },
      null
    );
    expect(text).toContain('Rank #3');
    expect(text).toContain('431 points');
    expect(text).toContain('70 followers');
  });

  it('leads with the biography when there is one', () => {
    const text = profileDescription(
      { username: 'ayesha', rank: 1, score: 500 },
      { bio: 'Builds things.' }
    );
    expect(text.startsWith('Builds things.')).toBe(true);
  });
});

describe('profileHtml', () => {
  const index = `<html><head>
    <meta name="description" content="the site" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://rankistan.dev/" />
    <meta property="og:title" content="Rankistan" />
    <meta property="og:image" content="https://rankistan.dev/favicon.svg" />
    <link rel="canonical" href="https://rankistan.dev/" />
    <title>Rankistan | Leaderboard</title>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
  </head><body></body></html>`;

  it('names the developer in the title, the preview tags and the canonical link', () => {
    const html = profileHtml(
      index,
      { username: 'ayesha', name: 'Ayesha Khan', rank: 3, score: 431 },
      null
    );
    expect(html).toContain('<title>Ayesha Khan (@ayesha) | Rankistan</title>');
    expect(html).toContain('content="profile"');
    expect(html).toContain('content="https://rankistan.dev/ayesha"');
    expect(html).toContain('<link rel="canonical" href="https://rankistan.dev/ayesha"');
    expect(html).not.toContain('content="Rankistan"');
  });

  it('describes the developer as a person', () => {
    const html = profileHtml(
      index,
      { username: 'ayesha', name: 'Ayesha Khan' },
      { bio: 'Builds things.' }
    );
    expect(html).toContain('"@type": "Person"');
    expect(html).toContain('https://github.com/ayesha');
    expect(html).toContain('Builds things.');
  });
});

describe('notFoundHtml', () => {
  it('keeps the path and sends the visitor to the root', () => {
    const index = `<html><head><script id="rankistan-path-restore">var x = 1;</script></head><body></body></html>`;
    const html = notFoundHtml(index);
    expect(html).toContain("sessionStorage.setItem('rankistan:path'");
    expect(html).toContain("window.location.replace('/')");
    // The restore script belongs to the root page, not to this one.
    expect(html).not.toContain('rankistan-path-restore');
  });
});

describe('sitemapXml', () => {
  it('lists every tab and every developer', () => {
    const xml = sitemapXml([{ username: 'ayesha' }]);
    expect(xml).toContain('<loc>https://rankistan.dev/</loc>');
    expect(xml).toContain('<loc>https://rankistan.dev/ayesha</loc>');
    expect(xml.startsWith('<?xml')).toBe(true);
  });
});
