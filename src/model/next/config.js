/**
 * Scoring v3's configuration, validated once, for every caller.
 *
 * Built beside the live model (src/model/config.js) and read by nothing that publishes a score
 * until the switch. The rules are the live model's: the model reads no key that is not declared
 * below, a missing, malformed or unknown key is an exception that names it, and there is no
 * fallback value anywhere. Two rules are new:
 *
 *   - every constant carries its reason in DERIVATIONS, keyed by its path, and a constant without
 *     one is an error. A number nobody can explain is a number nobody can defend, or safely
 *     change.
 *   - cross-checks: the weights sum to 1, the window is the measurement's window, the gate fits
 *     in the window.
 *
 * Pure ESM with no Node-only imports: the pipeline, the Vite bundle and the Worker load it.
 */
import rawConfig from '../../../score-config.next.json' with { type: 'json' };
import { WINDOW_DAYS as MEASURED_WINDOW_DAYS } from '../measurement.js';

const FILE = 'score-config.next.json';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => isFiniteNumber(v) && v > 0;
const unit = (v) => isFiniteNumber(v) && v >= 0 && v <= 1;
const openUnit = (v) => isFiniteNumber(v) && v > 0 && v <= 1;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;
const text = (v) => typeof v === 'string' && v.trim() !== '';

export const PART_IDS = Object.freeze(['work', 'collaboration', 'appreciation']);

/** Every number the model reads, and what it must hold. Order is the order errors are reported. */
const NUMBERS = [
  ['SCALE', positiveInteger, 'an integer > 0'],
  ...PART_IDS.map((id) => [`WEIGHTS.${id}`, unit, 'a number in [0, 1]']),
  ['WINDOW_DAYS', positiveInteger, 'an integer number of days > 0'],
  ['RECENCY_FLOOR', openUnit, 'a number in (0, 1]'],
  ['WORK.CURVE_POWER', (v) => isFiniteNumber(v) && v >= 1, 'a number >= 1'],
  ['WORK.GATE_MIN_DAYS', positiveInteger, 'an integer number of days > 0'],
  ['COLLABORATION.HALF_POINT', positive, 'a number > 0'],
  ['COLLABORATION.CAP_PER_GROUP', positive, 'a number > 0'],
  ['COLLABORATION.REVIEW_WEIGHT', unit, 'a number in [0, 1]'],
  ['COLLABORATION.MAINTAINED_WEIGHT', unit, 'a number in [0, 1]'],
  [
    'COLLABORATION.COUNTERPARTY_MIN_AGE_DAYS',
    (v) => Number.isInteger(v) && v >= 0,
    'an integer >= 0'
  ],
  ['COLLABORATION.REJECTION_PRIOR', positive, 'a number > 0'],
  ['COLLABORATION.STARS_FLOOR', unit, 'a number in [0, 1]'],
  ['COLLABORATION.STARS_PER_DIGIT', positive, 'a number > 0'],
  ['COLLABORATION.TINY_MAX_FILES', (v) => Number.isInteger(v) && v >= 0, 'an integer >= 0'],
  ['COLLABORATION.TINY_MAX_LINES', (v) => Number.isInteger(v) && v >= 0, 'an integer >= 0'],
  ['COLLABORATION.TINY_WEIGHT', unit, 'a number in [0, 1]'],
  ['APPRECIATION.FROM_STARS', positiveInteger, 'an integer > 0'],
  ['APPRECIATION.DECADES', positive, 'a number > 0'],
  ['APPRECIATION.FULL_AFTER_DAYS', positiveInteger, 'an integer number of days > 0'],
  ['INTEGRITY.MAX_LEAD_HOURS', (v) => isFiniteNumber(v) && v >= 0, 'a number of hours >= 0'],
  ['INTEGRITY.MAX_AHEAD_HOURS', (v) => isFiniteNumber(v) && v >= 0, 'a number of hours >= 0'],
  ['INTEGRITY.BOT_SHARE', openUnit, 'a number in (0, 1]']
];

const RULES = [
  ['MODEL_VERSION', (v) => typeof v === 'string' && SEMVER.test(v), 'a semver string like "3.0.0"'],
  ['MODEL_VERSION_RULE', text, 'a non-empty string'],
  ...NUMBERS
];

/** The constants that need a derivation: every number. */
export const DERIVED_KEYS = Object.freeze(NUMBERS.map(([key]) => key));
export const REQUIRED_CONFIG_KEYS = Object.freeze([...RULES.map(([key]) => key), 'DERIVATIONS']);

const CONTAINERS = new Set(
  RULES.flatMap(([key]) => {
    const parts = key.split('.');
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.'));
  })
);
const KNOWN = new Set([...RULES.map(([key]) => key), ...CONTAINERS, 'DERIVATIONS']);

export class ScoreConfigError extends Error {
  constructor(key, message) {
    super(`${FILE}: ${message}`);
    this.name = 'ScoreConfigError';
    this.key = key;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const describe = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

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
 * Returns a frozen, validated copy of `config`, or throws a ScoreConfigError naming the first key
 * that is missing, malformed, unknown, unexplained or inconsistent.
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

  const derivations = config.DERIVATIONS;
  if (!isPlainObject(derivations)) {
    throw new ScoreConfigError('DERIVATIONS', '`DERIVATIONS` must be an object of reasons');
  }
  for (const key of DERIVED_KEYS) {
    if (!text(derivations[key])) {
      throw new ScoreConfigError(
        `DERIVATIONS.${key}`,
        `\`${key}\` has no derivation; say why it is ${describe(lookup(config, key))}`
      );
    }
  }
  for (const key of Object.keys(derivations)) {
    if (!DERIVED_KEYS.includes(key)) {
      throw new ScoreConfigError(
        `DERIVATIONS.${key}`,
        `a derivation for \`${key}\`, which is not a constant the model reads`
      );
    }
  }

  const weights = PART_IDS.reduce((sum, id) => sum + config.WEIGHTS[id], 0);
  if (Math.abs(weights - 1) > 1e-12) {
    throw new ScoreConfigError('WEIGHTS', `the weights must sum to 1, not ${weights}`);
  }
  if (config.WINDOW_DAYS !== MEASURED_WINDOW_DAYS) {
    throw new ScoreConfigError(
      'WINDOW_DAYS',
      `\`WINDOW_DAYS\` is ${config.WINDOW_DAYS}, but the measurement covers ${MEASURED_WINDOW_DAYS} days`
    );
  }
  if (config.WORK.GATE_MIN_DAYS > config.WINDOW_DAYS) {
    throw new ScoreConfigError(
      'WORK.GATE_MIN_DAYS',
      'the gate needs more days than the window holds'
    );
  }
  if (config.APPRECIATION.FULL_AFTER_DAYS > config.WINDOW_DAYS) {
    throw new ScoreConfigError(
      'APPRECIATION.FULL_AFTER_DAYS',
      'full appreciation needs more days than the window holds'
    );
  }

  const copy = deepFreeze(JSON.parse(JSON.stringify(config)));
  validated.add(copy);
  return copy;
}

/** The model takes its config as an argument so tests can vary it, but only a validated one. */
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
