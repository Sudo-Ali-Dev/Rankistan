/**
 * Lists every developer a batch's search matches, or says exactly which part it could not.
 *
 * A batch is one or more `created:` ranges from SEARCH_BATCHES. partition.js cuts them into leaves
 * of at most PACK_TO developers; this lists each leaf in a single request and decides, leaf by
 * leaf, whether the listing can be trusted.
 *
 * A leaf is complete only when
 *   - the response carried no error, with one exception: NOT_FOUND scoped to a single node, a
 *     search hit whose account no longer resolves, is evidence about that node alone. The node is
 *     dropped and the rest of the response kept;
 *   - every node carries a databaseId, a login and a createdAt inside the leaf's own range. A null
 *     field is unmeasured, never a fact about the developer;
 *   - the distinct databaseIds, plus any not-found nodes, equal the leaf's userCount.
 *
 * Developers are keyed on databaseId, not login. A login can be renamed between two requests and
 * then claimed by someone else; the id cannot.
 *
 * Candidates come only from complete leaves. An incomplete leaf contributes nobody this run, so its
 * developers are not evaluated, which run-all.js treats as not seen: their rows are carried forward,
 * not removed.
 *
 * Failures split rather than retry at the same size. A 502, a discarded response or an incomplete
 * listing halves the leaf, which also corners a single bad node in a few developers instead of
 * losing a whole leaf to it; a leaf that outgrew a page between counting and listing is
 * re-partitioned from its new count. Only a leaf that cannot be split any further, or a batch that
 * has spent its re-split budget, is retried as it is.
 */

import {
  PACK_TO,
  PAGE_SIZE,
  SPLIT_AT,
  packLeaves,
  parseShardQuery,
  partitionMany,
  partitionRoots,
  splitSlice,
  toQuery
} from './partition.js';
import { MAX_DISCARD_RETRIES, RateLimitError } from './graphql.js';

/** Halvings of one packed leaf before it is given up on: a full leaf of 95 down to about 6. */
export const MAX_RESPLIT_DEPTH = 4;
/**
 * Re-splits one batch may spend before failing leaves are recorded as they are. The live runs of
 * 2026-10-13 needed none across 29 leaves. Eight is enough to corner two persistent bad nodes at
 * full depth, and it stops a systemic failure from multiplying a batch's requests.
 */
export const MAX_RESPLITS_PER_BATCH = 8;
const RETRY_BASE_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sum = (values) => values.reduce((total, value) => total + value, 0);

function summarize(problems) {
  const shown = problems.slice(0, 3).join('; ');
  return problems.length > 3 ? `${shown} (+${problems.length - 3} more)` : shown;
}

/**
 * Judge one listing response for one leaf. Pure.
 *
 * @returns {{query, slice, complete: boolean, count: number, countedAs: number,
 *            listedIds: number[], users: Array<{id, login}>, notFound: number,
 *            duplicates: number, reason: string|null}}
 */
export function measureListing(leaf, query, { userCount, nodes, notFound = [] }) {
  const problems = [];
  const missing = new Set();
  for (const index of notFound) {
    if (index >= 0 && index < nodes.length) missing.add(index);
    else problems.push(`a NOT_FOUND error points at node ${index}, which the page does not have`);
  }

  const users = new Map();
  let duplicates = 0;
  nodes.forEach((node, index) => {
    if (missing.has(index)) return;
    if (node == null) {
      problems.push(`node ${index} is null with no error to explain it`);
      return;
    }
    const { databaseId: id, login, createdAt } = node;
    if (!Number.isInteger(id) || typeof login !== 'string' || login === '') {
      problems.push(`node ${index} came back without a databaseId or login`);
      return;
    }
    const created = Date.parse(createdAt) / 1000;
    if (!Number.isFinite(created)) {
      problems.push(`${login} came back without createdAt`);
      return;
    }
    // GitHub matched this account to the leaf's created: range, so its own createdAt must fall
    // inside it. One that does not means the query did not filter as written.
    if (created < leaf.slice.from || created > leaf.slice.to) {
      problems.push(`${login} was created ${createdAt}, outside this leaf`);
      return;
    }
    if (users.has(id)) {
      duplicates += 1;
      return;
    }
    users.set(id, { id, login });
  });

  if (users.size + missing.size !== userCount) {
    const extra = missing.size ? ` (+${missing.size} not found)` : '';
    problems.push(`listed ${users.size}${extra} of ${userCount}`);
  }

  const complete = problems.length === 0;
  return {
    query,
    slice: leaf.slice,
    complete,
    count: userCount,
    countedAs: leaf.count,
    listedIds: [...users.keys()],
    users: [...users.values()],
    notFound: missing.size,
    duplicates,
    reason: complete ? null : summarize(problems)
  };
}

function unlisted(leaf, query, count, reason) {
  return {
    query,
    slice: leaf.slice,
    complete: false,
    count,
    countedAs: leaf.count,
    listedIds: [],
    users: [],
    notFound: 0,
    duplicates: 0,
    reason
  };
}

/**
 * Partition one batch, list every leaf, and report what was and was not measured.
 *
 * Throws when the partition itself cannot be built - a range that cannot be counted has no leaves
 * to report on - and on a fatal response such as a rejected credential, which no later leaf would
 * survive either. Every other listing failure is recorded on its leaf.
 *
 * @param {{label: string, queries: string[]}} batch
 * @param {{count, list, usage, sleep?}} client  from createSearchClient; retries wait on its sleep
 */
export async function discoverBatch({ label, queries }, client, options = {}) {
  const sleep = options.sleep || client.sleep || defaultSleep;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(`Batch ${label} has no search query`);
  }
  const parsed = queries.map((q) => parseShardQuery(q));
  const base = parsed[0].base;
  if (parsed.some((p) => p.base !== base)) {
    throw new Error(`Batch ${label} uses different qualifiers across its ranges`);
  }
  const io = { base, count: (batch) => client.count(batch) };
  const before = client.usage();

  const { roots, stats } = await partitionRoots(
    parsed.map((p) => p.root),
    io
  );
  const rootCount = sum(roots.map((r) => r.count));
  const resplits = [];

  /** Smaller leaves to list instead of this one, or null when it cannot be split. */
  async function smallerLeaves(leaf, failure) {
    try {
      if (failure.kind === 'overflow') {
        // It outgrew a page between counting and listing: re-partition from the count it has now.
        const { leaves } = await partitionMany([{ slice: leaf.slice, count: failure.count }], io);
        const packed = packLeaves(leaf.slice, leaves);
        return packed.length > 1 ? packed : null;
      }
      const halves = splitSlice(leaf.slice);
      if (!halves) return null;
      const counts = await client.count(halves.map((slice) => toQuery(base, slice)));
      return halves.map((slice, i) => ({ slice, count: counts[i] }));
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return null;
    }
  }

  async function listLeaf(leaf, depth) {
    const query = toQuery(base, leaf.slice);
    let failure = null;

    for (let attempt = 0; attempt <= MAX_DISCARD_RETRIES; attempt += 1) {
      const response = await client.list(query, { first: PAGE_SIZE });
      if (!response.ok) {
        failure = { kind: 'discarded', reason: response.reason, count: leaf.count };
      } else if (response.userCount > PAGE_SIZE || response.hasNextPage) {
        failure = {
          kind: 'overflow',
          reason: `${response.userCount} now match, more than one page`,
          count: response.userCount
        };
      } else {
        const measured = measureListing(leaf, query, response);
        if (measured.complete) return [measured];
        failure = { kind: 'incomplete', reason: measured.reason, count: measured.count, measured };
      }

      const canSplit = depth < MAX_RESPLIT_DEPTH && resplits.length < MAX_RESPLITS_PER_BATCH;
      const parts = canSplit ? await smallerLeaves(leaf, failure) : null;
      if (parts) {
        resplits.push({ query, reason: failure.reason, parts: parts.length });
        const results = [];
        for (const part of parts) results.push(...(await listLeaf(part, depth + 1)));
        return results;
      }
      // A leaf too big for one page will not shrink on a retry.
      if (failure.kind === 'overflow') break;
      if (attempt < MAX_DISCARD_RETRIES) await sleep(RETRY_BASE_MS * (attempt + 1));
    }
    return [failure.measured ?? unlisted(leaf, query, failure.count, failure.reason)];
  }

  const leaves = [];
  let stoppedBy = null;
  for (const leaf of roots.flatMap((r) => r.leaves)) {
    const query = toQuery(base, leaf.slice);
    if (stoppedBy) {
      leaves.push(unlisted(leaf, query, leaf.count, `not listed: ${stoppedBy}`));
      continue;
    }
    try {
      leaves.push(...(await listLeaf(leaf, 0)));
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      // Still limited after backing off. Every further request would wait out the same limit, so
      // the rest of the batch is recorded as unlisted rather than queued behind it.
      stoppedBy = error.message;
      leaves.push(unlisted(leaf, query, leaf.count, `not listed: ${stoppedBy}`));
    }
  }

  const candidates = new Map();
  let listedTwice = 0;
  for (const leaf of leaves) {
    if (!leaf.complete) continue;
    for (const user of leaf.users) {
      if (candidates.has(user.id)) listedTwice += 1;
      else candidates.set(user.id, user);
    }
  }

  // The leaves tile the range, so their counts must add up to the range's own. A shortfall means
  // someone sits in no leaf; an excess, in two.
  const leafSum = sum(leaves.map((l) => l.count));
  const problems = [];
  const [mismatch] = stats.additivityMismatches;
  if (mismatch) {
    problems.push(
      `${stats.additivityMismatches.length} split(s) did not add up, first ` +
        `${mismatch.query}: ${mismatch.parent} against ${mismatch.sum}`
    );
  }
  if (leafSum !== rootCount) {
    problems.push(`its leaves sum to ${leafSum} but the range counts ${rootCount}`);
  }
  if (listedTwice > 0) problems.push(`${listedTwice} developer(s) were listed by two leaves`);

  const after = client.usage();
  return {
    label,
    base,
    rootCount,
    ranges: roots.map((r) => ({ query: toQuery(base, r.root), count: r.count })),
    leaves,
    candidates: [...candidates.values()],
    sum: {
      root: rootCount,
      leaves: leafSum,
      listed: candidates.size,
      notFound: sum(leaves.map((l) => l.notFound)),
      valid: problems.length === 0
    },
    problems,
    stats: {
      fineLeaves: sum(roots.map((r) => r.fineLeaves)),
      slicesCounted: stats.slicesCounted,
      levels: stats.levels,
      resplits,
      requests: after.requests - before.requests,
      points: after.points - before.points,
      discarded: after.discarded - before.discarded,
      remaining: after.remaining
    }
  };
}

/** Escape a workflow-command message, so a reason cannot break or forge an annotation. */
function annotation(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function leafName(base, query) {
  return query.startsWith(`${base} `) ? query.slice(base.length + 1) : query;
}

/** Log lines for one batch report: `info` for the run log, `warnings` as Actions annotations. */
export function describeDiscovery(report) {
  const { label, base, leaves, stats } = report;
  const complete = leaves.filter((l) => l.complete).length;
  const info = [
    `  ${report.rootCount} match across ${report.ranges.length} range(s): ` +
      `${leaves.length} leaves, ${complete} complete, ${report.candidates.length} candidates.`,
    `  partition: ${stats.fineLeaves} slices under ${SPLIT_AT} packed into leaves of at most ` +
      `${PACK_TO}; ${stats.slicesCounted} slices counted over ${stats.levels + 1} levels.`,
    `  GraphQL: ${stats.points} points over ${stats.requests} requests` +
      (stats.remaining == null ? '.' : ` (${stats.remaining} left this hour).`)
  ];
  for (const resplit of stats.resplits) {
    info.push(
      `  re-split ${leafName(base, resplit.query)} into ${resplit.parts}: ${resplit.reason}`
    );
  }
  if (report.sum.notFound > 0) {
    info.push(
      `  ${report.sum.notFound} search hit(s) no longer resolve to an account (NOT_FOUND) ` +
        `and are not candidates.`
    );
  }

  // When the counts do not add up, say where. A shortfall seen only as a total cannot be traced
  // to the leaves that lost people; one line per leaf can.
  if (!report.sum.valid) {
    for (const range of report.ranges) info.push(`  range ${range.query}: counted ${range.count}`);
    for (const leaf of leaves) {
      info.push(
        `  leaf ${leafName(base, leaf.query)}: counted ${leaf.count}, listed ` +
          `${leaf.listedIds ? leaf.listedIds.length : '?'}${leaf.complete ? '' : ` (incomplete: ${leaf.reason})`}`
      );
    }
  }

  const warnings = [];
  for (const leaf of leaves) {
    if (leaf.complete) continue;
    warnings.push(
      `::warning title=Discovery::${annotation(
        `${label}: leaf ${leafName(base, leaf.query)} is incomplete (${leaf.reason}). ` +
          `Its ${leaf.count} developer(s) were not listed this run.`
      )}`
    );
  }
  for (const problem of report.problems) {
    warnings.push(`::warning title=Discovery::${annotation(`${label}: ${problem}.`)}`);
  }
  return { info, warnings };
}
