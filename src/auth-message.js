// Client twin of api/_lib/auth-message.js - the two MUST produce
// byte-identical output for the same inputs (test/auth-message.test.mjs
// imports both and compares them directly). Builds the EIP-191 message
// src/wallet.js's getSession() signs to establish a session via
// POST /api/auth/session.
//
// See api/_lib/auth-message.js's header comment for the exact wire format
// and the reasoning behind canonicalDelegateJwk's fixed field order.

export function canonicalDelegateJwk(jwk) {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

// Browser twin of the server's computeDelegateFingerprint - same shape
// (async, SubtleCrypto SHA-256 over the same canonical bytes), just sourced
// from window.crypto.subtle instead of Node's require("node:crypto").
export async function computeDelegateFingerprint(jwk) {
  if (!jwk) return "none";
  const bytes = new TextEncoder().encode(canonicalDelegateJwk(jwk));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildSessionMessage({ tokenId, address, issuedAt, nonce, delegate }) {
  return [
    "HOODCHAN Brawl session",
    `token: HOODCHAN #${tokenId}`,
    `address: ${address}`,
    `issued: ${issuedAt}`,
    `nonce: ${nonce}`,
    `delegate: ${delegate}`,
  ].join("\n");
}
