// POST /api/auth/session
//
// Body: { adapter?, tokenId, address, issuedAt, nonce, signature, delegatePubKey? }
// 200:  { token, sid, wallet, tokenId, expiresAt, engineVersion }
// Errors: JSON { code, error } with code one of INVALID_INPUT |
//   INVALID_TIMESTAMP | EXPIRED | INVALID_SIGNATURE | CHAIN_UNAVAILABLE |
//   NOT_OWNER | REPLAYED | BANNED | NOT_CONFIGURED.
//
// Establishes a session (see api/_lib/auth.js) by having the caller sign an
// EIP-191 message (api/_lib/auth-message.js's buildSessionMessage, rebuilt
// here from the request's own fields - never trusted from the client) that
// binds a wallet to a live-owned HOODCHAN token, with an optional delegate
// P-256 key (src/wallet.js) fingerprinted into the same message so later
// requests can be signed by the delegate key instead of re-prompting the
// wallet every time.
//
// Checks run in this exact order, matching the spec this route was built
// against: rate limit -> config present -> input shapes -> message rebuild
// -> signature recovery -> ban check -> live ownerOf -> single-use
// signature consumption (LAST, once every other check has passed - an RPC
// outage or a bad request must never burn a legitimate signature the caller
// will need to retry with).
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { withRoute } = require("../_lib/http");
const { redisCommand } = require("../_lib/redis");
const { ownerOf } = require("../_lib/chain");
const { issueSession } = require("../_lib/auth");
const { buildSessionMessage, computeDelegateFingerprint } = require("../_lib/auth-message");

const MIN_TOKEN_ID = 1;
const MAX_TOKEN_ID = 1200;
const ISSUED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h in the past
const ISSUED_AT_MAX_SKEW_MS = 60 * 1000; // 60s into the future
// Outlives the 24h freshness window comfortably, same reasoning as
// api/lobby/complete.js's SIG_REPLAY_TTL_SECONDS - a replay must stay
// impossible for the entire span the signature could otherwise still pass
// the timestamp check.
const SIG_REPLAY_TTL_SECONDS = 86460;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

function parseTokenId(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// Public-key-only P-256 JWK shape - no `d` (private component) should ever
// be here, but this isn't the place to enforce that; it's just enough of a
// shape check that a malformed delegatePubKey fails loudly (INVALID_INPUT)
// instead of silently fingerprinting garbage into the session message.
function isValidDelegatePubKey(jwk) {
  return (
    jwk &&
    typeof jwk === "object" &&
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    jwk.x.length > 0 &&
    typeof jwk.y === "string" &&
    jwk.y.length > 0
  );
}

// version.json lives at the repo root, a sibling of api/ - read fresh on
// every call (not cached at require time) so a redeploy's stamped version
// shows up without waiting on a cold start. Any read/parse failure, or a
// file that doesn't carry a recognizable version field, resolves to null -
// this is a nice-to-have in the response, never a reason to fail the route.
function readEngineVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", "version.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === "string") return parsed.version;
    if (typeof parsed.engineVersion === "string") return parsed.engineVersion;
    return null;
  } catch {
    return null;
  }
}

async function handler(req, res) {
  // Fail closed before doing anything else - never mint a session signed
  // with a fallback secret, and never risk burning a legitimate signature
  // on a misconfigured deploy.
  if (!process.env.SESSION_SECRET) {
    res.status(503).json({ code: "NOT_CONFIGURED", error: "Sessions are not configured on this deployment" });
    return;
  }

  const body = req.body || {};
  const { adapter, tokenId: rawTokenId, address, issuedAt, nonce, signature, delegatePubKey } = body;

  // --- Input shapes ---
  const tokenId = parseTokenId(rawTokenId);
  if (tokenId === null || tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) {
    res.status(400).json({ code: "INVALID_INPUT", error: `tokenId must be an integer ${MIN_TOKEN_ID}-${MAX_TOKEN_ID}` });
    return;
  }
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    res.status(400).json({ code: "INVALID_INPUT", error: "address must be a valid 0x address" });
    return;
  }
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    res.status(400).json({ code: "INVALID_INPUT", error: "nonce must be 32 lowercase hex characters" });
    return;
  }
  if (typeof signature !== "string" || !signature) {
    res.status(400).json({ code: "INVALID_INPUT", error: "signature is required" });
    return;
  }
  if (typeof issuedAt !== "string" || !issuedAt) {
    res.status(400).json({ code: "INVALID_INPUT", error: "issuedAt is required" });
    return;
  }
  if (delegatePubKey !== undefined && delegatePubKey !== null && !isValidDelegatePubKey(delegatePubKey)) {
    res.status(400).json({ code: "INVALID_INPUT", error: "delegatePubKey must be a P-256 public JWK" });
    return;
  }

  // issuedAt freshness - part of "input shapes" per the spec, checked before
  // the message is even rebuilt.
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is not a valid timestamp" });
    return;
  }
  const ageMs = Date.now() - issuedMs;
  if (ageMs < -ISSUED_AT_MAX_SKEW_MS) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is too far in the future" });
    return;
  }
  if (ageMs > ISSUED_AT_MAX_AGE_MS) {
    res.status(403).json({ code: "EXPIRED", error: "issuedAt is too old" });
    return;
  }

  // --- Rebuild the message server-side and recover the signer ---
  const delegateJwk = delegatePubKey ?? null;
  const delegate = await computeDelegateFingerprint(delegateJwk);
  const message = buildSessionMessage({ tokenId, address, issuedAt, nonce, delegate });

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Could not verify signature" });
    return;
  }
  const walletLc = address.toLowerCase();
  if (recovered.toLowerCase() !== walletLc) {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Signature does not match address" });
    return;
  }

  try {
    // --- Ban check ---
    const banned = await redisCommand("SISMEMBER", "ban:wallet", walletLc);
    if (Number(banned) === 1) {
      res.status(403).json({ code: "BANNED", error: "This wallet is banned" });
      return;
    }

    // --- Live ownership check. An RPC failure must never consume the
    // signature below - the caller retries the exact same signed request
    // once the chain is reachable again (see test/auth-session.test.mjs). ---
    let owner;
    try {
      owner = await ownerOf(tokenId);
    } catch (err) {
      console.error("[auth/session] ownerOf RPC failed", err);
      res.status(503).json({ code: "CHAIN_UNAVAILABLE", error: "Could not verify token ownership right now" });
      return;
    }
    if (!owner || owner !== walletLc) {
      res.status(403).json({ code: "NOT_OWNER", error: "address does not own this token" });
      return;
    }

    // --- Single-use signature, consumed LAST now that every other check
    // has passed (same reasoning as api/lobby/complete.js's sigused: guard:
    // a request that was always going to fail some other check shouldn't
    // burn the caller's one legitimate signature). ---
    const canonicalSig = ethers.Signature.from(signature).serialized;
    const sigHash = crypto.createHash("sha256").update(canonicalSig).digest("hex");
    const consumed = await redisCommand(
      "SET",
      `sigused:session:${sigHash}`,
      "1",
      "NX",
      "EX",
      String(SIG_REPLAY_TTL_SECONDS),
    );
    if (consumed !== "OK") {
      res.status(409).json({ code: "REPLAYED", error: "This signed session request was already used" });
      return;
    }

    const adapterKey = typeof adapter === "string" && adapter ? adapter : null;
    const session = await issueSession({
      wallet: walletLc,
      tokenId,
      adapter: adapterKey,
      delegateJwk,
      delegateFp: delegate === "none" ? null : delegate,
    });

    res.status(200).json({
      token: session.token,
      sid: session.sid,
      wallet: session.wallet,
      tokenId: session.tokenId,
      expiresAt: session.expiresAt,
      engineVersion: readEngineVersion(),
    });
  } catch (err) {
    if (err?.code === "NOT_CONFIGURED") {
      res.status(503).json({ code: "NOT_CONFIGURED", error: "Sessions are not configured on this deployment" });
      return;
    }
    console.error("[auth/session]", err);
    res.status(502).json({ error: "Could not create session right now" });
  }
}

module.exports = withRoute(handler, {
  methods: ["POST"],
  cors: "public",
  rateLimit: { scope: "auth/session", max: 20, windowSec: 600, failOpen: false },
  session: "none",
});
