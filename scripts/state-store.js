// Pipeline state: the whole leaderboard, kept as assets on one GitHub Release
// rather than as commits to main.
//
// Why not git. public/data.json was 98.4% of the repository's packed size -
// 3,928 versions, about 305 MB - and 95.5% of the commits on main were the
// bot's, each costing 77-118 KB packed. A `data` branch would only move that
// weight, since a normal clone fetches every branch. Release assets are not in
// the git object store, so nothing a clone downloads grows with them.
//
// Layout. One release, tagged `pipeline-state`, published as a prerelease that
// is never marked latest. Each pipeline run uploads
// `state-<run_id>-<run_attempt>.json.gz`: the board in data.json's shape, byte
// for byte, gzipped. The state is the newest *uploaded* asset by `created_at`.
// One that fails to download, match its digest or parse is skipped for the
// next-newest, and the newest KEEP_ASSETS - three days of hourly runs - are
// kept, so any of them can be restored by hand. So is the newest state of each
// Pakistan date for KEEP_DAILY_DAYS: the board as it closed that day, the
// record a history of the board is built from (pruning used to delete it after
// three days, so nothing durable recorded the board at all).
//
// Writes are serialized by the pipeline's concurrency group in
// update-digest.yml. This module takes no lock of its own.
//
//   node scripts/state-store.js pull [path] [--if-missing]   default path public/data.json
//   node scripts/state-store.js restore [path] [--force]     default path public/data.json
//   node scripts/state-store.js save <path> [--label <text>]
//   node scripts/state-store.js list
//
// `restore` is the rollback: `pull`, but verified first (see restoreLatest).
// It is here rather than with the switch to release-backed state so that
// reverting that switch cannot remove it.
//
// `pull` needs no token: a public repository serves release assets to anyone,
// and two unauthenticated API calls find the newest. `save` needs GITHUB_TOKEN
// with `contents: write`.
//
// Built-ins only (fetch, zlib, crypto, fs), like watchdog.js, so it runs
// without `npm ci`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const STATE_TAG = 'pipeline-state';
export const KEEP_ASSETS = 72;
/** Days the last state of each Pakistan date is kept. Well under 1,000 assets a release. */
export const KEEP_DAILY_DAYS = 400;
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Pakistan date (UTC+5) an asset was saved on. */
export function pktDateOf(iso) {
  return new Date(Date.parse(iso) + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The newest uploaded state of each Pakistan date saved within the last `days`, newest first:
 * each day's closing board.
 */
export function dailyCloses(assets, { now, days = KEEP_DAILY_DAYS }) {
  const seen = new Set();
  const out = [];
  for (const asset of newestFirst(assets)) {
    if (now - Date.parse(asset.created_at) > days * DAY_MS) continue;
    const date = pktDateOf(asset.created_at);
    if (seen.has(date)) continue;
    seen.add(date);
    out.push(asset);
  }
  return out;
}
export const DEFAULT_REPO = 'Sudo-Ali-Dev/Rankistan';

// How many assets `load` tries, newest first. Past this many unreadable in a
// row the store itself is broken, not one upload, and quietly reaching further
// back would rewind the board by days.
export const MAX_LOAD_ATTEMPTS = 5;

// An asset still in `starter` state is an upload that never completed. Once it
// is this old it is abandoned, not in flight, and only occupies its name.
const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

const ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;
const NAME_PATTERN = /^state-[A-Za-z0-9]+-\d+\.json\.gz$/;

const RELEASE_BODY = [
  'Pipeline state for the leaderboard. Not a software release.',
  '',
  'Each asset is the whole board as of one pipeline run, in the shape of `data.json`, gzipped.',
  'The newest is the current state; older ones are kept for three days so any of them can be',
  'restored. Written by `.github/workflows/update-digest.yml`; see `scripts/state-store.js`.'
].join('\n');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stateAssetName({ runId, runAttempt = 1 } = {}) {
  const id = String(runId ?? '');
  const attempt = Number(runAttempt);
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    throw new Error(`A state asset needs an alphanumeric run id, got ${JSON.stringify(runId)}.`);
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`A state asset needs a run attempt >= 1, got ${JSON.stringify(runAttempt)}.`);
  }
  return `state-${id}-${attempt}.json.gz`;
}

export function isStateAsset(asset) {
  return typeof asset?.name === 'string' && NAME_PATTERN.test(asset.name);
}

/**
 * Uploaded state assets, newest first. `created_at` decides, not the name: a
 * re-run attempt carries an older run id than runs that started after it. The
 * asset id, which only grows, breaks a tie inside one second.
 */
export function newestFirst(assets) {
  return (assets || [])
    .filter((asset) => isStateAsset(asset) && asset.state === 'uploaded')
    .sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id) - Number(a.id)
    );
}

/** A board from JSON text, or an exception that says why it is not one. */
export function parseBoard(text, source = 'state') {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(payload?.leaderboard)) {
    throw new Error(`${source} has no "leaderboard" array`);
  }
  return payload;
}

/** The bytes stored for a board: its JSON text exactly as given, gzipped. */
export function encodeState(board) {
  const text = Buffer.isBuffer(board)
    ? board.toString('utf8')
    : typeof board === 'string'
      ? board
      : JSON.stringify(board);
  parseBoard(text, 'the board to save');
  return zlib.gzipSync(Buffer.from(text, 'utf8'));
}

/**
 * The board inside stored bytes. Plain JSON is accepted too, in case a proxy
 * ever undoes the gzip in transit; the asset is served as
 * application/octet-stream with no Content-Encoding today, so fetch does not.
 */
export function decodeState(bytes, source = 'state') {
  const buffer = Buffer.from(bytes);
  let raw = buffer;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      raw = zlib.gunzipSync(buffer);
    } catch (error) {
      throw new Error(`${source} is not valid gzip: ${error.message}`);
    }
  }
  const text = raw.toString('utf8');
  return { text, payload: parseBoard(text, source) };
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function httpError(method, url, status, text) {
  let message = '';
  try {
    const body = JSON.parse(text);
    message = [body?.message, ...(body?.errors || []).map((e) => e?.code || e?.message)]
      .filter(Boolean)
      .join(': ');
  } catch {
    // A 502 is an HTML page; the status says enough.
  }
  const error = new Error(
    `${method} ${url.replace(/\?.*/, '')} -> HTTP ${status}${message ? ` (${message})` : ''}`
  );
  error.status = status;
  return error;
}

/**
 * A thin GitHub client: JSON calls against the repository, the asset upload
 * host, and asset downloads. Injected `fetchImpl` and `sleep` make it testable
 * without the network.
 */
export function makeGitHubClient({
  token,
  repo = DEFAULT_REPO,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  userAgent = 'rankistan-state-store'
} = {}) {
  const headers = (extra = {}) => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  });

  // Network failures, 5xx and 429 are retried for requests that are safe to
  // repeat. GitHub's 502s are HTML pages that cost no rate limit.
  async function send(url, init, retry) {
    const attempts = retry ? ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
      const transient = response && (response.status >= 500 || response.status === 429);
      if (response && (!transient || attempt >= attempts)) return response;
      if (response) await response.text().catch(() => '');
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  async function json(method, route, { body, allow404 = false, retry } = {}) {
    const url = route.startsWith('https://')
      ? route
      : `https://api.github.com/repos/${repo}${route}`;
    const response = await send(
      url,
      {
        method,
        headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      },
      retry ?? (method === 'GET' || method === 'DELETE')
    );
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw httpError(method, url, response.status, text);
    return text ? JSON.parse(text) : null;
  }

  async function upload(uploadUrl, { name, label, bytes, contentType }) {
    const base = String(uploadUrl).replace(/\{[^}]*\}$/, '');
    const query = new URLSearchParams(label ? { name, label } : { name });
    const response = await send(
      `${base}?${query}`,
      { method: 'POST', headers: headers({ 'Content-Type': contentType }), body: bytes },
      false
    );
    const text = await response.text();
    if (!response.ok) throw httpError('POST', base, response.status, text);
    return JSON.parse(text);
  }

  // With a token, the asset API, which answers with a redirect to a signed URL
  // on another host; that URL is fetched without the token. Without one,
  // `browser_download_url`, which a public repository serves to anyone and
  // which costs no API quota.
  async function download(asset) {
    let response;
    if (token) {
      response = await send(
        asset.url,
        { headers: headers({ Accept: 'application/octet-stream' }), redirect: 'manual' },
        true
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`${asset.name}: redirect with no location`);
        response = await send(location, { headers: { 'User-Agent': userAgent } }, true);
      }
    } else {
      response = await send(
        asset.browser_download_url,
        { headers: { 'User-Agent': userAgent } },
        true
      );
    }
    if (!response.ok) throw new Error(`${asset.name}: download -> HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  return { repo, authenticated: Boolean(token), json, upload, download, sleep };
}

export function createStateStore({
  client,
  tag = STATE_TAG,
  keep = KEEP_ASSETS,
  log = console,
  now = () => Date.now()
}) {
  async function findRelease() {
    return client.json('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  }

  async function ensureRelease() {
    const existing = await findRelease();
    if (existing) return existing;
    try {
      const created = await client.json('POST', '/releases', {
        body: {
          tag_name: tag,
          name: 'Pipeline state',
          body: RELEASE_BODY,
          draft: false,
          // Never "Latest": that badge belongs to the real releases.
          prerelease: true,
          make_latest: 'false'
        }
      });
      log.log(`Created release ${tag}${created?.html_url ? ` (${created.html_url})` : ''}.`);
      return created;
    } catch (error) {
      // Someone else created it first. Theirs is the one to use.
      if (error.status === 422) {
        const raced = await findRelease();
        if (raced) return raced;
      }
      throw error;
    }
  }

  async function listAssets(release) {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await client.json(
        'GET',
        `/releases/${release.id}/assets?per_page=100&page=${page}`
      );
      all.push(...(batch || []));
      if (!batch || batch.length < 100) break;
    }
    return all;
  }

  async function readAsset(asset) {
    const bytes = await client.download(asset);
    // GitHub records a sha256 for every asset it stores; a mismatch is a
    // truncated or altered download.
    if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
      if (sha256(bytes) !== asset.digest) throw new Error('digest does not match the download');
    }
    return { ...decodeState(bytes, asset.name), bytes };
  }

  /**
   * The newest readable board, or `null` when nothing has ever been saved
   * (no release, or a release with no state assets). Throws when assets exist
   * and none of the newest MAX_LOAD_ATTEMPTS can be read: that is a broken
   * store, and treating it as empty would publish a board of one batch.
   */
  async function load() {
    const release = await findRelease();
    if (!release) {
      log.warn(`No release tagged ${tag} in ${client.repo}: no state has been saved yet.`);
      return null;
    }
    const candidates = newestFirst(await listAssets(release));
    if (candidates.length === 0) {
      log.warn(`Release ${tag} holds no state assets yet.`);
      return null;
    }

    const skipped = [];
    for (const asset of candidates.slice(0, MAX_LOAD_ATTEMPTS)) {
      try {
        const { payload, text, bytes } = await readAsset(asset);
        return { payload, text, bytes, asset, release, skipped };
      } catch (error) {
        log.warn(`Skipping state asset ${asset.name} (${asset.created_at}): ${error.message}`);
        skipped.push({ name: asset.name, error: error.message });
      }
    }
    throw new Error(
      `None of the newest ${skipped.length} state assets on ${tag} could be read: ` +
        skipped.map((s) => `${s.name} (${s.error})`).join('; ')
    );
  }

  async function uploadAsset(release, { name, label, bytes }) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await client.upload(release.upload_url, {
          name,
          label,
          bytes,
          contentType: 'application/gzip'
        });
      } catch (error) {
        const retryable = !error.status || error.status >= 500 || [422, 429].includes(error.status);
        if (!retryable || attempt >= ATTEMPTS) throw error;
        // A failed upload can still have landed, or left a `starter` asset
        // holding the name (which is the 422). Look before trying again.
        const same = (await listAssets(release)).find((asset) => asset.name === name);
        if (same?.state === 'uploaded' && same.size === bytes.length) return same;
        if (same) await client.json('DELETE', `/releases/assets/${same.id}`);
        await client.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Deletes state assets beyond the newest `keep`, and uploads abandoned in
   * `starter` state. Assets that are not state - anything attached by hand -
   * are never touched.
   */
  async function prune(release, justSaved) {
    const assets = await listAssets(release);
    // The asset just written is kept whatever the listing says, in case the
    // listing lags the upload.
    const kept = new Set([
      justSaved?.id,
      ...newestFirst(assets)
        .slice(0, keep)
        .map((a) => a.id),
      ...dailyCloses(assets, { now: now() }).map((a) => a.id)
    ]);
    const doomed = assets.filter(
      (asset) =>
        isStateAsset(asset) &&
        !kept.has(asset.id) &&
        (asset.state === 'uploaded' || now() - Date.parse(asset.created_at) > ABANDONED_UPLOAD_MS)
    );
    for (const asset of doomed) {
      await client.json('DELETE', `/releases/assets/${asset.id}`);
    }
    return doomed.map((asset) => asset.name);
  }

  /**
   * Saves a board (an object, JSON text or a Buffer of it) as the new newest
   * state, reads it back, then prunes. A failed prune does not fail the save:
   * the state is already written, and the next save prunes again. It is
   * returned as `pruneError` for the caller to surface.
   */
  async function save(board, { name, label } = {}) {
    if (!name || !isStateAsset({ name })) {
      throw new Error(
        `Refusing to save state under ${JSON.stringify(name)}: not a state asset name.`
      );
    }
    const bytes = encodeState(board);
    const release = await ensureRelease();
    const asset = await uploadAsset(release, { name, label, bytes });

    // Read back through the reader's own path, so a save that cannot be
    // loaded fails now, at the write, rather than at the next run's read.
    const readBack = await client.download(asset);
    if (!readBack.equals(bytes)) {
      throw new Error(`${name} did not read back byte for byte after upload`);
    }

    let pruned = [];
    let pruneError = null;
    try {
      pruned = await prune(release, asset);
    } catch (error) {
      pruneError = error.message;
    }
    return { asset, release, bytes: bytes.length, pruned, pruneError };
  }

  async function list() {
    const release = await findRelease();
    return release ? { release, assets: await listAssets(release) } : null;
  }

  return { load, save, prune, list, findRelease, ensureRelease, listAssets, readAsset };
}

/** Writes bytes exactly, through a same-directory temp file and a rename. */
export function writeFileAtomic(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

/**
 * Downloads the newest state to `target`, as the exact text that was saved.
 * With `ifMissing` an existing file is left alone, and a failure is a warning
 * rather than an error, so `npm run dev` still starts offline.
 */
export async function pullLatest({ store, target, ifMissing = false, log = console }) {
  if (ifMissing && fs.existsSync(target)) {
    log.log(`${target} exists; not pulling. Run \`npm run state:pull\` for the latest board.`);
    return { skipped: true };
  }
  try {
    const state = await store.load();
    if (!state) throw new Error(`no state has been saved on release ${STATE_TAG}`);
    writeFileAtomic(target, state.text);
    log.log(
      `Wrote ${state.payload.leaderboard.length} developers to ${target} from ${state.asset.name} ` +
        `(saved ${state.asset.created_at}, last_updated ${state.payload.last_updated}).`
    );
    return { state };
  } catch (error) {
    if (!ifMissing) throw error;
    log.warn(
      `Could not pull the latest board (${error.message}). Continuing without ${target}; ` +
        'the app will show its load error until `npm run state:pull` succeeds.'
    );
    return { error: error.message };
  }
}

/**
 * The rollback path. Writes the newest state to `target` - public/data.json -
 * only once it verifies, so that reverting the switch to release-backed state
 * and committing this one file puts the board back on main exactly as the
 * release last held it, and the pipeline that commits to main resumes from
 * there. `verify` is verifyPublished, passed in so this module keeps to
 * built-ins at load time.
 */
export async function restoreLatest({ store, target, verify, force = false, log = console }) {
  const state = await store.load();
  if (!state) {
    throw new Error(`no state has been saved on release ${STATE_TAG}; nothing to restore`);
  }

  const { errors } = verify(state.payload);
  if (errors.length > 0 && !force) {
    throw new Error(
      `${state.asset.name} fails verification with ${errors.length} problem(s), so nothing was ` +
        `written: ${errors.slice(0, 5).join('; ')}. Pass --force to restore it anyway.`
    );
  }
  writeFileAtomic(target, state.text);
  log.log(
    `Restored ${state.payload.leaderboard.length} developers to ${target} from ${state.asset.name} ` +
      `(saved ${state.asset.created_at}, last_updated ${state.payload.last_updated})` +
      `${errors.length > 0 ? `, despite ${errors.length} verification problem(s)` : ', verified'}.`
  );
  return { state, errors };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--label') flags.label = argv[(i += 1)];
    else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const USAGE = [
  'Usage: node scripts/state-store.js pull [path] [--if-missing]',
  '       node scripts/state-store.js restore [path] [--force]',
  '       node scripts/state-store.js save <path> [--label <text>]',
  '       node scripts/state-store.js list'
].join('\n');

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPO;

  if (command === 'pull') {
    const client = makeGitHubClient({ token: env.GITHUB_TOKEN || env.MY_GITHUB_PAT, repo });
    const target = path.resolve(positional[0] || path.join('public', 'data.json'));
    await pullLatest({
      store: createStateStore({ client }),
      target,
      ifMissing: flags['if-missing']
    });
    return;
  }

  if (command === 'restore') {
    const client = makeGitHubClient({ token: env.GITHUB_TOKEN || env.MY_GITHUB_PAT, repo });
    const target = path.resolve(positional[0] || path.join('public', 'data.json'));
    const { verifyPublished } = await import('./verify-published.js');
    const { loadModerationFile, MODERATION_PATH } = await import('./moderation.js');
    const moderation = loadModerationFile(path.join(process.cwd(), MODERATION_PATH));
    await restoreLatest({
      store: createStateStore({ client }),
      target,
      verify: (payload) => verifyPublished(payload, { moderation }),
      force: flags.force
    });
    console.log(
      [
        '',
        'To put the board back on main: commit this file, then push.',
        `  git add -f ${path.relative(process.cwd(), target)}`,
        '  git commit -m "chore: restore leaderboard from pipeline state"'
      ].join('\n')
    );
    return;
  }

  if (command === 'save') {
    if (!positional[0]) throw new Error(USAGE);
    if (!env.GITHUB_TOKEN) throw new Error('save needs GITHUB_TOKEN with contents: write.');
    const source = path.resolve(positional[0]);
    const text = fs.readFileSync(source, 'utf8');
    const developers = parseBoard(text, source).leaderboard.length;
    const name = stateAssetName({
      // Outside Actions there is no run id; a timestamp keeps the name unique.
      runId: env.GITHUB_RUN_ID || `local${Date.now()}`,
      runAttempt: env.GITHUB_RUN_ATTEMPT || 1
    });
    const label = [flags.label, `${developers} developers`].filter(Boolean).join(', ');
    const store = createStateStore({ client: makeGitHubClient({ token: env.GITHUB_TOKEN, repo }) });
    const result = await store.save(text, { name, label });
    console.log(
      `Saved ${source} as ${name} on release ${STATE_TAG}: ${developers} developers, ` +
        `${result.bytes} bytes gzipped, read back byte for byte.`
    );
    if (result.pruned.length > 0)
      console.log(`Pruned ${result.pruned.length} older state asset(s).`);
    if (result.pruneError) {
      console.log(`::warning title=STATE_PRUNE_FAILED::${result.pruneError}`);
    }
    return;
  }

  if (command === 'list') {
    const client = makeGitHubClient({ token: env.GITHUB_TOKEN || env.MY_GITHUB_PAT, repo });
    const listing = await createStateStore({ client }).list();
    if (!listing) {
      console.log(`No release tagged ${STATE_TAG} in ${repo}.`);
      return;
    }
    const ordered = newestFirst(listing.assets);
    console.log(`${ordered.length} state asset(s) on ${STATE_TAG}, newest first:`);
    for (const asset of ordered) {
      console.log(`  ${asset.created_at}  ${asset.name}  ${asset.size} B  ${asset.label || ''}`);
    }
    const other = listing.assets.length - ordered.length;
    if (other > 0) console.log(`  (+${other} other asset(s): not state, or not fully uploaded)`);
    return;
  }

  throw new Error(USAGE);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (isEntryPoint()) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
