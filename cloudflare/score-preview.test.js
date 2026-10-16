import { describe, it, expect } from 'vitest';
import {
  MODERATION_URL,
  PREVIEW_PER_IP,
  PREVIEW_TOTAL,
  PreviewCache,
  handleScorePreviewRequest,
  loadModeration,
  previewScore
} from './score-preview.js';
import { RateLimiter } from './rate-limiter.js';
import { NOW, fakeGitHub, mergedNode, person } from '../scripts/measure/fake-contributions.js';
import {
  measureShadowContributions,
  createShadowClient
} from '../scripts/measure/contributions.js';
import { scoreModel } from '../src/model/next/score.js';

const people = () => ({
  ana: person('ana', {
    id: 7,
    commits: { 'ana/app': { 0: 1, 3: 2, 9: 1, 20: 4, 28: 1 } },
    accepted: [mergedNode(25, 'stdlib-js/stdlib', 'kgryte', { stars: 6000 })]
  })
});

/** GitHub and rankistan.dev, as one fetch. */
function upstream({ moderation = { repositories: [] }, onRequest } = {}) {
  const github = fakeGitHub(people(), { onRequest });
  const calls = { moderation: 0 };
  async function fetchImpl(url, init) {
    if (String(url) === MODERATION_URL) {
      calls.moderation += 1;
      if (moderation === 'down') return new Response('nope', { status: 500 });
      return Response.json(moderation);
    }
    return github.fetchImpl(url, init);
  }
  return { fetchImpl, github, calls };
}

function memoryNamespace(make) {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get: (id) => {
      if (!objects.has(id)) {
        const state = { storage: new Map() };
        state.storage.get = Map.prototype.get.bind(state.storage);
        state.storage.put = async (k, v) => state.storage.set(k, v);
        objects.set(id, make(state));
      }
      const object = objects.get(id);
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
    objects
  };
}

const jsonResponse = (body, status = 200) =>
  status === 204 ? new Response(null, { status }) : Response.json(body, { status });

function call(path, { env = {}, limited = false, method = 'GET', fetchImpl, now = NOW } = {}) {
  const request = new Request(`https://w.test${path}`, { method });
  return handleScorePreviewRequest(
    request,
    { GITHUB_PREVIEW_TOKEN: 't', ...env },
    { jsonResponse, corsOrigin: '*', isLimited: async () => limited },
    { now, fetchImpl }
  );
}

describe('previewScore', () => {
  it('gives exactly the score the pipeline computes from the same measurement', async () => {
    const { fetchImpl } = upstream();
    const preview = await previewScore('ana', { token: 't', now: NOW, fetchImpl });
    expect(preview.status).toBe(200);

    const { fetchImpl: again } = upstream();
    const client = createShadowClient({
      token: 't',
      fetchImpl: again,
      minIntervalMs: 0,
      log: { log() {}, warn() {} }
    });
    const { blocks } = await measureShadowContributions([{ username: 'ana' }], {
      client,
      now: NOW,
      log: { log() {}, warn() {} }
    });
    const pipeline = scoreModel(blocks.get('ana'));
    expect(preview.body.score_exact).toBe(pipeline.score_exact);
    expect(preview.body.evidence).toEqual(pipeline.evidence);
    expect(preview.body.gate).toEqual({ passes: true, working_days: 5, needed: 4 });
  });

  it('answers 404 for a user GitHub does not know, and 503 when GitHub cannot be measured', async () => {
    const { fetchImpl } = upstream();
    expect((await previewScore('nobody', { token: 't', now: NOW, fetchImpl })).status).toBe(404);
    const down = upstream({ onRequest: () => new Response('<html>502</html>', { status: 502 }) });
    expect(
      (
        await previewScore('ana', {
          token: 't',
          now: NOW,
          fetchImpl: down.fetchImpl,
          sleep: async () => {}
        })
      ).status
    ).toBe(503);
  });
});

describe('the route', () => {
  it('takes GET only, and a valid login only', async () => {
    expect((await call('/api/score-preview/ana', { method: 'POST' })).status).toBe(405);
    expect((await call('/api/score-preview/-bad-')).status).toBe(400);
    expect((await call('/api/score-preview/%E0%A4%A')).status).toBe(400);
  });

  it('is rate limited, and unconfigured without its own token', async () => {
    expect((await call('/api/score-preview/ana', { limited: true })).status).toBe(429);
    expect(
      (await call('/api/score-preview/ana', { env: { GITHUB_PREVIEW_TOKEN: '' } })).status
    ).toBe(503);
  });

  it('measures, applies the moderation list, and caches until the window moves', async () => {
    const cache = memoryNamespace((state) => new PreviewCache(state));
    const { fetchImpl, github } = upstream({
      moderation: { repositories: [{ repo: 'ana/app', reason: 'a script' }] }
    });
    const first = await call('/api/score-preview/ana', {
      env: { PREVIEW_CACHE: cache },
      fetchImpl
    });
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body).toMatchObject({
      login: 'ana',
      model_version: '3.0.0',
      moderation: 'applied',
      cached: false
    });
    expect(body.evidence.excluded).toEqual([{ repo: 'ana/app', reason: 'moderation: a script' }]);

    const requests = github.calls.length;
    const second = await (
      await call('/api/score-preview/ANA', { env: { PREVIEW_CACHE: cache }, fetchImpl })
    ).json();
    expect(second.cached).toBe(true);
    expect(github.calls.length).toBe(requests);

    // The next Pakistan date is a new window: measured again.
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    const third = await (
      await call('/api/score-preview/ana', {
        env: { PREVIEW_CACHE: cache },
        fetchImpl,
        now: tomorrow
      })
    ).json();
    expect(third.cached).toBe(false);
  });

  it('never caches a result scored without the moderation list', async () => {
    const cache = memoryNamespace((state) => new PreviewCache(state));
    const { fetchImpl } = upstream({ moderation: 'down' });
    const body = await (
      await call('/api/score-preview/ana', { env: { PREVIEW_CACHE: cache }, fetchImpl })
    ).json();
    expect(body.moderation).toBe('unavailable');
    const again = await (
      await call('/api/score-preview/ana', { env: { PREVIEW_CACHE: cache }, fetchImpl })
    ).json();
    expect(again.cached).toBe(false);
  });
});

describe('loadModeration', () => {
  it('reads the list, treats a missing file as empty, and anything else as unavailable', async () => {
    expect(
      await loadModeration(async () =>
        Response.json({ repositories: [{ repo: 'a/b', reason: 'x' }] })
      )
    ).toEqual([{ repo: 'a/b', reason: 'x' }]);
    expect(await loadModeration(async () => new Response('', { status: 404 }))).toEqual([]);
    expect(await loadModeration(async () => new Response('', { status: 500 }))).toBeNull();
    expect(
      await loadModeration(async () => {
        throw new TypeError('offline');
      })
    ).toBeNull();
  });
});

describe('RateLimiter with a limit of its own', () => {
  it('honours a requested limit within bounds, and the default otherwise', async () => {
    const ns = memoryNamespace((state) => new RateLimiter(state));
    const check = (id, query = '') =>
      ns
        .get(id)
        .fetch(`https://rate-limiter/check${query}`)
        .then((r) => r.json());
    const q = `?max=${PREVIEW_PER_IP.max}&window=${PREVIEW_PER_IP.windowMs}`;
    for (let i = 0; i < PREVIEW_PER_IP.max; i += 1)
      expect((await check('a', q)).allowed).toBe(true);
    expect((await check('a', q)).allowed).toBe(false);
    // An out-of-bounds request falls back to the default limit of 20.
    let allowed = 0;
    for (let i = 0; i < 25; i += 1)
      if ((await check('b', '?max=999999&window=0')).allowed) allowed += 1;
    expect(allowed).toBe(20);
    expect(PREVIEW_TOTAL.max).toBeGreaterThan(PREVIEW_PER_IP.max);
  });
});
