// Hardening tests for the routes in the "low-risk" hardening pass: rate
// limits are wired, lobby/create stamps adapter+seed, lobby/poll stages
// wallet exposure by room status, share-upload validates real PNG bytes,
// and ipfs validates the CID it's asked to proxy.
//
// Hermetic: fake Redis (test/_helpers/fake-redis.js) swapped into
// require.cache for api/_lib/redis.js, and a fake @vercel/blob for
// share-upload. Each test gets a FRESH fake + fresh require of the route
// (and of api/_lib/rate-limit.js) so one test's rate-limit counters never
// leak into the next - same cache-busting need as test/rate-limit.test.mjs.
//
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import crypto from "node:crypto";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { makeReq, call } from "./_helpers/http.js";
import { mintFakeSession } from "./_helpers/fake-session.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// api/lobby/create.js and api/lobby/poll.js now require/accept a session
// (see api/_lib/auth.js) - every test below that calls them needs
// SESSION_SECRET set so mintFakeSession's HMAC matches what those routes
// verify with.
process.env.SESSION_SECRET = "test-routes-hardening-secret";

function randomAddress() {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

// Fresh fake Redis, with api/_lib/rate-limit.js, api/_lib/auth.js,
// api/_lib/room.js, AND the target route re-required against it -
// otherwise any already-cached module would still hold a `redisCommand`
// closed over a previous test's (or no) fake. auth.js/room.js matter now
// that api/lobby/create.js and api/lobby/poll.js depend on them (session
// gating, TTL_BY_STATE) - without busting their cache too, a session
// minted into THIS test's fake redis would look up against a STALE fake
// from an earlier test and never be found.
function freshRoute(relPath) {
  const fake = installFakeRedis(require, root);
  for (const dep of ["api/_lib/rate-limit.js", "api/_lib/auth.js", "api/_lib/room.js"]) {
    delete require.cache[require.resolve(path.join(root, dep))];
  }
  const routePath = require.resolve(path.join(root, relPath));
  delete require.cache[routePath];
  const handler = require(routePath);
  return { handler, fake };
}

// Stubs @vercel/blob's `put` so share-upload.js tests never touch the
// network - and never need the real package on disk at all. require.cache
// alone isn't enough here (unlike fake-redis.js/fake-chain.js, which stub a
// real in-repo file): "@vercel/blob" is a bare specifier Node has to
// resolve on disk first, and this checkout has no node_modules installed
// (zero-build repo, dep never actually npm-installed for local test runs).
// So Module._resolveFilename is patched to hand back a synthetic id for
// that one specifier, then require.cache is seeded at that id - same
// "cache holds the exports object" trick, just with a resolution step
// Node itself doesn't need to perform on disk.
const FAKE_BLOB_ID = path.join(root, "__fake_vercel_blob__.js");
let blobResolvePatched = false;
function installFakeBlob() {
  const calls = [];
  require.cache[FAKE_BLOB_ID] = {
    id: FAKE_BLOB_ID,
    filename: FAKE_BLOB_ID,
    loaded: true,
    exports: {
      async put(filename, body, opts) {
        calls.push({ filename, size: body.length, opts });
        return { url: `https://blob.fake/${filename}` };
      },
    },
  };
  if (!blobResolvePatched) {
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "@vercel/blob") return FAKE_BLOB_ID;
      return originalResolve.call(this, request, ...rest);
    };
    blobResolvePatched = true;
  }
  return calls;
}

// share-upload.js reads the body via `for await (const chunk of req)`, not
// req.body - a plain async-iterable stand-in, not the {method,body,...}
// shape test/_helpers/http.js's makeReq builds for JSON-body routes.
function makeStreamReq({ method = "POST", headers = {}, chunks = [] } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const reqFrom = (ip, { headers = {}, ...extra } = {}) =>
  makeReq({ headers: { "x-vercel-forwarded-for": ip, ...headers }, ...extra });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- lobby/create ---------------------------------------------------------

test("lobby/create requires a session (401 UNAUTHENTICATED)", async () => {
  const { handler } = freshRoute("api/lobby/create.js");
  const res = await call(handler, reqFrom("10.0.0.0"));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "UNAUTHENTICATED");
});

test("lobby/create stamps the room with adapter + a uint32 seed, p1 from the session", async () => {
  const { handler, fake } = freshRoute("api/lobby/create.js");
  const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 7 });
  const res = await call(handler, reqFrom("10.0.0.1", { headers: { authorization: `Bearer ${session.token}` } }));
  assert.equal(res.status, 200);
  const { roomCode } = res.body;
  const stored = JSON.parse(fake.store.get(`lobby:${roomCode}`).value);
  assert.equal(stored.adapter, "onchainhoodies"); // LEGACY_ADAPTER_KEY, no ADAPTER_KEY env set
  assert.equal(typeof stored.seed, "number");
  assert.ok(Number.isInteger(stored.seed));
  assert.ok(stored.seed >= 0 && stored.seed <= 0xffffffff, "seed must fit a uint32");
  assert.equal(stored.p1.wallet, session.wallet);
  assert.equal(stored.p1.tokenId, 7);
});

test("lobby/create 429s on the 11th call from one IP within the window", async () => {
  const { handler, fake } = freshRoute("api/lobby/create.js");
  const ip = "10.0.0.2";
  for (let i = 0; i < 10; i++) {
    // A distinct wallet per call - otherwise the per-wallet rooms:open cap
    // (max 2/hour, see api/lobby/create.js) would 429 first and this
    // wouldn't be testing the IP rate limit at all.
    const session = mintFakeSession(fake, { wallet: randomAddress(), tokenId: i + 1 });
    const res = await call(handler, reqFrom(ip, { headers: { authorization: `Bearer ${session.token}` } }));
    assert.equal(res.status, 200, `call ${i + 1} of 10 should succeed`);
  }
  const lastSession = mintFakeSession(fake, { wallet: randomAddress(), tokenId: 99 });
  const denied = await call(handler, reqFrom(ip, { headers: { authorization: `Bearer ${lastSession.token}` } }));
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers["Retry-After"]) > 0);
});

test("lobby/create 429s (ROOM_CAP) on the 3rd room from the same wallet within the hour", async () => {
  const { handler, fake } = freshRoute("api/lobby/create.js");
  const wallet = randomAddress();
  for (let i = 0; i < 2; i++) {
    const session = mintFakeSession(fake, { wallet, tokenId: 1 });
    const res = await call(handler, reqFrom(`10.0.1.${i}`, { headers: { authorization: `Bearer ${session.token}` } }));
    assert.equal(res.status, 200, `room ${i + 1} of 2 should succeed`);
  }
  const session3 = mintFakeSession(fake, { wallet, tokenId: 1 });
  const denied = await call(handler, reqFrom("10.0.1.9", { headers: { authorization: `Bearer ${session3.token}` } }));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.code, "ROOM_CAP");
});

// --- lobby/poll -------------------------------------------------------------

const P1_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const P2_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function seedLobby(fake, roomCode, lobby) {
  await fake.redisCommand("SET", `lobby:${roomCode}`, JSON.stringify(lobby), "EX", "600");
}

test("lobby/poll hides wallets before status is ready", async () => {
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  await seedLobby(fake, "AAA111", {
    status: "connected",
    p1: { wallet: P1_WALLET, tokenId: 1, joinedAt: 1 },
    p2: { wallet: P2_WALLET, tokenId: 2, joinedAt: 2 },
  });
  const res = await call(handler, makeReq({ method: "GET", query: { roomCode: "AAA111" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.p1, { present: true, tokenId: 1 });
  assert.deepEqual(res.body.p2, { present: true, tokenId: 2 });
  assert.equal(res.body.p1.wallet, undefined);
});

test("lobby/poll truncates wallets at ready for a non-participant caller", async () => {
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  await seedLobby(fake, "BBB222", {
    status: "ready",
    p1: { wallet: P1_WALLET, tokenId: 1, joinedAt: 1 },
    p2: { wallet: P2_WALLET, tokenId: 2, joinedAt: 2 },
  });
  const res = await call(handler, makeReq({ method: "GET", query: { roomCode: "BBB222" } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.p1.wallet, "0xaaaa…aaaa");
  assert.equal(res.body.p2.wallet, "0xbbbb…bbbb");
});

test("lobby/poll reveals full wallets to a proven participant (session, not the removed x-brawl-wallet header)", async () => {
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  await seedLobby(fake, "CCC333", {
    status: "ready",
    p1: { wallet: P1_WALLET, tokenId: 1, joinedAt: 1 },
    p2: { wallet: P2_WALLET, tokenId: 2, joinedAt: 2 },
  });
  const session = mintFakeSession(fake, { wallet: P1_WALLET, tokenId: 1 });
  const res = await call(
    handler,
    makeReq({
      method: "GET",
      query: { roomCode: "CCC333" },
      headers: { authorization: `Bearer ${session.token}` },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.p1.wallet, P1_WALLET);
  assert.equal(res.body.p2.wallet, P2_WALLET);
  assert.equal(res.body.p1.sid, undefined, "sid must never be exposed to poll callers, even participants");
});

test("lobby/poll: the OLD x-brawl-wallet header no longer proves participation (truncated wallets)", async () => {
  const { handler, fake } = freshRoute("api/lobby/poll.js");
  await seedLobby(fake, "DDD444", {
    status: "ready",
    p1: { wallet: P1_WALLET, tokenId: 1, joinedAt: 1 },
    p2: { wallet: P2_WALLET, tokenId: 2, joinedAt: 2 },
  });
  const res = await call(
    handler,
    makeReq({
      method: "GET",
      query: { roomCode: "DDD444" },
      headers: { "x-brawl-wallet": P1_WALLET.toUpperCase() },
    }),
  );
  assert.equal(res.status, 200);
  assert.notEqual(res.body.p1.wallet, P1_WALLET);
  assert.equal(res.body.p1.wallet, "0xaaaa…aaaa");
});

// --- share-upload -----------------------------------------------------------

test("share-upload rejects a body that isn't a real PNG (magic bytes)", async () => {
  installFakeBlob();
  const { handler } = freshRoute("api/share-upload.js");
  const req = makeStreamReq({
    headers: { "x-vercel-forwarded-for": "10.0.0.3", "content-type": "image/png" },
    chunks: [Buffer.from("this is not a png")],
  });
  const res = await call(handler, req);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a valid PNG/);
});

test("share-upload rejects a payload over the 3MB cap", async () => {
  installFakeBlob();
  const { handler } = freshRoute("api/share-upload.js");
  const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(3 * 1024 * 1024)]); // > 3MB total
  const req = makeStreamReq({
    headers: { "x-vercel-forwarded-for": "10.0.0.4", "content-type": "image/png" },
    chunks: [oversized],
  });
  const res = await call(handler, req);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /3MB/);
});

test("share-upload accepts a real PNG and passes addRandomSuffix through to put()", async () => {
  const calls = installFakeBlob();
  const { handler } = freshRoute("api/share-upload.js");
  const validPng = Buffer.concat([PNG_MAGIC, Buffer.from([1, 2, 3, 4])]);
  const req = makeStreamReq({
    headers: { "x-vercel-forwarded-for": "10.0.0.5", "content-type": "image/png" },
    chunks: [validPng],
  });
  const res = await call(handler, req);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.addRandomSuffix, true);
});

// --- ipfs ---------------------------------------------------------------

test("ipfs rejects a path that isn't a valid CID", async () => {
  const { handler } = freshRoute("api/ipfs.js");
  const res = await call(
    handler,
    reqFrom("10.0.0.6", { method: "GET", query: { path: "../../etc/passwd" } }),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /CID/);
});

// --- match-result ---------------------------------------------------------

test("match-result 429s after 60 calls from one IP within the window", async () => {
  const { handler } = freshRoute("api/match-result.js");
  const ip = "10.0.0.8";
  for (let i = 0; i < 60; i++) {
    const res = await call(handler, reqFrom(ip, { body: { tokenId: 1, result: "win" } }));
    assert.equal(res.status, 200, `call ${i + 1} of 60 should succeed`);
  }
  const denied = await call(handler, reqFrom(ip, { body: { tokenId: 1, result: "win" } }));
  assert.equal(denied.status, 429);
});
