// Tests for api/ai-match-complete.js, hermetic via test/_helpers/fake-redis.js
// and test/_helpers/fake-chain.js (same require.cache-swap pattern as
// test/rate-limit.test.mjs / scripts/test-lobby-join.mjs), with REAL ethers
// signing (ethers.Wallet is pure crypto, no network) for wallet1's required
// attestation - see api/ai-match-complete.js's header comment (B4 fix).
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { createFakeChain } from "./_helpers/fake-chain.js";
import { makeReq, call } from "./_helpers/http.js";
import { buildAiMatchMessage as clientBuildAiMatchMessage } from "../src/api.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 40-hex-char address from a small integer — distinct, valid 0x addresses
// without hand-typing hex strings for every fixture wallet/token owner.
// Only used for wallet2 (the AI opponent) below, which is NOT required to
// sign anything (see api/ai-match-complete.js's header comment) - wallet1
// always needs a real ethers.Wallet so it can produce a real signature.
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");

// Fresh fake Redis + fake chain + a fresh require of ai-match-complete.js
// (and its rate-limit.js dependency, which closes over the redis binding)
// per test, so counters/idempotency keys from one test never leak into
// another. Mirrors freshRateLimit() in test/rate-limit.test.mjs.
function freshHandler({ owners = {}, failFor = new Set() } = {}) {
  const redisFake = installFakeRedis(require, root);
  const chainFake = createFakeChain({ owners, failFor });
  chainFake.installFakeChain(require, root);
  for (const rel of ["api/_lib/rate-limit.js", "api/ai-match-complete.js"]) {
    delete require.cache[require.resolve(path.join(root, rel))];
  }
  const handler = require(path.join(root, "api/ai-match-complete.js"));
  return { handler, redisFake };
}

const reqFrom = (ip, body) => makeReq({ headers: { "x-vercel-forwarded-for": ip }, body });

function keysStartingWith(store, prefix) {
  return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
}

function baseFields({ wallet1, nft1, wallet2, nft2, winnerId = null, issuedAt }) {
  return { wallet1, nft1, wallet2, nft2, winnerId, issuedAt: issuedAt ?? new Date().toISOString() };
}

// Signs `fields` with `signerWallet` (an ethers.Wallet, must be wallet1)
// using the SERVER's own buildAiMatchMessage (attached to the handler
// export - see api/ai-match-complete.js's final line) - this is what a
// legitimate client submission looks like (src/api.js's submitAiMatchComplete).
async function signedBody(handler, signerWallet, fields) {
  const message = handler.buildAiMatchMessage(fields);
  const signature = await signerWallet.signMessage(message);
  return { ...fields, signature };
}

test("buildAiMatchMessage: client (src/api.js) and server (api/ai-match-complete.js) produce identical bytes", () => {
  const { handler } = freshHandler();
  const fields = { nft1: 14, nft2: 165, winnerId: 14, wallet1: addr(0xa), issuedAt: "2026-09-16T12:00:00.000Z" };
  assert.equal(clientBuildAiMatchMessage(fields), handler.buildAiMatchMessage(fields));
  // Null-winner (draw) rendering too, not just the happy path.
  const drawFields = { ...fields, winnerId: null };
  assert.equal(clientBuildAiMatchMessage(drawFields), handler.buildAiMatchMessage(drawFields));
});

test("missing signature is rejected (400)", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler } = freshHandler({ owners: { 14: A, 165: B } });
  const body = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14 }); // no signature
  const r = await call(handler, reqFrom("9.9.9.1", body));
  assert.equal(r.status, 400);
});

test("signature from a wallet other than wallet1 is rejected (403 INVALID_SIGNATURE)", async () => {
  const walletA = ethers.Wallet.createRandom();
  const walletOther = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler } = freshHandler({ owners: { 14: A, 165: B } });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14 });
  const body = await signedBody(handler, walletOther, fields); // signed by the wrong wallet
  const r = await call(handler, reqFrom("9.9.9.2", body));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "INVALID_SIGNATURE");
});

test("stale issuedAt is rejected (403 INVALID_TIMESTAMP)", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler } = freshHandler({ owners: { 14: A, 165: B } });
  const staleIssuedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14, issuedAt: staleIssuedAt });
  const body = await signedBody(handler, walletA, fields);
  const r = await call(handler, reqFrom("9.9.9.3", body));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "INVALID_TIMESTAMP");
});

test("a signature can't be replayed (409 REPLAYED)", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler } = freshHandler({ owners: { 14: A, 165: B } });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14 });
  const body = await signedBody(handler, walletA, fields);
  const first = await call(handler, reqFrom("9.9.9.4", body));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await call(handler, reqFrom("9.9.9.4", body));
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "REPLAYED");
});

test("happy path: enqueues exactly one mintqueue entry, no fought: keys, 200 response", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler, redisFake } = freshHandler({ owners: { 14: A, 165: B } });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14 });
  const body = { ...(await signedBody(handler, walletA, fields)), adapter: "hoodchan" };
  const r = await call(handler, reqFrom("1.1.1.1", body));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, queued: true, adapter: "hoodchan", pair: [14, 165] });
  assert.equal(keysStartingWith(redisFake.store, "mintqueue:").length, 1, "exactly one mint queued");
  assert.equal(keysStartingWith(redisFake.store, "fought:").length, 0, "no fought: keys written here — that's mint-cron's job after a real mint");
});

test("draw (winnerId null) records a draw for both fighters, not a loss", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler, redisFake } = freshHandler({ owners: { 14: A, 165: B } });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: null });
  const body = await signedBody(handler, walletA, fields);
  const r = await call(handler, reqFrom("9.9.9.5", body));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const recent = await redisFake.redisCommand("LRANGE", "matches:recent", "0", "0");
  const entry = JSON.parse(recent[0]);
  assert.equal(entry.result, "draw");
  // No winner means no wins/losses counter writes at all for this match.
  assert.equal(await redisFake.redisCommand("GET", "hoodie:14:wins"), null);
  assert.equal(await redisFake.redisCommand("GET", "hoodie:165:losses"), null);
});

test("same wallet on both sides is 400", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const { handler } = freshHandler({ owners: { 14: A, 165: A } });
  const upperCaseA = "0x" + A.slice(2).toUpperCase(); // same address, different case — must still collide
  // Rejected on the same-wallet check before signature verification is even
  // reached, so a syntactically-present-but-unverified signature is enough.
  const body = { ...baseFields({ wallet1: A, nft1: 14, wallet2: upperCaseA, nft2: 165, winnerId: null }), signature: "0xdeadbeef" };
  const r = await call(handler, reqFrom("1.1.1.2", body));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /different/i);
});

test("claimed ownership that doesn't match the chain is 403 with which side failed", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const ACTUAL_OWNER = addr(0xc0ffee);
  // token 165 is actually owned by ACTUAL_OWNER, not B as the request claims
  const { handler } = freshHandler({ owners: { 14: A, 165: ACTUAL_OWNER } });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: null });
  const body = await signedBody(handler, walletA, fields);
  const r = await call(handler, reqFrom("1.1.1.3", body));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(r.body.failed, ["wallet2/nft2"]);
});

test("RPC failure verifying ownership is 502, never a silent pass, and consumes no idempotency key", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler, redisFake } = freshHandler({ owners: { 14: A }, failFor: new Set([165]) });
  const fields = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: null });
  const body = await signedBody(handler, walletA, fields);
  const r = await call(handler, reqFrom("1.1.1.4", body));
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "Could not verify ownership");
  assert.equal(keysStartingWith(redisFake.store, "mintidem:").length, 0, "ownership must be verified before any idempotency key is claimed");
});

test("a second request for the same pair is 409 (idempotent), first request unaffected", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler, redisFake } = freshHandler({ owners: { 14: A, 165: B } });
  // Two distinct signed attestations for the SAME pair (different issuedAt,
  // so this exercises the mintidem: pair-idempotency guard, not the
  // sigused:aimatch: replay guard a byte-identical resubmit would hit
  // instead).
  const fields1 = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14 });
  const body1 = await signedBody(handler, walletA, fields1);
  const first = await call(handler, reqFrom("1.1.1.5", body1));
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const fields2 = baseFields({ wallet1: A, nft1: 14, wallet2: B, nft2: 165, winnerId: 14, issuedAt: new Date(Date.now() + 1000).toISOString() });
  const body2 = await signedBody(handler, walletA, fields2);
  const second = await call(handler, reqFrom("1.1.1.5", body2));
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already minted or pending/);
  // Still exactly one queued mint — the duplicate never got that far.
  assert.equal(keysStartingWith(redisFake.store, "mintqueue:").length, 1);
});

test("a wallet's 4th mint in a day is 429 even though each pair is new", async () => {
  const hostWallet = ethers.Wallet.createRandom();
  const HOST = hostWallet.address.toLowerCase();
  const opponents = [addr(1), addr(2), addr(3), addr(4)];
  const owners = { 14: HOST, 1: opponents[0], 2: opponents[1], 3: opponents[2], 4: opponents[3] };
  const { handler, redisFake } = freshHandler({ owners });

  const results = [];
  for (let i = 0; i < 4; i++) {
    const fields = baseFields({ wallet1: HOST, nft1: 14, wallet2: opponents[i], nft2: i + 1, winnerId: 14 });
    const body = await signedBody(handler, hostWallet, fields);
    results.push(await call(handler, reqFrom("1.1.1.6", body)));
  }
  assert.deepEqual(results.slice(0, 3).map((r) => r.status), [200, 200, 200], JSON.stringify(results.slice(0, 3)));
  assert.equal(results[3].status, 429, JSON.stringify(results[3].body));
  assert.equal(results[3].body.error, "daily mint cap reached");
  // Cap was hit before any mint queued for the 4th pair, and its idempotency
  // claim must have been released so it isn't dead-locked for 30 days.
  assert.equal(keysStartingWith(redisFake.store, "mintqueue:").length, 3);
  assert.equal(keysStartingWith(redisFake.store, "mintidem:hoodchan:4:14").length, 0);
});

test("a capped wallet1 doesn't burn its opponent's daily quota (sequential cap check)", async () => {
  const hostWallet = ethers.Wallet.createRandom();
  const HOST = hostWallet.address.toLowerCase();
  const opponent = ethers.Wallet.createRandom(); // will be wallet1 in the 5th, unrelated request
  const OPP = opponent.address.toLowerCase();
  const owners = { 14: HOST, 1: addr(1), 2: addr(2), 3: addr(3), 165: OPP };
  const { handler, redisFake } = freshHandler({ owners });

  // Burn HOST's cap (3/day) against three different opponents.
  for (let i = 0; i < 3; i++) {
    const fields = baseFields({ wallet1: HOST, nft1: 14, wallet2: addr(i + 1), nft2: i + 1, winnerId: 14 });
    const body = await signedBody(handler, hostWallet, fields);
    const r = await call(handler, reqFrom("1.1.1.9", body));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  // HOST is now capped. Pair HOST (wallet1, over cap) against OPP - this
  // must 429 without touching OPP's own daily counter.
  const fields = baseFields({ wallet1: HOST, nft1: 14, wallet2: OPP, nft2: 165, winnerId: 14 });
  const body = await signedBody(handler, hostWallet, fields);
  const r = await call(handler, reqFrom("1.1.1.9", body));
  assert.equal(r.status, 429);
  assert.equal(await redisFake.redisCommand("GET", `rl:aimint:${OPP}`), null, "wallet2 must not be charged when wallet1 was already over cap");
});

test("6th ai-match-complete request from one IP in 10 minutes is 429, regardless of body validity", async () => {
  const wallets = [];
  const owners = {};
  for (let i = 1; i <= 12; i++) {
    if (i % 2 === 1) {
      const w = ethers.Wallet.createRandom();
      wallets[i] = w;
      owners[i] = w.address.toLowerCase();
    } else {
      owners[i] = addr(i);
    }
  }
  const { handler } = freshHandler({ owners });

  const results = [];
  for (let i = 0; i < 6; i++) {
    const nft1 = i * 2 + 1;
    const nft2 = i * 2 + 2;
    const fields = baseFields({ wallet1: owners[nft1], nft1, wallet2: owners[nft2], nft2, winnerId: null });
    const body = await signedBody(handler, wallets[nft1], fields);
    results.push(await call(handler, reqFrom("2.2.2.2", body)));
  }
  assert.deepEqual(results.slice(0, 5).map((r) => r.status), [200, 200, 200, 200, 200], JSON.stringify(results));
  assert.equal(results[5].status, 429);
  assert.equal(results[5].body.error, "Too many requests", "rate limit 429, not the daily-cap 429");
});

test("out-of-range token id is 400", async () => {
  const walletA = ethers.Wallet.createRandom();
  const A = walletA.address.toLowerCase();
  const B = addr(0xb);
  const { handler } = freshHandler({ owners: { 14: A, 1201: B } });
  const r = await call(handler, reqFrom("1.1.1.7", { wallet1: A, nft1: 14, wallet2: B, nft2: 1201, signature: "0xdeadbeef", issuedAt: new Date().toISOString() }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /1\.\.1200/);

  const r2 = await call(handler, reqFrom("1.1.1.7", { wallet1: A, nft1: 0, wallet2: B, nft2: 165, signature: "0xdeadbeef", issuedAt: new Date().toISOString() }));
  assert.equal(r2.status, 400, "0 is out of range — HOODCHAN token IDs start at 1");
});
