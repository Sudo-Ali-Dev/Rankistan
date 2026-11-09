// Boots the PRODUCTION BUNDLE in a DOM and asserts the app actually mounts.
//
// Why this exists: on 2026-08-21 the site went down with React error #527
// (react 19.2.8 against react-dom 19.2.4). `npm run build` succeeded and all 42
// tests passed, because nothing in CI ever loaded the app - so a bundle that
// cannot mount looked perfectly green. This closes that gap: it runs the real
// dist/ output, the same file the browser gets, and fails if #root stays empty
// or anything throws during mount.
//
// Deliberately operates on dist/ rather than on source, so it catches problems
// that only appear after bundling: version mismatches, bad chunking, a missing
// asset, or a module that throws at evaluation time.

import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { buildPublicPayload, hasPipelineOnlyFields } from '../src/utils/split-data.js';
import { scoreEvidence } from '../src/model/score.js';

const DIST = path.join(process.cwd(), 'dist');
const failures = [];
const note = (m) => console.log(`  ${m}`);

function fail(m) {
  failures.push(m);
  console.error(`  FAIL: ${m}`);
}

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

// 1. Every local asset the HTML references must exist on disk.
// Root-absolute (vite.config.js `base: '/'`), so the same page works at /map and /from/...
const refs = [...html.matchAll(/(?:src|href)="\.?\/(?!\/)([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (!fs.existsSync(path.join(DIST, ref))) fail(`referenced asset missing from dist/: ${ref}`);
}
note(`checked ${refs.length} local asset references`);

// 1b. Every tab path has its own page (scripts/build-routes.js), identical to index.html.
for (const name of ['map.html', 'badge.html', 'register.html', 'digest.html', 'about.html', 'evolution.html']) {
  const file = path.join(DIST, name);
  if (!fs.existsSync(file)) fail(`dist/${name} missing - did build-routes run?`);
  else if (fs.readFileSync(file, 'utf8') !== html) fail(`dist/${name} differs from dist/index.html`);
}
if (!html.includes('id="analytics-boot"')) fail('dist/index.html lost its analytics boot script');
if (!html.includes('id="rankistan-path-restore"')) fail('dist/index.html lost its path restore script');

// 1c. The 404 page keeps the path it was asked for and sends the visitor to the root, where
//     index.html puts it back. It is not a copy of index.html: it has the store script instead
//     of the restore script.
const notFound = path.join(DIST, '404.html');
if (!fs.existsSync(notFound)) {
  fail('dist/404.html missing - did build-routes run?');
} else {
  const text = fs.readFileSync(notFound, 'utf8');
  if (!text.includes("sessionStorage.setItem('rankistan:path'")) {
    fail('dist/404.html does not keep the path it was asked for');
  }
  if (!text.includes("window.location.replace('/')")) {
    fail('dist/404.html does not send the visitor to the root');
  }
  if (text.includes('rankistan-path-restore')) {
    fail('dist/404.html restores a path as well as keeping one');
  }
}

// 2. React and react-dom must agree. A mismatch is what caused the outage, and
//    it is cheap to assert directly rather than relying on the mount to notice.
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
const reactV = lock.packages?.['node_modules/react']?.version;
const reactDomV = lock.packages?.['node_modules/react-dom']?.version;
if (!reactV || !reactDomV) {
  fail('could not resolve react / react-dom versions from the lockfile');
} else if (reactV !== reactDomV) {
  fail(`react (${reactV}) and react-dom (${reactDomV}) must be the same version - React throws #527 otherwise`);
} else {
  note(`react and react-dom both ${reactV}`);
}
void pkg;

// 2b. The split data files the browser reads, and data.json byte-for-byte as
//     public/data.json holds it: the Worker and outside readers fetch it from
//     the site root.
for (const file of ['board.json', 'digest.json']) {
  if (!fs.existsSync(path.join(DIST, file))) fail(`dist/${file} missing - did build-split-data run?`);
}
const devDir = path.join(DIST, 'dev');
const devFiles = fs.existsSync(devDir) ? fs.readdirSync(devDir).length : 0;
if (devFiles === 0) fail('dist/dev/ has no developer files');

// 2b. Every developer on the board has a page of their own, with their name in it, so a link
//     to them answers 200 and previews them (scripts/build-routes.js).
const boardForPages = JSON.parse(fs.readFileSync(path.join(DIST, 'board.json'), 'utf8'));
const boardRows = Array.isArray(boardForPages?.leaderboard) ? boardForPages.leaderboard : [];
let pageCount = 0;
for (const row of boardRows) {
  const page = path.join(DIST, `${row.username}.html`);
  if (!fs.existsSync(page)) {
    fail(`dist/${row.username}.html missing - a developer on the board has no page`);
    break;
  }
  const text = fs.readFileSync(page, 'utf8');
  if (!text.includes(`https://rankistan.dev/${row.username}`)) {
    fail(`dist/${row.username}.html does not point at its own URL`);
    break;
  }
  if (!text.includes(`(@${row.username})`)) {
    fail(`dist/${row.username}.html does not name the developer`);
    break;
  }
  pageCount += 1;
}
if (pageCount === boardRows.length && boardRows.length > 0) {
  note(`${pageCount} developer pages written, each naming its developer`);
}
const sitemapFile = path.join(DIST, 'sitemap.xml');
if (!fs.existsSync(sitemapFile)) {
  fail('dist/sitemap.xml missing - did build-routes run?');
} else if (!fs.readFileSync(sitemapFile, 'utf8').includes('https://rankistan.dev/')) {
  fail('dist/sitemap.xml does not list the site');
}

// 2c. Every developer file's published evidence gives its published score, bit for bit: the
//     evidence is what a reader checks a score against, so it must be the evidence it came from.
let withEvidence = 0;
for (const name of fs.existsSync(devDir) ? fs.readdirSync(devDir) : []) {
  const { developer } = JSON.parse(fs.readFileSync(path.join(devDir, name), 'utf8'));
  if (!developer?.score_evidence) continue;
  withEvidence += 1;
  const again = scoreEvidence(developer.score_evidence);
  if (again.score_exact !== developer.score_exact || again.score !== developer.score) {
    fail(`dist/dev/${name}: its evidence scores ${again.score_exact}, the file says ${developer.score_exact}`);
  }
}
note(`${withEvidence} of ${devFiles} developer files carry evidence that recomputes their score exactly`);
const source = path.join(process.cwd(), 'public', 'data.json');
const published = path.join(DIST, 'data.json');
if (!fs.existsSync(published)) {
  fail('dist/data.json missing - the Worker reads it from the site root');
} else if (fs.existsSync(source)) {
  // The served copy is the state without its pipeline-only fields (split-data.js), and the state
  // itself when no row has any.
  const sourceBytes = fs.readFileSync(source);
  const payload = JSON.parse(sourceBytes.toString('utf8'));
  const expected = hasPipelineOnlyFields(payload)
    ? Buffer.from(JSON.stringify(buildPublicPayload(payload)))
    : sourceBytes;
  if (!expected.equals(fs.readFileSync(published))) {
    fail('dist/data.json is not public/data.json without its pipeline-only fields');
  } else {
    note(
      `board.json, digest.json and ${devFiles} developer files present; data.json ` +
        (expected === sourceBytes ? 'unchanged' : `${sourceBytes.length - expected.length} bytes of pipeline-only fields left out`)
    );
  }
} else {
  note(`board.json, digest.json and ${devFiles} developer files present`);
}

// 3. Boot the real bundle and assert it mounts.
const entry = refs.find((r) => r.endsWith('.js'));
if (!entry) {
  fail('no JS entry found in dist/index.html');
} else {
  const code = fs.readFileSync(path.join(DIST, entry), 'utf8');
  const window = new Window({ url: 'https://rankistan.dev/' });
  const { document } = window;

  const consoleErrors = [];
  window.console.error = (...args) => consoleErrors.push(args.join(' '));

  document.body.innerHTML = '<div id="root"></div>';

  // Serve dist/ itself, as Pages does, so the render path is the production
  // one (board.json, not the data.json fallback) rather than an error branch.
  const requested = [];
  window.fetch = async (url) => {
    const rel = decodeURIComponent(new URL(String(url), 'https://rankistan.dev/').pathname).replace(/^\/+/, '');
    requested.push(rel);
    const file = path.join(DIST, rel);
    if (rel && file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const text = fs.readFileSync(file, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  let threw = null;
  try {
    window.eval(code);
  } catch (error) {
    threw = error;
  }

  await new Promise((resolve) => setTimeout(resolve, 600));

  const root = document.getElementById('root');
  const rendered = (root?.innerHTML || '').trim();

  if (threw) {
    fail(`bundle threw while evaluating: ${threw.message}`);
  } else if (!rendered) {
    fail('#root is empty after mount - the app did not render (this is the outage signature)');
  } else {
    note(`app mounted, #root contains ${rendered.length} chars of markup`);
  }

  // The point of the split: the first screen must not download the 1.65 MB file.
  if (!requested.includes('board.json')) {
    fail(`the leaderboard did not request board.json (requested: ${requested.join(', ') || 'nothing'})`);
  } else if (requested.includes('data.json')) {
    fail('the first mount downloaded data.json; it should read board.json');
  } else {
    const board = JSON.parse(fs.readFileSync(path.join(DIST, 'board.json'), 'utf8'));
    const first = board.leaderboard?.[0]?.username;
    if (first && !rendered.includes(first)) fail(`board.json loaded but its first row (${first}) did not render`);
    else note(`first mount read board.json only, and rendered its rows`);
  }

  const fatal = consoleErrors.filter((e) => /Minified React error|Invalid hook|Cannot read/i.test(e));
  for (const e of fatal) fail(`console error during mount: ${e.slice(0, 200)}`);

  await window.happyDOM?.close?.();
}

if (failures.length > 0) {
  console.error(`\nsmoke test FAILED with ${failures.length} problem(s).`);
  process.exit(1);
}
console.log('\nBuild smoke test passed: the production bundle mounts.');
