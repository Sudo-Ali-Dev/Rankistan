import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  STATE_TAG,
  KEEP_ASSETS,
  MAX_LOAD_ATTEMPTS,
  stateAssetName,
  newestFirst,
  encodeState,
  decodeState,
  makeGitHubClient,
  createStateStore,
  pullLatest,
  restoreLatest
} from './state-store.js';
import { verifyPublished } from './verify-published.js';
import { mergeBatchIntoLeaderboard } from './run-all.js';

const REPO = 'owner/repo';
const API = `https://api.github.com/repos/${REPO}`;
const START = Date.parse('2026-10-13T00:00:00Z');
const quiet = { log: () => {}, warn: () => {} };

const board = (names, extra = {}) => ({
  last_updated: '2026-10-13T00:00:00.000Z',
  total_devs: names.length,
  leaderboard: names.map((username, i) => ({ username, rank: i + 1, score: 100 - i })),
  ...extra
});

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
  };
}

/**
 * Enough of the Releases API to exercise the store: releases by tag, release
 * creation, paginated asset listing, uploads on their own host, downloads that
 * redirect to a storage host, and deletes. `intercept` lets a test fail one
 * call before the fake handles it.
 */
function fakeGitHub({ withRelease = false } = {}) {
  const gh = {
    release: null,
    assets: [],
    bytes: new Map(),
    calls: [],
    created: [],
    clock: START,
    nextId: 500,
    intercept: null
  };

  const makeRelease = () => ({
    id: 77,
    tag_name: STATE_TAG,
    html_url: `https://github.com/${REPO}/releases/tag/${STATE_TAG}`,
    upload_url: `https://uploads.github.com/repos/${REPO}/releases/77/assets{?name,label}`
  });
  if (withRelease) gh.release = makeRelease();

  gh.seed = (name, contents, { createdAt, state = 'uploaded', digest } = {}) => {
    const id = (gh.nextId += 1);
    const bytes = Buffer.from(contents);
    gh.bytes.set(id, bytes);
    const asset = {
      id,
      name,
      state,
      size: bytes.length,
      created_at: new Date(createdAt ?? gh.clock).toISOString(),
      digest: digest ?? `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      url: `${API}/releases/assets/${id}`,
      browser_download_url: `https://github.com/${REPO}/releases/download/${STATE_TAG}/${name}`
    };
    gh.assets.push(asset);
    return asset;
  };

  gh.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const call = { method, url, headers: init.headers || {}, redirect: init.redirect };
    gh.calls.push(call);
    const hooked = gh.intercept?.(call, init);
    if (hooked) return hooked;

    const u = new URL(url);
    const route = `${method} ${u.host}${u.pathname}`;

    if (route === `GET api.github.com/repos/${REPO}/releases/tags/${STATE_TAG}`) {
      return gh.release ? response(200, gh.release) : response(404, { message: 'Not Found' });
    }
    if (route === `POST api.github.com/repos/${REPO}/releases`) {
      if (gh.release) {
        return response(422, {
          message: 'Validation Failed',
          errors: [{ code: 'already_exists' }]
        });
      }
      gh.created.push(JSON.parse(init.body));
      gh.release = makeRelease();
      return response(201, gh.release);
    }
    if (route === `GET api.github.com/repos/${REPO}/releases/77/assets`) {
      const per = Number(u.searchParams.get('per_page'));
      const page = Number(u.searchParams.get('page'));
      return response(200, gh.assets.slice((page - 1) * per, page * per));
    }
    if (route === `POST uploads.github.com/repos/${REPO}/releases/77/assets`) {
      const name = u.searchParams.get('name');
      if (gh.assets.some((a) => a.name === name)) {
        return response(422, {
          message: 'Validation Failed',
          errors: [{ code: 'already_exists' }]
        });
      }
      gh.clock += 3_600_000;
      const asset = gh.seed(name, init.body);
      asset.label = u.searchParams.get('label');
      asset.content_type = init.headers['Content-Type'];
      return response(201, asset);
    }
    let match = /^GET api\.github\.com\/repos\/owner\/repo\/releases\/assets\/(\d+)$/.exec(route);
    if (match && init.headers?.Accept === 'application/octet-stream') {
      return response(302, '<html>redirect</html>', {
        location: `https://release-assets.example.test/${match[1]}?sig=abc`
      });
    }
    match = /^GET release-assets\.example\.test\/(\d+)$/.exec(route);
    if (match) return response(200, gh.bytes.get(Number(match[1])));
    match = /^GET github\.com\/owner\/repo\/releases\/download\/pipeline-state\/(.+)$/.exec(route);
    if (match) {
      const asset = gh.assets.find((a) => a.name === match[1]);
      return asset ? response(200, gh.bytes.get(asset.id)) : response(404, 'Not Found');
    }
    match = /^DELETE api\.github\.com\/repos\/owner\/repo\/releases\/assets\/(\d+)$/.exec(route);
    if (match) {
      gh.assets = gh.assets.filter((a) => a.id !== Number(match[1]));
      return response(204);
    }
    throw new Error(`fake GitHub has no route for ${route}`);
  };

  return gh;
}

function storeFor(gh, { token = 'test-token', ...options } = {}) {
  const client = makeGitHubClient({
    token,
    repo: REPO,
    fetchImpl: gh.fetch,
    sleep: async () => {}
  });
  return createStateStore({ client, log: quiet, now: () => gh.clock, ...options });
}

const gz = (value) => zlib.gzipSync(Buffer.from(JSON.stringify(value)));

describe('state asset names and order', () => {
  it('names an asset after the run and attempt that wrote it', () => {
    expect(stateAssetName({ runId: 18234567890, runAttempt: 2 })).toBe(
      'state-18234567890-2.json.gz'
    );
    expect(() => stateAssetName({ runId: '../etc' })).toThrow(/alphanumeric/);
    expect(() => stateAssetName({ runId: 1, runAttempt: 0 })).toThrow(/attempt/);
  });

  it('orders by created_at, not by name, so a re-run attempt cannot jump the queue', () => {
    const assets = [
      { id: 1, name: 'state-900-1.json.gz', state: 'uploaded', created_at: '2026-10-13T01:00:00Z' },
      { id: 2, name: 'state-100-2.json.gz', state: 'uploaded', created_at: '2026-10-13T03:00:00Z' },
      { id: 3, name: 'state-500-1.json.gz', state: 'uploaded', created_at: '2026-10-13T02:00:00Z' },
      { id: 4, name: 'state-999-1.json.gz', state: 'starter', created_at: '2026-10-13T04:00:00Z' },
      { id: 5, name: 'notes.txt', state: 'uploaded', created_at: '2026-10-13T05:00:00Z' }
    ];
    expect(newestFirst(assets).map((a) => a.id)).toEqual([2, 3, 1]);
  });
});

describe('encodeState / decodeState', () => {
  it('round-trips the exact text, so a pulled file is byte-identical to what was saved', () => {
    const text = '{"last_updated":"x","total_devs":1,"leaderboard":[{"username":"a"}]}';
    expect(decodeState(encodeState(text)).text).toBe(text);
    expect(decodeState(encodeState(Buffer.from(text))).text).toBe(text);
  });

  it('refuses to encode something that is not a board', () => {
    expect(() => encodeState({ rows: [] })).toThrow(/no "leaderboard" array/);
    expect(() => encodeState('{not json')).toThrow(/not valid JSON/);
  });

  it('names what is wrong with a corrupt asset', () => {
    const truncated = encodeState(board(['a'])).subarray(0, 12);
    expect(() => decodeState(truncated, 'state-1-1.json.gz')).toThrow(
      /state-1-1\.json\.gz is not valid gzip/
    );
    expect(() => decodeState(zlib.gzipSync('{"leaderboard": 3}'))).toThrow(/leaderboard/);
  });

  it('accepts plain JSON, in case a proxy undoes the gzip in transit', () => {
    expect(decodeState(Buffer.from(JSON.stringify(board(['a'])))).payload.total_devs).toBe(1);
  });
});

describe('createStateStore against a fake Releases API', () => {
  it('reports nothing saved, rather than an empty board, when the release is missing', async () => {
    const gh = fakeGitHub();
    expect(await storeFor(gh).load()).toBeNull();
  });

  it('reports nothing saved when the release exists but holds no state assets', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('README.txt', 'not state');
    expect(await storeFor(gh).load()).toBeNull();
  });

  it('creates the release on the first save, as a prerelease never marked latest', async () => {
    const gh = fakeGitHub();
    const store = storeFor(gh);
    const saved = await store.save(board(['a', 'b']), {
      name: 'state-1-1.json.gz',
      label: 'batch 3'
    });

    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]).toMatchObject({
      tag_name: STATE_TAG,
      draft: false,
      prerelease: true,
      make_latest: 'false'
    });
    expect(saved.asset).toMatchObject({ name: 'state-1-1.json.gz', label: 'batch 3' });
    expect(saved.asset.content_type).toBe('application/gzip');

    const loaded = await store.load();
    expect(loaded.asset.name).toBe('state-1-1.json.gz');
    expect(loaded.payload.leaderboard.map((r) => r.username)).toEqual(['a', 'b']);
  });

  it('reuses the release on every later save', async () => {
    const gh = fakeGitHub();
    const store = storeFor(gh);
    await store.save(board(['a']), { name: 'state-1-1.json.gz' });
    await store.save(board(['b']), { name: 'state-2-1.json.gz' });
    expect(gh.created).toHaveLength(1);
    expect((await store.load()).payload.leaderboard[0].username).toBe('b');
  });

  it('uses the release someone else created first if it loses that race', async () => {
    const gh = fakeGitHub({ withRelease: true });
    let looked = false;
    gh.intercept = (call) => {
      // The first lookup misses; the other writer's release lands just after.
      if (!looked && call.url.endsWith(`/releases/tags/${STATE_TAG}`)) {
        looked = true;
        return response(404, { message: 'Not Found' });
      }
      return null;
    };
    const saved = await storeFor(gh).save(board(['a']), { name: 'state-1-1.json.gz' });
    expect(gh.created).toEqual([]);
    expect(saved.release.id).toBe(77);
  });

  it('takes the newest asset by created_at', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-300-1.json.gz', gz(board(['old'])), { createdAt: START });
    gh.seed('state-100-2.json.gz', gz(board(['newest'])), { createdAt: START + 7_200_000 });
    gh.seed('state-200-1.json.gz', gz(board(['middle'])), { createdAt: START + 3_600_000 });
    const loaded = await storeFor(gh).load();
    expect(loaded.asset.name).toBe('state-100-2.json.gz');
    expect(loaded.payload.leaderboard[0].username).toBe('newest');
  });

  it('falls back to the next-newest when the newest is corrupt', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-1-1.json.gz', gz(board(['good'])), { createdAt: START });
    gh.seed('state-2-1.json.gz', Buffer.from([0x1f, 0x8b, 0, 1, 2]), { createdAt: START + 1000 });
    const loaded = await storeFor(gh).load();
    expect(loaded.asset.name).toBe('state-1-1.json.gz');
    expect(loaded.skipped).toEqual([
      { name: 'state-2-1.json.gz', error: expect.stringMatching(/not valid gzip/) }
    ]);
  });

  it('treats a download that does not match its recorded digest as corrupt', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-1-1.json.gz', gz(board(['good'])), { createdAt: START });
    gh.seed('state-2-1.json.gz', gz(board(['altered'])), {
      createdAt: START + 1000,
      digest: `sha256:${'0'.repeat(64)}`
    });
    const loaded = await storeFor(gh).load();
    expect(loaded.payload.leaderboard[0].username).toBe('good');
    expect(loaded.skipped[0].error).toMatch(/digest/);
  });

  it('throws, rather than reporting an empty store, when no recent asset can be read', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-0-1.json.gz', gz(board(['too-old-to-reach'])), { createdAt: START });
    for (let i = 1; i <= MAX_LOAD_ATTEMPTS; i += 1) {
      gh.seed(`state-${i}-1.json.gz`, 'garbage', { createdAt: START + i * 1000 });
    }
    await expect(storeFor(gh).load()).rejects.toThrow(
      new RegExp(`None of the newest ${MAX_LOAD_ATTEMPTS} state assets`)
    );
  });

  it(`keeps the newest ${KEEP_ASSETS} and prunes the rest, never touching other files`, async () => {
    const gh = fakeGitHub({ withRelease: true });
    for (let i = 0; i < KEEP_ASSETS + 3; i += 1) {
      gh.seed(`state-${i}-1.json.gz`, gz(board([`u${i}`])), { createdAt: START + i * 1000 });
    }
    gh.seed('notes.txt', 'attached by hand', { createdAt: START - 10 * 86_400_000 });
    // A dead upload from long ago, and one that may still be in flight.
    gh.seed('state-dead-1.json.gz', 'x', { createdAt: START - 86_400_000, state: 'starter' });
    // The fake's upload advances its clock an hour, so this one is ten minutes
    // old when the prune runs.
    gh.clock = START + 86_400_000;
    gh.seed('state-live-1.json.gz', 'x', { createdAt: gh.clock + 3_000_000, state: 'starter' });

    const saved = await storeFor(gh).save(board(['latest']), { name: 'state-new-1.json.gz' });

    expect(saved.pruned.sort()).toEqual(
      [
        'state-0-1.json.gz',
        'state-1-1.json.gz',
        'state-2-1.json.gz',
        'state-3-1.json.gz',
        'state-dead-1.json.gz'
      ].sort()
    );
    const names = gh.assets.map((a) => a.name);
    expect(names).toContain('notes.txt');
    expect(names).toContain('state-live-1.json.gz');
    expect(names).toContain('state-new-1.json.gz');
    expect(newestFirst(gh.assets)).toHaveLength(KEEP_ASSETS);
  });

  it('does not fail a save whose prune fails; the state is already written', async () => {
    const gh = fakeGitHub({ withRelease: true });
    for (let i = 0; i < KEEP_ASSETS + 1; i += 1) {
      gh.seed(`state-${i}-1.json.gz`, gz(board([`u${i}`])), { createdAt: START + i });
    }
    gh.intercept = (call) => (call.method === 'DELETE' ? response(403, { message: 'nope' }) : null);
    const saved = await storeFor(gh).save(board(['a']), { name: 'state-x-1.json.gz' });
    expect(saved.pruneError).toMatch(/HTTP 403/);
    expect((await storeFor(gh).load()).asset.name).toBe('state-x-1.json.gz');
  });

  it('downloads through the asset API with a token, and never sends it to the storage host', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-1-1.json.gz', gz(board(['a'])));
    await storeFor(gh).load();

    const api = gh.calls.find((c) => c.url.includes('/releases/assets/'));
    expect(api.redirect).toBe('manual');
    expect(api.headers.Authorization).toBe('Bearer test-token');
    const storage = gh.calls.find((c) => c.url.startsWith('https://release-assets.example.test/'));
    expect(storage.headers.Authorization).toBeUndefined();
  });

  it('downloads from browser_download_url without a token, as a public repository allows', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-1-1.json.gz', gz(board(['a'])));
    const loaded = await storeFor(gh, { token: null }).load();
    expect(loaded.payload.leaderboard[0].username).toBe('a');
    expect(gh.calls.every((c) => !c.headers.Authorization)).toBe(true);
    expect(gh.calls.some((c) => c.url.startsWith('https://github.com/'))).toBe(true);
  });

  it('retries a 502 on read, which GitHub serves as HTML', async () => {
    const gh = fakeGitHub({ withRelease: true });
    gh.seed('state-1-1.json.gz', gz(board(['a'])));
    let failures = 1;
    gh.intercept = (call) =>
      call.url.endsWith(`/releases/tags/${STATE_TAG}`) && failures-- > 0
        ? response(502, '<html>Bad Gateway</html>')
        : null;
    expect((await storeFor(gh).load()).asset.name).toBe('state-1-1.json.gz');
  });

  it('recovers an upload that failed part-way and left its name taken', async () => {
    const gh = fakeGitHub({ withRelease: true });
    let first = true;
    gh.intercept = (call) => {
      if (call.method === 'POST' && call.url.startsWith('https://uploads.github.com/') && first) {
        first = false;
        gh.seed('state-9-1.json.gz', 'partial', { state: 'starter' });
        return response(502, '<html>Bad Gateway</html>');
      }
      return null;
    };
    const saved = await storeFor(gh).save(board(['a']), { name: 'state-9-1.json.gz' });
    expect(saved.asset.state).toBe('uploaded');
    expect(gh.assets.filter((a) => a.name === 'state-9-1.json.gz')).toHaveLength(1);
    expect((await storeFor(gh).load()).payload.leaderboard[0].username).toBe('a');
  });

  it('refuses to save under a name readers would not recognise', async () => {
    const gh = fakeGitHub({ withRelease: true });
    await expect(storeFor(gh).save(board(['a']), { name: 'data.json' })).rejects.toThrow(
      /not a state asset name/
    );
    expect(gh.calls).toEqual([]);
  });
});

describe('pullLatest', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-pull-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the saved text exactly', async () => {
    const gh = fakeGitHub({ withRelease: true });
    const text = JSON.stringify(board(['a', 'b']));
    gh.seed('state-1-1.json.gz', zlib.gzipSync(text));
    const target = path.join(dir, 'public', 'data.json');
    await pullLatest({ store: storeFor(gh), target, log: quiet });
    expect(fs.readFileSync(target, 'utf8')).toBe(text);
  });

  it('fails when nothing has been saved', async () => {
    const target = path.join(dir, 'data.json');
    await expect(pullLatest({ store: storeFor(fakeGitHub()), target, log: quiet })).rejects.toThrow(
      /no state has been saved/
    );
  });

  it('with --if-missing, leaves an existing file alone and makes no request', async () => {
    const gh = fakeGitHub({ withRelease: true });
    const target = path.join(dir, 'data.json');
    fs.writeFileSync(target, 'mine');
    const result = await pullLatest({ store: storeFor(gh), target, ifMissing: true, log: quiet });
    expect(result.skipped).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('mine');
    expect(gh.calls).toEqual([]);
  });

  it('with --if-missing, warns instead of failing, so the dev server still starts offline', async () => {
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    const client = makeGitHubClient({ repo: REPO, fetchImpl: offline, sleep: async () => {} });
    const store = createStateStore({ client, log: quiet });
    const target = path.join(dir, 'data.json');
    const result = await pullLatest({ store, target, ifMissing: true, log: quiet });
    expect(result.error).toMatch(/ENOTFOUND/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('restoreLatest, the rollback path', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-restore-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ranked = (names, batch) =>
    board(names, {
      leaderboard: names.map((username, i) => ({
        username,
        rank: i + 1,
        score: 900 - i,
        batch_index: batch
      }))
    });

  it('writes the newest state, verified, as a file the main-branch pipeline continues from', async () => {
    const gh = fakeGitHub({ withRelease: true });
    const text = JSON.stringify(ranked(['a', 'b', 'c'], 4));
    gh.seed('state-1-1.json.gz', zlib.gzipSync(text));
    const target = path.join(dir, 'public', 'data.json');

    await restoreLatest({ store: storeFor(gh), target, verify: verifyPublished, log: quiet });
    expect(fs.readFileSync(target, 'utf8')).toBe(text);

    // The next batch on the old pipeline merges onto it like any committed file.
    const next = mergeBatchIntoLeaderboard({
      batchIndex: 4,
      newEntries: [{ username: 'a', batch_index: 4, score: 950 }],
      evaluated: ['a', 'b', 'c'],
      targetPath: target
    });
    expect(next.leaderboard.map((r) => r.username)).toEqual(['a']);
  });

  it('writes nothing when the state fails verification, unless forced', async () => {
    const gh = fakeGitHub({ withRelease: true });
    const broken = ranked(['a', 'b'], 4);
    broken.leaderboard[1].rank = 7;
    gh.seed('state-1-1.json.gz', gz(broken));
    const target = path.join(dir, 'data.json');
    const store = storeFor(gh);

    await expect(
      restoreLatest({ store, target, verify: verifyPublished, log: quiet })
    ).rejects.toThrow(/fails verification.*--force/);
    expect(fs.existsSync(target)).toBe(false);

    const forced = await restoreLatest({
      store,
      target,
      verify: verifyPublished,
      force: true,
      log: quiet
    });
    expect(forced.errors).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).leaderboard).toHaveLength(2);
  });

  it('refuses when there is nothing to restore', async () => {
    await expect(
      restoreLatest({
        store: storeFor(fakeGitHub()),
        target: path.join(dir, 'data.json'),
        verify: verifyPublished,
        log: quiet
      })
    ).rejects.toThrow(/nothing to restore/);
  });
});
