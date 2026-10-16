import { describe, it, expect } from 'vitest';
import { OUTPUT_FIELDS, stripInternalFields } from './write-leaderboard.js';

describe('stripInternalFields', () => {
  const developer = {
    username: 'dev',
    location: 'Lahore',
    score: 500,
    raw_events_60d: [{ type: 'PushEvent' }],
    following: 3
  };

  it('publishes how discovery found the developer', () => {
    for (const source of ['pakistan', 'city', 'registered']) {
      expect(stripInternalFields({ ...developer, discovery_source: source }).discovery_source).toBe(
        source
      );
    }
  });

  it('publishes the account id, which opt-outs match on', () => {
    expect(stripInternalFields({ ...developer, github_id: 2 }).github_id).toBe(2);
  });

  it('leaves the field off a row measured without one, rather than writing null', () => {
    const json = JSON.parse(JSON.stringify(stripInternalFields(developer)));
    expect(Object.hasOwn(json, 'discovery_source')).toBe(false);
    expect(Object.hasOwn(json, 'raw_events_60d')).toBe(false);
    expect(json.location).toBe('Lahore');
  });

  it('keeps the measurement and the score parts, for the state and for recomputing', () => {
    expect(OUTPUT_FIELDS).toContain('contributions');
    expect(OUTPUT_FIELDS).toContain('score_parts');
    expect(OUTPUT_FIELDS).not.toContain('activity_score');
    expect(OUTPUT_FIELDS).not.toContain('shadow_contributions');
    const block = { v: 2, at: '2026-10-14T00:00:00Z' };
    const parts = { work: 0.5, collaboration: 0, appreciation: 0 };
    const row = stripInternalFields({
      ...developer,
      contributions: block,
      score_parts: parts,
      gate: true
    });
    expect(row.contributions).toEqual(block);
    expect(row.score_parts).toEqual(parts);
    expect(row).not.toHaveProperty('gate');
  });
});
