import { describe, it, expect } from 'vitest';
import { contributionsGate, GATE_MIN_DAYS, SCREEN_MIN_DAYS } from './gate.js';
import { createMeasurementClient } from './contributions.js';
import { NOW, fakeGitHub, person } from './fake-contributions.js';

const quiet = { log() {}, warn() {} };
const days = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [29 - i, 1]));

function setup(people) {
  const fake = fakeGitHub(people);
  const client = createMeasurementClient({
    token: 't',
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    minIntervalMs: 0,
    log: quiet
  });
  return { fake, client };
}

describe('contributionsGate', () => {
  it('screens on the calendar, measures who could pass, and gates on working days', async () => {
    const people = {
      busy: {
        ...person('busy', { id: 1, commits: { 'busy/app': days(10) } }),
        calendar: [1, 1, 1, 1]
      },
      thin: { ...person('thin', { id: 2, commits: { 'thin/app': days(2) } }), calendar: [1, 1, 0] },
      idle: {
        ...person('idle', { id: 3, commits: {} }),
        calendar: [0, 0, SCREEN_MIN_DAYS > 1 ? 1 : 0]
      }
    };
    const { fake, client } = setup(people);
    const result = await contributionsGate(
      [
        { id: 1, login: 'busy' },
        { id: 2, login: 'thin' },
        { id: 3, login: 'idle' }
      ],
      { client, now: NOW, log: quiet }
    );
    expect([...result.passed.keys()]).toEqual(['busy']);
    // idle: under the calendar screen. thin: measured, short after the first phase.
    expect(result.screenedOut.sort()).toEqual(['idle', 'thin']);
    expect(result.complete).toBe(true);
    // Nobody short of the gate was searched.
    const searched = fake.calls
      .filter((c) => c.kind === 'search')
      .flatMap((c) => Object.values(c.variables));
    expect(searched.some((q) => q.includes('thin') || q.includes('idle'))).toBe(false);
    expect(GATE_MIN_DAYS).toBe(4);
  });

  it('always measures a developer already on the board, whatever their calendar says', async () => {
    const people = {
      quiet: { ...person('quiet', { id: 7, commits: { 'quiet/app': days(6) } }), calendar: [0] }
    };
    const { client } = setup(people);
    const result = await contributionsGate([{ id: 7, login: 'quiet' }], {
      client,
      now: NOW,
      bypass: new Set([7]),
      log: quiet
    });
    expect([...result.passed.keys()]).toEqual(['quiet']);
  });

  it('applies the moderation list to the gate', async () => {
    const people = {
      ana: { ...person('ana', { id: 1, commits: { 'ana/app': days(10) } }), calendar: [1, 1] }
    };
    const { client } = setup(people);
    const result = await contributionsGate([{ id: 1, login: 'ana' }], {
      client,
      now: NOW,
      moderation: [{ repo: 'ana/app', reason: 'a script commits here' }],
      log: quiet
    });
    expect(result.passed.size).toBe(0);
    expect(result.screenedOut).toEqual(['ana']);
  });

  it('calls a run incomplete when too many measurements fail, so misses freeze', async () => {
    const { client } = setup({});
    const result = await contributionsGate([{ id: 9, login: 'gone' }], {
      client,
      now: NOW,
      bypass: new Set([9]),
      log: quiet
    });
    expect(result.passed.size).toBe(0);
    expect(result.failed.get('gone')).toBe('not found');
    expect(result.complete).toBe(false);
  });
});
