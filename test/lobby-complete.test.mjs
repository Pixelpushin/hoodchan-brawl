// Tests for api/lobby/complete.js: hermetic via test/_helpers/fake-redis.js
// (same require.cache-swap pattern as scripts/test-lobby-join.mjs and
// test/rate-limit.test.mjs), with REAL ethers signing (ethers.Wallet is pure
// crypto, no network) so signature verification runs for real.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { makeReq, call } from "./_helpers/http.js";
import { mintFakeSession } from "./_helpers/fake-session.js";
import { buildResultMessage as clientBuildResultMessage } from "../src/lobby.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REDIS_PATH = require.resolve(path.join(root, "api/_lib/redis.js"));
const RATE_LIMIT_PATH = require.resolve(path.join(root, "api/_lib/rate-limit.js"));
const AUTH_PATH = require.resolve(path.join(root, "api/_lib/auth.js"));
const COMPLETE_PATH = require.resolve(path.join(root, "api/lobby/complete.js"));

// api/lobby/complete.js now requires a session (Authorization: Bearer, see
// api/_lib/auth.js) whose wallet matches the signing wallet, on top of the
// EIP-191 signature it already verified - every test below needs
// SESSION_SECRET set so mintFakeSession's HMAC matches what the route
// verifies with.
process.env.SESSION_SECRET = "test-lobby-complete-secret";

// Fresh fake Redis + a fresh require of complete.js (and auth.js, which it
// now depends on for session gating) per test, so rate-limit counters,
// sigused: keys, sess: records, and lobby state from one test never leak
// into another (rate-limit.js/auth.js/complete.js all destructure redis.js's
// exports at require time, so all must be re-required after the fake is
// installed - same reasoning as test/rate-limit.test.mjs's freshRateLimit()).
function freshComplete() {
  const fake = installFakeRedis(require, root);
  delete require.cache[RATE_LIMIT_PATH];
  delete require.cache[AUTH_PATH];
  delete require.cache[COMPLETE_PATH];
  const complete = require(COMPLETE_PATH);
  return { complete, fake, reqFrom: makeReqFrom(fake) };
}

// Builds a reqFrom(ip, body) bound to `fake`'s store: when `body.wallet` is
// present, a session is auto-minted for exactly that wallet and attached as
// Authorization: Bearer - this is what every legitimate caller looks like
// now that api/lobby/complete.js requires session.wallet to equal the
// signing wallet (403 SESSION_MISMATCH otherwise, see the dedicated test
// below). Tests that need a MISMATCHED session build their own request
// instead of using this helper.
function makeReqFrom(fake) {
  return (ip, body) => {
    const headers = { "x-vercel-forwarded-for": ip };
    if (body?.wallet) {
      const session = mintFakeSession(fake, { wallet: body.wallet, tokenId: 0 });
      headers.authorization = `Bearer ${session.token}`;
    }
    return makeReq({ headers, body });
  };
}

const ROOM = "ABC123";
const LOBBY_KEY = `lobby:${ROOM}`;

// p1 owns token 14, p2 owns token 165 - matches scripts/test-lobby-join.mjs's
// convention of using real-shaped (if fake) owner data.
const walletA = ethers.Wallet.createRandom(); // p1
const walletB = ethers.Wallet.createRandom(); // p2
const walletC = ethers.Wallet.createRandom(); // not in this lobby
const A = walletA.address.toLowerCase();
const B = walletB.address.toLowerCase();

function freshLobbyJson(overrides = {}) {
  return JSON.stringify({
    status: "ready",
    p1: { wallet: A, tokenId: 14, joinedAt: 1 },
    p2: { wallet: B, tokenId: 165, joinedAt: 2 },
    createdAt: 1,
    ...overrides,
  });
}

// fake-redis.js's store holds { type, value, expiresAt } entries, not raw
// strings - writing through redisCommand("SET", ...) would work too, but
// touching fake.store directly (for setup, and for the CAS-interference test
// below) needs to match that same internal shape or GET reads it back as
// null (type mismatch).
function seedLobby(fake, overrides = {}) {
  fake.store.set(LOBBY_KEY, { type: "string", value: freshLobbyJson(overrides), expiresAt: Date.now() + 600_000 });
}

function baseFields({ winnerId = 14, loserId = 165, p1Score = 3, p2Score = 1, roundsPlayed = 4, wallet = A, issuedAt } = {}) {
  return {
    roomCode: ROOM,
    winnerId,
    loserId,
    p1Score,
    p2Score,
    roundsPlayed,
    wallet,
    issuedAt: issuedAt ?? new Date().toISOString(),
  };
}

// Signs `fields` with `signer` (an ethers.Wallet) using the SERVER's own
// buildResultMessage (attached to the handler export - see complete.js's
// final line) - this is what a legitimate client submission looks like.
async function signedBody(complete, signer, fields) {
  const message = complete.buildResultMessage(fields);
  const signature = await signer.signMessage(message);
  return { ...fields, signature };
}

test("buildResultMessage: client (src/lobby.js) and server (api/lobby/complete.js) produce identical bytes", () => {
  const { complete } = freshComplete();
  const fields = baseFields({ issuedAt: "2026-09-16T12:00:00.000Z" });
  const fromServer = complete.buildResultMessage(fields);
  const fromClient = clientBuildResultMessage(fields);
  assert.equal(fromClient, fromServer);
  // Also check the null-winner/loser rendering, not just the happy path.
  const nullFields = baseFields({ winnerId: null, loserId: 165, issuedAt: "2026-09-16T12:00:00.000Z" });
  assert.equal(clientBuildResultMessage(nullFields), complete.buildResultMessage(nullFields));
});

test("missing signature is rejected (400)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const fields = baseFields();
  const body = { ...fields }; // no `signature`
  const res = await call(complete, reqFrom("1.1.1.1", body));
  assert.equal(res.status, 400);
});

test("signature from the wrong signer is rejected (403 INVALID_SIGNATURE)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const fields = baseFields({ wallet: A }); // claims to be A...
  const body = await signedBody(complete, walletB, fields); // ...but B actually signed it
  const res = await call(complete, reqFrom("1.1.1.2", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "INVALID_SIGNATURE");
});

test("stale issuedAt is rejected (403 INVALID_TIMESTAMP)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const staleIssuedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const fields = baseFields({ wallet: A, issuedAt: staleIssuedAt });
  const body = await signedBody(complete, walletA, fields);
  const res = await call(complete, reqFrom("1.1.1.3", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "INVALID_TIMESTAMP");
});

test("a signature can't be replayed (409 REPLAYED)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const fields = baseFields({ wallet: A });
  const body = await signedBody(complete, walletA, fields);
  const first = await call(complete, reqFrom("1.1.1.4", body));
  assert.equal(first.status, 200);
  assert.equal(first.body.recorded, false);
  assert.equal(first.body.waitingFor, "p2");

  const replay = await call(complete, reqFrom("1.1.1.4", body));
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "REPLAYED");
});

test("a wallet that isn't in the lobby is rejected (403 NOT_A_PARTICIPANT)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const fields = baseFields({ wallet: walletC.address.toLowerCase() });
  const body = await signedBody(complete, walletC, fields);
  const res = await call(complete, reqFrom("1.1.1.5", body));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NOT_A_PARTICIPANT");
});

test("no session at all is rejected (401 UNAUTHENTICATED)", async () => {
  const { complete, fake } = freshComplete();
  seedLobby(fake);
  const body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  const res = await call(complete, makeReq({ headers: { "x-vercel-forwarded-for": "1.1.1.20" }, body }));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "UNAUTHENTICATED");
});

test("a session for a DIFFERENT wallet than the signer is rejected (403 SESSION_MISMATCH), even with a perfectly valid signature", async () => {
  const { complete, fake } = freshComplete();
  seedLobby(fake);
  const body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  // The session belongs to B, not A - B is even a real participant (p2) in
  // this same lobby, so this isn't just "unknown session", it's specifically
  // "the wrong player's session was used to submit A's signed result".
  const session = mintFakeSession(fake, { wallet: B, tokenId: 165 });
  const res = await call(
    complete,
    makeReq({ headers: { "x-vercel-forwarded-for": "1.1.1.21", authorization: `Bearer ${session.token}` }, body }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "SESSION_MISMATCH");
});

test("first submission is recorded but not finalized: recorded:false, waitingFor the other side", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);
  const fields = baseFields({ wallet: A });
  const body = await signedBody(complete, walletA, fields);
  const res = await call(complete, reqFrom("1.1.1.6", body));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { recorded: false, waitingFor: "p2" });

  const lobby = JSON.parse(fake.store.get(LOBBY_KEY).value);
  assert.equal(lobby.sub.p1.winnerId, 14);
  assert.equal(lobby.status, "ready", "status stays non-terminal until both sides submit");
});

test("both sides submit and agree: recorded:true, adapter-namespaced stats written, mintqueue entry exists", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);

  const p1Body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  const first = await call(complete, reqFrom("1.1.1.7", p1Body));
  assert.equal(first.status, 200);
  assert.equal(first.body.waitingFor, "p2");

  const p2Body = await signedBody(complete, walletB, baseFields({ wallet: B }));
  const second = await call(complete, reqFrom("1.1.1.8", p2Body));
  assert.equal(second.status, 200);
  assert.equal(second.body.recorded, true);
  assert.equal(second.body.minted, "queued");

  // Legacy adapter ("onchainhoodies") - no lobby.adapter was set, and no
  // ADAPTER_KEY env var is set in this test run, so DEFAULT_ADAPTER_KEY
  // falls back to LEGACY_ADAPTER_KEY - these are the exact keys
  // /api/hoodie/[tokenId]/stats, /api/leaderboard, /api/rivalry/*, and
  // /api/matches/recent read by default (see api/_lib/stats-keys.js).
  assert.equal(await fake.redisCommand("GET", "hoodie:14:wins"), "1");
  assert.equal(await fake.redisCommand("GET", "hoodie:165:losses"), "1");
  const recent = await fake.redisCommand("LRANGE", "matches:recent", "0", "0");
  assert.equal(JSON.parse(recent[0]).winnerId, 14);

  const mintqueueRaw = await fake.redisCommand("GET", `mintqueue:${ROOM}`);
  assert.ok(mintqueueRaw, "mintqueue entry should exist");
  const mintEntry = JSON.parse(mintqueueRaw);
  assert.equal(mintEntry.wallet1, A);
  assert.equal(mintEntry.wallet2, B);
  assert.equal(mintEntry.nft1, 14);
  assert.equal(mintEntry.nft2, 165);

  const lobby = JSON.parse(fake.store.get(LOBBY_KEY).value);
  assert.equal(lobby.status, "complete");
  assert.equal(lobby.readyToMint, true);
});

test("both sides submit but disagree: disputed, no stats or mintqueue writes", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);

  const p1Body = await signedBody(complete, walletA, baseFields({ wallet: A, winnerId: 14, loserId: 165 }));
  await call(complete, reqFrom("1.1.1.9", p1Body));

  // p2 claims THEY won instead.
  const p2Body = await signedBody(complete, walletB, baseFields({ wallet: B, winnerId: 165, loserId: 14 }));
  const second = await call(complete, reqFrom("1.1.1.10", p2Body));
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { recorded: false, disputed: true });

  assert.equal(await fake.redisCommand("GET", "hoodie:14:wins"), null);
  assert.equal(await fake.redisCommand("GET", "hoodie:165:wins"), null);
  assert.equal(await fake.redisCommand("GET", `mintqueue:${ROOM}`), null);

  const lobby = JSON.parse(fake.store.get(LOBBY_KEY).value);
  assert.equal(lobby.status, "disputed");
});

test("a completed room is 409", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake, { status: "complete" });
  const body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  const res = await call(complete, reqFrom("1.1.1.11", body));
  assert.equal(res.status, 409);
});

test("CAS interference: a racing write between GET and compare-and-set is retried, not lost", async () => {
  // Not freshComplete() here - the wrap below must be installed on the redis
  // module's exports BEFORE complete.js is required, since complete.js
  // destructures `redisCompareAndSet` into a local binding at require time
  // (wrapping the export afterward wouldn't touch what complete.js already
  // captured).
  const fake = installFakeRedis(require, root);
  delete require.cache[RATE_LIMIT_PATH];
  delete require.cache[AUTH_PATH];
  delete require.cache[COMPLETE_PATH];
  const reqFrom = makeReqFrom(fake);
  seedLobby(fake);

  // First compare-and-set call in the CAS loop loses a race: another writer
  // (simulating p2's own concurrent submission) changes the record out from
  // under the expected value, forcing complete.js's loop to retry.
  const redisExports = require.cache[REDIS_PATH].exports;
  const originalCas = redisExports.redisCompareAndSet;
  let armed = true;
  redisExports.redisCompareAndSet = async (key, expected, next, ttl) => {
    if (armed && key === LOBBY_KEY) {
      armed = false;
      const racing = JSON.parse(fake.store.get(LOBBY_KEY).value);
      racing.sub = { p2: { winnerId: 14, loserId: 165, p1Score: 3, p2Score: 1, roundsPlayed: 4, at: Date.now() } };
      seedLobby(fake, racing);
    }
    return originalCas(key, expected, next, ttl);
  };

  const complete = require(COMPLETE_PATH);
  const body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  const res = await call(complete, reqFrom("1.1.1.12", body));

  // p1's submission must survive the CAS retry AND still see p2's
  // (racily-written) submission that landed in between - i.e. this call
  // itself completes the match rather than reporting waitingFor.
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, true);
});

test("agreed winner/loser but mismatched scores is disputed, not silently recorded with p1's numbers (S3)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);

  const p1Body = await signedBody(complete, walletA, baseFields({ wallet: A, p1Score: 3, p2Score: 1 }));
  await call(complete, reqFrom("1.1.1.13", p1Body));

  // p2 agrees on who won, but signed different round scores than p1 did -
  // before the S3 fix this was accepted anyway (agree only compared
  // winnerId/loserId), silently recording p1's numbers even though p2 never
  // attested to them.
  const p2Body = await signedBody(complete, walletB, baseFields({ wallet: B, p1Score: 3, p2Score: 0 }));
  const second = await call(complete, reqFrom("1.1.1.14", p2Body));

  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { recorded: false, disputed: true });
  assert.equal(await fake.redisCommand("GET", "hoodie:14:wins"), null);
  const lobby = JSON.parse(fake.store.get(LOBBY_KEY).value);
  assert.equal(lobby.status, "disputed");
});

test("finalization can only happen once, even across N concurrently-signed submissions of the same agreeing side (B1)", async () => {
  const { complete, fake, reqFrom } = freshComplete();
  seedLobby(fake);

  // p1 submits once, normally.
  const p1Body = await signedBody(complete, walletA, baseFields({ wallet: A }));
  const waiting = await call(complete, reqFrom("1.1.1.15", p1Body));
  assert.equal(waiting.body.waitingFor, "p2");

  // p2 then fires several concurrently-signed submissions of the SAME
  // agreeing result - each carries its own distinct issuedAt/signature (as
  // a real attacker's would), so the sigused: replay guard can't collapse
  // them into one. Before the B1 fix, every one of these that reached the
  // agree-and-finalize step re-ran the stats writes, inflating win/loss
  // counts once per concurrent request instead of once per match.
  const N = 5;
  const p2Bodies = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      signedBody(complete, walletB, baseFields({ wallet: B, issuedAt: new Date(Date.now() + i).toISOString() })),
    ),
  );
  const results = await Promise.all(p2Bodies.map((body, i) => call(complete, reqFrom(`1.1.2.${i}`, body))));

  const recordedTrue = results.filter((r) => r.body?.recorded === true);
  assert.equal(recordedTrue.length, 1, `exactly one request should finalize the match, got: ${JSON.stringify(results.map((r) => r.body))}`);

  // The invariant that actually matters: stats were written exactly once,
  // not once per concurrent request.
  assert.equal(await fake.redisCommand("GET", "hoodie:14:wins"), "1");
  assert.equal(await fake.redisCommand("GET", "hoodie:165:losses"), "1");
  const recent = await fake.redisCommand("LRANGE", "matches:recent", "0", "-1");
  assert.equal(recent.length, 1, "matches:recent must have exactly one entry for this match, not one per racing request");
});
