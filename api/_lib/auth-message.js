// Server twin of src/auth-message.js - the two MUST produce byte-identical
// output for the same inputs (test/auth-message.test.mjs imports both and
// compares them directly). This is the EIP-191 message a wallet signs to
// establish a session (see api/auth/session.js), rebuilt server-side from
// the request's own fields rather than ever trusting client-supplied text -
// same pattern as api/lobby/complete.js's buildResultMessage.
//
// Wire format (lines joined by \n, no trailing newline):
//   HOODCHAN Brawl session
//   token: HOODCHAN #<tokenId>
//   address: <address as sent>
//   issued: <issuedAt ISO-8601 as sent>
//   nonce: <32 lowercase hex chars>
//   delegate: <sha256 hex of the session P-256 pubkey JWK | "none">
"use strict";

const crypto = require("node:crypto");

// Canonical JSON over exactly {crv, kty, x, y} in that field order - other
// JWK members (key_ops, ext, ...) a wallet's WebCrypto export might include
// are deliberately dropped so the fingerprint only ever depends on the
// public key material itself, and so this object-literal's insertion order
// (which JSON.stringify preserves) is the one thing that has to match
// src/auth-message.js's copy of this function.
function canonicalDelegateJwk(jwk) {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

// sha256 hex of the canonical JWK, or the literal "none" when no delegate
// key was presented for this session. Async because SubtleCrypto.digest is
// async in both runtimes this repo cares about (browser + Node 22's global
// webcrypto) - keeping this function's shape identical to the client twin's
// is what keeps the two implementations honest, not just their output.
async function computeDelegateFingerprint(jwk) {
  if (!jwk) return "none";
  const bytes = new TextEncoder().encode(canonicalDelegateJwk(jwk));
  const digest = await crypto.webcrypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

// Pure string template - `delegate` is an already-resolved value ("none" or
// a fingerprint hex string from computeDelegateFingerprint above), so this
// function itself stays sync and crypto-free.
function buildSessionMessage({ tokenId, address, issuedAt, nonce, delegate }) {
  return [
    "HOODCHAN Brawl session",
    `token: HOODCHAN #${tokenId}`,
    `address: ${address}`,
    `issued: ${issuedAt}`,
    `nonce: ${nonce}`,
    `delegate: ${delegate}`,
  ].join("\n");
}

module.exports = { buildSessionMessage, computeDelegateFingerprint, canonicalDelegateJwk };
