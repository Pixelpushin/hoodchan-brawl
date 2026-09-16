// Tests for api/status.js, hermetic via test/_helpers/fake-redis.js and a
// local fake for api/_lib/chain.js (getBalance/blockNumber aren't part of
// test/_helpers/fake-chain.js's shape, so — same as test/mint-cron.test.mjs —
// this file installs its own).
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

function installFakeChain({ block = 999, endpoint = "public", failBalance = false, failBlock = false, balanceWei = "1234000000000000000" } = {}) {
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
        return { block, endpoint };
      },
    },
  };
}

// `patchRedisCommand`, when given, is applied to the cached module's
// `exports.redisCommand` BEFORE api/_lib/rate-limit.js and api/status.js are
// (re)required — both destructure `{ redisCommand }` at require time, so
// patching after that require would leave them holding the old function
// reference. Receives (originalRedisCommand) and returns the replacement.
function freshHandler({ chain, patchRedisCommand } = {}) {
  const redisFake = installFakeRedis(require, root);
  installFakeChain(chain);
  if (patchRedisCommand) {
    const p = require.resolve(path.join(root, "api/_lib/redis.js"));
    require.cache[p].exports.redisCommand = patchRedisCommand(require.cache[p].exports.redisCommand);
  }
  for (const rel of ["api/_lib/rate-limit.js", "api/_lib/log.js", "api/status.js"]) {
    delete require.cache[require.resolve(path.join(root, rel))];
  }
  const handler = require(path.join(root, "api/status.js"));
  return { handler, redisFake };
}

const getReq = (ip = "1.1.1.1") => makeReq({ method: "GET", headers: { "x-vercel-forwarded-for": ip } });

test("GET returns 200 with ok:true when redis+rpc are healthy and nothing is queued", async () => {
  const { handler } = freshHandler();
  const r = await call(handler, getReq());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("full response shape", async () => {
  const { handler } = freshHandler();
  const r = await call(handler, getReq());
  const body = r.body;
  assert.ok("ok" in body);
  assert.ok("commit" in body);
  assert.deepEqual(Object.keys(body.redis).sort(), ["latencyMs", "ok"]);
  assert.deepEqual(Object.keys(body.rpc).sort(), ["block", "endpoint", "latencyMs", "ok"]);
  assert.deepEqual(Object.keys(body.minter).sort(), ["address", "balanceEth", "low"]);
  assert.deepEqual(Object.keys(body.queue).sort(), ["dead", "depth", "oldestAgeSec"]);
  assert.deepEqual(Object.keys(body.cron).sort(), ["lastError", "lastRunAgoSec", "stale"]);
  assert.ok(Array.isArray(body.alerts));
});

test("no CRON_SECRET-style secrets or env values ever appear in the response", async () => {
  const prevKey = process.env.MINTER_PRIVATE_KEY;
  process.env.MINTER_PRIVATE_KEY = "0xsupersecretprivatekeyvalue";
  try {
    const { handler } = freshHandler();
    const r = await call(handler, getReq());
    assert.doesNotMatch(JSON.stringify(r.body), /supersecretprivatekey/);
  } finally {
    if (prevKey === undefined) delete process.env.MINTER_PRIVATE_KEY;
    else process.env.MINTER_PRIVATE_KEY = prevKey;
  }
});

test("cron.stale is true and an alert is present when mint:cron:last has never been written", async () => {
  const { handler } = freshHandler();
  const r = await call(handler, getReq());
  assert.equal(r.body.cron.stale, true);
  assert.equal(r.body.cron.lastRunAgoSec, null);
  assert.ok(r.body.alerts.includes("cron.stale"));
});

test("cron.stale is false right after a fresh mint:cron:last, becomes true once older than 180s", async () => {
  const { handler, redisFake } = freshHandler();
  await redisFake.redisCommand("SET", "mint:cron:last", String(Date.now()));
  const fresh = await call(handler, getReq());
  assert.equal(fresh.body.cron.stale, false);
  assert.ok(!fresh.body.alerts.includes("cron.stale"));

  await redisFake.redisCommand("SET", "mint:cron:last", String(Date.now() - 200_000));
  const stale = await call(handler, getReq());
  assert.equal(stale.body.cron.stale, true);
  assert.ok(stale.body.cron.lastRunAgoSec >= 200);
  assert.ok(stale.body.alerts.includes("cron.stale"));
});

test("cron.lastError surfaces whatever mint-cron.js last wrote", async () => {
  const { handler, redisFake } = freshHandler();
  await redisFake.redisCommand("SET", "mint:cron:lastError", "boom: insufficient funds");
  const r = await call(handler, getReq());
  assert.equal(r.body.cron.lastError, "boom: insufficient funds");
});

test("minter address/balance are read from Redis (mint:minter:address), not derived here", async () => {
  const { handler, redisFake } = freshHandler({ chain: { balanceWei: "2500000000000000000" } }); // 2.5 ETH
  await redisFake.redisCommand("SET", "mint:minter:address", "0xdeadbeef00000000000000000000000000dead");
  const r = await call(handler, getReq());
  assert.equal(r.body.minter.address, "0xdeadbeef00000000000000000000000000dead");
  assert.equal(r.body.minter.balanceEth, "2.500000");
});

test("minter.low mirrors mint:alert:minter-low and adds the alert", async () => {
  const { handler, redisFake } = freshHandler();
  await redisFake.redisCommand("SET", "mint:alert:minter-low", "1", "EX", "3600");
  const r = await call(handler, getReq());
  assert.equal(r.body.minter.low, true);
  assert.ok(r.body.alerts.includes("minter.low"));
});

test("queue depth and oldestAgeSec reflect mintqueue: entries", async () => {
  const { handler, redisFake } = freshHandler();
  const now = Date.now();
  await redisFake.redisCommand("SET", "mintqueue:A", JSON.stringify({ queuedAt: now - 5000 }), "EX", "7200");
  await redisFake.redisCommand("SET", "mintqueue:B", JSON.stringify({ queuedAt: now - 90000 }), "EX", "7200");
  const r = await call(handler, getReq());
  assert.equal(r.body.queue.depth, 2);
  assert.ok(r.body.queue.oldestAgeSec >= 89, JSON.stringify(r.body.queue));
});

test("queue.dead reflects mint:dead length and sets the mint.dead alert", async () => {
  const { handler, redisFake } = freshHandler();
  await redisFake.redisCommand("LPUSH", "mint:dead", JSON.stringify({ key: "mintqueue:X" }));
  const r = await call(handler, getReq());
  assert.equal(r.body.queue.dead, 1);
  assert.ok(r.body.alerts.includes("mint.dead"));
});

test("redis down: ok:false, redis.down alert, rest of the response still renders", async () => {
  // Fail only status.js's own health-check GET, not rate-limit.js's INCR
  // (which runs first, per-request, and fails OPEN by default — a single
  // queued failure via fake-redis's failNext() would be silently absorbed
  // there instead of reaching the check this test actually cares about).
  let thrown = false;
  const { handler } = freshHandler({
    patchRedisCommand: (original) => async (cmd, ...args) => {
      if (!thrown && String(cmd).toUpperCase() === "GET" && args[0] === "mint:cron:last") {
        thrown = true;
        throw new Error("upstash: connection refused");
      }
      return original(cmd, ...args);
    },
  });
  const r = await call(handler, getReq());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.redis.ok, false);
  assert.ok(r.body.alerts.includes("redis.down"));
});

test("rpc down: ok:false, rpc.down alert", async () => {
  const { handler } = freshHandler({ chain: { failBlock: true } });
  const r = await call(handler, getReq());
  assert.equal(r.body.ok, false);
  assert.equal(r.body.rpc.ok, false);
  assert.ok(r.body.alerts.includes("rpc.down"));
});

test("rpc.block/endpoint reflect chain.blockNumber() on success", async () => {
  const { handler } = freshHandler({ chain: { block: 424242, endpoint: "alchemy" } });
  const r = await call(handler, getReq());
  assert.equal(r.body.rpc.ok, true);
  assert.equal(r.body.rpc.block, 424242);
  assert.equal(r.body.rpc.endpoint, "alchemy");
});

test("OPTIONS is a 204 preflight response", async () => {
  const { handler } = freshHandler();
  const r = await call(handler, makeReq({ method: "OPTIONS" }));
  assert.equal(r.status, 204);
});

test("non-GET, non-OPTIONS method is 405", async () => {
  const { handler } = freshHandler();
  const r = await call(handler, makeReq({ method: "POST" }));
  assert.equal(r.status, 405);
});

test("31st request from one IP within the window is rate limited (429)", async () => {
  const { handler } = freshHandler();
  const results = [];
  for (let i = 0; i < 31; i++) {
    results.push(await call(handler, getReq("7.7.7.7")));
  }
  assert.deepEqual(results.slice(0, 30).map((r) => r.status), Array(30).fill(200));
  assert.equal(results[30].status, 429);
});
