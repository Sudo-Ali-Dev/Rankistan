import { describe, it, expect } from 'vitest';
import {
  TAB_PATHS,
  TABS,
  RESERVED_PATHS,
  tabFromPath,
  pathForTab,
  loginFromHash,
  usernameFromPath,
  isReservedPath
} from './route.js';

describe('route', () => {
  it('maps every tab to its path and back', () => {
    for (const tab of TABS) expect(tabFromPath(pathForTab(tab))).toBe(tab);
    expect(pathForTab('leaderboard')).toBe('/');
  });

  it('ignores trailing slashes and case', () => {
    expect(tabFromPath('/map/')).toBe('map');
    expect(tabFromPath('/About')).toBe('about');
    expect(tabFromPath('')).toBe('leaderboard');
  });

  it('names no tab for a campaign landing or any other path', () => {
    expect(tabFromPath('/from/linkedin/infra-1')).toBeNull();
    expect(tabFromPath('/nope')).toBeNull();
  });

  it('sends an unknown tab to the leaderboard', () => {
    expect(pathForTab('nope')).toBe('/');
  });

  it('gives every tab a distinct path', () => {
    expect(new Set(Object.values(TAB_PATHS)).size).toBe(TABS.length);
  });
});

describe('loginFromHash', () => {
  it('reads a developer from the badge link, and nothing that is not a GitHub login', () => {
    expect(loginFromHash('#Ali-Dev')).toBe('Ali-Dev');
    expect(loginFromHash('#a')).toBe('a');
    expect(loginFromHash('#a'.padEnd(40, 'b'))).toBe('a'.padEnd(39, 'b'));
    expect(loginFromHash('#a'.padEnd(41, 'b'))).toBeNull();
    for (const hash of [
      '',
      '#',
      '#-ali',
      '#ali-',
      '#al--i',
      '#a/b',
      '#digest/archive',
      '#%E0%A4%A',
      '#a b'
    ]) {
      expect(loginFromHash(hash)).toBeNull();
    }
  });
});

describe('usernameFromPath', () => {
  it('reads a developer from their own page', () => {
    expect(usernameFromPath('/ahmershahdev')).toBe('ahmershahdev');
    expect(usernameFromPath('/Ali-Dev')).toBe('Ali-Dev');
    expect(usernameFromPath('/ahmershahdev/')).toBe('ahmershahdev');
    expect(usernameFromPath('/a')).toBe('a');
  });

  it('names no developer for a tab path, a campaign landing or a path that is not a login', () => {
    for (const path of [
      '/',
      '/map',
      '/MAP',
      '/badge',
      '/register',
      '/digest',
      '/about',
      '/evolution',
      '/from/linkedin/infra-1',
      '/a/b',
      '/a/b/c',
      '/-ali',
      '/ali-',
      '/al--i',
      '/a b',
      '/a.b',
      '/index.html',
      '/404.html'
    ]) {
      expect(usernameFromPath(path)).toBeNull();
    }
  });

  it('reads a login that arrived percent-encoded', () => {
    expect(usernameFromPath('/Ali%2DDev')).toBe('Ali-Dev');
    expect(usernameFromPath('/%E0%A4%A')).toBeNull();
  });

  it('keeps every tab path out of the developers’ names', () => {
    for (const path of Object.values(TAB_PATHS)) {
      if (path === '/') continue;
      expect(usernameFromPath(path)).toBeNull();
      expect(isReservedPath(path)).toBe(true);
      expect(RESERVED_PATHS.has(path.slice(1).toLowerCase())).toBe(true);
    }
  });
});
