// Durable Object rate limiter.
//
// This replaces two things that did not work:
//
// 1. A module-level Map, which lives in a single Worker isolate. Isolates are
//    ephemeral and there are many of them, so the limit was enforced per
//    isolate rather than per IP, and a sequential caller landing on fresh
//    isolates was never counted at all. That was the original report (#65).
//
// 2. Cloudflare's Rate Limiting binding, which measured as ineffective here:
//    it returned {"success":true} for 30 consecutive requests against a
//    20/60s config, and still passed 10 consecutive requests when the limit
//    was lowered to 3. It rejected 7 of 40 concurrent requests, so it offers
//    coarse burst protection and no sequential enforcement.
//
// A Durable Object is the right primitive because Cloudflare guarantees a
// single instance per object ID and serialises requests to it. Keying the
// object by client IP therefore gives one authoritative counter per IP with no
// races, which is exactly what a rate limit needs.
//
// Storage holds one array of hit timestamps. A sliding window is used rather
// than a fixed window so a caller cannot send 2x the limit by straddling a
// boundary.

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 20;

// A caller may ask for a different limit on its own object (the score preview does), within
// these bounds. The object id is chosen by the Worker, never by a client, so a client cannot pick
// a laxer limit for a counter it shares with others.
const MAX_ALLOWED_REQUESTS = 1000;
const MAX_ALLOWED_WINDOW_MS = 60 * 60 * 1000;

function limitsOf(request) {
  const params = request ? new URL(request.url).searchParams : new URLSearchParams();
  const max = Number(params.get('max'));
  const windowMs = Number(params.get('window'));
  return {
    max: Number.isInteger(max) && max > 0 && max <= MAX_ALLOWED_REQUESTS ? max : MAX_REQUESTS,
    windowMs:
      Number.isInteger(windowMs) && windowMs > 0 && windowMs <= MAX_ALLOWED_WINDOW_MS
        ? windowMs
        : WINDOW_MS
  };
}

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { max: MAX, windowMs: WINDOW } = limitsOf(request);
    // Bound the stored array so a caller cannot grow one object's storage without
    // limit. Only timestamps inside the window matter, and the window can never
    // legitimately hold more than MAX of them.
    const MAX_STORED = MAX * 2;
    const now = Date.now();
    const cutoff = now - WINDOW;

    const stored = (await this.state.storage.get('hits')) || [];
    const recent = stored.filter((ts) => ts > cutoff);

    if (recent.length >= MAX) {
      // Persist the pruned array so storage does not keep expired entries, but
      // do not record this attempt: a rejected request must not extend the
      // window, otherwise a caller who keeps hammering is locked out forever.
      if (recent.length !== stored.length) {
        await this.state.storage.put('hits', recent.slice(-MAX_STORED));
      }
      const retryAfter = Math.max(1, Math.ceil((recent[0] + WINDOW - now) / 1000));
      return Response.json({ allowed: false, retryAfter }, { status: 200 });
    }

    recent.push(now);
    await this.state.storage.put('hits', recent.slice(-MAX_STORED));

    return Response.json({ allowed: true, remaining: MAX - recent.length }, { status: 200 });
  }
}

export { WINDOW_MS as RATE_LIMIT_WINDOW_MS, MAX_REQUESTS as RATE_LIMIT_MAX_REQUESTS };
