// Tests for api/_lib/rate-limit.js, hermetic via test/_helpers/fake-redis.js.
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

// Fresh fake Redis + a fresh require of rate-limit.js per test, so counters
// from one test never leak into another (each test gets its own
// require.cache entry for api/_lib/redis.js, and rate-limit.js is re-required
// via a cache-busting query string since Node module caching would otherwise
// hand back the same module with the OLD redis binding closed over).
function freshRateLimit() {
  const fake = installFakeRedis(require, root);
  delete require.cache[require.resolve(path.join(root, "api/_lib/rate-limit.js"))];
  const rateLimit = require(path.join(root, "api/_lib/rate-limit.js"));
  return { ...rateLimit, fake };
}

const reqFrom = (ip) => makeReq({ headers: { "x-vercel-forwarded-for": ip } });

test("allows up to max requests in a window, then denies", async () => {
  const { rateLimit } = freshRateLimit();
  const req = reqFrom("1.1.1.1");
  for (let i = 0; i < 3; i++) {
    const r = await rateLimit(req, "create", 3, 600);
    assert.equal(r.allowed, true, `request ${i + 1} of 3 should be allowed`);
  }
  const denied = await rateLimit(req, "create", 3, 600);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds > 0, "denied response carries a positive retry-after");
});

test("separate scopes are independent counters", async () => {
  const { rateLimit } = freshRateLimit();
  const req = reqFrom("2.2.2.2");
  for (let i = 0; i < 2; i++) await rateLimit(req, "create", 2, 600);
  const createDenied = await rateLimit(req, "create", 2, 600);
  const joinAllowed = await rateLimit(req, "join", 2, 600); // different scope, same ip
  assert.equal(createDenied.allowed, false);
  assert.equal(joinAllowed.allowed, true);
});

test("separate IPs are independent counters within the same scope", async () => {
  const { rateLimit } = freshRateLimit();
  for (let i = 0; i < 2; i++) await rateLimit(reqFrom("3.3.3.3"), "join", 2, 600);
  const aDenied = await rateLimit(reqFrom("3.3.3.3"), "join", 2, 600);
  const bAllowed = await rateLimit(reqFrom("4.4.4.4"), "join", 2, 600); // different ip, same scope
  assert.equal(aDenied.allowed, false);
  assert.equal(bAllowed.allowed, true);
});

test("missing/unknown headers fall back to a stable 'unknown' bucket instead of throwing", async () => {
  const { rateLimit } = freshRateLimit();
  const bareReq = { method: "POST" }; // no headers at all
  const r = await rateLimit(bareReq, "poll", 5, 600);
  assert.equal(r.allowed, true);
});

test("fails open on a Redis error by default", async () => {
  const { rateLimit, fake } = freshRateLimit();
  fake.failNext(new Error("upstash is down"));
  const r = await rateLimit(reqFrom("5.5.5.5"), "match-result", 1, 600);
  assert.equal(r.allowed, true);
  assert.equal(r.retryAfterSeconds, 0);
});

test("fails closed when failOpen: false is requested", async () => {
  const { rateLimit, fake } = freshRateLimit();
  fake.failNext(new Error("upstash is down"));
  const r = await rateLimit(reqFrom("6.6.6.6"), "ai-match-complete", 1, 600, { failOpen: false });
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSeconds, 30);
});

test("enforceRateLimit lets allowed requests through untouched", async () => {
  const { enforceRateLimit } = freshRateLimit();
  const req = reqFrom("7.7.7.7");
  const res = { setHeader() {}, status() { return this; }, json() {}, end() {} };
  let calledJson = false;
  res.json = () => { calledJson = true; };
  const ok = await enforceRateLimit(req, res, "share-upload", 5, 600);
  assert.equal(ok, true);
  assert.equal(calledJson, false, "enforceRateLimit must not write a response when allowed");
});

test("enforceRateLimit writes 429 + Retry-After when denied", async () => {
  const { enforceRateLimit } = freshRateLimit();
  const req = reqFrom("8.8.8.8");
  const handler = async (r, res) => {
    if (!(await enforceRateLimit(r, res, "ipfs", 1, 600))) return;
    res.status(200).json({ ok: true });
  };
  const first = await call(handler, req);
  assert.equal(first.status, 200);
  const second = await call(handler, req);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, "Too many requests");
  assert.ok(Number(second.headers["Retry-After"]) > 0);
});

test("countAndCap allows up to max, then denies, with a running count", async () => {
  const { countAndCap } = freshRateLimit();
  const key = "rl:aimint:0xabc";
  const r1 = await countAndCap(key, 2, 86400);
  const r2 = await countAndCap(key, 2, 86400);
  const r3 = await countAndCap(key, 2, 86400);
  assert.deepEqual([r1.allowed, r1.count], [true, 1]);
  assert.deepEqual([r2.allowed, r2.count], [true, 2]);
  assert.deepEqual([r3.allowed, r3.count], [false, 3]);
});

test("countAndCap keys are independent of each other", async () => {
  const { countAndCap } = freshRateLimit();
  await countAndCap("rl:aimint:0xaaa", 1, 86400);
  const other = await countAndCap("rl:aimint:0xbbb", 1, 86400);
  assert.equal(other.allowed, true);
});
