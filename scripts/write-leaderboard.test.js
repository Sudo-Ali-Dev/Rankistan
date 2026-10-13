import { describe, it, expect } from 'vitest';
import { stripInternalFields } from './write-leaderboard.js';

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

  it('leaves the field off a row measured without one, rather than writing null', () => {
    const json = JSON.parse(JSON.stringify(stripInternalFields(developer)));
    expect(Object.hasOwn(json, 'discovery_source')).toBe(false);
    expect(Object.hasOwn(json, 'raw_events_60d')).toBe(false);
    expect(json.location).toBe('Lahore');
  });
});
