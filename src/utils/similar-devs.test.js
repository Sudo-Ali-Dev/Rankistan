import { describe, it, expect } from 'vitest';
import { similarDevelopers } from './similar-devs.js';

const rows = [
  { username: 'ayesha', rank: 10, tags: ['Web', 'AI/ML'] },
  { username: 'bilal', rank: 3, tags: ['Web'] },
  { username: 'ayesha2', rank: 20, tags: ['Web', 'AI/ML', 'DevOps'] },
  { username: 'daniyal', rank: 5, tags: ['AI/ML', 'Security'] },
  { username: 'eve', rank: 30, tags: ['Mobile'] },
  { username: 'faisal', rank: 40, tags: [] }
];

describe('similarDevelopers', () => {
  it('ranks the neighbours by the tags they share', () => {
    const similar = similarDevelopers(rows, 'ayesha');
    expect(similar.map((entry) => entry.dev.username)).toEqual(['ayesha2', 'bilal', 'daniyal']);
    expect(similar[0].shared).toEqual(['Web', 'AI/ML']);
  });

  it('leaves out the developer themselves and anyone who shares nothing', () => {
    const similar = similarDevelopers(rows, 'ayesha');
    expect(similar.some((entry) => entry.dev.username === 'ayesha')).toBe(false);
    expect(similar.some((entry) => entry.dev.username === 'eve')).toBe(false);
    expect(similar.some((entry) => entry.dev.username === 'faisal')).toBe(false);
  });

  it('breaks a tie on shared tags by rank', () => {
    const similar = similarDevelopers(rows, 'ayesha');
    const daniyal = similar.find((entry) => entry.dev.username === 'daniyal');
    const bilal = similar.find((entry) => entry.dev.username === 'bilal');
    expect(daniyal.shared.length).toBe(1);
    expect(bilal.shared.length).toBe(1);
    // The same number of shared tags: the higher rank comes first.
    expect(similar.indexOf(bilal)).toBeLessThan(similar.indexOf(daniyal));
  });

  it('takes as many as asked for, and no more', () => {
    expect(similarDevelopers(rows, 'ayesha', { limit: 2 })).toHaveLength(2);
    expect(similarDevelopers(rows, 'ayesha', { limit: 0 })).toHaveLength(0);
  });

  it('names nobody for a developer who is not on the board', () => {
    expect(similarDevelopers(rows, 'nobody')).toEqual([]);
    expect(similarDevelopers(rows, '')).toEqual([]);
    expect(similarDevelopers(null, 'ayesha')).toEqual([]);
  });
});
