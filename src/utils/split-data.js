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

// Fields the pipeline keeps on a row for its own use and no page reads: the
// shadow measurement of the next activity model's inputs, and how far back
// the events read behind today's reached (scripts/measure/contributions.js).
// They stay in data.json, which is the pipeline's state, and out of every
// file derived for the browser, which therefore downloads what it did before
// they existed. They would roughly double a detail file.
export const PIPELINE_ONLY_FIELDS = Object.freeze(['shadow_contributions', 'events_window']);

/** A row as the browser is given it: everything but PIPELINE_ONLY_FIELDS. */
export function toDeveloperRow(row) {
  const out = { ...row };
  for (const field of PIPELINE_ONLY_FIELDS) delete out[field];
  return out;
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
