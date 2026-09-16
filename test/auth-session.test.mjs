// Tests for POST /api/auth/session (api/auth/session.js) and its
// supporting api/_lib/auth.js, hermetic via test/_helpers/{fake-redis,
// fake-chain}.js (same require.cache-swap pattern as
// test/ai-match-complete.test.mjs / test/lobby-complete.test.mjs), with REAL
// ethers signing (ethers.Wallet is pure crypto, no network).
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "ethers";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { createFakeChain } from "./_helpers/fake-chain.js";
import { makeReq, call } from "./_helpers/http.js";
import { buildSessionMessage } from "../src/auth-message.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REDIS_PATH = require.resolve(path.join(root, "api/_lib/redis.js"));
const CHAIN_PATH = require.resolve(path.join(root, "api/_lib/chain.js"));
const RATE_LIMIT_PATH = require.resolve(path.join(root, "api/_lib/rate-limit.js"));
const AUTH_PATH = require.resolve(path.join(root, "api/_lib/auth.js"));
const HTTP_PATH = require.resolve(path.join(root, "api/_lib/http.js"));
const SESSION_PATH = require.resolve(path.join(root, "api/auth/session.js"));
const START_PATH = require.resolve(path.join(root, "api/x-auth/start.js"));

const DEPENDENT_PATHS = [RATE_LIMIT_PATH, AUTH_PATH, HTTP_PATH, SESSION_PATH, START_PATH];

// Fresh fake Redis + fake chain + a fresh require of every module that
// closes over redisCommand/ownerOf at require time (rate-limit.js, auth.js,
// http.js, and the route itself) per test, so rate-limit counters,
// sigused:/ban:/sess: keys never leak between tests. SESSION_SECRET is also
// reset per call so "unset" tests don't need a separate process.
// sessionSecret: null (NOT undefined - a destructuring default would mask
// an explicit `undefined`) means "unset SESSION_SECRET for this test".
function freshSession({ owners = {}, failFor = new Set(), sessionSecret = "test-session-secret" } = {}) {
  if (sessionSecret === null) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = sessionSecret;
  }

  const redisFake = installFakeRedis(require, root);
  const chainFake = createFakeChain({ owners, failFor });
  chainFake.installFakeChain(require, root);

  for (const p of DEPENDENT_PATHS) delete require.cache[p];

  const session = require(SESSION_PATH);
  return { session, redisFake };
}

// Wraps the fake redis's redisCommand (already installed in require.cache)
// with a call counter BEFORE the dependent modules are (re-)required, so
// auth.js's destructured `redisCommand` binding is the wrapped one.
function countCommand(cmd) {
  const exports = require.cache[REDIS_PATH].exports;
  const original = exports.redisCommand;
  let count = 0;
  exports.redisCommand = async (...args) => {
    if (String(args[0]).toUpperCase() === String(cmd).toUpperCase()) count++;
    return original(...args);
  };
  return () => count;
}

const reqFrom = (ip, body, extraHeaders = {}) =>
  makeReq({ headers: { "x-vercel-forwarded-for": ip, ...extraHeaders }, body });

const TOKEN_ID = 42;

async function signedFields(wallet, overrides = {}) {
  const fields = {
    tokenId: TOKEN_ID,
    address: wallet.address,
    issuedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
    delegate: "none",
    ...overrides,
  };
  const message = buildSessionMessage(fields);
  const signature = await wallet.signMessage(message);
  const { delegate, ...body } = fields;
  return { ...body, signature };
}

test("happy path: valid signed request issues a token and stores the session", async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = wallet.address.toLowerCase();
  const { session, redisFake } = freshSession({ owners: { [TOKEN_ID]: owner } });

  const body = await signedFields(wallet);
  const res = await call(session, reqFrom("10.0.0.1", body));

  assert.equal(res.status, 200);
  assert.match(res.body.token, /^v1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(res.body.wallet, owner);
  assert.equal(res.body.tokenId, TOKEN_ID);
  assert.equal(typeof res.body.expiresAt, "number");
  assert.ok(res.body.expiresAt > Date.now());
  // No "version" field in this repo's version.json fixture -> null, not a throw.
  assert.equal(res.body.engineVersion, null);

  const sid = res.body.token.split(".")[1];
  const stored = JSON.parse(await redisFake.redisCommand("GET", `sess:${sid}`));
  assert.equal(stored.wallet, owner);
  assert.equal(stored.tokenId, TOKEN_ID);
});

test("missing/invalid fields are rejected (400 INVALID_INPUT)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() } });

  const cases = [
    { ...(await signedFields(wallet)), tokenId: 0 }, // out of range
    { ...(await signedFields(wallet)), tokenId: 1201 }, // out of range
    { ...(await signedFields(wallet)), address: "not-an-address" },
    { ...(await signedFields(wallet)), nonce: "TOO-SHORT" },
    { ...(await signedFields(wallet)), nonce: "0123456789ABCDEF0123456789ABCDEF" }, // uppercase not allowed
  ];
  for (const body of cases) {
    const res = await call(session, reqFrom("10.0.0.2", body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_INPUT");
  }

  const { signature, ...noSig } = await signedFields(wallet);
  const res = await call(session, reqFrom("10.0.0.2", noSig));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("issuedAt too far in the future is rejected (403 INVALID_TIMESTAMP)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() } });
  const futureIssuedAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const body = await signedFields(wallet, { issuedAt: futureIssuedAt });
  const res = await call(session, reqFrom("10.0.0.3", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "INVALID_TIMESTAMP");
});

test("unparseable issuedAt is rejected (403 INVALID_TIMESTAMP)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() } });
  const body = { ...(await signedFields(wallet)), issuedAt: "not-a-date" };
  const res = await call(session, reqFrom("10.0.0.4", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "INVALID_TIMESTAMP");
});

test("issuedAt older than 24h is rejected (403 EXPIRED)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() } });
  const staleIssuedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const body = await signedFields(wallet, { issuedAt: staleIssuedAt });
  const res = await call(session, reqFrom("10.0.0.5", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "EXPIRED");
});

test("signature from the wrong wallet is rejected (403 INVALID_SIGNATURE)", async () => {
  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: walletA.address.toLowerCase() } });

  // Claims to be A's address, but B actually signed it.
  const fields = {
    tokenId: TOKEN_ID,
    address: walletA.address,
    issuedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
    delegate: "none",
  };
  const message = buildSessionMessage(fields);
  const signature = await walletB.signMessage(message);
  const { delegate, ...body } = fields;

  const res = await call(session, reqFrom("10.0.0.6", { ...body, signature }));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "INVALID_SIGNATURE");
});

test("banned wallet is rejected (403 BANNED) before any chain call", async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = wallet.address.toLowerCase();
  const { session, redisFake } = freshSession({ owners: { [TOKEN_ID]: owner } });
  await redisFake.redisCommand("SADD", "ban:wallet", owner);

  const body = await signedFields(wallet);
  const res = await call(session, reqFrom("10.0.0.7", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "BANNED");
});

test("a wallet that does not own the token is rejected (403 NOT_OWNER)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const actualOwner = ethers.Wallet.createRandom().address.toLowerCase();
  const { session } = freshSession({ owners: { [TOKEN_ID]: actualOwner } });

  const body = await signedFields(wallet); // wallet != actualOwner
  const res = await call(session, reqFrom("10.0.0.8", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NOT_OWNER");
});

test("chain RPC failure is 503 CHAIN_UNAVAILABLE and does NOT consume the signature - a retry once the chain recovers succeeds", async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = wallet.address.toLowerCase();
  const { session: downSession } = freshSession({ owners: { [TOKEN_ID]: owner }, failFor: new Set([TOKEN_ID]) });

  const body = await signedFields(wallet);
  const down = await call(downSession, reqFrom("10.0.0.9", body));
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "CHAIN_UNAVAILABLE");

  // Same signed body, chain now reachable - must succeed (nothing was
  // consumed on the failed attempt above). Re-require against a fresh fake
  // chain that resolves ownerOf, but deliberately WITHOUT touching
  // REDIS_PATH's cache entry - the same fake redis state carries over, so
  // the sigused: guard, if it had wrongly fired on the failed attempt,
  // would be visible here as a false 409.
  const chainFake = createFakeChain({ owners: { [TOKEN_ID]: owner } });
  chainFake.installFakeChain(require, root);
  for (const p of DEPENDENT_PATHS) delete require.cache[p];
  const recoveredSession = require(SESSION_PATH);

  const retry = await call(recoveredSession, reqFrom("10.0.0.9", body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.match(retry.body.token, /^v1\./);
});

test("a signature can't be replayed (409 REPLAYED)", async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = wallet.address.toLowerCase();
  const { session } = freshSession({ owners: { [TOKEN_ID]: owner } });

  const body = await signedFields(wallet);
  const first = await call(session, reqFrom("10.0.0.10", body));
  assert.equal(first.status, 200);

  const replay = await call(session, reqFrom("10.0.0.10", body));
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "REPLAYED");
});

test("SESSION_SECRET unset -> 503 NOT_CONFIGURED, never falls back to a default secret", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() }, sessionSecret: null });
  const body = await signedFields(wallet);
  const res = await call(session, reqFrom("10.0.0.11", body));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "NOT_CONFIGURED");
});

test("per-IP rate limit is fail-closed at 20/10min", async () => {
  const wallet = ethers.Wallet.createRandom();
  const { session } = freshSession({ owners: { [TOKEN_ID]: wallet.address.toLowerCase() } });

  for (let i = 0; i < 20; i++) {
    const body = await signedFields(wallet, { nonce: crypto.randomBytes(16).toString("hex") });
    const res = await call(session, reqFrom("10.0.0.12", body));
    assert.notEqual(res.status, 429, `request ${i} should not be rate limited yet`);
  }
  const body = await signedFields(wallet, { nonce: crypto.randomBytes(16).toString("hex") });
  const res = await call(session, reqFrom("10.0.0.12", body));
  assert.equal(res.status, 429);
});

test("verifyToken rejects a tampered MAC without ever touching Redis", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  installFakeRedis(require, root); // self-contained: don't rely on a prior test's fake being live
  const getCalls = countCommand("GET");
  for (const p of DEPENDENT_PATHS) delete require.cache[p];
  const auth = require(AUTH_PATH);

  const tampered = "v1." + "a".repeat(32) + ".WRONGMACWRONGMACWRONG";
  const req = { headers: { authorization: `Bearer ${tampered}` } };
  const result = await auth.getSession(req);

  assert.equal(result, null);
  assert.equal(getCalls(), 0, "a tampered token must never trigger a Redis GET");

  // Sanity: a well-formed token minted by issueSession DOES pass verifyToken
  // and DOES trigger exactly one GET.
  const minted = await auth.issueSession({ wallet: "0x" + "1".repeat(40), tokenId: 1 });
  const req2 = { headers: { authorization: `Bearer ${minted.token}` } };
  const found = await auth.getSession(req2);
  assert.ok(found, "a real token should resolve to a session");
  assert.equal(getCalls(), 1);
});

test("x-auth/start without a session is rejected (401 UNAUTHENTICATED)", async () => {
  for (const p of DEPENDENT_PATHS) delete require.cache[p];
  const redisFake = installFakeRedis(require, root);
  for (const p of DEPENDENT_PATHS) delete require.cache[p];
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.X_CLIENT_ID = "test-client-id";
  process.env.X_AUTH_REDIRECT_URI = "https://fight.hoodchan.org/api/x-auth/callback";
  const start = require(START_PATH);

  const req = makeReq({ method: "GET", headers: { "x-vercel-forwarded-for": "10.0.0.20" }, query: {} });
  const res = await call(start, req);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "UNAUTHENTICATED");
  void redisFake;
});
