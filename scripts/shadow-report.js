/**
 * What the contributions measurement says, read off a board: the instrument scoring v3's
 * constants are checked against.
 *
 *   node scripts/shadow-report.js [board.json]     default public/data.json
 *
 * Prints markdown: coverage of `shadow_contributions` (scripts/measure/contributions.js), and the
 * distribution of every input the model reads - working days, merges others accepted and who
 * merged them, reviews and whose pull requests they were on, merges into the developer's own
 * repositories, and the commit-date evidence. A block of the previous shape is counted as
 * waiting for its batch to run, never read.
 *
 * Honest by construction:
 *   - every figure states how many rows it is over;
 *   - nothing is extrapolated: a list GitHub cut is counted and labelled, never scaled up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHADOW_FIELD, decodeMeasurement } from './measure/contributions.js';
import { workingDays, GATE_MIN_DAYS } from './measure/prescreen-log.js';
import { deriveEvidence } from '../src/model/next/evidence.js';
import { scoreEvidence } from '../src/model/next/score.js';
import { SCORE_CONFIG as NEXT_CONFIG } from '../src/model/next/config.js';
import {
  CUT_ACCEPTED,
  CUT_COMMIT_REPOS,
  CUT_DEGRADED,
  CUT_INTEGRITY,
  CUT_ISSUES,
  CUT_MAINTAINED,
  CUT_PULL_REQUESTS,
  CUT_REVIEWS,
  FLAG_FORK,
  FLAG_OWNED,
  KIND_BOT,
  KIND_USER,
  OUTCOME_CLOSED,
  OUTCOME_MERGED,
  SHAPE_VERSION
} from '../src/model/measurement.js';

export const TOP_K = 50;
/** Below this many rows a rank correlation is noise, and is not printed. */
export const MIN_ROWS_TO_COMPARE = 10;
/** The commit-date evidence the report lists; the model holds its own threshold. */
export const REPORT_LEAD_HOURS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const CUTS = [
  [CUT_COMMIT_REPOS, 'commit repository list'],
  [CUT_PULL_REQUESTS, 'pull requests'],
  [CUT_ISSUES, 'issues'],
  [CUT_REVIEWS, 'reviews'],
  [CUT_ACCEPTED, 'accepted merges'],
  [CUT_MAINTAINED, 'merges into own repositories'],
  [CUT_DEGRADED, 'shorter repository list'],
  [CUT_INTEGRITY, 'commit-date samples']
];

/** Nearest-rank quantile of a sorted array. */
function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null
  };
}

/** Ranks 1..n, ties sharing their average rank. */
export function averageRanks(values) {
  const order = values.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) ranks[order[k].i] = rank;
    start = end + 1;
  }
  return ranks;
}

/** Spearman's rho with tie correction (Pearson on average ranks); null when undefined. */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mean = (r) => r.reduce((a, b) => a + b, 0) / r.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

/** Positions 1..n by value, highest first; ties broken by input order so a position is unique. */
function positions(values) {
  const order = values
    .map((value, i) => ({ value, i }))
    .sort((a, b) => b.value - a.value || a.i - b.i);
  const out = new Array(values.length);
  order.forEach(({ i }, position) => {
    out[i] = position + 1;
  });
  return out;
}

/** How many of the top `k` by `a` are also in the top `k` by `b`. */
export function topOverlap(a, b, k) {
  const top = (values) => new Set(positions(values).flatMap((p, i) => (p <= k ? [i] : [])));
  const ta = top(a);
  let shared = 0;
  for (const i of top(b)) if (ta.has(i)) shared += 1;
  return shared;
}

const ageDays = (created, at) =>
  created ? Math.floor((Date.parse(at) - Date.parse(`${created}T00:00:00Z`)) / DAY_MS) : null;

/** Every figure the report reads from one decoded measurement. */
export function inputsOf(m) {
  const me = m.login.toLowerCase();
  const isMe = (p) => p && p.login.toLowerCase() === me;
  const merges = m.accepted.flatMap((r) => r.items.map((item) => ({ repo: r, item })));
  const reviews = m.reviews.flatMap((r) => r.items);
  const theirs = m.pull_requests.filter((r) => !(r.flags & (FLAG_OWNED | FLAG_FORK)));
  const outcomes = theirs.flatMap((r) => r.items.map((i) => i.outcome));
  const flagged = m.integrity.filter(
    (s) =>
      (s.max_lead_hours ?? -Infinity) > REPORT_LEAD_HOURS ||
      (s.max_ahead_hours ?? -Infinity) > REPORT_LEAD_HOURS ||
      (s.sampled > 0 && s.bot * 2 >= s.sampled)
  );
  return {
    working_days: workingDays(m),
    restricted: m.restricted,
    accepted: merges.length,
    accepted_by_user: merges.filter(
      ({ item }) => item.merger?.kind === KIND_USER && !isMe(item.merger)
    ).length,
    accepted_by_self: merges.filter(({ item }) => isMe(item.merger)).length,
    accepted_by_bot: merges.filter(({ item }) => item.merger?.kind === KIND_BOT).length,
    accepted_by_nobody: merges.filter(({ item }) => !item.merger).length,
    accepted_young_merger: merges.filter(
      ({ item }) =>
        item.merger?.kind === KIND_USER &&
        !isMe(item.merger) &&
        (ageDays(item.merger.created, m.measured_at) ?? 0) < 365
    ).length,
    accepted_owners: new Set(merges.map(({ repo }) => repo.repo.split('/')[0].toLowerCase())).size,
    accepted_tiny: merges.filter(({ item }) => item.files <= 1 && item.lines <= 5).length,
    reviews: reviews.length,
    reviews_self: reviews.filter((i) => isMe(i.author)).length,
    reviews_bot: reviews.filter((i) => i.author?.kind === KIND_BOT).length,
    maintained: m.maintained.reduce((s, r) => s + r.items.length, 0),
    maintained_bot: m.maintained.reduce(
      (s, r) => s + r.items.filter((i) => i.author?.kind === KIND_BOT).length,
      0
    ),
    others_merged: outcomes.filter((o) => o === OUTCOME_MERGED).length,
    others_closed: outcomes.filter((o) => o === OUTCOME_CLOSED).length,
    future_repos: m.future_repos,
    flagged
  };
}

const fmt = (value, digits = 0) => {
  if (value == null) return '-';
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) && digits === 0 ? String(value) : value.toFixed(digits || 2);
};
const pct = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '-');

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

function describeStats(s, digits = 0) {
  if (!s.n) return 'none';
  const at = (value) => fmt(value, digits);
  return `p50 ${at(s.p50)}, p90 ${at(s.p90)}, p99 ${at(s.p99)}, max ${at(s.max)} (n=${s.n})`;
}

/** Coefficient of variation of a repository's commits per active day: near 0 is a metronome. */
function cadence(days) {
  const counts = days.map((d) => d.commits);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  return mean > 0 ? sd / mean : null;
}

/**
 * Scoring v3 run over every measured row, for calibration: the board it would publish, how its
 * parts are distributed, how it relates to the current score and to popularity, and the
 * repositories a moderator should look at. The suspect list is for a person to check against
 * the commits themselves; it is never published as a label (a regular, honest developer can look
 * like a metronome).
 */
export function nextModelPreview(measured, { config = NEXT_CONFIG } = {}) {
  const out = ['## Scoring v3 preview', ''];
  if (measured.length === 0) return out;
  const scored = measured.map(({ row, m }) => ({
    row,
    m,
    r: scoreEvidence(deriveEvidence(m, { config }), { config })
  }));
  const n = scored.length;
  const passing = scored.filter(({ r }) => r.gate);
  out.push(
    `Over ${n} measured rows. Pass the ${config.WORK.GATE_MIN_DAYS}-day gate: ${passing.length}.`,
    `Score: ${describeStats(summarize(scored.map(({ r }) => r.score_exact)), 1)}.`,
    `Work: ${describeStats(summarize(scored.map(({ r }) => r.parts.work)), 3)}. ` +
      `Collaboration: ${describeStats(summarize(scored.map(({ r }) => r.parts.collaboration)), 3)}; ` +
      `above 0 for ${scored.filter(({ r }) => r.parts.collaboration > 0).length}. ` +
      `Appreciation above 0 for ${scored.filter(({ r }) => r.parts.appreciation > 0).length}.`,
    `Distinct exact scores: ${new Set(scored.map(({ r }) => r.score_exact)).size} of ${n}.`,
    ''
  );

  const v3 = scored.map(({ r }) => r.score_exact);
  const corr = (values) => fmt(spearman(v3, values), 3);
  const known = (key) => scored.every(({ row }) => typeof row[key] === 'number');
  out.push(
    table(
      ['compared with', 'Spearman'],
      [
        [
          'current score_exact',
          known('score_exact') ? corr(scored.map(({ row }) => row.score_exact)) : '-'
        ],
        ['followers', known('followers') ? corr(scored.map(({ row }) => row.followers)) : '-'],
        [
          'total stars',
          known('total_stars') ? corr(scored.map(({ row }) => row.total_stars)) : '-'
        ],
        ['private contributions', corr(scored.map(({ m }) => m.restricted))]
      ]
    ),
    ''
  );

  const order = [...scored].sort((a, b) => b.r.score_exact - a.r.score_exact);
  out.push(
    `### Top ${Math.min(TOP_K, n)}`,
    '',
    table(
      [
        '#',
        'developer',
        'score',
        'work',
        'collab.',
        'appr.',
        'days',
        'accepted',
        'reviews',
        'now #'
      ],
      order
        .slice(0, TOP_K)
        .map(({ row, r }, i) => [
          i + 1,
          row.username,
          fmt(r.score_exact, 1),
          fmt(r.parts.work, 3),
          fmt(r.parts.collaboration, 3),
          fmt(r.parts.appreciation, 3),
          r.details.working_days,
          r.evidence.accepted.length,
          r.evidence.reviews.length,
          row.rank ?? '-'
        ])
    ),
    ''
  );

  const excluded = scored.flatMap(({ m, r }) =>
    r.evidence.excluded.map((e) => [m.login, e.repo, e.reason])
  );
  out.push(`### Excluded repositories: ${excluded.length}`, '');
  if (excluded.length) out.push(table(['developer', 'repository', 'why'], excluded), '');

  const suspects = scored
    .flatMap(({ m, r }) =>
      m.commits
        .filter((c) => c.days.length >= 20 && !r.evidence.excluded.some((e) => e.repo === c.repo))
        .map((c) => ({
          login: m.login,
          repo: c.repo,
          days: c.days.length,
          cv: cadence(c.days),
          work: r.parts.work,
          collab: r.parts.collaboration
        }))
    )
    .filter((x) => x.cv !== null && x.cv <= 0.25)
    .sort((a, b) => a.cv - b.cv);
  out.push(
    `### For a moderator to check: ${suspects.length} repositories with commits on 20+ days at a near-constant rate`,
    '',
    'Not a verdict. Open the commits before listing anything in public/moderation.json.',
    ''
  );
  if (suspects.length) {
    out.push(
      table(
        ['developer', 'repository', 'days', 'cadence cv', 'work', 'collab.'],
        suspects
          .slice(0, 60)
          .map((x) => [x.login, x.repo, x.days, fmt(x.cv, 2), fmt(x.work, 3), fmt(x.collab, 3)])
      ),
      ''
    );
  }
  return out;
}

/**
 * The report for a board payload, as markdown.
 * @param {object} payload  data.json's shape
 * @param {{ source?: string }} [options]
 */
export function buildReport(payload, { source = 'board' } = {}) {
  const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
  const boardAt = Date.parse(payload?.last_updated);
  const measured = [];
  let previousShape = 0;
  let undecodable = 0;
  let bytes = 0;
  for (const row of rows) {
    const block = row?.[SHADOW_FIELD];
    if (block == null) continue;
    if (block.v !== SHAPE_VERSION) {
      previousShape += 1;
      continue;
    }
    const m = decodeMeasurement(block);
    if (!m) {
      undecodable += 1;
      continue;
    }
    bytes += JSON.stringify(block).length;
    measured.push({ row, m, inputs: inputsOf(m) });
  }

  const out = [`# Contributions measurement report (${source})`, ''];
  out.push(
    `Rows: ${rows.length}. Measured in shape ${SHAPE_VERSION}: ${measured.length} ` +
      `(${pct(measured.length, rows.length)}). In the previous shape, waiting for their batch: ` +
      `${previousShape}. Undecodable: ${undecodable}. Without a block: ` +
      `${rows.length - measured.length - previousShape - undecodable}.`,
    ''
  );
  if (measured.length === 0) {
    out.push('No row carries a measurement of this shape yet.');
    return out.join('\n');
  }

  const n = measured.length;
  const ages = measured.map(({ m }) => (boardAt - Date.parse(m.measured_at)) / 3600000);
  out.push(
    `Block age at the board's last update, hours: ${describeStats(summarize(ages), 1)}.`,
    `Block size, bytes: ${describeStats(summarize(measured.map(({ row }) => JSON.stringify(row[SHADOW_FIELD]).length)))}; ` +
      `${bytes} in all.`,
    ''
  );

  out.push('## Cut lists', '');
  out.push(
    table(
      ['list', 'rows'],
      CUTS.map(([bit, name]) => [name, `${measured.filter(({ m }) => m.cut & bit).length} of ${n}`])
    ),
    ''
  );

  const field = (key) => measured.map(({ inputs }) => inputs[key]);
  const sum = (key) => field(key).reduce((a, b) => a + b, 0);
  const rowsWith = (key) => measured.filter(({ inputs }) => inputs[key] > 0).length;

  out.push('## Working days', '');
  out.push(
    `As scoring v3 counts them: ${describeStats(summarize(field('working_days')))}. ` +
      `Under ${GATE_MIN_DAYS}: ${measured.filter(({ inputs }) => inputs.working_days < GATE_MIN_DAYS).length} of ${n}.`,
    `Private contributions (context, never scored): ${describeStats(summarize(field('restricted')))}; ` +
      `rows sharing any: ${rowsWith('restricted')} of ${n}.`,
    ''
  );

  out.push('## Merges into repositories the developer does not own', '');
  out.push(
    table(
      ['figure', 'merges', 'rows'],
      [
        ['all', sum('accepted'), rowsWith('accepted')],
        ['merged by another user', sum('accepted_by_user'), rowsWith('accepted_by_user')],
        [
          '  of which the merger is under a year old',
          sum('accepted_young_merger'),
          rowsWith('accepted_young_merger')
        ],
        ['merged by the developer', sum('accepted_by_self'), rowsWith('accepted_by_self')],
        ['merged by a bot', sum('accepted_by_bot'), rowsWith('accepted_by_bot')],
        ['merger account gone', sum('accepted_by_nobody'), rowsWith('accepted_by_nobody')],
        ['one file and at most 5 lines', sum('accepted_tiny'), rowsWith('accepted_tiny')]
      ].map(([a, b, c]) => [a, b, `${c} of ${n}`])
    ),
    '',
    `Distinct owners per developer: ${describeStats(summarize(field('accepted_owners').filter((v) => v > 0)))}.`,
    `Their pull requests to others' repositories opened in the window: ${sum('others_merged')} merged, ` +
      `${sum('others_closed')} closed without merging.`,
    ''
  );

  out.push('## Reviews and merges into their own repositories', '');
  out.push(
    `Reviews: ${sum('reviews')} on ${rowsWith('reviews')} rows; on their own pull requests ` +
      `${sum('reviews_self')}, on a bot's ${sum('reviews_bot')}.`,
    `Other people's pull requests merged into their repositories: ${sum('maintained')} on ` +
      `${rowsWith('maintained')} rows, ${sum('maintained_bot')} of them by bots.`,
    ''
  );

  out.push('## Commit-date evidence', '');
  const future = measured.filter(({ inputs }) => inputs.future_repos.length > 0);
  const flagged = measured.filter(({ inputs }) => inputs.flagged.length > 0);
  out.push(
    `Rows with commits dated in the future: ${future.length} of ${n}. Rows with a sampled ` +
      `repository whose author dates run more than ${REPORT_LEAD_HOURS} h ahead of their commit ` +
      `dates or past the measurement, or whose commits are half or more by a bot: ${flagged.length} of ${n}.`,
    ''
  );
  if (future.length + flagged.length > 0) {
    out.push(
      table(
        ['developer', 'repository', 'evidence'],
        [
          ...future.flatMap(({ m, inputs }) =>
            inputs.future_repos.map((repo) => [m.login, repo, 'future-dated commits'])
          ),
          ...flagged.flatMap(({ m, inputs }) =>
            inputs.flagged.map((s) => [
              m.login,
              s.repo,
              `lead ${fmt(s.max_lead_hours, 1)} h, ahead ${fmt(s.max_ahead_hours, 1)} h, bot ${s.bot}/${s.sampled}`
            ])
          )
        ]
      ),
      ''
    );
  }
  out.push(...nextModelPreview(measured));
  return out.join('\n');
}

function main(argv) {
  const target = path.resolve(process.cwd(), argv[0] || path.join('public', 'data.json'));
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  console.log(buildReport(payload, { source: path.relative(process.cwd(), target) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
