// Regression tests for api/_lib/log.js's redactSecrets and api/_lib/mint.js's
// minter-key parsing. Both exist because of a real incident (2026-09-16): a
// trailing newline in MINTER_PRIVATE_KEY made ethers throw an error whose
// message embedded the key, the cron stored that message in Redis, and the
// public /api/status echoed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { redactSecrets } = require(path.join(root, "api/_lib/log.js"));

const FAKE_KEY = "0x" + "ab".repeat(32);

test("redactSecrets strips an ethers-style BytesLike error that embeds the value", () => {
  const msg = `invalid BytesLike value (argument="value", value="${FAKE_KEY}\\n", code=INVALID_ARGUMENT, version=6.17.0)`;
  const out = redactSecrets(msg);
  assert.equal(out.includes("ab".repeat(8)), false, "hex payload must not survive");
  assert.equal(out.includes(FAKE_KEY), false);
  assert.match(out, /INVALID_ARGUMENT/);
});

test("redactSecrets strips bare 0x hex runs, long hex runs, and URLs, and caps length", () => {
  const out = redactSecrets(`tx ${FAKE_KEY} at https://x.example/secret?k=${"f".repeat(40)} ${"e".repeat(400)}`);
  assert.equal(out.includes("abab"), false);
  assert.equal(out.includes("x.example"), false);
  assert.ok(out.length <= 300);
});

test("redactSecrets leaves short, harmless text alone", () => {
  assert.equal(redactSecrets("Room not found or expired"), "Room not found or expired");
  assert.equal(redactSecrets(null), "");
});

test("mint.js never passes a malformed MINTER_PRIVATE_KEY to ethers (generic error, no value)", () => {
  const saved = process.env.MINTER_PRIVATE_KEY;
  try {
    process.env.MINTER_PRIVATE_KEY = FAKE_KEY + "\n";
    // Fresh module instance so the memoized address is empty.
    const p = require.resolve(path.join(root, "api/_lib/mint.js"));
    delete require.cache[p];
    const mint = require(p);
    // A trailing newline is tolerated (trimmed) - the address derives fine.
    assert.match(mint.getMinterAddress(), /^0x[0-9a-fA-F]{40}$/);
    delete require.cache[p];
    process.env.MINTER_PRIVATE_KEY = "not-a-key-" + FAKE_KEY;
    const mint2 = require(p);
    assert.throws(() => mint2.getMinterAddress(), (err) => {
      assert.equal(String(err.message).includes("abab"), false, "error must not contain the value");
      assert.match(err.message, /malformed/);
      return true;
    });
  } finally {
    if (saved === undefined) delete process.env.MINTER_PRIVATE_KEY;
    else process.env.MINTER_PRIVATE_KEY = saved;
    const p = require.resolve(path.join(root, "api/_lib/mint.js"));
    delete require.cache[p];
  }
});
