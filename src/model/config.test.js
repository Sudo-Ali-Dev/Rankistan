import { describe, it, expect } from 'vitest';
import rawConfig from '../../score-config.json' with { type: 'json' };
import {
  validateScoreConfig,
  assertValidatedConfig,
  majorVersion,
  REQUIRED_CONFIG_KEYS,
  ScoreConfigError,
  SCORE_CONFIG,
  MODEL_VERSION
} from './config.js';
import { scoreModel } from './score.js';

const clone = () => JSON.parse(JSON.stringify(rawConfig));

function parentOf(obj, path) {
  const parts = path.split('.');
  const last = parts.pop();
  let node = obj;
  for (const part of parts) node = node[part];
  return [node, last];
}

function without(path) {
  const config = clone();
  const [node, key] = parentOf(config, path);
  delete node[key];
  return config;
}

function withValue(path, value) {
  const config = clone();
  const [node, key] = parentOf(config, path);
  node[key] = value;
  return config;
}

function leafPaths(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' ? leafPaths(value, path) : [path];
  });
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('validateScoreConfig', () => {
  it('accepts the shipped score-config.json', () => {
    expect(() => validateScoreConfig(clone())).not.toThrow();
    expect(MODEL_VERSION).toBe(rawConfig.MODEL_VERSION);
  });

  it('declares every key in score-config.json, and nothing the file lacks', () => {
    // Each leaf of the file is read by the model; a key nobody reads is a key
    // somebody will edit expecting it to do something.
    expect(leafPaths(rawConfig).sort()).toEqual([...REQUIRED_CONFIG_KEYS].sort());
  });

  it.each(REQUIRED_CONFIG_KEYS)('throws, naming the key, when `%s` is deleted', (key) => {
    const error = thrown(() => validateScoreConfig(without(key)));
    expect(error).toBeInstanceOf(ScoreConfigError);
    expect(error.key).toBe(key);
    expect(error.message).toContain(`\`${key}\``);
  });

  it.each([
    ['STAR_WEIGHT', '2'],
    ['STAR_WEIGHT', -1],
    ['STAR_WEIGHT', NaN],
    ['STAR_WEIGHT', Infinity],
    ['STAR_WEIGHT', null],
    ['WEIGHTS.followers', '1'],
    ['WEIGHTS.publicRepos', -0.5],
    ['MAX_STARS_FOR_SCORING', 250.5],
    ['MAX_FOLLOWERS_FOR_SCORING', -1],
    ['MAX_PUBLIC_REPOS_FOR_SCORING', '200'],
    ['SIX_MONTHS_DAYS', 0],
    ['SIX_MONTHS_DAYS', 180.5],
    ['AGE_PENALTY_MULTIPLIER', 0],
    ['AGE_PENALTY_MULTIPLIER', 1.5],
    ['AGE_PENALTY_MULTIPLIER', '0.5'],
    ['ACTIVITY_SCORING.push.base', 0],
    ['ACTIVITY_SCORING.pr.dailyCap', -25],
    ['ACTIVITY_SCORING.push.maxCountedPerDay', 0],
    ['ACTIVITY_SCORING.push.maxCountedPerDay', 2.5],
    ['ACTIVITY_SCORING.release.maxCountedPerDay', '20'],
    ['MODEL_VERSION', '2.0'],
    ['MODEL_VERSION', 'v2.0.0'],
    ['MODEL_VERSION', 2],
    ['MODEL_VERSION_RULE', ' ']
  ])('rejects `%s` = %j, naming the key', (key, value) => {
    const error = thrown(() => validateScoreConfig(withValue(key, value)));
    expect(error).toBeInstanceOf(ScoreConfigError);
    expect(error.key).toBe(key);
    expect(error.message).toContain(`\`${key}\` must be`);
  });

  it.each([
    ['AGE_PENALTY_MULTIPLIER', 1],
    ['ACTIVITY_SCORING.push.maxCountedPerDay', null],
    ['ACTIVITY_SCORING.pr.maxCountedPerDay', 40],
    ['STAR_WEIGHT', 0]
  ])('accepts `%s` = %j', (key, value) => {
    expect(() => validateScoreConfig(withValue(key, value))).not.toThrow();
  });

  it.each([
    // The two keys the old fallbacks read and nothing reads now.
    ['FALLBACK_ACTIVITY_WEIGHT', 3.125],
    ['WEIGHTS.pr', 4],
    ['ACTIVITY_SCORING.push.weight', 2],
    ['ACTIVITY_SCORING.comment', { base: 1, dailyCap: 5, maxCountedPerDay: null }]
  ])('rejects the unknown key `%s`', (key, value) => {
    const error = thrown(() => validateScoreConfig(withValue(key, value)));
    expect(error).toBeInstanceOf(ScoreConfigError);
    expect(error.key).toBe(key);
    expect(error.message).toMatch(/unknown key/);
  });

  it('rejects a section that is not an object', () => {
    const error = thrown(() => validateScoreConfig(withValue('WEIGHTS', 1)));
    expect(error.key).toBe('WEIGHTS.followers');
  });

  it('rejects something that is not a config at all', () => {
    expect(() => validateScoreConfig(null)).toThrow(ScoreConfigError);
    expect(() => validateScoreConfig([])).toThrow(ScoreConfigError);
  });

  it('returns a frozen copy, so a caller cannot edit the model in place', () => {
    expect(Object.isFrozen(SCORE_CONFIG)).toBe(true);
    expect(Object.isFrozen(SCORE_CONFIG.ACTIVITY_SCORING.push)).toBe(true);
    expect(SCORE_CONFIG).not.toBe(rawConfig);
    expect(SCORE_CONFIG).toEqual(rawConfig);
  });
});

describe('assertValidatedConfig', () => {
  const developer = {
    total_stars: 1,
    followers: 1,
    public_repos: 1,
    created_at: '2020-01-01T00:00:00Z',
    raw_events_60d: []
  };

  it('refuses the raw JSON, which is how shadow defaults get started', () => {
    expect(() => assertValidatedConfig(rawConfig)).toThrow(/validateScoreConfig/);
    expect(() => scoreModel(developer, { config: rawConfig, now: Date.now() })).toThrow(
      /validateScoreConfig/
    );
  });

  it('refuses a missing config rather than finding one', () => {
    expect(() => scoreModel(developer, { now: Date.now() })).toThrow(/validateScoreConfig/);
  });

  it('accepts any validated config, so tests can vary the model', () => {
    const varied = validateScoreConfig(withValue('STAR_WEIGHT', 3));
    expect(scoreModel(developer, { config: varied, now: Date.now() }).components.stars.points).toBe(
      3
    );
  });
});

describe('majorVersion', () => {
  it('reads the major part of a model version', () => {
    expect(majorVersion('2.0.0')).toBe(2);
    expect(majorVersion('10.4.1')).toBe(10);
  });

  it('throws on anything that is not a version', () => {
    expect(() => majorVersion(undefined)).toThrow();
    expect(() => majorVersion('2')).toThrow();
  });
});
