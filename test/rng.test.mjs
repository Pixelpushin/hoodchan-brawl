// Tests for src/rng.js (Design A step c). These pin the exact bit-exact
// output of mulberry32 and derive() - not just "is a number in range" - so
// any future engine port (Bun, a second JS engine, a native replay tool)
// can be checked against these same expected values to confirm it's
// producing the identical sequence real determinism (golden replays, two
// netcode peers agreeing) depends on.
//
//   node --test test/rng.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { nextU32, makeRng, derive, randomSeed } from "../src/rng.js";

test("mulberry32 determinism: same seed produces the same 1000 values", () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 1000 }, () => a.float());
  const seqB = Array.from({ length: 1000 }, () => b.float());
  assert.deepEqual(seqA, seqB);
  // Every draw is a real [0, 1) float, not a placeholder/constant sequence.
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  assert.ok(new Set(seqA).size > 990, "expected a real spread of values, not near-duplicates");
});

test("mulberry32 first-5 values are pinned for seed 12345 (regression guard)", () => {
  const rng = makeRng(12345);
  const first5 = Array.from({ length: 5 }, () => rng.float());
  assert.deepEqual(first5, [
    0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061,
  ]);
});

test("nextU32 is a pure function of state (no hidden closure)", () => {
  const [s1, u1] = nextU32(12345);
  const [s2, u2] = nextU32(12345);
  assert.equal(s1, s2);
  assert.equal(u1, u2);
  assert.ok(Number.isInteger(u1) && u1 >= 0 && u1 <= 0xffffffff);
});

test("derive() is stable for fixed (seed, tag) pairs - pinned expected values", () => {
  // Printed once via `node --input-type=module -e '...'` against this exact
  // rng.js and pinned here - see this file's own header comment for why a
  // regression here (not just "some number changed") is the thing this
  // guards against.
  assert.equal(derive(12345, "round:1:0"), 216885198);
  assert.equal(derive(12345, "fx"), 1994389270);
  assert.equal(derive(0, "arena"), 3558948908);
  assert.equal(derive(4294967295, "round:2:0"), 2049589957);
  // Same (seed, tag) called twice gives the same result (pure function).
  assert.equal(derive(12345, "round:1:0"), derive(12345, "round:1:0"));
});

test("int(n) always returns an integer in [0, n)", () => {
  const rng = makeRng(777);
  for (let i = 0; i < 2000; i++) {
    const v = rng.int(7);
    assert.ok(Number.isInteger(v));
    assert.ok(v >= 0 && v < 7);
  }
});

test("pick(array) always returns an element of the array", () => {
  const rng = makeRng(42);
  const arr = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    assert.ok(arr.includes(rng.pick(arr)));
  }
});

test("two makeRng streams with different derive() tags diverge", () => {
  const a = makeRng(derive(999, "a"));
  const b = makeRng(derive(999, "b"));
  const seqA = Array.from({ length: 50 }, () => a.float());
  const seqB = Array.from({ length: 50 }, () => b.float());
  assert.notDeepEqual(seqA, seqB);
});

test("state is readable and settable, and resuming from it continues the same sequence", () => {
  const rng = makeRng(555);
  rng.float();
  rng.float();
  const savedState = rng.state;
  const expected = [rng.float(), rng.float(), rng.float()];

  const resumed = makeRng(0);
  resumed.state = savedState;
  const actual = [resumed.float(), resumed.float(), resumed.float()];
  assert.deepEqual(actual, expected);
});

test("randomSeed() returns a real uint32 and is not constant across calls", () => {
  const seeds = new Set(Array.from({ length: 8 }, () => randomSeed()));
  for (const s of seeds) {
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  }
  assert.ok(seeds.size > 1, "expected randomSeed() to vary across calls");
});
