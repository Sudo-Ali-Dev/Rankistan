import { describe, it, expect } from 'vitest';
import { scoreDevelopers } from './score.js';
import { stripInternalFields } from './write-leaderboard.js';
import { recomputePublished } from '../src/model/score.js';
import { MODEL_VERSION } from '../src/model/config.js';
import { encodeMeasurement } from '../src/model/measurement.js';
import { measurement, MEASURED_AT } from '../src/model/__fixtures__/measured.js';

const row = (username, options) => ({
  username,
  github_id: 1,
  followers: 999999,
  total_stars: 999999,
  contributions: encodeMeasurement(measurement(username, options))
});

describe('scoreDevelopers', () => {
  it('scores each row from its measurement, and stamps the version and when it was measured', () => {
    const [scored] = scoreDevelopers([row('ana', { days: 20, merges: 2 })]);
    expect(scored).toMatchObject({
      model_version: MODEL_VERSION,
      scored_at: MEASURED_AT,
      gate: true
    });
    expect(Object.keys(scored.score_parts)).toEqual(['work', 'collaboration', 'appreciation']);
    expect(recomputePublished(scored)).toEqual({
      score: scored.score,
      score_exact: scored.score_exact
    });
  });

  it('reads nothing but the measurement: followers and stars change nothing', () => {
    const a = scoreDevelopers([row('ana', { days: 12 })])[0];
    const b = scoreDevelopers([{ ...row('ana', { days: 12 }), followers: 0, total_stars: 0 }])[0];
    expect(b.score_exact).toBe(a.score_exact);
  });

  it('marks a measurement under the gate', () => {
    expect(scoreDevelopers([row('ana', { days: 3 })])[0].gate).toBe(false);
  });

  it('applies the moderation list', () => {
    const plain = scoreDevelopers([row('ana', { days: 30 })])[0];
    const moderated = scoreDevelopers([row('ana', { days: 30 })], {
      moderation: [{ repo: 'ana/app', reason: 'a script' }]
    })[0];
    expect(moderated.score_exact).toBeLessThan(plain.score_exact);
    expect(moderated.gate).toBe(false);
  });

  it('refuses a row with no measurement rather than scoring it as zero', () => {
    expect(() => scoreDevelopers([{ username: 'x' }])).toThrow(/no measurement/);
  });

  it('publishes the parts and the measurement, and not the gate flag', () => {
    const published = stripInternalFields(scoreDevelopers([row('ana', { days: 20 })])[0]);
    expect(published).toHaveProperty('score_parts');
    expect(published).toHaveProperty('contributions');
    expect(published).not.toHaveProperty('gate');
    expect(published).not.toHaveProperty('activity_score');
  });
});
