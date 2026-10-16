/**
 * The developer score (scoring v3), from the evidence (src/model/evidence.js). The pipeline
 * (scripts/score.js), the board check (scripts/verify-published.js) and the Worker's preview
 * (cloudflare/score-preview.js) all call this one implementation.
 *
 *   score_exact = SCALE × (w_work·Work + w_collaboration·Collaboration + w_appreciation·Appreciation)
 *   score       = round(score_exact)
 *
 *   Work           x = Σ recency weights of working days / Σ recency weights of every day
 *                  Work = 1 − (1 − x)^CURVE_POWER
 *   Collaboration  c = f·accepted + reviews + maintained,  Collaboration = c / (c + HALF_POINT)
 *                  accepted = the smaller of Σ_owner and Σ_merger of min(CAP, log2(1 + V)),
 *                  V the group's Σ starWeight·size·recency; reviews likewise by owner and by
 *                  author; maintained by author; f the rejection factor
 *   Appreciation   max over active own projects of clamp(decades of stars above FROM_STARS
 *                  / DECADES) × min(1, commit days / FULL_AFTER_DAYS)
 *
 * Pure and clock-free: the same evidence gives the same score, bit for bit, wherever it runs. Every
 * sum runs in a fixed order (evidence order, then groups by key), because floating-point addition
 * is not associative and a published score is checked by recomputing it.
 */
import { assertValidatedConfig, majorVersion, SCORE_CONFIG, PART_IDS } from './config.js';
import { decodeMeasurement } from './measurement.js';
import { deriveEvidence } from './evidence.js';
import { compareCodePoints } from './order.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the model reads from a row in the state. Nothing else affects the score. */
export const MODEL_INPUT_FIELDS = Object.freeze(['contributions']);

/** What a served row carries for its score to be recomputed without the measurement. */
export const PUBLISHED_MODEL_FIELDS = Object.freeze([
  'score_exact',
  'score_parts',
  'model_version',
  'scored_at'
]);

/** The recency weight of a window day, 0 the oldest: falls evenly from 1 to RECENCY_FLOOR. */
export function recencyWeight(offset, config) {
  const { WINDOW_DAYS, RECENCY_FLOOR } = config;
  return RECENCY_FLOOR + ((1 - RECENCY_FLOOR) * offset) / (WINDOW_DAYS - 1);
}

function offsetOf(date, window, config) {
  const offset = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / DAY_MS
  );
  if (!Number.isInteger(offset) || offset < 0 || offset >= config.WINDOW_DAYS) {
    throw new RangeError(`scoring model: ${JSON.stringify(date)} is not a date in the window`);
  }
  return offset;
}

/** A target's weight by its stars: STARS_FLOOR, plus STARS_PER_DIGIT per digit, at most 1. */
export function starWeight(stars, config) {
  const { STARS_FLOOR, STARS_PER_DIGIT } = config.COLLABORATION;
  return Math.min(1, STARS_FLOOR + STARS_PER_DIGIT * Math.log10(1 + stars));
}

/** Half (TINY_WEIGHT) for a one-file change of at most TINY_MAX_LINES lines. */
export function sizeWeight({ lines, files }, config) {
  const { TINY_MAX_FILES, TINY_MAX_LINES, TINY_WEIGHT } = config.COLLABORATION;
  return files <= TINY_MAX_FILES && lines <= TINY_MAX_LINES ? TINY_WEIGHT : 1;
}

/** Σ over groups (in key order) of min(CAP, log2(1 + the group's Σ value)). */
function groupCredit(items, key, value, config) {
  const totals = new Map();
  for (const item of items) {
    const k = String(key(item)).toLowerCase();
    totals.set(k, (totals.get(k) || 0) + value(item));
  }
  let sum = 0;
  for (const k of [...totals.keys()].sort(compareCodePoints)) {
    sum += Math.min(config.COLLABORATION.CAP_PER_GROUP, Math.log2(1 + totals.get(k)));
  }
  return sum;
}

/** The rejection factor: min(1, P(M + P) / (M + X + 2P)), P the prior. */
export function rejectionFactor({ merged, closed }, config) {
  const p = config.COLLABORATION.REJECTION_PRIOR;
  return Math.min(1, (p * (merged + p)) / (merged + closed + 2 * p));
}

/**
 * The three parts, and the figures behind them, from evidence.
 * @returns {{work: number, collaboration: number, appreciation: number, details: object}}
 */
export function partsFromEvidence(evidence, { config = SCORE_CONFIG } = {}) {
  assertValidatedConfig(config);
  const window = evidence.window;
  const w = (date) => recencyWeight(offsetOf(date, window, config), config);

  let total = 0;
  for (let k = 0; k < config.WINDOW_DAYS; k += 1) total += recencyWeight(k, config);
  let weighted = 0;
  for (const date of evidence.working_days) weighted += w(date);
  const x = weighted / total;
  const work = 1 - (1 - x) ** config.WORK.CURVE_POWER;

  const C = config.COLLABORATION;
  const acceptedValue = (i) => starWeight(i.stars, config) * sizeWeight(i, config) * w(i.date);
  const accepted = Math.min(
    groupCredit(evidence.accepted, (i) => i.owner, acceptedValue, config),
    groupCredit(evidence.accepted, (i) => i.merger, acceptedValue, config)
  );
  const f = rejectionFactor(evidence.pull_requests_to_others, config);
  const reviewValue = (i) => C.REVIEW_WEIGHT * starWeight(i.stars, config) * w(i.date);
  const reviews = Math.min(
    groupCredit(evidence.reviews, (i) => i.owner, reviewValue, config),
    groupCredit(evidence.reviews, (i) => i.author, reviewValue, config)
  );
  const maintainedValue = (i) =>
    C.MAINTAINED_WEIGHT * starWeight(i.stars, config) * sizeWeight(i, config) * w(i.date);
  const maintained = groupCredit(evidence.maintained, (i) => i.author, maintainedValue, config);
  const c = f * accepted + reviews + maintained;
  const collaboration = c / (c + C.HALF_POINT);

  const A = config.APPRECIATION;
  let appreciation = 0;
  let appreciated = null;
  for (const r of evidence.appreciation) {
    const decades = Math.log10(r.stars) - Math.log10(A.FROM_STARS);
    const value =
      Math.min(1, Math.max(0, decades / A.DECADES)) * Math.min(1, r.days / A.FULL_AFTER_DAYS);
    if (value > appreciation) {
      appreciation = value;
      appreciated = r.repo;
    }
  }

  return {
    work,
    collaboration,
    appreciation,
    details: {
      working_days: evidence.working_days.length,
      x,
      c,
      accepted,
      rejection_factor: f,
      reviews,
      maintained,
      appreciated
    }
  };
}

/** The score from the three parts. One function, so a check recomputes with the same arithmetic. */
export function scoreFromParts(parts, { config = SCORE_CONFIG } = {}) {
  assertValidatedConfig(config);
  let sum = 0;
  for (const id of PART_IDS) {
    const value = parts?.[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `scoring model: part ${id} is ${JSON.stringify(value)}, not a number in [0, 1]`
      );
    }
    sum += config.WEIGHTS[id] * value;
  }
  return config.SCALE * sum;
}

/** The whole result for evidence. */
export function scoreEvidence(evidence, { config = SCORE_CONFIG } = {}) {
  const parts = partsFromEvidence(evidence, { config });
  const scoreExact = scoreFromParts(parts, { config });
  return {
    score: Math.round(scoreExact),
    score_exact: scoreExact,
    parts: {
      work: parts.work,
      collaboration: parts.collaboration,
      appreciation: parts.appreciation
    },
    details: parts.details,
    gate: evidence.working_days.length >= config.WORK.GATE_MIN_DAYS,
    evidence
  };
}

/**
 * The score of a stored measurement block. Throws on a block that is not a measurement: a score
 * is computed from the measurement or not at all.
 */
export function scoreModel(block, { config = SCORE_CONFIG, moderation = [] } = {}) {
  const m = decodeMeasurement(block);
  if (!m) throw new TypeError('scoring model: the row carries no measurement this model can read');
  return scoreEvidence(deriveEvidence(m, { config, moderation }), { config });
}

/** The fields a scored row carries. `scored_at` is when the inputs were measured. */
export function publishedScoreFields(result, { config = SCORE_CONFIG } = {}) {
  assertValidatedConfig(config);
  return {
    score: result.score,
    score_exact: result.score_exact,
    score_parts: { ...result.parts },
    model_version: config.MODEL_VERSION,
    scored_at: result.evidence.measured_at
  };
}

/**
 * Recomputes a published row's score from its `score_parts`, and refuses a row scored by another
 * major version: its parts mean something else.
 */
export function recomputePublished(row, { config = SCORE_CONFIG } = {}) {
  assertValidatedConfig(config);
  if (typeof row?.model_version !== 'string') {
    throw new TypeError(
      `recomputePublished: ${JSON.stringify(row?.username)} carries no model_version`
    );
  }
  if (majorVersion(row.model_version) !== majorVersion(config.MODEL_VERSION)) {
    throw new TypeError(
      `recomputePublished: ${row.username} was scored by ${row.model_version}, this is ${config.MODEL_VERSION}`
    );
  }
  const scoreExact = scoreFromParts(row.score_parts, { config });
  return { score: Math.round(scoreExact), score_exact: scoreExact };
}
