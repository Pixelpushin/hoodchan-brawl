// Mints a session directly into a fake redis store (test/_helpers/fake-redis.js),
// bypassing POST /api/auth/session's signature/ownerOf checks entirely - for
// tests of session-GATED routes (api/lobby/*, api/rtc/*, api/match/*) that
// don't want to re-prove wallet ownership on every test.
//
// Mirrors api/_lib/auth.js's issueSession()/verifyToken() token shape
// EXACTLY (v1.<sid>.<mac>, sess:<sid> JSON record) - a token minted here
// passes requireSession()/getSession() against the same fake redis store
// exactly like a real one, as long as process.env.SESSION_SECRET is set to
// the same value both sides use (see api/_lib/auth.js's sessionSecret()).
"use strict";

const crypto = require("node:crypto");

const MAC_LENGTH = 22;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function computeMac(sid, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(`v1.${sid}`).digest()).slice(0, MAC_LENGTH);
}

// fake: a createFakeRedis() instance (has .store, a Map of key -> {type,
// value, expiresAt}). Returns { token, sid, wallet, tokenId } - `token` is
// the exact `Authorization: Bearer <token>` value a test hands to `call()`.
function mintFakeSession(fake, { wallet, tokenId, adapter = null, sid, ttlSeconds = 4 * 60 * 60 } = {}) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("mintFakeSession requires process.env.SESSION_SECRET to be set in the test");
  }
  const sessionSid = sid ?? crypto.randomBytes(16).toString("hex");
  const mac = computeMac(sessionSid, secret);
  const token = `v1.${sessionSid}.${mac}`;
  const walletLc = String(wallet).toLowerCase();

  const record = {
    wallet: walletLc,
    tokenId,
    adapter,
    iat: Date.now(),
    exp: Date.now() + ttlSeconds * 1000,
    delegateJwk: null,
    delegateFp: null,
  };

  fake.store.set(`sess:${sessionSid}`, {
    type: "string",
    value: JSON.stringify(record),
    expiresAt: Date.now() + ttlSeconds * 1000,
  });

  return { token, sid: sessionSid, wallet: walletLc, tokenId, adapter };
}

// Convenience: token string + auth header pair for makeReq's `headers`.
function fakeSessionHeaders(fake, opts) {
  const session = mintFakeSession(fake, opts);
  return { headers: { authorization: `Bearer ${session.token}` }, session };
}

module.exports = { mintFakeSession, fakeSessionHeaders };
