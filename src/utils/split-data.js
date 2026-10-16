import { ensureLeaderboardTags } from './tags.js';

// The shapes of the files the browser reads instead of data.json.
//
// data.json is 1.65 MB raw and ~400 KB gzipped, and every visitor downloaded
// all of it to show ten rows. 70% of a row is `top_repos` and `digest_repos`,
// which only the expanded card and the Digest read. So the build splits it:
//
//   board.json         every row, list fields only           (~49 KB gzipped)
//   dev/<login>.json   one developer's full row               (~0.8 KB each)
//   digest.json        the Digest's aggregates, precomputed   (~9 KB)
//
// data.json itself is still published unchanged: the Worker and outside
// readers fetch it from the site root. These files are derived from it at
// build time (scripts/build-split-data.js) and never committed.
//
// Everything here is pure and shared by the build and the browser, so the
// browser's fallback path (data.json when a split file is missing) computes
// exactly what the build wrote.

/** Bump when a consumer could misread an older or newer file. */
export const SPLIT_SCHEMA = 1;

// Every field a list view reads, found by reading each one. A field not listed
// here still reaches the browser through dev/<login>.json, so a new pipeline
// field is never lost - but a list view that starts reading one must add it.
//
//   rank           DevCard row, Compare, CSV, Register, Badge
//   username       everywhere; the key every view joins on
//   name           DevCard row, sort, search, Compare, CSV, Map
//   avatar_url     DevCard row, Compare, Map, Register, Badge
//   location       DevCard row, search, Compare, CSV, Map, Register
//   score          DevCard row, sort, Compare, CSV, Map, Register
//   followers      sort, Compare, CSV, the expanded card's stat
//   public_repos   Compare, CSV, Map, the expanded card's stat
//   total_stars    Compare, CSV, Map
//   events_30d     sort, Compare, CSV, Map
//   top_languages  search, Compare, CSV
//   tags           DevCard row, the tag filter, Compare
//
// Detail only: bio, top_repos, digest_repos, linkedin_url, and anything the
// pipeline adds later, except PIPELINE_ONLY_FIELDS. Register's ten bios come
// from the detail files: bios are 87 KB of high-entropy text and would nearly
// double the board gzipped.
export const BOARD_FIELDS = Object.freeze([
  'rank',
  'username',
  'name',
  'avatar_url',
  'location',
  'score',
  'followers',
  'public_repos',
  'total_stars',
  'events_30d',
  'top_languages',
  'tags'
]);

// Fields a board row gains from its row rather than copies: the score to two decimals.
export const DERIVED_BOARD_FIELDS = Object.freeze(['score_shown']);

// Fields the pipeline keeps on a row for its own use and no page reads: the contributions
// measurement the score is computed from (scripts/measure/contributions.js, the field it had
// before the switch included), and the miss counter of a row a run did not see (mergeBatch in
// scripts/run-all.js). They stay in the state and out of every file derived for the browser. A
// measurement is a few kilobytes per row; the evidence derived from it is published instead, in
// each developer's own file.
export const PIPELINE_ONLY_FIELDS = Object.freeze([
  'contributions',
  'shadow_contributions',
  'events_window',
  'missed_runs',
  'missed_since'
]);

// Fields only a developer's own file carries: the score's evidence, every working day and every
// pull request, review and merge that counted, each a public GitHub item (src/model/evidence.js).
// About 2 KB a row, so the board and data.json, which every visitor or the Worker downloads
// whole, leave it out.
export const DETAIL_ONLY_FIELDS = Object.freeze(['score_evidence']);

/** A row as the browser is given it in a developer's own file: everything but PIPELINE_ONLY_FIELDS. */
export function toDeveloperRow(row) {
  const out = { ...row };
  for (const field of PIPELINE_ONLY_FIELDS) delete out[field];
  return out;
}

/** A row as data.json serves it: also without DETAIL_ONLY_FIELDS. */
function toPublicRow(row) {
  const out = toDeveloperRow(row);
  for (const field of DETAIL_ONLY_FIELDS) delete out[field];
  return out;
}

/** Whether any row carries a PIPELINE_ONLY_FIELDS field. */
export function hasPipelineOnlyFields(payload) {
  const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
  return rows.some((row) =>
    [...PIPELINE_ONLY_FIELDS, ...DETAIL_ONLY_FIELDS].some((field) => row && field in row)
  );
}

/**
 * The data.json the site serves: the pipeline's state with PIPELINE_ONLY_FIELDS and
 * DETAIL_ONLY_FIELDS removed from every row, and every other field and its order untouched. The
 * Worker downloads and parses this file whole on Cloudflare's per-request CPU budget, and the
 * browser's fallback caches it in localStorage, so neither the measurement nor the evidence may
 * reach it.
 */
export function buildPublicPayload(payload) {
  return { ...payload, leaderboard: payload.leaderboard.map(toPublicRow) };
}

/** The Digest's tables, as many rows as the page renders. */
export const DIGEST_TOP_REPOS = 100;
export const DIGEST_TOP_CONTRIBUTORS = 10;

function rowsOf(payload) {
  return Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
}

// Top-level fields other than the rows (last_updated, total_devs, and
// whatever the pipeline adds), so file-level metadata flows through.
function metadataOf(payload) {
  const meta = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (key !== 'leaderboard' && key !== 'schema') meta[key] = value;
  }
  return meta;
}

export function toBoardRow(row) {
  const out = {};
  for (const field of BOARD_FIELDS) {
    if (row && Object.hasOwn(row, field)) out[field] = row[field];
  }
  // The score to two decimals, the precision at which almost every change of rank shows. The
  // board shows it beside the rounded score, so two rows with different ranks do not both read
  // 500 (measured 2026-10-16, 953 of 967 rank changes visible against 327 with whole numbers).
  if (row && Number.isFinite(row.score_exact))
    out.score_shown = Math.round(row.score_exact * 100) / 100;
  return out;
}

// Tags are computed here rather than in the browser. A row published without
// tags gets them matched from its bio and repository text, which the board no
// longer carries - so the browser could not reproduce them from a board row.
export function buildBoard(payload) {
  return {
    schema: SPLIT_SCHEMA,
    ...metadataOf(payload),
    leaderboard: ensureLeaderboardTags(rowsOf(payload)).map(toBoardRow)
  };
}

// The repositories and contributors the Digest page renders, moved out of the
// page so the build and the page's fallback share one implementation.
//
// The order is the page's: a stable sort by stars, so ties keep leaderboard
// order. Two fields the page computed and never rendered are not carried:
// each repo's `devAvatar` and each contributor's `avatar` (the page builds the
// avatar URL from the username).
export function summarizeDigest(rows) {
  const devs = Array.isArray(rows) ? rows : [];
  const repos = devs.flatMap((d) =>
    (d.digest_repos || []).map((r) => ({ ...r, stars: r.stars || 0, dev: d.username }))
  );
  repos.sort((a, b) => b.stars - a.stars);

  const contribMap = new Map();
  for (const r of repos) {
    if (!contribMap.has(r.dev)) {
      contribMap.set(r.dev, { username: r.dev, repoCount: 0, totalStars: 0 });
    }
    const entry = contribMap.get(r.dev);
    entry.repoCount += 1;
    entry.totalStars += r.stars;
  }
  const contributors = Array.from(contribMap.values()).sort((a, b) => b.totalStars - a.totalStars);

  return {
    topRepos: repos.slice(0, DIGEST_TOP_REPOS),
    topContributors: contributors.slice(0, DIGEST_TOP_CONTRIBUTORS),
    totalRepos: repos.length,
    devsWithRepos: devs.filter((d) => d.digest_repos?.length > 0).length,
    activeDevs: devs.length
  };
}

export function buildDigest(payload) {
  return {
    schema: SPLIT_SCHEMA,
    last_updated: payload?.last_updated ?? '',
    ...summarizeDigest(rowsOf(payload))
  };
}

export function buildDeveloperFile(payload, row) {
  return {
    schema: SPLIT_SCHEMA,
    last_updated: payload?.last_updated ?? '',
    developer: toDeveloperRow(row)
  };
}

// A GitHub login is [A-Za-z0-9-] and case-insensitive, so it is already a safe
// file name once lowercased. The encoding exists for a login that is not:
// every byte outside [a-z0-9-] becomes `_` plus two hex digits, and `_` itself
// is always escaped, so the mapping is reversible, never yields `.`, `/` or
// `%`, and the name needs no further escaping in a URL.
const MAX_FILE_STEM = 200;

export function developerFileName(login) {
  const lower = String(login ?? '')
    .trim()
    .toLowerCase();
  if (!lower) return null;

  let stem = '';
  for (const byte of new TextEncoder().encode(lower)) {
    const isSafe =
      (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d;
    stem += isSafe ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return stem.length > MAX_FILE_STEM ? null : `${stem}.json`;
}

export function developerFilePath(login) {
  const name = developerFileName(login);
  return name ? `dev/${name}` : null;
}

// Shape checks for what came over the network. A missing file on the Vite dev
// server answers 200 with index.html, and an old cached bundle may meet a
// newer schema: both must read as "not available" and fall back to data.json.
export function isBoardPayload(value) {
  return value?.schema === SPLIT_SCHEMA && Array.isArray(value.leaderboard);
}

export function isDigestPayload(value) {
  return (
    value?.schema === SPLIT_SCHEMA &&
    Array.isArray(value.topRepos) &&
    Array.isArray(value.topContributors)
  );
}

export function isDeveloperFileFor(value, login) {
  const wanted = String(login ?? '')
    .trim()
    .toLowerCase();
  return (
    value?.schema === SPLIT_SCHEMA &&
    typeof value.developer?.username === 'string' &&
    value.developer.username.toLowerCase() === wanted
  );
}
