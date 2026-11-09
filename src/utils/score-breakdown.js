/**
 * The score, in its three parts, for a developer who is on the board.
 *
 * The parts are the model's own: active days, open source contributions and stars
 * (score-config.json, scoring v3.1). Followers, repository counts and account age give no points
 * and are not shown as if they did - the About page says so in the same words
 * (SCORE_NOT_COUNTED in score-explainer.js).
 *
 * Every number comes from the published row: `score_parts` for the shape of the score and
 * `score_evidence` for what was found. Nothing is recomputed here, so the page cannot show a
 * breakdown the board would not agree with.
 */
import { SCORE_CONFIG } from '../model/config.js';
import { PART_LABELS } from './score-explainer.js';

const { SCALE, WEIGHTS, WINDOW_DAYS, APPRECIATION } = SCORE_CONFIG;

const one = (n) => n.toLocaleString('en-US');
const round1 = (n) => Math.round(n * 10) / 10;

/** The points a part gave, out of the whole score. */
export function pointsForPart(parts, id) {
  const value = Number(parts?.[id]);
  if (!Number.isFinite(value)) return 0;
  return SCALE * WEIGHTS[id] * value;
}

/** What was found under the stars part: the repository the points came from. */
function appreciationDetail(evidence) {
  const list = Array.isArray(evidence?.appreciation) ? evidence.appreciation : [];
  if (list.length === 0) {
    return `No repository of theirs with ${APPRECIATION.FROM_STARS} or more stars that they committed to this month.`;
  }
  const best = list.reduce((a, b) => (b.stars > a.stars ? b : a), list[0]);
  return `${best.repo} · ${one(best.stars)} stars, committed to on ${best.days} ${best.days === 1 ? 'day' : 'days'}.`;
}

/** What was found under the open source part: the work other developers accepted. */
function collaborationDetail(evidence) {
  const accepted = Array.isArray(evidence?.accepted) ? evidence.accepted.length : 0;
  const reviews = Array.isArray(evidence?.reviews) ? evidence.reviews.length : 0;
  const maintained = Array.isArray(evidence?.maintained) ? evidence.maintained.length : 0;
  const closed = Number(evidence?.pull_requests_to_others?.closed) || 0;
  const parts = [];
  if (accepted > 0)
    parts.push(
      `${one(accepted)} pull ${accepted === 1 ? 'request' : 'requests'} merged into open source projects and accepted by another developer`
    );
  if (reviews > 0) parts.push(`${one(reviews)} ${reviews === 1 ? 'review' : 'reviews'}`);
  if (maintained > 0)
    parts.push(
      `${one(maintained)} pull ${maintained === 1 ? 'request' : 'requests'} from other developers merged into their repositories`
    );
  if (parts.length === 0) {
    return `No open source work another developer accepted in the last ${WINDOW_DAYS} days.`;
  }
  const rejected = closed > 0 ? ` ${one(closed)} closed without being merged.` : '';
  return `${parts.join(', ')}.${rejected}`;
}

/**
 * The three parts of a score, each with its points, its maximum and what was found.
 *
 * @returns {Array<{id, label, points, max, share, detail}>} empty when the row carries no parts
 */
export function scoreBreakdown(row) {
  const parts = row?.score_parts;
  if (!parts || typeof parts !== 'object') return [];

  const evidence = row?.score_evidence;
  const activeDays = Array.isArray(evidence?.working_days) ? evidence.working_days.length : null;

  const rows = [
    {
      id: 'work',
      label: PART_LABELS.work,
      points: pointsForPart(parts, 'work'),
      max: SCALE * WEIGHTS.work,
      detail:
        activeDays === null
          ? `Active on ${WINDOW_DAYS} days or fewer in the last ${WINDOW_DAYS}.`
          : `Active on ${one(activeDays)} of the last ${WINDOW_DAYS} days.`
    },
    {
      id: 'collaboration',
      label: PART_LABELS.collaboration,
      points: pointsForPart(parts, 'collaboration'),
      max: SCALE * WEIGHTS.collaboration,
      detail: collaborationDetail(evidence)
    },
    {
      id: 'appreciation',
      label: PART_LABELS.appreciation,
      points: pointsForPart(parts, 'appreciation'),
      max: SCALE * WEIGHTS.appreciation,
      detail: appreciationDetail(evidence)
    }
  ];

  for (const row of rows) {
    row.share = row.max > 0 ? Math.max(0, Math.min(1, row.points / row.max)) : 0;
    row.points_text = round1(row.points).toFixed(1);
  }
  return rows;
}

/** The score the parts add up to, and the whole it is out of. */
export function breakdownTotal(row) {
  const parts = row?.score_parts;
  if (!parts) return null;
  let sum = 0;
  for (const id of Object.keys(WEIGHTS)) sum += pointsForPart(parts, id);
  return { points: round1(sum), max: SCALE };
}
