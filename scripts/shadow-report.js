/**
 * What the shadow measurement says, read off a board: the instrument the next activity model's
 * caps are chosen with.
 *
 *   node scripts/shadow-report.js [board.json] [--discount 0.5]     default public/data.json
 *
 * Prints markdown: coverage of `shadow_contributions` (scripts/measure/contributions.js), the
 * distribution of every input a candidate rule would read, and candidate activity measures
 * compared with today's `activity_score` and with each other.
 *
 * Honest by construction:
 *   - every figure states how many rows it is over;
 *   - nothing is extrapolated: a repository list GitHub cut, pull requests that were not read and
 *     events reads that stopped at their page ceiling are counted and labelled, never scaled up;
 *   - a comparison with `activity_score` uses only rows that carry one;
 *   - "top-k" is the top-k of the rows measured, and k shrinks with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_OWNED, SHADOW_FIELD, decodeShadow, truncation } from './measure/contributions.js';

export const CAPS = Object.freeze([5, 10, 20]);
export const DEFAULT_DISCOUNT = 0.5;
export const TOP_K = 50;
/** Below this many rows a rank correlation is noise, and is not printed. */
export const MIN_ROWS_TO_COMPARE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

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

const isZeroStarOwned = (repo) => (repo.flags & FLAG_OWNED) !== 0 && repo.stars === 0;

/**
 * The candidate activity measures for one decoded measurement. Every one is computed from the
 * listed repositories only; a cut list is reported, not filled in.
 */
export function candidateMeasures(m, { discount = DEFAULT_DISCOUNT } = {}) {
  const commitDays = new Set();
  for (const repo of m.commit_repositories_30d) for (const d of repo.days) commitDays.add(d.day);
  const out = {
    calendar_days: m.calendar_60d.slice(-30).filter((n) => n > 0).length,
    commit_days: commitDays.size,
    commits: m.commit_repositories_30d.reduce((sum, r) => sum + r.commits, 0)
  };
  for (const cap of CAPS) {
    let capped = 0;
    let discounted = 0;
    for (const repo of m.commit_repositories_30d) {
      const sum = repo.days.reduce((s, d) => s + Math.min(d.commits, cap), 0);
      capped += sum;
      discounted += isZeroStarOwned(repo) ? sum * discount : sum;
    }
    out[`cap${cap}`] = capped;
    out[`cap${cap}_z`] = discounted;
  }
  return out;
}

/** The longest run of zero days in the 60-day calendar. */
export function longestCalendarGap(calendar) {
  let longest = 0;
  let run = 0;
  for (const n of calendar) {
    run = n > 0 ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

function inputsOf(m) {
  const t = m.totals_30d;
  const listed = m.commit_repositories_30d.reduce((sum, r) => sum + r.commits, 0);
  const zeroOwned = m.commit_repositories_30d
    .filter(isZeroStarOwned)
    .reduce((sum, r) => sum + r.commits, 0);
  const read = m.pull_request_repositories_30d.reduce((sum, r) => sum + r.read, 0);
  return {
    perRepoDay: m.commit_repositories_30d.flatMap((r) => r.days.map((d) => d.commits)),
    maxRepoDay: Math.max(
      0,
      ...m.commit_repositories_30d.flatMap((r) => r.days.map((d) => d.commits))
    ),
    perRepo: m.commit_repositories_30d.map((r) => r.commits),
    repositories: t.commit_repositories,
    zeroOwnedShare: listed > 0 ? zeroOwned / listed : null,
    restricted: t.restricted,
    pullRequests: t.pull_requests,
    mergedByOther: m.pull_request_repositories_30d.reduce((sum, r) => sum + r.merged_by_other, 0),
    mergedByOtherShare:
      read > 0
        ? m.pull_request_repositories_30d.reduce((sum, r) => sum + r.merged_by_other, 0) / read
        : null,
    prGap: m.pull_request_gap_30d?.median_seconds ?? null,
    gap60: longestCalendarGap(m.calendar_60d)
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

/**
 * The report for a board payload, as markdown.
 * @param {object} payload  data.json's shape
 * @param {{ discount?: number, source?: string }} [options]
 */
export function buildReport(payload, { discount = DEFAULT_DISCOUNT, source = 'board' } = {}) {
  const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
  const boardAt = Date.parse(payload?.last_updated);
  const measured = [];
  let undecodable = 0;
  for (const row of rows) {
    if (row?.[SHADOW_FIELD] == null) continue;
    const m = decodeShadow(row[SHADOW_FIELD]);
    if (!m) {
      undecodable += 1;
      continue;
    }
    measured.push({ row, m, inputs: inputsOf(m), cut: truncation(m) });
  }
  const n = measured.length;
  const count = (test) => measured.filter(test).length;
  const gapUnder = (seconds) => (x) => x.inputs.prGap != null && x.inputs.prGap < seconds;
  const out = [];

  out.push('# Shadow contributions report', '');
  out.push(
    `Source: ${source}, last_updated ${payload?.last_updated ?? 'unknown'}, ${rows.length} rows. ` +
      `${n} rows carry a decodable block` +
      (undecodable ? `, ${undecodable} carry one this code cannot read` : '') +
      '. Every figure below is over the rows it names; nothing is extrapolated.',
    ''
  );

  // Coverage
  out.push('## Coverage', '');
  out.push(`- Rows with a block: ${n} of ${rows.length} (${pct(n, rows.length)}).`);
  const windows = new Map();
  for (const { m } of measured) {
    const key = `${m.scoring_window.from}..${m.scoring_window.to}`;
    windows.set(key, (windows.get(key) || 0) + 1);
  }
  if (windows.size) {
    out.push(
      `- Scoring windows, [from, to): ${[...windows].map(([w, c]) => `${w} (${c})`).join(', ')}.`
    );
  }
  const ages = {
    'after last_updated': 0,
    '< 1 day': 0,
    '1-2 days': 0,
    '2-7 days': 0,
    '>= 7 days': 0,
    unknown: 0
  };
  for (const { m } of measured) {
    const age = (boardAt - Date.parse(m.measured_at)) / DAY_MS;
    if (!Number.isFinite(age)) ages.unknown += 1;
    else if (age < 0) ages['after last_updated'] += 1;
    else if (age < 1) ages['< 1 day'] += 1;
    else if (age < 2) ages['1-2 days'] += 1;
    else if (age < 7) ages['2-7 days'] += 1;
    else ages['>= 7 days'] += 1;
  }
  out.push(
    `- Age at last_updated: ${
      Object.entries(ages)
        .filter(([, c]) => c > 0)
        .map(([a, c]) => `${a} ${c}`)
        .join(', ') || 'none'
    }.`,
    ''
  );
  const byBatch = new Map();
  for (const row of rows) {
    const b = row?.batch_index ?? '?';
    const entry = byBatch.get(b) || { rows: 0, blocks: 0 };
    entry.rows += 1;
    if (decodeShadow(row?.[SHADOW_FIELD])) entry.blocks += 1;
    byBatch.set(b, entry);
  }
  out.push(
    table(
      ['batch', 'rows', 'with a block', 'share'],
      [...byBatch]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([b, e]) => [b, e.rows, e.blocks, pct(e.blocks, e.rows)])
    ),
    ''
  );

  if (n === 0) {
    out.push('No row carries a block yet, so there is nothing more to report.');
    return out.join('\n');
  }

  // Truncation
  const cutRepos = measured.filter((x) => x.cut.commit_repositories);
  const unlisted = cutRepos.reduce((sum, x) => sum + x.cut.commits_unlisted, 0);
  const withEvents = measured.filter((x) => x.row.events_window);
  const truncatedEvents = withEvents.filter((x) => x.row.events_window.truncated);
  out.push('## What was not seen', '');
  out.push(
    `- Commit repository list cut by GitHub: ${cutRepos.length} of ${n} rows, ${unlisted} commits ` +
      'unlisted. Per-repository figures for these rows cover the listed repositories only.',
    `- Pull request repository list cut: ` +
      `${measured.filter((x) => x.cut.pull_request_repositories).length} of ${n} rows; rows with ` +
      `more pull requests in one repository than were read: ` +
      `${measured.filter((x) => x.cut.pull_requests_unread).length} of ${n}. Merged counts cover ` +
      'the pull requests read.',
    `- Events read behind \`activity_score\` stopped at its page ceiling: ${truncatedEvents.length} ` +
      `of ${withEvents.length} rows that record it; days those reads reached back: ` +
      `${describeStats(summarize(truncatedEvents.map((x) => x.row.events_window.days)), 1)}.`,
    `- Rows sharing private counts (restricted > 0): ${count((x) => x.inputs.restricted > 0)} ` +
      `of ${n}. Their calendar days include private work, which is context and never scored.`,
    ''
  );

  // Distributions
  out.push('## Inputs', '');
  const dist = (label, values, digits = 0) => {
    const s = summarize(values);
    return [
      label,
      s.n,
      fmt(s.p50, digits),
      fmt(s.p90, digits),
      fmt(s.p99, digits),
      fmt(s.max, digits)
    ];
  };
  const all = (key) => measured.map((x) => x.inputs[key]);
  const flat = (key) => measured.flatMap((x) => x.inputs[key]);
  const decoded = (fn) => measured.map((x) => fn(x));
  out.push(
    table(
      ['input (30 days unless named)', 'n', 'p50', 'p90', 'p99', 'max'],
      [
        dist('commits per repository per day (days with any)', flat('perRepoDay')),
        dist('max commits in one repository on one day, per row', all('maxRepoDay')),
        dist('commits per repository', flat('perRepo')),
        dist('repositories with commits, per row', all('repositories')),
        dist(
          'commits, per row',
          decoded((x) => x.m.totals_30d.commits)
        ),
        dist(
          'calendar active days (includes private)',
          decoded((x) => candidateMeasures(x.m).calendar_days)
        ),
        dist(
          'commit active days',
          decoded((x) => candidateMeasures(x.m).commit_days)
        ),
        dist('share of commits in owned zero-star repositories', all('zeroOwnedShare'), 2),
        dist('restricted (private) contributions', all('restricted')),
        dist('pull requests opened', all('pullRequests')),
        dist('pull requests merged by someone else (of those read)', all('mergedByOther')),
        dist('share merged by someone else (of those read)', all('mergedByOtherShare'), 2),
        dist('median seconds between PR creations (>= 5 PRs)', all('prGap')),
        dist('longest calendar gap in 60 days, days', all('gap60'))
      ]
    ),
    ''
  );
  const zeroAll = measured.filter((x) => x.inputs.zeroOwnedShare === 1).length;
  const noOther = measured.filter(
    (x) => x.inputs.pullRequests > 0 && x.inputs.mergedByOther === 0
  ).length;
  out.push(
    `- Rows whose every listed commit is in an owned zero-star repository: ${zeroAll} of ${n}.`,
    `- Rows with pull requests, none merged by someone else: ${noOther} of ` +
      `${measured.filter((x) => x.inputs.pullRequests > 0).length}.`,
    `- Rows with a PR-creation median under 61 s: ${count(gapUnder(61))}; ` +
      `under 300 s: ${count(gapUnder(300))} ` +
      `(of ${measured.filter((x) => x.inputs.prGap != null).length} with a median).`,
    ''
  );

  // Candidates
  const candidates = measured.map((x) => candidateMeasures(x.m, { discount }));
  const names = Object.keys(candidates[0]);
  const scored = measured
    .map((x, i) => ({ x, c: candidates[i] }))
    .filter(
      ({ x }) => typeof x.row.activity_score === 'number' && Number.isFinite(x.row.activity_score)
    );
  const k = Math.min(TOP_K, Math.floor(scored.length / 5));
  out.push('## Candidate activity measures', '');
  out.push(
    '`calendar_days` and `commit_days` count active days in the scoring window; `commits` is the ' +
      `listed total; \`capK\` sums min(commits, K) over every repository-day; \`capK_z\` is the same ` +
      `with owned zero-star repositories weighted ${discount}. Compared with today's ` +
      `\`activity_score\` over the ${scored.length} rows that carry both; top-k overlap uses ` +
      `k = ${k} (min(${TOP_K}, n/5)), so below ${TOP_K * 5} rows it is not ` +
      `the top-${TOP_K} of the board.`,
    ''
  );
  const activity = scored.map(({ x }) => x.row.activity_score);
  const comparable = scored.length >= MIN_ROWS_TO_COMPARE;
  const withEvents30 = measured
    .map((x, i) => ({ c: candidates[i], e: x.row.events_30d }))
    .filter(({ e }) => Number.isInteger(e));
  const events30 = withEvents30.map(({ e }) => e);
  if (!comparable) {
    out.push(
      `Only ${scored.length} rows carry both, under the ${MIN_ROWS_TO_COMPARE} this report ` +
        'compares on; the activity_score columns are left empty rather than filled with noise.',
      ''
    );
  }
  out.push(
    table(
      [
        'candidate',
        `Spearman vs activity_score (n=${scored.length})`,
        `top-${k} shared with activity_score`,
        `Spearman vs events_30d (n=${withEvents30.length})`
      ],
      names.map((name) => {
        const values = scored.map(({ c }) => c[name]);
        return [
          name,
          comparable ? fmt(spearman(values, activity), 3) : '-',
          comparable && k > 0 ? `${topOverlap(values, activity, k)} of ${k}` : '-',
          fmt(
            spearman(
              withEvents30.map(({ c }) => c[name]),
              events30
            ),
            3
          )
        ];
      })
    ),
    ''
  );
  const truncatedScored = scored.filter(({ x }) => x.row.events_window?.truncated);
  if (truncatedScored.length) {
    out.push(
      `${truncatedScored.length} of these ${scored.length} \`activity_score\` values came from ` +
        'an events read that stopped at its page ceiling: the baseline itself saw only part of ' +
        'the window.',
      ''
    );
  }

  out.push(`Candidates against each other, over all ${n} rows with a block (Spearman):`, '');
  out.push(
    table(
      ['', ...names],
      names.map((a) => [
        a,
        ...names.map((b) =>
          fmt(
            spearman(
              candidates.map((c) => c[a]),
              candidates.map((c) => c[b])
            ),
            2
          )
        )
      ])
    ),
    ''
  );

  // Extremes
  const place = {};
  for (const name of names) {
    const p = positions(candidates.map((c) => c[name]));
    place[name] = (i) => p[i];
  }
  const activityPositions = positions(
    measured.map((x) => (typeof x.row.activity_score === 'number' ? x.row.activity_score : -1))
  );
  const pick = new Set();
  const by = (fn) =>
    measured
      .map((x, i) => ({ i, v: fn(x, i) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5)
      .forEach(({ i }) => pick.add(i));
  by((x) => x.m.totals_30d.commits);
  by((x) => x.inputs.maxRepoDay);
  by((x) => x.inputs.pullRequests - x.inputs.mergedByOther);
  by((x) => (x.inputs.prGap == null ? -Infinity : -x.inputs.prGap));
  out.push(
    `## Where the most extreme accounts land (positions among the ${n} rows with a block)`,
    '',
    'The five highest by commits, by commits in one repository on one day, and by pull requests ' +
      'not merged by someone else, and the five with the shortest PR-creation median. The ' +
      '`activity_score` column and each candidate column are positions, 1 the highest.',
    ''
  );
  out.push(
    table(
      [
        'developer',
        'board rank',
        'commits',
        'max repo-day',
        'owned zero-star share',
        'PRs (by others)',
        'PR median s',
        'events read, days',
        'activity_score',
        ...names
      ],
      [...pick]
        .sort((a, b) => measured[b].m.totals_30d.commits - measured[a].m.totals_30d.commits)
        .map((i) => {
          const { row, m, inputs, cut } = measured[i];
          return [
            row.username,
            row.rank ?? '-',
            cut.commit_repositories
              ? `${m.totals_30d.commits} (${m.totals_30d.commits - cut.commits_unlisted} listed)`
              : m.totals_30d.commits,
            inputs.maxRepoDay,
            fmt(inputs.zeroOwnedShare, 2),
            `${inputs.pullRequests} (${inputs.mergedByOther})`,
            fmt(inputs.prGap),
            row.events_window ? fmt(row.events_window.days, 1) : '-',
            typeof row.activity_score === 'number' ? `#${activityPositions[i]}` : '-',
            ...names.map((name) => `#${place[name](i)}`)
          ];
        })
    ),
    ''
  );
  return out.join('\n');
}

function describeStats(s, digits = 0) {
  if (!s.n) return 'none';
  const at = (value) => fmt(value, digits);
  return `p50 ${at(s.p50)}, p90 ${at(s.p90)}, max ${at(s.max)} (n=${s.n})`;
}

function main(argv) {
  const args = [...argv];
  const discountAt = args.indexOf('--discount');
  let discount = DEFAULT_DISCOUNT;
  if (discountAt !== -1) {
    discount = Number(args[discountAt + 1]);
    args.splice(discountAt, 2);
    if (!(discount >= 0 && discount <= 1)) throw new Error('--discount must be between 0 and 1');
  }
  const target = path.resolve(process.cwd(), args[0] || path.join('public', 'data.json'));
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  console.log(buildReport(payload, { discount, source: path.relative(process.cwd(), target) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
