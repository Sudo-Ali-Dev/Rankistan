import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
  HISTORY_TAG,
  KEEP_VERSIONS,
  MAX_DAYS_PER_RUN,
  assetMonth,
  createHistoryStore,
  historyAssetName,
  updateHistory
} from './history-store.js';
import { serializeMonth } from './rank-history.js';
import { measuredRow } from '../src/model/__fixtures__/measured.js';

const quiet = { log() {}, warn() {} };

/** The releases API, in memory: one release per tag, assets uploaded in order. */
function fakeReleases() {
  const releases = new Map();
  const calls = [];
  let nextId = 1;
  let clock = Date.parse('2026-10-18T00:00:00Z');
  const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  const client = {
    repo: 'o/r',
    async json(method, route, { body } = {}) {
      calls.push(`${method} ${route}`);
      let match = /^\/releases\/tags\/(.+)$/.exec(route);
      if (method === 'GET' && match) return releases.get(decodeURIComponent(match[1])) ?? null;
      if (method === 'POST' && route === '/releases') {
        const release = {
          id: nextId++,
          tag_name: body.tag_name,
          upload_url: `u/${body.tag_name}`,
          assets: []
        };
        releases.set(body.tag_name, release);
        return release;
      }
      match = /^\/releases\/(\d+)\/assets\?per_page=100&page=(\d+)$/.exec(route);
      if (method === 'GET' && match) {
        const release = [...releases.values()].find((r) => r.id === Number(match[1]));
        return Number(match[2]) === 1 ? release.assets.map(({ bytes, ...a }) => a) : [];
      }
      match = /^\/releases\/assets\/(\d+)$/.exec(route);
      if (method === 'DELETE' && match) {
        for (const r of releases.values())
          r.assets = r.assets.filter((a) => a.id !== Number(match[1]));
        return null;
      }
      throw fail(404);
    },
    async upload(url, { name, bytes }) {
      calls.push(`UPLOAD ${name}`);
      const release = [...releases.values()].find((r) => r.upload_url === url);
      clock += 1000;
      const asset = {
        id: nextId++,
        name,
        state: 'uploaded',
        created_at: new Date(clock).toISOString(),
        bytes
      };
      release.assets.push(asset);
      return asset;
    },
    async download(asset) {
      calls.push(`DOWNLOAD ${asset.name}`);
      for (const r of releases.values()) {
        const found = r.assets.find((a) => a.id === asset.id);
        if (found) return Buffer.from(found.bytes);
      }
      throw fail(404);
    }
  };
  const assetsOf = (tag) => releases.get(tag)?.assets.map((a) => a.name) ?? [];
  return { client, calls, assetsOf, releases };
}

const dev = (name, id, days) =>
  measuredRow(name, { days, githubId: id }, { scored_at: '2026-10-17T03:00:00Z' });
function closeOf(rows) {
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return { last_updated: '2026-10-17T18:50:00.000Z', leaderboard: rows };
}
/** Closing boards by date, as closesFromStateStore gives them. */
function closes(byDate) {
  const reads = [];
  return {
    reads,
    async asset(date) {
      return byDate[date] ? { name: `state-${date}-1.json.gz`, date } : null;
    },
    async read(asset) {
      reads.push(asset.date);
      return byDate[asset.date];
    }
  };
}
const AT_18 = Date.parse('2026-10-18T06:00:00Z'); // 11:00 on 18 October in Pakistan

describe('historyAssetName', () => {
  it('names a month by its last date and the run that wrote it', () => {
    const name = historyAssetName({
      month: '2026-10',
      lastDate: '2026-10-17',
      runId: '42',
      runAttempt: 1
    });
    expect(name).toBe('history-2026-10-d17-42-1.ndjson.gz');
    expect(assetMonth({ name })).toBe('2026-10');
    expect(assetMonth({ name: 'state-1-1.json.gz' })).toBeNull();
  });
});

describe('updateHistory', () => {
  const run = (fake, options) =>
    updateHistory({
      history: createHistoryStore({ client: fake.client, log: quiet }),
      runId: 'r1',
      log: quiet,
      ...options
    });

  it('writes yesterday from its closing board on the first run of a date, then nothing until the next date', async () => {
    const fake = fakeReleases();
    const boards = closes({ '2026-10-17': closeOf([dev('ana', 1, 20), dev('bob', 2, 9)]) });
    const result = await run(fake, { closes: boards, now: AT_18 });
    expect(result).toMatchObject({ through: '2026-10-17', written: ['2026-10-17'], gaps: [] });
    expect(fake.assetsOf(HISTORY_TAG)).toEqual(['history-2026-10-d17-r1-1.ndjson.gz']);

    const calls = fake.calls.length;
    const again = await run(fake, {
      closes: boards,
      now: AT_18 + 3_600_000,
      through: result.through
    });
    expect(again.written).toEqual([]);
    expect(fake.calls.length).toBe(calls); // not a single request
  });

  it('records a date with no closing board as a gap, and catches up a week at a time', async () => {
    const fake = fakeReleases();
    const board = closeOf([dev('ana', 1, 20)]);
    const boards = closes({ '2026-10-17': board, '2026-10-19': board });
    const result = await run(fake, { closes: boards, now: Date.parse('2026-11-01T06:00:00Z') });
    expect(result.written).toHaveLength(MAX_DAYS_PER_RUN);
    expect(result.written[0]).toBe('2026-10-17');
    expect(result.gaps).toContain('2026-10-18');
    expect(result.through).toBe('2026-10-23');
  });

  it('never writes a date twice when the state that recorded it failed to save', async () => {
    const fake = fakeReleases();
    const boards = closes({ '2026-10-17': closeOf([dev('ana', 1, 20)]) });
    await run(fake, { closes: boards, now: AT_18 });
    // The next run still believes nothing was written.
    const repeat = await run(fake, { closes: boards, now: AT_18 + 3_600_000, runId: 'r2' });
    expect(repeat.written).toEqual([]);
    expect(repeat.through).toBe('2026-10-17'); // and the state catches up with the history
    expect(fake.assetsOf(HISTORY_TAG)).toHaveLength(1);
  });

  it('removes a newly opted-out account from every month and every older copy', async () => {
    const fake = fakeReleases();
    const board = closeOf([dev('ana', 1, 20), dev('bob', 2, 9)]);
    const boards = closes({ '2026-10-17': board, '2026-10-18': board });
    let state = await run(fake, { closes: boards, now: AT_18 });
    state = await run(fake, {
      closes: boards,
      now: AT_18 + 86_400_000,
      through: state.through,
      runId: 'r2'
    });
    expect(fake.assetsOf(HISTORY_TAG)).toHaveLength(KEEP_VERSIONS);

    const optedOut = new Set([2]);
    const scrubbed = await run(fake, {
      closes: boards,
      now: AT_18 + 86_400_000 + 3_600_000,
      through: state.through,
      scrubbed: state.scrubbed,
      optedOut,
      runId: 'r3'
    });
    expect(scrubbed.purged).toEqual(['2026-10']);
    expect(scrubbed.scrubbed).toEqual([2]);
    const names = fake.assetsOf(HISTORY_TAG);
    expect(names).toEqual(['history-2026-10-d18-r3-1.ndjson.gz']);
    const bytes = [...fake.releases.get(HISTORY_TAG).assets][0].bytes;
    expect(zlib.gunzipSync(bytes).toString()).not.toContain('"bob"');

    // Already scrubbed: the next run makes no request for it.
    const calls = fake.calls.length;
    await run(fake, {
      closes: boards,
      now: AT_18 + 86_400_000 + 7_200_000,
      through: scrubbed.through,
      scrubbed: scrubbed.scrubbed,
      optedOut,
      runId: 'r4'
    });
    expect(fake.calls.length).toBe(calls);
  });

  it('refuses to write over a month none of whose versions reads', async () => {
    const fake = fakeReleases();
    const store = createHistoryStore({ client: fake.client, log: quiet });
    await store.writeMonth('2026-10', [{ v: 1, d: '2026-10-17', gap: 'no_state' }], {
      runId: 'r0'
    });
    fake.releases.get(HISTORY_TAG).assets[0].bytes = Buffer.from('not gzip');
    await expect(
      run(fake, {
        closes: closes({}),
        now: Date.parse('2026-10-19T06:00:00Z'),
        through: '2026-10-17'
      })
    ).rejects.toThrow(/no version of 2026-10 reads/);
  });

  it('reads the newest version of a month that parses', async () => {
    const fake = fakeReleases();
    const store = createHistoryStore({ client: fake.client, log: quiet });
    const good = [{ v: 1, d: '2026-10-17', gap: 'no_state' }];
    await store.writeMonth('2026-10', good, { runId: 'r0' });
    await store.writeMonth('2026-10', [...good, { v: 1, d: '2026-10-18', gap: 'no_state' }], {
      runId: 'r1'
    });
    fake.releases.get(HISTORY_TAG).assets[1].bytes = zlib.gzipSync('{"broken"');
    expect(await store.readMonth('2026-10')).toEqual(good);
    expect(serializeMonth(good)).toContain('2026-10-17');
  });
});
