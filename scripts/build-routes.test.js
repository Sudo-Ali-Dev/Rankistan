import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildRoutes, routeFiles } from './build-routes.js';

describe('buildRoutes', () => {
  it('writes one page per tab path plus the 404 fallback, each the same as index.html', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
    const written = buildRoutes({ outDir: dir });
    expect(written).toEqual(routeFiles());
    expect(written).toEqual(
      expect.arrayContaining(['map.html', 'badge.html', 'register.html', 'about.html', '404.html'])
    );
    expect(written).not.toContain('.html');
    for (const name of written) {
      expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('<html>app</html>');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to run before vite build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    expect(() => buildRoutes({ outDir: dir })).toThrow(/vite build/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
