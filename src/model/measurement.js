/**
 * The measurement a score is computed from: one developer's public contributions over a 30-day
 * window, as GitHub's contributions API and search report them, in the compact form stored on a
 * row. Pure - no I/O and no clock - so the pipeline (scripts/measure/contributions.js), the score
 * model and the Worker's preview endpoint all read one definition.
 *
 * ## The window
 *
 * The 30 Pakistan dates (UTC+5, no daylight saving) before the Pakistan date of the measurement,
 * half-open `[from, to)`. Two kinds of timestamp are mapped onto it:
 *
 *   - A commit contribution comes from GitHub already dated, by the commit's own time zone, and is
 *     kept when that date is in the window. For a developer in Pakistan that is a Pakistan date.
 *   - Everything else - a pull request or issue opened, a review, a merge - is an exact instant,
 *     and takes the Pakistan date of that instant.
 *
 * Measured on 2026-10-16: `contributionsCollection(from, to)` bounds commit days and calendar days
 * by the UTC dates of `from` and `to`, and bounds pull requests, issues and reviews by the
 * instants. So the query starts at 19:00Z on the day before `from` (the first instant of Pakistan
 * date `from`) and ends at the last second of UTC date `to - 1`. That range also returns commit
 * days dated `from - 1` and instants of Pakistan date `to`; both are dropped here, never thrown
 * as malformed.
 *
 * The future probe asks for commits dated two or more days after the measurement's Pakistan date.
 * No time zone is that far ahead, so any commit there carries a date its author made up.
 *
 * ## The stored block (SHAPE_VERSION 3)
 *
 *   v     SHAPE_VERSION
 *   at    measured_at, ISO 8601 to the second
 *   u     the login measured, `id` its account id: the block says whose it is
 *   w     [from, to), Pakistan dates
 *   r     restricted (private) contributions in the query range, as context: never scored
 *   cr    commits: [repo, flags, stars, [day, commits, ...]]
 *   pr    pull requests opened: [repo, flags, [day, number, outcome, ...]]
 *   is    issues opened: [repo, flags, [day, number, ...]]
 *   rv    reviews given: [repo, flags, stars, [day, number, author, outsider, ...]]. `outsider` is 1
 *         when GitHub reported the review's author association as NONE: no role in the project.
 *   ac    pull requests of theirs merged into a repository they do not own, by merge date:
 *         [repo, flags, stars, owner, [day, number, merger, lines, files, approver, ...]].
 *         `approver`, for a pull request they merged themselves, is the user who approved it
 *         (the one whose account is oldest, when several did), else -1.
 *   mt    pull requests by other people merged into their own repositories, by merge date:
 *         [repo, flags, stars, [day, number, author, lines, files, ...]]
 *   pp    people: [login, kind, created]. `owner`, `merger` and `author` index into it, -1 when
 *         GitHub reports no account (deleted). kind is U (user), O (organization), B (bot) or X
 *         (anything else); created is the account's creation date, or null when not reported.
 *   fu    repositories holding commits dated in the future
 *   ig    commit-date samples, of the default branch and gh-pages (the branches GitHub counts):
 *         [repo, sampled, bot, lead, ahead, days]. `bot` counts sampled commits a bot committed;
 *         `lead` is the most hours an author date ran ahead of its commit date; `ahead` the most
 *         hours any date ran past the measurement, both null when nothing was sampled. `days` is
 *         the Pakistan dates the sample covers when it holds every commit of theirs since the
 *         window began, else null.
 *   cut   CUT_* bits: which lists are known to be incomplete. Nothing is extrapolated.
 *
 * `day` is the offset into the window, 0 (the oldest date) to 29. Repositories are ordered by
 * name and items by day then number, so equal measurements encode to equal bytes.
 *
 * Shape 2 blocks still decode: a review reads as not by an outsider, a merge as unapproved, and a
 * sample as not covering its days. Those are the readings that change nothing a shape 2 block
 * said, so a block measured before shape 3 scores as it did, short of the new rules.
 */

export const SHAPE_VERSION = 3;
const READABLE_SHAPES = new Set([2, 3]);
export const WINDOW_DAYS = 30;
export const PKT_OFFSET_HOURS = 5;

/** Days after the measurement's Pakistan date where the future probe starts looking. */
export const FUTURE_PROBE_START_DAYS = 2;

export const FLAG_OWNED = 1;
export const FLAG_FORK = 2;
/** A profile README repository: owned by a user account and named after it. */
export const FLAG_PROFILE = 4;
/** Owned by an organization. */
export const FLAG_ORG = 8;

export const OUTCOME_OPEN = 0;
export const OUTCOME_MERGED = 1;
export const OUTCOME_CLOSED = 2;

export const KIND_USER = 'U';
export const KIND_ORG = 'O';
export const KIND_BOT = 'B';
export const KIND_OTHER = 'X';
const KINDS = new Set([KIND_USER, KIND_ORG, KIND_BOT, KIND_OTHER]);

/** No account: GitHub reports `null`, which is what a deleted account looks like. */
export const NOBODY = -1;

export const CUT_COMMIT_REPOS = 1;
export const CUT_PULL_REQUESTS = 2;
export const CUT_ISSUES = 4;
export const CUT_REVIEWS = 8;
export const CUT_ACCEPTED = 16;
export const CUT_MAINTAINED = 32;
/** Measured with a shorter repository list after the full one was refused. */
export const CUT_DEGRADED = 64;
/** Some repositories were not sampled for commit dates. */
export const CUT_INTEGRITY = 128;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PKT_OFFSET_MS = PKT_OFFSET_HOURS * HOUR_MS;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);
export const addDays = (date, days) => isoDate(dateMs(date) + days * DAY_MS);

function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('a measurement needs `now` (a Date or epoch milliseconds)');
  }
  return ms;
}

/** The Pakistan date of an instant (ISO string or epoch milliseconds). */
export function pktDate(instant) {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant;
  if (!Number.isFinite(ms)) throw new TypeError(`not an instant: ${JSON.stringify(instant)}`);
  return isoDate(ms + PKT_OFFSET_MS);
}

/**
 * The window a measurement taken at `now` covers, and the ranges to ask GitHub for.
 *
 * @returns {{from: string, to: string, query: {from: string, to: string},
 *            instants: {from: number, to: number}, future: {from: string, to: string}}}
 *   `instants` is the half-open range of epoch milliseconds whose Pakistan date is in the window.
 */
export function measurementWindow(now) {
  const ms = toMs(now);
  const to = pktDate(ms);
  const from = addDays(to, -WINDOW_DAYS);
  const futureFrom = addDays(to, FUTURE_PROBE_START_DAYS);
  return {
    from,
    to,
    query: { from: `${addDays(from, -1)}T19:00:00Z`, to: `${addDays(to, -1)}T23:59:59Z` },
    instants: {
      from: dateMs(from) - PKT_OFFSET_MS,
      to: dateMs(to) - PKT_OFFSET_MS
    },
    // contributionsCollection spans at most a year.
    future: { from: `${futureFrom}T00:00:00Z`, to: `${addDays(futureFrom, 364)}T23:59:59Z` }
  };
}

/** The `merged:` range for a search: the window's instants, to the second. */
export function searchMergedRange(window) {
  const at = (ms) => isoSecond(ms).replace(/Z$/, '+00:00');
  return `${at(window.instants.from)}..${at(window.instants.to - 1000)}`;
}

/** A date's offset into the window, or null outside it. */
export function dayOffset(date, window) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  const offset = Math.round((dateMs(date) - dateMs(window.from)) / DAY_MS);
  return offset >= 0 && offset < WINDOW_DAYS ? offset : null;
}

/** The offset of an instant's Pakistan date, or null outside the window. */
export function instantOffset(instant, window) {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  return dayOffset(pktDate(ms), window);
}

/**
 * The date of a commit contribution. GitHub reports it as that date at a local midnight (US
 * Pacific, measured); half a day later is the same date for any offset within twelve hours.
 */
export function commitDate(occurredAt) {
  const ms = Date.parse(occurredAt);
  if (!Number.isFinite(ms)) return null;
  return isoDate(ms + 12 * HOUR_MS);
}

/** The date `offset` days into a window. */
export const windowDate = (window, offset) => addDays(window.from, offset);

/** Repository flags from its owner and name, relative to the developer `login`. */
export function repositoryFlags({ nameWithOwner, ownerLogin, ownerType, isFork }, login) {
  const owner = String(ownerLogin || nameWithOwner.split('/')[0]).toLowerCase();
  const name = String(nameWithOwner.split('/')[1] || '').toLowerCase();
  let flags = 0;
  if (owner === String(login).toLowerCase()) flags |= FLAG_OWNED;
  if (isFork === true) flags |= FLAG_FORK;
  if (ownerType === 'Organization') flags |= FLAG_ORG;
  else if (owner === name) flags |= FLAG_PROFILE;
  return flags;
}

/** The kind of an actor from its GraphQL `__typename`. */
export function actorKind(typename) {
  if (typename === 'User') return KIND_USER;
  if (typename === 'Organization') return KIND_ORG;
  if (typename === 'Bot') return KIND_BOT;
  return KIND_OTHER;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Orders items by day, then number, then any later field. */
function compareTuples(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The stored form of a readable measurement. People are collected from every list, ordered by
 * login, and referred to by index.
 */
export function encodeMeasurement(m) {
  const people = new Map();
  const person = (p) => {
    if (!p) return;
    const key = p.login.toLowerCase();
    if (!people.has(key)) people.set(key, p);
  };
  for (const repo of m.accepted) {
    person(repo.owner);
    repo.items.forEach((item) => {
      person(item.merger);
      person(item.approver);
    });
  }
  for (const repo of m.reviews) repo.items.forEach((item) => person(item.author));
  for (const repo of m.maintained) repo.items.forEach((item) => person(item.author));
  const pp = [...people.values()].sort((a, b) =>
    compareText(a.login.toLowerCase(), b.login.toLowerCase())
  );
  const index = new Map(pp.map((p, i) => [p.login.toLowerCase(), i]));
  const ref = (p) => (p ? index.get(p.login.toLowerCase()) : NOBODY);

  const byName = (a, b) => compareText(a.repo, b.repo);
  const flat = (items, fields) =>
    items
      .map((item) => fields.map((field) => field(item)))
      .sort(compareTuples)
      .flat();

  return {
    v: SHAPE_VERSION,
    at: m.measured_at,
    u: m.login,
    id: m.github_id,
    w: [m.window.from, m.window.to],
    r: m.restricted,
    cr: [...m.commits]
      .sort(byName)
      .map((r) => [r.repo, r.flags, r.stars, flat(r.days, [(d) => d.day, (d) => d.commits])]),
    pr: [...m.pull_requests]
      .sort(byName)
      .map((r) => [
        r.repo,
        r.flags,
        flat(r.items, [(i) => i.day, (i) => i.number, (i) => i.outcome])
      ]),
    is: [...m.issues]
      .sort(byName)
      .map((r) => [r.repo, r.flags, flat(r.items, [(i) => i.day, (i) => i.number])]),
    rv: [...m.reviews]
      .sort(byName)
      .map((r) => [
        r.repo,
        r.flags,
        r.stars,
        flat(r.items, [
          (i) => i.day,
          (i) => i.number,
          (i) => ref(i.author),
          (i) => (i.outsider ? 1 : 0)
        ])
      ]),
    ac: [...m.accepted]
      .sort(byName)
      .map((r) => [
        r.repo,
        r.flags,
        r.stars,
        ref(r.owner),
        flat(r.items, [
          (i) => i.day,
          (i) => i.number,
          (i) => ref(i.merger),
          (i) => i.lines,
          (i) => i.files,
          (i) => ref(i.approver ?? null)
        ])
      ]),
    mt: [...m.maintained]
      .sort(byName)
      .map((r) => [
        r.repo,
        r.flags,
        r.stars,
        flat(r.items, [
          (i) => i.day,
          (i) => i.number,
          (i) => ref(i.author),
          (i) => i.lines,
          (i) => i.files
        ])
      ]),
    pp: pp.map((p) => [p.login, p.kind, p.created ?? null]),
    fu: [...m.future_repos].sort(compareText),
    ig: [...m.integrity]
      .sort(byName)
      .map((r) => [r.repo, r.sampled, r.bot, r.max_lead_hours, r.max_ahead_hours, r.days ?? null]),
    cut: m.cut
  };
}

class Malformed extends Error {}

const isCount = (value) => Number.isInteger(value) && value >= 0;
function count(value, what) {
  if (!isCount(value)) throw new Malformed(`${what} is ${JSON.stringify(value)}, not a count`);
  return value;
}
function text(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw new Malformed(`${what} is not text`);
  return value;
}
function list(value, what) {
  if (!Array.isArray(value)) throw new Malformed(`${what} is not a list`);
  return value;
}
function day(value, what) {
  if (!Number.isInteger(value) || value < 0 || value >= WINDOW_DAYS) {
    throw new Malformed(`${what} day ${JSON.stringify(value)} is outside the window`);
  }
  return value;
}
function hours(value, what) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Malformed(`${what} is ${JSON.stringify(value)}, not a number of hours`);
  }
  return value;
}

/** Splits a flat list into tuples of `width`. */
function tuples(values, width, what) {
  list(values, what);
  if (values.length % width !== 0) throw new Malformed(`${what} is not in groups of ${width}`);
  const out = [];
  for (let i = 0; i < values.length; i += width) out.push(values.slice(i, i + width));
  return out;
}

/**
 * The readable form of a stored block (shape 2 or 3), or null for anything that is not a
 * well-formed one.
 * Every index into `pp` is checked, so a reader never meets a dangling reference.
 */
export function decodeMeasurement(block) {
  if (!block || typeof block !== 'object' || !READABLE_SHAPES.has(block.v)) return null;
  const v3 = block.v === 3;
  try {
    const people = list(block.pp, 'pp').map(([login, kind, created], i) => {
      text(login, `pp[${i}] login`);
      if (!KINDS.has(kind)) throw new Malformed(`pp[${i}] kind ${JSON.stringify(kind)}`);
      if (created !== null && !(typeof created === 'string' && DATE_RE.test(created))) {
        throw new Malformed(`pp[${i}] created ${JSON.stringify(created)}`);
      }
      return { login, kind, created };
    });
    const who = (i, what) => {
      if (i === NOBODY) return null;
      if (!Number.isInteger(i) || i < 0 || i >= people.length) {
        throw new Malformed(`${what} refers to person ${JSON.stringify(i)}`);
      }
      return people[i];
    };
    const [from, to] = list(block.w, 'w');
    if (!DATE_RE.test(from) || addDays(from, WINDOW_DAYS) !== to) {
      throw new Malformed(`window ${JSON.stringify(block.w)}`);
    }
    if (!Number.isFinite(Date.parse(block.at))) throw new Malformed('at');
    if (!isCount(block.id)) throw new Malformed('id');

    return {
      version: block.v,
      measured_at: block.at,
      login: text(block.u, 'u'),
      github_id: block.id,
      window: { from, to },
      restricted: count(block.r, 'r'),
      commits: list(block.cr, 'cr').map(([repo, flags, stars, days]) => ({
        repo: text(repo, 'cr repo'),
        flags: count(flags, `${repo} flags`),
        stars: count(stars, `${repo} stars`),
        days: tuples(days, 2, `${repo} days`).map(([d, commits]) => ({
          day: day(d, repo),
          commits: count(commits, `${repo} commits`)
        }))
      })),
      pull_requests: list(block.pr, 'pr').map(([repo, flags, items]) => ({
        repo: text(repo, 'pr repo'),
        flags: count(flags, `${repo} flags`),
        items: tuples(items, 3, `${repo} pull requests`).map(([d, number, outcome]) => {
          if (![OUTCOME_OPEN, OUTCOME_MERGED, OUTCOME_CLOSED].includes(outcome)) {
            throw new Malformed(`${repo}#${number} outcome ${JSON.stringify(outcome)}`);
          }
          return { day: day(d, repo), number: count(number, `${repo} number`), outcome };
        })
      })),
      issues: list(block.is, 'is').map(([repo, flags, items]) => ({
        repo: text(repo, 'is repo'),
        flags: count(flags, `${repo} flags`),
        items: tuples(items, 2, `${repo} issues`).map(([d, number]) => ({
          day: day(d, repo),
          number: count(number, `${repo} number`)
        }))
      })),
      reviews: list(block.rv, 'rv').map(([repo, flags, stars, items]) => ({
        repo: text(repo, 'rv repo'),
        flags: count(flags, `${repo} flags`),
        stars: count(stars, `${repo} stars`),
        items: tuples(items, v3 ? 4 : 3, `${repo} reviews`).map(([d, number, author, outsider]) => {
          if (v3 && outsider !== 0 && outsider !== 1) {
            throw new Malformed(`${repo}#${number} outsider ${JSON.stringify(outsider)}`);
          }
          return {
            day: day(d, repo),
            number: count(number, `${repo} number`),
            author: who(author, `${repo}#${number} author`),
            outsider: outsider === 1
          };
        })
      })),
      accepted: list(block.ac, 'ac').map(([repo, flags, stars, owner, items]) => ({
        repo: text(repo, 'ac repo'),
        flags: count(flags, `${repo} flags`),
        stars: count(stars, `${repo} stars`),
        owner: who(owner, `${repo} owner`),
        items: tuples(items, v3 ? 6 : 5, `${repo} merges`).map(
          ([d, number, merger, lines, files, approver]) => ({
            day: day(d, repo),
            number: count(number, `${repo} number`),
            merger: who(merger, `${repo}#${number} merger`),
            lines: count(lines, `${repo}#${number} lines`),
            files: count(files, `${repo}#${number} files`),
            approver: v3 ? who(approver, `${repo}#${number} approver`) : null
          })
        )
      })),
      maintained: list(block.mt, 'mt').map(([repo, flags, stars, items]) => ({
        repo: text(repo, 'mt repo'),
        flags: count(flags, `${repo} flags`),
        stars: count(stars, `${repo} stars`),
        items: tuples(items, 5, `${repo} merges`).map(([d, number, author, lines, files]) => ({
          day: day(d, repo),
          number: count(number, `${repo} number`),
          author: who(author, `${repo}#${number} author`),
          lines: count(lines, `${repo}#${number} lines`),
          files: count(files, `${repo}#${number} files`)
        }))
      })),
      people,
      future_repos: list(block.fu, 'fu').map((repo) => text(repo, 'fu repo')),
      integrity: list(block.ig, 'ig').map(([repo, sampled, bot, lead, ahead, covered]) => ({
        repo: text(repo, 'ig repo'),
        sampled: count(sampled, `${repo} sampled`),
        bot: count(bot, `${repo} bot`),
        max_lead_hours: hours(lead, `${repo} lead`),
        max_ahead_hours: hours(ahead, `${repo} ahead`),
        days: v3 && covered !== null ? count(covered, `${repo} days`) : null
      })),
      cut: count(block.cut, 'cut')
    };
  } catch (error) {
    if (error instanceof Malformed) return null;
    throw error;
  }
}

/** Whether a stored block is a well-formed measurement of this shape. */
export const isMeasurement = (block) => decodeMeasurement(block) !== null;
