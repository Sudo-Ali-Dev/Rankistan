// GET /api/score-preview/:login - any developer's scoring v3 score, measured live.
//
// The Register page used to estimate a score in the browser from the unauthenticated REST events
// feed. Scoring v3 is computed from GitHub's contributions API and search, which need a token, so
// the preview moves here and runs the pipeline's own code: the same measurement
// (scripts/measure/contributions.js), the same evidence rules and the same arithmetic
// (src/model/next/). What it returns is the score the pipeline would publish for the same day,
// with the evidence behind it, so anyone can check any developer's score item by item.
//
// Costs and limits:
//   - GITHUB_PREVIEW_TOKEN when set (fine-grained, public read only), else the Worker's
//     GITHUB_DISPATCH_TOKEN. Never the pipeline's: the board is measured with the Actions token,
//     so previews cannot starve it. A personal token's GraphQL budget is its owner's, 5,000 points
//     an hour, and PREVIEW_TOTAL keeps previews well under it.
//   - one measurement costs about 2 GraphQL points. A result is cached per login until the
//     Pakistan date turns over, when the window moves and the score can change.
//   - rate limited per IP and in total, by the same Durable Object counter /api/dev-summary uses.
//   - it never waits on a GitHub rate limit: a request that would have to wait answers 503.
import { GITHUB_USERNAME_RE } from './limits.js';
import {
  createShadowClient,
  decodeMeasurement,
  measureShadowContributions
} from '../scripts/measure/contributions.js';
import { measurementWindow } from '../src/model/measurement.js';
import { deriveEvidence } from '../src/model/next/evidence.js';
import { scoreEvidence } from '../src/model/next/score.js';
import { SCORE_CONFIG } from '../src/model/next/config.js';

export const PREVIEW_PER_IP = Object.freeze({ max: 5, windowMs: 60 * 1000 });
// At about 2 points a measurement, at most ~1,200 points an hour.
export const PREVIEW_TOTAL = Object.freeze({ max: 10, windowMs: 60 * 1000 });
export const MODERATION_URL = 'https://rankistan.dev/moderation.json';
// Long enough for one retry of a request GitHub's gateway timed out (contributions.js waits 5 s
// before it), short enough that an answer still arrives inside the page's 30 s timeout. A rate
// limit, which would mean a wait of minutes, still answers 503.
const MAX_WAIT_MS = 6000;
const quiet = { log() {}, warn() {} };

/** The moderation list the pipeline applies, or null when it cannot be read. */
export async function loadModeration(fetchImpl = (...args) => fetch(...args)) {
  try {
    const response = await fetchImpl(MODERATION_URL, { cf: { cacheTtl: 300 } });
    if (response.status === 404) return [];
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body?.repositories) ? body.repositories : null;
  } catch {
    return null;
  }
}

/**
 * Measures and scores one developer. Pure apart from `fetchImpl`: everything else is passed in.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function previewScore(
  login,
  { token, now = Date.now(), fetchImpl, moderation = [], sleep }
) {
  const client = createShadowClient({
    token,
    fetchImpl,
    minIntervalMs: 0,
    maxWaitMs: MAX_WAIT_MS,
    log: quiet,
    ...(sleep ? { sleep } : {})
  });
  const { blocks, failed } = await measureShadowContributions([{ username: login }], {
    client,
    now,
    log: quiet
  });
  const block = blocks.get(login.toLowerCase());
  if (!block) {
    const reason = failed.get(login.toLowerCase()) || 'not measured';
    if (reason === 'not found') return { status: 404, body: { error: 'No such GitHub user.' } };
    return {
      status: 503,
      body: { error: 'GitHub could not be measured just now. Try again in a few minutes.' }
    };
  }
  const m = decodeMeasurement(block);
  const result = scoreEvidence(deriveEvidence(m, { config: SCORE_CONFIG, moderation }), {
    config: SCORE_CONFIG
  });
  return {
    status: 200,
    body: {
      login: m.login,
      model_version: SCORE_CONFIG.MODEL_VERSION,
      measured_at: m.measured_at,
      window: m.window,
      score: result.score,
      score_exact: result.score_exact,
      parts: result.parts,
      details: result.details,
      gate: {
        passes: result.gate,
        working_days: result.evidence.working_days.length,
        needed: SCORE_CONFIG.WORK.GATE_MIN_DAYS
      },
      evidence: result.evidence
    }
  };
}

/** Durable Object: one cached preview per login, kept until its window moves. */
export class PreviewCache {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'PUT') {
      await this.state.storage.put('preview', await request.json());
      return new Response(null, { status: 204 });
    }
    const stored = (await this.state.storage.get('preview')) || null;
    return Response.json(stored);
  }
}

async function cached(env, login, windowTo) {
  const namespace = env?.PREVIEW_CACHE;
  if (!namespace) return { read: async () => null, write: async () => {} };
  const stub = namespace.get(namespace.idFromName(login.toLowerCase()));
  return {
    read: async () => {
      try {
        const entry = await (await stub.fetch('https://preview-cache/')).json();
        return entry && entry.window_to === windowTo ? entry.body : null;
      } catch {
        return null;
      }
    },
    write: async (body) => {
      try {
        await stub.fetch('https://preview-cache/', {
          method: 'PUT',
          body: JSON.stringify({ window_to: windowTo, body })
        });
      } catch {
        // A cache that cannot be written costs a measurement next time, nothing else.
      }
    }
  };
}

/**
 * The route. `helpers` comes from worker.js: its CORS-aware jsonResponse and the Durable Object
 * rate limiter, so this endpoint is limited and answered exactly as the others are.
 */
export async function handleScorePreviewRequest(
  request,
  env,
  helpers,
  { now = Date.now(), fetchImpl } = {}
) {
  const { jsonResponse, corsOrigin, isLimited } = helpers;
  const fetchFn = fetchImpl || ((...args) => fetch(...args));
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, corsOrigin);
  }
  let login = '';
  try {
    login = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '').trim();
  } catch {
    login = '';
  }
  if (!login || !GITHUB_USERNAME_RE.test(login)) {
    return jsonResponse({ error: 'Invalid username.' }, 400, corsOrigin);
  }

  const windowTo = measurementWindow(now).to;
  const cache = await cached(env, login, windowTo);
  const hit = await cache.read();
  if (hit) return jsonResponse({ ...hit, cached: true }, 200, corsOrigin);

  if (
    (await isLimited('preview:total', PREVIEW_TOTAL)) ||
    (await isLimited('preview:ip', PREVIEW_PER_IP))
  ) {
    return jsonResponse(
      { error: 'Too many previews right now. Try again in a minute.' },
      429,
      corsOrigin
    );
  }

  const token = env?.GITHUB_PREVIEW_TOKEN || env?.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return jsonResponse({ error: 'The preview is not configured.' }, 503, corsOrigin);
  }

  const moderation = await loadModeration(fetchFn);
  try {
    const { status, body } = await previewScore(login, {
      token,
      now,
      fetchImpl: fetchFn,
      moderation: moderation ?? []
    });
    if (status !== 200) return jsonResponse(body, status, corsOrigin);
    const answer = { ...body, moderation: moderation === null ? 'unavailable' : 'applied' };
    if (moderation !== null) await cache.write(answer);
    return jsonResponse({ ...answer, cached: false }, 200, corsOrigin);
  } catch (error) {
    console.error(`Score preview failed for ${login}: ${error.message}`);
    return jsonResponse({ error: 'Failed to compute the score.' }, 502, corsOrigin);
  }
}
