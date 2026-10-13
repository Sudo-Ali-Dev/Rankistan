// Self-registration and opt-out, read from GitHub issues and keyed on the numeric account id.
//
// Registration is opening an issue from .github/ISSUE_TEMPLATE/register.yml, which labels it
// `registration`; opting out is opening one from remove-me.yml, labelled `opt-out`. The account
// that opened the issue is the account it is about. Nothing in the title or body is ever read for
// identity, so nobody can register or remove anyone but themselves.
//
// Registration replaces exactly one gate: the location search. Discovery finds developers whose
// location says Pakistan or names one of its cities (scripts/discovery/locations.js), so anyone
// else is never a candidate; a registration makes them one, in the batch whose `created:` range
// holds their account. Every other gate still applies to them. Search's own `repos:` and `followers:` qualifiers are checked
// here, since a registered developer never passed through search, and account age and activity
// are applied by fetch-devs.js to every candidate alike.
//
// The rules for reading the issues:
//   - An author's latest intent wins, by when the issue was opened. An opt-out filed after a
//     registration removes them; a registration filed after an opt-out brings them back.
//   - A registration a maintainer closed as `not_planned` is rejected and counts for nothing.
//     Closing as completed, which the acknowledgement workflow does, changes nothing.
//   - An opt-out counts however it was closed. Nobody can keep someone on the board who asked to
//     leave.
//   - Pull requests are ignored, and so are authors that are not a `User`, and the `ghost`
//     placeholder GitHub assigns a deleted account's issues to.
//
// Opt-outs fail closed. readRegistry throws on any failure, and run-all.js reads it before
// measuring, so a run that cannot read the opt-outs never saves or publishes. An issues-API blip
// costs one hourly batch; republishing someone who asked to leave costs more.
//
// Opt-outs are matched on the account id: `github_id` on rows the pipeline has measured since
// this file was added, otherwise the id inside `avatar_url`
// (https://avatars.githubusercontent.com/u/<id>?v=4), which every row on the board carried on
// 2026-10-13. A login can be renamed and then claimed by someone else; the id cannot.
//
// Budget per run: one REST request per label (100 issues a page), and one GraphQL point per 100
// registered developers, spent only when there are any.

import { annotation } from './discovery/discover.js';
import { DISCOVERY_SOURCES } from './discovery/locations.js';
import { parseFollowers, parseShardQuery } from './discovery/partition.js';

export const REGISTRATION_LABEL = 'registration';
export const OPT_OUT_LABEL = 'opt-out';

export const ISSUES_PER_PAGE = 100;
/** A paging loop that has not ended by here is a bug, not a registry. */
const MAX_ISSUE_PAGES = 100;
/** `nodes(ids:)` takes at most 100 ids. */
export const NODES_PER_REQUEST = 100;
/** GitHub's placeholder for deleted accounts: every issue they opened now belongs to it. */
export const GHOST_ACCOUNT_ID = 10137;

const RESOLVE_RETRIES = 2;
const RESOLVE_RETRY_MS = 5000;

const AVATAR_ID = /^https:\/\/avatars\d*\.githubusercontent\.com\/u\/(\d+)(?:[?/#]|$)/;

const isAccountId = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * The numeric account id of a leaderboard row: `github_id` when the row has it, else the id in its
 * avatar URL. `null` when neither is there.
 */
export function rowGithubId(row) {
  if (isAccountId(row?.github_id)) return row.github_id;
  const match = AVATAR_ID.exec(String(row?.avatar_url ?? ''));
  const id = match ? Number(match[1]) : null;
  return isAccountId(id) ? id : null;
}

const labelNames = (issue) =>
  (Array.isArray(issue?.labels) ? issue.labels : []).map((label) =>
    typeof label === 'string' ? label : label?.name
  );

/** `opt-out`, `register`, or null. An issue carrying both labels is an opt-out. */
export function intentOf(issue) {
  const names = labelNames(issue);
  if (names.includes(OPT_OUT_LABEL)) return 'opt-out';
  if (names.includes(REGISTRATION_LABEL)) return 'register';
  return null;
}

function assertIssue(issue) {
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error(`An issue came back without a number: ${JSON.stringify(issue)?.slice(0, 200)}`);
  }
  if (!Number.isFinite(Date.parse(issue.created_at))) {
    throw new Error(`Issue #${issue.number} came back without created_at.`);
  }
  if (issue.pull_request) return;
  const user = issue.user;
  if (!user || typeof user.type !== 'string' || !isAccountId(user.id)) {
    throw new Error(`Issue #${issue.number} came back without its author's account id and type.`);
  }
  if (user.type === 'User' && (typeof user.node_id !== 'string' || !user.node_id)) {
    throw new Error(`Issue #${issue.number} came back without its author's node_id.`);
  }
}

/**
 * Each author's latest intent, from their labelled issues. Pure.
 *
 * Throws on an issue it cannot attribute: an unreadable record is a failed read, and a failed
 * read must not be mistaken for "nobody opted out".
 *
 * @returns {{ registered: Array<{id, nodeId, login, issueNumber, at}>, optedOut: Set<number>,
 *             counts: { issues, ignored, rejected } }}
 */
export function resolveIntents(issues) {
  const byNumber = new Map();
  for (const issue of issues || []) {
    assertIssue(issue);
    byNumber.set(issue.number, issue);
  }
  // Oldest first, so each later intent overwrites the one before. The issue number, which only
  // grows, breaks a tie inside one second.
  const ordered = [...byNumber.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number
  );

  const latest = new Map();
  let ignored = 0;
  let rejected = 0;
  for (const issue of ordered) {
    const intent = intentOf(issue);
    const user = issue.user;
    if (issue.pull_request || !intent || user.type !== 'User' || user.id === GHOST_ACCOUNT_ID) {
      ignored += 1;
      continue;
    }
    if (intent === 'register' && issue.state_reason === 'not_planned') {
      rejected += 1;
      continue;
    }
    latest.set(user.id, { intent, issue });
  }

  const registered = [];
  const optedOut = new Set();
  for (const [id, { intent, issue }] of latest) {
    if (intent === 'opt-out') {
      optedOut.add(id);
    } else {
      registered.push({
        id,
        nodeId: issue.user.node_id,
        login: issue.user.login,
        issueNumber: issue.number,
        at: issue.created_at
      });
    }
  }
  registered.sort((a, b) => a.issueNumber - b.issueNumber);
  return { registered, optedOut, counts: { issues: byNumber.size, ignored, rejected } };
}

/**
 * Every registration and opt-out on the repository, read through `api`, a client with
 * `json('GET', route)` against the repository (state-store.js makeGitHubClient).
 *
 * Throws on any failure. Never returns a partial registry.
 */
export async function readRegistry({ api, perPage = ISSUES_PER_PAGE }) {
  const issues = [];
  let requests = 0;
  for (const label of [REGISTRATION_LABEL, OPT_OUT_LABEL]) {
    for (let page = 1; ; page += 1) {
      if (page > MAX_ISSUE_PAGES) {
        throw new Error(`The \`${label}\` issues did not end within ${MAX_ISSUE_PAGES} pages.`);
      }
      // Oldest first: an issue opened while this pages lands on the last page rather than
      // shifting every page after it.
      const route =
        `/issues?labels=${encodeURIComponent(label)}&state=all&sort=created&direction=asc` +
        `&per_page=${perPage}&page=${page}`;
      const batch = await api.json('GET', route);
      requests += 1;
      if (!Array.isArray(batch)) {
        throw new Error(`Listing the \`${label}\` issues returned ${typeof batch}, not a list.`);
      }
      issues.push(...batch);
      if (batch.length < perPage) break;
    }
  }
  return { ...resolveIntents(issues), complete: true, requests };
}

/** No registrations and no opt-outs, for a run that reads none: the dry run, and tests. */
export function emptyRegistry(note = null) {
  return {
    registered: [],
    optedOut: new Set(),
    counts: { issues: 0, ignored: 0, rejected: 0 },
    complete: true,
    requests: 0,
    note
  };
}

/**
 * Calls `read` and checks what it returned, or stops the run. The `::error::` names the cause in
 * the Actions run, and the throw reaches run-all.js before anything is saved.
 */
export async function loadRegistry(read, log = console) {
  try {
    if (typeof read !== 'function') {
      throw new Error('no registry reader was given, and opt-outs must be applied on every run');
    }
    const registry = await read();
    if (
      registry?.complete !== true ||
      !(registry.optedOut instanceof Set) ||
      !Array.isArray(registry.registered)
    ) {
      throw new Error('the registry reader returned something other than a complete registry');
    }
    log.log(
      registry.note
        ? `Registry: ${registry.note}.`
        : `Registry: ${registry.registered.length} registered, ${registry.optedOut.size} opted ` +
            `out, from ${registry.counts.issues} issue(s) in ${registry.requests} request(s)` +
            (registry.counts.rejected ? `; ${registry.counts.rejected} rejected` : '') +
            (registry.counts.ignored ? `; ${registry.counts.ignored} ignored` : '') +
            '.'
    );
    return registry;
  } catch (error) {
    const message =
      'Could not read the registration and opt-out issues, so this run saves and publishes ' +
      `nothing: ${error.message}`;
    log.log(`::error title=REGISTRY_UNREADABLE::${annotation(message)}`);
    throw new Error(message);
  }
}

/** `rows` without anyone in `optedOut`, by account id. Pure. */
export function withoutOptedOut(rows, optedOut) {
  if (!optedOut?.size) return rows;
  return rows.filter((row) => !optedOut.has(rowGithubId(row)));
}

/**
 * Takes everyone in `optedOut` off the board, whatever batch owns their row, with the reason
 * guardBoard needs: `{username, batch_index, reason: 'opted_out'}`.
 */
export function applyOptOuts(rows, optedOut, log = console) {
  const kept = [];
  const removed = [];
  let unkeyed = 0;
  for (const row of rows) {
    const id = rowGithubId(row);
    if (id == null) unkeyed += 1;
    if (id != null && optedOut?.has(id)) {
      removed.push({ username: row.username, batch_index: row.batch_index, reason: 'opted_out' });
    } else {
      kept.push(row);
    }
  }
  if (removed.length > 0) {
    const names = removed.map((r) => `${r.username} (batch ${r.batch_index})`);
    log.log(`Opt-outs: removed ${removed.length} from the board: ${names.join(', ')}.`);
  }
  if (unkeyed > 0) {
    log.warn(
      `::warning title=Registry::${unkeyed} row(s) carry no account id, in github_id or ` +
        'avatar_url, so an opt-out cannot reach them.'
    );
  }
  return { kept, removed };
}

const queriesOf = (batch) =>
  Array.isArray(batch?.queries) && batch.queries.length > 0
    ? batch.queries
    : typeof batch?.q === 'string' && batch.q
      ? [batch.q]
      : [];

/**
 * The batch whose `created:` range holds an account created at `createdAt`, and the query that
 * matched, or null. Ranges are read the way discovery reads them (partition.js): inclusive at both
 * ends, in UTC, to the second.
 */
export function rangeForCreatedAt(createdAt, batches) {
  const seconds = Date.parse(createdAt) / 1000;
  if (!Number.isFinite(seconds)) return null;
  for (let index = 0; index < batches.length; index += 1) {
    for (const query of queriesOf(batches[index])) {
      const { root } = parseShardQuery(query);
      if (seconds >= root.from && seconds <= root.to) return { batchIndex: index, query };
    }
  }
  return null;
}

/** The index of the batch that evaluates an account created at `createdAt`, or null. */
export function batchForCreatedAt(createdAt, batches) {
  return rangeForCreatedAt(createdAt, batches)?.batchIndex ?? null;
}

/**
 * The gates a batch's search applies that a registration must not skip: its `repos:` and
 * `followers:` ranges. Location is the one qualifier a registration replaces, and `type:user` is
 * already settled by the issue author's type. Any other qualifier throws, so a gate added to the
 * search later cannot be bypassed by registering.
 */
export function registrationGates(query) {
  const { base, root } = parseShardQuery(query);
  let repos = [0, Infinity];
  // A quoted value, such as a city of two words, is one qualifier.
  for (const token of base.match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    if (/^-?location:/i.test(token) || /^type:user$/i.test(token)) continue;
    const reposMatch = /^repos:(.+)$/i.exec(token);
    if (reposMatch) {
      repos = parseFollowers(reposMatch[1]);
      continue;
    }
    throw new Error(`A registration cannot apply the search qualifier ${token}.`);
  }
  return { repos, followers: root.followers };
}

const within = (value, [lo, hi]) => Number.isFinite(value) && value >= lo && value <= hi;

/** Whether a fetched profile meets its batch's search gates. */
export function passesRegistrationGates(developer, gates) {
  return (
    within(Number(developer?.public_repos), gates.repos) &&
    within(Number(developer?.followers), gates.followers)
  );
}

const NODES_DOCUMENT = `query($ids: [ID!]!) {
  rateLimit { cost remaining resetAt }
  nodes(ids: $ids) { __typename ... on User { databaseId login createdAt location } }
}`;

/**
 * Each registered account's current login and createdAt, from GraphQL `nodes(ids:)`, at most
 * NODES_PER_REQUEST per request.
 *
 * `graphql.query(document, variables)` is the discovery client's request (discovery/graphql.js):
 * rate limits already waited out, and the answer classified `ok`, `partial` or `gateway`. A
 * gateway failure is retried. A node GitHub reports NOT_FOUND, or that is not a user, is an
 * account that no longer exists as one: it is returned in `unresolved`. Anything else throws.
 *
 * @returns {Promise<{ resolved: Array<{id, login, createdAt, location, issueNumber}>,
 *                     unresolved: Array<{id, login, issueNumber, reason}>, requests: number }>}
 */
export async function resolveRegistered({
  graphql,
  registered,
  sleep = graphql?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
}) {
  const resolved = [];
  const unresolved = [];
  let requests = 0;

  for (let start = 0; start < registered.length; start += NODES_PER_REQUEST) {
    const chunk = registered.slice(start, start + NODES_PER_REQUEST);
    let outcome;
    for (let attempt = 0; ; attempt += 1) {
      outcome = await graphql.query(NODES_DOCUMENT, { ids: chunk.map((entry) => entry.nodeId) });
      requests += 1;
      if (outcome?.kind !== 'gateway') break;
      if (attempt >= RESOLVE_RETRIES) {
        throw new Error(`Resolving registered accounts failed: ${outcome.reason}`);
      }
      await sleep(RESOLVE_RETRY_MS * (attempt + 1));
    }

    const notFound = new Set();
    const other = [];
    for (const error of outcome.errors || []) {
      const path = error?.path;
      if (error?.type === 'NOT_FOUND' && path?.[0] === 'nodes' && Number.isInteger(path[1])) {
        notFound.add(path[1]);
      } else {
        other.push(error);
      }
    }
    if (other.length > 0) {
      const first = other[0];
      throw new Error(
        `Resolving registered accounts failed: ${first?.type || 'error'}: ` +
          `${String(first?.message || '').slice(0, 200)}`
      );
    }
    const nodes = outcome.data?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== chunk.length) {
      throw new Error(
        `Resolving registered accounts returned no node for each of ${chunk.length} ids.`
      );
    }

    chunk.forEach((entry, index) => {
      const node = nodes[index];
      const gone = (reason) =>
        unresolved.push({
          id: entry.id,
          login: entry.login,
          issueNumber: entry.issueNumber,
          reason
        });
      if (notFound.has(index)) return gone('the account no longer exists');
      // A null with no error to explain it is unmeasured, never a fact about the account.
      if (node == null) throw new Error(`Node ${entry.nodeId} came back null with no error.`);
      if (node.__typename !== 'User') return gone(`it is now a ${node.__typename}, not a user`);
      if (node.databaseId !== entry.id) {
        throw new Error(
          `Node ${entry.nodeId} resolved to account ${node.databaseId}, not ${entry.id}.`
        );
      }
      if (
        typeof node.login !== 'string' ||
        !node.login ||
        !Number.isFinite(Date.parse(node.createdAt))
      ) {
        throw new Error(`Account ${entry.id} came back without a login or createdAt.`);
      }
      resolved.push({
        id: entry.id,
        login: node.login,
        createdAt: node.createdAt,
        location: node.location ?? '',
        issueNumber: entry.issueNumber
      });
    });
  }
  return { resolved, unresolved, requests };
}

/**
 * One batch's candidates once the registry is applied: discovered developers minus anyone who
 * opted out, plus registered developers whose account falls in this batch's range (every batch's,
 * when `batchIndex` is null). Keyed on the account id; a registered developer search also found
 * keeps the search's own entry and source, except that one only a city name found becomes
 * `registered`, so the city search's location re-check does not apply to them.
 *
 * `discovered` is `[{id, login, source}]` from discovery; a registered candidate joins with the
 * source `registered`. `complete` is false when the registered accounts could not be resolved:
 * none of them is then evaluated, and the merge treats this batch's search as short, as it does
 * for a leaf that failed to list.
 *
 * @returns {Promise<{ candidates: Array<{id, login, source}>, registered: Map<number, object>,
 *                     ids: Set<number>, complete: boolean }>}
 */
export async function joinRegistry({
  discovered,
  registry,
  batchIndex = null,
  batches,
  graphql,
  log = console
}) {
  const optedOut = registry?.optedOut ?? new Set();
  const pending = (registry?.registered ?? []).filter((entry) => !optedOut.has(entry.id));
  const registeredIds = new Set(pending.map((entry) => entry.id));
  const candidates = [];
  const ids = new Set();
  let withheld = 0;
  for (const candidate of discovered) {
    if (ids.has(candidate.id)) continue;
    if (optedOut.has(candidate.id)) {
      withheld += 1;
      continue;
    }
    ids.add(candidate.id);
    // A registration replaces the location check, and a city-found developer's location is
    // checked again once fetched (fetch-devs.js). One who registered is admitted by registering,
    // not by the city name, so they are never ruled out on location.
    candidates.push(
      candidate.source === DISCOVERY_SOURCES.CITY && registeredIds.has(candidate.id)
        ? { ...candidate, source: DISCOVERY_SOURCES.REGISTERED }
        : candidate
    );
  }
  if (withheld > 0) log.log(`Opt-outs: ${withheld} discovered developer(s) not fetched.`);

  const registered = new Map();
  if (pending.length === 0) return { candidates, registered, ids, complete: true };

  let resolution;
  try {
    resolution = await resolveRegistered({ graphql, registered: pending });
  } catch (error) {
    log.warn(
      `::warning title=Registration::${annotation(
        `Could not resolve ${pending.length} registered developer(s), so none is evaluated ` +
          `this run and miss counters are frozen: ${error.message}`
      )}`
    );
    return { candidates, registered, ids, complete: false };
  }
  for (const entry of resolution.unresolved) {
    log.log(`Registration: ${entry.login} (#${entry.issueNumber}) skipped: ${entry.reason}.`);
  }

  let found = 0;
  for (const person of resolution.resolved) {
    const match = rangeForCreatedAt(person.createdAt, batches);
    if (!match) {
      log.warn(
        `::warning title=Registration::${annotation(
          `${person.login} (#${person.issueNumber}) was created ${person.createdAt}, outside ` +
            'every batch range, so no batch evaluates them.'
        )}`
      );
      continue;
    }
    if (batchIndex != null && match.batchIndex !== batchIndex) continue;
    if (ids.has(person.id)) {
      found += 1;
      continue;
    }
    registered.set(person.id, { ...person, gates: registrationGates(match.query) });
    ids.add(person.id);
    candidates.push({ id: person.id, login: person.login, source: DISCOVERY_SOURCES.REGISTERED });
  }
  log.log(
    `Registration: ${pending.length} registered, ${registered.size + found} in this run's ` +
      `range(s): ${found} already found by search, ${registered.size} added as candidates.`
  );
  return { candidates, registered, ids, complete: true };
}

/**
 * What becomes of one developer fetched in full, decided by account id.
 *
 *   { admit: row }    published as measured; a registered developer's row is tagged
 *                     `discovery_source: 'registered'`.
 *   { reject: why }   a registered developer below search's repos:/followers: gates. Evaluated
 *                     and failed, so their row leaves the board, as any ineligible one does.
 *   { skip: why }     the login, fetched by name, now belongs to an account this run never chose
 *                     (renamed and claimed since discovery). Not evaluated.
 */
export function admitFetched(joined, developer, log = console) {
  const id = developer?.github_id;
  if (isAccountId(id) && joined?.ids && !joined.ids.has(id)) {
    const why = `${developer.username} is now account ${id}, which was not a candidate`;
    log.warn(`Skipping ${why}.`);
    return { skip: why };
  }
  const person = joined?.registered?.get(id);
  if (!person) return { admit: developer };
  if (!passesRegistrationGates(developer, person.gates)) {
    const why =
      `${developer.username} registered but has ${developer.public_repos} public repos and ` +
      `${developer.followers} followers, below this batch's search gates`;
    log.log(`Registration: ${why}.`);
    return { reject: why };
  }
  return { admit: { ...developer, discovery_source: DISCOVERY_SOURCES.REGISTERED } };
}
