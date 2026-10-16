import { describe, expect, it } from 'vitest';
import { SCORE_CONFIG } from '../model/config.js';
import { scoreModel } from '../model/score.js';
import { encodeMeasurement } from '../model/measurement.js';
import {
  SCORE_EXAMPLE,
  SCORE_PARTS,
  exampleMeasurement,
  pointsForCredits,
  pointsForStars,
  workPointsForDays
} from './score-explainer.js';

describe('the score explained on the site', () => {
  it('shows an example whose parts add up to the score the model gives it', () => {
    const sum = SCORE_EXAMPLE.rows.reduce((total, row) => total + row.points, 0);
    expect(sum).toBe(SCORE_EXAMPLE.score);
    expect(scoreModel(encodeMeasurement(exampleMeasurement())).score).toBe(SCORE_EXAMPLE.score);
  });

  it('gives every part its maximum at the top of its table', () => {
    const max = (id) => SCORE_CONFIG.SCALE * SCORE_CONFIG.WEIGHTS[id];
    expect(workPointsForDays(SCORE_CONFIG.WINDOW_DAYS)).toBe(max('work'));
    expect(pointsForCredits(SCORE_CONFIG.COLLABORATION.HALF_POINT)).toBe(max('collaboration') / 2);
    expect(pointsForStars(SCORE_CONFIG.APPRECIATION.FROM_STARS)).toBe(0);
    expect(Math.round(pointsForStars(10000))).toBe(max('appreciation'));
    for (const part of SCORE_PARTS) {
      expect(part.table.rows.every((cells) => cells.length === part.table.head.length)).toBe(true);
    }
  });
});
