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

  it('keeps the shadow measurement and the events window, for the state and the next model', () => {
    expect(OUTPUT_FIELDS).toContain('shadow_contributions');
    expect(OUTPUT_FIELDS).toContain('events_window');
    const block = { v: 1, at: '2026-10-14T00:00:00Z', t30: [1, 0, 0, 0, 0, 1, 0] };
    const events = { fetched: 200, truncated: true, days: 6.1 };
    const row = stripInternalFields({
      ...developer,
      shadow_contributions: block,
      events_window: events
    });
    expect(row.shadow_contributions).toEqual(block);
    expect(row.events_window).toEqual(events);
  });
});
