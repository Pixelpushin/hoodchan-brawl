// Tests for the session-gated room routes built on top of api/_lib/room.js:
// api/lobby/join.js's session gating (SESSION_MISMATCH/SELF_PLAY/
// ENGINE_VERSION_MISMATCH), api/lobby/poll.js's session-based participant
// view, and the new api/rtc/signal.js, api/rtc/turn.js, api/match/start.js,
// api/match/heartbeat.js routes. api/lobby/create.js's session gating and
// room cap, and api/lobby/complete.js's session requirement, are covered in
// test/routes-hardening.test.mjs and test/lobby-complete.test.mjs
// respectively (extended alongside this file) rather than duplicated here.
//
// Hermetic via test/_helpers/{fake-redis,fake-chain,fake-session,http}.js -
// same require.cache-swap pattern as test/lobby-complete.test.mjs /
// test/auth-session.test.mjs.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { createFakeChain } from "./_helpers/fake-chain.js";
import { makeReq, call } from "./_helpers/http.js";
import { mintFakeSession } from "./_helpers/fake-session.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.SESSION_SECRET = "test-lobby-session-secret";

// Every route under test depends on these at require time (session gating,
// TTL_BY_STATE, ownerOf) - all must be busted per test alongside the route
// itself, or a stale closure from an earlier test's fake redis/chain leaks
// through (same reasoning as test/auth-session.test.mjs's DEPENDENT_PATHS).
const LIB_DEPS = ["api/_lib/rate-limit.js", "api/_lib/auth.js", "api/_lib/room.js"];

function freshRoute(relPath, { owners = {}, failFor = new Set() } = {}) {
  const fake = installFakeRedis(require, root);
  const chainFake = createFakeChain({ owners, failFor });
  chainFake.installFakeChain(require, root);
  for (const dep of LIB_DEPS) delete require.cache[require.resolve(path.join(root, dep))];
  const routePath = require.resolve(path.join(root, relPath));
  delete require.cache[routePath];
  const handler = require(routePath);
  return { handler, fake };
}

function reqFrom(ip, { method = "POST", body, query, headers = {} } = {}) {
  return makeReq({ method, headers: { "x-vercel-forwarded-for": ip, ...headers }, body, query });
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function randomAddress() {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

function seedRoom(fake, code, record) {
  fake.store.set(`lobby:${code.toUpperCase()}`, {
    type: "string",
    value: JSON.stringify({ v: 0, createdAt: 1, updatedAt: 1, ...record }),
    expiresAt: Date.now() + 600_000,
  });
}

// =====================================================================
// api/lobby/join.js - session gating
// =====================================================================

test("join: no session is 401 UNAUTHENTICATED", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "AAA111", { status: "waiting", p1: null, p2: null });
  const res = await call(handler, reqFrom("2.0.0.1", { body: { roomCode: "AAA111" } }));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "UNAUTHENTICATED");
});

test("join: body wallet not matching the session's wallet is 403 SESSION_MISMATCH", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "BBB111", { status: "waiting", p1: null, p2: null });
  const sessionWallet = randomAddress();
  const otherWallet = randomAddress();
  const session = mintFakeSession(fake, { wallet: sessionWallet, tokenId: 9 });
  const res = await call(
    handler,
    reqFrom("2.0.0.2", { body: { roomCode: "BBB111", wallet: otherWallet, tokenId: 9 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "SESSION_MISMATCH");
});

test("join: body tokenId not matching the session's tokenId is 403 SESSION_MISMATCH", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "BBB222", { status: "waiting", p1: null, p2: null });
  const wallet = randomAddress();
  const session = mintFakeSession(fake, { wallet, tokenId: 9 });
  const res = await call(
    handler,
    reqFrom("2.0.0.3", { body: { roomCode: "BBB222", wallet, tokenId: 10 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "SESSION_MISMATCH");
});

test("join: happy path - guest fills p2 from session, ownerOf verified, status flips waiting->connected->ready", async () => {
  const hostWallet = randomAddress();
  const guestWallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/join.js", { owners: { 5: guestWallet } });
  seedRoom(fake, "CCC111", {
    status: "waiting",
    adapter: "onchainhoodies",
    seed: 1,
    matchId: "m_x",
    engineVersion: null,
    p1: { wallet: hostWallet, tokenId: 1, sid: "host-sid", joinedAt: 1 },
    p2: null,
  });
  const session = mintFakeSession(fake, { wallet: guestWallet, tokenId: 5 });
  const res = await call(
    handler,
    reqFrom("2.0.0.4", {
      body: { roomCode: "ccc111", wallet: guestWallet, tokenId: 5, side: "p2" },
      headers: authHeaders(session.token),
    }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.slot, "p2");
  assert.equal(res.body.lobbyState.status, "ready");
  assert.equal(res.body.lobbyState.p2.wallet, guestWallet.toLowerCase());
  assert.equal(res.body.lobbyState.p2.sid, session.sid);
  assert.equal(res.body.lobbyState.v, 1, "transition() must bump v on a successful write");
});

test("join: side-less pre-registration (no wallet/tokenId in body) still writes the session's real wallet+sid, not an anonymous slot", async () => {
  // Regression for the squat finding: a side-less join used to leave
  // `{joinedAt}` only in the slot (wallet/sid only written when the body
  // repeated them), so a genuine second player's own side-less join could
  // never tell "someone's actually here" apart from "empty" via .wallet.
  const hostWallet = randomAddress();
  const guestWallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "GGG111", {
    status: "waiting",
    p1: { wallet: hostWallet, tokenId: 1, sid: "host-sid", joinedAt: 1 },
    p2: null,
  });
  const session = mintFakeSession(fake, { wallet: guestWallet, tokenId: 7 });
  const res = await call(
    handler,
    reqFrom("2.0.0.10", { body: { roomCode: "GGG111" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.slot, "p2");
  assert.equal(res.body.lobbyState.p2.wallet, guestWallet.toLowerCase(), "wallet must come from the session, not the (empty) body");
  assert.equal(res.body.lobbyState.p2.sid, session.sid);
  assert.equal(res.body.lobbyState.p2.tokenId, undefined, "tokenId stays unset until an explicit registration call");
  assert.equal(res.body.lobbyState.status, "connected", "not ready yet - p2 hasn't registered a tokenId");
});

test("join: a wallet-only join (no tokenId) never flips the room to ready, even once both slots have a wallet", async () => {
  // Regression for should-fix #6: 'ready' used to gate on wallet presence,
  // so a join that supplied a wallet but never a tokenId could flip a room
  // to "ready" with a slot api/lobby/complete.js could never resolve
  // winnerId/loserId against (lobbyIds is built from tokenId, not wallet).
  const hostWallet = randomAddress();
  const guestWallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/join.js", { owners: { 9: guestWallet } });
  seedRoom(fake, "GGG222", {
    status: "connected",
    p1: { wallet: hostWallet, sid: "host-sid", joinedAt: 1 }, // p1 present, no tokenId yet either
    p2: { joinedAt: 2 },
  });
  const session = mintFakeSession(fake, { wallet: guestWallet, tokenId: 9 });
  const res = await call(
    handler,
    reqFrom("2.0.0.11", {
      body: { roomCode: "GGG222", wallet: guestWallet, side: "p2" },
      headers: authHeaders(session.token),
    }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.lobbyState.p2.wallet, guestWallet.toLowerCase());
  assert.equal(res.body.lobbyState.p2.tokenId, undefined);
  assert.equal(res.body.lobbyState.status, "connected", "wallet alone must not flip the room to ready");
});

test("join: ownerOf mismatch is still 403 (wallet doesn't actually own the token)", async () => {
  const wallet = randomAddress();
  const actualOwner = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/join.js", { owners: { 5: actualOwner } });
  seedRoom(fake, "CCC222", { status: "waiting", p1: null, p2: null });
  const session = mintFakeSession(fake, { wallet, tokenId: 5 });
  const res = await call(
    handler,
    reqFrom("2.0.0.5", { body: { roomCode: "CCC222", wallet, tokenId: 5 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
});

test("join: a session wallet can't occupy both slots (409 SELF_PLAY)", async () => {
  const wallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/join.js", { owners: { 1: wallet, 2: wallet } });
  seedRoom(fake, "DDD111", {
    status: "connected",
    p1: { wallet, tokenId: 1, joinedAt: 1 },
    p2: { joinedAt: 2 },
  });
  const session = mintFakeSession(fake, { wallet, tokenId: 2 });
  const res = await call(
    handler,
    reqFrom("2.0.0.6", {
      body: { roomCode: "DDD111", wallet, tokenId: 2, side: "p2" },
      headers: authHeaders(session.token),
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SELF_PLAY");
});

test("join: engineVersion mismatch is 426 ENGINE_VERSION_MISMATCH with the room's expected version", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "EEE111", { status: "waiting", engineVersion: "abc123", p1: { joinedAt: 1 }, p2: null });
  const wallet = randomAddress();
  const session = mintFakeSession(fake, { wallet, tokenId: 3 });
  const res = await call(
    handler,
    reqFrom("2.0.0.7", { body: { roomCode: "EEE111", engineVersion: "different" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 426);
  assert.equal(res.body.code, "ENGINE_VERSION_MISMATCH");
  assert.equal(res.body.expected, "abc123");
});

test("join: matching engineVersion is not rejected", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  seedRoom(fake, "EEE222", { status: "waiting", engineVersion: "abc123", p1: { joinedAt: 1 }, p2: null });
  const wallet = randomAddress();
  const session = mintFakeSession(fake, { wallet, tokenId: 3 });
  const res = await call(
    handler,
    reqFrom("2.0.0.8", { body: { roomCode: "EEE222", engineVersion: "abc123" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);
});

test("join: unknown room is 404", async () => {
  const { handler, fake } = freshRoute("api/lobby/join.js");
  const wallet = randomAddress();
  const session = mintFakeSession(fake, { wallet, tokenId: 1 });
  const res = await call(
    handler,
    reqFrom("2.0.0.9", { body: { roomCode: "NOPE00" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 404);
});

// =====================================================================
// api/lobby/poll.js - session-based participant view (no x-brawl-wallet)
// =====================================================================

test("poll: a session participant sees full wallets and never sees `sid`", async () => {
  const p1Wallet = randomAddress();
  const p2Wallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  seedRoom(fake, "FFF111", {
    status: "ready",
    p1: { wallet: p1Wallet, tokenId: 1, sid: "s1", joinedAt: 1 },
    p2: { wallet: p2Wallet, tokenId: 2, sid: "s2", joinedAt: 2 },
  });
  const session = mintFakeSession(fake, { wallet: p1Wallet, tokenId: 1 });
  const res = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "FFF111" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.p1.wallet, p1Wallet);
  assert.equal(res.body.p2.wallet, p2Wallet);
  assert.equal(res.body.p1.sid, undefined);
  assert.equal(res.body.p2.sid, undefined);
});

test("poll: a non-participant session still only sees truncated wallets", async () => {
  const p1Wallet = randomAddress();
  const p2Wallet = randomAddress();
  const strangerWallet = randomAddress();
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  seedRoom(fake, "FFF222", {
    status: "ready",
    p1: { wallet: p1Wallet, tokenId: 1, joinedAt: 1 },
    p2: { wallet: p2Wallet, tokenId: 2, joinedAt: 2 },
  });
  const session = mintFakeSession(fake, { wallet: strangerWallet, tokenId: 99 });
  const res = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "FFF222" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);
  assert.notEqual(res.body.p1.wallet, p1Wallet);
});

// =====================================================================
// api/rtc/signal.js
// =====================================================================

function offerMsg(extra = {}) {
  return { type: "offer", sdp: "v=0...", ...extra };
}

test("signal: POST without a session is 401", async () => {
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  seedRoom(fake, "SIG001", { status: "ready", p1: { wallet: randomAddress(), tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const res = await call(handler, reqFrom("3.0.0.1", { body: { roomCode: "SIG001", msg: offerMsg() } }));
  assert.equal(res.status, 401);
});

test("signal: a non-participant session is 403 NOT_A_PARTICIPANT", async () => {
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  const p1 = randomAddress();
  const p2 = randomAddress();
  seedRoom(fake, "SIG002", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: p2, tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 3 });
  const res = await call(
    handler,
    reqFrom("3.0.0.2", { body: { roomCode: "SIG002", msg: offerMsg() }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NOT_A_PARTICIPANT");
});

test("signal: an invalid msg.type is rejected (400)", async () => {
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  const p1 = randomAddress();
  seedRoom(fake, "SIG003", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    reqFrom("3.0.0.3", { body: { roomCode: "SIG003", msg: { type: "not-a-real-type" } }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 400);
});

test("signal: happy path relays to the OTHER side's queue and flips ready -> signaling on the first message", async () => {
  const p1 = randomAddress();
  const p2 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  seedRoom(fake, "SIG004", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: p2, tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    reqFrom("3.0.0.4", { body: { roomCode: "SIG004", msg: offerMsg({ from: "p1" }) }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const queued = await fake.redisCommand("LRANGE", "sig:SIG004:p2", "0", "-1");
  assert.equal(queued.length, 1);
  assert.equal(JSON.parse(queued[0]).from, "p1");

  const room = JSON.parse(fake.store.get("lobby:SIG004").value);
  assert.equal(room.status, "signaling");
});

test("signal: the queue is capped at 32 messages (429 QUEUE_FULL past that)", async () => {
  const p1 = randomAddress();
  const p2 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  seedRoom(fake, "SIG005", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: p2, tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const headers = authHeaders(session.token);
  for (let i = 0; i < 32; i++) {
    const res = await call(handler, reqFrom("3.0.0.5", { body: { roomCode: "SIG005", msg: offerMsg({ i }) }, headers }));
    assert.equal(res.status, 200, `message ${i} should be accepted`);
  }
  const denied = await call(handler, reqFrom("3.0.0.5", { body: { roomCode: "SIG005", msg: offerMsg({ i: 32 }) }, headers }));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.code, "QUEUE_FULL");
});

test("signal: GET drains the caller's own queue exactly once (empty on the second GET)", async () => {
  const p1 = randomAddress();
  const p2 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/signal.js");
  seedRoom(fake, "SIG006", { status: "signaling", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: p2, tokenId: 2 } });
  await fake.redisCommand("RPUSH", "sig:SIG006:p1", JSON.stringify({ type: "answer", n: 1 }));
  await fake.redisCommand("RPUSH", "sig:SIG006:p1", JSON.stringify({ type: "candidate", n: 2 }));

  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const first = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "SIG006" }, headers: authHeaders(session.token) }),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.msgs.length, 2);

  const second = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "SIG006" }, headers: authHeaders(session.token) }),
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.msgs, []);
});

// =====================================================================
// api/rtc/turn.js
// =====================================================================

test("turn: without TURN_URLS/TURN_SECRET configured, returns STUN-only with 200", async () => {
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/turn.js");
  seedRoom(fake, "TRN001", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "TRN001" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.turn, null);
  assert.ok(Array.isArray(res.body.iceServers) && res.body.iceServers[0].urls.length > 0);
});

test("turn: with TURN_URLS/TURN_SECRET configured, returns REST-style HMAC credentials", async () => {
  process.env.TURN_URLS = "turn:turn.example.com:3478,turn:turn.example.com:3478?transport=tcp";
  process.env.TURN_SECRET = "test-turn-secret";
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/turn.js");
  seedRoom(fake, "TRN002", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "TRN002" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);
  assert.match(res.body.username, new RegExp(`^\\d+:${session.sid}$`));
  assert.equal(res.body.ttl, 600);
  assert.deepEqual(res.body.urls, process.env.TURN_URLS.split(","));
  const expected = crypto.createHmac("sha1", "test-turn-secret").update(res.body.username).digest("base64");
  assert.equal(res.body.credential, expected);

  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
});

test("turn: a non-participant is 403", async () => {
  const { handler, fake } = freshRoute("api/rtc/turn.js");
  seedRoom(fake, "TRN003", { status: "ready", p1: { wallet: randomAddress(), tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 9 });
  const res = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "TRN003" }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
});

test("turn: capped at 6 requests per session per hour (429 TURN_CAP on the 7th)", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/rtc/turn.js");
  seedRoom(fake, "TRN004", { status: "ready", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  for (let i = 0; i < 6; i++) {
    const res = await call(
      handler,
      makeReq({ method: "GET", query: { roomCode: "TRN004" }, headers: authHeaders(session.token) }),
    );
    assert.equal(res.status, 200, `request ${i + 1} of 6 should succeed`);
  }
  const denied = await call(
    handler,
    makeReq({ method: "GET", query: { roomCode: "TRN004" }, headers: authHeaders(session.token) }),
  );
  assert.equal(denied.status, 429);
  assert.equal(denied.body.code, "TURN_CAP");
});

// =====================================================================
// api/match/start.js
// =====================================================================

test("match/start: happy path transitions signaling|ready -> in_match and stamps startedAt", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/match/start.js");
  seedRoom(fake, "STR001", { status: "signaling", matchId: "m_abc", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(handler, reqFrom("4.0.0.1", { body: { roomCode: "STR001" }, headers: authHeaders(session.token) }));
  assert.equal(res.status, 200);
  assert.equal(res.body.matchId, "m_abc");
  assert.equal(res.body.status, "in_match");
  assert.ok(typeof res.body.startedAt === "number");

  const room = JSON.parse(fake.store.get("lobby:STR001").value);
  assert.equal(room.status, "in_match");
});

test("match/start: idempotent - calling it again on an already in_match room returns the SAME matchId, 200", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/match/start.js");
  seedRoom(fake, "STR002", { status: "ready", matchId: "m_xyz", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const headers = authHeaders(session.token);
  const first = await call(handler, reqFrom("4.0.0.2", { body: { roomCode: "STR002" }, headers }));
  assert.equal(first.status, 200);
  const second = await call(handler, reqFrom("4.0.0.2", { body: { roomCode: "STR002" }, headers }));
  assert.equal(second.status, 200);
  assert.equal(second.body.matchId, first.body.matchId);
  assert.equal(second.body.startedAt, first.body.startedAt);
});

test("match/start: a non-participant is 403 and does not start the match", async () => {
  const { handler, fake } = freshRoute("api/match/start.js");
  seedRoom(fake, "STR003", { status: "ready", matchId: "m_no", p1: { wallet: randomAddress(), tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 9 });
  const res = await call(handler, reqFrom("4.0.0.3", { body: { roomCode: "STR003" }, headers: authHeaders(session.token) }));
  assert.equal(res.status, 403);
  const room = JSON.parse(fake.store.get("lobby:STR003").value);
  assert.equal(room.status, "ready", "the room must not start for a non-participant");
});

test("match/start: a room still in 'waiting' (never got to ready) is 409", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/match/start.js");
  seedRoom(fake, "STR004", { status: "waiting", matchId: "m_w", p1: { wallet: p1, tokenId: 1 }, p2: null });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(handler, reqFrom("4.0.0.4", { body: { roomCode: "STR004" }, headers: authHeaders(session.token) }));
  assert.equal(res.status, 409);
});

// =====================================================================
// api/match/heartbeat.js
// =====================================================================

test("match/heartbeat: sets hb:<CODE>:<side> and rejoin:<CODE>:<wallet> with the documented TTLs", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/match/heartbeat.js");
  seedRoom(fake, "HB0001", { status: "in_match", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    reqFrom("5.0.0.1", { body: { roomCode: "HB0001", frame: 1234 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 200);

  const hb = fake.store.get("hb:HB0001:p1");
  assert.equal(hb.value, "1234");
  assert.ok((hb.expiresAt - Date.now()) / 1000 <= 25 && (hb.expiresAt - Date.now()) / 1000 > 20);

  const rejoin = fake.store.get(`rejoin:HB0001:${p1}`);
  assert.equal(rejoin.value, "p1");
  assert.ok((rejoin.expiresAt - Date.now()) / 1000 <= 120 && (rejoin.expiresAt - Date.now()) / 1000 > 110);
});

test("match/heartbeat: a non-participant is 403", async () => {
  const { handler, fake } = freshRoute("api/match/heartbeat.js");
  seedRoom(fake, "HB0002", { status: "in_match", p1: { wallet: randomAddress(), tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 9 });
  const res = await call(
    handler,
    reqFrom("5.0.0.2", { body: { roomCode: "HB0002", frame: 1 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 403);
});

test("match/heartbeat: an invalid frame is rejected (400)", async () => {
  const p1 = randomAddress();
  const { handler, fake } = freshRoute("api/match/heartbeat.js");
  seedRoom(fake, "HB0003", { status: "in_match", p1: { wallet: p1, tokenId: 1 }, p2: { wallet: randomAddress(), tokenId: 2 } });
  const session = mintFakeSession(fake, { wallet: p1, tokenId: 1 });
  const res = await call(
    handler,
    reqFrom("5.0.0.3", { body: { roomCode: "HB0003", frame: -5 }, headers: authHeaders(session.token) }),
  );
  assert.equal(res.status, 400);
});
