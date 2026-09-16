// Session tokens for POST /api/auth/session and every route that requires
// one (see api/_lib/http.js's `session` option).
//
// Token shape: v1.<sid>.<mac>
//   sid = 16 random bytes, hex (32 chars)
//   mac = base64url(HMAC-SHA256(SESSION_SECRET, "v1." + sid)), truncated to
//         22 chars - enough entropy to make forging a mac computationally
//         pointless while keeping the token short.
//
// The session record itself (wallet, tokenId, ...) lives in Redis at
// sess:<sid>, NOT in the token - the token only proves "the holder was
// handed a sid by this server" (via the mac). This is what makes
// verifyToken() safe to run before ever touching Redis: a garbage or
// tampered token is rejected by a local HMAC comparison alone, so spamming
// fake bearer tokens at a protected route costs this server zero Redis
// round-trips (see getSession()'s ordering and
// test/auth-session.test.mjs's "tampered MAC never touches Redis" case).
"use strict";

const crypto = require("node:crypto");
const { redisCommand } = require("./redis");

const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4h, per the spec (sess:<sid> EX 14400)
const MAC_LENGTH = 22;
const SID_PATTERN = /^[0-9a-f]{32}$/;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Reads SESSION_SECRET fresh on every call (not cached at module load) so a
// test can set/unset process.env.SESSION_SECRET between cases without
// needing to re-require this module. Never falls back to a default - an
// unset secret must fail closed everywhere it's checked, not sign with "".
function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

function computeMac(sid, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(`v1.${sid}`).digest()).slice(0, MAC_LENGTH);
}

// Mints a new session: writes sess:<sid> to Redis and returns the bearer
// token the caller (api/auth/session.js) hands back to the client. Throws
// with `.code === "NOT_CONFIGURED"` when SESSION_SECRET is unset - callers
// must not catch this and fall back to anything, just surface it as a 503.
async function issueSession({ wallet, tokenId, adapter = null, delegateJwk = null, delegateFp = null }) {
  const secret = sessionSecret();
  if (!secret) {
    const err = new Error("SESSION_SECRET is not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const sid = crypto.randomBytes(16).toString("hex");
  const mac = computeMac(sid, secret);
  const token = `v1.${sid}.${mac}`;
  const iat = Date.now();
  const exp = iat + SESSION_TTL_SECONDS * 1000;
  const walletLc = String(wallet).toLowerCase();

  const record = {
    wallet: walletLc,
    tokenId,
    adapter,
    iat,
    exp,
    delegateJwk: delegateJwk ?? null,
    delegateFp: delegateFp ?? null,
  };

  await redisCommand("SET", `sess:${sid}`, JSON.stringify(record), "EX", String(SESSION_TTL_SECONDS));

  return { token, sid, wallet: walletLc, tokenId, expiresAt: exp };
}

// Local-only check: token shape + HMAC, no Redis. Returns { ok, sid }.
// `sid` is only meaningful when ok === true.
function verifyToken(token) {
  const secret = sessionSecret();
  if (!secret || typeof token !== "string") return { ok: false, sid: null };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, sid: null };
  const [, sid, mac] = parts;
  if (!SID_PATTERN.test(sid) || typeof mac !== "string") return { ok: false, sid: null };

  const expected = computeMac(sid, secret);
  const given = Buffer.from(mac, "utf8");
  const want = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false - a tampered/truncated mac must be rejected either way, but
  // never by throwing out of this function.
  if (given.length !== want.length) return { ok: false, sid: null };
  if (!crypto.timingSafeEqual(given, want)) return { ok: false, sid: null };

  return { ok: true, sid };
}

function bearerToken(req) {
  const header = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Resolves the full session record for a request, or null - never throws.
// Order matters: verifyToken() runs first and only a token that passes it
// ever reaches the redisCommand("GET", ...) call below.
async function getSession(req) {
  const token = bearerToken(req);
  if (!token) return null;

  const { ok, sid } = verifyToken(token);
  if (!ok) return null;

  let raw;
  try {
    raw = await redisCommand("GET", `sess:${sid}`);
  } catch (err) {
    console.error("[auth] session lookup failed", err);
    return null;
  }
  if (!raw) return null;

  try {
    const session = JSON.parse(raw);
    // Belt-and-suspenders on top of the Redis TTL (sess:<sid> EX
    // SESSION_TTL_SECONDS, which is what actually makes an old session
    // record disappear) - `exp` is stamped onto every record at issueSession
    // time, so a session is rejected on its own declared expiry even in a
    // world where the Redis-side TTL was somehow missed (e.g. hand-restored
    // from a backup with a fresh TTL, or an EXPIRE that never landed).
    if (typeof session.exp === "number" && Date.now() > session.exp) return null;
    return { ...session, sid };
  } catch {
    return null;
  }
}

// Convenience for route handlers that require a session: returns the
// session, or writes 401 {code:"UNAUTHENTICATED"} itself and returns null.
async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ code: "UNAUTHENTICATED", error: "Sign in required" });
    return null;
  }
  return session;
}

module.exports = { issueSession, verifyToken, getSession, requireSession, SESSION_TTL_SECONDS };
