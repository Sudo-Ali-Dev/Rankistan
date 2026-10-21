import { describe, it, expect } from 'vitest';
import { scoreBreakdown, breakdownTotal, pointsForPart } from './score-breakdown.js';
import { SCORE_CONFIG } from '../model/config.js';
import { decodeMeasurement } from '../model/measurement.js';
import { deriveEvidence } from '../model/evidence.js';
import { measuredRow } from '../model/__fixtures__/measured.js';

const { SCALE, WEIGHTS } = SCORE_CONFIG;

/** A published row with the evidence the breakdown reads. */
function row(options = {}) {
  const published = measuredRow('ayesha', { days: 10, merges: 2, stars: 500, ...options });
  const evidence = deriveEvidence(decodeMeasurement(published.contributions), {
    config: SCORE_CONFIG,
    moderation: []
  });
  return { ...published, score_evidence: evidence };
}

describe('scoreBreakdown', () => {
  it('shows the three parts the model scores, with their maximums', () => {
    const parts = scoreBreakdown(row());
    expect(parts.map((part) => part.id)).toEqual(['work', 'collaboration', 'appreciation']);
    expect(parts.map((part) => part.max)).toEqual([
      SCALE * WEIGHTS.work,
      SCALE * WEIGHTS.collaboration,
      SCALE * WEIGHTS.appreciation
    ]);
  });

  it('adds up to the score the board publishes', () => {
    const published = row();
    const parts = scoreBreakdown(published);
    const total = breakdownTotal(published);
    const sum = parts.reduce((acc, part) => acc + part.points, 0);
    expect(total.points).toBeCloseTo(published.score_exact, 1);
    expect(sum).toBeCloseTo(published.score_exact, 6);
  });

  it('counts no points for followers, repositories or account age, which give none', () => {
    const parts = scoreBreakdown(row());
    const labels = parts
      .map((part) => part.label)
      .join(' ')
      .toLowerCase();
    for (const word of ['follower', 'repositor', 'age']) {
      expect(labels).not.toContain(word);
    }
    // The only stars in the breakdown are the ones the model scores.
    expect(parts.length).toBe(3);
  });

  it('says what was found under each part', () => {
    const parts = scoreBreakdown(row());
    expect(parts[0].detail).toMatch(/Active on 10 of the last 30 days/);
    expect(parts[1].detail).toMatch(/merged into open source projects/);
    expect(parts[2].detail).toMatch(/stars/);
  });

  it('gives no breakdown for a row without parts', () => {
    expect(scoreBreakdown({ username: 'nobody' })).toEqual([]);
    expect(breakdownTotal({ username: 'nobody' })).toBeNull();
  });

  it('reads a part of zero as zero points, not as nothing', () => {
    expect(pointsForPart({ work: 0 }, 'work')).toBe(0);
  });
});
