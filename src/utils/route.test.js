import { describe, it, expect } from 'vitest';
import { TAB_PATHS, TABS, tabFromPath, pathForTab } from './route.js';

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
