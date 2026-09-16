// Tests for api/mint-cron.js, hermetic via test/_helpers/fake-redis.js and a
// local fake for api/_lib/chain.js (getBalance/blockNumber aren't part of
// test/_helpers/fake-chain.js's shape, so this file installs its own),
// plus a fake api/_lib/mint.js (stubbing ethers.Contract/Wallet would mean
// stubbing ethers itself — this repo's own convention, per
// test/ai-match-complete.test.mjs, is to fake at the _lib boundary instead).
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { installFakeRedis } from "./_helpers/fake-redis.js";
import { makeReq, call } from "./_helpers/http.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CRON_SECRET = "test-cron-secret";
const MINTER_ADDRESS = "0x000000000000000000000000000000000000ba1e";
// Well above DEFAULT_MINTER_MIN_WEI (0.002 ETH) so tests default to "funded"
// unless a test overrides balanceWei explicitly.
const FUNDED_BALANCE_WEI = "1000000000000000000"; // 1 ETH

function installFakeChain({ balanceWei = FUNDED_BALANCE_WEI, block = 12345, failBalance = false, failBlock = false } = {}) {
  const p = require.resolve(path.join(root, "api/_lib/chain.js"));
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      RPC_URL: "https://fake-rpc.invalid",
      CHAIN_ID: 4663,
      NFT_CONTRACT: "0x0000000000000000000000000000000000dEaD",
      ownerOf: async () => null,
      getBalance: async () => {
        if (failBalance) throw new Error("fake chain: rpc down");
        return balanceWei;
      },
      blockNumber: async () => {
        if (failBlock) throw new Error("fake chain: rpc down");
        return { block, endpoint: "public" };
      },
    },
  };
}

// mintResults: array of results/errors consumed in call order (one per
// mintMatchRecord call), so a test can script "fails, fails, succeeds" etc.
// A plain object is treated as a success return; an Error instance is thrown.
function installFakeMint(mintResults = [{ txHash: "0xabc", alreadyMinted: false, tba1: "0xt1", tba2: "0xt2" }]) {
  let i = 0;
  const calls = [];
  const p = require.resolve(path.join(root, "api/_lib/mint.js"));
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      mintMatchRecord: async (wallet1, nft1, wallet2, nft2) => {
        calls.push({ wallet1, nft1, wallet2, nft2 });
        const next = mintResults[Math.min(i, mintResults.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next;
      },
      getMinterAddress: () => MINTER_ADDRESS,
      computeTba: async () => "0xtba",
    },
  };
  return { calls };
}

// test/_helpers/fake-redis.js's EVAL handler only recognizes ONE script (the
// CAS_SIGNATURE substring match) and misidentifies anything else containing
// "redis.call('GET', KEYS[1])" as that same compare-and-set script — which
// api/_lib/redis.js's new "cdel" script (compare-and-DELETE) also starts
// with. Rather than edit the shared helper (out of this task's ownership),
// patch redisEval directly on the already-installed fake's cached exports so
// "cas"/"cdel" are both handled correctly using the fake's own GET/DEL/CAS
// primitives — mint-cron.js only ever calls redisEval("cdel", ...), but
// "cas" is patched too for parity with the real registry.
function patchFakeRedisEval(fake) {
  const p = require.resolve(path.join(root, "api/_lib/redis.js"));
  require.cache[p].exports.redisEval = async (name, keys = [], args = []) => {
    if (name === "cdel") {
      const [key] = keys;
      const [expected] = args;
      const cur = await fake.redisCommand("GET", key);
      if (cur === expected) {
        await fake.redisCommand("DEL", key);
        return 1;
      }
      return 0;
    }
    if (name === "cas") {
      const [key] = keys;
      const [expected, next, ttl] = args;
      return (await fake.redisCompareAndSet(key, expected, next, ttl)) ? 1 : 0;
    }
    throw new Error(`fake redisEval: unknown script "${name}"`);
  };
}

// `patchRedisCommand`, when given, is applied to the cached module's
// `exports.redisCommand` BEFORE api/mint-cron.js is (re)required — mint-cron
// destructures `{ redisCommand }` at require time, so patching the cache
// exports AFTER that require would leave mint-cron holding the old function
// reference. Receives (originalRedisCommand) and returns the replacement.
function freshHandler({ chain, mintResults, patchRedisCommand } = {}) {
  const redisFake = installFakeRedis(require, root);
  patchFakeRedisEval(redisFake);
  installFakeChain(chain);
  const mintFake = installFakeMint(mintResults);
  if (patchRedisCommand) {
    const p = require.resolve(path.join(root, "api/_lib/redis.js"));
    require.cache[p].exports.redisCommand = patchRedisCommand(require.cache[p].exports.redisCommand);
  }
  for (const rel of ["api/_lib/rate-limit.js", "api/_lib/log.js", "api/_lib/metrics.js", "api/mint-cron.js"]) {
    delete require.cache[require.resolve(path.join(root, rel))];
  }
  const handler = require(path.join(root, "api/mint-cron.js"));
  return { handler, redisFake, mintFake };
}

// test/_helpers/http.js's call() resolves as soon as the handler invokes
// res.json()/res.end() — fine for asserting the response, but mint-cron.js
// does its lock release in a `finally` block AFTER the response is sent, so
// asserting on Redis state right after `await call(...)` races that
// still-pending cleanup. This awaits the handler's own returned promise (so
// the whole async function, finally included) before resolving.
function callFull(handler, req) {
  const headers = {};
  let captured = null;
  const res = {
    setHeader(key, value) { headers[key] = value; },
    status(code) { this._status = code; return this; },
    json(body) { captured = { status: this._status, body, headers }; },
    end(body) { captured = { status: this._status, body, headers }; },
  };
  return Promise.resolve(handler(req, res)).then(() => captured);
}

function cronReq() {
  return makeReq({ method: "GET", headers: { authorization: `Bearer ${CRON_SECRET}` } });
}

function withCronSecret(fn) {
  return async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = CRON_SECRET;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  };
}

async function seedQueueEntry(redisFake, roomCode, overrides = {}) {
  const entry = {
    roomCode,
    wallet1: "0x1111111111111111111111111111111111111a",
    nft1: 1,
    wallet2: "0x2222222222222222222222222222222222222b",
    nft2: 2,
    queuedAt: Date.now(),
    ...overrides,
  };
  await redisFake.redisCommand("SET", `mintqueue:${roomCode}`, JSON.stringify(entry), "EX", "7200");
  return entry;
}

test("wrong/missing CRON_SECRET auth is unaffected by the rewrite (401/503)", withCronSecret(async () => {
  const { handler } = freshHandler();
  const r = await call(handler, makeReq({ method: "GET", headers: { authorization: "Bearer nope" } }));
  assert.equal(r.status, 401);
}));

test("SET mint:cron:last happens at the start of every run, even a locked-out one", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler();
  await redisFake.redisCommand("SET", "mint:lock", "someone-elses-run-id", "NX", "EX", "50");
  const r = await call(handler, cronReq());
  assert.deepEqual(r.body, { skipped: "locked" });
  const last = await redisFake.redisCommand("GET", "mint:cron:last");
  assert.ok(last, "mint:cron:last must be set even when this run is locked out");
}));

test("lock prevents a concurrent run: second call is skipped, first still processes", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler();
  await seedQueueEntry(redisFake, "ROOM1");

  // Simulate an in-flight run holding the lock.
  await redisFake.redisCommand("SET", "mint:lock", "in-flight-run-id", "NX", "EX", "50");
  const r = await call(handler, cronReq());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { skipped: "locked" });
  // Queue entry untouched — the locked-out run never got to processing.
  assert.ok(await redisFake.redisCommand("GET", "mintqueue:ROOM1"), "entry must still be queued");
}));

test("lock is released after a successful run (cdel), so the next run can acquire it", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler();
  await seedQueueEntry(redisFake, "ROOM1");
  // callFull, not call() — the lock release happens in a `finally` AFTER
  // the response is sent (see callFull's doc comment above).
  const first = await callFull(handler, cronReq());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(await redisFake.redisCommand("GET", "mint:lock"), null, "lock must be released after the run finishes");
}));

test("multi-page SCAN reads every mintqueue: key across all pages, not just the first", withCronSecret(async () => {
  let scanCalls = 0;
  // Applied BEFORE mint-cron.js is required (see freshHandler's
  // patchRedisCommand doc comment) — the FIRST SCAN call reports a non-zero
  // cursor (simulating a second page still pending) with no keys on it,
  // proving mint-cron.js's loop keeps scanning until cursor "0" instead of
  // trusting the first page alone; the second call must be issued with the
  // cursor the first call returned.
  const { handler, redisFake } = freshHandler({
    mintResults: [{ txHash: "0xa", alreadyMinted: false, tba1: "0xt1", tba2: "0xt2" }],
    patchRedisCommand: (original) => async (cmd, ...args) => {
      if (String(cmd).toUpperCase() === "SCAN") {
        scanCalls++;
        if (scanCalls === 1) return ["5", []];
        assert.equal(args[0], "5", "loop must SCAN with the cursor the previous page returned");
        return ["0", ["mintqueue:PAGE1"]];
      }
      return original(cmd, ...args);
    },
  });
  await seedQueueEntry(redisFake, "PAGE1");

  const r = await call(handler, cronReq());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.processed, 1, "the entry on the second SCAN page must still be processed");
  assert.equal(scanCalls, 2, "loop must issue a second SCAN because the first page's cursor wasn't 0");
}));

test("processes at most 3 entries per run, oldest queuedAt first", withCronSecret(async () => {
  const { handler, redisFake, mintFake } = freshHandler({ mintResults: [
    { txHash: "0x1", alreadyMinted: false, tba1: "a", tba2: "b" },
    { txHash: "0x2", alreadyMinted: false, tba1: "a", tba2: "b" },
    { txHash: "0x3", alreadyMinted: false, tba1: "a", tba2: "b" },
  ]});
  const now = Date.now();
  await seedQueueEntry(redisFake, "NEWEST", { queuedAt: now });
  await seedQueueEntry(redisFake, "MIDDLE", { queuedAt: now - 1000 });
  await seedQueueEntry(redisFake, "OLDEST", { queuedAt: now - 2000 });
  await seedQueueEntry(redisFake, "FOURTH", { queuedAt: now - 500 });

  const r = await call(handler, cronReq());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.processed, 3, "at most 3 per run");
  assert.deepEqual(mintFake.calls.map((c) => c.nft1), [1, 1, 1]); // sanity: all calls used the seeded fixture shape
  // The 4th-oldest ("NEWEST", queuedAt = now) must be the one left behind.
  assert.ok(await redisFake.redisCommand("GET", "mintqueue:NEWEST"), "the newest entry must be the one skipped this run");
  assert.equal(await redisFake.redisCommand("GET", "mintqueue:OLDEST"), null, "oldest entry must have been processed and deleted");
}));

test("5th failed attempt dead-letters the entry and deletes the queue key", withCronSecret(async () => {
  const failure = () => new Error("contract revert: nope");
  const { handler, redisFake } = freshHandler({
    mintResults: [failure(), failure(), failure(), failure(), failure()],
  });
  await seedQueueEntry(redisFake, "FLAKY");

  let last;
  for (let i = 0; i < 5; i++) {
    // Each cron run only advances the shared fake mint's call index by
    // however many entries it actually processes (1, since only one entry
    // is queued) — five separate runs against the same still-queued entry.
    last = await call(handler, cronReq());
    if (i < 4) {
      assert.equal(last.body.results[0].status, "error", `run ${i + 1} should still be a plain retry`);
      assert.ok(await redisFake.redisCommand("GET", "mintqueue:FLAKY"), `entry must still be queued after run ${i + 1}`);
    }
  }
  assert.equal(last.body.results[0].status, "dead-lettered");
  assert.equal(await redisFake.redisCommand("GET", "mintqueue:FLAKY"), null, "queue key must be deleted once dead-lettered");
  const dead = await redisFake.redisCommand("LRANGE", "mint:dead", "0", "-1");
  assert.equal(dead.length, 1);
  const payload = JSON.parse(dead[0]);
  assert.equal(payload.key, "mintqueue:FLAKY");
  assert.match(payload.lastError, /contract revert/);
}));

test("success writes the ledger + deletes the queue key + increments bar:total once, plus fought: pairs", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler({ mintResults: [
    { txHash: "0xsuccess", alreadyMinted: false, tba1: "0xTBA1", tba2: "0xTBA2" },
  ]});
  await seedQueueEntry(redisFake, "WIN1");

  const r = await call(handler, cronReq());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].status, "minted");
  assert.equal(r.body.results[0].txHash, "0xsuccess");

  assert.equal(await redisFake.redisCommand("GET", "mintqueue:WIN1"), null);
  assert.equal(await redisFake.redisCommand("GET", "bar:total"), "1");
  const ledgerEntry = await redisFake.redisCommand("HGET", "mint:ledger", "mintqueue:WIN1");
  assert.ok(ledgerEntry);
  const parsed = JSON.parse(ledgerEntry);
  assert.equal(parsed.txHash, "0xsuccess");
  assert.equal(parsed.tba1, "0xTBA1");
  const fought1 = await redisFake.redisCommand("SMEMBERS", "fought:0x1111111111111111111111111111111111111a");
  assert.deepEqual(fought1, ["1:0x2222222222222222222222222222222222222b:2"]);
}));

test("already-minted success does not double-increment bar:total", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler({ mintResults: [
    { txHash: null, alreadyMinted: true },
  ]});
  await redisFake.redisCommand("SET", "bar:total", "10");
  await seedQueueEntry(redisFake, "DUPE");
  const r = await call(handler, cronReq());
  assert.equal(r.body.results[0].status, "already-minted");
  assert.equal(await redisFake.redisCommand("GET", "bar:total"), "10", "bar:total must not increment for an already-minted pairing");
}));

test("minter-low skips sending and sets the alert key, without touching the queue", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler({ chain: { balanceWei: "1" } }); // 1 wei, far under the default min
  await seedQueueEntry(redisFake, "STARVED");
  // callFull — this early-return path still releases the lock in a
  // `finally` AFTER the response is sent (see callFull's doc comment).
  const r = await callFull(handler, cronReq());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { skipped: "minter-low" });
  assert.equal(await redisFake.redisCommand("GET", "mint:alert:minter-low"), "1");
  assert.ok(await redisFake.redisCommand("GET", "mintqueue:STARVED"), "queue must be untouched when the minter is starved");
  // Lock must still be released even on this early-return path.
  assert.equal(await redisFake.redisCommand("GET", "mint:lock"), null);
}));

test("MINTER_MIN_WEI env override changes the low-balance threshold", withCronSecret(async () => {
  const prev = process.env.MINTER_MIN_WEI;
  process.env.MINTER_MIN_WEI = "5000000000000000000"; // 5 ETH — above the 1 ETH fixture balance
  try {
    const { handler, redisFake } = freshHandler();
    await seedQueueEntry(redisFake, "ROOM1");
    const r = await call(handler, cronReq());
    assert.deepEqual(r.body, { skipped: "minter-low" });
  } finally {
    if (prev === undefined) delete process.env.MINTER_MIN_WEI;
    else process.env.MINTER_MIN_WEI = prev;
  }
}));

test("mint:minter:address is published every run the minter is configured, even when the queue is empty", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler();
  const r = await call(handler, cronReq());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { processed: 0 });
  assert.equal(await redisFake.redisCommand("GET", "mint:minter:address"), MINTER_ADDRESS);
}));

test("a hard failure mid-run sets mint:cron:lastError", withCronSecret(async () => {
  const { handler, redisFake } = freshHandler({ chain: { failBalance: true } });
  await seedQueueEntry(redisFake, "ROOM1");
  const r = await call(handler, cronReq());
  assert.equal(r.status, 502);
  const lastError = await redisFake.redisCommand("GET", "mint:cron:lastError");
  assert.ok(lastError, "mint:cron:lastError must be set on a failed run");
}));
