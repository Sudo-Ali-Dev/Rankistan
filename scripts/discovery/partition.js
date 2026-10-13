/**
 * Cuts a GitHub user search into leaves small enough to list in one request.
 *
 * Why this exists: GitHub serves at most 1,000 results for any one search, however many match.
 * The pipeline listed each hourly batch's `created:` range as a single query sorted by followers,
 * so a range holding more than 1,000 people silently lost the rest - and because of the sort, the
 * people it lost were always the lowest-follower ones. Measured on 2026-10-13, 13 of the 26 shard
 * queries were at or over the cap and 1,172 developers could not be reached however often the
 * pipeline ran. Paging was unsound even under the cap: follower counts tie in runs of 40-73, ties
 * straddle page boundaries, and a rate-limit wait mid-pagination resumed over a shifted result set,
 * which is how five production runs returned 16-256 duplicates or stopped at 560 of 881.
 *
 * So a range is never paged. It is bisected on `created:` - whole UTC days, then seconds, then a
 * `followers:` sub-range as a last resort - until every slice counts below SPLIT_AT, and
 * neighbouring slices are then packed back together up to PACK_TO. Every leaf therefore lists in a
 * single request of PAGE_SIZE, and a single request is atomic: there is no page boundary for a tie
 * to straddle and no cursor for a rate-limit wait to invalidate.
 *
 * Nothing here touches the network. `count(queries)` is injected.
 *
 * Search semantics this relies on, each verified against the live API on 2026-10-13:
 *   - `created:A..B` is inclusive at both ends, in UTC, for dates and for second-precision
 *     datetimes, so count(A..B) = count(A..M) + count(M+1..B) exactly. Every split re-checks it.
 *   - A bare date is a UTC day: `created:D` = `created:DT00:00:00Z..DT23:59:59Z`.
 *   - Two `created:` qualifiers do not intersect. GitHub silently drops the filter and matches
 *     everyone. Repeated `followers:` qualifiers OR together. A slice therefore REPLACES the base
 *     qualifier rather than being appended to it, and toQuery refuses a base carrying either one.
 *   - An inverted range (`created:B..A`) is not empty: it counts as the forward range. assertSlice
 *     refuses to emit one.
 *   - `location:` is never partitioned, so it stays in the base verbatim. Repeated `location:`
 *     qualifiers OR together and `-location:` negations AND, so the city twin's base - fifteen
 *     `location:` qualifiers and `-location:pakistan`, scripts/discovery/locations.js - is one
 *     fixed filter, the same for every slice.
 */

/** One GraphQL search request returns at most this many nodes. */
export const PAGE_SIZE = 100;
/**
 * A slice counting this many or more is split. Partitioning finely and packing afterwards lands
 * leaves close to full: measured over all 26 shard queries on 2026-10-13, 318 single-request
 * leaves, against 386 for plain bisection at PAGE_SIZE.
 */
export const SPLIT_AT = 30;
/**
 * Neighbours are packed while their sum stays at or below this. The margin under PAGE_SIZE absorbs
 * growth in the minute or so between counting a leaf and listing it; a leaf that outgrows a page
 * anyway is re-split at listing time, not truncated.
 */
export const PACK_TO = 95;

export const DAY_SECONDS = 86400;
/** GitHub's first accounts date from 2007; nothing can be created before this. */
export const EARLIEST_CREATED = Date.UTC(2007, 0, 1) / 1000;
/** Matches the open-ended `2099-12-31` that SEARCH_BATCHES uses. */
export const LATEST_CREATED = Date.UTC(2099, 11, 31, 23, 59, 59) / 1000;

/** Above this, an open-ended `followers:>=N` range is not split further. */
const MAX_SPLITTABLE_FOLLOWERS = 1e9;
const MAX_DEPTH = 96;
/** Hard stop for a pathological counter. A real batch counts a few hundred slices. */
const MAX_COUNTED_SLICES = 5000;

// ---------------------------------------------------------------------------------------------
// Slices
//
// A slice is { from, to, followers: [lo, hi] }: `from`/`to` are inclusive UTC epoch seconds and
// `hi` may be Infinity. Leaves are kept "created-major": the followers dimension is only ever
// split inside a created range that cannot be split further, so every set of leaves is a run of
// created ranges, each carrying one or more followers ranges that tile the root's.
// ---------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/;

function isoDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function isoSecond(seconds) {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

function parseDay(text) {
  const seconds = Date.parse(`${text}T00:00:00Z`) / 1000;
  // Date.parse rolls 2023-02-30 over to 2 March rather than rejecting it.
  if (!Number.isFinite(seconds) || isoDay(seconds) !== text) {
    throw new Error(`Invalid date in created: qualifier: ${text}`);
  }
  return seconds;
}

/** One end of a `created:` value as epoch seconds. `end` selects the inclusive upper edge. */
function parseInstant(text, end) {
  if (text === '*') return end ? LATEST_CREATED : EARLIEST_CREATED;
  if (DATE_RE.test(text)) {
    const start = parseDay(text);
    return end ? start + DAY_SECONDS - 1 : start;
  }
  const match = DATETIME_RE.exec(text);
  if (match) {
    parseDay(match[1]);
    // Without a zone GitHub reads UTC (verified: no-Z and Z give identical counts).
    const ms = Date.parse(match[5] ? text : `${text}Z`);
    if (!Number.isFinite(ms)) throw new Error(`Invalid datetime in created: qualifier: ${text}`);
    return ms / 1000;
  }
  throw new Error(`Unsupported created: value: ${text}`);
}

export function parseCreated(value) {
  if (value.includes('..')) {
    const [a, b] = value.split('..');
    return { from: parseInstant(a, false), to: parseInstant(b, true) };
  }
  const op = /^(>=|<=|>|<)(.+)$/.exec(value);
  if (op) {
    const [, sign, operand] = op;
    const step = DATETIME_RE.test(operand) ? 1 : DAY_SECONDS;
    if (sign === '>=') return { from: parseInstant(operand, false), to: LATEST_CREATED };
    if (sign === '>') return { from: parseInstant(operand, false) + step, to: LATEST_CREATED };
    if (sign === '<=') return { from: EARLIEST_CREATED, to: parseInstant(operand, true) };
    return { from: EARLIEST_CREATED, to: parseInstant(operand, false) - 1 };
  }
  return { from: parseInstant(value, false), to: parseInstant(value, true) };
}

function parseCount(text) {
  if (!/^\d+$/.test(text)) throw new Error(`Unsupported followers: value: ${text}`);
  return Number(text);
}

export function parseFollowers(value) {
  if (value.includes('..')) {
    const [a, b] = value.split('..');
    return [a === '*' ? 0 : parseCount(a), b === '*' ? Infinity : parseCount(b)];
  }
  const op = /^(>=|<=|>|<)(.+)$/.exec(value);
  if (op) {
    const n = parseCount(op[2]);
    if (op[1] === '>=') return [n, Infinity];
    if (op[1] === '>') return [n + 1, Infinity];
    if (op[1] === '<=') return [0, n];
    return [0, n - 1];
  }
  const n = parseCount(value);
  return [n, n];
}

// Any spelling GitHub might read as one of the two partitioned qualifiers, negated or not.
const mentionsCreated = (token) => /^-?created:/i.test(token);
const mentionsFollowers = (token) => /^-?followers:/i.test(token);

/**
 * Split a batch query such as
 *   'location:pakistan type:user repos:>3 followers:>1 created:2022-12-01..2023-02-28'
 * into the qualifiers that stay fixed (`base`) and the root slice this module partitions.
 */
export function parseShardQuery(query) {
  const tokens = String(query).trim().split(/\s+/).filter(Boolean);
  const created = tokens.filter(mentionsCreated);
  const followers = tokens.filter(mentionsFollowers);
  // Repeated qualifiers do not intersect in GitHub search, so two of either would not mean what a
  // reader expects. Refuse rather than guess.
  if (created.length > 1) throw new Error(`Query repeats created: - ${query}`);
  if (followers.length > 1) throw new Error(`Query repeats followers: - ${query}`);
  for (const token of [...created, ...followers]) {
    if (!/^(created|followers):/.test(token)) {
      throw new Error(`Unsupported form of a partitioned qualifier: ${token}`);
    }
  }

  const base = tokens.filter((t) => !mentionsCreated(t) && !mentionsFollowers(t)).join(' ');
  const range = created.length
    ? parseCreated(created[0].slice('created:'.length))
    : { from: EARLIEST_CREATED, to: LATEST_CREATED };
  const followerRange = followers.length
    ? parseFollowers(followers[0].slice('followers:'.length))
    : [0, Infinity];

  const root = { ...range, followers: followerRange };
  assertSlice(root);
  return { base, root };
}

export function assertSlice(slice) {
  const { from, to, followers } = slice || {};
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error(`Slice bounds must be integer seconds: ${JSON.stringify(slice)}`);
  }
  // An inverted range is not empty on GitHub - it counts as the forward range - so emitting one
  // would double-count.
  if (from > to) throw new Error(`Inverted created range: ${from} > ${to}`);
  if (!Array.isArray(followers) || followers.length !== 2) {
    throw new Error(`Slice needs a [lo, hi] followers range: ${JSON.stringify(slice)}`);
  }
  const [lo, hi] = followers;
  if (!Number.isInteger(lo) || lo < 0 || !(hi === Infinity || Number.isInteger(hi)) || lo > hi) {
    throw new Error(`Invalid followers range: [${lo}, ${hi}]`);
  }
}

function isDayAligned({ from, to }) {
  return from % DAY_SECONDS === 0 && (to + 1) % DAY_SECONDS === 0;
}

export function createdQualifier(slice) {
  assertSlice(slice);
  return isDayAligned(slice)
    ? `created:${isoDay(slice.from)}..${isoDay(slice.to)}`
    : `created:${isoSecond(slice.from)}..${isoSecond(slice.to)}`;
}

export function followersQualifier([lo, hi]) {
  if (lo === 0 && hi === Infinity) return '';
  // `>N` rather than `>=N+1`, so an unsplit root reads byte-for-byte like the batch's own query.
  if (hi === Infinity) return `followers:>${lo - 1}`;
  if (lo === hi) return `followers:${lo}`;
  return `followers:${lo}..${hi}`;
}

/**
 * The search string for one slice. This is the only place a query is built, and it refuses to
 * build one that GitHub would read differently from what it says: a base that already carries a
 * `created:` or `followers:` qualifier would put two of them in the query, and two `created:`
 * qualifiers make GitHub drop the filter and match everyone.
 */
export function toQuery(base, slice) {
  const tokens = String(base).trim().split(/\s+/).filter(Boolean);
  if (tokens.some(mentionsCreated) || tokens.some(mentionsFollowers)) {
    throw new Error(
      `Base query must not carry created: or followers: - the slice supplies both: ${base}`
    );
  }
  return [...tokens, followersQualifier(slice.followers), createdQualifier(slice)]
    .filter(Boolean)
    .join(' ');
}

function sameFollowers(a, b) {
  return a.followers[0] === b.followers[0] && a.followers[1] === b.followers[1];
}

function compareSlices(a, b) {
  return a.from - b.from || a.followers[0] - b.followers[0];
}

// ---------------------------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------------------------

/** Two contiguous, gap-free halves of `units` units starting at `start`. */
function halve(start, units, unitSeconds) {
  const mid = Math.floor(units / 2);
  return [
    [start, start + mid * unitSeconds - 1],
    [start + mid * unitSeconds, start + units * unitSeconds - 1]
  ];
}

export function splitFollowers([lo, hi]) {
  if (hi === Infinity) {
    if (lo >= MAX_SPLITTABLE_FOLLOWERS) return null;
    // Follower counts are heavy-tailed, so an open range splits geometrically: [2..5] [6..*],
    // then [6..13] [14..*], and so on.
    const cut = Math.max(lo + 1, 2 * lo + 2);
    return [
      [lo, cut - 1],
      [cut, Infinity]
    ];
  }
  if (hi === lo) return null;
  const cut = lo + Math.ceil((hi - lo + 1) / 2);
  return [
    [lo, cut - 1],
    [cut, hi]
  ];
}

/**
 * The two halves of a slice, in order, or null when it cannot be split any further. Whole days
 * first, then seconds within a day, then followers. The halves always tile the parent exactly.
 */
export function splitSlice(slice) {
  const span = slice.to - slice.from + 1;

  if (isDayAligned(slice) && span > DAY_SECONDS) {
    return halve(slice.from, span / DAY_SECONDS, DAY_SECONDS).map(([from, to]) => ({
      ...slice,
      from,
      to
    }));
  }

  if (span > 1) {
    return halve(slice.from, span, 1).map(([from, to]) => ({ ...slice, from, to }));
  }

  const parts = splitFollowers(slice.followers);
  return parts ? parts.map((followers) => ({ ...slice, followers })) : null;
}

// ---------------------------------------------------------------------------------------------
// Partition
// ---------------------------------------------------------------------------------------------

function checkCounts(counts, expected) {
  if (!Array.isArray(counts) || counts.length !== expected) {
    throw new Error(`count() returned ${counts?.length} results for ${expected} queries`);
  }
  counts.forEach((c, i) => {
    if (!Number.isInteger(c) || c < 0) throw new Error(`count() result ${i} is not a count: ${c}`);
  });
}

/**
 * Breadth-first partition of several start slices at once, so each level costs one batched
 * count() call however many slices are splitting. A start may carry a known `count`.
 *
 * Returns the fine leaves (each below SPLIT_AT, or `irreducible`) tagged with the index of the
 * start they came from, every start's count, and stats including an additivity check of every
 * split: count(parent) must equal the sum of its children.
 *
 * @param {Array<{slice, count?}>} starts
 * @param {{base: string, count: (queries: string[]) => Promise<number[]>}} io
 */
export async function partitionMany(starts, io) {
  if (typeof io?.count !== 'function') throw new Error('partition needs a count(queries) function');

  const stats = {
    countCalls: 0,
    slicesCounted: 0,
    levels: 0,
    additivityChecks: 0,
    additivityMismatches: []
  };
  const roots = starts.map(({ slice, count }, start) => {
    assertSlice(slice);
    return { slice, depth: 0, start, count: count ?? null };
  });
  const leaves = [];
  let frontier = roots;
  let parents = [];

  while (frontier.length > 0) {
    const unknown = frontier.filter((n) => n.count == null);
    if (unknown.length > 0) {
      if (stats.slicesCounted + unknown.length > MAX_COUNTED_SLICES) {
        throw new Error(
          `Partition budget exceeded: ${stats.slicesCounted + unknown.length} slices counted ` +
            `(max ${MAX_COUNTED_SLICES}). The counter may be returning a constant.`
        );
      }
      const counts = await io.count(unknown.map((n) => toQuery(io.base, n.slice)));
      checkCounts(counts, unknown.length);
      unknown.forEach((n, i) => (n.count = counts[i]));
      stats.countCalls += 1;
      stats.slicesCounted += unknown.length;
    }

    // Every split doubles as a live check of the boundary semantics this module relies on.
    for (const parent of parents) {
      const sum = parent.children.reduce((s, c) => s + c.count, 0);
      stats.additivityChecks += 1;
      if (sum !== parent.count) {
        stats.additivityMismatches.push({
          query: toQuery(io.base, parent.slice),
          parent: parent.count,
          sum
        });
      }
    }

    parents = [];
    const next = [];
    for (const node of frontier) {
      const leaf = { slice: node.slice, count: node.count, start: node.start };
      if (node.count < SPLIT_AT) {
        leaves.push(leaf);
        continue;
      }
      const parts = node.depth < MAX_DEPTH ? splitSlice(node.slice) : null;
      if (!parts) {
        // The finest grain there is and still not under SPLIT_AT. Still listable if it fits a page;
        // the lister reports it as incomplete if it does not, rather than truncating it.
        leaves.push({ ...leaf, irreducible: true });
        continue;
      }
      node.children = parts.map((slice) => ({
        slice,
        depth: node.depth + 1,
        start: node.start,
        count: null
      }));
      parents.push(node);
      next.push(...node.children);
    }

    if (next.length > 0) stats.levels += 1;
    frontier = next;
  }

  leaves.sort((a, b) => compareSlices(a.slice, b.slice));
  return { leaves, startCounts: roots.map((r) => r.count), stats };
}

// ---------------------------------------------------------------------------------------------
// Tiling and packing
// ---------------------------------------------------------------------------------------------

/**
 * Throw unless `leaves` tile `root` exactly: created ranges contiguous from root.from to root.to
 * with no gap or overlap, and within each created range the followers ranges tiling root's.
 */
export function assertTiling(root, leaves) {
  assertSlice(root);
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('No leaves to tile the root');
  const sorted = [...leaves].sort((a, b) => compareSlices(a.slice, b.slice));
  let cursor = root.from;
  let i = 0;

  while (i < sorted.length) {
    const { from, to } = sorted[i].slice;
    if (from > cursor) throw new Error(`Gap in created coverage: ${isoSecond(cursor)} not covered`);
    if (from < cursor) throw new Error(`Overlap in created coverage at ${isoSecond(from)}`);

    const group = [];
    while (i < sorted.length && sorted[i].slice.from === from) {
      assertSlice(sorted[i].slice);
      group.push(sorted[i]);
      i += 1;
    }
    if (group.some((leaf) => leaf.slice.to !== to)) {
      throw new Error(`Overlap: created ranges starting ${isoSecond(from)} end at different times`);
    }

    let next = root.followers[0];
    for (const leaf of group) {
      const [lo, hi] = leaf.slice.followers;
      if (lo !== next) {
        throw new Error(
          `${lo > next ? 'Gap' : 'Overlap'} in followers coverage at ${isoSecond(from)}: ` +
            `expected followers >= ${next}, got [${lo}, ${hi}]`
        );
      }
      next = hi === Infinity ? Infinity : hi + 1;
    }
    const end = root.followers[1] === Infinity ? Infinity : root.followers[1] + 1;
    if (next !== end) throw new Error(`Followers coverage at ${isoSecond(from)} stops short`);

    cursor = to + 1;
  }

  if (cursor !== root.to + 1) {
    throw new Error(
      cursor <= root.to
        ? `Gap in created coverage: ${isoSecond(cursor)}..${isoSecond(root.to)} not covered`
        : `Leaves extend past the root to ${isoSecond(cursor - 1)}`
    );
  }
  return true;
}

function mergePair(a, b) {
  const merged = {
    slice: {
      from: Math.min(a.slice.from, b.slice.from),
      to: Math.max(a.slice.to, b.slice.to),
      followers: [
        Math.min(a.slice.followers[0], b.slice.followers[0]),
        Math.max(a.slice.followers[1], b.slice.followers[1])
      ]
    },
    // Exact, because counts are additive across these boundaries.
    count: a.count + b.count
  };
  if (a.start != null) merged.start = a.start;
  return merged;
}

/**
 * Pack neighbouring leaves while their combined count stays at or below `packTo`: first the
 * followers sub-ranges inside one created range, then neighbouring created ranges that span the
 * root's whole followers range. Irreducible leaves never merge. The result still tiles `root`.
 */
export function packLeaves(root, leaves, packTo = PACK_TO) {
  const sorted = [...leaves].sort((a, b) => compareSlices(a.slice, b.slice));

  const followersMerged = [];
  for (const leaf of sorted) {
    const prev = followersMerged[followersMerged.length - 1];
    const canMerge =
      prev &&
      !prev.irreducible &&
      !leaf.irreducible &&
      prev.slice.from === leaf.slice.from &&
      prev.slice.to === leaf.slice.to &&
      prev.slice.followers[1] !== Infinity &&
      prev.slice.followers[1] + 1 === leaf.slice.followers[0] &&
      prev.count + leaf.count <= packTo;
    if (canMerge) followersMerged[followersMerged.length - 1] = mergePair(prev, leaf);
    else followersMerged.push(leaf);
  }

  const out = [];
  for (const leaf of followersMerged) {
    const prev = out[out.length - 1];
    const canMerge =
      prev &&
      !prev.irreducible &&
      !leaf.irreducible &&
      sameFollowers(prev.slice, root) &&
      sameFollowers(leaf.slice, root) &&
      prev.slice.to + 1 === leaf.slice.from &&
      prev.count + leaf.count <= packTo;
    if (canMerge) out[out.length - 1] = mergePair(prev, leaf);
    else out.push(leaf);
  }

  assertTiling(root, out);
  return out;
}

/**
 * Partition several disjoint roots in one breadth-first pass, then pack each root's leaves.
 * Returns, per root, its count and its packed leaves in created order.
 */
export async function partitionRoots(roots, io) {
  const sorted = [...roots].sort(compareSlices);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].from <= sorted[i - 1].to) {
      throw new Error('Batch ranges overlap; a developer would be listed twice');
    }
  }

  const { leaves, startCounts, stats } = await partitionMany(
    roots.map((slice) => ({ slice })),
    io
  );
  const perRoot = roots.map((root, index) => {
    const own = leaves.filter((leaf) => leaf.start === index);
    assertTiling(root, own);
    return {
      root,
      count: startCounts[index],
      fineLeaves: own.length,
      leaves: packLeaves(root, own)
    };
  });
  return { roots: perRoot, stats };
}
