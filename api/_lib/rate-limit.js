// Fixed-window rate limiting on top of Upstash Redis (api/_lib/redis.js).
//
// One counter per (scope, ip, window): INCR the key, EXPIRE it on the first
// hit in the window, deny once the count exceeds `max`. Cheap (one round
// trip on the fast path, two on the first request of a window) and good
// enough for the write-heavy routes this repo has - nothing here needs a
// sliding window or token bucket.
//
// Limits table (per 10 minutes unless noted) - keep this in sync with the
// enforceRateLimit() call sites:
//   lobby/create          10   fail-open
//   lobby/join             30   fail-open
//   lobby/poll            600   fail-open
//   lobby/complete          10   fail-CLOSED (mint-adjacent, abuse is costly)
//   match-result            60   fail-open
//   ai-match-complete        5   fail-CLOSED (mints a soulbound token)
//   share-upload              5   fail-open
//   ipfs                    300   fail-open
//   x-auth/start               5   fail-open
//   aimint per-wallet cap (countAndCap, not this table - see rl:aimint:<wallet>)
//
// "fail-open" means a Redis outage lets requests through uncounted (rate
// limiting is a defense-in-depth nicety, not there to break the game when
// Upstash hiccups); "fail-closed" is for the two routes that trigger an
// on-chain mint, where an outage should throttle rather than wave everyone
// through.

const { redisCommand } = require("./redis");

// Best-effort client IP from the headers Vercel/most proxies set, in order
// of trust. Defensive because `req.headers` can be undefined in hermetic
// tests, and x-forwarded-for is attacker-controlled so only its FIRST entry
// (closest hop's view of the original client) is used, never the whole list.
function clientIp(req) {
  const headers = req?.headers || {};
  const xff = headers["x-forwarded-for"];
  const firstXff = typeof xff === "string" ? xff.split(",")[0].trim() : null;
  // Trust order: Vercel's own platform-set header first, then the first hop
  // of x-forwarded-for (attacker-controlled, but only its first entry - see
  // the header comment above). x-real-ip is NOT part of the documented spec
  // here and sits last, below firstXff rather than above it - it's set by
  // some proxies but isn't Vercel's platform guarantee the way
  // x-vercel-forwarded-for is, so it shouldn't outrank the XFF fallback this
  // scheme is actually built around.
  return (
    headers["x-vercel-forwarded-for"] ||
    firstXff ||
    headers["x-real-ip"] ||
    "unknown"
  );
}

// Core check: allowed + how long until the caller can retry. Never throws -
// a Redis error resolves to `failOpen`'s outcome so callers don't need their
// own try/catch just to rate limit.
async function rateLimit(req, scope, max, windowSec, { failOpen = true } = {}) {
  const ip = clientIp(req);
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${scope}:${ip}:${win}`;

  try {
    const n = await redisCommand("INCR", key);
    if (Number(n) === 1) {
      // Only the request that created the window sets its expiry - avoids a
      // burst of concurrent first-requests each re-issuing EXPIRE.
      await redisCommand("EXPIRE", key, windowSec);
    }
    const allowed = Number(n) <= max;
    // Window resets at the next window boundary, not "windowSec from now" -
    // cheap upper bound on retry time without tracking the key's actual TTL.
    const retryAfterSeconds = allowed ? 0 : (win + 1) * windowSec - Math.floor(Date.now() / 1000);
    return { allowed, retryAfterSeconds };
  } catch (err) {
    console.error(`[rate-limit] redis error for scope=${scope}`, err);
    return { allowed: failOpen, retryAfterSeconds: failOpen ? 0 : 30 };
  }
}

// Convenience wrapper for route handlers: returns true when the request may
// proceed, otherwise writes the 429 response itself and returns false so the
// caller can just `if (!(await enforceRateLimit(...))) return;`.
async function enforceRateLimit(req, res, scope, max, windowSec, opts) {
  const { allowed, retryAfterSeconds } = await rateLimit(req, scope, max, windowSec, opts);
  if (allowed) return true;
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "Too many requests", retryAfterSeconds });
  return false;
}

// Per-key counter for caps that aren't IP-scoped (e.g. rl:aimint:<wallet> -
// N AI matches per wallet per day, independent of rate-limit's fixed-window
// IP buckets above). Same INCR+EXPIRE-on-first shape, just keyed directly by
// the caller instead of deriving a scope:ip:window key.
async function countAndCap(key, max, ttlSec) {
  const n = await redisCommand("INCR", key);
  if (Number(n) === 1) {
    await redisCommand("EXPIRE", key, ttlSec);
  }
  return { allowed: Number(n) <= max, count: Number(n) };
}

module.exports = { rateLimit, enforceRateLimit, countAndCap, clientIp };
