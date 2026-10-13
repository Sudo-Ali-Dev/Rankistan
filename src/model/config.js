/**
 * The scoring configuration, validated once, for every caller.
 *
 * Before this module the formula read score-config.json from two places, and
 * one of them carried a shadow copy of every value as a `??` default
 * (`config.STAR_WEIGHT ?? 2`). Deleting a key from the file therefore did two
 * different things: the pipeline multiplied by `undefined` and scored NaN,
 * which it then wrote as 0, while the Register preview kept using 2. Neither
 * said anything.
 *
 * So the model reads no key that is not declared below, and a missing or
 * malformed key is an exception that names it. There is no fallback value
 * anywhere in src/model/: a config the model cannot read is a build that does
 * not start, which CI sees, rather than a board that is silently wrong.
 *
 * Pure ESM with no Node-only imports: the pipeline and the Vite bundle both
 * load this file.
 */
import rawConfig from '../../score-config.json' with { type: 'json' };

/**
 * `MODEL_VERSION` is semver over *published output*, and it is stamped on
 * every row the pipeline scores:
 *
 *   major - any developer's score can change (a weight, a cap, the curve).
 *   minor - published fields or the ordering change; every score is unchanged.
 *   patch - no published output changes at all.
 *
 * The same rule is written beside the version in score-config.json, as
 * `MODEL_VERSION_RULE`, so it is in front of whoever edits a number there.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const ACTIVITY_TYPES = Object.freeze(['push', 'issue', 'pr', 'release']);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNegative = (v) => isFiniteNumber(v) && v >= 0;
const positive = (v) => isFiniteNumber(v) && v > 0;
const nonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;

/**
 * Every key the model reads, and what it must hold. Order is the order errors
 * are reported in.
 */
const RULES = [
  ['MODEL_VERSION', (v) => typeof v === 'string' && SEMVER.test(v), 'a semver string like "2.0.0"'],
  ['MODEL_VERSION_RULE', (v) => typeof v === 'string' && v.trim() !== '', 'a non-empty string'],
  ['STAR_WEIGHT', nonNegative, 'a finite number >= 0'],
  ['WEIGHTS.followers', nonNegative, 'a finite number >= 0'],
  ['WEIGHTS.publicRepos', nonNegative, 'a finite number >= 0'],
  ['MAX_STARS_FOR_SCORING', nonNegativeInteger, 'an integer >= 0'],
  ['MAX_FOLLOWERS_FOR_SCORING', nonNegativeInteger, 'an integer >= 0'],
  ['MAX_PUBLIC_REPOS_FOR_SCORING', nonNegativeInteger, 'an integer >= 0'],
  ['SIX_MONTHS_DAYS', positiveInteger, 'an integer number of days > 0'],
  [
    'AGE_PENALTY_MULTIPLIER',
    (v) => isFiniteNumber(v) && v > 0 && v <= 1,
    'a finite number in (0, 1]'
  ],
  ...ACTIVITY_TYPES.flatMap((type) => [
    [`ACTIVITY_SCORING.${type}.base`, positive, 'a finite number > 0'],
    [`ACTIVITY_SCORING.${type}.dailyCap`, positive, 'a finite number > 0'],
    // Explicitly null rather than absent, so that deleting push's limit is an
    // error and not a quiet switch to "count every push".
    [
      `ACTIVITY_SCORING.${type}.maxCountedPerDay`,
      (v) => v === null || positiveInteger(v),
      'null (no per-day limit) or an integer > 0'
    ]
  ])
];

/** Every key path the model requires, in report order. */
export const REQUIRED_CONFIG_KEYS = Object.freeze(RULES.map(([key]) => key));

// Every path that must be an object because a required key sits beneath it.
const CONTAINERS = new Set(
  REQUIRED_CONFIG_KEYS.flatMap((key) => {
    const parts = key.split('.');
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.'));
  })
);
const KNOWN = new Set([...REQUIRED_CONFIG_KEYS, ...CONTAINERS]);

export class ScoreConfigError extends Error {
  constructor(key, message) {
    super(`score-config.json: ${message}`);
    this.name = 'ScoreConfigError';
    this.key = key;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function describe(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

// A key nobody reads is a key somebody will edit expecting it to do
// something. `WEIGHTS.pr` survived for months after ACTIVITY_SCORING replaced
// it, and changing it did nothing.
function rejectUnknownKeys(obj, prefix) {
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!KNOWN.has(path)) {
      throw new ScoreConfigError(
        path,
        `unknown key \`${path}\`; the scoring model does not read it`
      );
    }
    if (CONTAINERS.has(path)) {
      if (!isPlainObject(obj[key])) {
        throw new ScoreConfigError(
          path,
          `\`${path}\` must be an object, got ${describe(obj[key])}`
        );
      }
      rejectUnknownKeys(obj[key], path);
    }
  }
}

function lookup(config, key) {
  let node = config;
  for (const part of key.split('.')) {
    if (!isPlainObject(node) || !own(node, part)) {
      throw new ScoreConfigError(key, `missing required key \`${key}\``);
    }
    node = node[part];
  }
  return node;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const validated = new WeakSet();

/**
 * Returns a frozen, validated copy of `config`, or throws a ScoreConfigError
 * naming the first key that is missing, malformed or unknown.
 */
export function validateScoreConfig(config) {
  if (!isPlainObject(config)) {
    throw new ScoreConfigError('', `expected an object, got ${describe(config)}`);
  }

  for (const [key, check, expected] of RULES) {
    const value = lookup(config, key);
    if (!check(value)) {
      throw new ScoreConfigError(key, `\`${key}\` must be ${expected}, got ${describe(value)}`);
    }
  }

  rejectUnknownKeys(config, '');

  const copy = deepFreeze(JSON.parse(JSON.stringify(config)));
  validated.add(copy);
  return copy;
}

/**
 * The model takes its config as an argument so tests can vary it, but only a
 * config that has been through validateScoreConfig. Validating on every call
 * would be cheap; letting an unvalidated object through even once is how the
 * `??` defaults got started.
 */
export function assertValidatedConfig(config) {
  if (!validated.has(config)) {
    throw new TypeError(
      'scoring model: config must come from validateScoreConfig(); pass SCORE_CONFIG'
    );
  }
  return config;
}

export function majorVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new TypeError(`not a model version: ${describe(version)}`);
  }
  return Number(version.split('.')[0]);
}

/** The configuration every caller scores with. */
export const SCORE_CONFIG = validateScoreConfig(rawConfig);

export const MODEL_VERSION = SCORE_CONFIG.MODEL_VERSION;
