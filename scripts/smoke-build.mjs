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
const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (!fs.existsSync(path.join(DIST, ref))) fail(`referenced asset missing from dist/: ${ref}`);
}
note(`checked ${refs.length} local asset references`);

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

  // The app fetches data.json on mount; serve the real file so the render path
  // is the production one rather than an error branch.
  const dataPath = path.join(DIST, 'data.json');
  const dataJson = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, 'utf8') : '{"leaderboard":[]}';
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('data.json')) {
      return { ok: true, status: 200, json: async () => JSON.parse(dataJson), text: async () => dataJson };
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

  const fatal = consoleErrors.filter((e) => /Minified React error|Invalid hook|Cannot read/i.test(e));
  for (const e of fatal) fail(`console error during mount: ${e.slice(0, 200)}`);

  await window.happyDOM?.close?.();
}

if (failures.length > 0) {
  console.error(`\nsmoke test FAILED with ${failures.length} problem(s).`);
  process.exit(1);
}
console.log('\nBuild smoke test passed: the production bundle mounts.');
