// GET /api/health: is the live board fresh? For an outside monitor, not for the site.
//
// Every clock that runs the pipeline now lives in Cloudflare (scheduled.js), and the watchdog is
// one of the things that clock dispatches - so if the clock, its token, GitHub or the deploy
// stopped, nothing inside the system would be left to say so. This endpoint is what an outside
// monitor polls instead: cron-job.org requests it every hour, holds no token, and emails the owner
// on any non-2xx answer.
//
// It reads `last_updated` from the board the site serves. Every pipeline run rebuilds and
// redeploys the whole board, so that one field moves only when the whole chain worked: dispatch,
// measure, save, deploy. Stale past HEALTH_STALE_HOURS - the watchdog's SITE_STALE threshold,
// above the worst gap in 83 days of normal operation (3.2 h) - or unreadable, it answers 503.

export const HEALTH_BOARD_URL = 'https://rankistan.dev/board.json';
export const HEALTH_STALE_HOURS = 4;
// Bounds what a burst of requests costs the site: at most one upstream read a minute per colo.
const HEALTH_UPSTREAM_CACHE_SECONDS = 60;
const HEALTH_TIMEOUT_MS = 15000;

/** Pure: the verdict for a `last_updated` value read at `now`. */
export function healthVerdict(lastUpdated, now = Date.now()) {
  const at = Date.parse(lastUpdated);
  if (!Number.isFinite(at)) {
    return { status: 'unreadable', http: 503, reason: 'the board has no readable last_updated' };
  }
  const ageHours = Math.round(((now - at) / 3_600_000) * 10) / 10;
  const stale = ageHours > HEALTH_STALE_HOURS;
  return {
    status: stale ? 'stale' : 'ok',
    http: stale ? 503 : 200,
    last_updated: new Date(at).toISOString(),
    age_hours: ageHours,
    threshold_hours: HEALTH_STALE_HOURS
  };
}

export async function handleHealthRequest({ fetchImpl = fetch, now = Date.now() } = {}) {
  let verdict;
  try {
    const response = await fetchImpl(HEALTH_BOARD_URL, {
      cf: { cacheTtl: HEALTH_UPSTREAM_CACHE_SECONDS },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) {
      verdict = {
        status: 'unreadable',
        http: 503,
        reason: `the board answered HTTP ${response.status}`
      };
    } else {
      const board = await response.json();
      verdict = healthVerdict(board?.last_updated, now);
    }
  } catch (error) {
    verdict = {
      status: 'unreadable',
      http: 503,
      reason: `the board could not be read (${error?.name || 'error'})`
    };
  }

  const { http, ...body } = verdict;
  return new Response(JSON.stringify({ ...body, checked_at: new Date(now).toISOString() }), {
    status: http,
    headers: {
      'Content-Type': 'application/json',
      // A monitor must see this answer, not a copy of an earlier one.
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
