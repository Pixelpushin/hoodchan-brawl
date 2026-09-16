// Tests for the twin session-message builders: api/_lib/auth-message.js
// (server, CJS) and src/auth-message.js (client, ESM) MUST produce
// byte-identical output for identical inputs - api/auth/session.js rebuilds
// the message server-side rather than trusting whatever the client says it
// signed, so any drift between the two would make every real signature look
// invalid.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildSessionMessage as clientBuildSessionMessage,
  computeDelegateFingerprint as clientComputeDelegateFingerprint,
  canonicalDelegateJwk as clientCanonicalDelegateJwk,
} from "../src/auth-message.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = require(path.join(root, "api/_lib/auth-message.js"));

// A P-256 public JWK shape (values are fixtures, not real key material).
const JWK_A = { crv: "P-256", kty: "EC", x: "aaaa-bbbb", y: "cccc-dddd" };
const JWK_B_WITH_EXTRA = { crv: "P-256", kty: "EC", x: "xval", y: "yval", ext: true, key_ops: ["verify"] };

test("buildSessionMessage: client (src/auth-message.js) and server (api/_lib/auth-message.js) produce identical bytes for 3 inputs", () => {
  const cases = [
    {
      tokenId: 42,
      address: "0xAbC1230000000000000000000000000000dEaD",
      issuedAt: "2026-09-16T12:00:00.000Z",
      nonce: "0123456789abcdef".repeat(2),
      delegate: "none",
    },
    {
      tokenId: 1,
      address: "0x0000000000000000000000000000000000dead",
      issuedAt: "2026-01-01T00:00:00.000Z",
      nonce: "f".repeat(32),
      delegate: "a".repeat(64),
    },
    {
      tokenId: 1200,
      address: "0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf",
      issuedAt: "2099-12-31T23:59:59.999Z",
      nonce: "0".repeat(32),
      delegate: "none",
    },
  ];

  for (const fields of cases) {
    const fromServer = server.buildSessionMessage(fields);
    const fromClient = clientBuildSessionMessage(fields);
    assert.equal(fromClient, fromServer, `mismatch for tokenId=${fields.tokenId}`);
    assert.equal(
      fromServer,
      [
        "HOODCHAN Brawl session",
        `token: HOODCHAN #${fields.tokenId}`,
        `address: ${fields.address}`,
        `issued: ${fields.issuedAt}`,
        `nonce: ${fields.nonce}`,
        `delegate: ${fields.delegate}`,
      ].join("\n"),
    );
  }
});

test("canonicalDelegateJwk: fixed {crv,kty,x,y} field order, extra JWK members dropped, client == server", () => {
  assert.equal(clientCanonicalDelegateJwk(JWK_A), server.canonicalDelegateJwk(JWK_A));
  assert.equal(server.canonicalDelegateJwk(JWK_A), '{"crv":"P-256","kty":"EC","x":"aaaa-bbbb","y":"cccc-dddd"}');
  // Extra members present in a real WebCrypto JWK export (key_ops, ext, ...)
  // must not leak into the canonical form - only crv/kty/x/y matter.
  assert.equal(server.canonicalDelegateJwk(JWK_B_WITH_EXTRA), '{"crv":"P-256","kty":"EC","x":"xval","y":"yval"}');
});

test("computeDelegateFingerprint: client and server hash to the same sha256 hex; no key -> 'none'", async () => {
  const serverFp = await server.computeDelegateFingerprint(JWK_A);
  const clientFp = await clientComputeDelegateFingerprint(JWK_A);
  assert.equal(serverFp, clientFp);
  assert.match(serverFp, /^[0-9a-f]{64}$/);

  // Different key material must hash differently.
  const otherFp = await server.computeDelegateFingerprint(JWK_B_WITH_EXTRA);
  assert.notEqual(otherFp, serverFp);

  assert.equal(await server.computeDelegateFingerprint(null), "none");
  assert.equal(await clientComputeDelegateFingerprint(undefined), "none");
});
