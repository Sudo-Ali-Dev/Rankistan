// Rank History's store: the `board-history` release, one gzipped NDJSON file per month of daily
// records (scripts/rank-history.js). It follows the state store (scripts/state-store.js): a
// prerelease never marked latest, assets read newest first by upload time, the first that parses
// taken, every upload read back byte for byte. A month is rewritten whole, as a new asset, and the
// newest KEEP_VERSIONS of each month are kept, except after an opt-out, when every older version
// is deleted too: the release is public, and a deleted history must not survive in an old copy.
//
// Asset names: history-YYYY-MM-dDD-<run id>-<attempt>.ndjson.gz, DD the last date the file holds.
//
// Writes are serialized by the pipeline's concurrency group, as the state's are.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  HISTORY_START,
  addDays,
  appendRecords,
  dayRecord,
  datesBetween,
  gapRecord,
  monthOf,
  parseMonth,
  pktDateOf,
  scrubRecord,
  serializeMonth
} from './rank-history.js';

export const HISTORY_TAG = 'board-history';
export const KEEP_VERSIONS = 2;
const NAME_RE = /^history-(\d{4}-\d{2})-d(\d{2})-([A-Za-z0-9]+)-(\d+)\.ndjson\.gz$/;

const RELEASE_BODY = [
  'Rank History for the leaderboard. Not a software release.',
  '',
  'One file per month, gzipped NDJSON, one line per Pakistan date: where every developer on the',
  "board stood at that day's close. Written by `.github/workflows/update-digest.yml`; see",
  '`scripts/rank-history.js` and `docs/rank-history-design.md`. A developer who opts out is',
  'removed from every file.'
].join('\n');

/** A month file's name. */
export function historyAssetName({ month, lastDate, runId, runAttempt = 1 }) {
  const name = `history-${month}-d${lastDate.slice(8, 10)}-${runId}-${runAttempt}.ndjson.gz`;
  if (!NAME_RE.test(name)) throw new Error(`not a history asset name: ${JSON.stringify(name)}`);
  return name;
}

/** The month a history asset holds, or null for any other asset. */
export function assetMonth(asset) {
  const match = typeof asset?.name === 'string' ? NAME_RE.exec(asset.name) : null;
  return match ? match[1] : null;
}

/** Uploaded history assets of `month`, newest first (upload time, then the id that only grows). */
export function monthVersions(assets, month) {
  return (assets || [])
    .filter((asset) => asset.state === 'uploaded' && assetMonth(asset) === month)
    .sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id) - Number(a.id)
    );
}

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

/** `client` is the state store's GitHub client (makeGitHubClient in scripts/state-store.js). */
export function createHistoryStore({ client, tag = HISTORY_TAG, log = console }) {
  let release = null;
  let assets = null;

  async function findRelease() {
    return client.json('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  }

  async function ensureRelease() {
    if (release) return release;
    release = await findRelease();
    if (release) return release;
    try {
      release = await client.json('POST', '/releases', {
        body: {
          tag_name: tag,
          name: 'Rank History',
          body: RELEASE_BODY,
          draft: false,
          prerelease: true,
          make_latest: 'false'
        }
      });
      log.log(`Created release ${tag}.`);
    } catch (error) {
      if (error.status !== 422) throw error;
      release = await findRelease();
      if (!release) throw error;
    }
    return release;
  }

  async function listAssets({ fresh = false } = {}) {
    if (assets && !fresh) return assets;
    const found = await findRelease();
    if (!found) return (assets = []);
    release = found;
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await client.json(
        'GET',
        `/releases/${found.id}/assets?per_page=100&page=${page}`
      );
      all.push(...(batch || []));
      if (!batch || batch.length < 100) break;
    }
    return (assets = all);
  }

  async function readAsset(asset, month) {
    const bytes = await client.download(asset);
    if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
      if (sha256(bytes) !== asset.digest) throw new Error('digest does not match the download');
    }
    return parseMonth(zlib.gunzipSync(bytes).toString('utf8'), month);
  }

  /** The months the release holds, oldest first. */
  async function months() {
    return [...new Set((await listAssets()).map(assetMonth).filter(Boolean))].sort();
  }

  /**
   * A month's records, oldest first: the newest version that reads. [] for a month never written.
   * Throws when versions exist and none reads, since writing over it would lose the month.
   */
  async function readMonth(month) {
    const versions = monthVersions(await listAssets(), month);
    const errors = [];
    for (const asset of versions) {
      try {
        return await readAsset(asset, month);
      } catch (error) {
        log.warn(`Skipping history asset ${asset.name}: ${error.message}`);
        errors.push(`${asset.name} (${error.message})`);
      }
    }
    if (versions.length > 0) throw new Error(`no version of ${month} reads: ${errors.join('; ')}`);
    return [];
  }

  /**
   * Writes a month whole as its newest version, reads it back, then deletes older versions beyond
   * KEEP_VERSIONS, or every older one when `purge` (an opt-out) says no old copy may remain.
   */
  async function writeMonth(month, records, { runId, runAttempt, purge = false }) {
    if (records.length === 0) throw new Error(`refusing to write an empty ${month}`);
    const bytes = zlib.gzipSync(Buffer.from(serializeMonth(records), 'utf8'), { level: 9 });
    const name = historyAssetName({ month, lastDate: records.at(-1).d, runId, runAttempt });
    const target = await ensureRelease();
    const before = monthVersions(await listAssets({ fresh: true }), month);
    if (before.some((asset) => asset.name === name)) {
      throw new Error(`${name} already exists: this run has written ${month} already`);
    }
    const asset = await client.upload(target.upload_url, {
      name,
      bytes,
      contentType: 'application/gzip'
    });
    const back = await client.download(asset);
    if (!back.equals(bytes)) throw new Error(`${name} did not read back byte for byte`);
    const doomed = purge ? before : before.slice(KEEP_VERSIONS - 1);
    for (const old of doomed) await client.json('DELETE', `/releases/assets/${old.id}`);
    assets = null;
    return { name, bytes: bytes.length, deleted: doomed.map((a) => a.name) };
  }

  return { months, readMonth, writeMonth, listAssets };
}

/** Days one run writes at most: a run that falls behind catches up a week at a time. */
export const MAX_DAYS_PER_RUN = 7;

/**
 * Brings Rank History up to the day before `now`'s Pakistan date, and removes every account in
 * `optedOut` from all of it whenever one is not yet in `scrubbed`. A run on the same date as the
 * last one, with no new opt-out, makes no request at all.
 *
 * - `history` is a history store (createHistoryStore).
 * - `closes` gives each date's closing board: `asset(date)`, the state asset or null, and
 *   `read(asset)`, its payload (closesFromStateStore). A date without one is recorded as a gap.
 * - `through` is the last date written, as the state carries it, or null before the first.
 *
 * A date the history already holds is skipped, never written twice, so a run whose state failed
 * to save after writing the history only repeats the reads. Returns `{through, scrubbed, written,
 * gaps, purged}`.
 */
export async function updateHistory({
  history,
  closes,
  through = null,
  scrubbed = [],
  optedOut = new Set(),
  now,
  moderation = [],
  runId,
  runAttempt = 1,
  maxDays = MAX_DAYS_PER_RUN,
  log = console
}) {
  const yesterday = addDays(pktDateOf(new Date(now).toISOString()), -1);
  const start = through ? addDays(through, 1) : HISTORY_START;
  const end = [yesterday, addDays(start, maxDays - 1)].sort()[0];
  const done = new Set(scrubbed);
  const fresh = [...optedOut].filter((id) => !done.has(id));
  const dates = start <= end ? datesBetween(start, end) : [];
  const result = {
    through,
    scrubbed: [...done].sort((a, b) => a - b),
    written: [],
    gaps: [],
    purged: []
  };
  if (dates.length === 0 && fresh.length === 0) return result;

  const months = new Map();
  const dirty = new Set();
  const purge = new Set();
  const load = async (month) => {
    if (!months.has(month)) months.set(month, await history.readMonth(month));
    return months.get(month);
  };

  if (fresh.length > 0) {
    for (const month of await history.months()) {
      let changed = false;
      const records = (await load(month)).map((record) => {
        const scrub = scrubRecord(record, optedOut);
        changed ||= scrub.changed;
        return scrub.record;
      });
      if (changed) {
        months.set(month, records);
        dirty.add(month);
        purge.add(month);
      }
    }
  }

  for (const date of dates) {
    const records = await load(monthOf(date));
    if (records.some((record) => record.d === date)) continue;
    const day = addDays(date, -1);
    const previous =
      date > HISTORY_START ? (await load(monthOf(day))).find((record) => record.d === day) : null;
    const asset = await closes.asset(date);
    let record;
    if (!asset) {
      record = gapRecord(date);
      result.gaps.push(date);
    } else {
      const close = await closes.read(asset);
      record = dayRecord({
        date,
        close,
        state: asset.name,
        previous: previous ?? null,
        moderation,
        optedOut
      });
    }
    months.set(monthOf(date), appendRecords(records, [record]));
    dirty.add(monthOf(date));
    result.written.push(date);
  }

  for (const month of [...dirty].sort()) {
    const saved = await history.writeMonth(month, months.get(month), {
      runId,
      runAttempt,
      purge: purge.has(month)
    });
    if (purge.has(month)) result.purged.push(month);
    log.log(
      `Rank History: wrote ${saved.name} (${saved.bytes} bytes)` +
        (saved.deleted.length ? `, deleted ${saved.deleted.length} older version(s).` : '.')
    );
  }
  if (dates.length > 0) result.through = dates.at(-1);
  if (fresh.length > 0) result.scrubbed = [...optedOut].sort((a, b) => a - b);
  return result;
}

/**
 * Each date's closing board from the state store: the newest state uploaded on that Pakistan
 * date (dailyCloses in scripts/state-store.js), listed once, and only when first asked for.
 */
export function closesFromStateStore(store, { now, dailyCloses }) {
  let byDate = null;
  return {
    async asset(date) {
      if (!byDate) {
        const listed = await store.list();
        byDate = new Map(
          dailyCloses(listed?.assets ?? [], { now }).map((asset) => [
            pktDateOf(asset.created_at),
            asset
          ])
        );
      }
      return byDate.get(date) ?? null;
    },
    async read(asset) {
      return (await store.readAsset(asset)).payload;
    }
  };
}
