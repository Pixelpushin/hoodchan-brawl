// Tests for api/_lib/room.js's transition()/loadRoom()/isParticipant().
// Hermetic via test/_helpers/fake-redis.js (same require.cache-swap pattern
// as test/lobby-complete.test.mjs).
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { installFakeRedis } from "./_helpers/fake-redis.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOM_PATH = require.resolve(path.join(root, "api/_lib/room.js"));

function freshRoom() {
  const fake = installFakeRedis(require, root);
  delete require.cache[ROOM_PATH];
  const room = require(ROOM_PATH);
  return { room, fake };
}

const CODE = "abc123"; // deliberately lowercase/untrimmed - room.js normalizes
const KEY = "lobby:ABC123";

function seed(fake, record) {
  fake.store.set(KEY, { type: "string", value: JSON.stringify(record), expiresAt: Date.now() + 600_000 });
}

test("loadRoom returns null for a missing room, and the parsed record otherwise", async () => {
  const { room, fake } = freshRoom();
  assert.equal(await room.loadRoom(CODE), null);
  seed(fake, { status: "waiting", v: 0 });
  const loaded = await room.loadRoom(CODE);
  assert.equal(loaded.status, "waiting");
});

test("isParticipant matches p1/p2 case-insensitively, else null", () => {
  const { room } = freshRoom();
  const record = { p1: { wallet: "0xaaaa" }, p2: { wallet: "0xbbbb" } };
  assert.equal(room.isParticipant(record, "0xAAAA"), "p1");
  assert.equal(room.isParticipant(record, "0xbbbb"), "p2");
  assert.equal(room.isParticipant(record, "0xcccc"), null);
  assert.equal(room.isParticipant(null, "0xaaaa"), null);
  assert.equal(room.isParticipant(record, null), null);
});

test("transition 404s when the room doesn't exist", async () => {
  const { room } = freshRoom();
  const res = await room.transition(CODE, ["waiting"], (r) => r);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("transition 409s when the room's status isn't in fromStates, and never calls mutate", async () => {
  const { room, fake } = freshRoom();
  seed(fake, { status: "complete", v: 0 });
  let mutateCalled = false;
  const res = await room.transition(CODE, ["waiting", "connected"], (r) => {
    mutateCalled = true;
    return r;
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.body.status, "complete");
  assert.equal(mutateCalled, false, "mutate must not run when fromStates rejects the transition");
});

test("transition accepts a single status string (not just an array) for fromStates", async () => {
  const { room, fake } = freshRoom();
  seed(fake, { status: "waiting", v: 0 });
  const res = await room.transition(CODE, "waiting", (r) => ({ ...r, status: "connected" }));
  assert.equal(res.ok, true);
  assert.equal(res.room.status, "connected");
});

test("mutate can abort the transition by returning { error, status, code } - nothing is written", async () => {
  const { room, fake } = freshRoom();
  seed(fake, { status: "waiting", v: 0, p1: { wallet: "0xaaaa" } });
  const res = await room.transition(CODE, ["waiting"], () => ({ error: "self-play", status: 409, code: "SELF_PLAY" }));
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SELF_PLAY");
  const stillThere = JSON.parse(fake.store.get(KEY).value);
  assert.equal(stillThere.status, "waiting", "the room must be unchanged when mutate rejects");
});

test("a successful transition bumps v, stamps updatedAt, and writes with the new status's TTL", async () => {
  const { room, fake } = freshRoom();
  seed(fake, { status: "waiting", v: 3 });
  const before = Date.now();
  const res = await room.transition(CODE, ["waiting"], (r) => ({ ...r, status: "signaling" }));
  assert.equal(res.ok, true);
  assert.equal(res.room.v, 4);
  assert.ok(res.room.updatedAt >= before);

  const entry = fake.store.get(KEY);
  const stored = JSON.parse(entry.value);
  assert.equal(stored.status, "signaling");
  assert.equal(stored.v, 4);
  // signaling's TTL is 300s (room.js's TTL_BY_STATE) - allow a little slack
  // for wall-clock time spent in the test itself.
  const ttlSeconds = (entry.expiresAt - Date.now()) / 1000;
  assert.ok(ttlSeconds > 295 && ttlSeconds <= 300, `expected ~300s TTL, got ${ttlSeconds}`);
});

test("every TTL_BY_STATE entry is applied on transition into that status", async () => {
  const { room, fake } = freshRoom();
  for (const [status, ttl] of Object.entries(room.TTL_BY_STATE)) {
    seed(fake, { status: "waiting", v: 0 });
    const res = await room.transition(CODE, ["waiting"], (r) => ({ ...r, status }));
    assert.equal(res.ok, true, `transition into "${status}" should succeed`);
    const entry = fake.store.get(KEY);
    const ttlSeconds = (entry.expiresAt - Date.now()) / 1000;
    assert.ok(ttlSeconds > ttl - 5 && ttlSeconds <= ttl, `"${status}": expected ~${ttl}s TTL, got ${ttlSeconds}`);
  }
});

test("CAS retry: a racing write between GET and compare-and-set is retried, not lost", async () => {
  // Not freshRoom() here - the redisCompareAndSet wrap below must be
  // installed BEFORE room.js is required, since room.js destructures it
  // into a local binding at require time.
  const fake = installFakeRedis(require, root);
  delete require.cache[ROOM_PATH];
  seed(fake, { status: "waiting", v: 0 });

  const path2 = require.resolve(path.join(root, "api/_lib/redis.js"));
  const redisExports = require.cache[path2].exports;
  const originalCas = redisExports.redisCompareAndSet;
  let armed = true;
  redisExports.redisCompareAndSet = async (key, expected, next, ttl) => {
    if (armed && key === KEY) {
      armed = false;
      // Someone else's write lands in between this call's GET and its CAS.
      seed(fake, { status: "waiting", v: 0, racedIn: true });
    }
    return originalCas(key, expected, next, ttl);
  };

  const room = require(ROOM_PATH);
  const res = await room.transition(CODE, ["waiting"], (r) => ({ ...r, status: "connected" }));
  assert.equal(res.ok, true, "the transition should succeed after retrying past the race");
  assert.equal(res.room.status, "connected");
  assert.equal(res.room.racedIn, true, "the retry must be built on top of the racily-written record");
});

test("CAS exhaustion (every attempt loses the race) is reported as 503", async () => {
  const fake = installFakeRedis(require, root);
  delete require.cache[ROOM_PATH];
  seed(fake, { status: "waiting", v: 0 });

  const path2 = require.resolve(path.join(root, "api/_lib/redis.js"));
  const redisExports = require.cache[path2].exports;
  // Always loses the CAS race, no matter how many times it's retried.
  redisExports.redisCompareAndSet = async () => false;

  const room = require(ROOM_PATH);
  const res = await room.transition(CODE, ["waiting"], (r) => ({ ...r, status: "connected" }));
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
});

test("generateMatchId produces the documented m_<base36 ts>_<8 hex> shape, unique per call", () => {
  const { room } = freshRoom();
  const a = room.generateMatchId();
  const b = room.generateMatchId();
  assert.match(a, /^m_[0-9a-z]+_[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("roomKey/normalizeCode trim and uppercase the room code", () => {
  const { room } = freshRoom();
  assert.equal(room.normalizeCode(" abc123 "), "ABC123");
  assert.equal(room.roomKey("abc123"), "lobby:ABC123");
});
