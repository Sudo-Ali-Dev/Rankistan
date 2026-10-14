// After `vite build`: give every tab path a real page, so rankistan.dev/map answers 200.
//
//   node scripts/build-routes.js [--out dist]
//
// GitHub Pages serves dist/map.html for /map, so each tab in src/utils/route.js gets a copy of
// dist/index.html under its own name; the app then reads the tab from the path. A link preview
// (LinkedIn, Slack) of a tab URL therefore gets the page, not a 404. dist/404.html is the same
// page for every other path - a campaign landing like /from/linkedin/infra-1 after a reload -
// so it still opens the leaderboard. Assets are root-absolute (vite.config.js `base: '/'`), so
// one HTML file works at any depth.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAB_PATHS } from '../src/utils/route.js';

export function routeFiles() {
  return [
    ...Object.values(TAB_PATHS)
      .filter((p) => p !== '/')
      .map((p) => `${p.slice(1)}.html`),
    '404.html'
  ];
}

export function buildRoutes({ outDir }) {
  const index = path.join(outDir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`${index} is missing - run \`vite build\` first.`);
  const html = fs.readFileSync(index);
  const written = [];
  for (const name of routeFiles()) {
    fs.writeFileSync(path.join(outDir, name), html);
    written.push(name);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  const outDir = path.resolve(at === -1 ? 'dist' : argv[at + 1]);
  try {
    console.log(`build-routes: ${buildRoutes({ outDir }).join(', ')}`);
  } catch (error) {
    console.error(`build-routes: ${error.message}`);
    process.exit(1);
  }
}
